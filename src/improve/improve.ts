/**
 * Train's check and fix (the UI's Train, `ibgamer train`): the app makes a game play better with an engine on a clock —
 * the one thing the person asks for, with, if they have one, an idea of their own (notes for the trainer). It checks how
 * the game plays (check.ts) and fixes what the check says is wrong:
 *   - Laya playing worse than its rules: Laya taught more on that clock (DAgger; for the running clock, live games);
 *   - Jev playing worse: its instructions trained, Jev deciding (the version kept is Jev's: not made active, Jev's
 *     config plays it);
 *   - the rules playing worse than their record: the version trained on that clock (real time for the running one),
 *     then, for Laya, Laya distilled for the new version;
 *   - nothing playing worse: the version trained for a higher score, as the rules lose above.
 * Notes from the person always train the version with them. Then it checks again: a fix that does not play better is
 * undone — Laya's checkpoint before it comes back, the active version is the one before. One that does is what that
 * engine and clock play from then on (the game's configs). With nothing to check yet (nothingToCheck: no version, Laya
 * with no model of the version it plays, a clock the game is not played on yet) a training starts there instead
 * (src/train/train-for.ts). Nothing here knows a game.
 */

import { DistillOptions, DistillResult } from "../distill/distiller";
import { checkpointFor, currentCheckpoints } from "../distill/laya-play";
import { LayaCheckpoint, refuseLayaServer } from "../distill/laya-runtime";
import { GameBrowser } from "../devtools/client";
import { DecisionEngine, EngineKind } from "../engine";
import { LIVE_LATENCY, liveFloorMs, offeredConfig, playConfigs } from "../game/configs";
import { GameDefinition, PlayConfig, Profile } from "../game/types";
import { Library, ProfileSummary } from "../library/store";
import { TickEvent } from "../play/player";
import { profileHash } from "../run/decision-log";
import { layaToTeach } from "../train/train-for";
import { Decider, TrainHooks, TrainOptions, TrainResult } from "../train/trainer";
import { CheckGame, checkPlay, CheckReport, LIVE_GAMES_PER_SEED, Verdict } from "./check";

import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import path from "path";

/** A training's iterations when none is asked for: the rules on the running clock get more, Jev (deciding every move) fewer. */
const TRAIN_ITERATIONS: { paused: number; live: number; jev: number } = { paused: 3, live: 4, jev: 2 };
/** DAgger rounds Laya is taught more with, and its games a round (live ones are played one at a time). */
const LAYA_ROUNDS: number = 2;
const LAYA_STUDENT_GAMES: { paused: number; live: number } = { paused: 8, live: 6 };
/** How much higher the mean must be for a fix to play better where no fewer seeds play below their reference (playsBetter). */
const MEAN_RISES: number = 1.01;

export enum ImproveOutcome {
    IMPROVED = "improved",
    /** The fix did not play better (undone), or the training kept no version. */
    NOT_IMPROVED = "not improved",
    STOPPED = "stopped",
}

/** The engine of a kind for a version — Laya: that version's checkpoint served — and the version it plays. */
export interface ImproveEngines {
    engineFor(kind: EngineKind, version: number | undefined): Promise<{ engine: DecisionEngine; profileVersion: number }>;
    /** Stops what engineFor started (a Laya server): a distillation serves its student on the same port. */
    release(): Promise<void>;
}

export interface ImproveDeps {
    library: Library;
    openBrowser: () => GameBrowser;
    engines: ImproveEngines;
    train(options: TrainOptions): Promise<TrainResult>;
    distill(options: DistillOptions): Promise<DistillResult>;
    /** What a distillation needs that is not a fix's: the port, the base checkpoint, the teacher's rows, … */
    distillDefaults: Omit<DistillOptions, "gameId" | "profileVersion" | "rounds" | "studentGames" | "resume" | "lag" | "live" | "workDir" | "signal" | "hooks">;
}

