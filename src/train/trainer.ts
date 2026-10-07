/**
 * Training: an LLM writes and keeps improving a game's profile from the games
 * it plays; the decision engine plays every one of them.
 *
 *   no profile yet → SETUP: sample what the page draws, ask for the first extractor and actions
 *   then, each iteration:
 *     play the best profile on fixed seeds (several games at once)
 *     → evidence: scores, the last decisions before each end, end screens, the raw frames
 *       before each failure (saved as windows), things perceived for the first time
 *     → the TUNER writes a new version (+ regression tests pinning its fix)
 *     → it must pass every regression test offline (one repair round)
 *     → it plays the same seeds → kept only if its mean is higher; otherwise the best stays
 *
 * "Trained once, done" is wrong: a profile covers only the phases of a game it
 * has seen (one trained on a game's daytime can break when its night begins). Training again with
 * longer games feeds what is new back in.
 */

import { GameBrowser } from "../devtools/client";
import { StepRequest, StepResult } from "../devtools/protocol";
import { DecisionEngine, DecisionEngineError } from "../engine";
import { LIVE_LATENCY, liveFloors, MIN_PAUSED_TICK_MS } from "../game/configs";
import { openRequest, perceivedKinds } from "../game/open";
import { DecideOn, FailureWindow, GameAction, GameDefinition, Perception, PlanConfig, Profile, ProfileResults, RegressionTest } from "../game/types";
import { validateProfile, validateRegressionTest } from "../game/validate";
import { Library, ProfileSummary } from "../library/store";
import { guardState } from "../play/guard";
import { EpisodeResult, Pace, Player, PlayHooks, PlayOptions, PlayResult } from "../play/player";
import { inputSteps } from "../play/rounds";
import { checkExpression, checkExtractor, Extractor, Teacher } from "../play/sandbox";
import { RandomPlayer, RulesTeacher } from "../distill/teacher";
import { DecisionLog } from "../run/decision-log";
import { customScriptOf } from "../run/play";
import { TeacherWriter } from "./teacher-writer";
import { parseJsonObject, TrainerError, TrainerModel, TrainerTimeoutError } from "./claude";
import { RealtimeTraining, setupPrompt, TuneEvidence, tunePrompt } from "./prompts";
import { runRegressionTests, TestResult } from "./regression";
import { askTrainer } from "./trainer-cli";

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";

export const DEFAULT_TRAIN_SEEDS: number[] = [101, 202, 303];
/** Seeds a kept version must not play worse on (UNSEEN_TOLERANCE), never shown to the tuner (a game's `testSeeds` replaces them). */
export const DEFAULT_TEST_SEEDS: number[] = [1001, 2002, 3003];
/**
 * How much worse than the best's a candidate's mean on those seeds may be, as a share of the best's: a point on one seed
 * is noise, not rules fitted to the training games (a candidate playing 1266 against 494 was refused for 859.0 against
 * 859.3 there — 35 against 36 on one seed).
 */
export const UNSEEN_TOLERANCE: number = 0.01;

/** Whether a candidate plays the seeds it is never shown well enough to be kept: no more than UNSEEN_TOLERANCE worse than the best. */
export function playsUnseenWell(candidateMean: number, bestMean: number): boolean {
    return candidateMean >= bestMean - UNSEEN_TOLERANCE * Math.abs(bestMean);
}
/** Raw frames kept before a failure: enough to see the approach, few enough to replay in seconds. */
const WINDOW_FRAMES: number = 70;
/** Candidates in a row that did not beat the best before training stops. */
const MAX_REJECTED_IN_A_ROW: number = 2;
/** A new game first runs on its own (no input, finely sampled): what moves by itself, before blind input can end it. */
const SETUP_WATCH_SAMPLES: number = 8;
const SETUP_WATCH_MS: number = 100;
const SETUP_SAMPLES: number = 24;
const SETUP_SAMPLE_MS: number = 250;
const RAW_SAMPLE_WHAT: string =
    "what the perception adapter read: first while the game ran on its own (no input, 100 ms apart), then over a few seconds of blind play (clicks and key presses)";
const MAX_SETUP_CROPS: number = 60;
/** Pixel perception: the most frequent grid colours the setup sample summary lists. */
const PIXEL_SUMMARY_COLOURS: number = 12;
/**
 * The tickMs the trainer may write, rounded and clamped into it (never refused): the paused clock's shortest tick (two
 * frames: a shorter one is not played with the clock paused) to half a second of game time.
 */
const MIN_TRAINED_TICK_MS: number = MIN_PAUSED_TICK_MS;
const MAX_TRAINED_TICK_MS: number = 500;
/** The maxHoldMs the tuner may write, rounded and clamped into it as its tickMs is: the range a profile's validation takes. */
const MIN_TRAINED_HOLD_MS: number = 10;
const MAX_TRAINED_HOLD_MS: number = 10_000;
/** Blind input while sampling a new game: whatever it answers to shows more of it. */
const SETUP_POKES: StepRequest[] = [
    { click: true },
    { press: ["Space"] },
    {},
    { press: ["ArrowUp"] },
    { press: ["ArrowRight"] },
    {},
    { press: ["ArrowLeft"] },
    { press: ["ArrowDown"] },
];

export interface TrainHooks {
    onLog?(line: string): void;
    onPhase?(detail: string): void;
    /** The recorded game of each evaluation (the live view's). */
    play?: PlayHooks;
    onEpisodeEnd?(result: EpisodeResult, version: number | undefined): void;
    onSaved?(profile: Profile): void;
}

export interface TrainDeps {
    library: Library;
    engine: DecisionEngine;
    /** A browser session of its own for one game (evaluations play several at once). */
    openBrowser(): GameBrowser;
    trainer: TrainerModel;
    /** Asks the trainer (default: the Claude Code CLI); its reply's text. */
    ask?: (prompt: string, workDir: string, signal?: AbortSignal) => Promise<string>;
}

/** What decides while a profile is trained. */
export enum Decider {
    /** The engine reads the instructions (Jev): the rules in words. */
    ENGINE = "engine",
    /** The profile's teacher, teach(state): the rules as code, instant — distilled into Laya afterwards. */
    RULES = "rules",
}

/** Real-time training with the rules deciding: how late they answer, as the small model they teach does. */
const DEFAULT_REALTIME_LATENCY_MS: number = 30;
/** Real-time training with a hosted engine: its latency, for the tuner and the player's first decision (the player measures the real one). */
const REALTIME_ENGINE_LATENCY_MS: number = 280;
/** On the running clock, the step that lands a decision's input, on top of the decider's latency (the player's). */
const REALTIME_STEP_MS: number = 5;

export interface TrainOptions {
    gameId: string;
    /** Default ENGINE. */
    decider?: Decider;
    iterations: number;
    /** Game time per training game (s): default the game's trainSeconds. */
    gameSeconds?: number;
    /** Seeds a kept version must not play worse on (UNSEEN_TOLERANCE), whose games the tuner never sees: default the game's testSeeds. */
    testSeeds?: number[];
    /** Seeds every version is compared on: default the game's trainSeeds. */
    seeds?: number[];
    /** Plays an evaluation's games at once (default true). */
    parallel?: boolean;
    /** The training run's own directory: samples, crops, end screens the trainer reads. */
    workDir: string;
    /** Records each evaluation's first game (the live view). */
    recordDir?: string;
    /**
     * Train for real-time play: every game is played with the clock never paused, and the rules
     * decider answers late, as the engine that will play does — somewhere in `latency` (default 30 ms;
     * simulated, LIVE_LATENCY: Laya live), different from game to game and drifting within one, since an
     * engine's time does.
     */
    realtime?: boolean;
    latency?: { minMs: number; maxMs: number };
    /**
     * With `realtime`: real time simulated on the paused clock — each decision lands `latency` after its
     * frame in game time, the game running on meanwhile — so every run gives the same result, whatever
     * the machine's load (real real time does not replay: a candidate is kept or not on noise). Over a
     * range, each seed is played at its low end, its middle and its high end (lagPoints).
     */
    simulated?: boolean;
    /**
     * Real time with a slow engine (with `realtime`): the versions play in plan mode — one request
     * decides the next `slots` moments — and the tuner writes the extractor's prediction of each.
     */
    plan?: PlanConfig;
    /**
     * The version training starts from (default: the active one). Started from another, the versions it
     * keeps are saved without being made active: which one plays stays a decision of its own.
     */
    fromVersion?: number;
    /**
     * Real time as the game is played live (Train's fix, where a version loses live what simulated real time never shows):
     * with `realtime`, not `simulated`, every seed played `gamesPerSeed` times with the clock running, one game at a time,
     * the rules answering at once and each game's inputs landing no sooner than its own floor after their frame — spread
     * from `minLagMs` to `maxLagMs` (liveFloors; none: every game at `minLagMs`), as a slower engine or a busy machine lands
     * them. A version is measured over all those games (a seed's score their mean); the seeds it is never shown are played
     * paused, live games varying too much to hold a version to them.
     */
    live?: { minLagMs: number; gamesPerSeed: number; maxLagMs?: number };
    /**
     * Whether the versions it keeps are made active (default: when it started from the active version). False leaves the
     * active version as it is: a version trained for one engine (Jev's, without rules as code) is played by that
     * engine's config, not by every engine (Improve).
     */
    activate?: boolean;
    /**
     * Notes from the person training the game — what they saw it do, or want it to do — told to the trainer in its every
     * prompt (setup and tuning). A version is still kept only on its scores.
     */
    note?: string;
    signal?: AbortSignal;
    hooks?: TrainHooks;
}

