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
/** PEM private-key / certificate blocks (any base64 body, no key-name required). */
const SECRET_PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----\n?[A-Za-z0-9+/=\n\s]*?-----END [A-Z0-9 ]+-----/g;

export function containsSecret(text: string): boolean {
	SECRET_LIKE.lastIndex = 0;
	SECRET_JSON.lastIndex = 0;
	SECRET_BEARER.lastIndex = 0;
	SECRET_STANDALONE_BEARER.lastIndex = 0;
	SECRET_SK_KEY.lastIndex = 0;
	SECRET_PEM_BLOCK.lastIndex = 0;
	return (
		SECRET_LIKE.test(text) ||
		SECRET_JSON.test(text) ||
		SECRET_BEARER.test(text) ||
		SECRET_STANDALONE_BEARER.test(text) ||
		SECRET_SK_KEY.test(text) ||
		SECRET_PEM_BLOCK.test(text)
	);
}

export function redactSecretsInText(text: string): string {
	SECRET_LIKE.lastIndex = 0;
	SECRET_JSON.lastIndex = 0;
	SECRET_BEARER.lastIndex = 0;
	SECRET_STANDALONE_BEARER.lastIndex = 0;
	SECRET_SK_KEY.lastIndex = 0;
	SECRET_PEM_BLOCK.lastIndex = 0;
	let out = text.replace(SECRET_LIKE, match => {
		const key = match.split(/[:=]/)[0]?.trim() ?? "secret";
		return `${key}=[REDACTED]`;
	});
	out = out.replace(SECRET_JSON, (_m, key: string) => `"${key}":"[REDACTED]"`);
	out = out.replace(SECRET_BEARER, (_m, key: string) => `${key}: Bearer [REDACTED]`);
	out = out.replace(SECRET_STANDALONE_BEARER, () => "Bearer [REDACTED]");
	out = out.replace(SECRET_SK_KEY, () => "sk-[REDACTED]");
	out = out.replace(SECRET_PEM_BLOCK, () => "[REDACTED PRIVATE KEY BLOCK]");
	return out;
}
