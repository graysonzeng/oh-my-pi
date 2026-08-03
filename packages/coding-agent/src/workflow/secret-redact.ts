/** Global secret-like patterns; always reset lastIndex before use. */
const SECRET_LIKE =
	/(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{8,}/gi;
/** JSON-style `"token":"value"` keys the colon form misses because of the closing quote. */
const SECRET_JSON =
	/"(api[_-]?key|secret|password|token|authorization)"\s*:\s*"([^"\\]|\\.){8,}"/gi;
/** Authorization: Bearer <token> */
const SECRET_BEARER = /(authorization)\s*:\s*Bearer\s+([A-Za-z0-9_\-+/=.]{8,})/gi;

export function containsSecret(text: string): boolean {
	SECRET_LIKE.lastIndex = 0;
	SECRET_JSON.lastIndex = 0;
	SECRET_BEARER.lastIndex = 0;
	return SECRET_LIKE.test(text) || SECRET_JSON.test(text) || SECRET_BEARER.test(text);
}

export function redactSecretsInText(text: string): string {
	SECRET_LIKE.lastIndex = 0;
	SECRET_JSON.lastIndex = 0;
	SECRET_BEARER.lastIndex = 0;
	let out = text.replace(SECRET_LIKE, match => {
		const key = match.split(/[:=]/)[0]?.trim() ?? "secret";
		return `${key}=[REDACTED]`;
	});
	out = out.replace(SECRET_JSON, (_m, key: string) => `"${key}":"[REDACTED]"`);
	out = out.replace(SECRET_BEARER, (_m, key: string) => `${key}: Bearer [REDACTED]`);
	return out;
}