export interface ImproveHooks {
    onLog?(line: string): void;
    onPhase?(detail: string): void;
    onGame?(side: string, game: CheckGame): void;
    /** A check begins: how many games it plays. */
    onCheckStart?(when: "before" | "after", games: number): void;
    /** Each tick of every game a check plays (the UI's live view). */
    onTick?(event: TickEvent): void;
    onCheck?(when: "before" | "after", report: CheckReport): void;
    train?: TrainHooks;
    distill?: DistillOptions["hooks"];
}

export interface ImproveOptions {
    gameId: string;
    engine: EngineKind;
    live: boolean;
    /** The person's own idea, told to the trainer: the version is trained with it whatever the check finds. */
    note?: string;
    /** The version to check when no config pins one for that engine and clock: the one the person plays. */
    version?: number;
    /** A training's iterations (default: TRAIN_ITERATIONS, by the clock — Jev's its own). */
    iterations?: number;
    gamesPerSeed?: number;
    workDir: string;
    signal?: AbortSignal;
    hooks?: ImproveHooks;
}

export interface ImproveResult {
    outcome: ImproveOutcome;
    before: CheckReport;
    after?: CheckReport;
    /** What was done, in words, in order. */
    done: string[];
    /** The version that engine and clock play now. */
    version: number;
}

/** Laya taught more: the checkpoint it came to, the one before it (kept aside as `backup`), and what its rounds' folders start with. */
interface Lessons {
    checkpoint?: string;
    previous?: string;
    backup?: string;
    /** `v<N>-<hash>-r`: every round folder of the version starts with it. */
    rounds: string;
}

function meanOf(report: CheckReport): number {
    const means: number[] = Object.values(report.played.means);
    return means.length ? means.reduce((a: number, b: number): number => a + b, 0) / means.length : 0;
}

/**
 * Whether `after` plays better than `before`. The same version (Laya taught more) is held to the same rules: fewer seeds
 * below their reference with the mean no lower, or as few and the mean higher by more than MEAN_RISES. A new version is
 * held to its own, fresh record — its rules can no longer be below it —, so its engine must play better outright.
 */
export function playsBetter(before: CheckReport, after: CheckReport): boolean {
    if (after.stopped) {
        return false;
    }
    const was: number = meanOf(before);
    const now: number = meanOf(after);
    if (after.version === before.version && after.worseSeeds.length < before.worseSeeds.length) {
        return now >= was;
    }
    return (after.version !== before.version || after.worseSeeds.length <= before.worseSeeds.length) && now > was * MEAN_RISES;
}

/**
 * Why there is nothing to check yet with an engine on a clock, in words — a training starts there instead
 * (src/train/train-for.ts) —, or nothing when there is: a version that clock plays, the engine able to play it. Nothing
 * yet: no version trained; the game not played with that engine on that clock (live: a first training for real time);
 * Laya with no model of the version it is to play; the rules, in a version without them as code. `version`: the one
 * asked for where no config pins one (the rules, Jev).
 */
export function nothingToCheck(library: Library, game: GameDefinition, engine: EngineKind, live: boolean, version?: number): string | undefined {
    const profiles: ProfileSummary[] = library.profiles(game.id);
    if (!profiles.length) {
        return "no version trained yet";
    }
    const config: PlayConfig | undefined = offeredConfig(playConfigs(game, profiles), engine, live);
    if (!config) {
        return `not played with ${engine} with the clock ${live ? "running" : "paused"} yet`;
    }
    if (engine === EngineKind.LAYA) {
        const unlearnt: number | undefined = layaToTeach(library, game, live);
        return unlearnt !== undefined ? `Laya has no model of v${unlearnt} yet` : undefined;
    }
    const asked: number | undefined = config.version ?? version;
    const profile: Profile | undefined = library.profile(game.id, asked);
    if (!profile) {
        throw new Error(`${game.name} has no profile v${asked}`);
    }
    return engine === EngineKind.RULES && !profile.teacher ? `v${profile.version} has no rules as code yet` : undefined;
}

