/**
 * Paired/interleaved A/B qualification. No provider I/O.
 * Safe to import from bun:test. Source freezing lives in verifyConditions.
 */
import {
	type AttemptRecord,
	type BenefitStatus,
	type BenefitVerdict,
	type Mode,
	type QualificationReport,
	EXPERIMENT_VARIANTS,
	type Variant,
	buildQualificationReport,
	compareQualificationReports,
	measuredCount,
} from "./product-latency-qualification";

export type PairedExperiment = "advisories" | "sonic-effort";
export type PairedArm = "control" | "treatment";

export { EXPERIMENT_VARIANTS };

/** True when argv selects a paired experiment surface (not unpaired qualification). */
export function requestsPairedQualification(argv: readonly string[]): boolean {
	// Route every experiment request to paired validation, including malformed
	// values, so a typo cannot launch the unrelated unpaired provider suite.
	return argv.some(
		argument =>
			argument.startsWith("--paired-") || argument === "--experiment" || argument.startsWith("--experiment="),
	);
}

export interface PairedSlot {
	pairId: string;
	arm: PairedArm;
	variant: Variant;
	repetition: number;
	order: 0 | 1;
}

export interface PairedSlotResult {
	slot: PairedSlot;
	attempt: AttemptRecord;
}

export interface PairedPairSummary {
	pairId: string;
	variant: Variant;
	repetition: number;
	controlIndex: number | null;
	treatmentIndex: number | null;
	acceptanceDeltaMs: number | null;
}

export interface PairedQualificationReport {
	status: BenefitStatus;
	phase: "in_progress" | "complete" | "interrupted";
	reason?: string;
	experiment: PairedExperiment;
	slots: PairedSlotResult[];
	pairs: PairedPairSummary[];
	control: QualificationReport;
	treatment: QualificationReport;
	benefit: BenefitVerdict;
}

export function createPairedSchedule(mode: Mode, experiment: PairedExperiment = "advisories"): PairedSlot[] {
	const variants = EXPERIMENT_VARIANTS[experiment];
	const slots: PairedSlot[] = [];
	let pairIndex = 0;
	for (let repetition = 0; repetition <= measuredCount(mode); repetition++) {
		for (const variant of variants) {
			const pairId = `${variant}:${repetition}`;
			const first: PairedArm = pairIndex % 2 === 0 ? "control" : "treatment";
			const second: PairedArm = first === "control" ? "treatment" : "control";
			slots.push({ pairId, arm: first, variant, repetition, order: 0 });
			slots.push({ pairId, arm: second, variant, repetition, order: 1 });
			pairIndex += 1;
		}
	}
	return slots;
}

export async function runPairedQualification(args: {
	mode: Mode;
	experiment: PairedExperiment;
	modelsConfigSha256: string;
	execute: (slot: PairedSlot) => Promise<AttemptRecord>;
	checkpoint: (report: PairedQualificationReport) => Promise<void>;
	verifyConditions: () => Promise<void>;
	signal: AbortSignal;
}): Promise<PairedQualificationReport> {
	const schedule = createPairedSchedule(args.mode, args.experiment);
	const recorded: PairedSlotResult[] = [];

	const persist = async (
		phase: PairedQualificationReport["phase"],
		reason?: string,
	): Promise<PairedQualificationReport> => {
		const report = assemblePairedReport({
			mode: args.mode,
			experiment: args.experiment,
			modelsConfigSha256: args.modelsConfigSha256,
			schedule,
			recorded,
			phase,
			reason,
		});
		await args.checkpoint(report);
		return report;
	};

	for (let index = 0; index < schedule.length; index++) {
		const slot = schedule[index]!;
		if (args.signal.aborted) {
			return persist("interrupted", describeThrown(args.signal.reason, "aborted"));
		}
		try {
			await args.verifyConditions();
		} catch (error) {
			return persist("interrupted", describeThrown(error, "condition drift"));
		}
		if (args.signal.aborted) {
			return persist("interrupted", describeThrown(args.signal.reason, "aborted"));
		}

		let attempt: AttemptRecord;
		try {
			attempt = await args.execute(slot);
		} catch (error) {
			return persist("interrupted", describeThrown(error, "execute failed"));
		}

		recorded.push({ slot, attempt });
		const expectedWarmup = slot.repetition === 0;
		if (
			attempt.variant !== slot.variant ||
			attempt.repetition !== slot.repetition ||
			attempt.warmup !== expectedWarmup
		) {
			return persist(
				"interrupted",
				`slot mismatch: expected ${slot.variant} repetition ${slot.repetition} warmup ${expectedWarmup}, got ${attempt.variant} repetition ${attempt.repetition} warmup ${attempt.warmup}`,
			);
		}

		await persist("in_progress", "paired schedule in progress");
	}

	try {
		await args.verifyConditions();
	} catch (error) {
		return persist("interrupted", describeThrown(error, "condition drift"));
	}
	if (args.signal.aborted) {
		return persist("interrupted", describeThrown(args.signal.reason, "aborted"));
	}
	return persist("complete");
}

