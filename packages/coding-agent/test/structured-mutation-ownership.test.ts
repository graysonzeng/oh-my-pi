import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	collectShakeRegions,
	DEFAULT_PRUNE_CONFIG,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	prepareStructuredCompaction,
	type StructuredCompactionPatch,
} from "@oh-my-pi/pi-coding-agent/session/structured-compaction";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Real-file storage that parks every atomic rewrite behind a gate so tests can
 * hold a pending publish/repair deterministically while driving real public
 * entrypoints (`AgentSession.shake`, `dropImages`, manager branch/reset/swap).
 *
 * The gate only parks ATOMIC writes (`writeTextAtomic`): synchronous append
 * rewrites (`writeTextSync`) and the append writer land on real disk untouched,
 * matching how a concurrent append races a pending publish in production.
 */
class GatedFileStorage extends FileSessionStorage {
	/** Set false while seeding so the fixture can materialize the file with no parking. */
	gateEnabled = true;
	/** Resolves as soon as an atomic write is attempted (publish or repair). */
	readonly rewriteStarted = Promise.withResolvers<void>();
	/** Blocks every atomic write until the test resolves it. */
	readonly allowRewrite = Promise.withResolvers<void>();
	/** When > 0, the next atomic writes throw after the gate (publish or repair). */
	failNextWrites = 0;
	/** When true, failing writes also clobber the target so the repair sees a divergent file. */
	corruptOnFail = false;
	failedWrites = 0;
	guardRejections = 0;
	atomicWriteCount = 0;

	override async writeTextAtomic(fpath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicWriteCount++;
		if (this.gateEnabled) {
			this.rewriteStarted.resolve();
			await this.allowRewrite.promise;
		}
		if (this.failNextWrites > 0) {
			this.failNextWrites--;
			this.failedWrites++;
			if (this.corruptOnFail) this.writeTextSync(fpath, "^broken\n");
			throw new Error("injected atomic publish failure");
		}
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		return super.writeTextAtomic(fpath, content, options);
	}
}

const BIG_CALL_ID = "call-big-tail";

/** ~1500-token fenced block: a REAL aggressive-shake candidate (fenceMinTokens=400). */
const ORIGINAL_FENCE_BODY = "x".repeat(6_000);
/** ~450-token fenced block: still a REAL aggressive-shake candidate once committed. */
const SUMMARY_FENCE_BODY = "s".repeat(1_800);
/** ~45k-token suffix: clears the 40k structured protect window AND the 4k shake protect window. */
const TAIL_TEXT = "T".repeat(180_000);
const APPEND_TEXT = "appended during pending publish";

function fenced(body: string): string {
	return `\`\`\`
${body}
\`\`\`
`;
}

const usageZero = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Fixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
	sessionManager: SessionManager;
	storage: GatedFileStorage;
	xId: string;
}

async function openFixture(): Promise<Fixture> {
	const tempDir = TempDir.createSync("@pi-mutation-ownership-");
	let authStorage: AuthStorage;
	try {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const storage = new GatedFileStorage();
		storage.gateEnabled = false; // seed durably without parking
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path(), storage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Investigate the project." }],
			timestamp: now - 400,
		});
		const xId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: fenced(ORIGINAL_FENCE_BODY) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usageZero,
			timestamp: now - 300,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: BIG_CALL_ID, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usageZero,
			timestamp: now - 200,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: TAIL_TEXT }],
			isError: false,
			timestamp: now - 100,
		});
		// Materialize the file as CURRENT (full-body atomic write) so the next
		// rewrite's ensureOnDisk is a no-op and the FIRST parked atomic write is
		// genuinely the post-apply publish.
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		storage.gateEnabled = true;

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
			}),
			modelRegistry,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		return { tempDir, authStorage, session, sessionManager, storage, xId };
	} catch (error) {
		await tempDir.remove();
		throw error;
	}
}

async function disposeFixture(fixture: Fixture | undefined): Promise<void> {
	if (!fixture) return;
	try {
		await fixture.session.dispose();
	} finally {
		fixture.authStorage.close();
		await fixture.tempDir.remove();
	}
}

function visibleTokens(entries: readonly SessionEntry[]): number {
	const tokenizer = new Tokenizer();
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "message") total += tokenizer.countMessage(entry.message);
	}
	return total;
}

/**
 * A REAL structured patch whose single replacement rewrites the same-ID old
 * assistant message `xId` with a strict assistant summary. Prepared with the
 * real pure-preparation module and a deterministic summarize callback (the
 * same integration seam SessionMaintenance implements with models) — never a
 * hand-rolled runExclusive callback pretending to be a lifecycle operation.
 */
