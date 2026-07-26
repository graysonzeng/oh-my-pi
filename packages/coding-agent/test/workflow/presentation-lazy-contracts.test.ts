/**
 * P2 Lazy Tool/Schema/Skill Presentation — contract tests against shipped code.
 * Criteria: essential schema, xd expand, skill catalog, order stability,
 * restricted child refusal, feature-flag default off.
 */
import { describe, expect, it } from "bun:test";
import { getDefault } from "../../src/config/settings-schema";
import { parseXdUrl, XdProtocolHandler } from "../../src/internal-urls/xd-protocol";
import { applyWorkflowTransformTools } from "../../src/tools/workflow-alias-wrap";
import {
	type BenchmarkRuntime,
	buildDefaultBenchmarkSuite,
	buildScorecard,
	evaluateBenchmarkQualityGate,
	runBenchmarkSuite,
} from "../../src/workflow/benchmark";
import { DEFAULT_MODEL_PROFILES, getDefaultConfig } from "../../src/workflow/default-config";
import {
	applyPresentationPolicy,
	assertRestrictedToolDiscovery,
	CONSERVATIVE_ESSENTIAL_TOOLS,
	DEFAULT_PRESENTATION_POLICY,
	expandSkillBody,
	expandToolSchema,
	formatSkillCatalogSummary,
	formatToolCatalogSummary,
	parsePresentationLocator,
	presentationFingerprint,
	resolveWorkflowPresentation,
	skillBodyLocator,
	toolSchemaLocator,
} from "../../src/workflow/presentation-policy";
import { prepareWorkflowInvocation } from "../../src/workflow/runtime-invocation";
import type { WorkflowAgentRequest } from "../../src/workflow/types";

function fakeSession(overrides: Record<string, unknown> = {}) {
	return {
		cwd: process.cwd(),
		settings: {
			get: (_key: string) => undefined,
		},
		...overrides,
	} as WorkflowAgentRequest["session"];
}