/** Copies a directory, its files cloned where the disk can (APFS: no space, at once) — a checkpoint is ~650 MB. */
function cloneDir(from: string, to: string): void {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
        const source: string = path.join(from, entry);
        const target: string = path.join(to, entry);
        if (statSync(source).isDirectory()) {
            cloneDir(source, target);
        } else {
            copyFileSync(source, target, constants.COPYFILE_FICLONE);
        }
    }
}

/** A directory moved, from another volume too (a rename there fails: EXDEV): copied, then the source removed. */
function moveDir(from: string, to: string): void {
    try {
        renameSync(from, to);
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
            throw err;
        }
        cloneDir(from, to);
        rmSync(from, { recursive: true, force: true });
    }
}

/** A clock's config as it holds for a version: one pinned to another version is not this one's (its lag floor is not). */
function configFor(config: PlayConfig | undefined, version: number): PlayConfig | undefined {
    return config && (config.version === undefined || config.version === version) ? config : undefined;
}

export class Improver {
    constructor(private readonly deps: ImproveDeps) {}

    private log(options: ImproveOptions, line: string): void {
        options.hooks?.onLog?.(line);
    }

    private phase(options: ImproveOptions, detail: string): void {
        options.hooks?.onPhase?.(detail);
        this.log(options, `— ${detail}`);
    }

    /** As that engine and clock play the game: its config's version (none: Laya's checkpoint's, else the active one) and lag floor. */
    private played(game: GameDefinition, kind: EngineKind, live: boolean): PlayConfig | undefined {
        return offeredConfig(playConfigs(game, this.deps.library.profiles(game.id)), kind, live);
    }

