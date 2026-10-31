/**
 * Canonical stable JSON + SHA-256 for latency fingerprints.
 * Shared by ReadViewKey, BashAttemptLedger, and WorkflowConcurrencyDeclaration.
 */

import { createHash } from "node:crypto";

export function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableSerialize).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(obj[key])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function fingerprintStable(value: unknown): string {
	return sha256Hex(stableSerialize(value));
}
