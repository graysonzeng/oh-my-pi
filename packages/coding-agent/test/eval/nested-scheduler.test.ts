import { describe, expect, test } from "bun:test";
import { NestedToolScheduler } from "@oh-my-pi/pi-coding-agent/eval/js/nested-scheduler";

describe("NestedToolScheduler", () => {
	test("exclusive nested calls serialize even when the caller awaits them together", async () => {
		const scheduler = new NestedToolScheduler();
		const order: string[] = [];
		const exclusive = async (label: string) => {
			order.push(`start:${label}`);
			await Bun.sleep(20);
			order.push(`end:${label}`);
			return label;
		};

		const [first, second] = await Promise.all([
			scheduler.run("exclusive", () => exclusive("a")),
			scheduler.run("exclusive", () => exclusive("b")),
		]);

		expect([first, second].sort()).toEqual(["a", "b"]);
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
	});

	test("a failed exclusive call does not skip a later exclusive call", async () => {
		const scheduler = new NestedToolScheduler();
		const boom = scheduler.run("exclusive", async () => {
			throw new Error("boom");
		});
		const later = scheduler.run("exclusive", async () => "ok");
		await expect(boom).rejects.toThrow("boom");
		await expect(later).resolves.toBe("ok");
	});

	test("shared nested calls wait for the in-flight exclusive call then overlap", async () => {
		const scheduler = new NestedToolScheduler();
		const order: string[] = [];
		const exclusive = scheduler.run("exclusive", async () => {
			order.push("exclusive-start");
			await Bun.sleep(30);
			order.push("exclusive-end");
		});
		const sharedA = scheduler.run("shared", async () => {
			order.push("shared-a");
		});
		const sharedB = scheduler.run("shared", async () => {
			order.push("shared-b");
		});
		await Promise.all([exclusive, sharedA, sharedB]);
		expect(order[0]).toBe("exclusive-start");
		expect(order[1]).toBe("exclusive-end");
		expect(order.slice(2).sort()).toEqual(["shared-a", "shared-b"]);
	});
});
