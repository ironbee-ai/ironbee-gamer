/**
 * Plays a game with a profile: every decision is the engine's.
 *
 * One episode is a fresh page load (a game that did not end is never
 * "restarted" into the next), seeded when the game allows, so two profiles
 * can be compared on the same courses. The page's clock is frozen: the game
 * moves only by steps, so the engine's latency costs no game time — a
 * real-time game becomes turn-based.
 *
 * Each step: the raw input → the profile's extractor → the guard (no field may
 * carry the answer) → the engine picks an action → keys held / a click → game
 * time runs → the next raw input. `decideOn: tick` decides every `tickMs`;
 * `decideOn: change` holds the action until the state changes (at most
 * `maxHoldMs`). With `askWhen`, a step the expression calls uneventful keeps
 * the last decision in force without asking; so does a frame with no state
 * (reading the page or the extractor failed: an extractor error).
 *
 * An action chosen again with no effect on the state (twice or more) is
 * marked for the engine as ignored by the game.
 */

import { GameBrowser } from "../devtools/client";
import { OpenRequest, ScoreReading, StepRequest, StepResult } from "../devtools/protocol";
import { ChoiceAnswer, DecisionEngine, InvalidAnswerError, Question, validateChoice } from "../engine";
import { liveFloorMs } from "../game/configs";
import { openRequest, perceivedKinds } from "../game/open";
import { DecideOn, GameAction, GameDefinition, PlanConfig, Profile } from "../game/types";
import { sleep } from "../util/time";
import { guardState, GuardResult, stateSignature } from "./guard";
import { latencyAt, stepTimeAt } from "./latency";
import { planInputs, planInstructions, planQuestionId, TimedInput } from "./plan";
import { inputSteps, Resumes } from "./rounds";
import { ExtractInfo, Extractor, PendingInput, Predicate, ScriptError } from "./sandbox";

export enum Pace {
    /** The game advances only between decisions, as fast as they come (training, measuring). */
    TURN = "turn",
    /** As TURN, but never faster than the game's own speed: calm stretches play in real time (watching). */
    WATCH = "watch",
    /**
     * The game's clock is not frozen: it runs in real time and does not wait for a decision — a slow
     * engine decides on a state that is already old, and the game has moved on meanwhile.
     */
    REALTIME = "realtime",
}

const LAST_TICKS: number = 25;
/** REALTIME: how many recent decisions tell how late the next one will act. */
const LAG_WINDOW: number = 15;
/**
 * REALTIME: the share of recent decisions the lag covers. A decision faster than that waits, so every
 * input lands the same time after its frame: an engine whose time varies (a shared GPU: 40–70 ms) then
 * plays like one with a fixed lag, which the extractor can make up for.
 */
const LAG_PERCENTILE: number = 0.9;
/** REALTIME: a decision's lag before any was timed. */
const DEFAULT_LAG_MS: number = 30;
/** REALTIME: the step that lands a decision's input, after the engine answered. */
const STEP_MS: number = 5;
const SAMPLES_PER_EPISODE: number = 6;
const DEFAULT_MAX_HOLD_MS: number = 800;
const MIN_SUB_STEP_MS: number = 16;
/** A tick the engine was not asked about is sent to viewers at most this often. */
const UNASKED_TICK_EVENT_MS: number = 100;
/** An answer that is not an offered option is asked again this many times, then the last decision stands. */
const INVALID_ANSWER_RETRIES: number = 2;
/** The longest wait one `game_step` takes (the plugin's cap): in real time a longer start step sleeps the rest here. */
const MAX_STEP_WAIT_MS: number = 30_000;
/** Plan mode: how far ahead a plan's first moment is before any request was timed (a hosted engine's time). */
const DEFAULT_PLAN_LEAD_MS: number = 400;
/** Plan mode: a plan's first moment waits for this share of the recent requests (a later answer loses its first moments). */
const PLAN_LEAD_PERCENTILE: number = 0.9;
/** Plan mode: the page is looked at this often between answers (the game's end, the budget, the extractor's frames). */
const PLAN_LOOK_EVERY_MS: number = 100;
/** Plan mode: no look this close before an input is due. */
const PLAN_QUIET_MS: number = 30;
/** Plan mode with `planEveryMs`: at most this many requests in flight. */
const MAX_PLANS_IN_FLIGHT: number = 8;

export interface TickRecord {
    t: number;
    gameMs: number;
    state: unknown;
    choice: string;
    /** False: `askWhen` said nothing was worth deciding; the last decision stayed in force. */
    asked: boolean;
    fruitless?: boolean;
    score?: number;
    /** Plan mode: the plan answered on this frame, one action per moment. */
    plan?: string[];
    /** Plan mode: an input a plan played at its moment (the engine was asked on the frame of that plan). */
    planned?: boolean;
}

export interface TickEvent extends TickRecord {
    episode: number;
    engineMs?: number;
    probabilities?: Record<string, number>;
    decisions: number;
    /** Game time over wall time since the episode's first step: 1 = the game's own speed. */
    speed: number;
}

export interface NovelThing {
    key: string;
    firstSeenAtS: number;
    example: Record<string, unknown>;
    /** A PNG crop (canvas2d sprites), when one was saved. */
    crop?: string;
}

/** What the extractor was told with a frame of a failure window. */
export interface WindowFrameInfo extends ExtractInfo {
    /** The page could not be read on this frame: the extractor never saw it (its raw frame is empty), and a replay skips it. */
    unread?: boolean;
}

