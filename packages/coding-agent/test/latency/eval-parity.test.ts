import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as evalIndex from "../../src/eval";
import {
	buildEvalGateParityReceipt,
	mayMigrateEvalGate,
	recordOrRequireEvalParity,
} from "../../src/latency/eval-parity";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-parity-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("EvalTool parity gate wiring", () => {
	it("retains bridge control and reports unproven migration when armed", async () => {
		const settings = Settings.isolated({ "latency.arms.evalGateMigration": true });
		const executeSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
			displayOutputs: [],
		});

		const result = await new EvalTool(makeSession(settings)).execute("eval-gate", {
			language: "js",
			code: "1 + 1",
		});

		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.notice).toContain("parity receipt unavailable");
		expect(result.details?.notice).toContain("bridge control retained");
		expect(result.details?.notice).toContain("migration not proven");
	});
});

describe("EvalGateParityReceiptV1 migration gate", () => {
	const proven = buildEvalGateParityReceipt({
		sourceBridge: "eval-bridge",
		sourceRequestSha256: "a".repeat(64),
		sourceDecisionContract: "approved|changes_requested|blocked",
		sourceInlineIsolationContract: "inline+isolation",
		targetOwner: "workflow",
		parity: "proven",
	});

	it("keeps bridge control when the arm is off or parity is unknown/failed", () => {
		expect(recordOrRequireEvalParity(undefined, true)).toBe("bridge-control");
		expect(recordOrRequireEvalParity({ ...proven, parity: "unknown" }, true)).toBe("bridge-control");
		expect(recordOrRequireEvalParity({ ...proven, parity: "failed" }, true)).toBe("bridge-control");
		expect(recordOrRequireEvalParity(proven, false)).toBe("bridge-control");
		expect(mayMigrateEvalGate({ ...proven, parity: "failed" }, true)).toBe(false);
	});

	it("allows native control only for proven parity with the arm enabled", () => {
		expect(recordOrRequireEvalParity(proven, true)).toBe("native-control");
		expect(mayMigrateEvalGate(proven, true)).toBe(true);
	});
});
