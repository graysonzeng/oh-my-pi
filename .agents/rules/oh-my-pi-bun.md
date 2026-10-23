---
description: "Read for Bun/Node I/O, process, streams, APIs, or TS verification."
globs: ["**/*.ts", "**/*.tsx", "bunfig.toml"]
---

# Bun and Node APIs

Use Bun when its API is cleaner; use `node:*` only where Bun has no equivalent. NEVER spawn a shell command for an operation with a proper API, such as directory creation.

| Operation | Use | Avoid |
| --- | --- | --- |
| File read/write | `Bun.file()`, `Bun.write()` | `readFileSync`, `writeFileSync` |
| Spawn process | Bun Shell, `Bun.spawn()` | `child_process` |
| Sleep | `Bun.sleep(ms)` | `setTimeout` promises |
| Binary lookup | `$which("git")` from `@oh-my-pi/pi-utils` | spawning `which` |
| HTTP server | `Bun.serve()` | `http.createServer()` |
| SQLite | `bun:sqlite` | `better-sqlite3` |
| Hashing | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto` |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` conversions |
| JSON5 | `Bun.JSON5.parse()` / `.stringify()` | `json5` package |
| JSONL | `Bun.JSONL.parse()` / `.parseChunk()` | split/map parsing |
| String width | `Bun.stringWidth()` | custom or `get-east-asian-width` |
| ANSI wrapping | `Bun.wrapAnsi()` | custom wrappers |

## Processes

Use Bun Shell for simple commands:

```ts
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Available methods include `.quiet()`, `.nothrow()`, `.text()`, and `.cwd(path)`. Use `Bun.spawn` / `Bun.spawnSync` only for long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or signal/lifecycle control.

Pipe mode requires a stream cast:

```ts
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

## Node Imports

Use namespace imports for `node:fs`, `node:path`, and `node:os`:

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

Async-only file? Use `node:fs/promises`. Sync and async required? Use `node:fs`, then `fs.promises.*` for async calls.

## File I/O

```ts
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // creates parent directories
```

Use `node:fs/promises` for directory operations (`mkdir`, `rm`, `readdir`); Bun has no directory API. AVOID sync APIs in async flows; use them only behind synchronous interfaces.

- NEVER use `existsSync`, `readFileSync`, or `writeFileSync` in async code.
- NEVER create a parent directory before `Bun.write`; it is redundant.
- NEVER check `file.exists()` before reading; that adds a syscall and race. Catch `isEnoent`:

```ts
import { isEnoent } from "@oh-my-pi/pi-utils";

try {
	return await Bun.file(path).json();
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

- Reuse one `Bun.file(path)` handle across checks/loaders.
- Prefer `await fs.readFile(path)` over `Buffer.from(await Bun.file(path).arrayBuffer())`.
- NEVER combine an existence check with try/catch around the same read.

## Streams and Text

Prefer centralized stream helpers:

```ts
import { readStream, readLines } from "./utils/stream";

const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	// ...
}
```

Write manual reader loops only when a protocol requires them, such as SSE or streaming JSON-RPC.

- Passwords: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- Width: `Bun.stringWidth(text, { countAnsiEscapeCodes: false })`.
- Wrapping: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

TypeScript verification MUST use `bun check`; NEVER run `tsc` or `npx tsc`.
