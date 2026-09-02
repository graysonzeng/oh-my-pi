import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import { invalidateCodeIntelPath } from "./code-intel-index";

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCache(path);
	invalidateCodeIntelPath(path);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCache(path);
	invalidateCodeIntelPath(path);
}

/**
 * Invalidate shared filesystem scan caches after a rename/move.
 *
 * Some watchers care about the disappearance at the old path; others about the
 * appearance at the new one. Bust both to keep callers honest.
 */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCache(oldPath);
	invalidateCodeIntelPath(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCache(newPath);
		invalidateCodeIntelPath(newPath);
	}
}
