import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import { getDefaultConfig } from "../default-config";
import type { ModelProfile } from "../types";
import type { BenchmarkRuntime, BenchmarkRuntimeRequest, BenchmarkRuntimeResponse } from "./runner";

interface WorkflowToolDetails {
	workflowId?: string;
	status?: string;
}

interface WorkflowToolInput {
	op: "start" | "status" | "resume";
	request?: string;
	workflowId?: string;
	degradedMode?: boolean;
	singleStep?: boolean;
}

interface WorkflowToolPort {
	execute(toolCallId: string, input: WorkflowToolInput): Promise<AgentToolResult<WorkflowToolDetails>>;
}

export interface LiveBenchmarkRuntimeOptions {
	provider: string;
	model: string;
	agentDir?: string;
	maxResumeSteps?: number;
	/** Test seam; production defaults to a real createAgentSession + workflow tool run. */
	agentRunner?: LiveBenchmarkAgentRunner;
}

export interface LiveBenchmarkAgentResult {
	terminalStatus: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheObservable: boolean;
	costUsd: number;
	toolCalls: number;
}

export type LiveBenchmarkAgentRunner = (
	request: BenchmarkRuntimeRequest,
	cwd: string,
	options: LiveBenchmarkRuntimeOptions,
) => Promise<LiveBenchmarkAgentResult>;

function exact<T>(value: T): { value: T; provenance: "exact" } {
	return { value, provenance: "exact" };
}

function providerFact<T>(value: T): { value: T; provenance: "provider_fact" } {
	return { value, provenance: "provider_fact" };
}

export function buildLiveBenchmarkProfileOverrides(
	provider: string,
	model: string,
	variant: BenchmarkRuntimeRequest["variant"],
): Record<string, Partial<ModelProfile>> {
	const modelPattern = model.includes("/") ? model : `${provider}/${model}`;
	const profiles: Record<string, Partial<ModelProfile>> = {};
	for (const [id] of Object.entries(getDefaultConfig().profiles)) {
		profiles[id] =
			variant === "baseline"
				? {
						vendor: provider,
						modelPattern,
						promptStrategy: undefined,
						toolStrategy: undefined,
						contextStrategy: undefined,
						outputStrategy: undefined,
						toolAliases: undefined,
						argumentAliases: undefined,
						presentationPolicy: { enabled: false, mode: "direct" },
					}
				: { vendor: provider, modelPattern };
	}
	return profiles;
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
	const child = Bun.spawn(["/bin/zsh", "-dfc", command], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

async function initializeParserFixture(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "src"), { recursive: true });
	await fs.mkdir(path.join(root, "test"), { recursive: true });
	await Bun.write(
		path.join(root, "src/parser.ts"),
		"export function parseValue(input: string | null): string {\n\treturn input.trim();\n}\n",
	);
	await Bun.write(
		path.join(root, "test/parser.test.ts"),
		'import { describe, expect, it } from "bun:test";\nimport { parseValue } from "../src/parser";\n\ndescribe("parseValue", () => {\n\tit("returns an empty value for null input", () => {\n\t\texpect(parseValue(null)).toBe("");\n\t});\n\tit("trims string input", () => {\n\t\texpect(parseValue(" value ")).toBe("value");\n\t});\n});\n',
	);
	await Bun.write(
		path.join(root, "package.json"),
		`${JSON.stringify({ private: true, scripts: { check: "bun test test/parser.test.ts" } }, null, 2)}\n`,
	);
	await Bun.write(
		path.join(root, "AGENTS.md"),
		"Fix only the requested parser bug. Do not edit package.json or files outside src/parser.ts and test/parser.test.ts.\n",
	);
	for (const command of [
		"git init",
		"git config user.email workflow-bench@example.invalid",
		"git config user.name workflow-bench",
		"git add -A",
		"git commit -m fixture",
	]) {
		const result = await runCommand(command, root);
		if (result.exitCode !== 0) throw new Error(`Fixture setup failed: ${command}: ${result.output.slice(0, 300)}`);
	}
}