export interface TrainResult {
    startVersion?: number;
    bestVersion?: number;
    bestMean?: number;
    savedVersions: number[];
    history: Array<{ version?: number; mean: number | null; kept?: boolean; note?: string }>;
    stopped: boolean;
}

/** Scores on a set of seeds, nothing else. */
interface Scores {
    mean: number;
    scores: number[];
    /** A game was stopped before its end: the scores are partial. */
    stopped: boolean;
    /** Answers that were no action, or rules that failed on a state (the last decision stood), and the first one's error. */
    invalidAnswers: number;
    firstInvalidAnswer?: string;
}

/** Why a candidate is not kept, beyond not scoring higher: for the history, and for the tuner (`why`). */
interface Refusal {
    note: string;
    why: string;
}

interface Evaluation {
    result: PlayResult;
    evidence: TuneEvidence;
    failures: EpisodeResult[];
}

function slug(key: string): string {
    return key.replace(/[^\w.-]+/g, "_").slice(0, 100);
}

function writeDataUrl(file: string, dataUrl: string): void {
    const comma: number = dataUrl.indexOf(",");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(dataUrl.slice(comma + 1), "base64"));
}

function mean(values: number[]): number {
    return values.length ? values.reduce((a: number, b: number): number => a + b, 0) / values.length : 0;
}

/** Each seed's score, in the seeds' order, from games of it at several lags: the mean of its games (two decimals). */
function scoresBySeed(games: Array<{ seed?: number; score: number }>, seeds: number[]): number[] {
    return seeds.map((seed: number): number => {
        const own: number[] = games.filter((g: { seed?: number }): boolean => g.seed === seed).map((g: { score: number }): number => g.score);
        return Number(mean(own).toFixed(2));
    });
}

/** Answers games gave that were no action, or rules that failed on a state, and the first one's error. */
function invalidAnswersOf(games: Array<{ invalidAnswers: number; firstInvalidAnswer?: string }>): { count: number; first?: string } {
    const first: string | undefined = games.find((g: { firstInvalidAnswer?: string }): boolean => g.firstInvalidAnswer !== undefined)?.firstInvalidAnswer;
    return { count: games.reduce((a: number, g: { invalidAnswers: number }): number => a + g.invalidAnswers, 0), ...(first !== undefined ? { first } : {}) };
}

/**
 * A tickMs as the trainer wrote it, whole and within MIN/MAX_TRAINED_TICK_MS (40.4 is 40, 16.7 is the shortest); not a
 * number, `fallback` — within them too: a version kept from one with a shorter tick is saved with the tick it was played at.
 */
function tickOf(value: unknown, fallback: number): number {
    const tickMs: number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.min(MAX_TRAINED_TICK_MS, Math.max(MIN_TRAINED_TICK_MS, Math.round(tickMs)));
}

/** A maxHoldMs as the tuner wrote it, whole and within MIN/MAX_TRAINED_HOLD_MS; not a number, `fallback` (none: the player's default). */
function holdOf(value: unknown, fallback: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_TRAINED_HOLD_MS, Math.max(MIN_TRAINED_HOLD_MS, Math.round(value))) : fallback;
}

export class Trainer {
    constructor(private readonly deps: TrainDeps) {}

    /** The teacher writer, asking this trainer's trainer. */
    private teacherWriter(): TeacherWriter {
        return new TeacherWriter({
            library: this.deps.library,
            ask: (p: string, d: string, s?: AbortSignal): Promise<string> => this.ask(p, d, s),
            openBrowser: this.deps.openBrowser,
        });
    }

    /** What plays a profile while it is trained: the engine, or the profile's own teacher. */
    private deciderFor(profile: Profile, options: TrainOptions, seed?: number): DecisionEngine {
        // Simulated, the player lands each decision late: the rules answer at once.
        // On the running clock the rules answer as late as an engine would; live as played (Improve), at once.
        return options.decider === Decider.RULES
            ? new RulesTeacher(profile, options.realtime && !options.simulated && !options.live ? { latency: { ...this.latencyRange(options), ...(seed !== undefined ? { seed } : {}) } } : {})
            : this.deps.engine;
    }

    /**
     * How a training game is clocked: paused, real time, or real time simulated on the paused clock — at `lag` when a
     * seed is played at one of the range's points (lagPoints).
     */
    private paceOf(options: TrainOptions, lag?: number): Pick<PlayOptions, "pace" | "expectedLagMs" | "simulatedLag" | "minLagMs"> {
        if (!options.realtime) {
            return { pace: Pace.TURN };
        }
        if (options.live) {
            // As a live config plays it: its inputs held to its lag — the game's own floor (runsOf).
            return { pace: Pace.REALTIME, minLagMs: lag ?? options.live.minLagMs };
        }
        // Before any decision was timed, the player expects the decider's latency (it adds the step itself).
        const range: { minMs: number; maxMs: number } = this.decisionLatency(options);
        if (options.simulated) {
            return { pace: Pace.TURN, simulatedLag: lag !== undefined ? { minMs: lag, maxMs: lag } : range };
        }
        // No live floor: training plays at its own latency, the best and a candidate (no results yet, so the default
        // floor would be another one) at the same lag.
        return { pace: Pace.REALTIME, expectedLagMs: (range.minMs + range.maxMs) / 2, minLagMs: 0 };
    }

    private latencyRange(options: TrainOptions): { minMs: number; maxMs: number } {
        return options.latency ?? (options.simulated ? LIVE_LATENCY : { minMs: DEFAULT_REALTIME_LATENCY_MS, maxMs: DEFAULT_REALTIME_LATENCY_MS });
    }

    /**
     * Real time simulated over a range of lags: each seed is played at the range's low end, its middle and its high end,
     * and a version is measured over all of them. One game per seed, drifting somewhere in the range, kept a version that
     * lost at one lag and won at another (measured 2026-09-30: one seed lost at 45 and 50 ms and won at 55 and 60, another
     * won at 45 and lost at 50, 55 and 60) — live, the lag is wherever the engine's time puts it. None for one lag, or the
     * running clock.
     */
    private lagPoints(options: TrainOptions): number[] | undefined {
        if (!options.realtime || !options.simulated) {
            return undefined;
        }
        const range: { minMs: number; maxMs: number } = this.latencyRange(options);
        return range.maxMs > range.minMs ? [...new Set([range.minMs, Math.round((range.minMs + range.maxMs) / 2), range.maxMs])] : undefined;
    }

    /** The games an evaluation plays: each seed once, at each of the lag points, or live its games a seed. */
    private runsOf(seeds: number[], options: TrainOptions): Array<{ seed: number; lag?: number }> {
        if (options.live) {
            // Every seed's games, each at its own floor (the lag its inputs are held to).
            const floors: number[] = liveFloors(options.live.minLagMs, options.live.maxLagMs, options.live.gamesPerSeed);
            return seeds.flatMap((seed: number): Array<{ seed: number; lag: number }> => floors.map((lag: number): { seed: number; lag: number } => ({ seed, lag })));
        }
        const points: number[] | undefined = this.lagPoints(options);
        return points ? seeds.flatMap((seed: number): Array<{ seed: number; lag: number }> => points.map((lag: number): { seed: number; lag: number } => ({ seed, lag }))) : seeds.map((seed: number): { seed: number } => ({ seed }));
    }

    /** How the seeds a version is never shown are played: as its games are, but live ones paused (live games vary too much to hold a version to). */
    private unseenOptions(options: TrainOptions): TrainOptions {
        return options.live ? this.pausedOptions(options) : options;
    }

    /** The games a version plays with the clock paused (its paused bar, the random floor): once a seed, as ever — never live's repeats. */
    private pausedOptions(options: TrainOptions): TrainOptions {
        const { live: _live, ...paused } = options;
        return { ...paused, realtime: false };
    }

    /**
     * Real-time training: how long a decision takes. Simulated, every decision lands exactly `latency` after its frame,
     * whatever decides (info.lagMs is that); in real time the rules answer `latency` late, and the engine takes its own time.
     */
    private decisionLatency(options: TrainOptions): { minMs: number; maxMs: number } {
        return options.decider !== Decider.RULES && !options.simulated ? { minMs: REALTIME_ENGINE_LATENCY_MS, maxMs: REALTIME_ENGINE_LATENCY_MS } : this.latencyRange(options);
    }

