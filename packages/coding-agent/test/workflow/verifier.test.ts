import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Verifier } from "../../src/workflow/verifier";

describe("Verifier", () => {
	let artifactDir: string;

	beforeEach(async () => {
		artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-verifier-"));
	});

	afterEach(async () => {
		await fs.rm(artifactDir, { recursive: true, force: true });
	});

	it("executes an allowed command successfully", async () => {
		const verifier = new Verifier({ cwd: process.cwd(), artifactDir });
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			'echo "test"',
		]);
		expect(result.passed).toBe(true);
		expect(result.checks[0]).toMatchObject({ status: "passed", exitCode: 0 });
	});

	it("fails non-zero exits", async () => {
		const verifier = new Verifier({
			cwd: process.cwd(),
			artifactDir,
			spawn: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
		});
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			"bun test",
		]);
		expect(result.passed).toBe(false);
		expect(result.checks[0]?.exitCode).toBe(2);
	});

	it("handles timeout and cancellation", async () => {
		const verifier = new Verifier({
			cwd: process.cwd(),
			artifactDir,
			spawn: async () => {
				await Bun.sleep(50);
				return { exitCode: 0, stdout: "ok", stderr: "" };
			},
		});
		const timed = await verifier.verify(
			{ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" },
			["echo ok"],
			[],
			{ timeoutMs: 1 },
		);
		expect(timed.checks[0]?.summary).toMatch(/timed out|timeout/i);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await verifier.verify(
			{ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" },
			["echo ok"],
			[],
			{ signal: controller.signal },
		);
		expect(cancelled.checks[0]?.summary).toMatch(/cancel/i);
	});

	it("detects forbidden paths and unchanged tree", async () => {
		const verifier = new Verifier({ cwd: process.cwd(), artifactDir });
		const forbidden = await verifier.verify(
			{
				workflowId: "wf1",
				attemptId: "att1",
				stage: "implementation_verify",
				changedFiles: ["forbidden/file.ts"],
			},
			[],
			["forbidden"],
		);
		expect(forbidden.passed).toBe(false);

		const unchanged = await verifier.verify(
			{ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify", changedFiles: [] },
			[],
			[],
			{ expectDirtyTree: true },
		);
		expect(unchanged.checks.some(c => c.id === "unchanged-tree")).toBe(true);
	});

	it("rejects secret-like patch without logging the secret", async () => {
		const secret = "api_key=sk-super-secret-value-12345";
		const verifier = new Verifier({ cwd: process.cwd(), artifactDir });
		const result = await verifier.verify(
			{
				workflowId: "wf1",
				attemptId: "att1",
				stage: "implementation_verify",
				patchContent: `diff\n+const x = '${secret}'`,
			},
			[],
		);
		expect(result.passed).toBe(false);
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("sk-super-secret-value-12345");
		expect(result.checks.some(c => c.id === "secret-scan")).toBe(true);
	});

	it("secret scan does not flip-flop on consecutive identical patches (global regex lastIndex)", async () => {
		const patch = "password=supersecretvalue99";
		const verifier = new Verifier({ cwd: process.cwd(), artifactDir });
		const first = await verifier.verify(
			{ workflowId: "wf1", attemptId: "a1", stage: "implementation_verify", patchContent: patch },
			[],
		);
		const second = await verifier.verify(
			{ workflowId: "wf1", attemptId: "a2", stage: "implementation_verify", patchContent: patch },
			[],
		);
		expect(first.checks.some(c => c.id === "secret-scan")).toBe(true);
		expect(second.checks.some(c => c.id === "secret-scan")).toBe(true);
	});

	it("redacts every secret occurrence in command output (not only the first)", async () => {
		const verifier = new Verifier({
			cwd: process.cwd(),
			artifactDir,
			spawn: async () => ({
				exitCode: 0,
				stdout: "token=abcdefghij password=ijklmnopqr",
				stderr: "",
			}),
		});
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			"echo ok",
		]);
		const summary = result.checks[0]?.summary ?? "";
		expect(summary).not.toContain("abcdefghij");
		expect(summary).not.toContain("ijklmnopqr");
		expect(summary).toContain("[REDACTED]");
		// both keys redacted
		expect((summary.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("rejects unsafe shell syntax", async () => {
		const verifier = new Verifier({ cwd: process.cwd(), artifactDir });
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			"echo ok; echo unsafe",
		]);
		expect(result.checks[0]).toMatchObject({ status: "failed", summary: "Command rejected by verification policy" });
	});

	it("writes log artifact with truncation policy", async () => {
		const verifier = new Verifier({
			cwd: process.cwd(),
			artifactDir,
			spawn: async () => ({ exitCode: 0, stdout: "x".repeat(100), stderr: "" }),
		});
		const result = await verifier.verify({ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" }, [
			"echo ok",
		]);
		expect(result.checks[0]?.logPath).toBeTruthy();
		const log = await fs.readFile(result.checks[0]!.logPath!, "utf8");
		expect(log.length).toBeGreaterThan(0);
	});

	it("kills the child process on timeout via abort signal", async () => {
		let aborted = false;
		const verifier = new Verifier({
			cwd: process.cwd(),
			artifactDir,
			spawn: async (_argv, opts) => {
				const { promise, resolve, reject } = Promise.withResolvers<{
					exitCode: number;
					stdout: string;
					stderr: string;
				}>();
				const timer = setTimeout(() => resolve({ exitCode: 0, stdout: "late", stderr: "" }), 5_000);
				opts.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
				return promise;
			},
		});
		const result = await verifier.verify(
			{ workflowId: "wf1", attemptId: "att1", stage: "implementation_verify" },
			["echo ok"],
			[],
			{ timeoutMs: 20 },
		);
		expect(result.checks[0]?.summary).toMatch(/timed out|timeout/i);
		expect(aborted).toBe(true);
	});
});
