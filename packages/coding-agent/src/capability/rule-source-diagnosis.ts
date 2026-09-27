/**
 * D5 rule source diagnosis — explain winner / shadowed / disabled without
 * changing priority or name identity. Pure projection over capability load results.
 */
import type { SourceMeta } from "./types";

export type RuleSourceStatus = "winner" | "shadowed" | "disabled" | "suppressed";

export interface RuleSourceDiagnosisRow {
	name: string;
	status: RuleSourceStatus;
	provider?: string;
	providerName?: string;
	path?: string;
	/** Why this row is not the winner (shadowed/disabled), when known. */
	reason?: string;
}

export interface RuleLikeForDiagnosis {
	name: string;
	_source?: Partial<SourceMeta> & Pick<SourceMeta, "provider">;
	_shadowed?: boolean;
	disabled?: boolean;
}

/**
 * Build a diagnosis table from capability `items` (winners) and optional `all`
 * (includes shadowed). Does not change load semantics.
 */
export function diagnoseRuleSources(input: {
	items: readonly RuleLikeForDiagnosis[];
	all?: readonly RuleLikeForDiagnosis[];
	disabledNames?: readonly string[];
}): RuleSourceDiagnosisRow[] {
	const disabled = new Set((input.disabledNames ?? []).map(n => n.trim()).filter(Boolean));
	const winners = new Map<string, RuleLikeForDiagnosis>();
	for (const item of input.items) {
		if (!item.name) continue;
		if (!winners.has(item.name)) winners.set(item.name, item);
	}

	const rows: RuleSourceDiagnosisRow[] = [];
	const seen = new Set<string>();

	const universe = input.all && input.all.length > 0 ? input.all : input.items;
	for (const rule of universe) {
		const name = rule.name?.trim();
		if (!name) continue;
		const key = `${name}\0${rule._source?.provider ?? ""}\0${rule._source?.path ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);

		if (disabled.has(name)) {
			rows.push({
				name,
				status: "disabled",
				provider: rule._source?.provider,
				providerName: rule._source?.providerName,
				path: rule._source?.path,
				reason: "listed in disabledRules",
			});
			continue;
		}

		if (rule._shadowed === true) {
			const winner = winners.get(name);
			rows.push({
				name,
				status: "shadowed",
				provider: rule._source?.provider,
				providerName: rule._source?.providerName,
				path: rule._source?.path,
				reason: winner?._source?.path
					? `same-name first-wins; winner=${winner._source.providerName ?? winner._source.provider ?? "unknown"} path=${winner._source.path}`
					: "same-name first-wins; later duplicate shadowed",
			});
			continue;
		}

		const isWinner =
			winners.get(name) === rule || (!rule._shadowed && winners.has(name) && winners.get(name)?.name === name);
		rows.push({
			name,
			status: isWinner || winners.has(name) ? "winner" : "suppressed",
			provider: rule._source?.provider,
			providerName: rule._source?.providerName,
			path: rule._source?.path,
		});
	}

	return rows;
}

export function formatRuleSourceDiagnosis(rows: readonly RuleSourceDiagnosisRow[]): string {
	const lines = [
		"rule source diagnosis (D5)",
		...rows.map(
			r =>
				`  ${r.status}\t${r.name}\t${r.providerName ?? r.provider ?? "-"}\t${r.path ?? "-"}${r.reason ? `\t${r.reason}` : ""}`,
		),
	];
	return lines.join("\n");
}

/**
 * Format discovery warnings once for logger / notices (no rule body dump).
 */
export function formatRuleDiscoveryWarnings(warnings: readonly string[]): string | undefined {
	const cleaned = warnings.map(w => w.trim()).filter(Boolean);
	if (cleaned.length === 0) return undefined;
	const capped = cleaned.slice(0, 20);
	const extra = cleaned.length > capped.length ? ` (+${cleaned.length - capped.length} more)` : "";
	return `Rule discovery warnings (${cleaned.length})${extra}: ${capped.join("; ")}`;
}
