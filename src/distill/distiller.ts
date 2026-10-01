/**
 * Distillation: a teacher teaches a local Laya checkpoint to play one game, so the game is played
 * at close to its own speed.
 *
 * The teacher is the trainer's rules. By default they are the profile's `teacher` — `teach(state)`,
 * the instructions as code, written by the trainer (an LLM) and checked before it teaches (see
 * train/teacher-writer.ts); labels then cost nothing and training is bound only by the fine-tuning.
 * The other teacher is an engine that reads the instructions (Jev): the same rules, applied at a
 * few hundred milliseconds and a price per label.
 *
 *   no teacher yet → the trainer writes it (checked against logged decisions and by playing)
 *   → the teacher plays games (some moves random, so the data leaves its own path) → labelled states
 *   → finetune.py → checkpoint
 *   → DAgger rounds: Laya plays, the teacher labels the states Laya visited, train again on everything
 *   → Laya plays the profile's seeds: its scores beside the profile's
 *
 * With a lag, half the teacher's labelled states and half the student's games come from games simulating real time on
 * the paused clock: the states a lag-aware extractor makes live, which paused games alone never show.
 *
 * The state stays features only: the teacher's answer is the training TARGET, never a state field.
 * A checkpoint is tied to one profile version (its extractor makes the states it learned from):
 * `laya/v<N>-<hash>-r<k>`.
 */

import { GameBrowser } from "../devtools/client";
import { DecisionEngine, InvalidAnswerError, validateChoice } from "../engine";
import { LayaEngine } from "../engine/laya";
import { RequestTooLargeError } from "../engine/systemone";
import { GameDefinition, Profile } from "../game/types";
import { Library } from "../library/store";
import { DecisionRecord, EpisodeResult, Pace, Player, PlayHooks, PlayResult } from "../play/player";
import { ScriptError } from "../play/sandbox";
import { DecisionLog, profileHash } from "../run/decision-log";
import { customScriptOf } from "../run/play";
import { TeacherWriter } from "../train/teacher-writer";
import { appendRow, forEachJsonRow, sayingSkippedRows, SkippedRows } from "../util/rows";
import {
    holdLayaPort,
    holdRunLock,
    layaPortLockFile,
    recordedStudentMean,
    refuseLayaServer,
    reusableLayaServer,
    runFinetune,
    startLayaServer,
    LayaServerHandle,
} from "./laya-runtime";
import { RandomPlayer, RulesTeacher, seededRandom, TeacherLabel } from "./teacher";

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";

/**
 * The seeds of the teacher's games and of the students' come from two ranges that never meet: finetune.py holds out whole
 * games (by seed) to validate on, and a student's game on a teacher game's seed plays its layout — its rows, training only,
 * would be learnt while that game validates. The teacher's games take the lowest seeds from TEACHER_SEED_BASE up that no
 * row of the version holds. They once took TEACHER_SEED_BASE + the rows there were: the students' range, which began at
 * 20,000, once the rules held 10,000. Rows from before keep their seeds, which the teacher's games now pass over.
 */
const TEACHER_SEED_BASE: number = 10_000;
/** The students' range: from here up, after every seed the version's rows hold (+100 a round). */
const STUDENT_SEED_BASE: number = 1_000_000;
const RELABEL_CONCURRENCY: number = 8;
/** An engine teacher's answer that is no action is asked again this many times, as the player's decide asks (play/player.ts). */
const INVALID_ANSWER_RETRIES: number = 2;
/** Share of random moves in half of the rules teacher's games: states off its own path. */
const EXPLORATION: number = 0.08;
/** Teacher batches before training goes ahead with what there is. */
const MAX_TEACHER_BATCHES: number = 60;
/**
 * A teacher's batch adds almost nothing new when at most this share of the states it labelled were new (of the kind it
 * played for): two such batches in a row, and training goes ahead with what there is.
 */
const NOVELTY_SHARE: number = 0.01;

export enum TeacherKind {
    /** The profile's teach(state), written by the trainer. */
    RULES = "rules",
    /** An engine that reads the instructions (Jev). */
    ENGINE = "engine",
}

export interface DistillDeps {
    library: Library;
    openBrowser(): GameBrowser;
    python: string;
    /** The trainer (the Claude Code CLI): writes the teacher when the profile has none. */
    ask(prompt: string, workDir: string, signal?: AbortSignal): Promise<string>;
    /** An engine that reads the instructions: the ENGINE teacher. */
    engine?: DecisionEngine;
    /** Fine-tuning and serving (default: laya/finetune.py and laya/serve.py); tests replace them. */
    runtime?: { finetune: typeof runFinetune; serve: typeof startLayaServer };
}

export interface DistillOptions {
    gameId: string;
    /** The profile version Laya learns (default: the active one). */
    profileVersion?: number;
    teacher: TeacherKind;
    /** Labelled states wanted before training; the teacher plays more games while there are fewer. */
    minRows: number;
    /** Game time of a teacher / student game (s). */
    gameSeconds: number;
    /** Games played at once. */
    parallel: number;
    /** DAgger rounds after the first training. */
    rounds: number;
    /** Student games per DAgger round. */
    studentGames: number;
    epochs: number;
    /** Epochs of each DAgger round, which continues from the previous round's checkpoint (default: half of `epochs`). */
    roundEpochs?: number;
    /** The Laya server's port while the student plays. */
    port: number;
    base?: string;
    device?: string;
    /** Seconds of rest after each fine-tuning step (default 0.25): the machine stays usable. */
    pause?: number;
    /** Go on from this profile's latest checkpoint: `rounds` more DAgger rounds, no first training. */
    resume?: boolean;
    /**
     * Real time simulated on the paused clock (`play --lag`) for half the data: the teacher plays games landing each
     * decision this late after its frame, in game time (somewhere in the range, from the game's seed, drifting), until
     * half its distinct labelled states (minRows / 2) are made with it — the rows there count, so a version distilled
     * paused before plays lagged games only — and half of each DAgger round's student games are played with it: the rows
     * hold the states a lag-aware extractor makes in real time. The profile's seeds are played paused as always (they
     * decide which checkpoint stays), then once more with the lag.
     */
    lag?: { minMs: number; maxMs: number };
    /**
     * Every DAgger round's student games played live — the clock running, for real — their inputs held to land no sooner
     * than `minLagMs` (a lag-aware version's live floor): Laya corrected on the states it meets live, which a simulated lag
     * does not make (there a decision's own time varies, and an action it decides a frame late can come too late). One game at a
     * time: live games side by side slow each other. Each row keeps the lag its decision was made at.
     */
    live?: { minLagMs: number };
    workDir: string;
    signal?: AbortSignal;
    hooks?: { onLog?(line: string): void; onPhase?(detail: string): void; play?: PlayHooks };
}

export interface DistillResult {
    checkpoint: string;
    /**
     * Who taught the checkpoint: this run's teacher when this run fine-tuned it, else the one its distillation recorded (a
     * resume that fine-tuned nothing, an earlier checkpoint that stays) — "" when it recorded none: not known, as an
     * evaluation's.
     */
    teacher: string;
    /** The profile version Laya learned (a new one when the trainer wrote its teacher). */
    profileVersion: number;
    /**
     * The rows the checkpoint was last fine-tuned on, the teacher's and the DAgger ones — not the files' rows at the end: a
     * round that ended on agreement, or a resume that fine-tuned nothing, added rows it never learnt. None: not known (a
     * checkpoint this run did not fine-tune, whose distillation recorded none; an evaluation).
     */
    teacherRows?: number;
    daggerRows?: number;
    /**
     * The student's scores on the profile's seeds, and the reference: the profile's rules on the same games — its
     * teacher, unless an engine taught it — else the profile's recorded scores.
     */
    student?: { mean: number; scores: number[]; seeds: number[]; decisionMedianMs?: number; speed?: number };
    reference?: { mean: number; scores: number[]; by?: string };
    /** A random action every decision on the same games: the floor between which and the reference the student is placed. */
    random?: { mean: number; scores: number[] };
    /**
     * The lag the checkpoint's lagged data games were played with (`DistillOptions.lag`): this run's when this run fine-tuned
     * it, else as its distillation recorded (none: distilled without one, or not known).
     */
    lag?: { minMs: number; maxMs: number };
    /** With that lag: the rows made with it (their games were played with it), of `teacherRows` and of `daggerRows`. */
    laggedRows?: { teacher: number; dagger: number };
    /**
     * The checkpoint's student on the profile's seeds once more, each decision landing its own `lag` late: for information —
     * which checkpoint stays is decided by `student`, on the paused clock. A run that plays none keeps the recorded ones.
     */
    lagged?: { lag: { minMs: number; maxMs: number }; mean: number; scores: number[] };
}

