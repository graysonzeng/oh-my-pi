/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
import { isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";

export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					// Use the real tool as Reflect receiver so private-field getters on class
					// tools keep a valid brand (Proxy-as-receiver throws TypeError).
					const value = Reflect.get(tool, key, tool);
					if (typeof value !== "function") return value;
					// Callable schemas must retain their schema surface; bind only genuine methods.
					if (isArkSchema(value) || typeof value.bind !== "function") return value;
					return value.bind(tool);
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
