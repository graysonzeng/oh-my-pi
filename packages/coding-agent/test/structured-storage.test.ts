import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BlobStore, parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { FileEntry, SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	SessionManager,
	type SessionMessageRewrite,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir } from "@oh-my-pi/pi-utils";

/**
 * Memory storage that parks every atomic rewrite behind a gate so tests can
 * hold a pending publish (or inject failures) deterministically.
 */
class GatedRewriteStorage extends MemorySessionStorage {
	readonly rewriteStarted = Promise.withResolvers<void>();
	readonly allowRewrite = Promise.withResolvers<void>();
	/** When > 0, the next atomic writes throw after the gate (publish or repair). */
	failNextWrites = 0;
	/** When true, failing writes also clobber the target so the repair sees a divergent file. */
	corruptOnFail = false;
	failedWrites = 0;
	guardRejections = 0;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.rewriteStarted.resolve();
		await this.allowRewrite.promise;
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		if (this.failNextWrites > 0) {
			this.failNextWrites--;
			this.failedWrites++;
			if (this.corruptOnFail) this.writeTextSync(path, "^broken\n");
			throw new Error("injected atomic publish failure");
		}
		this.writeTextSync(path, content);
	}
}

const TOOL_RESULT = {
	toolCallId: "toolu_structured",
	toolName: "bash",
	isError: false,
	timestamp: Date.now(),
} as const;

function textContent(text: string): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text }];
}

function rewrittenMessage(content: Array<{ type: "text"; text: string }>) {
	return { role: "toolResult" as const, ...TOOL_RESULT, content };
}

/** Seed a durable assistant message so the session file materializes. */
function assistantSeed(manager: SessionManager): void {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model");
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "seed response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

type ToolResultEntry = SessionMessageEntry & { message: ToolResultMessage };

function messageContent(manager: SessionManager, id: string): unknown {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant" || message.role === "user" || message.role === "toolResult") {
		return message.content;
	}
	return undefined;
}

function findToolResult(branch: readonly SessionEntry[], toolCallId: string): ToolResultEntry | undefined {
	return branch.find(
		(entry): entry is ToolResultEntry =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
	);
}

async function openManager(sessionFile: string, storage: MemorySessionStorage): Promise<SessionManager> {
	return SessionManager.open(sessionFile, "/sessions", storage, {
		initialCwd: "/cwd",
		suppressBreadcrumb: true,
	});
}

function seededStorage(): { storage: GatedRewriteStorage; manager: SessionManager; targetId: string } {
	const storage = new GatedRewriteStorage();
	const manager = SessionManager.create("/cwd", "/sessions", storage);
	assistantSeed(manager);
	const targetId = manager.appendMessage({
		role: "toolResult",
		...TOOL_RESULT,
		content: textContent("original result"),
	});
	return { storage, manager, targetId };
}

function patchFor(manager: SessionManager, targetId: string, text: string): SessionMessageRewrite {
	return {
		prefix: structuredClone(manager.getBranch()),
		replacements: [{ id: targetId, message: rewrittenMessage(textContent(text)) }],
	};
}
/** First `data` string of a `{ omittedOriginal: [{ data }] }` shape, or undefined. */
function imageDataOf(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	if (!("omittedOriginal" in data)) return undefined;
	const omitted = data.omittedOriginal;
	if (!Array.isArray(omitted) || omitted.length === 0) return undefined;
	const block = omitted[0];
	if (typeof block !== "object" || block === null || !("data" in block)) return undefined;
	return typeof block.data === "string" ? block.data : undefined;
}

async function makeTmpSessionsDir(): Promise<{ root: string; sessionsDir: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-structured-storage-"));
	return { root, sessionsDir: path.join(root, "sessions") };
}

function sha256Hex(value: string): string {
	return new Bun.SHA256().update(Buffer.from(value, "utf8")).digest("hex");
}

/** > MAX_PERSIST_CHARS — generic persistence would truncate with a notice. */
const LONG_TEXT = "0123456789".repeat(60_001);
/** Canonical base64 of 200 KB of binary data (round-trips exactly; well above the blob threshold). */
const IMAGE_DATA = Buffer.alloc(200_000, 7).toString("base64");
const IMAGE_MIME = "image/png";