/**
 * The round folders of one profile (`<name>-r<k>` under the game's laya directory), latest round last; `complete`:
 * its fine-tuning finished — the model is written first and `training.json` last, so a folder without that file is
 * a fine-tuning that never finished or was cut off while it saved its model (a leftover).
 */
function roundFolders(layaDir: string, name: string): Array<{ round: number; dir: string; complete: boolean }> {
    if (!existsSync(layaDir)) {
        return [];
    }
    const out: Array<{ round: number; dir: string; complete: boolean }> = [];
    for (const entry of readdirSync(layaDir)) {
        const m: RegExpMatchArray | null = entry.startsWith(`${name}-r`) ? /^(\d+)$/.exec(entry.slice(name.length + 2)) : null;
        if (m) {
            const dir: string = path.join(layaDir, entry);
            out.push({ round: Number(m[1]), dir, complete: existsSync(path.join(dir, "model.safetensors")) && existsSync(path.join(dir, "training.json")) });
        }
    }
    return out.sort((a: { round: number }, b: { round: number }): number => a.round - b.round);
}

/** The round checkpoints of one profile, latest round last. */
function roundCheckpoints(layaDir: string, name: string): Array<{ round: number; dir: string }> {
    return roundFolders(layaDir, name)
        .filter((f: { complete: boolean }): boolean => f.complete)
        .map((f: { round: number; dir: string }): { round: number; dir: string } => ({ round: f.round, dir: f.dir }));
}

/** A stop while playing: what was measured is partial, and nothing of it may be recorded or decide anything. */
function throwIfStopped(options: DistillOptions, played: PlayResult[]): void {
    if (options.signal?.aborted || played.some((r: PlayResult): boolean => r.stopped)) {
        throw new Error("stopped");
    }
}

/**
 * A decision as a row of its game: marked with the game's lag when it was played with one (`DecisionRecord.lag`, which the
 * player sets too; finetune.py reads no such field).
 */
function rowOf(record: DecisionRecord, lag: { minMs: number; maxMs: number } | undefined): DecisionRecord {
    return lag ? { ...record, lag } : record;
}

/** Whether a row was made with this lag: its game was played with it. */
function madeWith(row: DecisionRecord, lag: { minMs: number; maxMs: number } | undefined): boolean {
    return lag !== undefined && row.lag?.minMs === lag.minMs && row.lag?.maxMs === lag.maxMs;
}

/** The rows of a rows file (of its first `limit`); a line that is no row is none (forEachJsonRow), as finetune.py skips it. */
async function countRows(file: string, limit?: number, skipped?: SkippedRows): Promise<number> {
    let rows: number = 0;
    await forEachJsonRow(
        file,
        (): void => {
            rows++;
        },
        { limit, skipped }
    );
    return rows;
}

/** The rows of a rows file made with this lag, of its first `limit` (a fine-tuning's rows: the files only grow). */
async function countLaggedRows(file: string, lag: { minMs: number; maxMs: number }, limit?: number, skipped?: SkippedRows): Promise<number> {
    let rows: number = 0;
    await forEachJsonRow(
        file,
        (row: DecisionRecord): void => {
            if (madeWith(row, lag)) {
                rows++;
            }
        },
        { limit, skipped }
    );
    return rows;
}

/** Distinct labelled states: in all, and of them those made with the lag and those made paused. */
interface Distinct {
    all: number;
    lagged: number;
    paused: number;
}

/**
 * Distinct states in a rows file (a game with no randomness replays the same states): in all, and apart in the rows
 * made with `lag` and in the paused ones — with a lag, half of the states wanted are of each (a row made with another
 * lag is neither).
 */
async function countDistinct(file: string, lag: { minMs: number; maxMs: number } | undefined, skipped?: SkippedRows): Promise<Distinct> {
    const seen: Map<string, { lagged: boolean; paused: boolean }> = new Map();
    await forEachJsonRow(
        file,
        (row: DecisionRecord): void => {
            const state: string = JSON.stringify(row.state);
            const kinds: { lagged: boolean; paused: boolean } = seen.get(state) ?? { lagged: false, paused: false };
            kinds.lagged ||= madeWith(row, lag);
            kinds.paused ||= row.lag === undefined;
            seen.set(state, kinds);
        },
        { skipped }
    );
    const counted: Array<{ lagged: boolean; paused: boolean }> = [...seen.values()];
    return {
        all: seen.size,
        lagged: counted.filter((k: { lagged: boolean }): boolean => k.lagged).length,
        paused: counted.filter((k: { paused: boolean }): boolean => k.paused).length,
    };
}

/** The seeds of the games rows files hold (the teacher's, the students', an engine's logged plays). */
async function seedsOf(files: string[], skipped?: SkippedRows): Promise<Set<number>> {
    const seeds: Set<number> = new Set();
    for (const file of files) {
        await forEachJsonRow(
            file,
            (row: DecisionRecord): void => {
                if (typeof row.seed === "number") {
                    seeds.add(row.seed);
                }
            },
            { skipped }
        );
    }
    return seeds;
}

/**
 * The teacher's next `n` seeds from `from` on: of its range, below the students' (STUDENT_SEED_BASE), and none a game of
 * the version's rows holds (`held`) — its own games of before, whose states it would label again, and a student's from
 * before the ranges were apart.
 */
function teacherSeeds(held: Set<number>, from: number, n: number): number[] {
    const seeds: number[] = [];
    for (let seed: number = from; seeds.length < n; seed++) {
        if (seed >= STUDENT_SEED_BASE) {
            throw new Error(
                `no seed is left for the teacher's games: they take the seeds from ${TEACHER_SEED_BASE} to ${STUDENT_SEED_BASE - 1} that no row of the version holds, and a student's game one from ${STUDENT_SEED_BASE} up`
            );
        }
        if (!held.has(seed)) {
            seeds.push(seed);
        }
    }
    return seeds;
}

/** The rows a fine-tuning learnt: the first ones of the teacher's rows file and of the DAgger rows file, which only grow. */
interface TrainedRows {
    teacherRows: number;
    daggerRows: number;
}

/** What a checkpoint's distillation recorded of it (its distill.json): who taught it, what it learnt, how its student played. */
type Recorded = Pick<DistillResult, "teacherRows" | "daggerRows" | "lag" | "laggedRows" | "student" | "lagged"> & { teacher?: string };

/** Whether a recorded value is an object with a number under each of these keys. */
function holdsNumbers(value: unknown, keys: string[]): boolean {
    return typeof value === "object" && value !== null && keys.every((k: string): boolean => typeof (value as Record<string, unknown>)[k] === "number");
}

/**
 * A checkpoint's record (its distill.json), of the fields it holds — one it holds as no such value is not known —; none when
 * it has none (a distillation that stopped before it measured its checkpoint records nothing).
 */