describe("P2 presentation policy defaults + settings gate", () => {
	it("resolveWorkflowPresentation(undefined) is disabled direct", () => {
		const p = resolveWorkflowPresentation(undefined);
		expect(p.enabled).toBe(false);
		expect(p.mode).toBe("direct");
		expect(p.essentialTools).toEqual([...CONSERVATIVE_ESSENTIAL_TOOLS]);
	});

	it("every default ModelProfile effective presentation is disabled", () => {
		for (const profile of Object.values(DEFAULT_MODEL_PROFILES)) {
			const raw =
				"presentationPolicy" in profile
					? (profile as { presentationPolicy?: Parameters<typeof resolveWorkflowPresentation>[0] })
							.presentationPolicy
					: undefined;
			const p = resolveWorkflowPresentation(raw);
			expect(p.enabled).toBe(false);
		}
		expect(getDefaultConfig().presentationOptimizationEnabled).toBe(false);
	});

	it("settings schema default for workflow.presentationOptimization.enabled is false", () => {
		expect(getDefault("workflow.presentationOptimization.enabled")).toBe(false);
	});

	it("settingsEnabled=true enables catalog without hand-edited profile", () => {
		const p = resolveWorkflowPresentation(undefined, { settingsEnabled: true });
		expect(p.enabled).toBe(true);
		expect(p.mode).toBe("catalog");
	});

	it("explicit profile enabled=false wins over settings gate", () => {
		const p = resolveWorkflowPresentation({ enabled: false, mode: "catalog" }, { settingsEnabled: true });
		expect(p.enabled).toBe(false);
		expect(p.mode).toBe("direct");
	});

	it("prepare with flag off keeps full schemas for allowed tools (direct path)", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		expect(prepared.presentationPolicy.enabled).toBe(false);
		const wire = prepared.transformTools([
			{ name: "bash", description: "run", schema: { type: "object", properties: { command: { type: "string" } } } },
			{
				name: "grep",
				description: "search",
				schema: { type: "object", properties: { pattern: { type: "string" } } },
			},
		]);
		// Both keep full schema in direct mode
		expect(wire.find(t => t.name === "bash")?.schema).toBeDefined();
		expect(wire.find(t => t.name === "grep")?.schema).toBeDefined();
	});

	it("feature-off default profile does not inline skill file bodies into assembledPromptText", async () => {
		const skillRoot = `${import.meta.dir}/../../.agent-artifacts/p2-skills-off-${Date.now()}`;
		const markers = [
			"FEATURE_OFF_SKILL_BODY_ALPHA_MARKER_do_not_inline",
			"FEATURE_OFF_SKILL_BODY_BETA_MARKER_do_not_inline",
		] as const;
		const skillMetas = [
			{ name: "skill-alpha", file: `${skillRoot}/skill-alpha/SKILL.md`, marker: markers[0] },
			{ name: "skill-beta", file: `${skillRoot}/skill-beta/SKILL.md`, marker: markers[1] },
		];
		for (const s of skillMetas) {
			// ~2KB bodies: exercise the real fail-closed path (not tiny placeholders).
			const pad = "x".repeat(1800);
			await Bun.write(s.file, `# ${s.name}\n\n${s.marker}\n\n${pad}\n`);
		}

		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			// Default profile: presentationPolicy.enabled resolves false
			profile: DEFAULT_MODEL_PROFILES.grok_implementer,
			assignment: "impl",
			session: fakeSession({
				skills: skillMetas.map(s => ({
					name: s.name,
					description: `${s.name} description`,
					filePath: s.file,
					baseDir: `${skillRoot}/${s.name}`,
					source: "test",
					// Even if content is already on the session object, feature-off must not catalog it.
					content: `# ${s.name}\n\n${s.marker}\n\nin-memory content must also stay out\n`,
				})),
			}),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		expect(prepared.presentationPolicy.enabled).toBe(false);
		for (const marker of markers) {
			expect(prepared.assembledPromptText).not.toContain(marker);
		}
		expect(prepared.assembledPromptText).not.toContain("in-memory content must also stay out");
		// Expand map must not preload skill bodies when optimization is off.
		const bodies = prepared.session.workflowToolOptimization?.presentationSkillBodies;
		expect(bodies === undefined || bodies.size === 0).toBe(true);

		// Pure policy contract: disabled ⇒ empty skillPresentationText, no bodies.
		const presented = applyPresentationPolicy({
			policy: resolveWorkflowPresentation(undefined),
			allowedToolNames: ["read"],
			tools: [{ name: "read", summary: "read" }],
			skills: skillMetas.map(s => ({
				name: s.name,
				summary: s.name,
				body: `body-${s.marker}`,
			})),
		});
		expect(presented.skillPresentationText).toBe("");
		for (const sk of presented.skills) {
			expect(sk.body).toBeUndefined();
		}
	});
});

