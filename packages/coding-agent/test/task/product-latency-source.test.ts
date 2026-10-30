import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	assertQualificationSourcePair,
	captureQualificationSource,
	PAIRED_FIXTURE_PATH,
} from "./product-latency-source";

async function seed(root: string): Promise<void> {
	for (const file of [
		"package.json",
		"bun.lock",
		"packages/coding-agent/package.json",
		PAIRED_FIXTURE_PATH,
		"packages/coding-agent/src/task/agents.ts",
		"packages/coding-agent/src/tools/read.ts",
		"packages/coding-agent/src/session/agent-session.ts",
	]) {
		await Bun.write(path.join(root, file), "baseline");
	}
}

describe("paired source isolation", () => {
	it("separates advisory changes from effort changes and rejects unrelated drift", async () => {
		using temp = TempDir.createSync("paired-source-");
		const controlRoot = path.join(temp.path(), "control");
		const treatmentRoot = path.join(temp.path(), "treatment");
		await seed(controlRoot);
		await seed(treatmentRoot);
		await Bun.write(path.join(treatmentRoot, "packages/coding-agent/src/tools/read.ts"), "advisory change");
		const control = await captureQualificationSource(controlRoot);
		const treatment = await captureQualificationSource(treatmentRoot);
		expect(assertQualificationSourcePair(control, treatment, "advisories")).toEqual([
			"packages/coding-agent/src/tools/read.ts",
		]);
		expect(() => assertQualificationSourcePair(control, treatment, "sonic-effort")).toThrow("undeclared");
		await Bun.write(path.join(treatmentRoot, "packages/coding-agent/src/unrelated.ts"), "new behavior");
		const drifted = await captureQualificationSource(treatmentRoot);
		expect(drifted.fingerprint).not.toBe(treatment.fingerprint);
		expect(() => assertQualificationSourcePair(control, drifted, "advisories")).toThrow("undeclared");
	});

	it("rejects changed dependency locks or scoring assets instead of attributing them to effort", async () => {
		using temp = TempDir.createSync("paired-source-");
		const controlRoot = path.join(temp.path(), "control");
		const treatmentRoot = path.join(temp.path(), "treatment");
		await seed(controlRoot);
		await seed(treatmentRoot);
		await Bun.write(path.join(treatmentRoot, "packages/coding-agent/src/task/agents.ts"), "ceiling change");
		const control = await captureQualificationSource(controlRoot);
		expect(
			assertQualificationSourcePair(control, await captureQualificationSource(treatmentRoot), "sonic-effort"),
		).toEqual(["packages/coding-agent/src/task/agents.ts"]);
		await Bun.write(path.join(treatmentRoot, "bun.lock"), "different dependency");
		expect(() => assertQualificationSourcePair(control, { ...control, root: treatmentRoot }, "advisories")).toThrow(
			"no experiment difference",
		);
		expect(() => assertQualificationSourcePair(control, { ...control }, "advisories")).toThrow(
			"distinct source roots",
		);
		const changedLock = await captureQualificationSource(treatmentRoot);
		expect(() => assertQualificationSourcePair(control, changedLock, "sonic-effort")).toThrow("bun.lock");
		await Bun.write(path.join(treatmentRoot, "bun.lock"), "baseline");
		await Bun.write(
			path.join(treatmentRoot, "packages/coding-agent/test/task/product-latency-reviewer-assignment.md"),
			"weaker scoring",
		);
		const changedRubric = await captureQualificationSource(treatmentRoot);
		expect(() => assertQualificationSourcePair(control, changedRubric, "sonic-effort")).toThrow("assignment.md");
	});

	it("refuses runtime source symlinks and missing required source files", async () => {
		using temp = TempDir.createSync("paired-source-");
		await seed(temp.path());
		const readPath = path.join(temp.path(), "packages/coding-agent/src/tools/read.ts");
		await fs.rm(readPath);
		await expect(captureQualificationSource(temp.path())).rejects.toThrow("missing required source");
		await fs.symlink(path.join(temp.path(), "package.json"), readPath);
		await expect(captureQualificationSource(temp.path())).rejects.toThrow("source symlink");
	});

	it("rejects a first-party workspace package that resolves through a shared node_modules to another checkout", async () => {
		using temp = TempDir.createSync("paired-source-");
		const controlRoot = path.join(temp.path(), "control");
		const thirdRoot = path.join(temp.path(), "third");
		await seed(controlRoot);
		await fs.mkdir(thirdRoot, { recursive: true });
		await Bun.write(path.join(thirdRoot, "index.ts"), "leaked");
		const realControl = await fs.realpath(controlRoot);
		const realThird = await fs.realpath(thirdRoot);
		await Bun.write(
			path.join(realControl, "package.json"),
			JSON.stringify({ name: "oh-my-pi", private: true, workspaces: ["packages/*"] }),
		);
		await Bun.write(
			path.join(realControl, "packages/utils/package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils" }),
		);
		await fs.mkdir(path.join(realControl, "node_modules/@oh-my-pi"), { recursive: true });
		await fs.symlink(realThird, path.join(realControl, "node_modules/@oh-my-pi/pi-utils"));
		await expect(captureQualificationSource(realControl)).rejects.toThrow("outside checkout");
	});
});
