/** Global secret-like patterns; always reset lastIndex before use. */
const SECRET_LIKE = /(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=.]{8,}/gi;
/** JSON-style `"token":"value"` keys the colon form misses because of the closing quote. */
const SECRET_JSON = /"(api[_-]?key|secret|password|token|authorization)"\s*:\s*"([^"\\]|\\.){8,}"/gi;
/** Authorization: Bearer <token> */
const SECRET_BEARER = /(authorization)\s*:\s*Bearer\s+([A-Za-z0-9_\-+/=.]{8,})/gi;
/** Standalone Bearer token without the key word (e.g. "Bearer eyJhbGci..."). */
const SECRET_STANDALONE_BEARER = /\bBearer\s+([A-Za-z0-9_+/=.-]{16,})/gi;
/** OpenAI-style sk- keys ("sk-", "sk-proj-", "sk-ant-" …) without a key-name prefix. */
const SECRET_SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/gi;
/** GitHub classic PATs and related gh* prefixes. */
const SECRET_GHP = /\bgh[pours]_[A-Za-z0-9]{20,}/gi;
/** GitHub fine-grained PATs. */
const SECRET_GITHUB_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}/gi;
/** GitLab personal access tokens. */
const SECRET_GLPAT = /\bglpat-[A-Za-z0-9_-]{20,}/gi;
/** Compact JWT (header.payload.signature) without a Bearer prefix. */
const SECRET_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
/** Absolute home directories that must not persist in stored error summaries. */
const HOME_PATH = /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+)/g;
/** PEM private-key / certificate blocks (any base64 body, no key-name required). */
const SECRET_PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----\n?[A-Za-z0-9+/=\n\s]*?-----END [A-Z0-9 ]+-----/g;

const ALL_PATTERNS = [
	SECRET_LIKE,
	SECRET_JSON,
	SECRET_BEARER,
	SECRET_STANDALONE_BEARER,
	SECRET_SK_KEY,
	SECRET_GHP,
	SECRET_GITHUB_PAT,
	SECRET_GLPAT,
	SECRET_JWT,
	HOME_PATH,
	SECRET_PEM_BLOCK,
] as const;

function resetPatterns(): void {
	for (const pattern of ALL_PATTERNS) pattern.lastIndex = 0;
}

export function containsSecret(text: string): boolean {
	resetPatterns();
	// Home paths are redacted in summaries but are not credential secrets —
	// patches routinely mention absolute paths under /Users or /home.
	return (
		SECRET_LIKE.test(text) ||
		SECRET_JSON.test(text) ||
		SECRET_BEARER.test(text) ||
		SECRET_STANDALONE_BEARER.test(text) ||
		SECRET_SK_KEY.test(text) ||
		SECRET_GHP.test(text) ||
		SECRET_GITHUB_PAT.test(text) ||
		SECRET_GLPAT.test(text) ||
		SECRET_JWT.test(text) ||
		SECRET_PEM_BLOCK.test(text)
	);
}

export function redactSecretsInText(text: string): string {
	resetPatterns();
	let out = text.replace(SECRET_LIKE, match => {
		const key = match.split(/[:=]/)[0]?.trim() ?? "secret";
		return `${key}=[REDACTED]`;
	});
	out = out.replace(SECRET_JSON, (_m, key: string) => `"${key}":"[REDACTED]"`);
	out = out.replace(SECRET_BEARER, (_m, key: string) => `${key}: Bearer [REDACTED]`);
	out = out.replace(SECRET_STANDALONE_BEARER, () => "Bearer [REDACTED]");
	out = out.replace(SECRET_SK_KEY, () => "sk-[REDACTED]");
	out = out.replace(SECRET_GHP, () => "gh*_[REDACTED]");
	out = out.replace(SECRET_GITHUB_PAT, () => "github_pat_[REDACTED]");
	out = out.replace(SECRET_GLPAT, () => "glpat-[REDACTED]");
	out = out.replace(SECRET_JWT, () => "eyJ[REDACTED_JWT]");
	out = out.replace(HOME_PATH, () => "[HOME]");
	out = out.replace(SECRET_PEM_BLOCK, () => "[REDACTED PRIVATE KEY BLOCK]");
	return out;
}
