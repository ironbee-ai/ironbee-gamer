#!/usr/bin/env node
/**
 * Bundles src/devtools-plugin/ into dist/devtools-plugin/game-tools.mjs: the
 * game tools as ONE ESM file IronBee DevTools loads with TOOL_PLUGINS. Nothing
 * is left to resolve — DevTools hands the plugin zod at start-up; Playwright
 * comes with the session.
 *
 * Not minified and no keepNames: the page-side scripts (src/devtools-plugin/page/)
 * are handed to Playwright as functions, which sends their source to the page —
 * it must stay self-contained, with no helper esbuild would add around it.
 */

const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "dist/devtools-plugin");

// The plugin ships only as the bundle: the per-module declarations `tsc
// --emitDeclarationOnly` wrote here describe nothing anyone imports.
if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir, { recursive: true })) {
        if (String(entry).endsWith(".d.ts")) {
            fs.rmSync(path.join(outDir, String(entry)));
        }
    }
}

buildSync({
    entryPoints: [path.join(repoRoot, "src/devtools-plugin/index.ts")],
    outfile: path.join(outDir, "game-tools.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: false,
    keepNames: false,
    // Types only: a runtime import left here would resolve against THIS
    // package's node_modules (dev dependencies), not DevTools' copies.
    external: ["playwright-core", "zod"],
    sourcemap: false,
    logLevel: "info",
});
