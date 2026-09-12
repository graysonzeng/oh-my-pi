import type { ShadowDefinition } from "./protocol";
import type { ShadowDimensionId } from "./types";

export const BUILTIN_SHADOWS: ReadonlyArray<ShadowDefinition & { id: ShadowDimensionId }> = [
	{
		id: "architecture-review",
		name: "Architecture Review",
		prompt: `Review the assigned patch for architectural defects: second engines, wrong canonical owners, leaked seams, circular dependencies, and module-boundary violations.
Report only concrete, patch-anchored issues with file path and line range. If the trajectory is a design review or unrelated, reply NOT_RELEVANT.`,
	},
	{
		id: "grounded-review",
		name: "Grounded Review",
		prompt: `Check whether the reviewer's claims (or the patch commentary) are grounded in the actual code and evidence packet.
Flag unstated assumptions, invented APIs, and facts that contradict the files. Report only evidence-backed issues. If unrelated, reply NOT_RELEVANT.`,
	},
	{
		id: "correctness-review",
		name: "Correctness Review",
		prompt: `Find correctness bugs introduced by the patch: races, dropped errors, inverted conditions, broken fail-open/fail-closed, abort/leak paths.
Each finding needs a trigger, impact, and file/line anchor. If unrelated, reply NOT_RELEVANT.`,
	},
	{
		id: "completion-review",
		name: "Completion Review",
		prompt: `Find incomplete contracts: missing tests for new behavior, schema fields without parsers, kill switches without changelog, prompts that wait forever, or fail-open holes.
Report only actionable gaps in this patch. If unrelated, reply NOT_RELEVANT.`,
	},
];