export interface EpisodeResult {
    episode: number;
    seed?: number;
    score: number;
    /** The game ended (a death); false: the game-time budget ran out. */
    over: boolean;
    gameSeconds: number;
    /** Wall time the episode took from its first step (page load and start excluded). */
    wallSeconds: number;
    /** Steps played (decisions in force). */
    steps: number;
    /** Times the engine was asked. */
    decisions: number;
    actionCounts: Record<string, number>;
    lastTicks: TickRecord[];
    samples: TickRecord[];
    /** Frames with no state (reading the page or the extractor failed): not asked about, the last decision stood. */
    extractErrors: number;
    /** The first of those frames' error. */
    firstExtractError?: string;
    adviceFieldsDropped: number;
    /** Answers that were no offered action, or rules as code that failed on the state: the last decision stood. */
    invalidAnswers: number;
    /** The first of those answers' error (why the rules failed, or that the answer was no action). */
    firstInvalidAnswer?: string;
    /** Frames whose score expression failed on the page (read as score 0, not over). */
    scoreErrors?: number;
    engineMedianMs?: number;
    /** REALTIME: the median lag the extractor was told (how late a decision acted after its frame). */
    lagMs?: number;
    /** The game's last own reading (levels, lives — whatever its score expression reports). */
    finalReading?: ScoreReading;
    endScreenshot?: string;
    /** The last raw frames (collected for training); one the page could not be read on is empty (`unread` in failureInfo). */
    failureWindow?: unknown[];
    /** What the extractor was told with each of those frames (the lag, the game time, a plan's moments). */
    failureInfo?: WindowFrameInfo[];
    /** Things perceived for the first time after the horizon the profile was trained on. */
    novel?: NovelThing[];
    stopped?: boolean;
}

export interface PlayResult {
    mean: number;
    episodes: EpisodeResult[];
    decisions: number;
    engineMedianMs?: number;
    extractErrors: number;
    adviceFieldsDropped: number;
    /** Frames whose score expression failed on the page, over all episodes. */
    scoreErrors?: number;
    videoPath?: string;
    stopped: boolean;
}

/** One question the engine answered, as asked: a distillation row (the answer is the teacher's). */
export interface DecisionRecord {
    state: unknown;
    criteria: Record<string, string>;
    instructions: { goal: string; instructions: string };
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
    ms: number;
    /** The game's seed: a model trained on the rows keeps each game's rows on one side of its validation split. */
    seed?: number;
    /**
     * The lag the decision was made with, as the distiller marks its lagged games' rows: a simulated lag's range, or in
     * real time `{ minMs: x, maxMs: x }`, x the lag its frame's state was made for (measured). None: paused.
     */
    lag?: { minMs: number; maxMs: number };
}

export interface PlayHooks {
    onPhase?(detail: string): void;
    /** Every decision the engine answered (logged for distillation); a plan's answers are not. */
    onDecision?(record: DecisionRecord): void;
    onEpisodeStart?(episode: number, seed: number | undefined): void;
    onTick?(event: TickEvent): void;
    onEpisodeEnd?(result: EpisodeResult): void;
    /** Recording started: frames now reach the live view. */
    onRecording?(): void;
}

export interface PlayOptions {
    game: GameDefinition;
    profile: Profile;
    episodes: number;
    gameSeconds: number;
    /** One seed per episode (cycled); none: unseeded games. */
    seeds?: number[];
    pace: Pace;
    /** Records a video of the whole run into this directory. */
    recordDir?: string;
    /** Saves each episode's end screen into this directory. */
    screenshotDir?: string;
    /** Collects training evidence: the last raw frames of a failure, and what is new after `noveltyAfterMs`. */
    collect?: { windowFrames: number; noveltyAfterMs?: number; cropDir?: string };
    /** The game's own perception script (a custom adapter). */
    customScript?: string;
    /** REALTIME: how late a decision acts before any was timed (default 30 ms). */
    expectedLagMs?: number;
    /**
     * REALTIME, a lag-aware profile: its inputs land no sooner than this after their frame, however fast
     * the engine answers — the lag it was trained at, where its extractor's timing holds (a config's `lagMs`).
     * Default: the profile's own (liveFloorMs — the lag training measured it at).
     */
    minLagMs?: number;
    /**
     * Plan mode: a new request at least this often, several in flight (a plan made on a newer frame
     * replaces an older one's) — what appears is reacted to sooner, for more requests. Default: one in flight.
     */
    planEveryMs?: number;
    /**
     * Real time simulated on the paused clock (TURN / WATCH): each decision lands this long after its
     * frame, in game time — somewhere in the range, from the seed, drifting as an engine's time does. The
     * game does not wait for the input, as in real time, and as in real time the next frame is read once
     * the input has landed and a tick has passed, plus a step's own time; but every run is the same
     * whatever the machine does.
     */
    simulatedLag?: { minMs: number; maxMs: number };
    signal?: AbortSignal;
    hooks?: PlayHooks;
}

/** The value at share `p` of the sorted values (0.5: the median). */
function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted: number[] = [...values].sort((a: number, b: number): number => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted: number[] = [...values].sort((a: number, b: number): number => a - b);
    return sorted[sorted.length >> 1];
}

/** One decision's question, as the decision log records its parts. */
type DecisionQuestion = { action: { type: "choice"; criteria: Record<string, string>; instructions: { goal: string; instructions: string } } };

/** Which action, by the game's goal and the profile's rules; an action the game ignored (`fruitless`) is marked. */
function decisionQuestion(game: GameDefinition, profile: Profile, fruitless?: { action: string; times: number }): DecisionQuestion {
    const criteria: Record<string, string> = {};
    for (const a of profile.actions) {
        criteria[a.id] =
            a.description +
            (fruitless && fruitless.action === a.id ? ` [CHOSEN ${fruitless.times} TIMES IN A ROW WITH NO EFFECT: THE GAME IGNORED IT]` : "");
    }
    return { action: { type: "choice", criteria, instructions: { goal: game.goal, instructions: profile.instructions } } };
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A frame's state that is only the error of making one (`{ extractorError }`: reading the page or the extractor
 * failed). Never asked about; a decision logged on one before it was not asked about is no state of the game.
 */
export function isExtractorErrorState(state: unknown): boolean {
    return (
        state !== null &&
        typeof state === "object" &&
        !Array.isArray(state) &&
        Object.keys(state).length === 1 &&
        typeof (state as { extractorError?: unknown }).extractorError === "string"
    );
}

/** Plan mode: what a frame's extractor is told besides the game time. */
interface PlanFrameInfo {
    lagMs: number;
    slots: number[];
    pending: PendingInput[];
}

