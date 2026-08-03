import * as fs from "node:fs/promises";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

/** Parsed xd:// target — classic device or presentation namespace bridge. */
export interface XdTarget {
	/**
	 * Device / skill name, or null for the root listing (`xd://`).
	 * For presentation locators `xd://tools/{name}` / `xd://skills/{name}`,
	 * this is the bare `{name}` so existing registry lookup still works.
	 */
	name: string | null;
	/**
	 * Presentation namespace when the URL used `tools/` or `skills/` path form.
	 * Classic `xd://{device}` leaves this null.
	 */
	namespace: "tools" | "skills" | null;
}

/**
 * Parse an `xd://` URL into its device / presentation target.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 *
 * Supported forms (same transport — no second protocol):
 * - `xd://` — root listing
 * - `xd://{tool}` — classic device docs / dispatch
 * - `xd://tools/{name}` — presentation schema locator (bridges to device `{name}`)
 * - `xd://skills/{name}` — presentation skill body locator
 */
export function parseXdUrl(input: string): XdTarget | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(XD_URL_PREFIX)) return null;
	const rest = trimmed.slice(XD_URL_PREFIX.length);
	if (rest.length === 0) return { name: null, namespace: null };
	// Reject query/fragment; path segments only for known presentation namespaces.
	if (/[?#]/.test(rest)) return null;

	const toolsMatch = /^tools\/([^/]+)$/.exec(rest);
	if (toolsMatch?.[1]) return { name: toolsMatch[1], namespace: "tools" };

	const skillsMatch = /^skills\/([^/]+)$/.exec(rest);
	if (skillsMatch?.[1]) return { name: skillsMatch[1], namespace: "skills" };

	// Classic xd://{tool} — no nested path.
	if (rest.includes("/")) return null;
	return { name: rest, namespace: null };
}

/** Whether a streaming path prefix could still become an `xd://` URL. */
export function couldBecomeXdUrl(partialPath: string): boolean {
	if (partialPath.length <= XD_URL_PREFIX.length) {
		return XD_URL_PREFIX.startsWith(partialPath.toLowerCase());
	}
	return partialPath.toLowerCase().startsWith(XD_URL_PREFIX);
}

/** Routes session-bound virtual tool devices through `xd://` URLs. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseXdUrl(url.href);
		if (!target) {
			throw new Error(
				`Invalid xd:// URL: ${url.href}. Use xd://, xd://<tool>, xd://tools/<name>, or xd://skills/<name>.`,
			);
		}

		// Skill presentation locator: bridge to session skills (same one-hop load as skill://).
		// Does not require the tool-device xd registry — skills live on the skill list.
		if (target.namespace === "skills") {
			if (!target.name) throw new Error(`Invalid xd://skills URL: ${url.href}. Use xd://skills/<name>.`);
			const skills = context?.skills;
			if (!skills || skills.length === 0) {
				throw new Error(`xd://skills/${target.name}: no skills loaded in this session.`);
			}
			const skill = skills.find(s => s.name === target.name);
			if (!skill) {
				const available = skills.map(s => s.name).join(", ") || "none";
				throw new Error(`Unknown skill: ${target.name}\nAvailable: ${available}`);
			}
			// Prefer an in-memory body when present (workflow catalog forwards prepared
			// skill content); fall back to the on-disk SKILL.md for discovered skills.
			const content =
				typeof (skill as { content?: unknown }).content === "string" &&
				(skill as { content?: string }).content!.length > 0
					? (skill as { content?: string }).content!
					: await fs.readFile(skill.filePath, "utf-8");
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content),
				sourcePath: skill.filePath,
			};
		}

		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		// tools/ namespace and classic devices share the same xd.read transport.
		const content = await context.xd.read(target.name);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = parseXdUrl(url.href);
		if (!target) {
			throw new Error(`Invalid xd:// URL: ${url.href}. Use xd://<tool> or xd://tools/<name> for device dispatch.`);
		}
		if (target.namespace === "skills") {
			throw new Error(`xd://skills/${target.name ?? ""} is read-only; use skill:// for skill content.`);
		}
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		// Bridge xd://tools/{name} → same device dispatch as xd://{name}.
		await context.xd.write(target.name, content);
	}
}
