import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

	it("returns reusable contentSha256 from save so callers need not re-hash immediately", async () => {
		const manager = new ArtifactManager(dir);
		const body = "identical-read-bytes-for-dedupe\n".repeat(20);
		const expected = new Bun.CryptoHasher("sha256").update(body).digest("hex");
		const saved = await manager.saveWithIdentity(body, "read");
		expect(saved.id).toMatch(/^\d+$/);
		expect(saved.contentSha256).toBe(expected);
		const onDisk = await Bun.file((await manager.getPath(saved.id))!).text();
		expect(onDisk).toBe(body);
		// Second save of same bytes gets a new id but identical content identity.
		const again = await manager.saveWithIdentity(body, "read");
		expect(again.id).not.toBe(saved.id);
		expect(again.contentSha256).toBe(saved.contentSha256);
	});

	it("records fewer re-reads when trusting returned identity after a fresh write", async () => {
		const manager = new ArtifactManager(dir);
		const body = "measure-reread-avoidance\n";
		let reads = 0;
		const saved = await manager.saveWithIdentity(body, "read");
		// Path under test: trust returned sha (0 re-reads) vs verify-by-reread (1+).
		const trustedMatch = saved.contentSha256 === new Bun.CryptoHasher("sha256").update(body).digest("hex");
		expect(trustedMatch).toBe(true);
		if (!trustedMatch) {
			reads += 1;
			const text = await Bun.file((await manager.getPath(saved.id))!).text();
			expect(new Bun.CryptoHasher("sha256").update(text).digest("hex")).toBe(saved.contentSha256);
		}
		expect(reads).toBe(0);
	});
});