/** What one observation gives: the raw input, the game's own reading, the state made of it. */
interface Observed {
    raw: unknown;
    reading: ScoreReading;
    state: unknown;
    signature: string;
}

/** Plan mode: a frame a plan was asked about, and its game time. */
interface PlanFrame {
    observed: Observed;
    gameMs: number;
}

/** Plan mode: a plan answered for the frame read at `frameAt` (wall ms), its first moment `leadMs` after it. */
interface PlanAnswer extends PlanFrame {
    frameAt: number;
    leadMs: number;
    /** How many plans had been merged when its frame was read: the schedule it was told of is theirs. */
    mergedBefore: number;
    choices: string[];
    ms: number;
}

type PlanOutcome = PlanAnswer | { error: unknown; ms: number };

export class Player {
    constructor(
        private readonly browser: GameBrowser,
        private readonly engine: DecisionEngine
    ) {}

    async play(options: PlayOptions): Promise<PlayResult> {
        const episodes: EpisodeResult[] = [];
        let videoPath: string | undefined;
        let recording: boolean = false;
        let stopped: boolean = false;
        const engineMs: number[] = [];
        this.engine.warmUp?.();
        // In real time a local model is kept from idling down while the page loads and between decisions: after a
        // pause its first answer comes 2–3× slower (keepWarm).
        const stopWarm: (() => void) | undefined = options.pace === Pace.REALTIME ? this.engine.keepWarm?.() : undefined;
        try {
            for (let ep: number = 1; ep <= options.episodes; ep++) {
                if (options.signal?.aborted) {
                    stopped = true;
                    break;
                }
                const seed: number | undefined = options.seeds?.length ? options.seeds[(ep - 1) % options.seeds.length] : undefined;
                options.hooks?.onPhase?.(`opening ${options.game.name} (episode ${ep}/${options.episodes})`);
                const request: OpenRequest = openRequest(options.game, {
                    seed,
                    customScript: options.customScript,
                    ...(options.pace === Pace.REALTIME ? { realtime: true } : {}),
                });
                await this.browser.open(request);
                if (options.recordDir && !recording) {
                    await this.browser.startRecording(options.recordDir);
                    recording = true;
                    options.hooks?.onRecording?.();
                }
                options.hooks?.onEpisodeStart?.(ep, request.seed);
                const result: EpisodeResult = await this.episode(options, ep, request.seed, engineMs);
                episodes.push(result);
                options.hooks?.onEpisodeEnd?.(result);
                if (result.stopped) {
                    stopped = true;
                    break;
                }
            }
        } finally {
            stopWarm?.();
            if (recording) {
                videoPath = await this.browser
                    .stopRecording()
                    .then((r: { filePath?: string }): string | undefined => r.filePath)
                    .catch((): undefined => undefined);
            }
        }
        const scores: number[] = episodes.map((e: EpisodeResult): number => e.score);
        const scoreErrors: number = episodes.reduce((a: number, e: EpisodeResult): number => a + (e.scoreErrors ?? 0), 0);
        return {
            mean: scores.length ? scores.reduce((a: number, b: number): number => a + b, 0) / scores.length : 0,
            episodes,
            decisions: episodes.reduce((a: number, e: EpisodeResult): number => a + e.decisions, 0),
            ...(median(engineMs) !== undefined ? { engineMedianMs: median(engineMs) } : {}),
            extractErrors: episodes.reduce((a: number, e: EpisodeResult): number => a + e.extractErrors, 0),
            adviceFieldsDropped: episodes.reduce((a: number, e: EpisodeResult): number => a + e.adviceFieldsDropped, 0),
            ...(scoreErrors > 0 ? { scoreErrors } : {}),
            ...(videoPath ? { videoPath } : {}),
            stopped,
        };
    }

