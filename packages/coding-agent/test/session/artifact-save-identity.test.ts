import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "../../src/session/artifacts";

describe("artifact save identity (R5/E3/E4)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "art-ident-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("returns sha and byteCount only after the written file matches the body", async () => {
		const manager = new ArtifactManager(dir);
		const body = "identical-read-bytes-for-dedupe\n".repeat(20);
		const saved = await manager.saveWithIdentity(body, "read");
		expect(saved.byteCount).toBe(Buffer.byteLength(body, "utf-8"));
		expect(saved.contentSha256).toBe(new Bun.CryptoHasher("sha256").update(body).digest("hex"));
		const onDisk = await Bun.file((await manager.getPath(saved.id))!).text();
		expect(Buffer.byteLength(onDisk, "utf-8")).toBe(saved.byteCount);
		expect(new Bun.CryptoHasher("sha256").update(onDisk).digest("hex")).toBe(saved.contentSha256);
		const again = await manager.saveWithIdentity(body, "read");
		expect(again.id).not.toBe(saved.id);
		expect(again.contentSha256).toBe(saved.contentSha256);
		expect(again.byteCount).toBe(saved.byteCount);
	});

	it("does not issue identity when the staged write is shorter than the body", async () => {
		const manager = new ArtifactManager(dir);
		const body = "short-write-must-not-attest\n";
		const originalWrite = Bun.write;
		const writeSpy = spyOn(Bun, "write").mockImplementation(async destination => {
			await originalWrite(destination, body.slice(0, 4));
			return 4;
		});
		try {
			await expect(manager.saveWithIdentity(body, "read")).rejects.toThrow(
				/incomplete|identity refused|size mismatch/i,
			);
			const files = await manager.listFiles();
			expect(files.filter(name => name.endsWith(".log"))).toEqual([]);
		} finally {
			writeSpy.mockRestore();
		}
	});
});