    /** Real-time training: how late a decision acts (the decider's latency, and on the running clock the step that lands its input). */
    private realtimeTraining(options: TrainOptions): RealtimeTraining {
        if (options.live) {
            // The rules answer at once: a decision lands at the floor its inputs are held to, each game's its own.
            const floors: number[] = liveFloors(options.live.minLagMs, options.live.maxLagMs, options.live.gamesPerSeed);
            return { minMs: Math.min(...floors), maxMs: Math.max(...floors), live: { gamesPerSeed: options.live.gamesPerSeed } };
        }
        const range: { minMs: number; maxMs: number } = this.decisionLatency(options);
        const step: number = options.simulated ? 0 : REALTIME_STEP_MS;
        const points: number[] | undefined = this.lagPoints(options);
        return {
            minMs: range.minMs + step,
            maxMs: range.maxMs + step,
            ...(options.simulated ? { simulated: true } : {}),
            ...(points ? { points } : {}),
            ...(options.plan ? { plan: options.plan } : {}),
        };
    }

    private ask(prompt: string, workDir: string, signal?: AbortSignal): Promise<string> {
        return this.deps.ask ? this.deps.ask(prompt, workDir, signal) : askTrainer(this.deps.trainer, prompt, workDir, signal);
    }

    private log(options: TrainOptions, line: string): void {
        options.hooks?.onLog?.(line);
    }