function describeThrown(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.length > 0) return error;
	return fallback;
}

function assemblePairedReport(args: {
	mode: Mode;
	experiment: PairedExperiment;
	modelsConfigSha256: string;
	schedule: readonly PairedSlot[];
	recorded: readonly PairedSlotResult[];
	phase: PairedQualificationReport["phase"];
	reason?: string;
}): PairedQualificationReport {
	const controlAttempts = args.recorded.filter(item => item.slot.arm === "control").map(item => item.attempt);
	const treatmentAttempts = args.recorded.filter(item => item.slot.arm === "treatment").map(item => item.attempt);
	const control = buildQualificationReport({
		mode: args.mode,
		attempts: controlAttempts,
		launches: controlAttempts.length,
		elapsedMs: sumAcceptanceWallMs(controlAttempts),
		modelsConfigSha256: args.modelsConfigSha256,
		experiment: args.experiment,
		variants: EXPERIMENT_VARIANTS[args.experiment],
	});
	const treatment = buildQualificationReport({
		mode: args.mode,
		attempts: treatmentAttempts,
		launches: treatmentAttempts.length,
		elapsedMs: sumAcceptanceWallMs(treatmentAttempts),
		modelsConfigSha256: args.modelsConfigSha256,
		experiment: args.experiment,
		variants: EXPERIMENT_VARIANTS[args.experiment],
	});
	const pairs = collectPairs(args.schedule, args.recorded);
	const benefit = finalizeBenefit({
		experiment: args.experiment,
		phase: args.phase,
		reason: args.reason,
		scheduleLength: args.schedule.length,
		recorded: args.recorded,
		pairs,
		control,
		treatment,
	});
	const reason = args.reason ?? benefit.reason;
	return {
		status: benefit.status,
		phase: args.phase,
		...(reason ? { reason } : {}),
		experiment: args.experiment,
		slots: [...args.recorded],
		pairs,
		control,
		treatment,
		benefit,
	};
}

function sumAcceptanceWallMs(attempts: readonly AttemptRecord[]): number {
	let sum = 0;
	for (const attempt of attempts) {
		if (typeof attempt.acceptanceWallMs === "number" && Number.isFinite(attempt.acceptanceWallMs)) {
			sum += attempt.acceptanceWallMs;
		}
	}
	return sum;
}

function collectPairs(schedule: readonly PairedSlot[], recorded: readonly PairedSlotResult[]): PairedPairSummary[] {
	const pairs: PairedPairSummary[] = [];
	// Recorded results are a prefix of the strictly serial schedule.
	for (let index = 0; index < recorded.length; index += 2) {
		const slot = schedule[index]!;
		const firstIsControl = recorded[index]!.slot.arm === "control";
		const secondIndex = index + 1 < recorded.length ? index + 1 : null;
		const controlIndex = firstIsControl ? index : secondIndex;
		const treatmentIndex = firstIsControl ? secondIndex : index;
		let acceptanceDeltaMs: number | null = null;
		if (controlIndex !== null && treatmentIndex !== null) {
			const controlMs = recorded[controlIndex]!.attempt.acceptanceWallMs;
			const treatmentMs = recorded[treatmentIndex]!.attempt.acceptanceWallMs;
			if (typeof controlMs === "number" && typeof treatmentMs === "number") {
				acceptanceDeltaMs = treatmentMs - controlMs;
			}
		}
		pairs.push({
			pairId: slot.pairId,
			variant: slot.variant,
			repetition: slot.repetition,
			controlIndex,
			treatmentIndex,
			acceptanceDeltaMs,
		});
	}
	return pairs;
}