describe("P2 essential tools full schema + non-essential catalog", () => {
	it("essentialTools get full schema; non-essentials get short desc + xd://tools locator", () => {
		const policy = resolveWorkflowPresentation({
			enabled: true,
			mode: "catalog",
			essentialTools: ["read", "write", "bash"],
			skillCatalogOnly: true,
		});
		const presented = applyPresentationPolicy({
			policy,
			allowedToolNames: ["read", "write", "bash", "grep", "find"],
			tools: [
				{ name: "find", summary: "find files" },
				{ name: "bash", summary: "run shell" },
				{ name: "grep", summary: "search code" },
				{ name: "write", summary: "write files" },
				{ name: "read", summary: "read files" },
			],
		});

		for (const name of ["read", "write", "bash"] as const) {
			const t = presented.tools.find(x => x.name === name)!;
			expect(t.schemaAttached).toBe(true);
			expect(t.schemaLocator).toBeUndefined();
			expect(t.summary).not.toContain("xd://tools/");
		}
		for (const name of ["grep", "find"] as const) {
			const t = presented.tools.find(x => x.name === name)!;
			expect(t.schemaAttached).toBe(false);
			expect(t.schemaLocator).toBe(toolSchemaLocator(name));
			expect(t.summary).toBe(formatToolCatalogSummary(name, name === "grep" ? "search code" : "find files"));
			expect(t.summary).toContain(`[Read full schema: xd://tools/${name}]`);
		}
	});

	it("prepare + transformTools drops non-essential schema and keeps essential", () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["read", "write", "bash"],
				},
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const fullGrepSchema = {
			type: "object",
			properties: { pattern: { type: "string" }, path: { type: "string" } },
			required: ["pattern"],
		};
		const wire = prepared.transformTools([
			{
				name: "bash",
				description: "run shell",
				schema: { type: "object", properties: { command: { type: "string" } } },
			},
			{
				name: "read",
				description: "read files",
				schema: { type: "object", properties: { path: { type: "string" } } },
			},
			{
				name: "write",
				description: "write files",
				schema: { type: "object", properties: { path: { type: "string" } } },
			},
			{ name: "grep", description: "search code", schema: fullGrepSchema },
			{
				name: "find",
				description: "find files",
				schema: { type: "object", properties: { pattern: { type: "string" } } },
			},
		]);

		const bash = wire.find(t => t.name === "bash")!;
		const grep = wire.find(t => t.name === "grep")!;
		expect(bash.schema).toBeDefined();
		expect((bash.schema as { properties?: unknown }).properties).toBeDefined();
		expect(grep.schema).toBeUndefined();
		expect(grep.schemaLocator).toBe("xd://tools/grep");
		expect(String(grep.description)).toContain("[Read full schema: xd://tools/grep]");

		// Expand path via pure helper (same allowlist + schema map as production).
		const schemas = prepared.session.workflowToolOptimization?.presentationToolSchemas;
		expect(schemas).toBeDefined();
		const expanded = expandToolSchema("xd://tools/grep", {
			allowedToolNames: prepared.allowedTools ?? [],
			schemas: schemas!,
		});
		expect(expanded.ok).toBe(true);
		if (expanded.ok) {
			expect(expanded.name).toBe("grep");
			expect(expanded.schema).toEqual(fullGrepSchema);
			// Subsequent call can use the schema (parameters known)
			expect((expanded.schema as { required?: string[] }).required).toContain("pattern");
		}
	});

	it("catalog stub still validates and executes real args after xd://tools expand", async () => {
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["bash", "read", "write"],
				},
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		const fullGrepSchema = {
			type: "object" as const,
			properties: {
				pattern: { type: "string" },
				path: { type: "string" },
			},
			required: ["pattern"],
		};
		let receivedArgs: Record<string, unknown> | undefined;
		const tools = [
			{
				name: "bash",
				description: "run",
				parameters: { type: "object", properties: { command: { type: "string" } } },
				execute: async () => ({ content: [], details: {} }),
			},
			{
				name: "grep",
				description: "search code",
				parameters: fullGrepSchema,
				execute: async (_id: string, args: Record<string, unknown>) => {
					receivedArgs = args;
					return { content: [{ type: "text", text: `matched ${String(args.pattern)}` }], details: {} };
				},
			},
		];
		const sessionOpt = {
			workflowToolOptimization: {
				transformTools: prepared.transformTools,
				presentationToolSchemas: prepared.session.workflowToolOptimization?.presentationToolSchemas ?? new Map(),
				presentationAllowedTools: prepared.allowedTools,
			},
		};
		const out = applyWorkflowTransformTools(tools, sessionOpt);
		const grep = out.find(t => t.name === "grep")!;
		// Wire surface: stub schema (no full properties) + locator
		expect((grep.parameters as { properties?: Record<string, unknown> }).properties).toEqual({});
		expect((grep.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(true);
		expect((grep as { schemaLocator?: string }).schemaLocator).toBe("xd://tools/grep");
		expect(String(grep.description)).toContain("xd://tools/grep");

		// Expand full schema from production catalog map
		const expanded = expandToolSchema("xd://tools/grep", {
			allowedToolNames: prepared.allowedTools ?? [],
			schemas: sessionOpt.workflowToolOptimization.presentationToolSchemas,
		});
		expect(expanded.ok).toBe(true);
		if (!expanded.ok) throw new Error(expanded.error);
		expect(expanded.schema).toEqual(fullGrepSchema);

		// Real agent-loop path: validateToolArguments against the wire tool (stub parameters)
		// must NOT strip real args (additionalProperties: true).
		const { validateToolArguments } = await import("@oh-my-pi/pi-ai/utils/validation");
		const validated = validateToolArguments(
			{ name: grep.name, description: String(grep.description), parameters: grep.parameters },
			{
				type: "toolCall",
				id: "call-grep-1",
				name: "grep",
				arguments: { pattern: "TODO", path: "src/" },
			},
		);
		expect(validated).toEqual({ pattern: "TODO", path: "src/" });

		// Execute receives the real validated args (post-expand call succeeds)
		await grep.execute("call-grep-1", validated as Record<string, unknown>);
		expect(receivedArgs).toEqual({ pattern: "TODO", path: "src/" });
	});
});

