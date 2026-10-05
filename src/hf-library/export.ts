/**
 * A game as the shared library holds it (types.ts): what plays it, and nothing that names this machine. Its definition
 * (with the active version), every profile version, its windows and samples, its picture, and Laya's checkpoints of the
 * versions its configs play — not every round of every version (~650 MB each), not the decision logs (rows to learn
 * from, hundreds of MB), not this library's state. A path of this machine in a JSON file (a checkpoint's base, a
 * training's work folder) is written as its last part; one left anywhere stops the export.
 */

import { checkpointFor, checkpointProfileVersion, currentCheckpoints } from "../distill/laya-play";
import { LayaCheckpoint } from "../distill/laya-runtime";
import { EngineKind } from "../engine/types";
import { playConfigs } from "../game/configs";
import { GameDefinition, PlayConfig, Profile } from "../game/types";
import { Library } from "../library/store";
import { sha256Of } from "./client";
import { HfFile, HfGame, HfIndex, HfPlay } from "./types";

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

/** A file or folder name the export copies: plain names only (a library checks the same on import). */
const PLAIN_NAME: RegExp = /^[A-Za-z0-9._-]+$/;
/** What of a game's folder goes, besides its definition and Laya's checkpoints. */
const SHARED_PARTS: string[] = ["profiles", "windows", "samples", "thumbnail.png"];
/** A string that is a path of this machine (a home folder, a temporary one, a drive). */
const LOCAL_PATH: RegExp = /^(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)\S*$/;
/** Files read as text for this machine's paths. */
const TEXT_FILE: RegExp = /\.(?:json|jsonl|txt|md)$/i;

/**
 * A JSON value with this machine's paths taken out: a string that is one becomes its last part (a checkpoint's
 * base is found by its name beside it); the home folder inside a longer string becomes `~`.
 */
export function scrubLocalPaths(value: unknown, home: string = homedir()): unknown {
    if (typeof value === "string") {
        if (LOCAL_PATH.test(value)) {
            return path.basename(value);
        }
        return home.length > 1 ? value.split(home).join("~") : value;
    }
    if (Array.isArray(value)) {
        return value.map((v: unknown): unknown => scrubLocalPaths(v, home));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]: [string, unknown]): [string, unknown] => [k, scrubLocalPaths(v, home)]));
    }
    return value;
}

/** Copies a file, a JSON one with this machine's paths taken out (untouched when it names none: a tokenizer keeps its bytes). */
function copyShared(from: string, to: string, home: string): void {
    mkdirSync(path.dirname(to), { recursive: true });
    if (/\.json$/i.test(from)) {
        const text: string = readFileSync(from, "utf-8");
        if (text.includes(home) || /"(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/)/.test(text)) {
            writeFileSync(to, JSON.stringify(scrubLocalPaths(JSON.parse(text), home), null, 2));
            return;
        }
    }
    copyFileSync(from, to);
}

/** Copies a folder's plain-named files and folders (no symbolic links), merging into `to`. */
function copyTree(from: string, to: string, home: string, keep: (rel: string) => boolean = (): boolean => true, rel: string = ""): void {
    for (const name of readdirSync(from)) {
        const src: string = path.join(from, name);
        const relPath: string = rel ? `${rel}/${name}` : name;
        if (!PLAIN_NAME.test(name) || name === ".DS_Store" || lstatSync(src).isSymbolicLink() || !keep(relPath)) {
            continue;
        }
        if (statSync(src).isDirectory()) {
            copyTree(src, path.join(to, name), home, keep, relPath);
        } else {
            copyShared(src, path.join(to, name), home);
        }
    }
}

/** Every file under a folder, its path relative to it with forward slashes. */
export function listFiles(dir: string, rel: string = ""): string[] {
    const out: string[] = [];
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
        const relPath: string = rel ? `${rel}/${name}` : name;
        if (statSync(path.join(dir, relPath)).isDirectory()) {
            out.push(...listFiles(dir, relPath));
        } else {
            out.push(relPath);
        }
    }
    return out;
}

/** A mean as the index lists it: two decimals at most. */
function rounded(mean: number | undefined): number | undefined {
    return mean === undefined || !Number.isFinite(mean) ? undefined : Math.round(mean * 100) / 100;
}

