/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getActiveRules } from "../capability/rule";
import { resolveContainedPath } from "../discovery/contained-path";
import { getActiveSkills } from "../extensibility/skills";
import { isMarkdownPath } from "../utils/lang-from-path";
import { buildDirectoryResource } from "./filesystem-resource";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	if (isMarkdownPath(filePath)) return "text/markdown";
	return "text/plain";
}

const UNKNOWN_SKILL_NO_SCAN = "Do not glob or read **/SKILL.md to recover unknown skills.";

/** Fail-closed unknown-skill message. Suggests `rule://` only on an exact rule name match. */
export function formatUnknownSkillError(skillName: string, available: readonly string[]): string {
	const availableStr = available.length > 0 ? available.join(", ") : "none";
	const lines = [`Unknown skill: ${skillName}`, `Available: ${availableStr}`];
	if (getActiveRules().some(rule => rule.name === skillName)) {
		lines.push(`Did you mean rule://${skillName}?`);
	}
	lines.push(UNKNOWN_SKILL_NO_SCAN);
	return lines.join("\n");
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (
		relativePath.split(/[\\/]/).includes("..") ||
		normalized.startsWith("..") ||
		normalized.includes("/../") ||
		normalized.includes("/..")
	) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			throw new Error(formatUnknownSkillError(skillName, available));
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
			// Agent Plugin skills (§4.1): the resource must canonically resolve
			// within the plugin root; a dangling or unresolvable path fails closed.
			// Symlinks may target other files inside the same package.
			if (skill.containRoot) {
				const contained = await resolveContainedPath(skill.containRoot, resolvedPath);
				if (contained.status === "outside") {
					throw new Error(`skill:// path resolves outside the plugin root: ${url.href}`);
				}
				if (contained.status === "missing") {
					throw new Error(`File not found: ${resolvedPath}`);
				}
				targetPath = contained.realPath;
			}
		} else {
			targetPath = context?.pathOnly === true ? skill.baseDir : skill.filePath;
		}

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
			}
			throw error;
		}

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
