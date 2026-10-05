/**
 * Pushing games into the shared library with the Hugging Face CLI (`hf upload`, logged in with `hf auth login`): each
 * game exported (export.ts) and uploaded in a commit of its own that also removes what its folder no longer holds (a
 * checkpoint replaced); then the repo's index read, these games put in it (the others kept) and uploaded with the
 * README, last — a reader never finds the index naming files not there yet. A repo that is not there is made, private
 * unless asked otherwise.
 */

import { Library } from "../library/store";
import { fetchIndex } from "./client";
import { exportGameForHf, mergeIndex, readmeFor } from "./export";
import { HF_LIBRARY_FORMAT, HfGame, HfIndex, HfSource } from "./types";

import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export interface PushOptions {
    /** Where the repo is read from (its index) — and its id is the one uploaded to. */
    source: HfSource;
    /** The Hugging Face CLI (IBGAMER_HF_CLI, else `hf`). */
    cli: string;
    /** A repo made public when it is not there yet (default: private; an existing repo keeps its visibility). */
    makePublic?: boolean;
    /** Each line of what is done, and of the CLI's output. */
    log: (line: string) => void;
}

/** Runs the Hugging Face CLI, its output line by line into `log`; rejects with its last lines when it fails. */
function runCli(cli: string, args: string[], log: (line: string) => void): Promise<void> {
    return new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
        const child: ReturnType<typeof spawn> = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
        const tail: string[] = [];
        const take: (chunk: Buffer) => void = (chunk: Buffer): void => {
            for (const line of chunk.toString("utf-8").split(/\r?\n|\r/)) {
                if (line.trim()) {
                    log(`  ${line}`);
                    tail.push(line);
                    tail.splice(0, Math.max(0, tail.length - 5));
                }
            }
        };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        child.on("error", (err: Error): void => reject(new Error(`${cli} could not start (${err.message}): install the Hugging Face CLI (pip install -U huggingface_hub) and log in (hf auth login)`)));
        child.on("close", (code: number | null): void => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${cli} ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${tail.join(" | ")}`));
            }
        });
    });
}

/**
 * Pushes these games into the shared library, one at a time (exported, uploaded, its folder removed: a game's
 * checkpoints are ~650 MB each); resolves with the index the repo now holds.
 */
export async function pushGames(library: Library, ids: string[], options: PushOptions): Promise<HfIndex> {
    const { source, cli, log } = options;
    const repo: string = source.repo;
    const visibility: string = options.makePublic ? "--no-private" : "--private";
    const staging: string = mkdtempSync(path.join(tmpdir(), "ibgamer-hf-"));
    try {
        const games: HfGame[] = [];
        for (const id of ids) {
            log(`${id}: exporting`);
            const folder: string = path.join(staging, "games", id);
            const game: HfGame = await exportGameForHf(library, id, folder);
            const plays: string = game.plays.map((p: { engine: string; live: boolean; version?: number }): string => `${p.engine}${p.live ? " live" : ""}${p.version !== undefined ? ` v${p.version}` : ""}`).join(", ");
            log(`${id}: ${game.files.length} files, ${Math.round(game.size / 1_000_000)} MB (${plays}) — uploading to ${repo}`);
            // `--delete *` against the game's folder: what it held before and does not now goes, in the same commit.
            await runCli(
                cli,
                ["upload", repo, folder, `games/${id}`, "--repo-type", "model", visibility, "--delete", "*", "--commit-message", `${id}: ${game.files.length} files`],
                log
            );
            rmSync(folder, { recursive: true, force: true });
            games.push(game);
        }
        const remote: { index: HfIndex; commit: string } | undefined = await fetchIndex(source);
        const index: HfIndex = mergeIndex(remote?.index, games, HF_LIBRARY_FORMAT);
        writeFileSync(path.join(staging, "index.json"), JSON.stringify(index, null, 2));
        writeFileSync(path.join(staging, "README.md"), readmeFor(index, repo));
        log(`index: uploading to ${repo}`);
        await runCli(
            cli,
            ["upload", repo, staging, ".", "--repo-type", "model", visibility, "--include", "index.json", "--include", "README.md", "--commit-message", `index: ${ids.join(", ")}`],
            log
        );
        return index;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