    private async check(options: ImproveOptions, game: GameDefinition, version: number | undefined, when: "before" | "after"): Promise<CheckReport> {
        this.phase(options, `checking how ${game.name} plays${when === "after" ? " now" : ""}: ${options.engine}, the clock ${options.live ? "running" : "paused"}`);
        const { engine, profileVersion }: { engine: DecisionEngine; profileVersion: number } = await this.deps.engines.engineFor(options.engine, version);
        const profile: Profile = this.deps.library.profile(game.id, profileVersion) as Profile;
        const config: PlayConfig | undefined = this.played(game, options.engine, options.live);
        const minLagMs: number | undefined = options.live ? liveFloorMs(profile, configFor(config, profileVersion)) : undefined;
        const report: CheckReport = await checkPlay(this.deps.openBrowser, this.deps.library, {
            game,
            profile,
            engine,
            live: options.live,
            ...(minLagMs !== undefined ? { minLagMs } : {}),
            ...(options.gamesPerSeed !== undefined ? { gamesPerSeed: options.gamesPerSeed } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            onStart: (games: number): void => options.hooks?.onCheckStart?.(when, games),
            onGame: (side: string, g: CheckGame): void => options.hooks?.onGame?.(side, g),
            ...(options.hooks?.onTick ? { onTick: options.hooks.onTick } : {}),
        });
        this.log(options, `${report.verdict === Verdict.NOTHING ? "nothing played worse" : `to fix: ${report.verdict === Verdict.RULES ? "the rules" : engine.label}`} — ${report.why}`);
        options.hooks?.onCheck?.(when, report);
        return report;
    }

    async improve(options: ImproveOptions): Promise<ImproveResult> {
        const library: Library = this.deps.library;
        const game: GameDefinition = library.game(options.gameId);
        if (options.live && options.engine === EngineKind.JEV) {
            throw new Error("Jev is not played with the clock running: a decision takes it ~275 ms");
        }
        if (options.engine === EngineKind.LAYA) {
            // A fix teaches Laya on the port Laya plays on: a server another process holds there would refuse that only
            // after the whole check — refused now.
            await this.deps.engines.release();
            await refuseLayaServer(this.deps.distillDefaults.port, "a training teaches Laya on that port");
        }
        const done: string[] = [];
        const asked: number | undefined = this.played(game, options.engine, options.live)?.version ?? options.version;
        const before: CheckReport = await this.check(options, game, asked, "before");
        const version: number = before.version;
        if (before.stopped) {
            return { outcome: ImproveOutcome.STOPPED, before, done, version };
        }
        const note: string | undefined = options.note?.trim() || undefined;
        const activeBefore: number | undefined = library.activeVersion(game.id);
        await this.deps.engines.release();

        // The fix: the person's notes train the version; else what the check found — nothing playing worse, the version
        // trained for a higher score. One that fails or is stopped part way is undone as one that plays no better is (a
        // stopped distillation throws).
        let played: number = version;
        let lessons: Lessons | undefined;
        let trained: number | undefined;
        try {
            if (!note && before.verdict === Verdict.ENGINE && options.engine === EngineKind.LAYA) {
                lessons = this.keepAside(options, game, version);
                await this.teachLaya(options, game, version, lessons, done);
            } else {
                // The rules lose, nothing does (a higher score is what is left), the notes ask for a change, or Jev / the
                // rules themselves are what plays: the version trained on that clock, and Laya distilled for the version kept.
                trained = await this.trainVersion(options, game, version, note, before.verdict, done);
                if (options.signal?.aborted) {
                    // Stopped: nothing more is started.
                } else if (trained !== undefined) {
                    played = trained;
                    if (options.engine === EngineKind.LAYA) {
                        await this.distillFor(options, game, trained, done);
                    }
                } else if (options.engine === EngineKind.LAYA && before.engineWorse.some((s: number): boolean => !before.rulesWorse.includes(s))) {
                    // No version played better, yet Laya plays below its rules where they hold: Laya taught more there.
                    lessons = this.keepAside(options, game, version);
                    await this.teachLaya(options, game, version, lessons, done);
                }
            }
        } catch (err: unknown) {
            this.undo(library, game, lessons, activeBefore, trained, done);
            throw err;
        }
        if (options.signal?.aborted) {
            this.undo(library, game, lessons, activeBefore, trained, done);
            return { outcome: ImproveOutcome.STOPPED, before, done, version };
        }
        if (!lessons && trained === undefined) {
            // Training kept no version: nothing new to play.
            return { outcome: ImproveOutcome.NOT_IMPROVED, before, done, version };
        }
        if (lessons && trained === undefined && lessons.checkpoint === lessons.previous) {
            // The distillation kept the checkpoint before it (the new one played no better paused): nothing new to check.
            done.push("Laya taught more, but the checkpoint before it played better: it stays");
            this.dropBackup(lessons);
            return { outcome: ImproveOutcome.NOT_IMPROVED, before, done, version };
        }

        let after: CheckReport;
        try {
            after = await this.check(options, game, played, "after");
        } catch (err: unknown) {
            // A check that failed (a Laya server that would not start on the new checkpoint) says nothing better: undone.
            await this.deps.engines.release().catch((): undefined => undefined);
            this.undo(library, game, lessons, activeBefore, trained, done);
            throw err;
        }
        if (playsBetter(before, after)) {
            if (trained !== undefined) {
                this.pin(game, options.engine, options.live, trained, done);
            }
            await this.deps.engines.release();
            this.dropBackup(lessons);
            return { outcome: ImproveOutcome.IMPROVED, before, after, done, version: played };
        }
        await this.deps.engines.release();
        this.undo(library, game, lessons, activeBefore, trained, done);
        return { outcome: after.stopped ? ImproveOutcome.STOPPED : ImproveOutcome.NOT_IMPROVED, before, after, done, version };
    }

    /** Laya's checkpoint for the version kept aside before Laya is taught more: what an undo brings back. */
    private keepAside(options: ImproveOptions, game: GameDefinition, version: number): Lessons {
        const library: Library = this.deps.library;
        const profile: Profile = library.profile(game.id, version) as Profile;
        const previous: LayaCheckpoint | undefined = checkpointFor(currentCheckpoints(library, game.id), version, library.activeVersion(game.id));
        const lessons: Lessons = { rounds: `v${version}-${profileHash(profile)}-r` };
        if (previous) {
            lessons.previous = previous.dir;
            lessons.backup = path.join(options.workDir, "laya-before", path.basename(previous.dir));
            cloneDir(previous.dir, lessons.backup);
        }
        return lessons;
    }

    /** Laya taught more on the clock asked, from its checkpoint for the version (kept aside: `lessons`). */
    private async teachLaya(options: ImproveOptions, game: GameDefinition, version: number, lessons: Lessons, done: string[]): Promise<void> {
        const library: Library = this.deps.library;
        const profile: Profile = library.profile(game.id, version) as Profile;
        const minLagMs: number = liveFloorMs(profile, configFor(this.played(game, EngineKind.LAYA, true), version)) ?? 0;
        this.phase(options, `teaching Laya more${options.live ? " live" : ""}: ${LAYA_ROUNDS} rounds where it plays and its rules say what they would do`);
        const result: DistillResult = await this.deps.distill({
            ...this.deps.distillDefaults,
            gameId: game.id,
            profileVersion: version,
            resume: lessons.previous !== undefined,
            rounds: LAYA_ROUNDS,
            studentGames: options.live ? LAYA_STUDENT_GAMES.live : LAYA_STUDENT_GAMES.paused,
            ...(options.live ? { live: { minLagMs } } : {}),
            ...(!lessons.previous && profile.lagAware ? { lag: LIVE_LATENCY } : {}),
            workDir: path.join(options.workDir, "distill"),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.hooks?.distill ? { hooks: options.hooks.distill } : {}),
        });
        lessons.checkpoint = result.checkpoint;
        done.push(`Laya taught more ${options.live ? "live" : "with the clock paused"} (${LAYA_ROUNDS} rounds): ${path.basename(result.checkpoint)}`);
    }

