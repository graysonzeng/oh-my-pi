import { describe, expect, it } from "bun:test";
import {
	buildConcurrencyDeclaration,
	buildConcurrencyExecutionPlan,
	validateConcurrencyDeclaration,
	type ConcurrencyUnitStateV1,
	type WorkflowConcurrencyDeclarationV1,
} from "../../src/latency/concurrency-declaration";

function declaration(unitCount: number, maxConcurrency = 4): WorkflowConcurrencyDeclarationV1 {
	return buildConcurrencyDeclaration({
		declarationId: "decl-execution",
		ownerKind: "workflow",
		ownerId: "wf-execution",
		scopeArtifactRef: "artifact://scope",
		scopeArtifactSha256: "a".repeat(64),
		revision: 0,
		maxConcurrency,
		completionPolicy: { kind: "all_required", minSuccesses: null },
		failurePolicy: "fail_closed",
		cancelPolicy: "stop_new_work",
		units: Array.from({ length: unitCount }, (_, index) => ({
			id: `unit-${index + 1}`,
			assignment: `Run unit ${index + 1}`,
			paths: [`src/unit-${index + 1}.ts`],
			dependsOn: [],
			mode: "write" as const,
			required: true,
			idempotencyKey: `unit-${index + 1}`,
		})),
	});
}

function statesFor(decl: WorkflowConcurrencyDeclarationV1): ConcurrencyUnitStateV1[] {
	return decl.units.map(unit => ({ id: unit.id, status: "declared", attemptCount: 0 }));
}

describe("WorkflowConcurrencyDeclarationV1 lowering", () => {
	it("lowers an independent ready wave with declaration ∩ task concurrency", async () => {
		const decl = declaration(3, 3);
		let active = 0;
		let peak = 0;
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 250);
		const plan = buildConcurrencyExecutionPlan(decl, {
			states: statesFor(decl),
			sessionMaxConcurrency: 2,
			execute: async (unit, _index, signal) => {
				active += 1;
				peak = Math.max(peak, active);
				if (active === 2) release.resolve();
				const abortWait = Promise.withResolvers<void>();
					if (signal.aborted) {
						abortWait.resolve();
					} else {
						signal.addEventListener("abort", () => abortWait.resolve(), { once: true });
					}
				await Promise.race([release.promise, abortWait.promise]);
				active -= 1;
				return unit.id;
			},
		});

		expect(plan?.maxConcurrency).toBe(2);
		expect(plan?.ready.map(unit => unit.id)).toEqual(["unit-1", "unit-2", "unit-3"]);
		const settled = await plan!.run(controller.signal);
		clearTimeout(timeout);
		expect(settled.aborted).toBe(false);
		expect(settled.results.every(result => result?.status === "fulfilled")).toBe(true);
		expect(peak).toBe(2);
	});

	it("returns serial/no-plan for fewer than two ready units or an effectively serial limit", () => {
		const one = declaration(1, 4);
		expect(
			buildConcurrencyExecutionPlan(one, {
				states: statesFor(one),
				execute: async unit => unit.id,
			}),
		).toBeNull();

		const boundedToOne = declaration(2, 4);
		expect(
			buildConcurrencyExecutionPlan(boundedToOne, {
				states: statesFor(boundedToOne),
				sessionMaxConcurrency: 1,
				execute: async unit => unit.id,
			}),
		).toBeNull();
	});

	it("fails closed for an unknown raw declaration field", () => {
		const decl = declaration(2);
		const raw = { ...decl, unexpected: true } as unknown as Record<string, unknown>;
		expect(
			buildConcurrencyExecutionPlan(decl, {
				states: statesFor(decl),
				raw,
				execute: async unit => unit.id,
			}),
		).toBeNull();
	});
	it("fails closed when rendezvous metadata names only one unit", () => {
		const decl = declaration(2);
		decl.units[0]!.rendezvousId = "solo-rendezvous";
		const validation = validateConcurrencyDeclaration(decl);
		expect(validation.ok).toBe(false);
		expect(validation.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "invalid_rendezvous", unitId: "unit-1" }),
			]),
		);
		expect(
			buildConcurrencyExecutionPlan(decl, {
				states: statesFor(decl),
				execute: async unit => unit.id,
			}),
		).toBeNull();
	});
});