async function structuredSummaryPatch(sessionManager: SessionManager, xId: string): Promise<StructuredCompactionPatch> {
	const branch = sessionManager.getBranch();
	const tokenizer = new Tokenizer();
	const currentTokens = visibleTokens(branch);
	const patch = await prepareStructuredCompaction({
		entries: branch,
		tokenizer,
		// Protect everything from deterministic tool omission so the patch is
		// the ASSISTANT summary rewrite we need (same-ID shake target).
		pruneConfig: {
			...DEFAULT_PRUNE_CONFIG,
			protectTokens: Number.MAX_SAFE_INTEGER,
			minimumSavings: 0,
			protectedTools: [],
		},
		targetTokens: currentTokens - 500,
		currentTokens,
		signal: new AbortController().signal,
		summarize: async inputs => (inputs.length === 0 ? [] : [{ id: xId, text: `\n${fenced(SUMMARY_FENCE_BODY)}` }]),
	});
	if (!patch) throw new Error("Expected a usable structured patch");
	expect(patch.rewrite.replacements).toHaveLength(1);
	expect(patch.rewrite.replacements[0].id).toBe(xId);
	return patch;
}

function branchText(sessionManager: SessionManager, id: string): string | undefined {
	const entry = sessionManager.getEntry(id);
	if (entry?.type !== "message") return undefined;
	const message = entry.message;
	const content = message.role === "assistant" || message.role === "user" ? message.content : undefined;
	if (content === undefined) return undefined;
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function branchSummaryEntryPresent(sessionManager: SessionManager): boolean {
	return sessionManager.getBranch().some(entry => entry.type === "branch_summary");
}

/** Find the assistant shake placeholder once it has been elided. */
function liveAgentHasShakenPlaceholder(fixture: Fixture): boolean {
	return fixture.session.agent.state.messages.some(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
		return message.content.some(
			block => block.type === "text" && typeof block.text === "string" && /^\[shaken ~\d+ tokens/.test(block.text),
		);
	});
}

async function reloadFixture(
	fixture: Fixture,
	file: string = fixture.sessionManager.getSessionFile()!,
): Promise<SessionManager> {
	return SessionManager.open(file, fixture.tempDir.path(), undefined, {
		initialCwd: "/cwd",
		suppressBreadcrumb: true,
	});
}

describe("structured mutation ownership: real public entries queue behind a pending publish", () => {
	it("proves the same-ID assistant text is a REAL aggressive-shake candidate both as the committed summary and as the repaired preimage", async () => {
		// Committed state: X carries the summary fence.
		const committedFixture = await openFixture();
		try {
			const { sessionManager, storage, xId } = committedFixture;
			const tokenizer = new Tokenizer();
			const assertRealCandidate = (): void => {
				const regions = collectShakeRegions(sessionManager.getBranch(), tokenizer, AGGRESSIVE_SHAKE_CONFIG);
				expect(regions).toHaveLength(1);
				expect(regions[0].kind).toBe("block");
				expect(regions[0].entry.id).toBe(xId);
			};
			const patch = await structuredSummaryPatch(sessionManager, xId);
			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);
			await storage.rewriteStarted.promise;
			storage.allowRewrite.resolve();
			expect(await committing).toBe(true);
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			assertRealCandidate();
		} finally {
			committedFixture.storage.allowRewrite.resolve();
			await disposeFixture(committedFixture);
		}

		// Repaired state: publish fails; the repair restores the ORIGINAL
		// preimage, which is itself a real aggressive-shake candidate.
		const repairedFixture = await openFixture();
		try {
			const { sessionManager, storage, xId } = repairedFixture;
			const tokenizer = new Tokenizer();
			const patch = await structuredSummaryPatch(sessionManager, xId);
			const failing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);
			await storage.rewriteStarted.promise;
			storage.failNextWrites = 1;
			storage.allowRewrite.resolve();
			await expect(failing).rejects.toThrow("injected atomic publish failure");
			expect(branchText(sessionManager, xId)).toBe(fenced(ORIGINAL_FENCE_BODY));
			const regions = collectShakeRegions(sessionManager.getBranch(), tokenizer, AGGRESSIVE_SHAKE_CONFIG);
			expect(regions).toHaveLength(1);
			expect(regions[0].kind).toBe("block");
			expect(regions[0].entry.id).toBe(xId);
		} finally {
			repairedFixture.storage.allowRewrite.resolve();
			await disposeFixture(repairedFixture);
		}
	});

	it("queues a real public shake('elide') before its first mutation, then runs it against the REPAIRED state and preserves shake+append in live/JSONL/fresh reload", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);

			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);

			await storage.rewriteStarted.promise; // publish parked AFTER apply
			// Concurrent pure append: lands before the publish fences, so it must
			// survive the failed replacement untouched.
			sessionManager.appendMessage({ role: "user", content: APPEND_TEXT, timestamp: Date.now() });
			// REAL public aggressive shake on the same-ID old assistant message.
			const shaking = session.shake("elide");
			let shakingSettled = false;
			shaking.then(
				() => {
					shakingSettled = true;
				},
				() => {
					shakingSettled = true;
				},
			);
			// Queued before the shake's FIRST mutation: the patch content is
			// still live, the shake has neither run nor settled.
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			expect(branchText(sessionManager, xId)).not.toMatch(/^\[shaken/);
			expect(shakingSettled).toBe(false);

			storage.failNextWrites = 1;
			storage.allowRewrite.resolve();

			// Publish failed; the manager rolled back only the replacement and
			// repaired authoritatively, retaining the concurrent append.
			await expect(committing).rejects.toThrow("injected atomic publish failure");

			// The real shake now acquires the owner, re-reads the REPAIRED
			// state (the restored preimage), and completes its elision.
			const result = await shaking;
			expect(result.mode).toBe("elide");
			expect(result.blocksDropped).toBe(1);
			expect(result.toolResultsDropped).toBe(0);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(branchText(sessionManager, xId)).toMatch(/^\[shaken ~\d+ tokens/);

			// Live agent messages were re-synced to the shaken branch.
			expect(liveAgentHasShakenPlaceholder(fixture)).toBe(true);

			// Live, JSONL, and fresh reload must agree: shake placeholder +
			// append preserved; the failed patch summary is nowhere durable.
			expect(
				sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" && entry.message.role === "user" && entry.message.content === APPEND_TEXT,
					),
			).toBe(true);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");
			const raw = await storage.readText(sessionFile);
			expect(raw).toContain("[shaken ~");
			expect(raw).toContain(APPEND_TEXT);
			expect(raw).not.toContain(SUMMARY_FENCE_BODY);
			expect(raw).not.toContain(ORIGINAL_FENCE_BODY);

			const reloaded = await reloadFixture(fixture);
			const reloadedShaken = reloaded
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						JSON.stringify(entry.message.content).includes("[shaken ~"),
				);
			expect(reloadedShaken).toBe(true);
			expect(
				reloaded
					.getBranch()
					.some(
						entry =>
							entry.type === "message" && entry.message.role === "user" && entry.message.content === APPEND_TEXT,
					),
			).toBe(true);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("releases a queued real shake after a SUCCESSFUL publish; it runs against the committed content", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);

			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);

			await storage.rewriteStarted.promise; // publish parked, patch applied
			sessionManager.appendMessage({ role: "user", content: APPEND_TEXT, timestamp: Date.now() });
			const shaking = session.shake("elide");
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			expect(branchText(sessionManager, xId)).not.toMatch(/^\[shaken/);

			storage.allowRewrite.resolve(); // publish succeeds
			expect(await committing).toBe(true);
			expect(storage.failedWrites).toBe(0);

			// The queued shake was released and ran against the COMMITTED
			// content: it elided the summary's fenced block (the only
			// ≥400-token fence left on the branch).
			const result = await shaking;
			expect(result.blocksDropped).toBe(1);
			expect(branchText(sessionManager, xId)).toContain("[shaken ~");

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");
			const raw = await storage.readText(sessionFile);
			expect(raw).toContain("[shaken ~");
			expect(raw).toContain(APPEND_TEXT);
			// Neither the preimage fence nor the committed summary fence
			// survives: the shake elided the committed summary.
			expect(raw).not.toContain(SUMMARY_FENCE_BODY);
			expect(raw).not.toContain(ORIGINAL_FENCE_BODY);

			const reloaded = await reloadFixture(fixture);
			expect(
				reloaded
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							JSON.stringify(entry.message.content).includes("[shaken ~"),
					),
			).toBe(true);
			expect(
				reloaded
					.getBranch()
					.some(
						entry =>
							entry.type === "message" && entry.message.role === "user" && entry.message.content === APPEND_TEXT,
					),
			).toBe(true);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("keeps the indeterminate latch and rejects a real public shake without running it or writing anything", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);

			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);
			await storage.rewriteStarted.promise;
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			storage.failNextWrites = Number.POSITIVE_INFINITY; // publish AND repair fail
			storage.corruptOnFail = true; // divergent file forces a genuine indeterminate latch
			storage.allowRewrite.resolve();

			await expect(committing).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);

			// The REAL public shake is a queued mutation: the latch rejects it
			// fail-closed. It must NOT run, must NOT send a fallback write, and
			// must not claim success.
			await expect(session.shake("elide")).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
			expect(branchText(sessionManager, xId)).toBe(fenced(ORIGINAL_FENCE_BODY)); // untouched
			const raw = await storage.readText(sessionManager.getSessionFile()!);
			expect(raw).toBe("^broken\n"); // indeterminate: not a committed or shaken state
			expect(raw).not.toContain("[shaken");

			// Only authoritative recovery restores consistency; a NEW shake then
			// runs against the repaired state.
			storage.failNextWrites = 0;
			await sessionManager.recoverPersistenceFromCurrentState();
			const result = await session.shake("elide");
			expect(result.blocksDropped).toBe(1);
			expect(branchText(sessionManager, xId)).toMatch(/^\[shaken ~\d+ tokens/);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("applies, aborts the caller after apply, and still reports the real commit once publish succeeds — the abort neither masks it nor releases the lease early", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);
			const controller = new AbortController();

			const committing = sessionManager.runExclusive(
				() => sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true),
				{ signal: controller.signal },
			);
			await storage.rewriteStarted.promise; // applied, publish parked
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);

			// A plain waiter queued BEFORE the abort must keep waiting on the
			// parked publish — the caller's cancellation does not release the lease.
			let ranWhileHeld = false;
			const waiter = sessionManager.runExclusive(() => {
				ranWhileHeld = true;
			});
			controller.abort(); // caller cancels AFTER apply
			// One macrotask turn (zero real delay) so the queued chain can run;
			// asserting it did NOT run is timing-free.
			await Bun.sleep(0);
			expect(ranWhileHeld).toBe(false);

			storage.allowRewrite.resolve(); // publish still completes despite the abort
			expect(await committing).toBe(true); // commit truth is NOT masked by the abort
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			await waiter;
			expect(ranWhileHeld).toBe(true);

			const raw = await storage.readText(sessionManager.getSessionFile()!);
			expect(raw).toContain(SUMMARY_FENCE_BODY);

			// Exactly one committed application: replaying the now-stale patch
			// must be a rejected no-op (no second mutation, no double reset).
			expect(await sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true)).toBe(false);
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);

			// The cancellation surfaces for later callers: the next operation on
			// the aborted signal exits without executing — no automatic retry.
			let retried = false;
			await expect(
				sessionManager.runExclusive(
					() => {
						retried = true;
					},
					{ signal: controller.signal },
				),
			).rejects.toBe(controller.signal.reason);
			expect(retried).toBe(false);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("control: a pre-apply abort applies nothing, writes nothing, and yields no commit-only reset", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);
			const before = storage.atomicWriteCount;
			const controller = new AbortController();
			controller.abort();

			await expect(
				sessionManager.runExclusive(
					() => sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true),
					{ signal: controller.signal },
				),
			).rejects.toBe(controller.signal.reason);

			// Nothing applied, no atomic write attempted (no commit, so no
			// commit-only provider reset can exist at this layer).
			expect(branchText(sessionManager, xId)).toBe(fenced(ORIGINAL_FENCE_BODY));
			expect(storage.atomicWriteCount).toBe(before);

			// Same for the real public shake: an already-aborted signal exits
			// before any mutation path.
			await expect(session.shake("elide", { signal: controller.signal })).rejects.toBe(controller.signal.reason);
			expect(branchText(sessionManager, xId)).toBe(fenced(ORIGINAL_FENCE_BODY));
			expect(storage.atomicWriteCount).toBe(before);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("control: apply → publish failure → repair success with a cancelled caller surfaces the PERSISTENCE error (not the abort) and leaves no committed marker anywhere", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);
			const controller = new AbortController();

			const committing = sessionManager.runExclusive(
				() => sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true),
				{ signal: controller.signal },
			);
			await storage.rewriteStarted.promise;
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			controller.abort(); // caller cancelled after apply
			storage.failNextWrites = 1;
			storage.allowRewrite.resolve();

			// The granted operation runs to completion: the failure surfaced is
			// the persistence error, never the abort reason, and the rollback +
			// repair completed (restored preimage, no latch from repair success).
			await expect(committing).rejects.toThrow("injected atomic publish failure");
			expect(branchText(sessionManager, xId)).toBe(fenced(ORIGINAL_FENCE_BODY));

			const raw = await storage.readText(sessionManager.getSessionFile()!);
			expect(raw).toContain(ORIGINAL_FENCE_BODY);
			expect(raw).not.toContain(SUMMARY_FENCE_BODY); // no committed marker
			expect(raw).not.toContain("[shaken");

			const reloaded = await reloadFixture(fixture);
			expect(branchText(reloaded, xId)).toBe(fenced(ORIGINAL_FENCE_BODY));

			// Repair succeeded (no latch): a fresh commit still works cleanly.
			const fresh = await structuredSummaryPatch(sessionManager, xId);
			expect(await sessionManager.rewriteMessageEntriesAtomically(fresh.rewrite, () => true)).toBe(true);
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);

			// And the real public shake still runs after the committed rewrite.
			const result = await session.shake("elide");
			expect(result.blocksDropped).toBe(1);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("queues public dropImages and the branch/reset/branchWithSummary entries behind the pending publish, and a canceled waiter exits without executing", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId, session } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);

			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);
			const dropped = session.dropImages(); // REAL public entry
			const branched = sessionManager.branch(xId);
			const reset = sessionManager.resetLeaf();
			const summarised = sessionManager.branchWithSummary(xId, "branch note");

			const controller = new AbortController();
			let canceledRan = false;
			const canceledWaiter = sessionManager.runExclusive(
				() => {
					canceledRan = true;
				},
				{ signal: controller.signal },
			);
			controller.abort();
			await expect(canceledWaiter).rejects.toBe(controller.signal.reason);
			expect(canceledRan).toBe(false);

			await storage.rewriteStarted.promise; // publish parked
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			// None of the queued public entries have run yet — no first mutation.
			let settledBeforeRelease = 0;
			dropped.then(
				() => settledBeforeRelease++,
				() => settledBeforeRelease++,
			);
			branched.then(
				() => settledBeforeRelease++,
				() => settledBeforeRelease++,
			);
			reset.then(
				() => settledBeforeRelease++,
				() => settledBeforeRelease++,
			);
			summarised.then(
				() => settledBeforeRelease++,
				() => settledBeforeRelease++,
			);
			// One macrotask turn (zero real delay); the parked publish holds the
			// lease, so "none settled" is deterministic, not a duration guess.
			await Bun.sleep(0);
			expect(settledBeforeRelease).toBe(0);

			storage.allowRewrite.resolve();
			expect(await committing).toBe(true);
			expect(await dropped).toEqual({ removed: 0 });
			await branched;
			await reset;
			await summarised;

			// FIFO after the commit: the summary entry exists and the canceled
			// waiter never executed.
			expect(branchSummaryEntryPresent(sessionManager)).toBe(true);
			expect(canceledRan).toBe(false);
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});

	it("queues current-session replacement (createBranchedSession/setSessionFile/newSession) behind the pending publish and settles in order after it", async () => {
		const fixture = await openFixture();
		try {
			const { sessionManager, storage, xId } = fixture;
			const patch = await structuredSummaryPatch(sessionManager, xId);

			const committing = sessionManager.rewriteMessageEntriesAtomically(patch.rewrite, () => true);
			const branchedSession = sessionManager.createBranchedSession(xId);
			const alternate = path.join(fixture.tempDir.path(), "alternate-session.jsonl");
			const swapped = sessionManager.setSessionFile(alternate);
			const fresh = sessionManager.newSession();

			let settledBeforeRelease = 0;
			for (const pending of [branchedSession, swapped, fresh]) {
				pending.then(
					() => settledBeforeRelease++,
					() => settledBeforeRelease++,
				);
			}
			await storage.rewriteStarted.promise; // publish parked
			expect(branchText(sessionManager, xId)).toContain(SUMMARY_FENCE_BODY);
			// One macrotask turn (zero real delay); the parked publish holds the
			// lease, so "none settled" is deterministic, not a duration guess.
			await Bun.sleep(0);
			expect(settledBeforeRelease).toBe(0); // all queue, none execute early

			storage.allowRewrite.resolve();
			expect(await committing).toBe(true);
			expect(await branchedSession).toEqual(expect.any(String)); // new durable file
			await swapped;
			await fresh;
			expect(sessionManager.getSessionFile()).toBeDefined();
			// The manager is still usable after the swap sequence.
			sessionManager.appendMessage({ role: "user", content: "after swap", timestamp: Date.now() });
			await sessionManager.flush();
		} finally {
			fixture.storage.allowRewrite.resolve();
			await disposeFixture(fixture);
		}
	});
});
