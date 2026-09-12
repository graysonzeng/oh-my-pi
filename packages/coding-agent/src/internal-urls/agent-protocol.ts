/**
 * Protocol handler for agent:// URLs.
 *
 * Resolves agent output IDs against the artifacts directories of every active
 * session. Parents and subagents share outputs via this registry: a subagent
 * can read its parent's output IDs because both sessions are registered in
 * the shared context.
 *
 * URL forms:
 * - agent://<id> - Full output content
 * - agent://<id>/<child> - Nested subagent output (hierarchy separator; the
 *   registry allocates a subagent's own children as dot-qualified ids, so
 *   `agent://Parent/Child` resolves `Parent.Child.md`)
 * - agent://<id>/<path> - JSON extraction via path form (fallback when no
 *   nested output matches the path)
 * - agent://<id>?q=<query> - JSON extraction via query form
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { applyQuery, pathToQuery } from "./json-query";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/**
 * Artifacts dirs for the session-scoped lineage roots: each ancestor session
 * file strips its `.jsonl` suffix to its artifacts dir (matching
 * `artifactsDirectoryFor`). Ordered nearest-first; duplicates collapse.
 */
function artifactsDirsFromLineage(context: ResolveContext | undefined): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	const lineage = context?.lineage;
	if (lineage?.currentSessionFile) addDir(lineage.currentSessionFile.slice(0, -6));
	for (const root of lineage?.lineageRoots ?? []) {
		addDir(root.canonicalPath.slice(0, -6));
	}
	return dirs;
}

/**
 * Handler for agent:// URLs.
 *
 * Resolves output IDs like "reviewer_0" to their artifact files,
 * with optional JSON extraction.
 */
export class AgentProtocolHandler implements ProtocolHandler {
	readonly scheme = "agent";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const outputId = url.rawHost || url.hostname;
		if (!outputId) {
			throw new Error("agent:// URL requires an output ID: agent://<id>");
		}

		const urlPath = url.pathname;
		const queryParam = url.searchParams.get("q");
		const hasPathExtraction = urlPath && urlPath !== "/" && urlPath !== "";
		const hasQueryExtraction = queryParam !== null && queryParam !== "";

		if (hasPathExtraction && hasQueryExtraction) {
			throw new Error("agent:// URL cannot combine path extraction with ?q=");
		}

		const registry = AgentRegistry.global();
		const rootSessionFile = context?.sessionFile
			? await ensurePersistedRoster(registry, context.sessionFile)
			: undefined;
		// Session-scoped lineage roots win over registry-derived current-process
		// roots, so a fresh process without a registered `Main` still reaches
		// persisted ancestors. The caller root's canonical artifact directory
		// (session file minus `.jsonl`) is still preferred in the registry scan
		// so two coexisting roots never let the other `Main` win first-hit.
		const dirs = [
			...artifactsDirsFromLineage(context),
			...artifactsDirsFromRegistry(rootSessionFile ? { preferredDir: rootSessionFile.slice(0, -6) } : undefined),
		];
		if (dirs.length === 0) {
			throw new Error("No session - agent outputs unavailable");
		}

		// A subagent allocates its own children as dot-qualified ids
		// (`Parent.Child`), so the slash path form is first tried as a hierarchy
		// separator: `agent://Parent/Child` resolves `Parent.Child.md`. Only when
		// no such nested output exists does the path fall back to jq-style JSON
		// extraction on `<outputId>.md`. Query form (`?q=`) is always extraction.
		const pathSegments = hasPathExtraction ? urlPath.split("/").filter(Boolean) : [];
		const decodedSegments = pathSegments.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
		const nestedId =
			decodedSegments.length > 0 && decodedSegments.every(segment => !segment.includes("."))
				? [outputId, ...decodedSegments].join(".")
				: undefined;

		const scan = await this.#findOutput(dirs, nestedId ? [nestedId, outputId] : [outputId]);
		if (!scan.anyDirExists) {
			throw new Error("No artifacts directory found");
		}
		if (!scan.foundPath) {
			const target = nestedId ?? outputId;
			const availableStr = scan.availableIds.size > 0 ? [...scan.availableIds].join(", ") : "none";
			throw new Error(`Not found: ${target}\nAvailable: ${availableStr}`);
		}