    async train(options: TrainOptions): Promise<TrainResult> {
        if (options.plan && !options.realtime) {
            throw new TrainerError("plan mode plays with the clock running: train with realtime too");
        }
        if (options.simulated && (!options.realtime || options.plan)) {
            throw new TrainerError("simulated real time goes with realtime, and plan mode is played on the running clock only");
        }
        if (options.live && (!options.realtime || options.simulated || options.plan)) {
            throw new TrainerError("live training plays as the game is played live: realtime, neither simulated nor in plans");
        }
        const { library } = this.deps;
        const game: GameDefinition = library.game(options.gameId);
        const seeds: number[] = options.seeds ?? game.trainSeeds ?? DEFAULT_TRAIN_SEEDS;
        const gameSeconds: number = options.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
        mkdirSync(options.workDir, { recursive: true });
        this.copySamples(game, options.workDir);
        if (options.note?.trim()) {
            this.log(options, `the notes for this training, told to the trainer: ${JSON.stringify(options.note.trim().slice(0, 300))}`);
        }

        const activeBefore: number | undefined = library.activeVersion(game.id);
        let best: Profile | undefined = library.profile(game.id, options.fromVersion);
        if (options.fromVersion !== undefined && !best) {
            throw new TrainerError(`${game.name} has no profile v${options.fromVersion}`);
        }
        const activate: boolean = options.activate ?? (options.fromVersion === undefined || options.fromVersion === activeBefore);
        const startVersion: number | undefined = best?.version;
        const saved: number[] = [];
        if (!best) {
            options.hooks?.onPhase?.("setting up: sampling the game");
            best = await this.setup(game, options);
            saved.push(best.version);
            options.hooks?.onSaved?.(best);
        }
        if (options.decider === Decider.RULES && !best.teacher) {
            options.hooks?.onPhase?.(`v${best.version} has no teacher: the trainer writes one`);
            // The engine's logged decisions for the version, when there are some: the teacher must agree with them (as the distiller's).
            const engineLog: string = new DecisionLog(library, game.id, best, "engine").file;
            best = (
                await this.teacherWriter().write(game, best, {
                    ...(existsSync(engineLog) && statSync(engineLog).size > 0 ? { decisionLog: engineLog } : {}),
                    workDir: options.workDir,
                    log: (line: string): void => this.log(options, line),
                    // Made active as the versions this training keeps are: not when it started from another than the active one.
                    activate,
                    ...(options.signal ? { signal: options.signal } : {}),
                })
            ).profile;
            saved.push(best.version);
            options.hooks?.onSaved?.(best);
        }
        const trainedHorizonS: number | undefined = best.results?.gameSeconds;
        const noveltyAfterMs: number | undefined = trainedHorizonS !== undefined && trainedHorizonS < gameSeconds ? trainedHorizonS * 1000 : undefined;
        // Simulated over a range of lags: the points each seed is played at, recorded with the real-time results.
        const points: number[] | undefined = this.lagPoints(options);
        const lagPoints: { points?: number[] } = points ? { points } : {};

        options.hooks?.onPhase?.(`measuring v${best.version} on seeds ${seeds.join(", ")}`);
        this.log(options, `v${best.version}: playing ${seeds.length} games of ${gameSeconds} s (seeds ${seeds.join(", ")})`);
        let bestEval: Evaluation = await this.evaluate(game, best, seeds, gameSeconds, `v${best.version}`, noveltyAfterMs, options);
        this.logEvaluation(options, `v${best.version}`, bestEval);
        // Trained for real time, a version must still play as well with the clock paused: one profile serves both.
        // The bar is how the version training began from plays paused, and it stays there: a kept version that
        // happened to play better paused does not raise it — that turned away a version playing exactly as the
        // starting one did (measured 2026-09-29: 38, 38, 21 against a kept 22, 38, 38).
        const pausedBar: { version: number; evaluation: Evaluation } | undefined = options.realtime
            ? { version: best.version, evaluation: await this.evaluatePaused(game, best, seeds, gameSeconds, `v${best.version}`, `v${best.version}`, options) }
            : undefined;
        // Seeds the tuner never sees: a kept version plays them no more than UNSEEN_TOLERANCE worse (rules fitted to three games
        // are not rules).
        const testSeeds: number[] = options.testSeeds ?? game.testSeeds ?? DEFAULT_TEST_SEEDS;
        let bestTest: Scores = await this.scoreOn(game, best, testSeeds, gameSeconds, this.unseenOptions(options));
        this.log(options, `  v${best.version} on seeds it is never shown (${testSeeds.join(", ")}): mean ${bestTest.mean.toFixed(1)} [${bestTest.scores.join(", ")}]`);
        // The floor: a random action every decision, on the training seeds.
        const random: Scores = await this.randomFloor(game, best, seeds, gameSeconds, options);
        this.log(options, `  random play on seeds ${seeds.join(", ")}: mean ${random.mean.toFixed(1)} [${random.scores.join(", ")}]`);
        // A stop during any of these measurements leaves it partial: none of it is recorded.
        const measured: boolean = !options.signal?.aborted && !bestEval.result.stopped && !pausedBar?.evaluation.result.stopped && !bestTest.stopped && !random.stopped;
        if (!best.results && measured) {
            // A version fresh from setup has no record yet: this measurement is it (the library card, the setup checklist) —
            // trained for real time, with its unseen seeds played paused too.
            const pausedTest: Scores | undefined = pausedBar ? (options.live ? bestTest : await this.scoreOn(game, best, testSeeds, gameSeconds, this.pausedOptions(options))) : undefined;
            if (!pausedTest?.stopped) {
                library.saveResults(
                    game.id,
                    best.version,
                    this.resultsOf(bestEval, seeds, gameSeconds, pausedBar?.evaluation, {
                        ...(options.live ? {} : { test: { ...bestTest, seeds: testSeeds } }),
                        ...(pausedTest ? { pausedTest: { ...pausedTest, seeds: testSeeds } } : {}),
                        random,
                        ...lagPoints,
                    })
                );
                best = library.profile(game.id, best.version) ?? best;
            }
        }
        const history: TrainResult["history"] = [{ version: best.version, mean: bestEval.result.mean, note: "starting point" }];
        let latest: { profile: Profile; evaluation: Evaluation; why: string } | undefined;
        let rejectedInARow: number = 0;
        let stopped: boolean = false;
        /** The tuner's last attempt was cut off at its time limit (minutes): its next one is told so, and to decide sooner. */
        let ranOutOfTime: number | undefined;

        for (let i: number = 1; i <= options.iterations; i++) {
            if (options.signal?.aborted) {
                stopped = true;
                break;
            }
            if (game.score.max !== undefined && bestEval.result.mean >= game.score.max) {
                this.log(options, `v${best.version} reaches the top score (${game.score.max}) on every seed: nothing left to train`);
                break;
            }
            const windows: FailureWindow[] = this.saveWindows(game, best, bestEval.failures);
            const tests: RegressionTest[] = best.tests;
            options.hooks?.onPhase?.(`iteration ${i}/${options.iterations}: the tuner is reading the runs`);
            this.log(options, `iteration ${i}: tuning (${bestEval.failures.length} failures, ${windows.length} new windows, ${tests.length} tests)`);
            let candidate: Profile;
            let newTests: RegressionTest[];
            try {
                ({ candidate, newTests } = await this.tune(game, best, bestEval, latest, history, gameSeconds, trainedHorizonS, options, ranOutOfTime));
                ranOutOfTime = undefined;
            } catch (err: unknown) {
                if (options.signal?.aborted) {
                    stopped = true;
                    break;
                }
                // An engine that failed while the regression tests played (an outage) is not the tuner's failure.
                const what: string = err instanceof DecisionEngineError ? "playing it failed" : "the tuner failed";
                this.log(options, `  ${what}: ${err instanceof Error ? err.message : String(err)}`);
                // Cut off at its time limit, the whole attempt is lost (no session is kept, and no answer was finished): the
                // next one is told, plainly — until 2026-10-06 its history read "tuner failed: claude stopped (killed): …" with
                // the stream's last line, and nothing asked it to decide sooner.
                ranOutOfTime = err instanceof TrainerTimeoutError ? err.minutes : undefined;
                history.push({
                    mean: null,
                    note:
                        err instanceof TrainerTimeoutError
                            ? `the tuner ran out of time: cut off at its ${err.minutes}-minute limit before its reply was finished — nothing of that attempt was kept`
                            : `${err instanceof DecisionEngineError ? "playing failed" : "tuner failed"}: ${err instanceof Error ? err.message.slice(0, 150) : ""}`,
                });
                if (++rejectedInARow >= MAX_REJECTED_IN_A_ROW) {
                    break;
                }
                continue;
            }
            options.hooks?.onPhase?.(`iteration ${i}: playing the new version`);
            let evaluation: Evaluation;
            let better: boolean;
            let paused: Evaluation | undefined;
            let test: Scores | undefined;
            /** Trained for real time: the unseen seeds with the clock paused too, recorded as every version has them. */
            let pausedTest: Scores | undefined;
            let floor: Scores | undefined;
            let refusal: Refusal | undefined;
            /** Better in real time, worse paused than where training began: kept for real time only (never made active). */
            let liveOnly: string | undefined;
            // Every game the candidate plays: one that fails (a DevTools timeout, an engine outage) fails the iteration, not the training.
            try {
                evaluation = await this.evaluate(game, candidate, seeds, gameSeconds, `it${i}`, noveltyAfterMs, options);
                this.logEvaluation(options, `iteration ${i}`, evaluation);
                if (evaluation.result.stopped) {
                    stopped = true;
                    break;
                }
                refusal = this.rulesFailed(options, evaluation.result.episodes, "in its games");
                better = !refusal && evaluation.result.mean > bestEval.result.mean;
                if (better && pausedBar) {
                    paused = await this.evaluatePaused(game, candidate, seeds, gameSeconds, `iteration ${i}`, `it${i}`, options);
                    if (paused.result.stopped) {
                        stopped = true;
                        break;
                    }
                    refusal = this.rulesFailed(options, paused.result.episodes, "with the clock paused");
                    if (!refusal && paused.result.mean < pausedBar.evaluation.result.mean) {
                        // One version serves both clocks when it can; one that does not keep the paused clock's score is
                        // still the better live player — some games want another game played in real time (the game moves
                        // on while a decision is made: a plan that needs that time loses it) — so it is kept for the live clock
                        // only, and the active version stays the paused clock's. A later one that plays both well is kept as ever.
                        liveOnly = `with the clock paused it plays ${paused.result.mean.toFixed(1)} against v${pausedBar.version}'s ${pausedBar.evaluation.result.mean.toFixed(1)}`;
                    }
                    better = !refusal;
                }
                if (better) {
                    test = await this.scoreOn(game, candidate, testSeeds, gameSeconds, this.unseenOptions(options));
                    if (test.stopped) {
                        stopped = true;
                        break;
                    }
                    this.log(options, `  iteration ${i} on the unseen seeds: mean ${test.mean.toFixed(1)} [${test.scores.join(", ")}]`);
                    refusal = this.rulesFailed(options, [test], "on seeds it is never shown");
                    if (!refusal && !playsUnseenWell(test.mean, bestTest.mean)) {
                        const worse: string = `more than ${Math.round(UNSEEN_TOLERANCE * 100)} % worse`;
                        this.log(
                            options,
                            `  => not kept: ${evaluation.result.mean.toFixed(1)} beats ${bestEval.result.mean.toFixed(1)} on the training seeds, ` +
                                `but on seeds it is never shown it plays ${test.mean.toFixed(1)} against ${bestTest.mean.toFixed(1)} (${worse})`
                        );
                        refusal = {
                            note:
                                `NOT KEPT although better on the training seeds: on other seeds, never shown, it played ${test.mean.toFixed(1)} against ${bestTest.mean.toFixed(1)} (${worse}) — ` +
                                "rules fitted to these games rather than to the game.",
                            why: `it beat the best (${bestEval.result.mean.toFixed(1)}) on these seeds, but on other seeds, never shown, it played ${test.mean.toFixed(1)} against the best's ${bestTest.mean.toFixed(1)} (${worse})`,
                        };
                    }
                    better = !refusal;
                }
                if (better) {
                    // Its own floor: random play with its actions and timing, not the starting version's.
                    floor = await this.randomFloor(game, candidate, seeds, gameSeconds, options);
                    if (floor.stopped) {
                        stopped = true;
                        break;
                    }
                    this.log(options, `  random play with iteration ${i}'s actions: mean ${floor.mean.toFixed(1)} [${floor.scores.join(", ")}]`);
                }
                if (better && pausedBar) {
                    // Live, the unseen seeds were played paused already.
                    pausedTest = options.live && test ? test : await this.scoreOn(game, candidate, testSeeds, gameSeconds, this.pausedOptions(options));
                    if (pausedTest.stopped) {
                        stopped = true;
                        break;
                    }
                    this.log(options, `  iteration ${i} on the unseen seeds with the clock paused: mean ${pausedTest.mean.toFixed(1)} [${pausedTest.scores.join(", ")}]`);
                }
            } catch (err: unknown) {
                if (options.signal?.aborted) {
                    stopped = true;
                    break;
                }
                this.log(options, `  playing it failed: ${err instanceof Error ? err.message : String(err)}`);
                history.push({ mean: null, note: `crashed: ${err instanceof Error ? err.message.slice(0, 150) : ""}` });
                if (++rejectedInARow >= MAX_REJECTED_IN_A_ROW) {
                    break;
                }
                continue;
            }
            if (better && floor) {
                const kept: Profile = library.saveProfile(
                    game.id,
                    {
                        ...candidate,
                        ...(liveOnly ? { liveOnly: true } : {}),
                        tests: [...best.tests, ...newTests],
                        results: this.resultsOf(evaluation, seeds, gameSeconds, paused, {
                            ...(test && !options.live ? { test: { ...test, seeds: testSeeds } } : {}),
                            ...(pausedTest ? { pausedTest: { ...pausedTest, seeds: testSeeds } } : {}),
                            random: floor,
                            ...lagPoints,
                        }),
                    },
                    { activate: activate && !liveOnly }
                );
                // Not made active: the active version stays the one it was. With none set (a fresh library) the newest would
                // be taken for it — this one, a version for Jev alone or from another.
                if (!activate && activeBefore !== undefined && library.activeVersion(game.id) !== activeBefore) {
                    library.setActive(game.id, activeBefore);
                }
                saved.push(kept.version);
                history.push({
                    version: kept.version,
                    mean: evaluation.result.mean,
                    kept: true,
                    note: liveOnly ? `KEPT FOR REAL TIME ONLY (${liveOnly}; not made active). ${candidate.note ?? ""}` : candidate.note,
                });
                this.log(
                    options,
                    liveOnly
                        ? `  => v${kept.version} saved for real time only: ${evaluation.result.mean.toFixed(1)} beats ${bestEval.result.mean.toFixed(1)} in real time, but ${liveOnly} (not made active)`
                        : `  => v${kept.version} saved: ${evaluation.result.mean.toFixed(1)} beats ${bestEval.result.mean.toFixed(1)}`
                );
                options.hooks?.onSaved?.(kept);
                best = kept;
                bestEval = evaluation;
                bestTest = test ?? bestTest;
                latest = undefined;
                rejectedInARow = 0;
            } else {
                // The tuner reads why a version that scored higher (or whose rules failed) was not kept: otherwise it keeps the cause.
                history.push({ mean: evaluation.result.mean, kept: false, note: refusal ? `${refusal.note} ${candidate.note ?? ""}` : candidate.note });
                if (!refusal) {
                    this.log(options, `  => not kept: ${evaluation.result.mean.toFixed(1)} does not beat ${bestEval.result.mean.toFixed(1)}`);
                }
                latest = { profile: candidate, evaluation, why: refusal?.why ?? `it did not beat the best (${bestEval.result.mean.toFixed(1)})` };
                if (++rejectedInARow >= MAX_REJECTED_IN_A_ROW) {
                    this.log(options, `  ${MAX_REJECTED_IN_A_ROW} versions in a row did not beat v${best.version}: training stops here`);
                    break;
                }
            }
        }
        return {
            ...(startVersion !== undefined ? { startVersion } : {}),
            bestVersion: best.version,
            bestMean: bestEval.result.mean,
            savedVersions: saved,
            history,
            stopped,
        };
    }

