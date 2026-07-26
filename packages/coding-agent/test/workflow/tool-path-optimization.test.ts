import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import {
	applyWorkflowTransformTools,
	parametersToJsonSchema,
	wrapAgentToolWithWorkflowAliases,
} from "../../src/tools/workflow-alias-wrap";
import { applyWorkflowToolSessionFields, pickWorkflowToolSessionFields } from "../../src/tools/workflow-session-fields";
import { DEFAULT_MODEL_PROFILES } from "../../src/workflow/default-config";
import { RuntimeAdapter, type StructuredRunnerRequest } from "../../src/workflow/runtime-adapter";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import { applySessionToolOutput, workflowToolWireName } from "../../src/workflow/tool-optimization";
import type { WorkflowAgentRequest } from "../../src/workflow/types";
import { fakeSession, implArtifact } from "./helpers";

/**
 * Contract: prepareWorkflowInvocation installs session.workflowToolOptimization;
 * createTools wraps AgentTools via wrapAgentToolWithWorkflowAliases so model-facing
 * schemas use argumentAliases and execute reverse-maps.
 *
 * wrap lives in tools/workflow-alias-wrap (not workflow/tool-optimization) so this
 * suite stays free of toolWireSchema / pi_natives.
 */
describe("live tool path helpers for workflowToolOptimization", () => {
	function prepareGrok() {
		return prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
	}

	it("workflowToolWireName exposes bash alias from prepared session", () => {
		const prep = prepareGrok();
		expect(workflowToolWireName(prep.session, "bash")).toBe("run_command");
		expect(workflowToolWireName(prep.session, "read")).toBeUndefined();
		expect(workflowToolWireName({} as never, "bash")).toBeUndefined();
	});

	it("toolAliases Proxy preserves private-field getters on description", () => {
		// Regression: Reflect.get(..., receiver=Proxy) breaks class #private fields
		// (live implement failed: TypeError on BashTool.#asyncEnabled via description).
		class PrivateFieldTool {
			name = "bash";
			#flag = true;
			get description(): string {
				return this.#flag ? "async-on" : "async-off";
			}
			get customWireName(): string | undefined {
				return undefined;
			}
			execute = async () => ({ content: [] });
		}
		const raw = new PrivateFieldTool();
		expect(raw.description).toBe("async-on");

		const wrapped = wrapAgentToolWithWorkflowAliases(raw, {
			workflowToolOptimization: { toolAliases: { bash: "run_command" } },
		});
		expect((wrapped as { customWireName?: string }).customWireName).toBe("run_command");
		expect((wrapped as { description: string }).description).toBe("async-on");
	});

	it("toolAliases Proxy executes class methods with the underlying private-field receiver", async () => {
		class PrivateFieldTool {
			name = "bash";
			parameters = { type: "object", properties: {} };
			#result = "executed";
			async execute(): Promise<string> {
				return this.#result;
			}
		}

		const wrapped = wrapAgentToolWithWorkflowAliases(new PrivateFieldTool(), {
			workflowToolOptimization: { toolAliases: { bash: "run_command" } },
		});

		expect(await wrapped.execute()).toBe("executed");
	});

	it("catalog schema-drop Proxy executes class methods with the underlying private-field receiver", async () => {
		class PrivateFieldTool {
			name = "read";
			description = "read a file";
			parameters = { type: "object", properties: { path: { type: "string" } } };
			#result = "catalog-executed";
			async execute(): Promise<string> {
				return this.#result;
			}
		}

		const [wrapped] = applyWorkflowTransformTools([new PrivateFieldTool()], {
			workflowToolOptimization: {
				transformTools: tools => tools.map(tool => ({ ...tool, schema: undefined })),
			},
		});

		expect(await wrapped?.execute()).toBe("catalog-executed");
	});

	it("composed production Proxies preserve the private-field execute receiver", async () => {
		const parameters = type({});
		class PrivateFieldTool {
			name = "read";
			label = "Read";
			description = "read a private result";
			parameters = parameters;
			#result = "composed-executed";
			get customWireName(): string | undefined {
				return undefined;
			}
			async execute(_toolCallId: string, _args: unknown) {
				return {
					content: [{ type: "text" as const, text: this.#result }],
					details: { result: this.#result },
				};
			}
		}

		const metaWrapped = wrapToolWithMetaNotice(new PrivateFieldTool());
		const aliasWrapped = wrapAgentToolWithWorkflowAliases(metaWrapped, {
			workflowToolOptimization: { toolAliases: { read: "read_file" } },
		});
		const [wrapped] = applyWorkflowTransformTools([aliasWrapped], {
			workflowToolOptimization: {
				transformTools: tools => tools.map(tool => ({ ...tool, customWireName: "read_file" })),
			},
		});

		expect(wrapped?.customWireName).toBe("read_file");
		expect(wrapped?.parameters).toBe(parameters);
		const result = await wrapped?.execute("call-composed", {});
		expect(result?.details).toEqual({ result: "composed-executed" });
	});

	it("applySessionToolOutput shortens oversized bash via session processResult", () => {
		const prep = prepareGrok();
		const huge = `${"test pass case_ok duration=1ms\n".repeat(400)}ERROR: compile failed\n`;
		const viaHelper = applySessionToolOutput(prep.session, "bash", huge, { exitCode: 1 });
		const viaPrep = prep.processToolResult("bash", huge, { exitCode: 1 });
		expect(viaHelper).toBe(viaPrep);
		expect(viaHelper.length).toBeLessThan(huge.length);
		expect(viaHelper).toMatch(/ERROR|Exit code/);
		// No optimization → passthrough
		expect(applySessionToolOutput({}, "bash", huge)).toBe(huge);
	});
});

describe("argumentAliases on live AgentTool surface (production wrap)", () => {
	function makeReadTool() {
		return {
			name: "read",
			label: "Read",
			description: "read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "file path" },
					offset: { type: "number" },
				},
				required: ["path"],
			},
			execute: async (_id: string, args: unknown) => {
				return {
					content: [{ type: "text" as const, text: JSON.stringify(args) }],
					details: { lastArgs: args },
				};
			},
		};
	}

	it("wrapAgentToolWithWorkflowAliases remaps path→file_path for grok_implementer", async () => {
		const prep = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const raw = makeReadTool();
		const rawWire = parametersToJsonSchema(raw.parameters);
		expect(rawWire?.properties).toHaveProperty("path");
		expect(rawWire?.properties).not.toHaveProperty("file_path");

		const wrapped = wrapAgentToolWithWorkflowAliases(raw, prep.session);
		const wire = parametersToJsonSchema(wrapped.parameters);
		// Model-facing schema must advertise file_path (profile argAliases)
		expect(wire?.properties).toHaveProperty("file_path");
		expect(wire?.properties).not.toHaveProperty("path");
		expect(wire?.required).toContain("file_path");
		expect(wire?.required).not.toContain("path");

		// execute reverse-maps wire args to internal path for the real tool body
		const result = await wrapped.execute("call-1", { file_path: "/tmp/demo.ts", offset: 3 });
		const text =
			result && typeof result === "object" && "content" in result
				? ((result as { content: Array<{ type: string; text?: string }> }).content.find(c => c.type === "text")
						?.text ?? "")
				: "";
		const seen = JSON.parse(text) as Record<string, unknown>;
		expect(seen.path).toBe("/tmp/demo.ts");
		expect(seen.file_path).toBeUndefined();
		expect(seen.offset).toBe(3);
	});

	it("RuntimeAdapter.run session is enough for wrap to change model-facing read schema", async () => {
		let seen: StructuredRunnerRequest | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seen = req;
			return {
				result: {
					id: "raw",
					structuredOutput: { status: "valid", data: implArtifact() },
				},
			};
		});
		await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
			isolation: { requested: true, merge: "patch", apply: true },
		});

		expect(seen?.session.workflowToolOptimization?.argumentAliases?.read?.path).toBe("file_path");
		const wrapped = wrapAgentToolWithWorkflowAliases(makeReadTool(), seen!.session);
		const wire = parametersToJsonSchema(wrapped.parameters);
		// Fails if aliases only sit on session but never reshape the tool surface.
		expect(wire?.properties).toHaveProperty("file_path");
		expect(wire?.properties).not.toHaveProperty("path");

		// transformTools on the request also remaps descriptor schemas (descriptor path)
		const descriptors = seen!.transformTools!([
			{
				name: "read",
				schema: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
			},
		]);
		expect(descriptors[0]?.schema?.properties).toHaveProperty("file_path");
		expect(descriptors[0]?.schema?.properties).not.toHaveProperty("path");
	});

	it("parametersToJsonSchema converts arktype-like schemas with toJsonSchema", () => {
		const arkLike = {
			toJsonSchema: () => ({
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			}),
		};
		const wire = parametersToJsonSchema(arkLike);
		expect(wire?.properties).toHaveProperty("path");

		const wrapped = wrapAgentToolWithWorkflowAliases(
			{
				name: "read",
				parameters: arkLike,
				execute: async (_id: string, args: unknown) => args,
			},
			{
				workflowToolOptimization: {
					argumentAliases: { read: { path: "file_path" } },
				},
			},
		);
		const remapped = parametersToJsonSchema(wrapped.parameters);
		expect(remapped?.properties).toHaveProperty("file_path");
		expect(remapped?.properties).not.toHaveProperty("path");
	});

	it("real arktype parameters (callable Type) remap path→file_path like ReadTool", async () => {
		const readSchema = type({ path: "string", "offset?": "number" });
		// typeof arktype Type is "function" — must not be rejected as non-object
		expect(typeof readSchema).toBe("function");
		const base = parametersToJsonSchema(readSchema);
		expect(base?.properties).toHaveProperty("path");

		const wrapped = wrapAgentToolWithWorkflowAliases(
			{
				name: "read",
				parameters: readSchema,
				execute: async (_id: string, args: unknown) => args,
			},
			{
				workflowToolOptimization: {
					argumentAliases: { read: { path: "file_path" } },
				},
			},
		);
		const wire = parametersToJsonSchema(wrapped.parameters);
		expect(wire?.properties).toHaveProperty("file_path");
		expect(wire?.properties).not.toHaveProperty("path");
		expect(wire?.required).toContain("file_path");

		const out = (await wrapped.execute("c1", { file_path: "/repo/a.ts", offset: 2 })) as Record<string, unknown>;
		expect(out.path).toBe("/repo/a.ts");
		expect(out.file_path).toBeUndefined();
	});
});