async function prepareFixture(request: BenchmarkRuntimeRequest): Promise<string> {
	if (request.case.repoFixture !== "synthetic-mini-parser") {
		throw new Error(`Live benchmark fixture is not implemented: ${request.case.repoFixture ?? request.case.id}`);
	}
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-workflow-bench-${request.case.id}-`));
	await initializeParserFixture(root);
	return root;
}

function workflowIdFrom(result: AgentToolResult<WorkflowToolDetails>): string | undefined {
	return result.details?.workflowId;
}

async function executeWorkflow(
	tool: WorkflowToolPort,
	request: BenchmarkRuntimeRequest,
	maxResumeSteps: number,
): Promise<string> {
	const started = await tool.execute(`workflow-bench-start-${request.repetition}`, {
		op: "start",
		request: request.case.request,
		degradedMode: true,
	} satisfies WorkflowToolInput);
	const workflowId = workflowIdFrom(started);
	if (!workflowId) throw new Error("Workflow start did not return a workflowId");

	let status = started.details?.status ?? "created";
	for (let step = 0; step < maxResumeSteps && !/^(completed|blocked|cancelled|failed)$/.test(status); step++) {
		const resumed = await tool.execute(`workflow-bench-resume-${request.repetition}-${step}`, {
			op: "resume",
			workflowId,
			singleStep: true,
		} satisfies WorkflowToolInput);
		status = resumed.details?.status ?? status;
	}
	return status;
}

function pathAllowed(file: string, allowedPaths: readonly string[]): boolean {
	return allowedPaths.some(allowed => file === allowed || file.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

async function runProductionWorkflow(
	request: BenchmarkRuntimeRequest,
	cwd: string,
	options: LiveBenchmarkRuntimeOptions,
): Promise<LiveBenchmarkAgentResult> {
	const settings = Settings.isolated({
		"workflow.enabled": true,
		"workflow.degradedMode": true,
		"workflow.requireIndependentReview": false,
		"workflow.verificationCommands": request.case.verificationCommands,
		"workflow.profiles": buildLiveBenchmarkProfileOverrides(options.provider, options.model, request.variant),
		"workflow.presentationOptimization.enabled": request.variant === "optimized",
		"task.isolation.mode": "auto",
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: options.agentDir,
		settings,
		modelPattern: `${options.provider}/${options.model}`,
		hasUI: false,
		autoApprove: true,
		toolNames: ["workflow", "read", "bash", "grep", "glob", "edit", "write", "todo", "yield"],
	});
	try {
		const tool = session.getToolByName("workflow") as WorkflowToolPort | undefined;
		if (!tool) throw new Error("Workflow tool is unavailable in the live benchmark session");
		const terminalStatus = await executeWorkflow(tool, request, options.maxResumeSteps ?? 16);
		const stats = session.getSessionStats();
		return {
			terminalStatus,
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cacheReadTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			// Session aggregates do not expose whether zero means observed-zero or unavailable.
			cacheObservable: false,
			costUsd: stats.cost,
			toolCalls: stats.toolCalls,
		};
	} finally {
		await session.dispose();
	}
}

async function runLiveCase(
	request: BenchmarkRuntimeRequest,
	options: LiveBenchmarkRuntimeOptions,
): Promise<BenchmarkRuntimeResponse> {
	const cwd = await prepareFixture(request);
	const startedAt = performance.now();
	try {
		const agentResult = await (options.agentRunner ?? runProductionWorkflow)(request, cwd, options);
		const verification = await Promise.all(
			request.case.verificationCommands.map(command => runCommand(command, cwd)),
		);
		const diff = await runCommand("git status --porcelain=v1 -z --untracked-files=all", cwd);
		const changedFiles = diff.output
			.split("\0")
			.filter(Boolean)
			.map(record => record.slice(3))
			.map(file => (file.includes(" -> ") ? file.slice(file.lastIndexOf(" -> ") + 4) : file));
		const scopeViolation = changedFiles.some(file => !pathAllowed(file, request.case.allowedPaths));
		const passed =
			agentResult.terminalStatus === "completed" &&
			verification.every(result => result.exitCode === 0) &&
			!scopeViolation;
		return {
			passed,
			firstPassed: passed,
			qualityScore: passed ? 1 : 0,
			durationMs: performance.now() - startedAt,
			scopeStatus: scopeViolation ? "violation" : "adhered",
			error: passed
				? undefined
				: `workflow=${agentResult.terminalStatus}; verification=${verification.map(v => v.exitCode).join(",")}; changed=${changedFiles.join(",")}`,
			tokens: {
				inputTokens: providerFact(agentResult.inputTokens),
				outputTokens: providerFact(agentResult.outputTokens),
				...(agentResult.cacheObservable
					? {
							cacheReadTokens: providerFact(agentResult.cacheReadTokens),
							cacheWriteTokens: providerFact(agentResult.cacheWriteTokens),
						}
					: {}),
				costUsd: providerFact(agentResult.costUsd),
				cacheObservable: agentResult.cacheObservable,
			},
			stage: {
				provider: options.provider,
				model: options.model,
				durationMs: exact(performance.now() - startedAt),
				toolCalls: exact(agentResult.toolCalls),
			},
		};
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

/** Costly, credentialed benchmark path. Callers must opt in explicitly. */
export function createLiveWorkflowBenchmarkRuntime(options: LiveBenchmarkRuntimeOptions): BenchmarkRuntime {
	if (!options.provider.trim() || !options.model.trim()) {
		throw new Error("Live benchmark requires explicit provider and model values");
	}
	return request => runLiveCase(request, options);
}