function recordOf(checkpoint: string): Recorded | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path.join(checkpoint, "distill.json"), "utf-8"));
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }
    const r: Record<string, unknown> = parsed as Record<string, unknown>;
    return {
        ...(typeof r.teacher === "string" && r.teacher !== "" ? { teacher: r.teacher } : {}),
        ...(typeof r.teacherRows === "number" && typeof r.daggerRows === "number" ? { teacherRows: r.teacherRows, daggerRows: r.daggerRows } : {}),
        ...(holdsNumbers(r.lag, ["minMs", "maxMs"]) ? { lag: r.lag as { minMs: number; maxMs: number } } : {}),
        ...(holdsNumbers(r.laggedRows, ["teacher", "dagger"]) ? { laggedRows: r.laggedRows as { teacher: number; dagger: number } } : {}),
        ...(holdsNumbers(r.student, ["mean"]) ? { student: r.student as DistillResult["student"] } : {}),
        ...(holdsNumbers(r.lagged, ["mean"]) ? { lagged: r.lagged as DistillResult["lagged"] } : {}),
    };
}

/**
 * Who taught a checkpoint and what it learnt, as its record says: the teacher ("" when it names none: not known), the rows,
 * the lag and the rows made with it — none of it this run's, which taught a checkpoint it did not fine-tune nothing.
 */
function taughtAsRecorded(recorded: Recorded | undefined): Pick<DistillResult, "teacher" | "teacherRows" | "daggerRows" | "lag" | "laggedRows"> {
    return {
        teacher: recorded?.teacher ?? "",
        ...(recorded?.teacherRows !== undefined && recorded.daggerRows !== undefined ? { teacherRows: recorded.teacherRows, daggerRows: recorded.daggerRows } : {}),
        ...(recorded?.lag ? { lag: recorded.lag } : {}),
        ...(recorded?.laggedRows ? { laggedRows: recorded.laggedRows } : {}),
    };
}

/** The kind of teacher a recorded label names: the rules (`rules v<N>`), else an engine — as `laya eval` reads a record. */
function teacherKindOf(teacher: string): TeacherKind {
    return teacher.startsWith("rules") ? TeacherKind.RULES : TeacherKind.ENGINE;
}

/**
 * Whether an error is the teacher failing on the state it was asked to label, which leaves that state out: an answer that
 * is no action (`InvalidAnswerError`), the rules failing on it (`ScriptError`), or a state larger than the engine takes
 * (`RequestTooLargeError`: asking again cannot help). Any other is no teacher's — an engine that cannot be reached after its
 * client's retries (no connection, HTTP 401 or 5xx), a rows file that cannot be written —: it stops the run, as it stops a
 * game the engine plays.
 */
function teacherFailedOn(err: unknown): boolean {
    return err instanceof InvalidAnswerError || err instanceof ScriptError || err instanceof RequestTooLargeError;
}

/** Labels states: the rules teacher at once, an engine by asking it. */
type Labeller = (d: DecisionRecord) => Promise<Record<string, number> | undefined>;

/** One game's states the teacher was asked to label, and those it failed on (the first error beside). */
interface GameLabels {
    seed?: number;
    states: number;
    failed: number;
    firstFailure?: string;
}

/** What relabelling the states a student visited gave. */
interface Relabelled {
    added: number;
    disagreed: number;
    /** States the teacher failed on (teacherFailedOn, or an answer with no probabilities): left out; the first error beside. */
    failed: number;
    firstFailure?: string;
    /** Each of the student's lagged games. */
    lagged: GameLabels[];
}

/** The lag to play with: none when unset or 0 (the player plays a lag of 0 as none). */
function lagOf(options: DistillOptions): { minMs: number; maxMs: number } | undefined {
    return options.lag && options.lag.maxMs > 0 ? options.lag : undefined;
}

/** A lag as the log says it: "45 ms", "45–60 ms". */
function lagText(lag: { minMs: number; maxMs: number }): string {
    return lag.maxMs > lag.minMs ? `${lag.minMs}–${lag.maxMs} ms` : `${lag.minMs} ms`;
}

/**
 * With a lag, whether the `index`-th game of pair (DAgger round) `batch` is played with it: every other game, the other
 * one in the next pair (round) — so a round of one alternates too. The teacher's games go in pairs whatever the
 * parallelism (the run's `g`-th is game `g % 2` of pair `Math.floor(g / 2)`), the second of a pair wandering: the lag
 * meets the random moves as often as not, and the four kinds of game (paused or lagged, on the teacher's path or off
 * it) come as often at any parallelism — a batch of one included. Decided by where the game stands, not drawn: a run
 * replays.
 */
function laggedGame(batch: number, index: number): boolean {
    return (batch + index) % 2 === 1;
}

/**
 * A lagged game whose states the teacher mostly failed on — more than half went unlabelled — refuses the run: a rules
 * teacher is checked on paused games only, and a student would learn next to nothing of real time from it.
 */
function laggedUnlabelled(teacher: string, game: string, unlabelled: GameLabels, lag: { minMs: number; maxMs: number }): Error {
    return new Error(
        `the teacher (${teacher}) failed on ${unlabelled.failed} of the ${unlabelled.states} states of ${game}, played with the lag ${lagText(lag)}` +
            `${unlabelled.firstFailure !== undefined ? ` (the first: ${unlabelled.firstFailure})` : ""}: with more than half of a lagged game unlabelled, ` +
            "the student would learn next to nothing of real time — the teacher must answer the states the lag makes, or distil without the lag"
    );
}

export class Distiller {
    constructor(private readonly deps: DistillDeps) {}

    private log(options: DistillOptions, line: string): void {
        options.hooks?.onLog?.(line);
    }

    /**
     * Distils the profile into a Laya checkpoint. The whole run holds its port (holdLayaPort): a second distillation on
     * it is refused at its start, not hours later when its student's server is refused or cannot bind. Once the version
     * it learns is known, it holds that too (holdVersion), whatever the port.
     */
    async distill(options: DistillOptions): Promise<DistillResult> {
        const releases: Array<() => void> = [holdLayaPort(layaPortLockFile(this.deps.library, options.port), options.port, `a distillation of ${options.gameId}`)];
        try {
            return await this.distillHolding(options, releases);
        } finally {
            for (const release of releases.reverse()) {
                release();
            }
        }
    }

    /**
     * Holds a profile version's round folders for the run (`<game>/laya/.v<N>-<hash>.lock`, holdRunLock): a second
     * distillation of the version, on another port, would remove this one's round in progress as a leftover, number its
     * rounds the same, fine-tune into the same folder, and each would drop the other's checkpoint at its end.
     */
    private holdVersion(game: GameDefinition, profile: Profile, layaDir: string, name: string, options: DistillOptions): () => void {
        const file: string = path.join(layaDir, `.${name}.lock`);
        return holdRunLock(
            file,
            `a distillation of ${game.id} on port ${options.port}`,
            (held: { pid: number; holder: string; since: string }): Error =>
                new Error(
                    `${game.name} v${profile.version} is held by ${held.holder} (pid ${held.pid}, since ${held.since}): wait for it to end — two distillations of one ` +
                        `version would number, fine-tune and remove the same round folders (its lock: ${file}; remove it if pid ${held.pid} is not that run)`
                )
        );
    }