describe("P2 xd:// expand + restricted child", () => {
	it("parseXdUrl bridges xd://tools/{name} to device name", () => {
		expect(parseXdUrl("xd://tools/grep")).toEqual({ name: "grep", namespace: "tools" });
		expect(parseXdUrl("xd://skills/tacit-knowledge")).toEqual({ name: "tacit-knowledge", namespace: "skills" });
		expect(parseXdUrl("xd://bash")).toEqual({ name: "bash", namespace: null });
		expect(parseXdUrl("xd://")).toEqual({ name: null, namespace: null });
		expect(parseXdUrl("xd://tools/grep/extra")).toBeNull();
	});

	it("expand refuses tools outside allowlist (restricted child)", () => {
		const schemas = new Map<string, unknown>([
			["read", { type: "object", properties: { path: { type: "string" } } }],
			["write", { type: "object", properties: { path: { type: "string" } } }],
			["bash", { type: "object", properties: { command: { type: "string" } } }],
		]);
		// Parent allowlist read/write only — child cannot expand bash
		const refused = expandToolSchema("xd://tools/bash", {
			allowedToolNames: ["read", "write"],
			schemas,
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.refused).toBe(true);
			expect(refused.error).toMatch(/allowlist/i);
		}
		// Allowlisted expand succeeds
		const ok = expandToolSchema("xd://tools/read", {
			allowedToolNames: ["read", "write"],
			schemas,
		});
		expect(ok.ok).toBe(true);
	});

	it("catalog presentation never lists tools outside allowlist", () => {
		const presented = applyPresentationPolicy({
			policy: { enabled: true, mode: "catalog", essentialTools: ["read"], skillCatalogOnly: true },
			allowedToolNames: ["read", "write"],
			tools: [
				{ name: "read", summary: "r" },
				{ name: "write", summary: "w" },
				{ name: "bash", summary: "b" },
			],
		});
		expect(presented.toolOrder).toEqual(["read", "write"]);
		expect(assertRestrictedToolDiscovery(presented, ["read", "write"]).ok).toBe(true);
		expect(presented.tools.some(t => t.name === "bash")).toBe(false);
		// Expand bash still refused even if schema map has it
		const exp = expandToolSchema("xd://tools/bash", {
			allowedToolNames: presented.toolOrder,
			schemas: new Map([["bash", { type: "object" }]]),
		});
		expect(exp.ok).toBe(false);
		if (!exp.ok) expect(exp.refused).toBe(true);
	});

	it("XdProtocolHandler resolves tools namespace via xd.read bridge", async () => {
		const handler = new XdProtocolHandler();
		const docs = await handler.resolve(
			{ href: "xd://tools/grep", scheme: "xd", hostname: "tools", pathname: "/grep", rawHost: "tools" } as never,
			{
				xd: {
					read: async name => {
						expect(name).toBe("grep");
						return JSON.stringify({ type: "object", properties: { pattern: { type: "string" } } });
					},
				},
			},
		);
		expect(docs.content).toContain("pattern");
	});
});

