#!/usr/bin/env node
/**
 * Per-file transpile + minify of `src/` → `dist/` via esbuild.
 *
 * Strategy A (no `--bundle`): every `src/**​/*.ts` is emitted as its own
 * minified `dist/**​/*.js` at the SAME relative path. This preserves the
 * module tree — and therefore the runtime `__dirname` reads keep resolving
 * exactly as they did under `tsc`: the web UI's static files
 * (`dist/server/ui/**`, copied by `scripts/copy-assets.js`) and the game
 * tools' plugin bundle (`dist/devtools-plugin/game-tools.mjs`, built by
 * `scripts/build-devtools-plugin.js`, which `src/devtools/daemon.ts` hands
 * the daemon). `src/devtools-plugin/` is skipped here: it ships only as that
 * bundle. The only change vs `tsc` output is that the JS is minified
 * (comments stripped, whitespace gone, locals mangled).
 *
 * Type-checking and the type declarations (`dist/**​/*.d.ts`, the package's
 * `types`) come from `tsc --emitDeclarationOnly`, run AFTER this script in the
 * `build` script (this one starts from an empty `dist/`) — esbuild only
 * transpiles + minifies, it does not type-check.
 *
 * Cross-platform (fs/path only) so `npm run build` works on every OS, same
 * contract as `scripts/copy-assets.js`.
 */

const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");

const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");

/** Recursively collect every `.ts` source file (excluding `.d.ts`). */
function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // The DevTools plugin is bundled on its own (scripts/build-devtools-plugin.js).
            if (full === path.join(srcRoot, "devtools-plugin")) {
                continue;
            }
            yield* walk(full);
        } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) {
            yield full;
        }
    }
}

// Start from a clean dist so stale tsc artifacts (.d.ts / .js.map / removed
// modules) never linger in the published package.
fs.rmSync(distRoot, { recursive: true, force: true });

const entryPoints = [...walk(srcRoot)];

buildSync({
    entryPoints,
    outdir: distRoot,
    outbase: srcRoot,
    bundle: false,          // per-file — keep the module tree + __dirname semantics
    minify: true,           // strip comments / whitespace, mangle local identifiers
    keepNames: true,        // preserve class/function .name (error classes, constructor.name)
    platform: "node",
    format: "cjs",
    target: "node22",       // matches engines.node >= 22
    // Lower runtime dynamic `import()` to a `require()`-based form. Without
    // --bundle, esbuild otherwise leaves `import()` native, which Node routes
    // through the ESM resolver — and that REQUIRES an explicit `.js` extension,
    // so an extensionless lazy `import("./some/module")` throws
    // ERR_MODULE_NOT_FOUND at runtime. tsc (module:commonjs) downlevels these
    // to require(); we must match that or the lazy-loaded modules break.
    supported: { "dynamic-import": false },
    sourcemap: false,       // do not ship maps — they would re-expose the source
    logLevel: "info",
});