function toolResultWithOriginals(): {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: "text"; text: string }>;
	omittedOriginal: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError: boolean;
	timestamp: number;
} {
	return {
		role: "toolResult",
		...TOOL_RESULT,
		content: textContent("visible placeholder"),
		omittedOriginal: [
			{ type: "text", text: LONG_TEXT },
			{ type: "image", data: IMAGE_DATA, mimeType: IMAGE_MIME },
		],
	};
}

describe("structured storage: rewriteMessageEntriesAtomically + omittedOriginal persistence", () => {
	it("persists >500k text + large image bytes to REAL disk and survives reopen and fork with byte-exact hashes", async () => {
		const { root, sessionsDir } = await makeTmpSessionsDir();
		try {
			// Default FileSessionStorage: a genuine on-disk JSONL journal.
			const manager = SessionManager.create("/cwd", sessionsDir);
			assistantSeed(manager);
			manager.appendMessage(toolResultWithOriginals());
			await manager.flush();

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");

			// On-disk JSONL: the text original is byte-exact BEFORE blob
			// resolution; the image original is externalized to a blob ref.
			const raw = await fs.promises.readFile(sessionFile, "utf8");
			const parsed = parseSessionContent(raw).entries;
			const persistedEntry = findToolResult(parsed as SessionEntry[], TOOL_RESULT.toolCallId);
			if (persistedEntry?.type !== "message") throw new Error("Expected persisted tool result");
			const persistedOriginal = persistedEntry.message.omittedOriginal;
			expect(persistedOriginal?.[0]).toEqual({ type: "text", text: LONG_TEXT });
			expect(persistedOriginal?.[1]?.type).toBe("image");
			if (persistedOriginal?.[1]?.type !== "image") throw new Error("Expected image original");
			expect(persistedOriginal[1].data).toMatch(/^blob:sha256:[a-f0-9]{64}$/);
			expect(persistedOriginal[1].mimeType).toBe(IMAGE_MIME);

			const textHash = sha256Hex(LONG_TEXT);
			const imageHash = sha256Hex(IMAGE_DATA);
			const assertExact = (entry: SessionEntry | undefined): void => {
				if (entry?.type !== "message") throw new Error("Expected tool result with originals");
				if (entry.message.role !== "toolResult") throw new Error("Expected a tool result message");
				const original = entry.message.omittedOriginal;
				expect(original?.[0]).toEqual({ type: "text", text: LONG_TEXT });
				if (original?.[1]?.type !== "image") throw new Error("Expected image original");
				expect(sha256Hex(original[0].type === "text" ? original[0].text : "")).toBe(textHash);
				expect(sha256Hex(original[1].data)).toBe(imageHash);
				expect(original[1].mimeType).toBe(IMAGE_MIME);
				// Provider-visible content stays short and untouched.
				expect(entry.message.content).toEqual([{ type: "text", text: "visible placeholder" }]);
			};

			// Restart from disk through a fresh manager.
			const reopened = await SessionManager.open(sessionFile, sessionsDir, undefined, {
				initialCwd: "/cwd",
				suppressBreadcrumb: true,
			});
			assertExact(findToolResult(reopened.getBranch(), TOOL_RESULT.toolCallId));

			// Fork the ORIGINAL manager on disk and restart from the forked file.
			await manager.fork();
			const forkedReloaded = await SessionManager.open(manager.getSessionFile()!, sessionsDir, undefined, {
				initialCwd: "/cwd",
				suppressBreadcrumb: true,
			});
			assertExact(findToolResult(forkedReloaded.getBranch(), TOOL_RESULT.toolCallId));

			// Missing blob: reopening degrades gracefully (returns the ref, never
			// crashes); the blob is then restored so deduped content stays intact.
			const ref = persistedOriginal[1].data;
			const hash = parseBlobRef(ref);
			if (!hash) throw new Error("Expected parseable blob ref");
			await fs.promises.unlink(path.join(getBlobsDir(), hash));
			const degraded = await SessionManager.open(sessionFile, sessionsDir, undefined, {
				initialCwd: "/cwd",
				suppressBreadcrumb: true,
			});
			const degradedEntry = findToolResult(degraded.getBranch(), TOOL_RESULT.toolCallId);
			if (degradedEntry?.type !== "message") throw new Error("Expected degraded tool result");
			expect(degradedEntry.message.omittedOriginal?.[1]?.type).toBe("image");
			if (degradedEntry.message.omittedOriginal?.[1]?.type === "image") {
				expect(degradedEntry.message.omittedOriginal[1].data).toBe(ref);
			}
			await new BlobStore(getBlobsDir()).put(Buffer.from(IMAGE_DATA, "base64"));
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("surfaces image externalization failure instead of silently losing the original", async () => {
		const { root } = await makeTmpSessionsDir();
		try {
			const blocker = path.join(root, "blocker");
			await fs.promises.writeFile(blocker, "x");
			const entry = {
				type: "message",
				id: "e-ext",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "toolResult",
					...TOOL_RESULT,
					content: textContent("visible"),
					omittedOriginal: [
						{ type: "image", data: Buffer.alloc(8_192, 3).toString("base64"), mimeType: "image/png" },
					],
				},
			} as unknown as FileEntry;
			// BlobStore whose directory cannot be created (parent is a regular file).
			expect(() => prepareEntryForPersistence(entry, new BlobStore(path.join(blocker, "blobs")))).toThrow();
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("truncates same-named omittedOriginal on non-toolResult carriers and oversized extra metadata inside text blocks", () => {
		const blobStore = new BlobStore(getBlobsDir()); // text-only fixtures: no blob writes

		// (1) A same-named carrier that is NOT a toolResult message must NOT get
		// the exact-original exemption — its oversized text still truncates.
		const fake = {
			type: "custom",
			customType: "fake",
			id: "e-fake",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			data: { omittedOriginal: [{ type: "text", text: LONG_TEXT }] },
		} as unknown as FileEntry;
		const persistedFake = prepareEntryForPersistence(fake, blobStore) as unknown as {
			data: { omittedOriginal: Array<{ text: string }> };
		};
		expect(persistedFake.data.omittedOriginal[0].text.length).toBeLessThan(LONG_TEXT.length);
		expect(persistedFake.data.omittedOriginal[0].text).toContain("[Session persistence truncated large content]");

		// (2) `role` alone must never authorize an exemption: a same-named
		// carrier that mimics role while carrying a NON-array omittedOriginal
		// (an object) still truncates its oversized text.
		const fakeRole = {
			type: "custom",
			customType: "fake-role",
			id: "e-fake-role",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			data: { role: "toolResult", omittedOriginal: { text: LONG_TEXT } },
		} as unknown as FileEntry;
		const persistedFakeRole = prepareEntryForPersistence(fakeRole, blobStore) as unknown as {
			data: { omittedOriginal: { text: string } };
		};
		expect(persistedFakeRole.data.omittedOriginal.text.length).toBeLessThan(LONG_TEXT.length);
		expect(persistedFakeRole.data.omittedOriginal.text).toContain("[Session persistence truncated large content]");

		// (3) Inside the REAL toolResult.omittedOriginal array, only the DIRECT
		// `text` field of a text block is exempt. Oversized extra metadata —
		// including NESTED text under it — still truncates.
		const toolResult = {
			type: "message",
			id: "e-extra",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				...TOOL_RESULT,
				content: textContent("visible"),
				omittedOriginal: [
					{
						type: "text",
						text: LONG_TEXT,
						extraMetadata: "y".repeat(600_000),
						nested: { text: "z".repeat(600_000) },
					},
				],
			},
		} as unknown as FileEntry;
		const persisted = prepareEntryForPersistence(toolResult, blobStore) as unknown as {
			message: {
				omittedOriginal: Array<{ text: string; extraMetadata?: string; nested?: { text: string } }>;
			};
		};
		expect(persisted.message.omittedOriginal[0].text).toBe(LONG_TEXT); // exact
		expect(persisted.message.omittedOriginal[0].extraMetadata?.length).toBeLessThan(600_000);
		expect(persisted.message.omittedOriginal[0].extraMetadata).toContain(
			"[Session persistence truncated large content]",
		);
		// The nested `text` under an extra metadata object is NOT the direct
		// text property of the block — it truncates like any generic field.
		expect(persisted.message.omittedOriginal[0].nested?.text.length).toBeLessThan(600_000);
		expect(persisted.message.omittedOriginal[0].nested?.text).toContain(
			"[Session persistence truncated large content]",
		);
	});

	it("never re-authorizes the recovery exemption from generic subtrees: nested fake entries, non-Text/Image elements, and nested arrays all truncate", () => {
		const blobStore = new BlobStore(getBlobsDir()); // text-only fixtures: no blob writes

		// (1) A COMPLETE fake entry embedded in a generic subtree must NOT
		// re-authorize the exemption — only the root session entry qualifies.
		const nestedFakeEntry = {
			type: "custom",
			customType: "fake",
			id: "e-nested",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			data: {
				type: "message",
				message: { role: "toolResult", omittedOriginal: [{ type: "text", text: LONG_TEXT }] },
			},
		} as unknown as FileEntry;
		const persistedNested = prepareEntryForPersistence(nestedFakeEntry, blobStore) as unknown as {
			data: { message: { omittedOriginal: Array<{ text: string }> } };
		};
		expect(persistedNested.data.message.omittedOriginal[0].text.length).toBeLessThan(LONG_TEXT.length);
		expect(persistedNested.data.message.omittedOriginal[0].text).toContain(
			"[Session persistence truncated large content]",
		);

		// (2) The recovery array elements must be Text/Image blocks: a
		// non-Text/Image element carries no exemption, so its oversized text
		// truncates.
		const nonContentElement = {
			type: "message",
			id: "e-non-content",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				...TOOL_RESULT,
				content: textContent("visible"),
				omittedOriginal: [{ type: "script", text: LONG_TEXT }],
			},
		} as unknown as FileEntry;
		const persistedNonContent = prepareEntryForPersistence(nonContentElement, blobStore) as unknown as {
			message: { omittedOriginal: Array<{ text: string }> };
		};
		expect(persistedNonContent.message.omittedOriginal[0].text.length).toBeLessThan(LONG_TEXT.length);
		expect(persistedNonContent.message.omittedOriginal[0].text).toContain(
			"[Session persistence truncated large content]",
		);

		// (3) A nested ARRAY inside the recovery array is not a Text/Image
		// element: the exemption must not recurse into it, so its text
		// truncates.
		const nestedArray = {
			type: "message",
			id: "e-nested-array",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				...TOOL_RESULT,
				content: textContent("visible"),
				omittedOriginal: [[{ type: "text", text: LONG_TEXT }]],
			},
		} as unknown as FileEntry;
		const persistedNestedArray = prepareEntryForPersistence(nestedArray, blobStore) as unknown as {
			message: { omittedOriginal: Array<Array<{ text: string }>> };
		};
		expect(persistedNestedArray.message.omittedOriginal[0][0].text.length).toBeLessThan(LONG_TEXT.length);
		expect(persistedNestedArray.message.omittedOriginal[0][0].text).toContain(
			"[Session persistence truncated large content]",
		);
	});

	it("keeps foreign same-named omittedOriginal image blob fields unresolved on load (old behavior)", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		assistantSeed(manager);
		const foreignRef = `blob:sha256:${"ab".repeat(32)}`;
		const customId = manager.appendCustomEntry("foreign-payload", {
			omittedOriginal: [{ type: "image", data: foreignRef, mimeType: "image/png" }],
		});
		await manager.flush();

		// The foreign payload is not a message entry: the loader must keep its
		// same-named image blob field untouched (only verified toolResult
		// recovery arrays resolve).
		const reloaded = await openManager(manager.getSessionFile()!, storage);
		const custom = reloaded.getEntry(customId);
		if (custom?.type !== "custom") throw new Error("Expected custom entry");
		expect(imageDataOf(custom.data)).toBe(foreignRef);
	});

	it("rejects a rewrite whose same-ID message was modified after capture", async () => {
		const { manager, targetId } = seededStorage();
		await manager.flush();
		const patch = patchFor(manager, targetId, "rewritten content");

		// Same-ID content mutation between capture and commit (a prune-style
		// in-place edit) must invalidate the full-value prefix CAS.
		const live = manager.getEntry(targetId);
		if (live?.type !== "message") throw new Error("Expected message entry");
		if (live.message.role !== "toolResult") throw new Error("Expected tool result message");
		live.message = { ...live.message, content: textContent("same-ID edit changed content") };

		expect(await manager.rewriteMessageEntriesAtomically(patch, () => true)).toBe(false);
		// Nothing was applied; the live edit remains.
		expect(messageContent(manager, targetId)).toEqual(textContent("same-ID edit changed content"));
	});

	it("rejects a rewrite whose entry metadata changed after capture", async () => {
		const { manager, targetId } = seededStorage();
		await manager.flush();
		const patch = patchFor(manager, targetId, "rewritten content");

		const live = manager.getEntry(targetId);
		if (!live) throw new Error("Expected entry");
		live.parentId = "different-parent";

		expect(await manager.rewriteMessageEntriesAtomically(patch, () => true)).toBe(false);
	});

	it("applies nothing when the synchronous validator vetoes the rewrite", async () => {
		const { manager, targetId } = seededStorage();
		await manager.flush();
		const patch = patchFor(manager, targetId, "rewritten content");

		expect(await manager.rewriteMessageEntriesAtomically(patch, () => false)).toBe(false);
		expect(messageContent(manager, targetId)).toEqual(textContent("original result"));
	});

	it("returns false (not a commit) for rewrites with no or duplicate replacements", async () => {
		const { manager, targetId } = seededStorage();
		await manager.flush();
		const prefix = structuredClone(manager.getBranch());

		expect(await manager.rewriteMessageEntriesAtomically({ prefix, replacements: [] }, () => true)).toBe(false);
		expect(
			await manager.rewriteMessageEntriesAtomically(
				{
					prefix,
					replacements: [
						{ id: targetId, message: rewrittenMessage(textContent("first")) },
						{ id: targetId, message: rewrittenMessage(textContent("second")) },
					],
				},
				() => true,
			),
		).toBe(false);
		expect(messageContent(manager, targetId)).toEqual(textContent("original result"));
	});

	it("rejects a rewrite with a compaction or reset boundary appended after the captured prefix", async () => {
		const { manager, targetId } = seededStorage();
		await manager.flush();

		// Capture the prefix FIRST; the boundaries are appended after capture,
		// which is exactly what must invalidate the patch.
		const prefix = structuredClone(manager.getBranch());
		const replacement = rewrittenMessage(textContent("rewritten content"));

		// Compaction boundary is not a pure append: it invalidates the patch.
		const firstKeptEntryId = manager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected branch entry");
		manager.appendCompaction("summary", "short", firstKeptEntryId, 100);
		expect(
			await manager.rewriteMessageEntriesAtomically(
				{ prefix, replacements: [{ id: targetId, message: replacement }] },
				() => true,
			),
		).toBe(false);

		// Same for a /clear reset boundary.
		manager.appendResetBoundary();
		expect(
			await manager.rewriteMessageEntriesAtomically(
				{ prefix, replacements: [{ id: targetId, message: replacement }] },
				() => true,
			),
		).toBe(false);
		expect(messageContent(manager, targetId)).toEqual(textContent("original result"));
	});

	it("rolls back only the replacement on publish failure, retains the concurrent append, repairs, and lets the queued waiter run against repaired state", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		const patch = patchFor(manager, targetId, "rewritten result by patch");
		const committing = manager.rewriteMessageEntriesAtomically(patch, () => true);
		// Pure append lands synchronously BEFORE the publish task starts (no
		// fence yet): it must survive the failed replacement untouched.
		manager.appendMessage({ role: "user", content: "appended during replacement", timestamp: Date.now() });

		// Queue a same-ID "shake-like" waiter behind the owner lease; it must
		// not run until the failed publish is repaired.
		let waiterRan = false;
		let stateSeenByWaiter: unknown;
		const waiter = manager.runExclusive(async () => {
			stateSeenByWaiter = messageContent(manager, targetId);
			const entry = manager.getEntry(targetId);
			if (entry?.type !== "message") throw new Error("Expected message entry");
			if (entry.message.role !== "toolResult") throw new Error("Expected tool result message");
			entry.message = { ...entry.message, content: textContent("queued shake edit") };
			await manager.rewriteEntries();
			waiterRan = true;
		});

		await storage.rewriteStarted.promise;
		expect(waiterRan).toBe(false);
		storage.failNextWrites = 1;
		storage.allowRewrite.resolve();

		await expect(committing).rejects.toThrow("injected atomic publish failure");
		// The rewrite rejects only after repair finishes and the owner lease is
		// released, so the waiter may already have run by the time we resume.
		await waiter;
		expect(waiterRan).toBe(true);
		// The waiter executed against the REPAIRED state: the patch's rewrite
		// was rolled back (preimage restored), so it saw the original message.
		expect(stateSeenByWaiter).toEqual(textContent("original result"));

		// Live, JSONL, and fresh reload agree: shake edit + append preserved,
		// and the rolled-back patch text is nowhere durable.
		expect(messageContent(manager, targetId)).toEqual(textContent("queued shake edit"));
		expect(
			manager.getBranch().some(entry => {
				if (entry.type !== "message") return false;
				const message = entry.message;
				return (
					(message.role === "user" || message.role === "assistant") &&
					message.content === "appended during replacement"
				);
			}),
		).toBe(true);

		const raw = await storage.readText(manager.getSessionFile()!);
		expect(raw).toContain("queued shake edit");
		expect(raw).toContain("appended during replacement");
		expect(raw).not.toContain("rewritten result by patch");

		const reloaded = await openManager(manager.getSessionFile()!, storage);
		const reloadedEntry = findToolResult(reloaded.getBranch(), TOOL_RESULT.toolCallId);
		if (reloadedEntry?.type !== "message") throw new Error("Expected reloaded tool result");
		expect(reloadedEntry.message.content).toEqual(textContent("queued shake edit"));
		expect(
			reloaded.getBranch().some(entry => {
				if (entry.type !== "message") return false;
				const message = entry.message;
				return (
					(message.role === "user" || message.role === "assistant") &&
					message.content === "appended during replacement"
				);
			}),
		).toBe(true);
	});

	it("retains the indeterminate latch, rejects queued mutations, and only recovery restores consistency", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		let waiterRan = false;
		const committing = manager.rewriteMessageEntriesAtomically(
			patchFor(manager, targetId, "rewritten content"),
			() => true,
		);
		const queued = manager.runExclusive(async () => {
			waiterRan = true;
		});
		// The latch may reject this queued promise before the assertion below
		// attaches a handler, and Bun reports unhandled rejections. The later
		// `expect(queued).rejects` still asserts the original promise.
		queued.catch(() => {});

		await storage.rewriteStarted.promise;
		storage.failNextWrites = Number.POSITIVE_INFINITY; // publish AND repair fail
		storage.corruptOnFail = true; // a divergent file forces a genuine indeterminate latch
		storage.allowRewrite.resolve();

		await expect(committing).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
		await expect(queued).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
		expect(waiterRan).toBe(false);

		// restoreState must NOT clear the latch: memory rollback is not disk
		// success. It is itself a queued mutation and is rejected by the latch.
		const snapshot = manager.captureState();
		await expect(manager.restoreState(snapshot)).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
		await expect(manager.runExclusive(async () => {})).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);

		// Only authoritative recovery cures the latch, after which new work runs.
		storage.failNextWrites = 0;
		await manager.recoverPersistenceFromCurrentState();
		await manager.runExclusive(async () => {});
		expect(messageContent(manager, targetId)).toEqual(textContent("original result"));
	});

	it("rejects reentrant owner calls once the latch is set inside the lease", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		let reentrantOutcome: unknown;
		const outer = manager.runExclusive(async () => {
			await expect(
				manager.rewriteMessageEntriesAtomically(patchFor(manager, targetId, "rewritten content"), () => true),
			).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
			try {
				await manager.runExclusive(async () => {});
				reentrantOutcome = "ran";
			} catch (err) {
				reentrantOutcome = err;
			}
		});

		await storage.rewriteStarted.promise;
		storage.failNextWrites = Number.POSITIVE_INFINITY;
		storage.corruptOnFail = true;
		storage.allowRewrite.resolve();
		await outer;

		// The reentrant path must fail closed against the latch, not run.
		expect(reentrantOutcome).toBeInstanceOf(SessionPersistenceIndeterminateError);
	});

	it("does not run a reentrant call whose signal was already aborted", async () => {
		const { manager } = seededStorage();
		await manager.flush();

		const controller = new AbortController();
		controller.abort();
		let nestedRan = false;
		await manager.runExclusive(async () => {
			await expect(
				manager.runExclusive(
					async () => {
						nestedRan = true;
					},
					{ signal: controller.signal },
				),
			).rejects.toThrow();
		});
		expect(nestedRan).toBe(false);
	});

	it("commits a rewrite against a shake/prune message whose cache version is non-enumerable, and still rejects a real post-capture change", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();
		storage.allowRewrite.resolve(); // not a gate test; release the parked publish

		// Real maintenance path: in-place replace the message body AND
		// invalidate the message cache on the new object (as prune/shake does).
		// The cache version is a non-enumerable symbol, so it must NOT make a
		// structuredClone prefix stale — only actual content changes may.
		const entry = manager.getEntry(targetId);
		if (entry?.type !== "message") throw new Error("Expected message entry");
		if (entry.message.role !== "toolResult") throw new Error("Expected tool result message");
		entry.message = { ...entry.message, content: textContent("shaken content") };
		invalidateMessageCache(entry.message);

		const patch = patchFor(manager, targetId, "rewritten after shake");
		expect(await manager.rewriteMessageEntriesAtomically(patch, () => true)).toBe(true);
		expect(messageContent(manager, targetId)).toEqual(textContent("rewritten after shake"));

		// Negative control: a real same-ID content change AFTER capture still
		// invalidates the full-value CAS, even with the cache invalidation run.
		entry.message = { ...entry.message, content: textContent("changed after capture") };
		invalidateMessageCache(entry.message);
		expect(await manager.rewriteMessageEntriesAtomically(patch, () => true)).toBe(false);
		expect(messageContent(manager, targetId)).toEqual(textContent("changed after capture"));
	});

	it("reports a real commit when a superseding append rewrites the body including the replacement", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		const committing = manager.rewriteMessageEntriesAtomically(
			patchFor(manager, targetId, "committed replacement"),
			() => true,
		);
		await storage.rewriteStarted.promise; // publish parked, fence active
		// A completed append supersedes the parked publish with a synchronous
		// full-body rewrite that carries both the replacement and the append.
		manager.appendMessage({ role: "user", content: "append during pending publish", timestamp: Date.now() });
		storage.allowRewrite.resolve();

		expect(await committing).toBe(true);
		expect(storage.guardRejections).toBe(1);

		expect(messageContent(manager, targetId)).toEqual(textContent("committed replacement"));
		const raw = await storage.readText(manager.getSessionFile()!);
		expect(raw).toContain("committed replacement");
		expect(raw).toContain("append during pending publish");

		const reloaded = await openManager(manager.getSessionFile()!, storage);
		const reloadedEntry = findToolResult(reloaded.getBranch(), TOOL_RESULT.toolCallId);
		if (reloadedEntry?.type !== "message") throw new Error("Expected reloaded tool result");
		expect(reloadedEntry.message.content).toEqual(textContent("committed replacement"));
	});

	it("rejects a canceled waiter promptly during a pending publish, without running it or disturbing the commit", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		const committing = manager.rewriteMessageEntriesAtomically(
			patchFor(manager, targetId, "committed replacement"),
			() => true,
		);
		await storage.rewriteStarted.promise; // lease held by the parked publish

		const controller = new AbortController();
		let cancelRan = false;
		let waiterSettled = false;
		let committingSettled = false;
		const waiter = manager.runExclusive(
			async () => {
				cancelRan = true;
			},
			{ signal: controller.signal },
		);
		waiter.then(
			() => {
				waiterSettled = true;
			},
			() => {
				waiterSettled = true;
			},
		);
		committing.then(
			() => {
				committingSettled = true;
			},
			() => {
				committingSettled = true;
			},
		);

		controller.abort();
		await Bun.sleep(0); // macrotask turn: the canceled waiter must settle
		expect(waiterSettled).toBe(true); // ...even though the publish is STILL parked
		expect(committingSettled).toBe(false); // the lease was not released early
		expect(cancelRan).toBe(false);

		storage.allowRewrite.resolve();
		expect(await committing).toBe(true);
		await expect(waiter).rejects.toThrow();
	});

	it("runs nested runExclusive inline within the acquiring chain and serializes concurrent callers FIFO", async () => {
		const { manager } = seededStorage();
		await manager.flush();

		let innerRan = false;
		await manager.runExclusive(async () => {
			await manager.runExclusive(async () => {
				innerRan = true;
			});
		});
		expect(innerRan).toBe(true);

		const events: string[] = [];
		await Promise.all([
			manager.runExclusive(async () => {
				events.push("a");
			}),
			manager.runExclusive(async () => {
				events.push("b");
			}),
		]);
		expect(events).toEqual(["a", "b"]);
	});

	it("commits rewrites in memory for non-persistent managers", async () => {
		const manager = SessionManager.inMemory();
		const targetId = manager.appendMessage({
			role: "toolResult",
			...TOOL_RESULT,
			content: textContent("original result"),
		});

		expect(
			await manager.rewriteMessageEntriesAtomically(patchFor(manager, targetId, "in-memory rewrite"), () => true),
		).toBe(true);
		expect(messageContent(manager, targetId)).toEqual(textContent("in-memory rewrite"));
	});

	it("allows compaction boundaries inside the appendEntriesAtomically sync callback (reentrant owner)", async () => {
		const { storage, manager } = seededStorage();
		await manager.flush();
		storage.allowRewrite.resolve(); // not a gate test; release the parked publish

		// LifecycleOwner's batch path appends compaction entries from the
		// synchronous batch callback; the owner is reentrant there and the
		// boundary guard must pass.
		const firstKeptEntryId = manager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected branch entry");
		const appendedId = await manager.appendEntriesAtomically(() =>
			manager.appendCompaction("summary", "short", firstKeptEntryId, 100),
		);
		expect(appendedId.length).toBeGreaterThan(0);
		expect(manager.getBranch().some(entry => entry.type === "compaction" && entry.id === appendedId)).toBe(true);
	});

	it("rejects compaction/reset boundary appends that bypass a held owner, and allows them reentrantly", async () => {
		const { storage, manager, targetId } = seededStorage();
		await manager.flush();

		const committing = manager.rewriteMessageEntriesAtomically(
			patchFor(manager, targetId, "rewritten content"),
			() => true,
		);
		await storage.rewriteStarted.promise; // another chain holds the owner

		// Boundaries are NOT pure appends: a bypassing append must fail closed
		// while the owner is held by a different chain.
		expect(() => manager.appendResetBoundary()).toThrow(/mutation owner/);
		const firstKeptEntryId = manager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected branch entry");
		expect(() => manager.appendCompaction("summary", "short", firstKeptEntryId, 100)).toThrow(/mutation owner/);

		storage.allowRewrite.resolve();
		expect(await committing).toBe(true);

		// Inside an owned lease the same appends are reentrant (the boundary
		// defers to the wrapped operation, never piercing a pending rewrite).
		await manager.runExclusive(async () => {
			expect(manager.appendResetBoundary().length).toBeGreaterThan(0);
			expect(manager.appendCompaction("summary", "short", firstKeptEntryId, 100).length).toBeGreaterThan(0);
		});
	});
});
