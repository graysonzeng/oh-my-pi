import { classifyModel } from "@oh-my-pi/pi-catalog/identity";

/** Vendor class from catalog taxonomy, or undefined when unclassified. */
export function modelLineageClass(modelId: string, provider = ""): string | undefined {
	const classified = classifyModel(provider, modelId, { lenient: true }).class;
	return classified === "unknown" ? undefined : classified;
}