    /** The distillation, its port held; the version's lock it takes goes into `releases`, which `distill` releases at the end. */
    private async distillHolding(options: DistillOptions, releases: Array<() => void>): Promise<DistillResult> {
        const { library } = this.deps;
        const game: GameDefinition = library.game(options.gameId);
        let profile: Profile | undefined = library.profile(game.id, options.profileVersion);
        if (!profile) {
            throw new Error(`${game.name} has no profile: train it first`);
        }
        const layaDir: string = path.join(library.userDirFor(game.id), "laya");
        // A resume goes on from this version's own checkpoint, with the teacher that taught it: both are there before anything
        // is done — a teacher written now would make a new version, which has no checkpoint to go on from.
        if (options.resume) {
            if (options.teacher === TeacherKind.RULES && !profile.teacher) {
                throw new Error(
                    `${game.name} v${profile.version} has no teacher (its rules as code) to go on with: resume with the engine teaching (--teacher engine), ` +
                        "or distil it afresh — its teacher is written first, as a new version"
                );
            }
            if (roundCheckpoints(layaDir, `v${profile.version}-${profileHash(profile)}`).length === 0) {
                throw new Error(`${game.name} v${profile.version} has no checkpoint to go on from: distil it first`);
            }
        }
        // The port first. A run that fine-tunes plays its students on checkpoints no server holds yet, so a server already
        // there would be refused when the first of them plays — after the teacher's games and a fine-tuning, hours from
        // now: any server there is refused now. (A resume with no more rounds plays the resumed checkpoint only: below.)
        const finetunes: boolean = !options.resume || options.rounds > 0;
        if (finetunes) {
            await refuseLayaServer(options.port, "a distillation serves the checkpoints it fine-tunes on its port itself");
        }
        mkdirSync(options.workDir, { recursive: true });

        // 0. The teacher.
        if (options.teacher === TeacherKind.RULES && !profile.teacher) {
            options.hooks?.onPhase?.("the trainer writes the teacher (the rules as code)");
            this.log(options, `v${profile.version} has no teacher: the trainer writes one`);
            const engineLog: string = new DecisionLog(library, game.id, profile, "engine").file;
            const written: { profile: Profile } = await new TeacherWriter({ library, ask: this.deps.ask, openBrowser: this.deps.openBrowser }).write(game, profile, {
                ...((await countRows(engineLog, 1)) > 0 ? { decisionLog: engineLog } : {}),
                workDir: options.workDir,
                log: (line: string): void => this.log(options, line),
                // Made active only when the version it teaches was: distilling another leaves which one plays as it was.
                activate: library.activeVersion(game.id) === profile.version,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            profile = written.profile;
            this.log(options, `v${profile.version} saved with its teacher`);
        }
        if (options.teacher === TeacherKind.ENGINE && !this.deps.engine) {
            throw new Error("the engine teacher needs an engine (Jev)");
        }
        const learned: Profile = profile;
        // Checkpoints are per profile version: `<name>-r<round>`. Its round folders are this run's until it ends.
        const name: string = `v${learned.version}-${profileHash(learned)}`;
        releases.push(this.holdVersion(game, learned, layaDir, name, options));
        // A fine-tuning that never finished left a folder with no model, or one cut off while it was saved (and maybe its
        // resume state): gone before the rounds are numbered, so no new round starts in it and none goes on from it.
        for (const f of roundFolders(layaDir, name)) {
            if (!f.complete) {
                rmSync(f.dir, { recursive: true, force: true });
            }
        }
        const previous: Array<{ round: number; dir: string }> = roundCheckpoints(layaDir, name);
        const resumed: { round: number; dir: string } | undefined = options.resume ? previous[previous.length - 1] : undefined;
        if (options.resume && !resumed) {
            throw new Error(`${game.name} v${learned.version} has no checkpoint to go on from: distil it first`);
        }
        // A resume with no lag given goes on with the one its checkpoint was distilled with (its record's): its rounds play
        // lagged games as the first run's did, and the checkpoint it keeps records it — a plain `--resume` of a lag-aware
        // version once played its rounds paused only and saved a checkpoint with no lag. A lag of 0 given is none.
        const resumedLag: { minMs: number; maxMs: number } | undefined = resumed && options.lag === undefined ? recordOf(resumed.dir)?.lag : undefined;
        if (resumedLag) {
            options = { ...options, lag: resumedLag };
        }
        // A new distillation numbers its rounds after the checkpoints already there: none is overwritten.
        const start: number = resumed ? resumed.round : previous.length ? previous[previous.length - 1].round + 1 : 0;
        if (resumed && !finetunes) {
            // Only the resumed checkpoint plays: a server holding that very one is reused, one holding another is refused
            // before the teacher's games.
            await reusableLayaServer(options.port, { [game.id]: resumed.dir });
        }
        // The teacher's own games label EVERY step: with askWhen, the steps it would skip are the calm ones
        // ("wait" states), and a student that never saw them does not know to wait when it is asked.
        const labelling: Profile = { ...learned, askWhen: undefined };
        const rules: RulesTeacher | undefined = options.teacher === TeacherKind.RULES ? new RulesTeacher(learned) : undefined;
        const teacherLabel: string = rules ? rules.label : (this.deps.engine as DecisionEngine).label;
        // Strict: a row of the teacher's that cannot be written fails its game, and the run with it — swallowed, a read-only
        // rules file once labelled nothing, and the run blamed the teacher.
        const data: DecisionLog = new DecisionLog(library, game.id, learned, teacherLabel, options.teacher === TeacherKind.RULES ? "rules" : undefined, { strict: true });
        const daggerFile: string = data.file.replace(/\.jsonl$/, ".dagger.jsonl");
        const label: Labeller = this.labeller(rules);
        /** The lines of the rows files that are no row, said once for each file: the run reads them many times. */
        const skipped: SkippedRows = sayingSkippedRows((line: string): void => this.log(options, line));

        // With a lag, half the labelled states are made with it: a lag-aware extractor's states in real time, which a
        // student that saw paused games alone never met. The other half stay paused, so the paused clock is still learnt.
        const lag: { minMs: number; maxMs: number } | undefined = lagOf(options);
        /** With a lag, the distinct labelled states wanted: half made with it, the others paused. */
        const wanted: { lagged: number; paused: number } = { lagged: Math.ceil(options.minRows / 2), paused: Math.floor(options.minRows / 2) };
        if (lag) {
            this.log(
                options,
                `with the lag ${lagText(lag)}: a lagged game lands every decision that late (real time simulated on the paused clock) — ${finetunes ? `the teacher plays them until ${wanted.lagged} of its distinct labelled states are made with the lag, and half of each round's Laya games; ` : ""}the profile's seeds are played paused, then once more with the lag`
            );
        }

        // 1. Labelled states from the teacher's own games: minRows DISTINCT ones (a game with no randomness
        // repeats its states; the random moves take it elsewhere). A batch that adds little new raises the
        // share of random moves. With a lag, half of them made with it; those there already count — a version
        // distilled paused before has its paused ones, and plays lagged games only. Resumed with no more rounds,
        // nothing is fine-tuned: the teacher plays no game (no checkpoint would learn its states).
        let rows: Distinct = finetunes ? await countDistinct(data.file, lag, skipped) : { all: 0, lagged: 0, paused: 0 };
        if (lag && finetunes) {
            this.log(
                options,
                rows.all > 0
                    ? `  ${rows.all} distinct labelled states are there already, reused: ${rows.lagged} made with the lag, ${rows.paused} paused`
                    : "  no labelled state is there yet"
            );
        }
        const short: () => boolean = (): boolean => finetunes && (lag ? rows.paused < wanted.paused || rows.lagged < wanted.lagged : rows.all < options.minRows);
        // The seeds the version's games hold: the teacher's games take none of them (teacherSeeds), and a student's come after
        // all of them (below).
        const held: Set<number> = await seedsOf([data.file, daggerFile], skipped);
        let seed: number = TEACHER_SEED_BASE;
        let exploration: number = EXPLORATION;
        let batches: number = 0;
        /** Batches in a row that added almost nothing new (NOVELTY_SHARE): two of them, and the teacher stops. */
        let stale: number = 0;
        /**
         * The teacher's games this run (and of them, those played with the lag), and the first error it met on a state of
         * them (why it labelled nothing, when it did not).
         */
        let games: number = 0;
        let laggedGames: number = 0;
        let failed: string | undefined;
        while (short() && batches++ < MAX_TEACHER_BATCHES) {
            if (options.signal?.aborted) {
                throw new Error("stopped");
            }
            options.hooks?.onPhase?.(
                lag
                    ? `the teacher plays: ${Math.min(rows.paused, wanted.paused) + Math.min(rows.lagged, wanted.lagged)}/${options.minRows} labelled states (${rows.lagged}/${wanted.lagged} made with the lag)`
                    : `the teacher plays: ${rows.all}/${options.minRows} labelled states`
            );
            const batch: number[] = teacherSeeds(held, seed, options.parallel);
            seed = batch[batch.length - 1] + 1;
            // With a lag, a game plays with it while the lagged states are short: every one once the paused ones are not, else
            // every other one (laggedGame, by the game's place in the run: the teacher's games go in pairs). Its rows are
            // recorded as any game's — the teacher's label of every state asked about, with the game's seed (finetune.py
            // keeps a game's rows on one side of its validation split) — and marked with the lag.
            const lags: Array<{ minMs: number; maxMs: number } | undefined> = batch.map((_: number, i: number): { minMs: number; maxMs: number } | undefined =>
                lag && rows.lagged < wanted.lagged && (rows.paused >= wanted.paused || laggedGame(Math.floor((games + i) / 2), (games + i) % 2)) ? lag : undefined
            );
            const results: PlayResult[] = await Promise.all(
                batch.map((s: number, i: number): Promise<PlayResult> => {
                    if (rules) {
                        // The second game of every pair wanders: a random move now and then (from the game's seed), still
                        // labelled by the rules.
                        const player: RulesTeacher = new RulesTeacher(learned, {
                            epsilon: (games + i) % 2 === 1 ? exploration : 0,
                            random: seededRandom(s),
                            onLabel: (l: TeacherLabel): void => data.append(rowOf({ ...l, seed: s }, lags[i])),
                        });
                        return this.play(game, labelling, player, s, options, i === 0, undefined, lags[i]);
                    }
                    return this.play(game, learned, this.deps.engine as DecisionEngine, s, options, i === 0, (d: DecisionRecord): void => data.append(rowOf(d, lags[i])), lags[i]);
                })
            );
            games += results.length;
            laggedGames += lags.filter((l: { minMs: number; maxMs: number } | undefined): boolean => l !== undefined).length;
            // The states the teacher failed on (it threw, or answered no action) went unlabelled.
            const asked: number = results.reduce((a: number, r: PlayResult): number => a + (r.episodes[0]?.decisions ?? 0), 0);
            const unlabelled: number = results.reduce((a: number, r: PlayResult): number => a + (r.episodes[0]?.invalidAnswers ?? 0), 0);
            const firstFailure: string | undefined = results.find((r: PlayResult): boolean => r.episodes[0]?.firstInvalidAnswer !== undefined)?.episodes[0]?.firstInvalidAnswer;
            failed ??= firstFailure;
            const before: Distinct = rows;
            rows = await countDistinct(data.file, lag, skipped);
            // What is new of the kind the batch was playing for: with a lag, the lagged states of its lagged games and the
            // paused ones of its paused games — the states reused from before are no bar (12,051 paused ones once made 107
            // new lagged states of two short games "almost nothing", and the lagged half stopped at 1,794 of 6,000).
            const playedLagged: boolean = lags.some((l: { minMs: number; maxMs: number } | undefined): boolean => l !== undefined);
            const playedPaused: boolean = lags.some((l: { minMs: number; maxMs: number } | undefined): boolean => l === undefined);
            const added: number = lag
                ? (playedLagged ? rows.lagged - before.lagged : 0) + (playedPaused ? rows.paused - before.paused : 0)
                : rows.all - before.all;
            if (added < 0.2 * asked) {
                exploration = Math.min(0.3, exploration * 1.5);
            }
            // Almost nothing new: of the states the batch labelled, at most NOVELTY_SHARE were not there before.
            stale = added <= NOVELTY_SHARE * (asked - unlabelled) ? stale + 1 : 0;
            this.log(
                options,
                `teacher games ${batch.map((s: number, i: number): string => `${s}${lags[i] ? " (lagged)" : ""}`).join(", ")}: ${results.map((r: PlayResult): string => `${r.episodes[0]?.score ?? "?"}${r.episodes[0]?.over ? "" : "*"}`).join(", ")} — ${lag ? `${rows.lagged}/${wanted.lagged} made with the lag, ` : ""}${rows.all} distinct labelled states`
            );
            if (unlabelled > 0) {
                this.log(options, `  the teacher failed on ${unlabelled} of the ${asked} states of these games: left unlabelled (the first: ${firstFailure})`);
            }
            for (const [i, r] of results.entries()) {
                const lagged: { minMs: number; maxMs: number } | undefined = lags[i];
                const e: EpisodeResult | undefined = r.episodes[0];
                if (lagged && e && e.invalidAnswers * 2 > e.decisions) {
                    const labels: GameLabels = {
                        seed: batch[i],
                        states: e.decisions,
                        failed: e.invalidAnswers,
                        ...(e.firstInvalidAnswer !== undefined ? { firstFailure: e.firstInvalidAnswer } : {}),
                    };
                    throw laggedUnlabelled(teacherLabel, `its lagged game ${batch[i]}`, labels, lagged);
                }
            }
            // Nothing labelled after a few batches: more of them would label nothing either (refused below).
            if (batches > 3 && rows.all === 0) {
                break;
            }
            // The game shows almost nothing new any more, two batches in a row (one short batch is no sign): what there is,
            // is what there is to learn.
            if (batches > 3 && stale >= 2) {
                this.log(
                    options,
                    `  the teacher's games add almost no new states (${added} of the ${asked - unlabelled} they labelled, and as few the batch before): training goes ahead with ${rows.all}${lag ? `, ${rows.lagged} of them made with the lag` : ""}`
                );
                break;
            }
        }
        if (!finetunes) {
            this.log(options, "  resumed with no more rounds, nothing is fine-tuned: the teacher plays no game");
        } else if (lag) {
            this.log(
                options,
                games === 0
                    ? `  the teacher plays no game: the ${rows.all} distinct labelled states there are enough, ${rows.lagged} of them made with the lag`
                    : `  the teacher played ${games} games, ${laggedGames} of them with the lag: ${rows.lagged} of the ${rows.all} distinct labelled states are made with it`
            );
        }
        // A first training needs labelled states: with none (a teacher that fails on every state it is asked about) it could
        // only fail, and be retried.
        if (!resumed && (await countRows(data.file, 1)) === 0) {
            throw new Error(`the teacher labelled no state in its ${games} games${failed !== undefined ? ` (it failed on them: ${failed})` : ""}: nothing to fine-tune on`);
        }

        // 2. First training, then DAgger rounds. Resumed, the latest checkpoint is a round already trained:
        // its student plays first.
        if (resumed) {
            this.log(options, `going on from ${path.basename(resumed.dir)}`);
        }
        const last: number = start + options.rounds;
        let checkpoint: string = resumed?.dir ?? "";
        /** The rows this run last fine-tuned on; none until it fine-tunes (a resumed checkpoint learnt its own before). */
        let trained: TrainedRows | undefined;
        // A student never replays a game the DAgger rows hold: a resumed checkpoint may be the one that played them (a run
        // that stopped on agreement), and would play them again the same way — the same rows twice. Its seeds come after every
        // seed the rows hold (the teacher's are below them: an engine's logged plays may be not).
        const firstStudentSeed: number = Math.max(STUDENT_SEED_BASE + start * 100, [...held].reduce((a: number, s: number): number => Math.max(a, s), -1) + 1);
        for (let round: number = start; round <= last; round++) {
            if (options.signal?.aborted) {
                throw new Error("stopped");
            }
            if (!resumed || round > start) {
                // A DAgger round goes on from the round before: it only has to learn where the student went wrong.
                const firstTraining: boolean = !resumed && round === start;
                const from: string | undefined = firstTraining ? options.base : checkpoint;
                checkpoint = path.join(layaDir, `${name}-r${round}`);
                const epochs: number = firstTraining ? options.epochs : (options.roundEpochs ?? options.epochs / 2);
                trained = await this.finetune(game, from, checkpoint, epochs, data.file, daggerFile, round, options, skipped);
            }
            if (round === last) {
                break;
            }
            // DAgger: the student plays; the teacher labels what it saw. With a lag, half its games are played with it: it is
            // corrected where it goes in real time too (the rows keep their game's seed and lag, relabelled as any).
            const visited: string = path.join(options.workDir, `student-r${round}.jsonl`);
            writeFileSync(visited, "");
            const seeds: number[] = Array.from({ length: options.studentGames }, (_: unknown, i: number): number => firstStudentSeed + (round - start) * 100 + i);
            // Live, every game is (its rows keep the lag each decision was made at); else half are lagged, with a lag.
            const lags: Array<{ minMs: number; maxMs: number } | undefined> = seeds.map((_: number, i: number): { minMs: number; maxMs: number } | undefined =>
                lag && !options.live && laggedGame(round, i) ? lag : undefined
            );
            const live: { minLagMs: number } | undefined = options.live;
            const played: PlayResult[] = await this.withStudent(game.id, checkpoint, options, async (student: LayaEngine): Promise<PlayResult[]> => {
                options.hooks?.onPhase?.(`round ${round}: Laya plays${live ? " live" : ""}, the teacher labels what it saw`);
                const one: (s: number, i: number) => Promise<PlayResult> = (s: number, i: number): Promise<PlayResult> =>
                    this.play(game, learned, student, s, options, i === 0, (d: DecisionRecord): void => appendRow(visited, rowOf(d, lags[i])), lags[i], live?.minLagMs);
                if (!live) {
                    return Promise.all(seeds.map(one));
                }
                const results: PlayResult[] = [];
                for (const [i, s] of seeds.entries()) {
                    results.push(await one(s, i));
                }
                return results;
            });
            this.log(
                options,
                `  Laya games${live ? " (live)" : ""}: ${played.map((r: PlayResult, i: number): string => `${r.episodes[0]?.score ?? "?"}${r.episodes[0]?.over ? "" : "*"}${lags[i] ? " (lagged)" : ""}`).join(", ")}`
            );
            const relabelled: Relabelled = await this.relabel(visited, daggerFile, label, options, skipped);
            this.log(options, `  the teacher labelled ${relabelled.added} states the student visited; it chose otherwise in ${relabelled.disagreed}`);
            if (relabelled.failed > 0) {
                this.log(options, `  the teacher failed on ${relabelled.failed} more: left out (the first: ${relabelled.firstFailure})`);
            }
            const unlabelled: GameLabels | undefined = relabelled.lagged.find((g: GameLabels): boolean => g.failed * 2 > g.states);
            const playedLag: { minMs: number; maxMs: number } | undefined = live ? { minMs: live.minLagMs, maxMs: live.minLagMs } : lag;
            if (playedLag && unlabelled) {
                throw laggedUnlabelled(teacherLabel, `the student's ${live ? "live" : "lagged"} game ${unlabelled.seed ?? "?"}`, unlabelled, playedLag);
            }
            if (relabelled.added > 0 && relabelled.disagreed === 0) {
                if (resumed && round === start && games > 0) {
                    // Resumed, the teacher's games of this run are rows the checkpoint never learnt: it is fine-tuned on them
                    // all the same (it once stopped here, and its record claimed rows it never trained on).
                    this.log(options, `  the student agrees with the teacher everywhere it went, but never learnt the teacher's ${games} games of this run: the next round does`);
                } else {
                    // The student made no mistake the teacher would correct: another round has nothing to learn.
                    this.log(options, `  the student agrees with the teacher everywhere it went: no more DAgger rounds`);
                    break;
                }
            }
        }

        // 3. The student on the profile's own seeds (a stop there throws: a partial mean must not decide which checkpoint stays).
        // A checkpoint this run did not fine-tune (resumed with no more rounds, or its student agreed everywhere in the first
        // round with no teacher's game of this run to learn) was taught as its record says: measured as taught by the teacher
        // the record names, not by this run's, which taught it nothing.
        const recorded: Recorded | undefined = trained ? undefined : recordOf(checkpoint);
        const evaluated: DistillResult = await this.measure(
            game,
            learned,
            checkpoint,
            recorded?.teacher !== undefined ? { ...options, teacher: teacherKindOf(recorded.teacher) } : options
        );
        const laggedPlay: DistillResult["lagged"] = evaluated.lagged ?? recorded?.lagged;
        const result: DistillResult = trained
            ? {
                // The rows it learnt: those of its last fine-tuning (the first ones of the files, which only grow), not the files'
                // rows now — a round that ended on agreement relabelled rows it never trained on.
                ...evaluated,
                teacher: teacherLabel,
                ...trained,
                ...(lag
                    ? {
                        lag,
                        laggedRows: {
                            teacher: await countLaggedRows(data.file, lag, trained.teacherRows, skipped),
                            dagger: await countLaggedRows(daggerFile, lag, trained.daggerRows, skipped),
                        },
                    }
                    : {}),
            }
            : {
                // Fine-tuned no more: its teacher, rows, lag and lagged rows as recorded, as `laya eval` keeps them (a `--rounds 0`
                // resume once erased the lag, and one with the engine teaching relabelled a checkpoint the rules taught); what this
                // run measured is refreshed, the lagged games only when it played them.
                ...evaluated,
                ...taughtAsRecorded(recorded),
                ...(laggedPlay ? { lagged: laggedPlay } : {}),
            };
        // A teacher not known is left out, not guessed (as `laya eval` leaves it).
        writeFileSync(
            path.join(checkpoint, "distill.json"),
            JSON.stringify({ ...result, teacher: result.teacher !== "" ? result.teacher : undefined, at: new Date().toISOString() }, null, 2)
        );
        // One checkpoint per profile is kept (~650 MB each): the new one, unless one from before plays better — on the
        // paused clock (`student`); the lagged games are for information.
        let kept: { dir: string; mean: number } | undefined;
        for (const p of previous) {
            const mean: number | undefined = recordedStudentMean(p.dir);
            if (p.dir !== checkpoint && mean !== undefined && mean > (kept?.mean ?? result.student?.mean ?? -Infinity)) {
                kept = { dir: p.dir, mean };
            }
        }
        const keep: string = kept?.dir ?? checkpoint;
        if (kept) {
            this.log(options, `${path.basename(kept.dir)} played better (mean ${kept.mean}): it stays, the new checkpoint is dropped`);
        }
        for (const p of roundFolders(layaDir, name)) {
            if (p.dir !== keep) {
                rmSync(p.dir, { recursive: true, force: true });
            }
        }
        if (!kept) {
            return result;
        }
        // The checkpoint that stays, as recorded: its student's scores and who taught it what — the lagged games just played, the
        // teacher and the rows were the dropped one's (the CLI said it was taught by the dropped run's teacher). The reference
        // and random play are the profile's on the same seeds, whichever checkpoint stays.
        const stays: Recorded | undefined = recordOf(kept.dir);
        return {
            checkpoint: kept.dir,
            profileVersion: result.profileVersion,
            ...taughtAsRecorded(stays),
            ...(stays?.student ? { student: stays.student } : {}),
            ...(result.reference ? { reference: result.reference } : {}),
            ...(result.random ? { random: result.random } : {}),
            ...(stays?.lagged ? { lagged: stays.lagged } : {}),
        };
    }

    /** Fine-tunes a checkpoint on the rows there are; returns how many it learnt (the files' first rows, as they only grow). */
    private async finetune(
        game: GameDefinition,
        from: string | undefined,
        checkpoint: string,
        epochs: number,
        dataFile: string,
        daggerFile: string,
        round: number,
        options: DistillOptions,
        skipped?: SkippedRows
    ): Promise<TrainedRows> {
        options.hooks?.onPhase?.(`fine-tuning Laya (round ${round})`);
        const rows: TrainedRows = { teacherRows: await countRows(dataFile, undefined, skipped), daggerRows: await countRows(daggerFile, undefined, skipped) };
        // No labelled row to learn from: a fine-tuning could only fail (and be retried twice).
        if (rows.teacherRows + rows.daggerRows === 0) {
            throw new Error(`round ${round}: no labelled states to fine-tune on (${path.basename(dataFile)} is empty)`);
        }
        this.log(options, `round ${round}: fine-tuning on ${rows.teacherRows} teacher states${existsSync(daggerFile) ? ` + ${rows.daggerRows} the student visited` : ""}`);
        await (this.deps.runtime?.finetune ?? runFinetune)({
            python: this.deps.python,
            data: [dataFile],
            ...(existsSync(daggerFile) ? { trainOnly: [daggerFile] } : {}),
            out: checkpoint,
            name: game.id,
            ...(from ? { base: from } : {}),
            epochs,
            ...(options.device ? { device: options.device } : {}),
            pause: options.pause ?? 0.25,
            onLine: (line: string): void => {
                // The summaries (the student's mistakes the round is for among them, the lines of a file that are no row), and one
                // progress line in four.
                if (
                    /^(rows|device|before|after|epoch|saved|resumed|hard rows|early stop|check at|fine-tuning stopped|skipped)/.test(line) ||
                    /^\s*the student's mistakes/.test(line) ||
                    /^step \d*00\//.test(line)
                ) {
                    this.log(options, `  ${line}`);
                }
            },
            ...(options.signal ? { signal: options.signal } : {}),
        });
        return rows;
    }

    /**
     * A checkpoint plays the profile's seeds (`laya eval`), holding the port as a distillation does: one running on it
     * refuses the evaluation, whose server would otherwise stand where the distillation's student is served.
     */
    async evaluate(game: GameDefinition, profile: Profile, checkpoint: string, options: DistillOptions): Promise<DistillResult> {
        const release: () => void = holdLayaPort(layaPortLockFile(this.deps.library, options.port), options.port, `an evaluation of ${game.id}`);
        try {
            return await this.measure(game, profile, checkpoint, options);
        } finally {
            release();
        }
    }

    /**
     * A checkpoint plays the profile's seeds, one game at a time (the decision time measured is a single game's).
     * A stop throws: nothing measured in part is returned.
     */
    private async measure(game: GameDefinition, profile: Profile, checkpoint: string, options: DistillOptions): Promise<DistillResult> {
        const seeds: number[] = profile.results?.seeds ?? game.trainSeeds ?? [101, 202, 303];
        const gameSeconds: number = profile.results?.gameSeconds ?? options.gameSeconds;
        const lag: { minMs: number; maxMs: number } | undefined = lagOf(options);
        throwIfStopped(options, []);
        const played: { paused: PlayResult[]; lagged: PlayResult[] } = await this.withStudent(
            game.id,
            checkpoint,
            options,
            async (student: LayaEngine): Promise<{ paused: PlayResult[]; lagged: PlayResult[] }> => {
                options.hooks?.onPhase?.(`Laya plays the profile's seeds (${seeds.join(", ")}, ${gameSeconds} s)`);
                const paused: PlayResult[] = [];
                for (const [i, s] of seeds.entries()) {
                    paused.push(await this.play(game, profile, student, s, { ...options, gameSeconds }, i === 0));
                }
                // With a lag, the same games once more with it: what the student makes of real time, for information.
                const lagged: PlayResult[] = [];
                if (lag) {
                    throwIfStopped(options, paused);
                    options.hooks?.onPhase?.(`Laya plays the profile's seeds with the lag ${lagText(lag)}`);
                    for (const s of seeds) {
                        lagged.push(await this.play(game, profile, student, s, { ...options, gameSeconds }, false, undefined, lag));
                    }
                }
                return { paused, lagged };
            }
        );
        throwIfStopped(options, [...played.paused, ...played.lagged]);
        const episodes: EpisodeResult[] = played.paused.map((r: PlayResult): EpisodeResult => r.episodes[0]);
        // The profile's rules on the same seeds — its teacher, unless an engine taught it: a seed replays the same
        // game, so the two are compared move for move.
        let reference: DistillResult["reference"] = profile.results ? { mean: profile.results.mean, scores: profile.results.scores, by: "recorded" } : undefined;
        if (profile.teacher) {
            const rules: RulesTeacher = new RulesTeacher(profile);
            const taught: PlayResult[] = [];
            for (const s of seeds) {
                taught.push(await this.play(game, profile, rules, s, { ...options, gameSeconds }, false));
            }
            throwIfStopped(options, taught);
            const scores: number[] = taught.map((r: PlayResult): number => r.episodes[0]?.score ?? 0);
            reference = { mean: scores.reduce((a: number, b: number): number => a + b, 0) / Math.max(1, scores.length), scores, by: rules.label };
        }
        // The floor: random play on the same games, so "the student covers N % of the way" means the same in every game.
        const randomGames: PlayResult[] = [];
        for (const s of seeds) {
            randomGames.push(await this.play(game, profile, new RandomPlayer(s), s, { ...options, gameSeconds }, false));
        }
        throwIfStopped(options, randomGames);
        const floor: number[] = randomGames.map((r: PlayResult): number => r.episodes[0]?.score ?? 0);
        const random: { mean: number; scores: number[] } = { mean: floor.reduce((a: number, b: number): number => a + b, 0) / Math.max(1, floor.length), scores: floor };
        const laggedScores: number[] = played.lagged.map((r: PlayResult): number => r.episodes[0]?.score ?? 0);
        const ms: number[] = episodes.flatMap((e: EpisodeResult): number[] => (e.engineMedianMs !== undefined ? [e.engineMedianMs] : []));
        const wall: number = episodes.reduce((a: number, e: EpisodeResult): number => a + e.wallSeconds, 0);
        const result: DistillResult = {
            checkpoint,
            teacher: "",
            profileVersion: profile.version,
            student: {
                mean: episodes.reduce((a: number, e: EpisodeResult): number => a + e.score, 0) / Math.max(1, episodes.length),
                scores: episodes.map((e: EpisodeResult): number => e.score),
                seeds,
                ...(ms.length ? { decisionMedianMs: Math.round(ms.reduce((a: number, b: number): number => a + b, 0) / ms.length) } : {}),
                speed: Number((episodes.reduce((a: number, e: EpisodeResult): number => a + e.gameSeconds, 0) / Math.max(0.1, wall)).toFixed(2)),
            },
            ...(reference ? { reference } : {}),
            random,
            ...(lag ? { lagged: { lag, mean: laggedScores.reduce((a: number, b: number): number => a + b, 0) / Math.max(1, laggedScores.length), scores: laggedScores } } : {}),
        };
        // Where the student stands between random play (0 %) and the reference (100 %).
        const span: number = (reference?.mean ?? random.mean) - random.mean;
        const share: string = reference && span > 0 ? `; ${Math.round((((result.student?.mean ?? 0) - random.mean) / span) * 100)} % of the way from random play to it` : "";
        const against: string = !reference
            ? "no reference"
            : reference.by === "recorded"
                ? "the profile's recorded"
                : options.teacher === TeacherKind.RULES
                    ? `its teacher (${reference.by}) on the same games`
                    : `the profile's rules (${reference.by}; not its teacher, an engine taught it) on the same games`;
        this.log(
            options,
            `Laya on the profile's seeds: ${result.student?.scores.join(", ")} (mean ${result.student?.mean.toFixed(1)}, ${result.student?.decisionMedianMs ?? "?"} ms a decision, ×${result.student?.speed} of the game's speed) — ${against}: ${reference?.scores.join(", ") ?? "not measured"}; random play: ${random.scores.join(", ")}${share}`
        );
        if (result.lagged) {
            this.log(
                options,
                `Laya with the lag ${lagText(result.lagged.lag)} on the same seeds: ${result.lagged.scores.join(", ")} (mean ${result.lagged.mean.toFixed(1)}; paused ${result.student?.mean.toFixed(1)}) — for information: which checkpoint stays is decided on the paused clock`
            );
        }
        return result;
    }

    private async withStudent<T>(gameId: string, checkpoint: string, options: DistillOptions, use: (student: LayaEngine) => Promise<T>): Promise<T> {
        const server: LayaServerHandle = await (this.deps.runtime?.serve ?? startLayaServer)({
            python: this.deps.python,
            port: options.port,
            checkpoints: { [gameId]: checkpoint },
            ...(options.device ? { device: options.device } : {}),
        });
        try {
            return await use(new LayaEngine({ url: server.url, model: gameId }));
        } finally {
            await server.stop();
        }
    }

    /**
     * One game on the paused clock; with `lag`, real time simulated on it (each decision lands that late, in game time);
     * with `liveMinLagMs`, live — the clock running, the inputs landing no sooner than that.
     */
    private async play(
        game: GameDefinition,
        profile: Profile,
        engine: DecisionEngine,
        seed: number,
        options: DistillOptions,
        recorded: boolean,
        onDecision?: (d: DecisionRecord) => void,
        lag?: { minMs: number; maxMs: number },
        liveMinLagMs?: number
    ): Promise<PlayResult> {
        const customScript: string | undefined = customScriptOf(this.deps.library, { game });
        const browser: GameBrowser = this.deps.openBrowser();
        try {
            return await new Player(browser, engine).play({
                game,
                profile,
                episodes: 1,
                gameSeconds: options.gameSeconds,
                seeds: [seed],
                pace: liveMinLagMs !== undefined ? Pace.REALTIME : Pace.TURN,
                ...(liveMinLagMs !== undefined ? { minLagMs: liveMinLagMs } : lag ? { simulatedLag: lag } : {}),
                ...(customScript ? { customScript } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                hooks: { ...(recorded ? options.hooks?.play : {}), ...(onDecision ? { onDecision } : {}) },
            });
        } finally {
            await browser.close();
        }
    }

    /**
     * Labels states: the rules teacher at once; an engine by asking it, its answer taken as the player takes one
     * (validateChoice: an offered action, with sane probabilities over the offered ones; one that is not is asked again,
     * INVALID_ANSWER_RETRIES times) — any other fails, and the state goes unlabelled: one naming an action not offered was
     * written as the teacher's choice and learnt as a hard row, and one of no weight counted as labelled (a lagged game of
     * them passed) while finetune.py dropped it.
     */
    private labeller(rules: RulesTeacher | undefined): Labeller {
        if (rules) {
            return async (d: DecisionRecord): Promise<Record<string, number> | undefined> => rules.teach(d.state);
        }
        const engine: DecisionEngine = this.deps.engine as DecisionEngine;
        return async (d: DecisionRecord): Promise<Record<string, number> | undefined> => {
            for (let attempt: number = 0; ; attempt++) {
                const response: { answers: Record<string, unknown> } = await engine.ask({ game: d.state }, { action: { type: "choice", criteria: d.criteria, instructions: d.instructions } });
                try {
                    return validateChoice(response.answers?.action, Object.keys(d.criteria)).probabilities;
                } catch (err: unknown) {
                    if (!(err instanceof InvalidAnswerError) || attempt >= INVALID_ANSWER_RETRIES) {
                        throw err;
                    }
                }
            }
        };
    }

    /**
     * The teacher's answers for the states a student visited, appended as training rows (each keeps its game's seed and
     * lag). A state the teacher fails on (teacherFailedOn, or an answer with no probabilities) is left out and counted, per
     * lagged game too: one the teacher mostly failed on refuses the run (laggedUnlabelled). Any other error — an engine that
     * cannot be reached, a row that cannot be written — stops the relabelling, and is thrown once the states being asked
     * about are answered: it was once counted as the teacher failing on every state (through an outage, hours of the
     * client's retries to add nothing, and with a lag the run refused blaming the teacher).
     */
    private async relabel(visitedFile: string, outFile: string, label: Labeller, options: DistillOptions, skipped?: SkippedRows): Promise<Relabelled> {
        const out: Relabelled = { added: 0, disagreed: 0, failed: 0, lagged: [] };
        const visited: DecisionRecord[] = [];
        await forEachJsonRow(
            visitedFile,
            (row: DecisionRecord): void => {
                visited.push(row);
            },
            { skipped }
        );
        const lagged: Map<number | undefined, GameLabels> = new Map();
        for (const d of visited.filter((v: DecisionRecord): boolean => v.lag !== undefined)) {
            const labels: GameLabels = lagged.get(d.seed) ?? { ...(d.seed !== undefined ? { seed: d.seed } : {}), states: 0, failed: 0 };
            labels.states++;
            lagged.set(d.seed, labels);
        }
        const fail: (d: DecisionRecord, error: string) => void = (d: DecisionRecord, error: string): void => {
            out.failed++;
            out.firstFailure ??= error;
            const labels: GameLabels | undefined = d.lag ? lagged.get(d.seed) : undefined;
            if (labels) {
                labels.failed++;
                labels.firstFailure ??= error;
            }
        };
        let next: number = 0;
        /** What stopped the relabelling, no teacher's failing on a state: the first is thrown once every worker settled. */
        const stops: unknown[] = [];
        const worker: () => Promise<void> = async (): Promise<void> => {
            while (next < visited.length && stops.length === 0 && !options.signal?.aborted) {
                const d: DecisionRecord = visited[next++];
                try {
                    const probabilities: Record<string, number> | undefined = await label(d);
                    if (!probabilities || Object.keys(probabilities).length === 0) {
                        fail(d, "no probabilities in its answer");
                        continue;
                    }
                    const best: string = Object.keys(probabilities).reduce((a: string, b: string): string => (probabilities[b] > probabilities[a] ? b : a));
                    // The student agrees when the teacher gives its choice the highest probability: a tie the teacher leaves
                    // open is no mistake (and its row not a hard one).
                    const agrees: boolean = (probabilities[d.choice] ?? -1) >= probabilities[best] - 1e-6;
                    const choice: string = agrees ? d.choice : best;
                    appendRow(outFile, { ...d, choice, probabilities, confidence: probabilities[choice], student: d.choice });
                    out.added++;
                    if (!agrees) {
                        out.disagreed++;
                    }
                } catch (err: unknown) {
                    if (!teacherFailedOn(err)) {
                        // Not the teacher failing on this state: the other workers ask about no more.
                        stops.push(err);
                        return;
                    }
                    // A state the teacher could not label is left out, counted.
                    fail(d, (err instanceof Error ? err.message : String(err)).slice(0, 300));
                }
            }
        };
        await Promise.all(Array.from({ length: RELABEL_CONCURRENCY }, worker));
        if (stops.length > 0) {
            throw stops[0];
        }
        out.lagged = [...lagged.values()];
        return out;
    }
}