    /**
     * What a version is recorded with: its scores with the clock paused, as every version is compared in
     * the library; trained for real time, the real-time scores beside them (`paused` given) — the unseen
     * seeds' among them (`realtime.test`: `extra.test`, played in real time like the rest) — and the unseen
     * seeds with the clock paused as `test` (`extra.pausedTest`), as every version records them.
     */
    private resultsOf(
        evaluation: Evaluation,
        seeds: number[],
        gameSeconds: number,
        paused?: Evaluation,
        extra: { test?: ProfileResults["test"]; pausedTest?: ProfileResults["test"]; random?: ProfileResults["random"]; points?: number[] } = {}
    ): ProfileResults {
        const main: Evaluation = paused ?? evaluation;
        const lags: number[] = evaluation.result.episodes.flatMap((e: EpisodeResult): number[] => (e.lagMs !== undefined ? [e.lagMs] : []));
        const unseen: (scores: ProfileResults["test"]) => ProfileResults["test"] = (scores: ProfileResults["test"]): ProfileResults["test"] =>
            scores ? { mean: Number(scores.mean.toFixed(2)), scores: scores.scores, seeds: scores.seeds } : undefined;
        const test: ProfileResults["test"] = unseen(extra.test);
        const pausedTest: ProfileResults["test"] = paused ? unseen(extra.pausedTest) : test;
        return {
            mean: Number(main.result.mean.toFixed(2)),
            scores: main.result.episodes.map((e: EpisodeResult): number => e.score),
            seeds,
            gameSeconds,
            measuredAt: new Date().toISOString(),
            ...(paused
                ? {
                    realtime: {
                        mean: Number(evaluation.result.mean.toFixed(2)),
                        // A seed played more than once (at the lag points, or live its games a seed): its score is the mean of its games.
                        scores:
                            evaluation.result.episodes.length > seeds.length
                                ? scoresBySeed(evaluation.result.episodes, seeds)
                                : evaluation.result.episodes.map((e: EpisodeResult): number => e.score),
                        ...(lags.length ? { lagMs: Math.round(mean(lags)) } : {}),
                        ...(extra.points ? { lagPoints: extra.points } : {}),
                        ...(test ? { test } : {}),
                    },
                }
                : {}),
            ...(pausedTest ? { test: pausedTest } : {}),
            ...(extra.random ? { random: { mean: Number(extra.random.mean.toFixed(2)), scores: extra.random.scores } } : {}),
        };
    }

    /** The floor a version is measured from: a random action every decision, with its actions and timing, the clock paused. */
    private randomFloor(game: GameDefinition, profile: Profile, seeds: number[], gameSeconds: number, options: TrainOptions): Promise<Scores> {
        return this.scoreOn(game, profile, seeds, gameSeconds, this.pausedOptions(options), (seed: number): DecisionEngine => new RandomPlayer(seed));
    }

    /**
     * A version's scores on seeds, nothing kept as evidence (no windows, screens or episodes shown): the
     * seeds the tuner never sees, or — `engineFor` — the random floor.
     */
    private async scoreOn(
        game: GameDefinition,
        profile: Profile,
        seeds: number[],
        gameSeconds: number,
        options: TrainOptions,
        engineFor?: (seed: number) => DecisionEngine
    ): Promise<Scores> {
        const one: (run: { seed: number; lag?: number }) => Promise<PlayResult> = async ({ seed, lag }: { seed: number; lag?: number }): Promise<PlayResult> => {
            const browser: GameBrowser = this.deps.openBrowser();
            try {
                return await new Player(browser, engineFor ? engineFor(seed) : this.deciderFor(profile, options, seed)).play({
                    game,
                    profile,
                    episodes: 1,
                    gameSeconds,
                    seeds: [seed],
                    ...this.paceOf(options, lag),
                    ...this.customScript(game),
                    ...(options.signal ? { signal: options.signal } : {}),
                });
            } finally {
                await browser.close();
            }
        };
        const runs: Array<{ seed: number; lag?: number }> = this.runsOf(seeds, options);
        // Live games one at a time: side by side they slow each other.
        const results: PlayResult[] =
            options.parallel === false || options.live !== undefined
                ? await runs.reduce(
                    async (acc: Promise<PlayResult[]>, run: { seed: number; lag?: number }): Promise<PlayResult[]> => [...(await acc), await one(run)],
                    Promise.resolve([])
                )
                : await Promise.all(runs.map((run: { seed: number; lag?: number }): Promise<PlayResult> => one(run)));
        const played: Array<{ seed: number; score: number }> = results.map((r: PlayResult, i: number): { seed: number; score: number } => ({ seed: runs[i].seed, score: r.episodes[0]?.score ?? 0 }));
        // A seed played at several lags scores the mean of its games (the mean over all is the same).
        const scores: number[] = runs.length > seeds.length ? scoresBySeed(played, seeds) : played.map((p: { score: number }): number => p.score);
        const invalid: { count: number; first?: string } = invalidAnswersOf(results.flatMap((r: PlayResult): EpisodeResult[] => r.episodes));
        return {
            mean: mean(played.map((p: { score: number }): number => p.score)),
            scores,
            stopped: results.some((r: PlayResult): boolean => r.stopped),
            invalidAnswers: invalid.count,
            ...(invalid.first !== undefined ? { firstInvalidAnswer: invalid.first } : {}),
        };
    }

    /**
     * A version's games with the clock paused (real-time training checks it still plays as well that way): `label`
     * for the log, `shots` for its end screens' folder (no spaces: the UI serves a run's files by a path pattern).
     */
    private async evaluatePaused(
        game: GameDefinition,
        profile: Profile,
        seeds: number[],
        gameSeconds: number,
        label: string,
        shots: string,
        options: TrainOptions
    ): Promise<Evaluation> {
        const { recordDir: _recordDir, ...rest } = options;
        const paused: Evaluation = await this.evaluate(game, profile, seeds, gameSeconds, `${shots}-paused`, undefined, this.pausedOptions(rest));
        this.log(options, `  ${label} with the clock paused: mean ${paused.result.mean.toFixed(1)} [${paused.result.episodes.map((e: EpisodeResult): number => e.score).join(", ")}]`);
        return paused;
    }

    private logEvaluation(options: TrainOptions, label: string, evaluation: Evaluation): void {
        const scores: string = evaluation.result.episodes
            .map((e: EpisodeResult): string => `${e.score}${e.over ? "" : "*"}`)
            .join(", ");
        const invalid: { count: number; first?: string } = invalidAnswersOf(evaluation.result.episodes);
        const extractError: string | undefined = evaluation.result.episodes.find((e: EpisodeResult): boolean => e.firstExtractError !== undefined)?.firstExtractError;
        this.log(
            options,
            `  ${label}: mean ${evaluation.result.mean.toFixed(1)} [${scores}] (* = survived the budget) | engine median ${evaluation.result.engineMedianMs ?? "?"} ms | extractor errors ${evaluation.result.extractErrors}${extractError !== undefined ? ` (the first: ${extractError})` : ""} | advice fields dropped ${evaluation.result.adviceFieldsDropped}` +
                ` | invalid answers ${invalid.count}${invalid.first !== undefined ? ` (the first: ${invalid.first})` : ""}`
        );
    }

    /**
     * With the rules deciding, a candidate whose teacher failed on a state of its games — it threw, or answered no
     * action, and the last decision stood — is not kept: distilled, a state it fails on is never labelled. Logged as
     * its play failing; undefined when it never failed (or the engine decides: an invalid answer is then the engine's).
     * A frame with no state (the page read or the extractor failed) is not the teacher's: the player does not ask about
     * it, so it is an extractor error, never counted here.
     */
    private rulesFailed(options: TrainOptions, games: Array<{ invalidAnswers: number; firstInvalidAnswer?: string }>, where: string): Refusal | undefined {
        const invalid: { count: number; first?: string } = invalidAnswersOf(games);
        if (options.decider !== Decider.RULES || invalid.count === 0) {
            return undefined;
        }
        const failed: string = `its teacher failed on ${invalid.count} states ${where}${invalid.first !== undefined ? ` (the first: ${invalid.first})` : ""}`;
        this.log(options, `  playing it failed: ${failed}`);
        return {
            note: `NOT KEPT: ${failed} — it threw, or answered no action, and the last decision stood there; a state the teacher cannot answer is never learnt.`,
            why: `${failed}: teach(state) must answer every state it is given`,
        };
    }

    /** The samples training looked at before (the library's), for the trainer to Read. */
    private copySamples(game: GameDefinition, workDir: string): void {
        const sample: string | undefined = this.deps.library.file(game.id, "samples/raw-sample.json");
        if (sample) {
            copyFileSync(sample, path.join(workDir, "raw-sample.json"));
        }
        const sprites: string | undefined = this.deps.library.file(game.id, "samples/setup.json");
        if (sprites) {
            copyFileSync(sprites, path.join(workDir, "setup.json"));
        }
        for (const dir of [path.join(this.deps.library.builtInDir, game.id, "samples", "sprites"), path.join(this.deps.library.userDir, game.id, "samples", "sprites")]) {
            if (existsSync(dir)) {
                cpSync(dir, path.join(workDir, "sprites"), { recursive: true });
            }
        }
    }

    private workFiles(workDir: string): Array<{ path: string; what: string }> {
        const files: Array<{ path: string; what: string }> = [];
        if (existsSync(path.join(workDir, "raw-sample.json"))) {
            files.push({ path: "./raw-sample.json", what: "a sample of the raw input (what the perception adapter gives), from when the game was set up" });
        }
        if (existsSync(path.join(workDir, "setup.json"))) {
            files.push({ path: "./setup.json", what: "the setup's labels for the sprites it saw" });
        }
        if (existsSync(path.join(workDir, "sprites"))) {
            files.push({ path: "./sprites/", what: "PNG crops of sprites, named by sprite key (: and , replaced by _)" });
        }
        files.push({ path: "./shots-*/", what: "end screens of the games played, per version (named in the results)" });
        return files;
    }

