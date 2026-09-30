/**
 * How laya/finetune.py reads the labelled rows, without torch: its row functions are taken out of the script (whose
 * imports need torch and Laya) and run by the python3 on PATH on a rows file; skipped where there is none.
 */

import { spawnSync, SpawnSyncReturns } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const FINETUNE: string = path.resolve(__dirname, "..", "..", "..", "laya", "finetune.py");

/** finetune.py's load_rows (and what it calls) on a rows file, its imports left out: the states of the rows it keeps, as JSON. */
const LOAD_ROWS: string = [
    "import ast, collections, json, os, sys",
    "tree = ast.parse(open(sys.argv[1]).read())",
    "wanted = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('no_state', 'load_rows')]",
    "names = {'collections': collections, 'json': json, 'os': os}",
    "exec(compile(ast.Module(body=wanted, type_ignores=[]), sys.argv[1], 'exec'), names)",
    "print(json.dumps([r['state'] for r in names['load_rows']([sys.argv[2]])]))",
].join("\n");

const python: boolean = spawnSync("python3", ["--version"]).status === 0;

describe("laya/finetune.py's rows", (): void => {
    (python ? it : it.skip)("leaves out a row of a frame with no state, as the player and the teacher writer tell one; a field it does not know is no matter", (): void => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-finetune-"));
        try {
            const row = (state: unknown): string =>
                JSON.stringify({
                    state,
                    criteria: { NOOP: "Keep running", JUMP: "Jump" },
                    instructions: { goal: "g", instructions: "i" },
                    choice: "NOOP",
                    probabilities: { NOOP: 1, JUMP: 0 },
                    seed: 1,
                    // The lag its game was played with, as the distiller marks a lagged game's rows.
                    lag: { minMs: 45, maxMs: 60 },
                });
            const file: string = path.join(root, "rows.jsonl");
            // An engine's decision log from before the player stopped asking about a frame with no state holds some.
            writeFileSync(file, [row({ dx: 1 }), row({ extractorError: "the page could not be read" }), row({ extractorError: "x", dx: 2 }), row({ extractorError: 3 })].join("\n"));
            const run: SpawnSyncReturns<string> = spawnSync("python3", ["-c", LOAD_ROWS, FINETUNE, file], { encoding: "utf-8" });
            expect(run.stderr).toBe("");
            // Kept: a state, one with an extractorError field among others, one whose extractorError is no message.
            expect(JSON.parse(run.stdout)).toEqual([{ dx: 1 }, { extractorError: "x", dx: 2 }, { extractorError: 3 }]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    (python ? it : it.skip)("skips a line that is no row — a row cut short in the middle, or the last one cut inside a character —, saying so once for its file", (): void => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-finetune-"));
        try {
            const row = (state: unknown): string =>
                JSON.stringify({ state, criteria: { NOOP: "Keep running", JUMP: "Jump" }, instructions: { goal: "g", instructions: "i" }, choice: "NOOP", probabilities: { NOOP: 1, JUMP: 0 }, seed: 1 });
            const file: string = path.join(root, "rows.jsonl");
            // The second row cut short, the third after its bytes on its line; the last cut inside a character of four bytes.
            const last: Buffer = Buffer.from(row({ text: "ü€😀" }), "utf-8");
            writeFileSync(
                file,
                Buffer.concat([Buffer.from(`${row({ dx: 1 })}\n${row({ dx: 2 }).slice(0, 30)}${row({ dx: 3 })}\n${row({ text: "ü€😀" })}\n`, "utf-8"), last.subarray(0, last.indexOf(0xf0) + 2)])
            );
            const run: SpawnSyncReturns<string> = spawnSync("python3", ["-c", LOAD_ROWS, FINETUNE, file], { encoding: "utf-8" });
            // It once failed at the first of them, and failed every later fine-tuning of the version.
            expect(run.stderr).toBe("");
            const out: string[] = run.stdout.trim().split("\n");
            expect(out[0]).toMatch(new RegExp(`^skipped 2 lines of ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} that are no row \\(the first: .+\\)$`));
            expect(out).toHaveLength(2);
            expect(JSON.parse(out[1])).toEqual([{ dx: 1 }, { text: "ü€😀" }]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
