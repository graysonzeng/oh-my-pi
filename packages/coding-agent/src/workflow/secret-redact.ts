/** Global secret-like pattern; always reset lastIndex before use. */
const SECRET_LIKE = /(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{8,}/gi;

export function containsSecret(text: string): boolean {
	SECRET_LIKE.lastIndex = 0;
	return SECRET_LIKE.test(text);
}

export function redactSecretsInText(text: string): string {
	SECRET_LIKE.lastIndex = 0;
	return text.replace(SECRET_LIKE, match => {
		const key = match.split(/[:=]/)[0]?.trim() ?? "secret";
		return `${key}=[REDACTED]`;
	});
}