    /**
     * Plays one game per seed — or per seed and lag point (lagPoints) — at once, each in its own browser session; the
     * first is recorded.
     */
    private async evaluate(
        game: GameDefinition,
        profile: Profile,
        seeds: number[],
        gameSeconds: number,
        label: string,
        noveltyAfterMs: number | undefined,
        options: TrainOptions
    ): Promise<Evaluation> {
        const cropDir: string = path.join(options.workDir, "novel");
        const one: (run: { seed: number; lag?: number }, index: number) => Promise<PlayResult> = async ({ seed, lag }: { seed: number; lag?: number }, index: number): Promise<PlayResult> => {
            // A seed's games at other lags end in folders of their own: an end screen is named for its seed.
            const shotsDir: string = path.join(options.workDir, lag !== undefined ? `shots-${label}-lag${lag}` : `shots-${label}`);
            const browser: GameBrowser = this.deps.openBrowser();
            try {
                const hooks: PlayHooks = {
                    ...(index === 0 ? options.hooks?.play : {}),
                    onEpisodeEnd: (result: EpisodeResult): void => {
                        if (index === 0) {
                            options.hooks?.play?.onEpisodeEnd?.(result);
                        }
                        options.hooks?.onEpisodeEnd?.(result, profile.version);
                    },
                };
                const result: PlayResult = await new Player(browser, this.deciderFor(profile, options, seed)).play({
                    game,
                    profile,
                    episodes: 1,
                    gameSeconds,
                    seeds: [seed],
                    ...this.paceOf(options, lag),
                    ...this.customScript(game),
                    ...(index === 0 && options.recordDir ? { recordDir: options.recordDir } : {}),
                    screenshotDir: shotsDir,
                    collect: { windowFrames: WINDOW_FRAMES, ...(noveltyAfterMs !== undefined ? { noveltyAfterMs } : {}) },
                    ...(options.signal ? { signal: options.signal } : {}),
                    hooks,
                });
                // A crop of each novel sprite, while its page is still there.
                if (game.perception.adapter === Perception.CANVAS2D) {
                    for (const episode of result.episodes) {
                        const keys: string[] = (episode.novel ?? []).map((n: { key: string }): string => n.key).slice(0, 40);
                        if (keys.length) {
                            const crops: Record<string, string> = (await browser.spriteCrops(keys).catch((): { crops: Record<string, string> } => ({ crops: {} }))).crops;
                            for (const n of episode.novel ?? []) {
                                if (crops[n.key]) {
                                    const file: string = path.join(cropDir, `${slug(n.key)}.png`);
                                    writeDataUrl(file, crops[n.key]);
                                    n.crop = `./${path.relative(options.workDir, file)}`;
                                }
                            }
                        }
                    }
                }
                return result;
            } finally {
                await browser.close();
            }
        };
        const runs: Array<{ seed: number; lag?: number }> = this.runsOf(seeds, options);
        // Live games one at a time: side by side they slow each other.
        const results: PlayResult[] =
            options.parallel === false || options.live !== undefined
                ? await runs.reduce(
                    async (acc: Promise<PlayResult[]>, run: { seed: number; lag?: number }, index: number): Promise<PlayResult[]> => [...(await acc), await one(run, index)],
                    Promise.resolve([])
                )
                : await Promise.all(runs.map((run: { seed: number; lag?: number }, index: number): Promise<PlayResult> => one(run, index)));
        const episodes: EpisodeResult[] = results.flatMap((r: PlayResult): EpisodeResult[] => r.episodes);
        const engineMs: number[] = results.flatMap((r: PlayResult): number[] => (r.engineMedianMs !== undefined ? [r.engineMedianMs] : []));
        const result: PlayResult = {
            mean: mean(episodes.map((e: EpisodeResult): number => e.score)),
            episodes,
            decisions: results.reduce((a: number, r: PlayResult): number => a + r.decisions, 0),
            ...(engineMs.length ? { engineMedianMs: Math.round(mean(engineMs)) } : {}),
            extractErrors: results.reduce((a: number, r: PlayResult): number => a + r.extractErrors, 0),
            adviceFieldsDropped: results.reduce((a: number, r: PlayResult): number => a + r.adviceFieldsDropped, 0),
            stopped: results.some((r: PlayResult): boolean => r.stopped),
        };
        return {
            result,
            // A game that ended at the top score was won, not lost.
            failures: episodes.filter(
                (e: EpisodeResult): boolean => e.over && Array.isArray(e.failureWindow) && (game.score.max === undefined || e.score < game.score.max)
            ),
            evidence: {
                mean: result.mean,
                extractErrors: result.extractErrors,
                adviceFieldsDropped: result.adviceFieldsDropped,
                episodes: episodes.map((e: EpisodeResult): TuneEvidence["episodes"][number] => ({
                    episode: e.episode,
                    ...(e.seed !== undefined ? { seed: e.seed } : {}),
                    // Real time: how late its decisions landed (at a lag point, that lag) — a seed may be lost at one and won at another.
                    ...(options.realtime && e.lagMs !== undefined ? { lagMs: e.lagMs } : {}),
                    score: e.score,
                    over: e.over,
                    gameSeconds: e.gameSeconds,
                    decisions: e.decisions,
                    actionCounts: e.actionCounts,
                    ...(e.firstExtractError !== undefined ? { firstExtractError: e.firstExtractError } : {}),
                    invalidAnswers: e.invalidAnswers,
                    ...(e.firstInvalidAnswer !== undefined ? { firstInvalidAnswer: e.firstInvalidAnswer } : {}),
                    lastTicks: e.lastTicks,
                    samples: e.samples,
                    ...(e.novel?.length ? { novel: e.novel } : {}),
                    ...(e.endScreenshot ? { endScreenshot: `./${path.relative(options.workDir, e.endScreenshot)}` } : {}),
                })),
            },
        };
    }

    /** The raw frames before each failure, saved in the library for the regression tests to replay. */
    private saveWindows(game: GameDefinition, profile: Profile, failures: EpisodeResult[]): FailureWindow[] {
        const saved: FailureWindow[] = [];
        for (const f of failures) {
            // Handed on already (below): the best version is tuned on again after a candidate that did not beat it.
            if (!f.failureWindow?.length) {
                continue;
            }
            let id: string = `v${profile.version}-seed${f.seed ?? "x"}`;
            for (let n: number = 2; this.deps.library.window(game.id, id); n++) {
                id = `v${profile.version}-seed${f.seed ?? "x"}-${n}`;
            }
            const window: FailureWindow = {
                id,
                ...(f.seed !== undefined ? { seed: f.seed } : {}),
                profileVersion: profile.version,
                rawFrames: f.failureWindow ?? [],
                ...(f.lagMs !== undefined ? { lagMs: f.lagMs } : {}),
                ...(f.failureInfo?.length ? { frameInfo: f.failureInfo } : {}),
            };
            this.deps.library.saveWindow(game.id, window);
            // Evidence handed on once: the next evaluation collects its own.
            f.failureWindow = undefined;
            f.failureInfo = undefined;
            saved.push(window);
        }
        return saved;
    }

    private listWindows(game: GameDefinition, profile: Profile): Array<{ id: string; frames: number; seed?: number; unread?: number[] }> {
        const ids: Set<string> = new Set(profile.tests.map((t: RegressionTest): string => t.window));
        for (const dir of [path.join(this.deps.library.userDir, game.id, "windows"), path.join(this.deps.library.builtInDir, game.id, "windows")]) {
            if (existsSync(dir)) {
                for (const entry of readdirSync(dir)) {
                    if (entry.endsWith(".json")) {
                        ids.add(entry.slice(0, -5));
                    }
                }
            }
        }
        const out: Array<{ id: string; frames: number; seed?: number; unread?: number[] }> = [];
        for (const id of ids) {
            const w: FailureWindow | undefined = this.deps.library.window(game.id, id);
            if (w) {
                // Frames the page could not be read on: the extractor never saw them, and a test pinned there checks nothing.
                const unread: number[] = (w.frameInfo ?? []).flatMap((info: { unread?: boolean }, i: number): number[] => (info.unread ? [i] : []));
                out.push({ id, frames: w.rawFrames.length, ...(w.seed !== undefined ? { seed: w.seed } : {}), ...(unread.length ? { unread } : {}) });
            }
        }
        return out;
    }