function finalizeBenefit(args: {
	experiment: PairedExperiment;
	phase: PairedQualificationReport["phase"];
	reason?: string;
	scheduleLength: number;
	recorded: readonly PairedSlotResult[];
	pairs: readonly PairedPairSummary[];
	control: QualificationReport;
	treatment: QualificationReport;
}): BenefitVerdict {
	if (args.phase !== "complete") {
		return {
			status: "INCOMPARABLE",
			reason:
				args.reason ??
				(args.phase === "in_progress" ? "paired schedule in progress" : "paired schedule interrupted"),
		};
	}
	if (args.recorded.length !== args.scheduleLength) {
		return { status: "INCOMPARABLE", reason: "incomplete paired schedule" };
	}
	const incompletePair = args.pairs.find(pair => pair.controlIndex === null || pair.treatmentIndex === null);
	if (incompletePair) {
		return { status: "INCOMPARABLE", reason: `incomplete pair ${incompletePair.pairId}` };
	}
	const identity = pairIdentityIssue(args.experiment, args.recorded, args.pairs);
	if (identity) {
		return { status: "INCOMPARABLE", reason: identity };
	}
	const compared = compareQualificationReports(args.control, args.treatment, {
		experiment: args.experiment,
		variants: EXPERIMENT_VARIANTS[args.experiment],
	});
	if (args.experiment !== "advisories" || !("declaredExperiment" in compared)) return compared;
	const { declaredExperiment: _declaredExperiment, ...rest } = compared;
	return rest;
}

function pairIdentityIssue(
	experiment: PairedExperiment,
	recorded: readonly PairedSlotResult[],
	pairs: readonly PairedPairSummary[],
): string | undefined {
	for (const pair of pairs) {
		if (pair.controlIndex === null || pair.treatmentIndex === null) continue;
		const control = recorded[pair.controlIndex]!.attempt;
		const treatment = recorded[pair.treatmentIndex]!.attempt;
		const controlModel = control.runtimeProvenance
			? `${control.runtimeProvenance.provider}/${control.runtimeProvenance.model}`
			: control.runtimeModel;
		const treatmentModel = treatment.runtimeProvenance
			? `${treatment.runtimeProvenance.provider}/${treatment.runtimeProvenance.model}`
			: treatment.runtimeModel;
		if (!controlModel || !treatmentModel) {
			return `missing runtime identity for pair ${pair.pairId}`;
		}
		if (controlModel !== treatmentModel) {
			return `pair ${pair.pairId} runtime model ${controlModel} vs ${treatmentModel}`;
		}
		if (control.effectiveAgentSource !== treatment.effectiveAgentSource) {
			return `pair ${pair.pairId} agent source differs`;
		}
		const frontmatter = frontmatterIssue(experiment, pair.variant, pair.pairId, control, treatment);
		if (frontmatter) return frontmatter;
		if (!control.effectiveEffort || !treatment.effectiveEffort) {
			return `missing runtime identity for pair ${pair.pairId}`;
		}
		if (
			(experiment === "advisories" || pair.variant !== "sonic") &&
			control.effectiveEffort !== treatment.effectiveEffort
		) {
			return `pair ${pair.pairId} undeclared effort drift ${control.effectiveEffort} vs ${treatment.effectiveEffort}`;
		}
	}
	if (experiment === "sonic-effort") {
		const sonic = recorded.filter(item => item.slot.variant === "sonic");
		const declared =
			sonic.length > 0 &&
			sonic.every(item => {
				const maxEffort = item.attempt.effectiveFrontmatterIdentity.maxEffort;
				return item.slot.arm === "control" ? maxEffort === undefined : maxEffort === "medium";
			});
		if (!declared) return "sonic experiment has no declared ceiling delta";
	}
	return undefined;
}

function frontmatterIssue(
	experiment: PairedExperiment,
	variant: Variant,
	pairId: string,
	control: AttemptRecord,
	treatment: AttemptRecord,
): string | undefined {
	const left = control.effectiveFrontmatterIdentity;
	const right = treatment.effectiveFrontmatterIdentity;
	if (
		left.thinkingLevel !== right.thinkingLevel ||
		left.readSummarize !== right.readSummarize ||
		left.shadowReview !== right.shadowReview ||
		JSON.stringify(left.model) !== JSON.stringify(right.model)
	) {
		return `pair ${pairId} frontmatter identity differs`;
	}
	if (experiment === "advisories") {
		if (left.maxEffort !== right.maxEffort) return `mixed experiment metadata for pair ${pairId}`;
		return undefined;
	}
	if (variant !== "sonic") {
		if (left.maxEffort !== right.maxEffort) return `pair ${pairId} undeclared maxEffort delta`;
		return undefined;
	}
	if (left.maxEffort !== undefined || right.maxEffort !== "medium") {
		return "sonic experiment has no declared ceiling delta";
	}
	return undefined;
}
