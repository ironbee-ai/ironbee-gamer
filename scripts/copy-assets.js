#!/usr/bin/env node
/**
 * Copies the web UI's static files (`src/server/ui/**`) to the matching
 * `dist/` path. esbuild only emits `.ts`; the UI is plain HTML/CSS/JS served
 * as-is and read via `__dirname` at runtime. Cross-platform (fs/path only).
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}

const uiSrc = path.join(repoRoot, "src", "server", "ui");
const uiDist = path.join(repoRoot, "dist", "server", "ui");
if (fs.existsSync(uiSrc)) {
    for (const file of walk(uiSrc)) {
        const dest = path.join(uiDist, path.relative(uiSrc, file));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
    }
}