    /** Asks the tuner for a new version; it must compile and pass the regression tests (one repair round). */
    private async tune(
        game: GameDefinition,
        best: Profile,
        bestEval: Evaluation,
        latest: { profile: Profile; evaluation: Evaluation; why: string } | undefined,
        history: TrainResult["history"],
        gameSeconds: number,
        trainedHorizonS: number | undefined,
        options: TrainOptions,
        /** The attempt before this one was cut off at its time limit (minutes): said in the prompt. */
        ranOutOfTime?: number
    ): Promise<{ candidate: Profile; newTests: RegressionTest[] }> {
        const windows: Array<{ id: string; frames: number; seed?: number; unread?: number[] }> = this.listWindows(game, best);
        let repair: Array<{ test: RegressionTest; failedAt?: unknown }> | undefined;
        let attempted: { profile: Profile; newTests: RegressionTest[] } | undefined;
        for (let attempt: number = 0; attempt < 2; attempt++) {
            const prompt: string = tunePrompt({
                game,
                engineLabel: this.deps.engine.label,
                ...(options.decider === Decider.RULES ? { rules: true } : {}),
                ...(options.realtime ? { realtime: this.realtimeTraining(options) } : {}),
                ...(bestEval.result.engineMedianMs !== undefined ? { engineMedianMs: bestEval.result.engineMedianMs } : {}),
                gameSeconds,
                best,
                bestResult: bestEval.evidence,
                ...(latest ? { latest: { profile: latest.profile, result: latest.evaluation.evidence, why: latest.why } } : {}),
                history,
                windows,
                tests: best.tests,
                files: this.workFiles(options.workDir),
                ...(repair ? { repair } : {}),
                ...(attempted ? { attempted } : {}),
                ...(trainedHorizonS !== undefined && trainedHorizonS < gameSeconds ? { trainedHorizonS } : {}),
                ...(options.note ? { userNote: options.note } : {}),
                ...(ranOutOfTime !== undefined ? { ranOutOfTime } : {}),
            });
            writeFileSync(path.join(options.workDir, `tuner-prompt-${history.length}-${attempt + 1}.md`), prompt);
            const started: number = Date.now();
            const text: string = await this.ask(prompt, options.workDir, options.signal);
            // Kept beside its prompt: a reply that does not parse can be read afterwards.
            writeFileSync(path.join(options.workDir, `tuner-reply-${history.length}-${attempt + 1}.txt`), text);
            const reply: Record<string, unknown> = parseJsonObject(text);
            this.log(options, `  tuner (${Math.round((Date.now() - started) / 1000)} s): ${String(reply.analysis ?? "").slice(0, 600)}`);
            const candidate: Profile = this.candidateFrom(reply, best, options);
            // A test that needs a choice asks what decides while training: the engine, or the candidate's own teacher — without
            // the latency real time trains for: the tests replay saved frames offline, where a late answer only waits.
            const player: Player = new Player(this.deps.openBrowser(), options.decider === Decider.RULES ? new RulesTeacher(candidate) : this.deps.engine);
            const known: Set<string> = new Set(windows.map((w: { id: string }): string => w.id));
            const newTests: RegressionTest[] = this.testsFrom(reply.newTests).filter((t: RegressionTest): boolean => known.has(t.window));
            const results: TestResult[] = await runRegressionTests(
                game,
                candidate,
                [...best.tests, ...newTests],
                (id: string): FailureWindow | undefined => this.deps.library.window(game.id, id),
                player
            );
            const failed: TestResult[] = results.filter((r: TestResult): boolean => !r.pass);
            this.log(
                options,
                `  regression tests: ${results.length - failed.length}/${results.length} pass` +
                    (failed.length ? ` — failing: ${failed.map((f: TestResult): string => f.test.why ?? f.test.expect).join(" | ").slice(0, 300)}` : "")
            );
            if (failed.length === 0) {
                return { candidate, newTests };
            }
            repair = failed.map((f: TestResult): { test: RegressionTest; failedAt?: unknown } => ({ test: f.test, failedAt: f.failedAt }));
            attempted = { profile: candidate, newTests };
        }
        throw new TrainerError("the new version still fails its regression tests");
    }

    /** The tuner's reply as a profile (not yet saved): it must compile. */
    private candidateFrom(reply: Record<string, unknown>, best: Profile, options: TrainOptions): Profile {
        const askWhen: unknown = reply.askWhen;
        // A teacher of the reply's own only when the rules decide (the tuner is shown the teacher only then): with the engine
        // deciding, one copied back over a new extractor would keep a teacher written for another state.
        const written: string | undefined =
            options.decider === Decider.RULES && typeof reply.teacher === "string" && reply.teacher.trim() ? reply.teacher : undefined;
        // Numbered as it would be saved, after every version there is (training from an older one while newer ones exist):
        // its games are reported under that number.
        const newest: number = Math.max(best.version, ...this.deps.library.profiles(options.gameId).map((p: ProfileSummary): number => p.version));
        const maxHoldMs: number | undefined = holdOf(reply.maxHoldMs, best.maxHoldMs);
        const drafted: Profile = validateProfile(
            {
                version: newest + 1,
                createdAt: new Date().toISOString(),
                parent: best.version,
                origin: "tuner",
                ...(typeof reply.analysis === "string" && reply.analysis.trim() ? { note: reply.analysis } : {}),
                extractor: reply.extractor,
                instructions: reply.instructions,
                actions: reply.actions,
                decideOn: reply.decideOn ?? best.decideOn,
                // Rounded and clamped as the setup's: a tick of 40.4 or 16 is no reason to fail an iteration. So is the longest hold,
                // into the range the validation takes: one out of it failed the iteration after a long tuner call.
                tickMs: tickOf(reply.tickMs, best.tickMs),
                ...(maxHoldMs !== undefined ? { maxHoldMs } : {}),
                ...(typeof askWhen === "string" && askWhen.trim() ? { askWhen } : {}),
                ...(written ? { teacher: written } : {}),
                // Written for real time, or from a version that was: the extractor makes up for the lag.
                ...(options.realtime || best.lagAware ? { lagAware: true } : {}),
                ...((options.plan ?? best.plan) ? { plan: options.plan ?? best.plan } : {}),
                tests: [],
            },
            "the tuner's profile"
        );
        const teacher: string | undefined = written ?? this.inheritedTeacher(drafted, best, options);
        if (options.decider === Decider.RULES && !teacher) {
            throw new TrainerError("the reply has no teacher, and the rules decide while training");
        }
        const profile: Profile = teacher && !written ? { ...drafted, teacher } : drafted;
        checkExtractor(profile.extractor);
        if (profile.teacher) {
            new Teacher(profile.teacher, profile.actions.map((a: GameAction): string => a.id));
        }
        if (profile.askWhen) {
            checkExpression(profile.askWhen, ["state"]);
        }
        return profile;
    }

    /**
     * The best version's teacher, for a candidate the tuner wrote none for (with the engine deciding it writes none: a
     * teacher in its reply is ignored): kept when the rules decide (they played the candidate's games, so its score is
     * that teacher's) or when nothing it was written for changed (the extractor's state, the actions, the rules in
     * words). Else it is left out, and the teacher writer writes one where one is needed: a teacher kept for another
     * state would be distilled unchecked.
     */
    private inheritedTeacher(candidate: Profile, best: Profile, options: TrainOptions): string | undefined {
        if (!best.teacher) {
            return undefined;
        }
        const unchanged: boolean =
            candidate.extractor === best.extractor && candidate.instructions === best.instructions && JSON.stringify(candidate.actions) === JSON.stringify(best.actions);
        return options.decider === Decider.RULES || unchanged ? best.teacher : undefined;
    }

    private testsFrom(value: unknown): RegressionTest[] {
        if (!Array.isArray(value)) {
            return [];
        }
        const out: RegressionTest[] = [];
        for (const t of value) {
            try {
                const test: RegressionTest = validateRegressionTest(t, "a new test");
                checkExpression(test.expect, ["state", "choice"]);
                out.push(test);
            } catch {
                // a test that does not parse or compile is left out
            }
        }
        return out;
    }