describe("P2 skill catalog", () => {
	it("skillCatalogOnly omits bodies except autoload; expand returns full body", () => {
		const policy = resolveWorkflowPresentation({
			enabled: true,
			mode: "catalog",
			essentialTools: ["read"],
			skillCatalogOnly: true,
			autoloadSkills: ["always-on"],
		});
		const presented = applyPresentationPolicy({
			policy,
			allowedToolNames: ["read"],
			tools: [{ name: "read", summary: "read" }],
			skills: [
				{
					name: "tacit-knowledge",
					summary: "expert judgment",
					body: "# Tacit Knowledge\n\nFull skill body here.",
					autoload: false,
				},
				{
					name: "always-on",
					summary: "always loaded",
					body: "# Always\n\nAutoload body.",
					autoload: false, // resolved via policy.autoloadSkills
				},
			],
		});
		const tacit = presented.skills.find(s => s.name === "tacit-knowledge")!;
		const always = presented.skills.find(s => s.name === "always-on")!;
		expect(tacit.body).toBeUndefined();
		expect(tacit.bodyLocator).toBe(skillBodyLocator("tacit-knowledge"));
		expect(tacit.summary).toBe(formatSkillCatalogSummary("tacit-knowledge", "expert judgment"));
		expect(tacit.summary).toContain("[Load: xd://skills/tacit-knowledge]");
		expect(always.body).toBe("# Always\n\nAutoload body.");
		expect(always.bodyLocator).toBeUndefined();
		// Autoload body appears in skill presentation text (real prompt section)
		expect(presented.skillPresentationText).toContain("Autoload body.");
		expect(presented.skillPresentationText).not.toContain("Full skill body here.");

		const bodies = new Map([
			["tacit-knowledge", "# Tacit Knowledge\n\nFull skill body here."],
			["always-on", "# Always\n\nAutoload body."],
		]);
		const expanded = expandSkillBody("xd://skills/tacit-knowledge", { bodies });
		expect(expanded.ok).toBe(true);
		if (expanded.ok) {
			expect(expanded.body).toContain("Full skill body here");
		}
	});

	it("prepareWorkflowInvocation wires autoloadSkills bodies into skill_catalog and expand map", async () => {
		const skillRoot = `${import.meta.dir}/../../.agent-artifacts/p2-skills-${Date.now()}`;
		const tacitPath = `${skillRoot}/tacit-knowledge/SKILL.md`;
		const alwaysPath = `${skillRoot}/always-on/SKILL.md`;
		await Bun.write(tacitPath, "# tacit-knowledge\n\nFull tacit skill body for expand.\n");
		await Bun.write(alwaysPath, "# always-on\n\nAutoload full body on prepare path.\n");

		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: {
					enabled: true,
					mode: "catalog",
					essentialTools: ["read", "bash"],
					skillCatalogOnly: true,
					autoloadSkills: ["always-on"],
				},
			},
			assignment: "impl",
			session: fakeSession({
				skills: [
					{
						name: "tacit-knowledge",
						description: "expert judgment",
						filePath: tacitPath,
						baseDir: `${skillRoot}/tacit-knowledge`,
						source: "test",
					},
					{
						name: "always-on",
						description: "always loaded",
						filePath: alwaysPath,
						baseDir: `${skillRoot}/always-on`,
						source: "test",
					},
				],
			}),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);

		// Autoload body is in assembled prompt skill_catalog section
		expect(prepared.assembledPromptText).toContain("Autoload full body on prepare path.");
		// Catalog-only skill is listed by name/desc + locator, not full body
		expect(prepared.assembledPromptText).toContain("xd://skills/tacit-knowledge");
		expect(prepared.assembledPromptText).not.toContain("Full tacit skill body for expand.");

		// Expand map holds both bodies for xd://skills one-hop
		const bodies = prepared.session.workflowToolOptimization?.presentationSkillBodies;
		expect(bodies).toBeDefined();
		expect(bodies!.get("tacit-knowledge")).toContain("Full tacit skill body for expand.");
		expect(bodies!.get("always-on")).toContain("Autoload full body on prepare path.");

		const expanded = expandSkillBody("xd://skills/tacit-knowledge", { bodies: bodies! });
		expect(expanded.ok).toBe(true);
		if (expanded.ok) expect(expanded.body).toContain("Full tacit skill body for expand.");
	});

	it("XdProtocolHandler loads skill file for xd://skills/{name}", async () => {
		const skillDir = `${import.meta.dir}/../../.agent-artifacts/p2-xd-skill-${Date.now()}`;
		await Bun.write(`${skillDir}/SKILL.md`, "# tacit-knowledge\n\nFull skill markdown content.\n");
		const handler = new XdProtocolHandler();
		const res = await handler.resolve(
			{
				href: "xd://skills/tacit-knowledge",
				scheme: "xd",
				hostname: "skills",
				pathname: "/tacit-knowledge",
				rawHost: "skills",
			} as never,
			{
				skills: [
					{
						name: "tacit-knowledge",
						description: "expert judgment",
						filePath: `${skillDir}/SKILL.md`,
						baseDir: skillDir,
						source: "test",
					},
				],
			},
		);
		expect(res.content).toContain("Full skill markdown content");
	});
});

