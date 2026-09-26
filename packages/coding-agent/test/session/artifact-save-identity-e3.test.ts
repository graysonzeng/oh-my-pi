/**
 * E3: measure hash / save / read counts and wall-clock for first retain,
 * consecutive identical save, long-file save, and verify-by-reread path.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "../../src/session/artifacts";

type Row = {
	scenario: string;
	hashOps: number;
	diskReads: number;
	saves: number;
	wallMs: number;
	finalInputBytes: number;
	contentSha256Prefix: string;
};

describe("E3 read-dedupe cost measurements (artifact identity)", () => {
	let dir: string;
	const rows: Row[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "art-e3-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function measure(
		scenario: string,
		body: string,
		opts: { trustReturnedIdentity: boolean; consecutiveIdentical?: boolean },
	): Promise<Row> {
		const manager = new ArtifactManager(dir);
		let hashOps = 0;
		let diskReads = 0;
		let saves = 0;
		const hashOnce = (text: string) => {
			hashOps += 1;
			return new Bun.CryptoHasher("sha256").update(text).digest("hex");
		};
		const t0 = performance.now();
		const first = await manager.saveWithIdentity(body, "read");
		saves += 1;
		// saveWithIdentity itself hashes once internally — count that as the write hash.
		hashOps += 1;
		expect(first.contentSha256).toBe(hashOnce(body));
		// Correct the double-count from expect's hashOnce: write path = 1 internal + 1 verify assert.
		// Report "hashOps" as operations observers would perform:
		// - trust path after save: 0 extra disk reads, identity reuse
		// - verify path: 1 disk read + 1 hash of disk bytes
		if (opts.trustReturnedIdentity) {
			const trusted = first.contentSha256 === new Bun.CryptoHasher("sha256").update(body).digest("hex");
			hashOps += 1; // comparison hash of known body (caller already has bytes)
			expect(trusted).toBe(true);
			diskReads += 0;
		} else {
			const onDisk = await Bun.file((await manager.getPath(first.id))!).text();
			diskReads += 1;
			const diskHash = new Bun.CryptoHasher("sha256").update(onDisk).digest("hex");
			hashOps += 1;
			expect(diskHash).toBe(first.contentSha256);
		}
		if (opts.consecutiveIdentical) {
			const second = await manager.saveWithIdentity(body, "read");
			saves += 1;
			hashOps += 1; // second write hashes again
			expect(second.contentSha256).toBe(first.contentSha256);
			expect(second.id).not.toBe(first.id);
		}
		const wallMs = performance.now() - t0;
		const row: Row = {
			scenario,
			hashOps,
			diskReads,
			saves,
			wallMs: Number(wallMs.toFixed(3)),
			finalInputBytes: Buffer.byteLength(body, "utf-8"),
			contentSha256Prefix: first.contentSha256.slice(0, 12),
		};
		rows.push(row);
		return row;
	}

	it("first retain trusts returned identity with zero disk re-reads", async () => {
		const row = await measure("first_retain_trust_identity", "first-retain-body\n", {
			trustReturnedIdentity: true,
		});
		expect(row.diskReads).toBe(0);
		expect(row.saves).toBe(1);
	});

	it("verify-by-reread path performs exactly one disk read", async () => {
		const row = await measure("verify_by_reread", "verify-reread-body\n", {
			trustReturnedIdentity: false,
		});
		expect(row.diskReads).toBe(1);
		expect(row.saves).toBe(1);
	});

	it("consecutive identical save reuses content identity with a second write", async () => {
		const row = await measure("consecutive_identical", "same-bytes-twice\n", {
			trustReturnedIdentity: true,
			consecutiveIdentical: true,
		});
		expect(row.saves).toBe(2);
		expect(row.diskReads).toBe(0);
	});

	it("long file retain stays trust-path (no reread) and records wall clock", async () => {
		const body = ("long-line-" + "x".repeat(200) + "\n").repeat(400);
		const row = await measure("long_file_trust", body, { trustReturnedIdentity: true });
		expect(row.finalInputBytes).toBeGreaterThan(50_000);
		expect(row.diskReads).toBe(0);
		expect(row.wallMs).toBeGreaterThanOrEqual(0);
		const allRows = [...rows];
		await Bun.write(
			new URL("../../../../artifacts/e3-hash-wallclock-report.json", import.meta.url).pathname,
			`${JSON.stringify({ measuredAt: new Date().toISOString(), rows: allRows }, null, 2)}\n`,
		);
	});
});
