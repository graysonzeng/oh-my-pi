import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "../../src/session/artifacts";
import { fileRecoveryUri, isProvenPersistedRef } from "../../src/workflow/stage-handoff";

describe("artifact identity I/O contracts", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "artifact-identity-io-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	it("does not reread the full body after save, retaining only the one-byte readability probe", async () => {
		const manager = new ArtifactManager(dir);
		const textReads = spyOn(Blob.prototype, "text");
		const byteReads = spyOn(Blob.prototype, "arrayBuffer");
		const saved = await manager.saveWithIdentity("recoverable-original\n", "read");
		expect(textReads).not.toHaveBeenCalled();
		expect(byteReads.mock.contexts.map(value => (value instanceof Blob ? value.size : -1))).toEqual([1]);
		textReads.mockRestore();
		byteReads.mockRestore();
		const filePath = (await manager.getPath(saved.id))!;
		expect(await Bun.file(filePath).text()).toBe("recoverable-original\n");
	});

	it("persists equal content under independent ids instead of overwriting an earlier artifact", async () => {
		const manager = new ArtifactManager(dir);
		const writes = spyOn(Bun, "write");
		const first = await manager.saveWithIdentity("same-source\n", "read");
		const second = await manager.saveWithIdentity("same-source\n", "read");
		expect(writes).toHaveBeenCalledTimes(2);
		expect(second.id).not.toBe(first.id);
		await fs.promises.rm((await manager.getPath(first.id))!);
		expect(await Bun.file((await manager.getPath(second.id))!).text()).toBe("same-source\n");
	});

	it("reads a persisted reference once per validation and rejects external corruption", async () => {
		const manager = new ArtifactManager(dir);
		const saved = await manager.saveWithIdentity("immutable verification content\n", "read");
		const filePath = (await manager.getPath(saved.id))!;
		const ref = {
			artifactId: saved.id,
			bytes: saved.byteCount,
			contentSha256: saved.contentSha256,
			recoveryUri: fileRecoveryUri(filePath),
		};
		const reads = spyOn(fs, "readFileSync");
		expect(isProvenPersistedRef(ref)).toBe(true);
		expect(reads).toHaveBeenCalledTimes(1);
		await Bun.write(filePath, "externally changed content\n");
		reads.mockClear();
		expect(isProvenPersistedRef(ref)).toBe(false);
		expect(reads).toHaveBeenCalledTimes(1);
	});
});
