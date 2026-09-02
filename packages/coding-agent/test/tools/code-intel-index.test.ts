import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { mnemopiEmbedClient } from "../../src/mnemopi/embed-client";
import {
	__resetCodeIntelIndexesForTests,
	codeIntelProjectKey,
	getCodeIntelIndex,
} from "../../src/tools/code-intel-index";
import { hasCodeIntelNatives } from "../../src/tools/code-intel-natives";

let indexHome: string | undefined;

beforeEach(async () => {
	indexHome = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-home-"));
	vi.spyOn(piUtils, "getCodeIntelDir").mockReturnValue(path.join(indexHome, "code-intel"));
});

afterEach(async () => {
	await __resetCodeIntelIndexesForTests();
	vi.restoreAllMocks();
	if (indexHome) await piUtils.removeWithRetries(indexHome);
	indexHome = undefined;
});

describe("code_intel generation snapshot", () => {
	it("publishes CURRENT from a tmp generation and ignores crashed tmp dirs", async () => {
		if (!hasCodeIntelNatives()) return;
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const ready = await index.ensureReady();
			expect(ready.generationId).toBeTruthy();
			expect(ready.generationId?.endsWith(".tmp")).toBe(false);
			expect(ready.filesIndexed).toBeGreaterThan(0);
			const generationId = ready.generationId;
			if (!generationId) throw new Error("expected a published generation id");

			const key = await codeIntelProjectKey(project);
			const projectDir = path.join(piUtils.getCodeIntelDir(), key);
			const current = (await Bun.file(path.join(projectDir, "CURRENT")).text()).trim();
			expect(current).toBe(generationId);
			expect(await Bun.file(path.join(projectDir, "generations", generationId, "manifest.json")).exists()).toBe(
				true,
			);

			await fs.mkdir(path.join(projectDir, "generations", "crash.tmp"), { recursive: true });
			await Bun.write(path.join(projectDir, "generations", "crash.tmp", "manifest.json"), "{}\n");
			await __resetCodeIntelIndexesForTests();
			const reloaded = getCodeIntelIndex(project, settings);
			await reloaded.ensureReady();
			await reloaded.waitUntilWarm();
			const afterCrash = await reloaded.ensureReady();
			expect(afterCrash.generationId).toBe(current);
			expect(afterCrash.generationId?.endsWith(".tmp")).toBe(false);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("rebuilds after invalidate instead of pinning the first in-flight warm forever", async () => {
		if (!hasCodeIntelNatives()) return;
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": false,
			});
			const index = getCodeIntelIndex(project, settings);
			await index.ensureReady();
			await index.waitUntilWarm();
			const first = await index.ensureReady();
			expect(first.generationId).toBeTruthy();
			await Bun.write(path.join(project, "extra.rs"), "pub fn beta() {}\n");
			index.invalidate(path.join(project, "extra.rs"));
			await index.waitUntilWarm();
			const second = await index.ensureReady();
			expect(second.generationId).toBeTruthy();
			expect(second.generationId).not.toBe(first.generationId);
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("does not initialize the embed worker from a query-time semanticHits call", async () => {
		const initialize = vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(null);
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": true,
			});
			const index = getCodeIntelIndex(project, settings);
			index.status();
			const hits = await index.semanticHits({ query: "alpha" });
			expect(hits).toEqual([]);
			expect(initialize).not.toHaveBeenCalled();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});

	it("initializes the embed worker on background warm, not on status()", async () => {
		if (!hasCodeIntelNatives()) return;
		const initialize = vi.spyOn(mnemopiEmbedClient, "initialize").mockResolvedValue(null);
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "code-intel-project-"));
		try {
			await Bun.write(path.join(project, "lib.rs"), "pub fn alpha() {}\n");
			const settings = Settings.isolated({
				"codeIntel.enabled": true,
				"codeIntel.semantic": true,
			});
			const index = getCodeIntelIndex(project, settings);
			index.status();
			expect(initialize).not.toHaveBeenCalled();
			await index.ensureReady();
			await index.waitUntilWarm();
			expect(initialize).toHaveBeenCalled();
		} finally {
			await piUtils.removeWithRetries(project);
		}
	});
});