		const rawContent = await Bun.file(scan.foundPath).text();
		const notes: string[] = [];
		let content = rawContent;
		let contentType: InternalResource["contentType"] = "text/markdown";

		// Extraction applies only when the URL did NOT resolve to a nested output
		// (a slash that named a real child is a hierarchy hop, not a jq path).
		const extract = hasQueryExtraction || (hasPathExtraction && scan.matchedId !== nestedId);
		let extractedFrom = scan.foundPath;
		if (extract) {
			let jsonValue: unknown;
			let parsed = false;
			if (scan.jsonPath) {
				try {
					jsonValue = JSON.parse(await Bun.file(scan.jsonPath).text());
					extractedFrom = scan.jsonPath;
					parsed = true;
				} catch {
					// Corrupt or partially written sidecar: fall back to <id>.md.
				}
			}
			if (!parsed) {
				try {
					jsonValue = JSON.parse(rawContent);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					throw new Error(`Output ${scan.matchedId} is not valid JSON: ${message}`);
				}
			}

			const query = hasQueryExtraction ? queryParam! : pathToQuery(urlPath);
			if (query) {
				const extracted = applyQuery(jsonValue, query);
				if (typeof extracted === "string") {
					// A string field (e.g. a scout's markdown `report`) reads as prose,
					// not as a JSON-escaped single line.
					content = extracted;
				} else {
					try {
						content = JSON.stringify(extracted, null, 2) ?? "null";
					} catch {
						content = String(extracted);
					}
					contentType = "application/json";
				}
				notes.push(`Extracted: ${query}`);
			} else {
				content = JSON.stringify(jsonValue, null, 2);
				contentType = "application/json";
			}
			if (parsed) notes.push(`Source: ${path.basename(extractedFrom!)}`);
		}

		return {
			url: url.href,
			content,
			contentType,
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: extractedFrom,
			notes,
		};
	}

	/**
	 * Scan every registered artifacts dir for the first `<id>.md` among
	 * `candidateIds` (tried in order, so a hierarchy match wins over the base
	 * id). Returns the resolved path and the id it matched, plus the set of
	 * available ids gathered from the scanned dirs for the not-found message.
	 */
	async #findOutput(
		dirs: string[],
		candidateIds: string[],
	): Promise<{
		foundPath?: string;
		matchedId?: string;
		jsonPath?: string;
		anyDirExists: boolean;
		availableIds: Set<string>;
	}> {
		// Build a full id→path map across every registered dir before picking, so
		// candidate priority is global: a nested id in a deeper dir must win over
		// the base id even when the base id's dir is scanned first.
		const byId = new Map<string, string>();
		const jsonById = new Map<string, string>();
		let anyDirExists = false;
		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			anyDirExists = true;
			for (const f of files) {
				if (f.endsWith(".json")) {
					const jsonId = f.slice(0, -5);
					if (!jsonById.has(jsonId)) jsonById.set(jsonId, path.join(dir, f));
					continue;
				}
				if (!f.endsWith(".md")) continue;
				const id = f.slice(0, -3);
				if (!byId.has(id)) byId.set(id, path.join(dir, f));
			}
		}
		for (const id of candidateIds) {
			const foundPath = byId.get(id);
			if (foundPath) {
				// Pair the sidecar with the SAME dir as the matched `<id>.md`: two
				// coexisting roots can both hold `Worker`, and a first-hit sidecar
				// from the other root would answer with a foreign agent's payload
				// (see the `preferredDir` comment above and caller-root-ab.test.ts).
				const sidecar = jsonById.get(id);
				const jsonPath = sidecar && path.dirname(sidecar) === path.dirname(foundPath) ? sidecar : undefined;
				return {
					foundPath,
					matchedId: id,
					jsonPath,
					anyDirExists,
					availableIds: new Set(byId.keys()),
				};
			}
		}
		return { anyDirExists, availableIds: new Set(byId.keys()) };
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				if (f.endsWith(".md")) ids.add(f.slice(0, -3));
			}
		}
		return [...ids].sort().map(value => ({ value }));
	}
}