    /**
     * The version trained on the clock asked, from the version played: Jev deciding for Jev (the version kept is not made
     * active), else the rules deciding. The version kept, if any.
     */
    private async trainVersion(options: ImproveOptions, game: GameDefinition, version: number, note: string | undefined, verdict: Verdict, done: string[]): Promise<number | undefined> {
        const jev: boolean = options.engine === EngineKind.JEV;
        const iterations: number = options.iterations ?? (jev ? TRAIN_ITERATIONS.jev : options.live ? TRAIN_ITERATIONS.live : TRAIN_ITERATIONS.paused);
        const why: string = note
            ? ", told the notes"
            : verdict === Verdict.RULES
                ? ": the rules lose"
                : verdict === Verdict.NOTHING
                    ? ": nothing plays worse, for a higher score"
                    : `: ${options.engine} loses`;
        this.phase(options, `training ${game.name} v${version}${jev ? " with Jev deciding" : " with its rules deciding"}${options.live ? " for real time" : ""}${why} (${iterations} iterations)`);
        const result: TrainResult = await this.deps.train({
            gameId: game.id,
            decider: jev ? Decider.ENGINE : Decider.RULES,
            iterations,
            fromVersion: version,
            // A version for Jev alone is Jev's: the active one stays the others'.
            ...(jev ? { activate: false } : {}),
            // The running clock trained live, as it is played: where a version loses only there, simulated real time never sees it.
            ...(options.live
                ? {
                    realtime: true,
                    live: {
                        minLagMs: liveFloorMs(this.deps.library.profile(game.id, version) as Profile, configFor(this.played(game, options.engine, true), version)) ?? 0,
                        gamesPerSeed: options.gamesPerSeed ?? LIVE_GAMES_PER_SEED,
                    },
                }
                : {}),
            ...(note ? { note } : {}),
            workDir: path.join(options.workDir, "train"),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.hooks?.train ? { hooks: options.hooks.train } : {}),
        });
        const kept: number | undefined = result.savedVersions.length ? result.bestVersion : undefined;
        done.push(kept !== undefined ? `trained: v${kept} kept (${result.savedVersions.map((v: number): string => `v${v}`).join(", ")} saved)` : "trained: no version played better");
        return kept;
    }

    /** Laya distilled for a version trained: its rules teach it (for real time with the lag, and live rounds for the running clock). */
    private async distillFor(options: ImproveOptions, game: GameDefinition, version: number, done: string[]): Promise<void> {
        const profile: Profile = this.deps.library.profile(game.id, version) as Profile;
        this.phase(options, `distilling Laya for v${version} (${LAYA_ROUNDS} rounds)`);
        const result: DistillResult = await this.deps.distill({
            ...this.deps.distillDefaults,
            gameId: game.id,
            profileVersion: version,
            rounds: LAYA_ROUNDS,
            studentGames: options.live ? LAYA_STUDENT_GAMES.live : LAYA_STUDENT_GAMES.paused,
            ...(profile.lagAware ? { lag: LIVE_LATENCY } : {}),
            ...(options.live ? { live: { minLagMs: liveFloorMs(profile) ?? 0 } } : {}),
            workDir: path.join(options.workDir, "distill"),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.hooks?.distill ? { hooks: options.hooks.distill } : {}),
        });
        done.push(`Laya distilled for v${version}: ${path.basename(result.checkpoint)}`);
    }

    /** The version that engine and clock play from now on: the game's configs (its own, else those its versions earn) with it pinned. */
    private pin(game: GameDefinition, kind: EngineKind, live: boolean, version: number, done: string[]): void {
        const library: Library = this.deps.library;
        const configs: PlayConfig[] = game.configs ?? playConfigs(game, library.profiles(game.id));
        const same: (c: PlayConfig) => boolean = (c: PlayConfig): boolean => Boolean(c.live) === live && (c.engine === kind || (kind === EngineKind.LAYA && c.engine === EngineKind.RULES));
        // Laya plays the version its rules taught it: the rules on the same clock play it too.
        const pinned: PlayConfig[] = configs.map((c: PlayConfig): PlayConfig => (same(c) ? { ...c, version } : c));
        library.saveGame({ ...library.game(game.id), configs: pinned });
        done.push(`${kind}${kind === EngineKind.LAYA ? " and the rules" : ""} now play v${version} with the clock ${live ? "running" : "paused"}`);
    }

    private dropBackup(lessons: Lessons | undefined): void {
        if (lessons?.backup) {
            rmSync(path.dirname(lessons.backup), { recursive: true, force: true });
        }
    }

    /**
     * A fix that plays no better undone: every round folder of the version but the one before goes — a stopped lesson's
     * too, which a resume would otherwise go on from —, the one before back where it was; the active version the one before.
     */
    private undo(library: Library, game: GameDefinition, lessons: Lessons | undefined, activeBefore: number | undefined, trained: number | undefined, done: string[]): void {
        if (lessons) {
            const dir: string = path.join(library.userDirFor(game.id), "laya");
            const keep: string | undefined = lessons.previous ? path.basename(lessons.previous) : undefined;
            let changed: boolean = false;
            for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
                if (entry.startsWith(lessons.rounds) && entry !== keep) {
                    rmSync(path.join(dir, entry), { recursive: true, force: true });
                    changed = true;
                }
            }
            if (lessons.previous && lessons.backup && !existsSync(lessons.previous)) {
                moveDir(lessons.backup, lessons.previous);
                changed = true;
            }
            if (changed) {
                done.push(lessons.previous ? `undone: Laya's checkpoint before it is back (${path.basename(lessons.previous)})` : "undone: the checkpoint it made is gone");
            }
        }
        this.dropBackup(lessons);
        if (trained !== undefined && activeBefore !== undefined && library.activeVersion(game.id) !== activeBefore) {
            library.setActive(game.id, activeBefore);
            done.push(`undone: v${activeBefore} is the active version again (v${trained} stays in the library)`);
        }
    }
}