/** What a checkpoint's student played with the lag 45–90 ms when it was distilled (distill.json `lagged`), when it did. */
function laggedMean(checkpoint: LayaCheckpoint): number | undefined {
    try {
        const mean: unknown = (JSON.parse(readFileSync(path.join(checkpoint.dir, "distill.json"), "utf-8")) as { lagged?: { mean?: unknown } }).lagged?.mean;
        return typeof mean === "number" ? mean : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The game's configs (its own, else those its versions earn) and, for each, the version it plays and how it scored:
 * Laya paused its student's mean as distilled, live the same student with the lag when that was played; the others the
 * version's results (live: as measured in real time).
 */
function playsOf(library: Library, game: GameDefinition, checkpoints: LayaCheckpoint[]): { plays: HfPlay[]; laya: LayaCheckpoint[] } {
    const active: number | undefined = library.activeVersion(game.id);
    const configs: PlayConfig[] = game.configs ?? playConfigs(game, library.profiles(game.id));
    const plays: HfPlay[] = [];
    const laya: LayaCheckpoint[] = [];
    for (const c of configs) {
        const live: boolean = Boolean(c.live);
        if (c.engine === EngineKind.LAYA) {
            const checkpoint: LayaCheckpoint | undefined = checkpointFor(checkpoints, c.version, active);
            if (!checkpoint) {
                continue;
            }
            if (!laya.some((k: LayaCheckpoint): boolean => k.name === checkpoint.name)) {
                laya.push(checkpoint);
            }
            const version: number | undefined = checkpointProfileVersion(checkpoint);
            const mean: number | undefined = rounded(live ? laggedMean(checkpoint) : checkpoint.studentMean);
            plays.push({
                engine: c.engine,
                live,
                ...(version !== undefined ? { version } : {}),
                ...(c.lagMs !== undefined ? { lagMs: c.lagMs } : {}),
                checkpoint: checkpoint.name,
                ...(mean !== undefined ? { mean } : {}),
            });
            continue;
        }
        const version: number | undefined = c.version ?? active;
        let profile: Profile | undefined;
        try {
            profile = version !== undefined ? library.profile(game.id, version) : undefined;
        } catch {
            profile = undefined;
        }
        const mean: number | undefined = rounded(live ? profile?.results?.realtime?.mean : profile?.results?.mean);
        plays.push({
            engine: c.engine,
            live,
            ...(version !== undefined ? { version } : {}),
            ...(c.lagMs !== undefined ? { lagMs: c.lagMs } : {}),
            ...(mean !== undefined ? { mean } : {}),
        });
    }
    return { plays, laya };
}

/**
 * Writes a game into `targetDir` as the shared library holds it, and says what is there: every file with its size and
 * sha256 (a pull checks each against them), how its configs play it. Throws, leaving the folder to be removed, when a
 * file still names this machine's home folder.
 */
export async function exportGameForHf(library: Library, id: string, targetDir: string, now: Date = new Date(), home: string = homedir()): Promise<HfGame> {
    const game: GameDefinition = library.game(id);
    mkdirSync(targetDir, { recursive: true });
    // Built-in first, then the user's on top: its files win, as they do when the library reads them.
    for (const root of [library.builtInDir, library.userDir]) {
        const dir: string = path.join(root, id);
        for (const part of SHARED_PARTS) {
            const src: string = path.join(dir, part);
            if (!existsSync(src) || lstatSync(src).isSymbolicLink()) {
                continue;
            }
            if (statSync(src).isDirectory()) {
                copyTree(src, path.join(targetDir, part), home, part === "profiles" ? (rel: string): boolean => /^v\d+\.json$/.test(rel) : undefined);
            } else {
                copyShared(src, path.join(targetDir, part), home);
            }
        }
    }
    const active: number | undefined = library.activeVersion(id);
    // The version that plays here plays there too (this library's state.json stays behind).
    writeFileSync(path.join(targetDir, "game.json"), JSON.stringify(scrubLocalPaths({ ...game, ...(active !== undefined ? { activeVersion: active } : {}) }, home), null, 2));
    const { plays, laya } = playsOf(library, game, currentCheckpoints(library, id));
    for (const checkpoint of laya) {
        copyTree(checkpoint.dir, path.join(targetDir, "laya", checkpoint.name), home);
    }
    const files: HfFile[] = [];
    for (const rel of listFiles(targetDir)) {
        const file: string = path.join(targetDir, rel);
        if (TEXT_FILE.test(rel) && home.length > 1 && readFileSync(file, "utf-8").includes(home)) {
            throw new Error(`${id}/${rel} still names ${home}: not shared`);
        }
        files.push({ path: `games/${id}/${rel}`, size: statSync(file).size, sha256: await sha256Of(file) });
    }
    return {
        id,
        name: game.name,
        url: game.url,
        goal: game.goal,
        scoreLabel: game.score.label,
        ...(active !== undefined ? { activeVersion: active } : {}),
        versions: library.profiles(id).map((p: { version: number }): number => p.version),
        plays,
        files,
        size: files.reduce((n: number, f: HfFile): number => n + f.size, 0),
        pushedAt: now.toISOString(),
    };
}

/** The repo's index with these games put in (each replacing its own entry), the others kept, by id. */
export function mergeIndex(remote: HfIndex | undefined, games: HfGame[], format: number, now: Date = new Date()): HfIndex {
    const byId: Map<string, HfGame> = new Map((remote?.games ?? []).map((g: HfGame): [string, HfGame] => [g.id, g]));
    for (const g of games) {
        byId.set(g.id, g);
    }
    return { format, updatedAt: now.toISOString(), games: [...byId.values()].sort((a: HfGame, b: HfGame): number => a.id.localeCompare(b.id)) };
}

function megabytes(bytes: number): string {
    return `${Math.round(bytes / 1_000_000)} MB`;
}

/** The repo's README (its model card): the games, how each engine plays them, and how a library pulls them. */
export function readmeFor(index: HfIndex, repo: string): string {
    const engines: (g: HfGame) => string = (g: HfGame): string =>
        g.plays
            .map((p: HfPlay): string => `${p.engine}${p.live ? " (live)" : ""}${p.version !== undefined ? ` v${p.version}` : ""}${p.mean !== undefined ? `: ${p.mean}` : ""}`)
            .join("; ");
    return [
        "---",
        "license: other",
        "license_name: elastic-license-2.0",
        "license_link: LICENSE",
        "tags:",
        "  - ironbee-gamer",
        "  - game-playing",
        "  - laya",
        "base_model: jhu-clsp/mmBERT-base",
        "---",
        "",
        "# IronBee Gamer library",
        "",
        "Browser games trained by [IronBee Gamer](https://github.com/ironbee-ai/ironbee-gamer): each game's definition, its",
        "profile versions (the rules the trainer wrote, in words and as code) and Laya's fine-tuned checkpoints of the versions",
        "it plays — a library that pulls a game plays it at once, trained, with Laya (local) or Jev (hosted, your own key).",
        "",
        "| Game | Id | Plays (engine, version: mean) | Size |",
        "|---|---|---|---|",
        ...index.games.map((g: HfGame): string => `| ${g.name} | \`${g.id}\` | ${engines(g)} | ${megabytes(g.size)} |`),
        "",
        "## Use",
        "",
        "In the IronBee Gamer UI: **Hugging Face** above the library, then **Download** beside a game. From the CLI:",
        "",
        "```",
        `ibgamer library pull <game>          # IBGAMER_HF_REPO=${repo} by default`,
        "```",
        "",
        "Every file is checked against its sha256 in `index.json`. A game's profiles hold JavaScript (how its state is read,",
        "its rules as code) that the app runs: pull from repos you trust.",
        "",
        `Layout: \`index.json\` lists every game and file; \`games/<id>/\` holds \`game.json\`, \`profiles/v<N>.json\`,`,
        "`windows/`, `samples/` and `laya/<checkpoint>/` (model.safetensors, tokenizer, the run's settings).",
        "",
        "## License",
        "",
        "[Elastic License 2.0](LICENSE), as IronBee Gamer. Laya's checkpoints are fine-tuned from",
        "[jhu-clsp/mmBERT-base](https://huggingface.co/jhu-clsp/mmBERT-base) (MIT). The games belong to their authors: each",
        "`game.json` names the page it plays.",
        "",
    ].join("\n");
}