    private async episode(options: PlayOptions, episode: number, seed: number | undefined, allEngineMs: number[]): Promise<EpisodeResult> {
        const { game, profile } = options;
        const extractor: Extractor = new Extractor(profile.extractor, seed);
        const askWhen: Predicate | undefined = profile.askWhen ? new Predicate(profile.askWhen, ["state"], seed) : undefined;
        const logDecision: ((record: DecisionRecord) => void) | undefined = options.hooks?.onDecision;
        const actionIds: string[] = profile.actions.map((a: GameAction): string => a.id);
        const budgetMs: number = options.gameSeconds * 1000;
        const watch: boolean = options.pace === Pace.WATCH;
        const realtime: boolean = options.pace === Pace.REALTIME;
        /** REALTIME and an extractor that makes up for the lag: inputs are held to land at it (a jitter buffer). */
        const holdInputs: boolean = realtime && profile.lagAware === true;
        /** How late held inputs land at the soonest: the lag the version was trained at, where its timing holds. */
        const floorMs: number = holdInputs ? (options.minLagMs ?? liveFloorMs(profile) ?? 0) : 0;

        let extractErrors: number = 0;
        let firstExtractError: string | undefined;
        let adviceFieldsDropped: number = 0;
        let invalidAnswers: number = 0;
        let firstInvalidAnswer: string | undefined;
        let scoreErrors: number = 0;
        const engineMs: number[] = [];
        /** The last ticks (trimmed now and then), and how many were played in all. */
        const ticks: TickRecord[] = [];
        let steps: number = 0;
        const samples: TickRecord[] = [];
        const actionCounts: Record<string, number> = {};
        const window: unknown[] = [];
        const windowInfo: WindowFrameInfo[] = [];
        const firstSeen: Map<string, { atMs: number; example: Record<string, unknown> }> = new Map();
        let gameMs: number = 0;
        /** Wall time the game may have reached by now at its own speed (WATCH). */
        let dueAt: number = Date.now();
        /** REALTIME: the page's clock at the start, and the wall time of the last observation (a tick is timed from it). */
        let clockStart: number | undefined;
        let observedAt: number = Date.now();

        const lags: number[] = [];
        /** Simulated real time: the steps played, each with its own time. */
        let simulatedSteps: number = 0;
        /**
         * How late a decision on the frame being read will act: 0 while the game waits for it; in real
         * time, the engine's recent decisions plus the step that lands the input — for a lag-aware profile
         * the slow end of them, a faster decision waiting for it (below), so the lag the extractor is told is
         * the lag there is, and a time-critical feature describes the world the action meets.
         */
        let lastLag: number = 0;
        /** Real time simulated on the paused clock: the lag each decision lands after its frame, in game time. */
        const simulated: { minMs: number; maxMs: number } | undefined =
            !realtime && options.simulatedLag && options.simulatedLag.maxMs > 0 ? options.simulatedLag : undefined;
        const lagMs: () => number = (): number => {
            if (simulated) {
                lastLag = Math.round(latencyAt({ ...simulated, ...(seed !== undefined ? { seed } : {}) }, gameMs));
                lags.push(lastLag);
                return lastLag;
            }
            if (!realtime) {
                return 0;
            }
            const measured: number = (percentile(allEngineMs.slice(-LAG_WINDOW), holdInputs ? LAG_PERCENTILE : 0.5) ?? options.expectedLagMs ?? DEFAULT_LAG_MS) + STEP_MS;
            // Held inputs wait for it; one played as soon as it is decided cannot land later than it is.
            lastLag = holdInputs ? Math.max(floorMs, measured) : measured;
            lags.push(lastLag);
            return lastLag;
        };
        /**
         * A decision as a row of its game: its seed and, played with a lag, the lag (`DecisionRecord.lag`) — so a row made
         * with one never passes for a paused one where rows are counted by lag (an engine's log is the distiller's data).
         */
        const onDecision: ((record: DecisionRecord) => void) | undefined = logDecision
            ? (record: DecisionRecord): void =>
                logDecision({
                    ...record,
                    ...(seed !== undefined ? { seed } : {}),
                    ...(simulated ? { lag: { minMs: simulated.minMs, maxMs: simulated.maxMs } } : realtime ? { lag: { minMs: lastLag, maxMs: lastLag } } : {}),
                })
            : undefined;

        const observe: (result: StepResult, planInfo?: PlanFrameInfo) => Observed = (result: StepResult, planInfo?: PlanFrameInfo): Observed => {
            let state: unknown;
            const info: ExtractInfo = { ...(planInfo ?? { lagMs: lagMs() }), nowMs: gameMs };
            try {
                if (result.readError) {
                    throw new ScriptError(`reading the page failed: ${result.readError}`);
                }
                const guarded: GuardResult = guardState(extractor.extract(result.raw, info), actionIds);
                state = guarded.state;
                adviceFieldsDropped += guarded.dropped;
            } catch (err: unknown) {
                extractErrors++;
                firstExtractError ??= (err instanceof Error ? err.message : String(err)).slice(0, 300);
                state = { extractorError: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
            }
            if (options.collect) {
                window.push(result.raw);
                // A frame the page could not be read on never reached the extractor: marked, so that a replay skips it too.
                windowInfo.push(result.readError ? { ...info, unread: true } : info);
                if (window.length > options.collect.windowFrames) {
                    window.shift();
                    windowInfo.shift();
                }
                for (const kind of perceivedKinds(game, result.raw)) {
                    if (!firstSeen.has(kind.key)) {
                        firstSeen.set(kind.key, { atMs: gameMs, example: kind.example });
                    }
                }
            }
            if (game.score.expression && result.scoreError !== undefined) {
                // Read as score 0, not over: counted, so a score expression that fails is seen.
                scoreErrors++;
            }
            const reading: ScoreReading = game.score.expression
                ? (result.score ?? {})
                : { over: Boolean((state as { over?: unknown })?.over), score: numberOr((state as { score?: unknown })?.score, 0) };
            return { raw: result.raw, reading, state, signature: stateSignature(state) };
        };

        const step: (request: StepRequest) => Promise<StepResult> = async (request: StepRequest): Promise<StepResult> => {
            if (realtime) {
                // The game runs by itself: the input now, then what is left of the tick in real time (none
                // when the decision took longer), then the reading. Game time is the page's own clock.
                const due: number = observedAt + (request.advanceMs ?? 0);
                let result: StepResult;
                if (request.observe !== false && due > Date.now()) {
                    await this.browser.step({ ...request, advanceMs: 0, observe: false });
                    await sleep(due - Date.now());
                    result = await this.browser.step({ advanceMs: 0 });
                } else {
                    const waitMs: number = (request.waitMs ?? 0) + (request.observe === false ? (request.advanceMs ?? 0) : 0);
                    result = await this.browser.step({ ...request, advanceMs: 0, waitMs: Math.min(waitMs, MAX_STEP_WAIT_MS) });
                    if (waitMs > MAX_STEP_WAIT_MS) {
                        await sleep(waitMs - MAX_STEP_WAIT_MS);
                    }
                }
                observedAt = Date.now();
                if (result.clockMs !== undefined) {
                    clockStart ??= result.clockMs;
                    gameMs = result.clockMs - clockStart;
                }
                return result;
            }
            const result: StepResult = await this.browser.step(request);
            const advanced: number = request.advanceMs ?? 0;
            gameMs += advanced;
            if (watch && advanced > 0) {
                // Not ahead of the game's own speed; behind it (a decision took longer) is not made up for later.
                const target: number = dueAt + advanced;
                const now: number = Date.now();
                if (target > now) {
                    await sleep(target - now);
                    dueAt = target;
                } else {
                    dueAt = now;
                }
            }
            return result;
        };

        /** Simulated lag: inputs decided but not landed yet, in the order they land (game time). */
        const landing: Array<{ at: number; input: StepRequest }> = [];
        /** Runs `ms` of game time, each input landing on its moment; then reads the frame. */
        const runLanding: (ms: number) => Promise<StepResult> = async (ms: number): Promise<StepResult> => {
            const until: number = gameMs + ms;
            while (landing.length > 0 && landing[0].at <= until) {
                const next: { at: number; input: StepRequest } = landing.shift() as { at: number; input: StepRequest };
                if (next.at > gameMs) {
                    await step({ advanceMs: next.at - gameMs, observe: false });
                }
                await step({ ...next.input, advanceMs: 0, observe: false });
            }
            return step({ advanceMs: Math.max(0, until - gameMs) });
        };

        // The game's start (a key to begin, a click), as a player would.
        for (const s of inputSteps(game.start)) {
            await step(s);
        }
        gameMs = 0;
        dueAt = Date.now();
        clockStart = undefined;
        observedAt = Date.now();
        const playStarted: number = Date.now();
        let current: Observed = observe(await step({ advanceMs: 0 }));

        let lastChoice: string | undefined;
        /** The mouse button is held down (the last action held the pointer). */
        let pointerHeld: boolean = false;
        let lastSignature: string | undefined;
        /** Steps in a row the same action was in force with no effect on the state, and that action. */
        let same: number = 0;
        let sameAction: string | undefined;
        let lastEventAt: number = 0;
        let over: boolean = false;
        let stopped: boolean = false;
        let decisions: number = 0;
        const resumes: Resumes = new Resumes(game);
        const maxHoldMs: number = profile.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;

        /** Between rounds the game waits for the player: keys let go and its resume run (rounds.ts). True when it ran. */
        const resumeIfWaiting: () => Promise<boolean> = async (): Promise<boolean> => {
            const resume: StepRequest[] = resumes.stepsAfter(current.reading, pointerHeld);
            if (resume.length === 0) {
                return false;
            }
            for (const s of resume) {
                await step(s);
            }
            pointerHeld = false;
            current = observe(await step({ advanceMs: 0 }));
            return true;
        };

        /**
         * Plan mode (the clock running, a profile with `plan`): a request is always in flight, each answer's
         * plan replaces what the earlier one scheduled from its first moment on, the inputs are played at
         * their moments, and the page is looked at between answers (see plan.ts).
         */
        const playPlans: (config: PlanConfig) => Promise<void> = async (config: PlanConfig): Promise<void> => {
            let schedule: TimedInput[] = [];
            /** What is down now: the last input played. */
            let held: GameAction | undefined;
            /** The answers still to come, oldest request first. */
            let inflight: Array<Promise<PlanOutcome>> = [];
            let requestedAt: number = -Infinity;
            /** When a request read a frame with no state (wall ms): the next one reads again a look later, not at once. */
            let unreadAt: number = -Infinity;
            /** The frame of the plan merged last: an answer about an older frame comes too late to matter. */
            let mergedFrameAt: number = -Infinity;
            /** Plans merged, and the moment from which each of the last ones (as many as can be in flight) changed the schedule. */
            let merged: number = 0;
            const changedFrom: number[] = [];
            const everyMs: number | undefined = options.planEveryMs;
            let lookedAt: number = Date.now();
            let sampledAtMs: number = -Infinity;
            let t: number = 0;
            const byId: (id: string) => GameAction = (id: string): GameAction => profile.actions.find((a: GameAction): boolean => a.id === id) ?? profile.actions[0];
            const leadMs: () => number = (): number =>
                Math.max(config.slotMs, percentile(allEngineMs.slice(-LAG_WINDOW), PLAN_LEAD_PERCENTILE) ?? options.expectedLagMs ?? DEFAULT_PLAN_LEAD_MS) + STEP_MS;

            /** A tick: a plan's on the frame it was asked about (`frame`), an input played on the latest one. */
            const record: (choice: string, asked: boolean, plan?: string[], tookMs?: number, frame?: PlanFrame) => void = (
                choice: string,
                asked: boolean,
                plan?: string[],
                tookMs?: number,
                frame?: PlanFrame
            ): void => {
                const seen: Observed = frame?.observed ?? current;
                const rec: TickRecord = {
                    t: t++,
                    gameMs: frame?.gameMs ?? gameMs,
                    state: seen.state,
                    choice,
                    asked,
                    score: numberOr(seen.reading.score, 0),
                    ...(plan ? { plan } : {}),
                    ...(asked ? {} : { planned: true }),
                };
                ticks.push(rec);
                steps++;
                if (ticks.length > LAST_TICKS * 40) {
                    ticks.splice(0, ticks.length - LAST_TICKS * 20);
                }
                if (gameMs - sampledAtMs >= 1_000) {
                    samples.push(rec);
                    sampledAtMs = gameMs;
                }
                if (asked || Date.now() - lastEventAt >= UNASKED_TICK_EVENT_MS) {
                    lastEventAt = Date.now();
                    options.hooks?.onTick?.({
                        ...rec,
                        episode,
                        decisions,
                        speed: Number((gameMs / Math.max(1, Date.now() - playStarted)).toFixed(2)),
                        ...(tookMs !== undefined ? { engineMs: tookMs } : {}),
                    });
                }
            };

            const play: (action: GameAction) => Promise<void> = async (action: GameAction): Promise<void> => {
                await step({
                    hold: action.keys ?? [],
                    ...(action.pointer || pointerHeld ? { pointer: action.pointer ?? false } : {}),
                    ...(action.click ? { click: action.click } : {}),
                    advanceMs: 0,
                    observe: false,
                });
                pointerHeld = !!action.pointer;
                held = action;
                actionCounts[action.id] = (actionCounts[action.id] ?? 0) + 1;
                record(action.id, false);
            };

            /** Reads the page now; the extractor is told the moments a plan asked for on this frame would have. */
            const look: () => Promise<{ frameAt: number; lead: number }> = async (): Promise<{ frameAt: number; lead: number }> => {
                const result: StepResult = await step({ advanceMs: 0 });
                const frameAt: number = observedAt;
                const lead: number = leadMs();
                const slots: number[] = Array.from({ length: config.slots }, (_: unknown, k: number): number => lead + k * config.slotMs);
                // What will have happened before the plan's first moment: every input not played yet (one that fell due
                // while the page was read is played right after: in 0 ms); inputs from then on, the new plan replaces.
                const pending: PendingInput[] = schedule
                    .filter((s: TimedInput): boolean => s.at < frameAt + lead)
                    .map((s: TimedInput): PendingInput => ({ inMs: Math.max(0, s.at - frameAt), action: s.action.id }));
                current = observe(result, { lagMs: lead, slots, pending });
                lookedAt = Date.now();
                return { frameAt, lead };
            };

            /**
             * Reads the page and sends the plan request; the answer is not waited for (wrapped: an awaited promise would be).
             * None on a frame with no state: nothing to plan from, the schedule stands.
             */
            const request: () => Promise<{ answer: Promise<PlanOutcome> } | undefined> = async (): Promise<{ answer: Promise<PlanOutcome> } | undefined> => {
                const { frameAt, lead } = await look();
                if (isExtractorErrorState(current.state)) {
                    unreadAt = Date.now();
                    return undefined;
                }
                const frame: PlanFrame = { observed: current, gameMs };
                const mergedBefore: number = merged;
                lags.push(lead);
                decisions++;
                const started: number = Date.now();
                const answer: Promise<PlanOutcome> = this.askPlan(game, profile, current.state, config, lead).then(
                    (choices: string[]): PlanOutcome => ({ ...frame, frameAt, leadMs: lead, mergedBefore, choices, ms: Date.now() - started }),
                    (error: unknown): PlanOutcome => ({ error, ms: Date.now() - started })
                );
                return { answer };
            };

            /**
             * From an answer's first moment on, its plan's inputs replace what was scheduled. Not when a plan merged since
             * its frame changed an input before that moment — moved or dropped one this plan was told is coming, or added
             * one: the plan counts on the inputs it was told of, and a later one, told of the change, decides (false).
             */
            const merge: (answer: PlanAnswer) => boolean = (answer: PlanAnswer): boolean => {
                const start: number = answer.frameAt + answer.leadMs;
                // Did a plan merged since its frame change an input before its first moment? Those plans were asked before
                // it, fewer than MAX_PLANS_IN_FLIGHT: what each changed is kept.
                const since: number = merged - answer.mergedBefore;
                if (since > changedFrom.length || changedFrom.slice(changedFrom.length - since).some((at: number): boolean => at < start)) {
                    return false;
                }
                const kept: TimedInput[] = schedule.filter((s: TimedInput): boolean => s.at < start);
                const heldAtStart: GameAction | undefined = kept.length ? kept[kept.length - 1].action : held;
                const now: number = Date.now();
                const slots: TimedInput[] = answer.choices
                    .map((id: string, k: number): TimedInput => ({ at: start + k * config.slotMs, action: byId(id) }))
                    // A late answer: moments already gone are dropped, one just gone is played now.
                    .filter((s: TimedInput): boolean => s.at >= now - config.slotMs / 2)
                    .map((s: TimedInput): TimedInput => ({ ...s, at: Math.max(s.at, now) }));
                const inputs: TimedInput[] = planInputs(slots, heldAtStart);
                // For the plans still in flight: the moment of the first input this replaced or added (none: Infinity).
                const replaced: TimedInput[] = schedule.filter((s: TimedInput): boolean => s.at >= start);
                changedFrom.push(Math.min(...[...replaced, ...inputs].map((s: TimedInput): number => s.at)));
                if (changedFrom.length > MAX_PLANS_IN_FLIGHT) {
                    changedFrom.shift();
                }
                merged++;
                schedule = [...kept, ...inputs];
                return true;
            };

            while (gameMs < budgetMs) {
                if (current.reading.over) {
                    over = true;
                    return;
                }
                if (options.signal?.aborted) {
                    stopped = true;
                    return;
                }
                if (await resumeIfWaiting()) {
                    // The new round is planned afresh: nothing scheduled, and no answer about a frame before it
                    // (dropped unread, so a request goes out now).
                    schedule = [];
                    held = undefined;
                    inflight = [];
                    continue;
                }
                while (schedule.length > 0 && schedule[0].at <= Date.now()) {
                    await play((schedule.shift() as TimedInput).action);
                }
                const nextRequestAt: number = Math.max(
                    unreadAt + PLAN_LOOK_EVERY_MS,
                    inflight.length === 0 ? 0 : everyMs !== undefined && inflight.length < MAX_PLANS_IN_FLIGHT ? requestedAt + everyMs : Infinity
                );
                if (Date.now() >= nextRequestAt) {
                    requestedAt = Date.now();
                    const sent: { answer: Promise<PlanOutcome> } | undefined = await request();
                    if (sent) {
                        inflight.push(sent.answer);
                    }
                    continue;
                }
                const nextAt: number = schedule.length ? schedule[0].at : Infinity;
                const wait: number = Math.max(0, Math.min(nextAt, lookedAt + PLAN_LOOK_EVERY_MS, nextRequestAt) - Date.now());
                const settled: { outcome: PlanOutcome; answer: Promise<PlanOutcome> } | undefined = await Promise.race([
                    ...inflight.map((answer: Promise<PlanOutcome>): Promise<{ outcome: PlanOutcome; answer: Promise<PlanOutcome> }> =>
                        answer.then((outcome: PlanOutcome): { outcome: PlanOutcome; answer: Promise<PlanOutcome> } => ({ outcome, answer }))
                    ),
                    sleep(wait).then((): undefined => undefined),
                ]);
                if (settled) {
                    inflight = inflight.filter((answer: Promise<PlanOutcome>): boolean => answer !== settled.answer);
                    const outcome: PlanOutcome = settled.outcome;
                    if ("error" in outcome) {
                        // An answer that is no action, or rules as code that failed on the frame: the schedule stands.
                        if (!(outcome.error instanceof InvalidAnswerError) && !(outcome.error instanceof ScriptError)) {
                            throw outcome.error;
                        }
                        invalidAnswers++;
                        firstInvalidAnswer ??= outcome.error.message.slice(0, 300);
                        continue;
                    }
                    engineMs.push(outcome.ms);
                    allEngineMs.push(outcome.ms);
                    if (outcome.frameAt > mergedFrameAt && merge(outcome)) {
                        mergedFrameAt = outcome.frameAt;
                        record(outcome.choices[0] ?? held?.id ?? actionIds[0], true, outcome.choices, outcome.ms, outcome);
                    }
                    continue;
                }
                if (Date.now() >= lookedAt + PLAN_LOOK_EVERY_MS && !(schedule.length > 0 && schedule[0].at - Date.now() < PLAN_QUIET_MS)) {
                    await look();
                }
            }
        };

        const plan: PlanConfig | undefined = realtime ? profile.plan : undefined;
        if (plan) {
            await playPlans(plan);
        } else {
            for (let t: number = 0; gameMs < budgetMs; t++) {
                if (current.reading.over) {
                    over = true;
                    break;
                }
                if (options.signal?.aborted) {
                    stopped = true;
                    break;
                }
                if (await resumeIfWaiting()) {
                    // The next round is decided afresh.
                    lastChoice = undefined;
                    lastSignature = undefined;
                    continue;
                }
                // The action in force did nothing when the state did not change: counted while it stays the same action.
                if (current.signature === lastSignature && lastChoice !== undefined) {
                    same = lastChoice === sameAction ? same + 1 : 1;
                    sameAction = lastChoice;
                } else {
                    same = 0;
                    sameAction = undefined;
                }
                lastSignature = current.signature;
                const fruitless: { action: string; times: number } | undefined =
                    same >= 2 && lastChoice !== undefined ? { action: lastChoice, times: same } : undefined;

                // A frame with no state (an extractor error, counted as one) has nothing to answer: the last decision stands.
                const unread: boolean = isExtractorErrorState(current.state);
                let asked: boolean = !unread && lastChoice === undefined;
                if (!asked && !unread) {
                    try {
                        asked = askWhen ? askWhen.test(current.state) : true;
                    } catch {
                        asked = true; // an expression that fails asks
                    }
                }
                let choice: string | undefined = lastChoice;
                let answer: ChoiceAnswer | undefined;
                let tookMs: number | undefined;
                if (asked) {
                    const t0: number = Date.now();
                    answer = await this.decide(game, profile, current.state, fruitless, onDecision).catch((err: unknown): undefined => {
                        // An answer that is no action, or rules as code that failed on the state: the last decision stands.
                        if (err instanceof InvalidAnswerError || err instanceof ScriptError) {
                            invalidAnswers++;
                            firstInvalidAnswer ??= err.message.slice(0, 300);
                            return undefined;
                        }
                        throw err;
                    });
                    tookMs = Date.now() - t0;
                    engineMs.push(tookMs);
                    allEngineMs.push(tookMs);
                    decisions++;
                    if (answer) {
                        choice = answer.choice;
                    }
                    if (holdInputs) {
                        // An early answer waits: its input lands the lag the extractor was told after the frame.
                        const landAt: number = observedAt + lastLag - STEP_MS;
                        if (landAt > Date.now()) {
                            await sleep(landAt - Date.now());
                        }
                    }
                }
                // In force: what was just decided, else the last decision; before the first one, nothing (no input).
                const action: GameAction | undefined =
                    choice === undefined ? undefined : (profile.actions.find((a: GameAction): boolean => a.id === choice) ?? profile.actions[0]);
                let input: StepRequest = {};
                if (action) {
                    const record: TickRecord = {
                        t,
                        gameMs,
                        state: current.state,
                        choice: action.id,
                        asked,
                        ...(fruitless ? { fruitless: true } : {}),
                        score: numberOr(current.reading.score, 0),
                    };
                    ticks.push(record);
                    steps++;
                    if (ticks.length > LAST_TICKS * 40) {
                        ticks.splice(0, ticks.length - LAST_TICKS * 20);
                    }
                    actionCounts[action.id] = (actionCounts[action.id] ?? 0) + 1;
                    if (asked || Date.now() - lastEventAt >= UNASKED_TICK_EVENT_MS) {
                        lastEventAt = Date.now();
                        options.hooks?.onTick?.({
                            ...record,
                            episode,
                            decisions,
                            speed: Number((gameMs / Math.max(1, Date.now() - playStarted)).toFixed(2)),
                            ...(tookMs !== undefined ? { engineMs: tookMs } : {}),
                            ...(answer ? { probabilities: answer.probabilities } : {}),
                        });
                    }
                    if (t % Math.max(1, Math.round(1_000 / profile.tickMs)) === 0) {
                        samples.push(record);
                    }
                    lastChoice = action.id;

                    // Input: the action's keys (and pointer) held — held again, they stay down — and a click only when
                    // just decided: a decision that stands (unasked, or no answer that was an action) does not click again.
                    input = {
                        hold: action.keys ?? [],
                        ...(action.pointer || pointerHeld ? { pointer: action.pointer ?? false } : {}),
                        ...(action.click && answer ? { click: action.click } : {}),
                    };
                    pointerHeld = !!action.pointer;
                }
                if (simulated) {
                    // Real time on the paused clock, as the real loop plays it: the input lands the lag after the frame
                    // it was decided on (at once when nothing was asked), the game running on meanwhile; the next frame
                    // is read once it has landed — a decision is not asked before the last one acted — and a tick has
                    // passed, plus the step's own time (a browser round trip, from the seed).
                    const wait: number = asked ? lastLag : 0;
                    if (action) {
                        landing.push({ at: Math.max(gameMs + wait, landing.length ? landing[landing.length - 1].at : 0), input });
                    }
                    current = observe(await runLanding(Math.max(profile.tickMs, wait) + stepTimeAt(seed, simulatedSteps++)));
                } else if (profile.decideOn === DecideOn.CHANGE) {
                    const before: string = current.signature;
                    const sub: number = Math.max(MIN_SUB_STEP_MS, Math.round(profile.tickMs / 3));
                    let held: number = 0;
                    let first: boolean = true;
                    do {
                        current = observe(await step(first ? { ...input, advanceMs: sub } : { advanceMs: sub }));
                        first = false;
                        held += sub;
                    } while (held < maxHoldMs && current.signature === before && !current.reading.over && gameMs < budgetMs);
                } else {
                    current = observe(await step({ ...input, advanceMs: profile.tickMs }));
                }
            }
        }
        if (current.reading.over) {
            over = true;
        }
        // Keys are let go before the end screen is read: a game over screen may wait for a release.
        await this.browser.step({ hold: [], ...(pointerHeld ? { pointer: false } : {}), observe: false }).catch((): void => undefined);

        let endScreenshot: string | undefined;
        if (options.screenshotDir && (over || episode === options.episodes || stopped)) {
            // Named for its game too (the seed asked for, when the page is not seeded): games played at once into one folder
            // must not overwrite each other's end screen, and the screenshot tool names a file only to the second.
            const named: number | undefined = seed ?? (options.seeds?.length ? options.seeds[(episode - 1) % options.seeds.length] : undefined);
            endScreenshot = await this.browser
                .screenshot(options.screenshotDir, `episode-${episode}${named !== undefined ? `-seed${named}` : ""}-end`)
                .catch((): undefined => undefined);
        }
        let novel: NovelThing[] | undefined;
        if (options.collect?.noveltyAfterMs !== undefined) {
            novel = [...firstSeen.entries()]
                .filter(([, v]: [string, { atMs: number }]): boolean => v.atMs > (options.collect?.noveltyAfterMs ?? Infinity))
                .map(([key, v]: [string, { atMs: number; example: Record<string, unknown> }]): NovelThing => ({
                    key,
                    firstSeenAtS: Number((v.atMs / 1000).toFixed(1)),
                    example: v.example,
                }));
        }
        // A few decisions spread over the whole game (samples were taken about once a game second).
        const every: number = Math.max(1, Math.floor(samples.length / SAMPLES_PER_EPISODE));
        const spread: TickRecord[] = samples.filter((_: TickRecord, i: number): boolean => i % every === 0).slice(0, SAMPLES_PER_EPISODE);
        return {
            episode,
            ...(seed !== undefined ? { seed } : {}),
            score: numberOr(current.reading.score, 0),
            over,
            gameSeconds: Number((gameMs / 1000).toFixed(1)),
            wallSeconds: Number(((Date.now() - playStarted) / 1000).toFixed(1)),
            steps,
            decisions,
            actionCounts,
            lastTicks: ticks.slice(-LAST_TICKS),
            samples: spread,
            extractErrors,
            ...(firstExtractError !== undefined ? { firstExtractError } : {}),
            adviceFieldsDropped,
            invalidAnswers,
            ...(firstInvalidAnswer !== undefined ? { firstInvalidAnswer } : {}),
            ...(scoreErrors > 0 ? { scoreErrors } : {}),
            ...(median(engineMs) !== undefined ? { engineMedianMs: median(engineMs) } : {}),
            ...(median(lags) !== undefined ? { lagMs: median(lags) } : {}),
            finalReading: current.reading,
            ...(endScreenshot ? { endScreenshot } : {}),
            ...(options.collect && over ? { failureWindow: [...window], failureInfo: [...windowInfo] } : {}),
            ...(novel ? { novel } : {}),
            ...(stopped ? { stopped: true } : {}),
        };
    }

    /**
     * One plan: a question per moment the state predicts (`state.slots`), in one request; the answers
     * up to the first that is not an offered action. A state without predictions gets one decision, for
     * the plan's first moment.
     */
    private async askPlan(game: GameDefinition, profile: Profile, state: unknown, config: PlanConfig, leadMs: number): Promise<string[]> {
        const criteria: Record<string, string> = Object.fromEntries(profile.actions.map((a: GameAction): [string, string] => [a.id, a.description]));
        const ids: string[] = profile.actions.map((a: GameAction): string => a.id);
        const predicted: unknown = (state as { slots?: unknown } | null)?.slots;
        const n: number = Array.isArray(predicted) ? Math.min(predicted.length, config.slots) : 0;
        if (n === 0) {
            const response: { answers: Record<string, unknown> } = await this.engine.ask(
                { game: state },
                { action: { type: "choice", criteria, instructions: { goal: game.goal, instructions: profile.instructions } } }
            );
            return [validateChoice(response.answers?.action, ids).choice];
        }
        const questions: Record<string, Question> = {};
        for (let k: number = 1; k <= n; k++) {
            questions[planQuestionId(k)] = {
                type: "choice",
                criteria,
                instructions: { goal: game.goal, instructions: `${profile.instructions}${planInstructions(n, config.slotMs, leadMs)} This question: slot ${k}.` },
            };
        }
        const response: { answers: Record<string, unknown> } = await this.engine.ask({ game: state }, questions);
        const choices: string[] = [];
        for (let k: number = 1; k <= n; k++) {
            try {
                choices.push(validateChoice(response.answers?.[planQuestionId(k)], ids).choice);
            } catch (err: unknown) {
                if (k === 1 || !(err instanceof InvalidAnswerError)) {
                    throw err;
                }
                break;
            }
        }
        return choices;
    }

    /** One decision: the state and the actions (an ignored one marked), the goal and the rules. */
    async decide(
        game: GameDefinition,
        profile: Profile,
        state: unknown,
        fruitless?: { action: string; times: number },
        onDecision?: (record: DecisionRecord) => void
    ): Promise<ChoiceAnswer> {
        const question: DecisionQuestion = decisionQuestion(game, profile, fruitless);
        const { criteria, instructions } = question.action;
        const ids: string[] = profile.actions.map((a: GameAction): string => a.id);
        for (let attempt: number = 0; ; attempt++) {
            const started: number = Date.now();
            const response: { answers: Record<string, unknown> } = await this.engine.ask({ game: state }, question);
            try {
                const answer: ChoiceAnswer = validateChoice(response.answers?.action, ids);
                onDecision?.({ state, criteria, instructions, ...answer, ms: Date.now() - started });
                return answer;
            } catch (err: unknown) {
                if (!(err instanceof InvalidAnswerError) || attempt >= INVALID_ANSWER_RETRIES) {
                    throw err;
                }
            }
        }
    }
}