/**
 * Production chain (embedded path):
 * prepareWorkflowInvocation(session) → pickWorkflowToolSessionFields (buildExecutorOptions)
 * → CreateAgentSessionOptions → applyWorkflowToolSessionFields(toolSession) → createTools wrap
 *
 * Without pick→apply, createAgentSession builds a fresh ToolSession and createTools is a no-op
 * for aliases. These tests drive the shipped pick/apply helpers createAgentSession uses.
 */
describe("subagent ToolSession handoff of workflowToolOptimization", () => {
	function makeReadTool() {
		return {
			name: "read",
			parameters: {
				type: "object" as const,
				properties: {
					path: { type: "string" as const },
				},
				required: ["path"],
			},
			execute: async (_id: string, args: unknown) => args,
		};
	}

	it("fresh child session without handoff drops aliases (documents createAgentSession bug class)", () => {
		const prep = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		// Parent prepared session HAS optimization
		expect(prep.session.workflowToolOptimization?.argumentAliases?.read?.path).toBe("file_path");

		// Fresh child ToolSession (createAgentSession without apply) loses it
		const childWithoutHandoff = fakeSession();
		expect(childWithoutHandoff.workflowToolOptimization).toBeUndefined();
		const bare = wrapAgentToolWithWorkflowAliases(makeReadTool(), childWithoutHandoff);
		const bareWire = parametersToJsonSchema(bare.parameters);
		expect(bareWire?.properties).toHaveProperty("path");
		expect(bareWire?.properties).not.toHaveProperty("file_path");
	});

	it("pick→apply (createAgentSession path) restores optimization so createTools wrap remaps file_path", async () => {
		const prep = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		// Same pick used by buildExecutorOptions from request.session
		const fields = pickWorkflowToolSessionFields(prep.session);
		expect(fields.workflowToolOptimization?.argumentAliases?.read?.path).toBe("file_path");
		expect(fields.workflowToolOptimization?.processResult).toBeTypeOf("function");
		// implementer also gets write/command policies on prepared session
		expect(fields.workflowWritePolicy?.repoRoot).toBeDefined();
		expect(fields.workflowCommandPolicy?.allowedCommands?.length).toBeGreaterThan(0);

		// Same apply used by createAgentSession before createTools
		const childSession = fakeSession();
		applyWorkflowToolSessionFields(childSession, fields);
		expect(childSession.workflowToolOptimization?.argumentAliases?.read?.path).toBe("file_path");

		// createTools calls wrapAgentToolWithWorkflowAliases(tool, toolSession)
		const wrapped = wrapAgentToolWithWorkflowAliases(makeReadTool(), childSession);
		const wire = parametersToJsonSchema(wrapped.parameters);
		expect(wire?.properties).toHaveProperty("file_path");
		expect(wire?.properties).not.toHaveProperty("path");

		const out = (await wrapped.execute("c1", { file_path: "/child/x.ts" })) as Record<string, unknown>;
		expect(out.path).toBe("/child/x.ts");

		// processResult also survives handoff (bash/read/grep path)
		const huge = `${"ok\n".repeat(200)}ERROR: boom\n`;
		const processed = childSession.workflowToolOptimization!.processResult("bash", huge, { exitCode: 1 });
		expect(processed.length).toBeLessThan(huge.length);
		expect(processed).toMatch(/ERROR/);
	});

	it("RuntimeAdapter prepared session survives pick→apply into child createTools surface", async () => {
		let seen: StructuredRunnerRequest | undefined;
		const adapter = new RuntimeAdapter(async req => {
			seen = req;
			return {
				result: {
					id: "raw",
					structuredOutput: { status: "valid", data: implArtifact() },
				},
			};
		});
		await adapter.run({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
			isolation: { requested: true, merge: "patch", apply: true },
		});

		// Production runner receives prepared session; subagent must hand off its fields
		const fields = pickWorkflowToolSessionFields(seen!.session);
		const child = fakeSession();
		applyWorkflowToolSessionFields(child, fields);
		const wrapped = wrapAgentToolWithWorkflowAliases(makeReadTool(), child);
		const wire = parametersToJsonSchema(wrapped.parameters);
		expect(wire?.properties).toHaveProperty("file_path");
		expect(wire?.properties).not.toHaveProperty("path");
	});
});