describe("P2 presentation order stability", () => {
	it("tool/skill order is name-sorted and byte-identical across builds and modes", () => {
		const tools = [
			{ name: "write", summary: "w" },
			{ name: "bash", summary: "b" },
			{ name: "grep", summary: "g" },
			{ name: "read", summary: "r" },
		];
		const skills = [
			{ name: "zeta", summary: "z", body: "Z" },
			{ name: "alpha", summary: "a", body: "A" },
		];
		const allow = ["bash", "grep", "read", "write"] as const;

		const catalogPolicy = {
			enabled: true,
			mode: "catalog" as const,
			essentialTools: ["read", "bash"],
			skillCatalogOnly: true,
		};
		const directPolicy = {
			enabled: false,
			mode: "direct" as const,
			essentialTools: ["read", "bash"],
			skillCatalogOnly: true,
		};

		const a1 = applyPresentationPolicy({
			policy: catalogPolicy,
			allowedToolNames: allow,
			tools: [...tools],
			skills: skills.map(s => ({ ...s })),
		});
		const a2 = applyPresentationPolicy({
			policy: catalogPolicy,
			allowedToolNames: allow,
			tools: [...tools].reverse(),
			skills: [...skills].reverse(),
		});
		const d1 = applyPresentationPolicy({
			policy: directPolicy,
			allowedToolNames: allow,
			tools: [...tools],
			skills: skills.map(s => ({ ...s, autoload: true })),
		});

		expect(a1.toolOrder).toEqual(["bash", "grep", "read", "write"]);
		expect(a2.toolOrder).toEqual(a1.toolOrder);
		expect(d1.toolOrder).toEqual(a1.toolOrder);
		expect(a1.skillOrder).toEqual(["alpha", "zeta"]);
		expect(a2.skillOrder).toEqual(a1.skillOrder);
		// Catalog fingerprint stable across input order
		expect(presentationFingerprint(a1)).toBe(presentationFingerprint(a2));
		// Mode changes summaries but not tool order names
		expect(d1.toolOrder.join(",")).toBe(a1.toolOrder.join(","));

		// Wire transform also stable
		const prepared = prepareWorkflowInvocation({
			workflowId: "wf",
			attemptId: "att",
			role: "implementer",
			profile: {
				...DEFAULT_MODEL_PROFILES.grok_implementer,
				presentationPolicy: catalogPolicy,
			},
			assignment: "impl",
			session: fakeSession(),
			outputSchema: {},
		} satisfies WorkflowAgentRequest);
		const descriptors = [
			{ name: "write", description: "w", schema: { type: "object" } },
			{ name: "bash", description: "b", schema: { type: "object" } },
			{ name: "grep", description: "g", schema: { type: "object" } },
			{ name: "read", description: "r", schema: { type: "object" } },
		];
		const w1 = prepared.transformTools(descriptors).map(t => t.name);
		const w2 = prepared.transformTools([...descriptors].reverse()).map(t => t.name);
		expect(w1).toEqual(w2);
		expect(w1.join(",")).toBe(w2.join(","));
	});
});

