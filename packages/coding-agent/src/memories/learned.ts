/**
 * Owner persistence for `learned.md` — secret-redacted, injection-neutralized,
 * serial RMW queue, newest-first dedupe/cap.
 *
 * Extracted from the heavy `memories/index` graph so memory transfer (and other
 * light callers) can reuse the real owner without pulling natives/SQLite.
 */
import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { redactMemorySecrets as redactSecrets } from "../memory-backend/redact";
import type { MemoryBackendSaveInput, MemoryBackendSaveResult } from "../memory-backend/types";
import { normalizeScopeCwd } from "./storage";

/** Filename under a project's memory root. */
export const LEARNED_LESSONS_FILE = "learned.md";
/** Newest-first cap on retained lessons. */
export const MAX_LEARNED_LESSONS = 100;
/** Per-field char caps so a single huge capture can't bloat learned.md. */
export const MAX_LEARNED_CONTENT_CHARS = 2000;
export const MAX_LEARNED_CONTEXT_CHARS = 400;

export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(normalizeScopeCwd(cwd)));
}

export function learnedLessonsPath(agentDir: string, cwd: string): string {
	return path.join(getMemoryRoot(agentDir, cwd), LEARNED_LESSONS_FILE);
}

/**
 * Strip prompt-injection vectors from a single line of lesson text.
 * Applied on BOTH write and read.
 */
export function neutralizeInjection(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/** Slice to `maxChars`, dropping a trailing unpaired high surrogate. */
export function boundChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const sliced = text.slice(0, maxChars);
	return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

/**
 * Normalize one lesson field: neutralize injection FIRST, then redact secrets,
 * then bound length.
 */
export function normalizeLearnedText(text: string, maxChars: number): string {
	return boundChars(redactSecrets(neutralizeInjection(text)).trim(), maxChars);
}

/** Per-path write chains serializing `learned.md` read-modify-write. */
const learnedWriteChains = new Map<string, Promise<unknown>>();

/**
 * Append one lesson to the project's `learned.md` (newest-first, deduped,
 * capped, secret-redacted, injection-neutralized).
 */
export async function saveLearnedLesson(
	agentDir: string,
	cwd: string,
	input: MemoryBackendSaveInput,
): Promise<MemoryBackendSaveResult> {
	const content = normalizeLearnedText(input.content, MAX_LEARNED_CONTENT_CHARS);
	if (!content) {
		return { backend: "local", stored: 0, message: "Empty lesson; nothing stored." };
	}
	const context = input.context ? normalizeLearnedText(input.context, MAX_LEARNED_CONTEXT_CHARS) : "";
	const line = context ? `- ${content} _(context: ${context})_` : `- ${content}`;
	const filePath = learnedLessonsPath(agentDir, cwd);

	const run = (learnedWriteChains.get(filePath) ?? Promise.resolve()).then(() => appendLearnedLine(filePath, line));
	const guarded = run.catch(() => {});
	learnedWriteChains.set(filePath, guarded);
	try {
		await run;
	} finally {
		if (learnedWriteChains.get(filePath) === guarded) learnedWriteChains.delete(filePath);
	}
	return { backend: "local", stored: 1, message: `Lesson saved to ${LEARNED_LESSONS_FILE}.` };
}

async function appendLearnedLine(filePath: string, line: string): Promise<void> {
	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	const lines = existing.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const isLesson = (l: string) => l.trimStart().startsWith("- ");
	const out = lines.filter(l => !(isLesson(l) && l.trim() === line));
	const firstBullet = out.findIndex(isLesson);
	if (firstBullet === -1) out.push(line);
	else out.splice(firstBullet, 0, line);
	let lessonCount = 0;
	for (const l of out) if (isLesson(l)) lessonCount++;
	for (let i = out.length - 1; i >= 0 && lessonCount > MAX_LEARNED_LESSONS; i--) {
		if (isLesson(out[i])) {
			out.splice(i, 1);
			lessonCount--;
		}
	}
	await Bun.write(filePath, `${out.join("\n")}\n`);
}

/**
 * Read `learned.md`, neutralizing each line on read. Returns "" when absent.
 */
export async function readLearnedLessons(memoryRoot: string): Promise<string> {
	let raw = "";
	try {
		raw = (await Bun.file(path.join(memoryRoot, LEARNED_LESSONS_FILE)).text()).trim();
	} catch {
		return "";
	}
	if (!raw) return "";
	return raw
		.split("\n")
		.map(line => redactSecrets(neutralizeInjection(line)))
		.join("\n");
}

/**
 * Split `learned.md` into lesson records by real bullet boundaries.
 * Does not flatten or truncate — export uses this so long files keep every lesson.
 */
export function splitLearnedLessonBullets(raw: string): string[] {
	const lessons: string[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed.trimStart().startsWith("- ")) continue;
		const body = trimmed.replace(/^\s*-\s+/, "").trim();
		if (body) lessons.push(body);
	}
	return lessons;
}

/** Existing lesson line bodies (without leading `- `) for idempotent preview. */
export async function listExistingLearnedBodies(agentDir: string, cwd: string): Promise<Set<string>> {
	const bodies = new Set<string>();
	try {
		const raw = await Bun.file(learnedLessonsPath(agentDir, cwd)).text();
		for (const body of splitLearnedLessonBullets(raw)) {
			bodies.add(normalizeLearnedText(body, MAX_LEARNED_CONTENT_CHARS));
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	return bodies;
}

function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
