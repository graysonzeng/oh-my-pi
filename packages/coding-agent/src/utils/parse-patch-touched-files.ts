/** Parse repository-relative paths from Git unified-diff headers, including C-quoted UTF-8 names. */

const GIT_PATH_TOKEN = /^(?:"(?:\\.|[^"])*"|[^\s]+)/;
const GIT_PATH_ENCODER = new TextEncoder();
const GIT_PATH_DECODER = new TextDecoder();
const GIT_PATH_ESCAPE_BYTES: Readonly<Record<string, number>> = {
	a: 0x07,
	b: 0x08,
	t: 0x09,
	n: 0x0a,
	v: 0x0b,
	f: 0x0c,
	r: 0x0d,
	'"': 0x22,
	"\\": 0x5c,
};

function decodeGitPathToken(rawToken: string, stripDiffPrefix: boolean): string {
	let value = rawToken;
	if (value.startsWith('"') && value.endsWith('"')) {
		const body = value.slice(1, -1);
		const bytes: number[] = [];
		for (let index = 0; index < body.length; index++) {
			const character = body[index]!;
			if (character !== "\\") {
				const codePoint = body.codePointAt(index)!;
				bytes.push(...GIT_PATH_ENCODER.encode(String.fromCodePoint(codePoint)));
				if (codePoint > 0xffff) index += 1;
				continue;
			}
			const escaped = body[++index];
			if (escaped === undefined) break;
			if (/^[0-7]$/.test(escaped)) {
				let octal = escaped;
				for (let count = 1; count < 3 && /^[0-7]$/.test(body[index + 1] ?? ""); count++) {
					octal += body[++index]!;
				}
				bytes.push(Number.parseInt(octal, 8));
				continue;
			}
			const escapeByte = GIT_PATH_ESCAPE_BYTES[escaped];
			if (escapeByte !== undefined) bytes.push(escapeByte);
			else bytes.push(...GIT_PATH_ENCODER.encode(escaped));
		}
		value = GIT_PATH_DECODER.decode(Uint8Array.from(bytes));
	}
	return stripDiffPrefix ? value.replace(/^[ab]\//, "") : value;
}

function diffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const first = GIT_PATH_TOKEN.exec(rest)?.[0];
	if (!first) return [];
	const second = GIT_PATH_TOKEN.exec(rest.slice(first.length).trimStart())?.[0];
	if (!second) return [];
	return [
		...new Set(
			[first, second].map(token => decodeGitPathToken(token, true)).filter(file => file && file !== "/dev/null"),
		),
	];
}

function patchHeaderPath(line: string): string | undefined {
	if (!line.startsWith("--- ") && !line.startsWith("+++ ")) return undefined;
	const token = GIT_PATH_TOKEN.exec(line.slice(4))?.[0];
	if (!token) return undefined;
	const file = decodeGitPathToken(token, true);
	return file && file !== "/dev/null" ? file : undefined;
}

function extendedHeaderPath(line: string, prefix: string): string | undefined {
	if (!line.startsWith(prefix)) return undefined;
	const file = decodeGitPathToken(line.slice(prefix.length).trim(), false);
	return file && file !== "/dev/null" ? file : undefined;
}

/** Parse repository-relative paths from Git unified-diff headers, including C-quoted UTF-8 names. */
export function parsePatchTouchedFiles(patchText: string): string[] {
	const files = new Set<string>();
	let blockPaths = new Set<string>();
	let copyDestination: string | undefined;
	let inFileHeader = true;
	const flushBlock = () => {
		if (copyDestination) files.add(copyDestination);
		else for (const file of blockPaths) files.add(file);
		blockPaths = new Set<string>();
		copyDestination = undefined;
	};
	for (const line of patchText.split("\n")) {
		const diffPaths = diffGitLinePaths(line);
		if (diffPaths.length > 0) {
			flushBlock();
			for (const file of diffPaths) blockPaths.add(file);
			inFileHeader = true;
			continue;
		}
		if (line.startsWith("@@")) {
			inFileHeader = false;
			continue;
		}
		if (!inFileHeader) continue;
		const copiedTo = extendedHeaderPath(line, "copy to ");
		if (copiedTo) {
			copyDestination = copiedTo;
			continue;
		}
		if (line.startsWith("copy from ")) continue;
		const headerPath = patchHeaderPath(line);
		if (headerPath) blockPaths.add(headerPath);
	}
	flushBlock();
	return [...files];
}