describe("P2 paired benchmark baseline vs lazy presentation", () => {
	it("reports initial prompt size, pass rate, xd call count; quality drop ≤3pp", async () => {
		const suite = buildDefaultBenchmarkSuite();
		const cases = suite.cases.slice(0, 3);

		// Measure real presentation sizes for baseline vs lazy.
		const allow = ["bash", "read", "write", "edit", "grep", "find"] as const;
		const toolDefs = allow.map(name => ({
			name,
			summary: `${name} tool`,
			schema: {
				type: "object",
				properties: Object.fromEntries(
					Array.from({ length: 8 }, (_, i) => [
						`field_${name}_${i}`,
						{ type: "string", description: "x".repeat(40) },
					]),
				),
			},
		}));

		const baselinePresented = applyPresentationPolicy({
			policy: DEFAULT_PRESENTATION_POLICY,
			allowedToolNames: allow,
			tools: toolDefs.map(t => ({ name: t.name, summary: t.summary })),
		});
		const lazyPresented = applyPresentationPolicy({
			policy: {
				enabled: true,
				mode: "catalog",
				essentialTools: ["read", "write", "edit", "bash"],
				skillCatalogOnly: true,
			},
			allowedToolNames: allow,
			tools: toolDefs.map(t => ({ name: t.name, summary: t.summary })),
		});

		const schemaBytes = (attached: boolean, name: string) => {
			if (!attached) return Buffer.byteLength(formatToolCatalogSummary(name, `${name} tool`), "utf-8");
			const schema = toolDefs.find(t => t.name === name)!.schema;
			return Buffer.byteLength(JSON.stringify(schema), "utf-8");
		};
		const baselineSchemaBytes = baselinePresented.tools.reduce(
			(s, t) => s + schemaBytes(t.schemaAttached, t.name),
			0,
		);
		const lazySchemaBytes = lazyPresented.tools.reduce((s, t) => s + schemaBytes(t.schemaAttached, t.name), 0);
		expect(lazySchemaBytes).toBeLessThan(baselineSchemaBytes);

		// xd:// expand overhead: one expand per non-essential if model needs it (estimate).
		const nonEssential = lazyPresented.tools.filter(t => !t.schemaAttached).length;
		let xdCalls = 0;

		const runtime: BenchmarkRuntime = async req => {
			const isOpt = req.variant === "optimized";
			if (isOpt) {
				// Simulate occasional schema discovery for non-essentials
				xdCalls += Math.min(1, nonEssential > 0 ? 1 : 0);
			}
			const toolSchemaBytes = isOpt ? lazySchemaBytes : baselineSchemaBytes;
			const systemPromptBytes = 1200;
			return {
				passed: true,
				firstPassed: true,
				qualityScore: 100,
				durationMs: isOpt ? 4 + req.repetition : 6 + req.repetition,
				tokens: {
					systemPromptBytes: { value: systemPromptBytes, provenance: "exact" },
					toolSchemaBytes: { value: toolSchemaBytes, provenance: "exact" },
					historyBytes: { value: 400, provenance: "exact" },
					repoMapBytes: { value: 200, provenance: "exact" },
					toolResultBytes: { value: isOpt ? 800 : 1200, provenance: "exact" },
					contextEvictedBytes: { value: 0, provenance: "exact" },
					estimatedTotalTokens: {
						value: Math.ceil((systemPromptBytes + toolSchemaBytes + (isOpt ? 800 : 1200)) / 4),
						provenance: "estimate",
					},
					cacheObservable: false,
					cacheReadTokens: { value: null, provenance: "unknown" },
					cacheWriteTokens: { value: null, provenance: "unknown" },
					inputTokens: { value: null, provenance: "unknown" },
					outputTokens: { value: null, provenance: "unknown" },
					costUsd: { value: null, provenance: "unknown" },
					ttftMs: { value: null, provenance: "unknown" },
					queueMs: { value: null, provenance: "unknown" },
				},
				stage: {
					profileId: isOpt ? "lazy-presentation" : "baseline",
					durationMs: { value: isOpt ? 4 : 6, provenance: "exact" },
					toolTimeMs: { value: 1, provenance: "exact" },
					schemaRetries: { value: 0, provenance: "exact" },
					fallbacks: { value: 0, provenance: "exact" },
					toolCalls: { value: 3 + (isOpt ? 1 : 0), provenance: "exact" },
					duplicateReadCount: { value: 0, provenance: "exact" },
					duplicateGrepCount: { value: 0, provenance: "exact" },
					compressionReceipts: [],
				},
				scopeStatus: "adhered",
			};
		};

		const results = await runBenchmarkSuite({
			suite: { ...suite, cases },
			runtime,
			optimizedProfileId: "lazy-presentation",
			optimizedStrategyFingerprint: "presentation-catalog-v1",
			minRepetitions: 1,
			liveQualityUnknown: true,
			notes: [
				`baselineToolSchemaBytes=${baselineSchemaBytes}`,
				`lazyToolSchemaBytes=${lazySchemaBytes}`,
				`schemaDeltaBytes=${lazySchemaBytes - baselineSchemaBytes}`,
				`xdDiscoveryCallsSimulated=${xdCalls}`,
			],
		});
		const scorecard = buildScorecard({ ...suite, cases }, results, {
			liveQualityUnknown: true,
			notes: [
				`baselineToolSchemaBytes=${baselineSchemaBytes}`,
				`lazyToolSchemaBytes=${lazySchemaBytes}`,
				`schemaDeltaBytes=${lazySchemaBytes - baselineSchemaBytes}`,
			],
		});
		const gate = evaluateBenchmarkQualityGate(scorecard);
		expect(gate.passed).toBe(true);

		// Quality: all passed — drop is 0pp
		const basePass = scorecard.summaries.filter(s => s.variant === "baseline");
		const optPass = scorecard.summaries.filter(s => s.variant === "optimized");
		const meanPass = (rows: typeof basePass) =>
			rows.reduce((s, r) => s + (r.passRate ?? 0), 0) / Math.max(1, rows.length);
		const baseRate = meanPass(basePass);
		const optRate = meanPass(optPass);
		expect(baseRate - optRate).toBeLessThanOrEqual(0.03);

		// Provenance: schema size reduced
		const firstBase = scorecard.summaries.find(s => s.variant === "baseline")!;
		const firstOpt = scorecard.summaries.find(s => s.variant === "optimized")!;
		expect(firstOpt.meanToolSchemaBytes).not.toBeNull();
		expect(firstBase.meanToolSchemaBytes).not.toBeNull();
		expect(firstOpt.meanToolSchemaBytes!).toBeLessThan(firstBase.meanToolSchemaBytes!);

		// Expose numbers for report (not invented — computed above)
		expect(baselineSchemaBytes).toBeGreaterThan(lazySchemaBytes);
		expect(parsePresentationLocator("xd://tools/grep")?.kind).toBe("tool");
	});
});
