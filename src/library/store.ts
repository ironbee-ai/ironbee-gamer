/**
 * The game library: every game this app knows how to reach, start and
 * measure, with the profiles that play it.
 *
 * Two roots, one view. The BUILT-IN library ships with the package
 * (`library/`) and is never written to. The USER library (`~/.ibgamer/library`
 * by default) holds the games a person added and everything training makes: a
 * trained built-in game gets its new profile versions there, beside the
 * built-in ones, so the shipped versions stay as they were and a person can go
 * back to one.
 *
 *   <root>/<game-id>/game.json          how to reach, start and measure it
 *   <root>/<game-id>/profiles/v<N>.json how to play it, one file per version
 *   <root>/<game-id>/windows/<id>.json  raw frames the regression tests replay
 *   <root>/<game-id>/samples/…          what training looked at (a raw sample, sprite crops)
 *   <root>/<game-id>/thumbnail.png      the library card's picture
 *   <root>/<game-id>/state.json         (user root) the active profile version
 *
 * The user root wins where both have a file: its game.json overrides, a
 * version number it holds shadows the built-in one. New versions are numbered
 * after every version either root holds.
 */

import { validateGame, validateProfile } from "../game/validate";
import { FailureWindow, GAME_ID_PATTERN, GameDefinition, Profile, ProfileResults } from "../game/types";

import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";

export enum GameSource {
    BUILT_IN = "built-in",
    USER = "user",
    /** A built-in game the user library adds to (trained versions, an edited game.json). */
    TRAINED = "built-in + user",
}

export interface GameSummary {
    id: string;
    name: string;
    description?: string;
    url: string;
    tags: string[];
    perception: string;
    scoreLabel: string;
    source: GameSource;
    activeVersion?: number;
    versions: number;
    /** The active profile's measured results. */
    results?: ProfileResults;
    hasThumbnail: boolean;
    /**
     * A local Laya checkpoint is on disk for this game, whatever version it learnt: a play takes only those that learnt
     * their version as it is now (`currentCheckpoints`, which the UI's card and `library games` mark by).
     */
    hasLaya: boolean;
}

export interface ProfileSummary {
    version: number;
    createdAt: string;
    origin: string;
    note?: string;
    parent?: number;
    results?: ProfileResults;
    tests: number;
    /** It carries its rules as code (`teach`): the rules engine can play it, Laya can learn it. */
    hasTeacher: boolean;
    /** Trained for real time: its extractor makes up for the lag (`Profile.lagAware`). */
    lagAware: boolean;
    /** For real time only (`Profile.liveOnly`): never made active; the live clock plays it. */
    liveOnly: boolean;
    source: GameSource;
    active: boolean;
}

/** A file name inside a game's directory: no separators, no dot-dot. */
const SAFE_NAME: RegExp = /^[\w][\w.-]{0,120}$/;
const SAFE_REL_PATH: RegExp = /^([\w][\w.-]{0,120}\/){0,3}[\w][\w.-]{0,120}$/;

export function defaultBuiltInDir(): string {
    return path.resolve(__dirname, "..", "..", "library");
}

function readJson(file: string): unknown {
    return JSON.parse(readFileSync(file, "utf-8"));
}

/** Whether a profile file holds a version kept for real time only (`Profile.liveOnly`); one that cannot be read does not: opening it says why. */
function keptForRealTimeOnly(file: string): boolean {
    try {
        return (readJson(file) as { liveOnly?: unknown }).liveOnly === true;
    } catch {
        return false;
    }
}

/** Writes through a temporary file: a reader never sees half a file. */
function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp: string = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, file);
}

/**
 * Writes a file that must not exist yet, whole: through a temporary file linked to its name, which fails
 * (EEXIST) when another process made it first — never replacing it. A file system without links gets it
 * created exclusively and written in place.
 */
function createJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const text: string = `${JSON.stringify(value, null, 2)}\n`;
    const tmp: string = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    try {
        linkSync(tmp, file);
    } catch (err: unknown) {
        const code: string | undefined = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
            throw err;
        }
        writeFileSync(file, text, { flag: "wx" });
    } finally {
        rmSync(tmp, { force: true });
    }
}

/** How many numbers a save tries while other processes keep taking the next one (four saving without a pause lost 20 in a row). */
const SAVE_ATTEMPTS: number = 200;

function checkId(id: string): void {
    if (!GAME_ID_PATTERN.test(id)) {
        throw new Error(`Not a game id: ${JSON.stringify(id)}`);
    }
}

/** Whether `inner` is `outer` or inside it (both resolved paths). */
function within(inner: string, outer: string): boolean {
    const rel: string = path.relative(outer, inner);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A path with its symbolic links resolved, as far as it exists. */
function realPath(p: string): string {
    const abs: string = path.resolve(p);
    if (existsSync(abs)) {
        return realpathSync(abs);
    }
    const parent: string = path.dirname(abs);
    return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
}

function isLink(p: string): boolean {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

export class GameNotFoundError extends Error {
    constructor(id: string) {
        super(`No game ${id} in the library`);
        this.name = "GameNotFoundError";
    }
}

export class Library {
    constructor(
        readonly builtInDir: string,
        readonly userDir: string
    ) {}

    private roots(): Array<{ dir: string; source: GameSource }> {
        return [
            { dir: this.userDir, source: GameSource.USER },
            { dir: this.builtInDir, source: GameSource.BUILT_IN },
        ];
    }

    /** A game's directories: the user's whenever it has one (a thumbnail, decisions, checkpoints count). */
    private dirsOf(id: string): { user?: string; builtIn?: string } {
        checkId(id);
        const user: string = path.join(this.userDir, id);
        const builtIn: string = path.join(this.builtInDir, id);
        return {
            ...(existsSync(user) ? { user } : {}),
            ...(existsSync(path.join(builtIn, "game.json")) ? { builtIn } : {}),
        };
    }

    /** The user library's directory for a game (created). */
    userDirFor(id: string): string {
        checkId(id);
        const dir: string = path.join(this.userDir, id);
        mkdirSync(dir, { recursive: true });
        return dir;
    }

    has(id: string): boolean {
        if (!GAME_ID_PATTERN.test(id)) {
            return false;
        }
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        return Boolean(dirs.builtIn || (dirs.user && existsSync(path.join(dirs.user, "game.json"))));
    }

    /**
     * Whether the user library holds a folder for the id: a game's, a built-in one's trained part, or
     * what a removed game left (profiles, checkpoints, decisions) — which a new game of that id would take over.
     */
    hasUserPart(id: string): boolean {
        return GAME_ID_PATTERN.test(id) && existsSync(path.join(this.userDir, id));
    }

    sourceOf(id: string): GameSource {
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        const userDefines: boolean = Boolean(dirs.user && (existsSync(path.join(dirs.user, "game.json")) || existsSync(path.join(dirs.user, "profiles"))));
        if (dirs.builtIn && userDefines) {
            return GameSource.TRAINED;
        }
        return dirs.builtIn ? GameSource.BUILT_IN : GameSource.USER;
    }

    game(id: string): GameDefinition {
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        for (const dir of [dirs.user, dirs.builtIn]) {
            if (dir && existsSync(path.join(dir, "game.json"))) {
                const game: GameDefinition = validateGame(readJson(path.join(dir, "game.json")), `${id}/game.json`);
                if (game.id !== id) {
                    throw new Error(`${id}/game.json names the game ${game.id}`);
                }
                return game;
            }
        }
        throw new GameNotFoundError(id);
    }

    /** Every game id, user and built-in, each once. */
    ids(): string[] {
        const ids: Set<string> = new Set();
        for (const root of this.roots()) {
            if (!existsSync(root.dir)) {
                continue;
            }
            for (const entry of readdirSync(root.dir)) {
                if (GAME_ID_PATTERN.test(entry) && this.has(entry)) {
                    ids.add(entry);
                }
            }
        }
        return [...ids].sort();
    }

    list(): GameSummary[] {
        const out: GameSummary[] = [];
        for (const id of this.ids()) {
            try {
                const game: GameDefinition = this.game(id);
                const active: Profile | undefined = this.profile(id);
                out.push({
                    id,
                    name: game.name,
                    ...(game.description ? { description: game.description } : {}),
                    url: game.url,
                    tags: game.tags ?? [],
                    perception: game.perception.adapter,
                    scoreLabel: game.score.label,
                    source: this.sourceOf(id),
                    ...(active ? { activeVersion: active.version } : {}),
                    versions: this.versionFiles(id).size,
                    ...(active?.results ? { results: active.results } : {}),
                    hasThumbnail: this.file(id, "thumbnail.png") !== undefined,
                    hasLaya: this.hasLayaCheckpoint(id),
                });
            } catch {
                // A broken entry is left out of the list; opening it says why.
            }
        }
        return out;
    }

    /** Whether the user library holds a fine-tuned Laya checkpoint for the game. */
    private hasLayaCheckpoint(id: string): boolean {
        const dir: string = path.join(this.userDir, id, "laya");
        return existsSync(dir) && readdirSync(dir).some((name: string): boolean => existsSync(path.join(dir, name, "model.safetensors")));
    }

    /** Version → file, the user root shadowing the built-in one. */
    private versionFiles(id: string): Map<number, { file: string; source: GameSource }> {
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        const out: Map<number, { file: string; source: GameSource }> = new Map();
        const add: (dir: string | undefined, source: GameSource) => void = (dir: string | undefined, source: GameSource): void => {
            const profiles: string | undefined = dir ? path.join(dir, "profiles") : undefined;
            if (!profiles || !existsSync(profiles)) {
                return;
            }
            for (const entry of readdirSync(profiles)) {
                const m: RegExpExecArray | null = /^v(\d+)\.json$/.exec(entry);
                if (m && !out.has(Number(m[1]))) {
                    out.set(Number(m[1]), { file: path.join(profiles, entry), source });
                }
            }
        };
        add(dirs.user, GameSource.USER);
        add(dirs.builtIn, GameSource.BUILT_IN);
        return out;
    }

    /** The active version: the one the user set, else the newest not kept for real time only (else the newest). */
    activeVersion(id: string): number | undefined {
        const newestFirst: Array<[number, { file: string; source: GameSource }]> = [...this.versionFiles(id).entries()].sort(
            (a: [number, unknown], b: [number, unknown]): number => b[0] - a[0],
        );
        if (newestFirst.length === 0) {
            return undefined;
        }
        const stateFile: string = path.join(this.userDir, id, "state.json");
        if (existsSync(stateFile)) {
            try {
                const active: unknown = (readJson(stateFile) as { active?: unknown }).active;
                if (typeof active === "number" && newestFirst.some(([version]: [number, unknown]): boolean => version === active)) {
                    return active;
                }
            } catch {
                // an unreadable state file: as if none were set
            }
        }
        // A training saves a version for real time only without making it active: with none set (a fresh library,
        // a built-in game), being the newest must not make it active all the same.
        const playable: [number, unknown] | undefined = newestFirst.find(([, entry]: [number, { file: string }]): boolean => !keptForRealTimeOnly(entry.file));
        return (playable ?? newestFirst[0])[0];
    }

    setActive(id: string, version: number): void {
        if (!this.versionFiles(id).has(version)) {
            throw new Error(`${id} has no profile v${version}`);
        }
        writeJson(path.join(this.userDirFor(id), "state.json"), { active: version });
    }

    /** A profile version (the active one when none is named); undefined when the game has none. */
    profile(id: string, version?: number): Profile | undefined {
        const files: Map<number, { file: string; source: GameSource }> = this.versionFiles(id);
        const wanted: number | undefined = version ?? this.activeVersion(id);
        if (wanted === undefined) {
            return undefined;
        }
        const entry: { file: string; source: GameSource } | undefined = files.get(wanted);
        if (!entry) {
            throw new Error(`${id} has no profile v${wanted}`);
        }
        const profile: Profile = validateProfile(readJson(entry.file), `${id} profile v${wanted}`);
        return { ...profile, version: wanted };
    }

    profiles(id: string): ProfileSummary[] {
        const active: number | undefined = this.activeVersion(id);
        return [...this.versionFiles(id).entries()]
            .sort((a: [number, unknown], b: [number, unknown]): number => b[0] - a[0])
            .map(([version, entry]: [number, { file: string; source: GameSource }]): ProfileSummary => {
                const p: Profile = validateProfile(readJson(entry.file), `${id} profile v${version}`);
                return {
                    version,
                    createdAt: p.createdAt,
                    origin: p.origin,
                    ...(p.note ? { note: p.note } : {}),
                    ...(p.parent !== undefined ? { parent: p.parent } : {}),
                    ...(p.results ? { results: p.results } : {}),
                    tests: p.tests.length,
                    hasTeacher: Boolean(p.teacher),
                    lagAware: p.lagAware === true,
                    liveOnly: p.liveOnly === true,
                    source: entry.source,
                    active: version === active,
                };
            });
    }

    /**
     * Saves a new version in the user library, numbered after every existing one, and makes it active. Two
     * processes saving at once (a CLI training beside the UI's) each get a number of their own: the file is
     * created, never replaced, and a number taken meanwhile is counted again.
     */
    saveProfile(id: string, profile: Omit<Profile, "version">, options: { activate?: boolean } = {}): Profile {
        if (!this.has(id)) {
            throw new GameNotFoundError(id);
        }
        for (let attempt: number = 1; ; attempt++) {
            const versions: number[] = [...this.versionFiles(id).keys()];
            const version: number = versions.length ? Math.max(...versions) + 1 : 1;
            const saved: Profile = validateProfile({ ...profile, version }, `${id} profile v${version}`);
            try {
                createJson(path.join(this.userDirFor(id), "profiles", `v${version}.json`), saved);
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt < SAVE_ATTEMPTS) {
                    continue;
                }
                throw err;
            }
            if (options.activate !== false) {
                this.setActive(id, version);
            }
            return saved;
        }
    }

    /** Records how a version scored (the user library's copy of it). */
    saveResults(id: string, version: number, results: ProfileResults): void {
        const profile: Profile | undefined = this.profile(id, version);
        if (!profile) {
            return;
        }
        writeJson(path.join(this.userDirFor(id), "profiles", `v${version}.json`), { ...profile, results });
    }

    saveWindow(id: string, window: FailureWindow): void {
        if (!SAFE_NAME.test(window.id)) {
            throw new Error(`Not a window id: ${window.id}`);
        }
        writeJson(path.join(this.userDirFor(id), "windows", `${window.id}.json`), window);
    }

    window(id: string, windowId: string): FailureWindow | undefined {
        if (!SAFE_NAME.test(windowId)) {
            return undefined;
        }
        const file: string | undefined = this.file(id, `windows/${windowId}.json`);
        return file ? (readJson(file) as FailureWindow) : undefined;
    }

    /** A file of the game's (user root first), by its path inside the game's directory; never one a link takes out of it. */
    file(id: string, relPath: string): string | undefined {
        if (!SAFE_REL_PATH.test(relPath)) {
            return undefined;
        }
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        for (const dir of [dirs.user, dirs.builtIn]) {
            const file: string | undefined = dir ? path.join(dir, relPath) : undefined;
            if (dir && file && existsSync(file) && statSync(file).isFile() && within(realPath(file), realPath(dir))) {
                return file;
            }
        }
        return undefined;
    }

    /** Saves a game definition in the user library (a new game, or an edit of a built-in one's). */
    saveGame(game: GameDefinition): GameDefinition {
        const checked: GameDefinition = validateGame(game);
        writeJson(path.join(this.userDirFor(checked.id), "game.json"), checked);
        return checked;
    }

    writeFile(id: string, relPath: string, data: string | Buffer): string {
        if (!SAFE_REL_PATH.test(relPath)) {
            throw new Error(`Not a file name: ${relPath}`);
        }
        const file: string = path.join(this.userDirFor(id), relPath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, data);
        return file;
    }

    /**
     * Removes the user library's part of a game: a game the user added goes
     * entirely; a built-in one loses its trained versions and edits.
     */
    removeUserPart(id: string): void {
        checkId(id);
        rmSync(path.join(this.userDir, id), { recursive: true, force: true });
    }

    /**
     * Copies a game directory (game.json, profiles/, windows/, …) into the user library: into a folder
     * beside the game's first, renamed into place once copied, so a copy that fails leaves the library as
     * it was. Symbolic links are not copied (what one points at is not the game's). The game's own folder
     * in the user library — or one holding it or inside it — is refused: replacing it would delete the source.
     */
    importGame(sourceDir: string, options: { replace?: boolean } = {}): GameDefinition {
        const source: string = realPath(sourceDir);
        if (isLink(path.join(source, "game.json"))) {
            throw new Error(`${sourceDir}/game.json is a symbolic link: import a folder that holds the file itself`);
        }
        const game: GameDefinition = validateGame(readJson(path.join(source, "game.json")), `${sourceDir}/game.json`);
        const profiles: string = path.join(source, "profiles");
        if (existsSync(profiles) && !isLink(profiles)) {
            for (const entry of readdirSync(profiles)) {
                if (/^v\d+\.json$/.test(entry) && !isLink(path.join(profiles, entry))) {
                    validateProfile(readJson(path.join(profiles, entry)), `${sourceDir}/profiles/${entry}`);
                }
            }
        }
        const target: string = path.join(this.userDir, game.id);
        if (existsSync(target) && !options.replace) {
            throw new Error(`The user library already has ${game.id}; replace it to import again`);
        }
        const into: string = realPath(target);
        if (within(source, into) || within(into, source)) {
            throw new Error(`${sourceDir} is ${game.id}'s own folder in the user library, or holds it or lies inside it: import a copy kept elsewhere`);
        }
        mkdirSync(this.userDir, { recursive: true });
        const staging: string = path.join(this.userDir, `.${game.id}.${process.pid}.import`);
        const previous: string = `${staging}-previous`;
        rmSync(staging, { recursive: true, force: true });
        rmSync(previous, { recursive: true, force: true });
        try {
            cpSync(source, staging, {
                recursive: true,
                filter: (src: string): boolean => {
                    const rel: string = path.relative(source, src);
                    return rel === "" || (!isLink(src) && rel.split(path.sep).every((part: string): boolean => SAFE_NAME.test(part)));
                },
            });
            if (existsSync(target)) {
                renameSync(target, previous);
            }
            renameSync(staging, target);
        } catch (err: unknown) {
            if (!existsSync(target) && existsSync(previous)) {
                renameSync(previous, target);
            }
            rmSync(staging, { recursive: true, force: true });
            throw err;
        }
        rmSync(previous, { recursive: true, force: true });
        return game;
    }

    /** Writes one self-contained directory for a game: its game.json, every profile version, windows and files. */
    exportGame(id: string, targetDir: string): void {
        const dirs: { user?: string; builtIn?: string } = this.dirsOf(id);
        if (!dirs.user && !dirs.builtIn) {
            throw new GameNotFoundError(id);
        }
        mkdirSync(targetDir, { recursive: true });
        // Built-in first, then the user root on top: its files win, as they do when reading.
        for (const dir of [dirs.builtIn, dirs.user]) {
            if (dir) {
                cpSync(dir, targetDir, {
                    recursive: true,
                    filter: (src: string): boolean => path.basename(src) !== "state.json",
                });
            }
        }
        writeJson(path.join(targetDir, "game.json"), this.game(id));
    }
}