    /** A new game's first profile: sample what the page draws, ask for an extractor and actions. */
    private async setup(game: GameDefinition, options: TrainOptions): Promise<Profile> {
        const { library } = this.deps;
        const browser: GameBrowser = this.deps.openBrowser();
        const watching: unknown[] = [];
        const samples: unknown[] = [];
        let screenshot: string | undefined;
        let playing: string | undefined;
        const workDir: string = options.workDir;
        try {
            await browser.open(openRequest(game, { seed: (options.seeds ?? game.trainSeeds ?? DEFAULT_TRAIN_SEEDS)[0], ...this.customScript(game) }));
            if (options.recordDir) {
                await browser.startRecording(options.recordDir).catch((): void => undefined);
            }
            // The game's start as the player sends it (inputSteps): the keys a `holdFrom` step names are let go by the next step,
            // and after a last one before the watch — held through it and the blind play, the samples the first extractor is
            // written from would be of a game play never shows.
            for (const s of inputSteps(game.start)) {
                await browser.step(s);
            }
            for (let i: number = 0; i < SETUP_WATCH_SAMPLES; i++) {
                const result: StepResult = await browser.step({ advanceMs: SETUP_WATCH_MS });
                if (result.raw !== undefined && result.raw !== null) {
                    watching.push(result.raw);
                }
            }
            screenshot = await browser.screenshot(workDir, "screenshot").catch((): undefined => undefined);
            for (let i: number = 0; i < SETUP_SAMPLES; i++) {
                const poke: StepRequest = i % 2 === 0 ? SETUP_POKES[(i / 2) % SETUP_POKES.length] : {};
                const result: StepResult = await browser.step({ ...poke, advanceMs: SETUP_SAMPLE_MS });
                if (result.raw !== undefined && result.raw !== null) {
                    samples.push(result.raw);
                }
                if (i === Math.floor(SETUP_SAMPLES / 2)) {
                    playing = await browser.screenshot(workDir, "screenshot-play").catch((): undefined => undefined);
                }
            }
            if (samples.length + watching.length === 0) {
                throw new TrainerError("the perception adapter read nothing from the page: is it the right adapter for this game?");
            }
            for (const [shot, name] of [
                [screenshot, "screenshot.png"],
                [playing, "screenshot-play.png"],
            ] as Array<[string | undefined, string]>) {
                if (shot) {
                    copyFileSync(shot, path.join(workDir, name));
                    library.writeFile(game.id, `samples/${name}`, readFileSync(shot));
                }
            }
            const sample: unknown = await this.sampleSummary(game, browser, watching, samples, workDir);
            writeFileSync(path.join(workDir, "raw-sample.json"), JSON.stringify(sample, null, 1));
            library.writeFile(game.id, "samples/raw-sample.json", JSON.stringify(sample, null, 1));
            if (options.recordDir) {
                await browser.stopRecording().catch((): void => undefined);
            }
        } finally {
            await browser.close();
        }

        options.hooks?.onPhase?.("setting up: the trainer is writing the first profile");
        const prompt: string = setupPrompt({
            game,
            files: this.setupFiles(workDir),
            ...(options.decider === Decider.RULES ? { withTeacher: true } : {}),
            ...(options.realtime ? { realtime: this.realtimeTraining(options) } : {}),
            ...(options.note ? { userNote: options.note } : {}),
        });
        writeFileSync(path.join(workDir, "setup-prompt.md"), prompt);
        const started: number = Date.now();
        const text: string = await this.ask(prompt, workDir, options.signal);
        writeFileSync(path.join(workDir, "setup-reply.txt"), text);
        const reply: Record<string, unknown> = parseJsonObject(text);
        const notes: string = typeof reply.notes === "string" ? reply.notes.trim() : "";
        const tickMs: number = tickOf(reply.tickMs, 96);
        const draft: Profile = validateProfile(
            {
                version: 1,
                createdAt: new Date().toISOString(),
                origin: "setup",
                note: `The setup's first extractor and actions (${Math.round((Date.now() - started) / 1000)} s).`,
                extractor: reply.extractor,
                instructions: `Play the game well. ${game.goal}${notes ? `\n${notes}` : ""}`,
                actions: reply.actions,
                decideOn: DecideOn.TICK,
                tickMs,
                // Only when the rules decide: they are asked for it then, and check it below. With the engine deciding, a
                // teacher in the reply was never checked, and the distiller would teach with it as it is.
                ...(options.decider === Decider.RULES && typeof reply.teacher === "string" && reply.teacher.trim() ? { teacher: reply.teacher } : {}),
                ...(options.realtime ? { lagAware: true } : {}),
                ...(options.plan ? { plan: options.plan } : {}),
                tests: [],
            },
            "the setup's profile"
        );
        if (options.decider === Decider.RULES && !draft.teacher) {
            throw new TrainerError("the setup wrote no teacher, and the rules decide while training");
        }
        // The states the extractor makes of the frames sampled, as a decider is given them.
        const extractor: Extractor = new Extractor(draft.extractor);
        const ids: string[] = draft.actions.map((a: GameAction): string => a.id);
        const states: unknown[] = [];
        for (const raw of [...watching, ...samples]) {
            try {
                states.push(guardState(extractor.extract(raw), ids).state);
            } catch {
                // counted below
            }
        }
        if (states.length === 0) {
            throw new TrainerError("the setup's extractor throws on every sample");
        }
        // The teacher is checked before it plays, as the teacher writer checks one: it answers every one of those states
        // (one repair round, told the errors and the states).
        const checked: Profile =
            options.decider === Decider.RULES && draft.teacher !== undefined
                ? {
                    ...draft,
                    teacher: await this.teacherWriter().checkedOnSamples(game, draft, states, {
                        workDir,
                        log: (line: string): void => this.log(options, line),
                        ...(options.signal ? { signal: options.signal } : {}),
                    }),
                }
                : draft;
        const kept: Profile = library.saveProfile(game.id, { ...checked });
        // Kept for the tuner (the setup's labels for the sprites it saw) only once the reply made a profile: one that parses
        // to anything else is no setup's answer (an empty object taken from inside a cut one once was written here), and one
        // refused above (no teacher, an extractor throwing on every sample, a teacher still failing) made none.
        writeFileSync(path.join(workDir, "setup.json"), JSON.stringify(reply, null, 1));
        library.writeFile(game.id, "samples/setup.json", JSON.stringify(reply, null, 1));
        this.log(options, `setup: v${kept.version} saved — actions ${kept.actions.map((a: GameAction): string => a.id).join(", ")}, tick ${kept.tickMs} ms`);
        return kept;
    }

    /** The game's own perception script (a custom adapter), for every game it plays: without it the extractor reads nothing. */
    private customScript(game: GameDefinition): { customScript?: string } {
        const script: string | undefined = customScriptOf(this.deps.library, { game });
        return script ? { customScript: script } : {};
    }

    private setupFiles(workDir: string): Array<{ path: string; what: string }> {
        const files: Array<{ path: string; what: string }> = [];
        if (existsSync(path.join(workDir, "screenshot.png"))) {
            files.push({ path: "./screenshot.png", what: "the page while the game ran on its own, before any input" });
        }
        if (existsSync(path.join(workDir, "screenshot-play.png"))) {
            files.push({ path: "./screenshot-play.png", what: "the page during blind play (the game may have ended by then)" });
        }
        files.push({ path: "./raw-sample.json", what: RAW_SAMPLE_WHAT });
        if (existsSync(path.join(workDir, "sprites"))) {
            files.push({ path: "./sprites/", what: "a PNG crop of each sprite in the catalog, named by its key (: and , replaced by _)" });
        }
        return files;
    }

    /** What a new game's samples show, compact: a sprite catalog with crops (canvas2d), object kinds (Phaser). */
    private async sampleSummary(game: GameDefinition, browser: GameBrowser, watching: unknown[], samples: unknown[], workDir: string): Promise<unknown> {
        const all: unknown[] = [...watching, ...samples];
        if (game.perception.adapter === Perception.CANVAS2D) {
            const catalog: Map<string, { count: number; example: Record<string, unknown> }> = new Map();
            for (const raw of all) {
                for (const kind of perceivedKinds(game, raw)) {
                    const entry: { count: number; example: Record<string, unknown> } = catalog.get(kind.key) ?? { count: 0, example: kind.example };
                    entry.count++;
                    catalog.set(kind.key, entry);
                }
            }
            const keys: string[] = [...catalog.keys()].slice(0, MAX_SETUP_CROPS);
            const crops: Record<string, string> = (await browser.spriteCrops(keys).catch((): { crops: Record<string, string> } => ({ crops: {} }))).crops;
            for (const [key, url] of Object.entries(crops)) {
                writeDataUrl(path.join(workDir, "sprites", `${slug(key)}.png`), url);
                this.deps.library.writeFile(game.id, `samples/sprites/${slug(key)}.png`, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
            }
            // Draw lists are long: the first and last frame of the game running on its own, three of blind play.
            const every: number = Math.max(1, Math.floor(samples.length / 3));
            return {
                sprites: Object.fromEntries(catalog),
                watching: watching.length > 1 ? [watching[0], watching[watching.length - 1]] : watching,
                blindPlay: samples.filter((_: unknown, i: number): boolean => i % every === 0).slice(0, 3),
            };
        }
        if (game.perception.adapter === Perception.PHASER || game.perception.adapter === Perception.PIXI || game.perception.adapter === Perception.COCOS || game.perception.adapter === Perception.THREE) {
            const kinds: Record<string, number> = {};
            for (const raw of all) {
                for (const kind of perceivedKinds(game, raw)) {
                    kinds[kind.key] = (kinds[kind.key] ?? 0) + 1;
                }
            }
            return { objectKinds: kinds, watching, blindPlay: samples.filter((_: unknown, i: number): boolean => i % 4 === 0) };
        }
        if (game.perception.adapter === Perception.PIXELS) {
            // A grid is thousands of characters: its size and the colours in it say more than the grids themselves.
            const colours: Record<string, number> = {};
            let size: { w: number; h: number } | undefined;
            for (const raw of all) {
                const grid: { w?: unknown; h?: unknown; px?: unknown } | null = raw && typeof raw === "object" ? (raw as { w?: unknown; h?: unknown; px?: unknown }) : null;
                if (!grid || typeof grid.px !== "string" || typeof grid.w !== "number" || typeof grid.h !== "number") {
                    continue;
                }
                size = { w: grid.w, h: grid.h };
                for (const cell of grid.px.match(/.{3}/g) ?? []) {
                    colours[cell] = (colours[cell] ?? 0) + 1;
                }
            }
            const top: Array<[string, number]> = Object.entries(colours)
                .sort((a: [string, number], b: [string, number]): number => b[1] - a[1])
                .slice(0, PIXEL_SUMMARY_COLOURS);
            return { grid: size ?? null, frames: all.length, commonColours: Object.fromEntries(top), readsEmpty: all.filter((raw: unknown): boolean => raw === null).length };
        }
        return { watching: watching.slice(0, 4), blindPlay: samples.slice(0, 6) };
    }
}
