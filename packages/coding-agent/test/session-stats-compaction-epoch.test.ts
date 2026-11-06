import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionStatsTracker } from "@oh-my-pi/pi-coding-agent/session/session-stats";

/**
 * CompactionEpoch is an in-process freshness counter for rejecting stale
 * post-cutoff anchors after mid-run rebase — not a durable "times compacted"
 * field. B1 cross-100k fixtures can show `type=compaction` success with both
 * assistants stamped `compactionEpoch: 0` when turn2 runs in a new AgentSession
 * (CLI continue / process restart). Same-process after successful rebase always
 * advances (≥ 1). Durable success is the JSONL compaction entry.
 */
describe("SessionStatsTracker compactionEpoch process-local contract", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(() => {
		// Trackers hold no handles that need dispose; Agent is GC'd with the test.
	});

	const model = (): Model => {
		const found = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!found) throw new Error("Expected a bundled model");
		return found;
	};

	const createTracker = (manager: SessionManager, target: Model): SessionStatsTracker => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			initialState: {
				model: target,
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext().messages,
			},
		});
		return new SessionStatsTracker({
			session: {
				agent,
				model: target,
				settings,
			},
			agent,
			sessionManager: manager,
			modelRegistry,
			model: () => target,
			sessionId: () => manager.getSessionId(),
		});
	};

	it("starts at 0 and advances only via rebaseAfterCompaction in the same tracker", () => {
		const target = model();
		const manager = SessionManager.inMemory();
		const tracker = createTracker(manager, target);

		expect(tracker.compactionEpoch).toBe(0);
		tracker.rebaseAfterCompaction();
		expect(tracker.compactionEpoch).toBe(1);
		tracker.rebaseAfterCompaction();
		expect(tracker.compactionEpoch).toBe(2);
	});

	it("does not restore epoch from durable compaction entries on a new tracker", () => {
		const target = model();
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		manager.appendCompaction("handoff summary", undefined, kept, 157_829, {
			tokensAfter: 15_343,
			method: "handoff",
		});
		expect(manager.getBranchView().some(entry => entry.type === "compaction")).toBe(true);

		// Same JSONL branch a continue/reload would see: compaction succeeded, epoch still 0.
		const resumed = createTracker(manager, target);
		expect(resumed.compactionEpoch).toBe(0);

		// In-process success after commit still advances the live counter.
		resumed.rebaseAfterCompaction();
		expect(resumed.compactionEpoch).toBe(1);

		// A later reconstruct (second process / new AgentSession) resets again.
		expect(createTracker(manager, target).compactionEpoch).toBe(0);
	});
});
