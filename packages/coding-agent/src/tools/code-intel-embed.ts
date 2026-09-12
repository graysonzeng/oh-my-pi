/**
 * Local-only embedding resolver for code-intel.
 *
 * Remote OpenAI-compatible URLs, API keys, and non-fastembed model ids
 * disable the semantic layer. Memory backend HTTP embeddings are never used.
 */
import { getFastembedCacheDir, untilAborted } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type MnemopiSubprocessEmbeddingModel, mnemopiEmbedClient } from "../mnemopi/embed-client";
import type { MnemopiEmbedRole } from "../mnemopi/embed-protocol";

export const ENGLISH_BGE_MODEL = "fast-bge-base-en-v1.5";
export const MULTILINGUAL_E5_MODEL = "fast-multilingual-e5-large";

const FASTEMBED_IDS = new Set([
	"fast-bge-small-en-v1.5",
	"fast-bge-base-en-v1.5",
	"fast-bge-small-en",
	"fast-bge-base-en",
	"fast-bge-small-zh-v1.5",
	"fast-multilingual-e5-large",
	"fast-all-MiniLM-L6-v2",
	"BAAI/bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5",
	"BAAI/bge-small-en",
	"BAAI/bge-base-en",
	"BAAI/bge-small-zh-v1.5",
	"intfloat/multilingual-e5-large",
	"sentence-transformers/all-MiniLM-L6-v2",
]);

const ALIAS_TO_FAST: Record<string, string> = {
	"BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
	"BAAI/bge-small-en": "fast-bge-small-en",
	"BAAI/bge-base-en": "fast-bge-base-en",
	"BAAI/bge-small-zh-v1.5": "fast-bge-small-zh-v1.5",
	"intfloat/multilingual-e5-large": "fast-multilingual-e5-large",
	"sentence-transformers/all-MiniLM-L6-v2": "fast-all-MiniLM-L6-v2",
};

export type CodeIntelEmbedResolution =
	| { ok: true; model: string; englishOnly: boolean }
	| { ok: false; reason: string };

function isRemoteEmbeddingId(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		lower.startsWith("text-embedding-") ||
		lower.includes("openai") ||
		lower.includes("openrouter") ||
		lower.startsWith("http://") ||
		lower.startsWith("https://")
	);
}

export function resolveCodeIntelEmbedModel(settings: Settings): CodeIntelEmbedResolution {
	if (settings.get("mnemopi.noEmbeddings") === true) {
		return { ok: false, reason: "semantic unavailable (mnemopi.noEmbeddings)" };
	}
	const apiUrl = settings.get("mnemopi.embeddingApiUrl");
	if (typeof apiUrl === "string" && apiUrl.trim().length > 0) {
		return { ok: false, reason: "semantic unavailable (remote embedding URL rejected)" };
	}
	const explicit = settings.get("mnemopi.embeddingModel")?.trim();
	if (explicit) {
		if (isRemoteEmbeddingId(explicit) || !FASTEMBED_IDS.has(explicit)) {
			return { ok: false, reason: "semantic unavailable (non-local embedding model rejected)" };
		}
		const model = ALIAS_TO_FAST[explicit] ?? explicit;
		return { ok: true, model, englishOnly: !model.includes("multilingual-e5") };
	}
	if (settings.get("mnemopi.embeddingVariant") === "multilingual") {
		return { ok: true, model: MULTILINGUAL_E5_MODEL, englishOnly: false };
	}
	return { ok: true, model: ENGLISH_BGE_MODEL, englishOnly: true };
}

export async function collectEmbedMatrix(
	handle: MnemopiSubprocessEmbeddingModel,
	texts: string[],
	role: MnemopiEmbedRole,
	batchSize = 32,
	signal?: AbortSignal,
): Promise<number[][]> {
	const rows: number[][] = [];
	for (let offset = 0; offset < texts.length; offset += batchSize) {
		if (signal?.aborted) return rows;
		const batch = texts.slice(offset, offset + batchSize);
		const iterator = handle.embed(batch, batchSize, role)[Symbol.asyncIterator]();
		while (true) {
			const next = await untilAborted(signal, iterator.next());
			if (next.done) break;
			rows.push(...next.value);
		}
	}
	return rows;
}

export async function tryInitializeLocalEmbed(model: string): Promise<MnemopiSubprocessEmbeddingModel | null> {
	return mnemopiEmbedClient.initialize(model, getFastembedCacheDir());
}

export function isEnglishOnlyEmbedModel(model: string): boolean {
	return !model.includes("multilingual-e5");
}
