/**
 * Pulling a game from the shared library into this one: every file downloaded at the index's commit and checked
 * (client.ts) into a folder beside the game's — a pull stopped part way goes on from the files already there —, then
 * put in place as an import does (Library.importGame: validated, renamed into place). The game's decision logs stay
 * (rows this library played, not the shared training). Its own training — versions or checkpoints this library made,
 * not pulled — is replaced only when asked (`replace`).
 */

import { Library } from "../library/store";
import { downloadFile, HfError } from "./client";
import { HfFile, HfGame, HfIndex, HfInstalled, HfSource } from "./types";

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";

/** What this library has of a game the shared library holds. */
export enum LocalState {
    /** Not here at all. */
    MISSING = "missing",
    /** Built in, never trained here: no versions or checkpoints of its own. */
    BUILT_IN = "built-in",
    /** Pulled, and the shared one is still what was pulled. */
    INSTALLED = "installed",
    /** Pulled, and the shared one has changed since. */
    UPDATE = "update",
    /** Trained here (versions or checkpoints not pulled): a pull replaces them. */
    LOCAL = "local",
}

export enum PullPhase {
    DOWNLOADING = "downloading",
    INSTALLING = "installing",
    DONE = "done",
    FAILED = "failed",
}

export interface PullProgress {
    gameId: string;
    phase: PullPhase;
    doneBytes: number;
    totalBytes: number;
    error?: string;
}

/** A pull refused before it began: the game has training of this library's own. */
export class PullConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PullConflictError";
    }
}

/** The name of what a pull writes into a game's folder: where it came from and its files. */
const INSTALLED_FILE: string = "hf.json";
/** A path segment a pull writes: plain names only (no `..`, no separators of its own). */
const PLAIN_NAME: RegExp = /^[A-Za-z0-9._-]+$/;

/** What a pull of this game wrote, when one did. */
export function installedOf(library: Library, id: string): HfInstalled | undefined {
    try {
        return JSON.parse(readFileSync(path.join(library.userDir, id, INSTALLED_FILE), "utf-8")) as HfInstalled;
    } catch {
        return undefined;
    }
}

/** The files of a game's folder that are its training: profile versions and Laya's checkpoints (relative paths). */
function trainingFiles(dir: string, rel: string = ""): string[] {
    const out: string[] = [];
    if (!existsSync(path.join(dir, rel))) {
        return out;
    }
    for (const name of readdirSync(path.join(dir, rel))) {
        const relPath: string = rel ? `${rel}/${name}` : name;
        if (statSync(path.join(dir, relPath)).isDirectory()) {
            out.push(...trainingFiles(dir, relPath));
        } else {
            out.push(relPath);
        }
    }
    return out;
}

/** A game's relative path in its folder, from its path in the repo (`games/<id>/<rel>`); refused when it is not plain. */
function relativeOf(game: HfGame, file: HfFile): string {
    const prefix: string = `games/${game.id}/`;
    const rel: string = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : "";
    if (!rel || !rel.split("/").every((part: string): boolean => PLAIN_NAME.test(part) && part !== "." && part !== "..")) {
        throw new HfError(`the index lists ${file.path} for ${game.id}: not a path of the game's folder`);
    }
    return rel;
}

/** What this library has of a shared game (LocalState). */
export function localState(library: Library, game: HfGame): LocalState {
    if (!library.has(game.id)) {
        return LocalState.MISSING;
    }
    const dir: string = path.join(library.userDir, game.id);
    const own: string[] = ["profiles", "laya"].flatMap((part: string): string[] => trainingFiles(dir, part));
    const installed: HfInstalled | undefined = installedOf(library, game.id);
    if (!installed) {
        return own.length ? LocalState.LOCAL : LocalState.BUILT_IN;
    }
    const pulled: Set<string> = new Set(installed.files.map((f: HfFile): string => relativeOf(game, f)));
    if (own.some((rel: string): boolean => !pulled.has(rel))) {
        return LocalState.LOCAL;
    }
    const key: (f: HfFile) => string = (f: HfFile): string => `${f.path} ${f.sha256}`;
    const now: Set<string> = new Set(game.files.map(key));
    return installed.files.length === game.files.length && installed.files.every((f: HfFile): boolean => now.has(key(f))) ? LocalState.INSTALLED : LocalState.UPDATE;
}

/**
 * Pulls a game of the shared library (its index read at `commit`) into this one. Refused (PullConflictError) when the
 * game has training of this library's own and `replace` is not set.
 */
export async function pullGame(
    library: Library,
    source: HfSource,
    shared: { index: HfIndex; commit: string },
    id: string,
    options: { replace?: boolean; onProgress?: (p: PullProgress) => void; signal?: AbortSignal } = {}
): Promise<HfGame> {
    const game: HfGame | undefined = shared.index.games.find((g: HfGame): boolean => g.id === id);
    if (!game) {
        throw new HfError(`${source.repo} has no game ${id}`);
    }
    if (localState(library, game) === LocalState.LOCAL && !options.replace) {
        throw new PullConflictError(`${id} has training of this library's own (versions or Laya checkpoints not pulled): a pull replaces it — replace to go on`);
    }
    const progress: PullProgress = { gameId: id, phase: PullPhase.DOWNLOADING, doneBytes: 0, totalBytes: game.size };
    const report: () => void = (): void => options.onProgress?.({ ...progress });
    report();
    // Beside the game's folder, on the same volume; kept when a pull stops, for the next one to go on from.
    const staging: string = path.join(library.userDir, `.${id}.hf-pull`);
    const wanted: Set<string> = new Set();
    for (const file of game.files) {
        const rel: string = relativeOf(game, file);
        wanted.add(rel);
        await downloadFile(
            source,
            shared.commit,
            file,
            path.join(staging, rel),
            (n: number): void => {
                progress.doneBytes += n;
                report();
            },
            options.signal
        );
    }
    // A file an earlier pull of another commit left that this one does not list goes.
    for (const rel of trainingFiles(staging)) {
        if (!wanted.has(rel)) {
            rmSync(path.join(staging, rel), { force: true });
        }
    }
    progress.phase = PullPhase.INSTALLING;
    report();
    const installed: HfInstalled = { repo: source.repo, commit: shared.commit, pushedAt: game.pushedAt, files: game.files };
    writeFileSync(path.join(staging, INSTALLED_FILE), JSON.stringify(installed, null, 2));
    // The game's decision logs stay with it: moved aside while the import replaces its folder (the same volume: no copy
    // of what can be gigabytes), then into the new one — back where they were when the import fails.
    const decisions: string = path.join(library.userDir, id, "decisions");
    const aside: string = path.join(library.userDir, `.${id}.decisions`);
    const carry: boolean = existsSync(decisions) && !existsSync(aside);
    if (carry) {
        renameSync(decisions, aside);
    }
    try {
        library.importGame(staging, { replace: true });
    } catch (err: unknown) {
        if (carry && existsSync(aside) && !existsSync(decisions)) {
            renameSync(aside, decisions);
        }
        throw err;
    }
    if (carry && existsSync(aside)) {
        renameSync(aside, decisions);
    }
    rmSync(staging, { recursive: true, force: true });
    progress.phase = PullPhase.DONE;
    report();
    return game;
}

