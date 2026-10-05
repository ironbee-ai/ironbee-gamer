/**
 * What the trainer is asked. Two prompts, both from the research that made
 * the built-in profiles (research/KNOW-HOW.md):
 *
 * - SETUP, once per new game: here is what the page draws (a raw sample,
 *   sprite crops, a screenshot) — write the first extractor and the actions.
 * - TUNE, every iteration: here is how the best profile played (scores, the
 *   last decisions before each end, end screens, failure windows, things seen
 *   for the first time) — write a better one, and regression tests that pin
 *   the fix down.
 *
 * The division of labor is stated in both: the state carries features, the
 * engine makes every decision. Fields that carry the answer are stripped
 * before the engine sees a state, and the tuner is told how many were.
 */

import { MIN_PAUSED_TICK_MS, pausedTickMs } from "../game/configs";
import { rawFormat } from "../game/open";
import { GameDefinition, Perception, PlanConfig, Profile, RegressionTest } from "../game/types";
import { EpisodeResult } from "../play/player";
import { CALL_TIMEOUT_MS } from "../play/sandbox";

/** What a teacher aims to take a call: a tenth of its limit, since a machine busy fine-tuning runs a search slower. */
const TEACHER_TARGET_MS: number = Math.round(CALL_TIMEOUT_MS / 10);

/** A teacher's time, in every prompt that asks for one: a single call past the sandbox's limit fails, as a throw does. */
export const TEACHER_TIME: string = `It has ${CALL_TIMEOUT_MS} ms a call — a call that takes longer fails, as a throw does — so aim for ${TEACHER_TARGET_MS} ms or less.`;

/** A frame the extractor makes no state of, in every prompt that asks for a teacher: never given to it, not its failure. */
export const NO_STATE_FRAMES: string =
    'A frame the extractor makes no state of (the page could not be read, or extract threw) is never given to it: that state is only { "extractorError": "<why>" }, nothing is decided on it (the last decision stands) and it counts as an extractor error, not as the teacher failing.';

/** Training for real-time play: the clock is never paused, and a decision acts `minMs`–`maxMs` after its frame. */
export interface RealtimeTraining {
    minMs: number;
    maxMs: number;
    /**
     * Real time simulated on the paused clock: the player decides every max(tickMs, lag) of game time,
     * whatever decideOn says (no "change", no maxHoldMs).
     */
    simulated?: boolean;
    /** Simulated over a range: each seed is played at each of these lags (ms), and a version is measured over them all. */
    points?: number[];
    /** Live, as the game is played live: each seed played this many times for real, the inputs held to `minMs`. */
    live?: { gamesPerSeed: number };
    /** Plan mode: one request decides the next moments (the engine is slower than the game). */
    plan?: PlanConfig;
}

/** What the extractor must do in plan mode: predict each moment of the plan. */
function planRule(plan: PlanConfig): string {
    return (
        ` PLAN MODE: the engine is too slow to decide every moment, so one request decides a plan — an action for each of the next ${plan.slots} moments, ${plan.slotMs} ms apart — while the game runs on. ` +
        `\`info.slots\` lists, for each moment, how many ms after this frame its action takes effect (info.slots[0] is info.lagMs); \`info.pending\` lists the inputs earlier plans scheduled that have not taken effect yet, as {inMs, action}: apply them before predicting: each moment shows the game as those inputs will have left it. ` +
        `\`info.nowMs\` is the game time of this frame: frames are NOT evenly spaced now, so measure speeds per millisecond between frames, never per frame. ` +
        `When info.slots is given, return beside the present state a field \`slots\`: one object per moment, each with exactly the fields of the present state, describing the game as it will be at that moment given the pending inputs and no other new input. ` +
        `The rules decide each moment from its own object — teach(slot) is called once per moment — and a plan plays at most one change: its first moment whose action changes something (a click, keys going down or up) and, when that pressed keys, their release back to what was held; the next plan, told of those inputs as pending, decides the rest. ` +
        `So a moment's object must say whether acting AT THAT MOMENT is right. Without info.slots (the clock paused), return the present state only; the same rules must play it. ` +
        `In the evidence, a tick with \`plan\` is a request (its frame's state and the plan answered for it, one action per moment) and a tick with \`planned: true\` is an input a plan played at its moment — askWhen is not used in plan mode.`
    );
}

/** What the extractor must do when the game does not wait: the world the action meets, not the one it was read in. */
function realtimeRule(realtime: RealtimeTraining): string {
    // Simulated, a decision lands exactly the engine's time after its frame: no step on top.
    const late: string = realtime.simulated ? "the engine's time" : "the engine's time plus the step that lands the input";
    return (
        `REAL TIME: these games run with the clock never paused, as a person plays them — the game does not wait for a decision. ` +
        (realtime.live
            ? `These games are played live, for real, as the game is played live: each seed ${realtime.live.gamesPerSeed} times, ${realtime.maxMs > realtime.minMs ? `each game's inputs held to land no sooner than its own floor, from ${realtime.minMs} to ${realtime.maxMs} ms after their frame (as a slower engine, or a busy machine, lands them)` : `every input landing no sooner than ${realtime.minMs} ms after its frame`} — and later when a decision takes longer, so the lag varies a little from decision to decision (every game's lagMs is its median). A version is measured over all of them: a seed lost in some of its games and won in others is a timing the state gets wrong — what the frame shows a few milliseconds earlier or later must lead to the same decision. `
            : realtime.points
                ? `A decision made on a frame takes effect ${realtime.minMs}–${realtime.maxMs} ms later (${late}), and the game has moved on by then. Each seed is played once at each of ${realtime.points.join(", ")} ms (every game's lagMs says which), and a version is measured over all of them: live, the lag is wherever the engine's time puts it in that range, so a version must play every seed well at every one of these lags — a seed lost at one lag and won at another is a timing the state gets wrong. `
                : realtime.maxMs > realtime.minMs
                    ? `A decision made on a frame takes effect ${realtime.minMs}–${realtime.maxMs} ms later (${late}) — a different lag in every game, drifting within one as the engine slows down and speeds up — and the game has moved on by then; `
                    : `A decision made on a frame takes effect about ${realtime.minMs} ms later (${late}), and the game has moved on by then; `) +
        `\`info.lagMs\` gives the extractor the current lag on every frame — never assume one. Compute every time-critical feature — distances, how soon things happen, angles, where moving things are — ` +
        `as of now + info.lagMs, from the speeds you measure (memory keeps earlier frames). With lagMs 0 the state must be exactly what the frame shows, so the same rules serve a player that pauses the game.` +
        (realtime.plan ? planRule(realtime.plan) : "")
    );
}

export interface SetupPromptInput {
    game: GameDefinition;
    /** Ask for the rules as code too (`teach(state)`): the rules decide while training, a small model learns them. */
    withTeacher?: boolean;
    /** The games are played in real time. */
    realtime?: RealtimeTraining;
    /** Files in the work directory the trainer may Read, with what each is. */
    files: Array<{ path: string; what: string }>;
    /** Notes from the person training the game (userNoteRule). */
    userNote?: string;
}

/** The most a training's notes may hold: they go into every prompt of it. */
export const MAX_USER_NOTE_CHARS: number = 2000;

/**
 * Notes from the person training the game — what they saw it do, or want it to do — for the trainer to act on. They cannot
 * change how a version is judged (it is kept only when it scores higher) nor the division of labor.
 */
function userNoteRule(note: string | undefined): string {
    const text: string | undefined = note?.trim();
    if (!text) {
        return "";
    }
    return (
        `NOTES FROM THE PERSON TRAINING THIS GAME — what they saw it do, or want it to do; act on them in this version:\n<<<\n${text.slice(0, MAX_USER_NOTE_CHARS)}\n>>>\n` +
        "A version is still kept only when it scores higher (and plays no worse with the clock paused when trained for real time) and passes the regression tests: " +
        "follow the notes as far as the evidence allows, and say in your analysis how you did — or, where the scores show they cost points, why you could not. " +
        "They never change the division of labor: the state carries features, never the answer.\n\n"
    );
}

export function setupPrompt(input: SetupPromptInput): string {
    const { game } = input;
    const perception: string =
        game.perception.adapter === Perception.CANVAS2D
            ? "Every frame, a generic recorder hooked into the page's 2D canvas API gives the list of what was drawn"
            : game.perception.adapter === Perception.PHASER && !game.perception.read
                ? "Every step, a generic Phaser engine adapter gives a dump of what the engine holds (it knows nothing about this game)"
                : game.perception.adapter === Perception.PIXI && !game.perception.read
                    ? "Every step, a generic PixiJS adapter gives a dump of the display tree the game renders (it knows nothing about this game)"
                    : game.perception.adapter === Perception.COCOS && !game.perception.read
                        ? "Every step, a generic Cocos engine adapter gives a dump of the scene the game runs (it knows nothing about this game)"
                        : game.perception.adapter === Perception.PIXELS
                            ? "Every step, the game's canvas is read as a small colour grid (nothing on this page says what is drawn). Find things by " +
                              "their colours, as the screenshots show them: the cells of a colour and their bounding boxes, a colour's centre or lowest " +
                              "row. Keep the state small — positions, distances, counts, never the grid itself"
                            : "Every step, the game's own reader gives its raw input (the game's state as its code keeps it)";
    return `You are setting up a fast game-playing loop for a browser game you have never seen the code of.

GOAL (the game's instructions, from the player): "${game.goal}"

${perception}. Its format: ${rawFormat(game)}

Files for you to Read (in the current directory):
${input.files.map((f: { path: string; what: string }): string => `  - ${f.path}: ${f.what}`).join("\n")}
Look at the screenshot and the samples to learn what each thing is.

The decision engine is fast (a few hundred ms) but text-only, and weak at spatial reasoning over raw coordinates and at arithmetic: it does best choosing from a few options, following rules written as simple comparisons of named fields. So give it decision-ready FEATURES: distances, how soon things happen, what is possible now, the predicted outcome of each action, progress, whether the game is over.

DIVISION OF LABOR (strict): the state carries features, never the answer. No field may name or recommend an action (fields like recommended/advice/bestAction/nextAction/should…, or any field whose value is an action id, are stripped before the engine sees the state). The rules that map features to actions go in "notes".

Write \`function extract(raw, memory, info)\` returning a small plain JSON state (no functions, no cycles), run once per decision. \`memory\` is an object that persists across the decisions of one game (velocities, counters, what was seen before); \`info.lagMs\` is how many ms after this frame the decision takes effect (0 when the game waits for every decision); \`info.nowMs\` is the game time of this frame in ms (it may be missing on a replay: then frames are tickMs apart). It runs in a bare JavaScript sandbox: no DOM, no console, no require — plain JavaScript and its built-ins only. Keep it well under 5 ms. Handle things you have not seen yet (a new kind of object, other score digits): report an unknown thing with its position and size rather than dropping it, and never report decoration (backgrounds, effects, the score display) as something that matters to play.
Also give the action set: a small list of discrete choices; each has "keys" (keys held while the action is in force; [] holds nothing) or "click": true (one click on the game's centre) or "click": {"x": 0.25, "y": 0.5} (one click at that point, as fractions of the game's width and height) or "pointer": true / {"x", "y"} (the mouse button held down there while the action is in force; any other action lets it go — for an input that acts while it is held, or on its release).

${input.withTeacher ? `
Also write the rules as code: \`function teach(state) { … }\` returns the action id your rules choose for a state (or probabilities by action id where they leave it open). Two things a small model learns badly: a counter that only grows as the game goes on (items collected, the score, a level number, frames played) lets it act on WHEN it is — at the 37th item, this action — instead of on the situation the rules look at, so keep such counters out of the state unless a rule truly needs one; and where two or more actions are equally good (the same outcome either way), return probabilities that share between them ({\"a\": 0.5, \"b\": 0.5} for two actions a and b) rather than one pick — a single pick teaches it an arbitrary tie-break that then counts as a mistake. It runs in the same bare sandbox, once per state, with no memory — so whatever a rule needs from earlier frames must already be a state field. Where the right move depends on more than the next moment — other things moving at the same time, an action whose result shows only later — let it search: a breadth-first search over the positions that can be reached, or a short lookahead over the actions. ${TEACHER_TIME} ${NO_STATE_FRAMES} While the profile is trained, the teacher plays; afterwards a small local model is fine-tuned to make the same choices from the state alone, and plays live. The teacher and your notes are the same rules: code and words. That model reads at most ~1000 tokens of state (JSON as text), and the shorter the better: keep the state to a few dozen named fields — no raw grids, no long per-object or per-option lists; summarise them into the fields the rules compare (for a choice among many options, the predicted outcome of each ACTION, not of every option).
` : ""}
${input.realtime ? `${realtimeRule(input.realtime)}\n\n` : ""}${userNoteRule(input.userNote)}Reply with ONLY a JSON object, no prose, no code fence:
{"extractor": "<the full source of function extract(raw, memory, info) {...}>", "actions": [{"id": "...", "description": "...", "keys": []}], "notes": "<the rules the engine should apply, in terms of your state fields, a few sentences>", "tickMs": <game ms per decision; 96 unless the game needs finer control; a multiple of 16, ${MIN_PAUSED_TICK_MS} at least (a shorter one is raised to it): the page draws a frame every 16 ms of game time, so each decision then sees the same number of frames>${input.withTeacher ? `, "teacher": "<the full source of function teach(state) {...}>"` : ""}}`;
}

export interface TunePromptInput {
    game: GameDefinition;
    engineLabel: string;
    /** The profile's teacher decides while training (it is then distilled into a small local model). */
    rules?: boolean;
    /** The games are played in real time. */
    realtime?: RealtimeTraining;
    engineMedianMs?: number;
    gameSeconds: number;
    best: Profile;
    bestResult: TuneEvidence;
    /** The latest version tried and not kept, and why it was not. */
    latest?: { profile: Profile; result: TuneEvidence; why?: string };
    history: Array<{ version?: number; mean: number | null; kept?: boolean; note?: string }>;
    windows: Array<{ id: string; frames: number; seed?: number; unread?: number[] }>;
    tests: RegressionTest[];
    /** Files in the work directory the trainer may Read. */
    files: Array<{ path: string; what: string }>;
    repair?: Array<{ test: RegressionTest; failedAt?: unknown }>;
    /** The reply that failed the tests in `repair`, as a profile and its new tests. */
    attempted?: { profile: Profile; newTests: RegressionTest[] };
    trainedHorizonS?: number;
    /** Notes from the person training the game (userNoteRule). */
    userNote?: string;
}

/** What a tuner is shown of a played profile. */
export interface TuneEvidence {
    mean: number;
    extractErrors: number;
    adviceFieldsDropped: number;
    episodes: Array<
        Pick<
            EpisodeResult,
            | "episode"
            | "seed"
            | "lagMs"
            | "score"
            | "over"
            | "gameSeconds"
            | "decisions"
            | "actionCounts"
            | "firstExtractError"
            | "invalidAnswers"
            | "firstInvalidAnswer"
            | "lastTicks"
            | "samples"
            | "novel"
        > & {
            endScreenshot?: string;
        }
    >;
}

/**
 * The profile as the tuner reads and writes it: what it may change. The teacher only when the rules decide
 * (`withTeacher`): with the engine deciding, one copied back would pass for rewritten, and a teacher written
 * for another state would be kept.
 */
export function tunableProfile(profile: Profile, withTeacher: boolean): Record<string, unknown> {
    return {
        instructions: profile.instructions,
        extractor: profile.extractor,
        actions: profile.actions,
        decideOn: profile.decideOn,
        // As it is played with the clock paused, and as a version kept from it is saved: the shortest tick at least.
        tickMs: pausedTickMs(profile),
        ...(profile.maxHoldMs !== undefined ? { maxHoldMs: profile.maxHoldMs } : {}),
        ...(profile.askWhen ? { askWhen: profile.askWhen } : {}),
        ...(withTeacher && profile.teacher ? { teacher: profile.teacher } : {}),
    };
}

export function tunePrompt(input: TunePromptInput): string {
    const { game } = input;
    const withTeacher: boolean = input.rules === true;
    const ms: string = input.engineMedianMs ? `~${Math.round(input.engineMedianMs)} ms` : "a few hundred ms";
    const decideOn: string = `decideOn "tick": after each action the game runs tickMs of game time. decideOn "change": the action is held while the game runs in small steps, until the state changes (fields whose names contain tick/count/time/age/frame are ignored), at most maxHoldMs.`;
    // Simulated real time decides on a schedule of its own: decideOn and maxHoldMs count only with the clock paused.
    const timing: string = input.realtime?.simulated
        ? `In these games decideOn and maxHoldMs are not used: a decision is made every max(tickMs, info.lagMs) of game time, never before the last one has landed. They are used when a version plays with the clock paused (it is checked that way too): ${decideOn}`
        : decideOn;
    return `You are tuning an automated player for a browser game. It works like this:
- DIVISION OF LABOR (strict): you shape the logic (what the state computes) and the rules (the instructions); the decision engine makes every decision at play time by applying your rules to the state. So the state carries FEATURES (distances, how soon things happen, what is possible now, predicted outcomes of each action, …) and NEVER the answer: no field may name or recommend an action (fields like recommended/advice/bestAction, or any field whose value is an action id, are stripped before the engine sees the state and counted as adviceFieldsDropped). The rule that maps features to an action belongs in the instructions, written so the engine can apply it with simple comparisons of named fields.
- Every decision, a PERCEPTION step turns the game into a small JSON state: \`function extract(raw, memory, info)\` (JavaScript in a bare sandbox: no DOM, no console, no require) over the raw input. \`memory\` persists across the decisions of one game (use it for velocities, counters, etc); \`info.lagMs\` is how many ms after this frame the decision takes effect (0 when the game waits for every decision); \`info.nowMs\` is the game time of this frame in ms. A frame it makes no state of (it throws, or the page could not be read) is not decided on — the last decision stands — and is counted in extractErrors (the first error in an episode's firstExtractError; the frame's state reads { "extractorError": "<why>" }).
${input.rules
        ? `- Every decision is made by your TEACHER, \`function teach(state)\` (JavaScript in a bare sandbox, NO memory between calls: what a rule needs from earlier frames must be a state field), returning an action id (or probabilities by action id where your rules leave it open). Where the right move depends on more than the next moment (other things moving at the same time, an action whose result shows only later), it may search (a breadth-first search over the positions that can be reached, a short lookahead over the actions). ${TEACHER_TIME} It plays every game you are shown. Afterwards a small local model (Laya) is fine-tuned to make the same choices from the state alone and plays live in a few tens of milliseconds — so the state must carry everything the rules use, as plain named fields, and prefer categorical fields ("ok"/"late", true/false) over raw numbers the model would have to compare. Keep counters that only grow as the game goes on (items collected, the score, a level number, frames played) out of the state unless a rule truly needs one — the model would act on WHEN it is instead of on the situation — and where actions are equally good, share the probability between them instead of picking one (a single pick teaches an arbitrary tie-break). The model reads at most ~1000 tokens of state, and the shorter the better: a few dozen fields, no raw grids or long lists (summarise a choice among many options into the predicted outcome of each ACTION). Write the rules twice: as code in "teacher" (what decides) and in words in "instructions" (the same rules, for people and for a text engine). It must answer every state it is given: where it throws or answers no action, the last decision stands (counted in an episode's invalidAnswers, the first error in firstInvalidAnswer), and a version whose teacher fails on any state of its games is not kept. ${NO_STATE_FRAMES}`
        : `- A fast DECISION ENGINE (${input.engineLabel}, ${ms} per decision) sees { game: <that state> }, the goal, your INSTRUCTIONS text, and the ACTIONS (id + description), and picks one action. It is text-only; it follows clear rules written in terms of state fields well, but it does not do arithmetic or spatial reasoning reliably — compute what a rule needs in the extractor and give it a named field. Rules must name fields that exist in the state.`}
- ${input.realtime ? realtimeRule(input.realtime) : "The game's clock is frozen while deciding, so decision speed costs no game time."} The page runs an animation frame every 16 ms of game time: a tickMs that is a multiple of 16 gives every decision the same number of frames (33 ms would give one decision in 16 three frames). tickMs is at least ${MIN_PAUSED_TICK_MS} (two frames; a shorter one is raised to it): a decision takes the engine that plays live about that long, and a game watched at its own speed must not fall behind it — where a moment between two decisions matters, the state must say so a decision ahead. An episode ends when the game is over or its game-time budget (${input.gameSeconds} s) runs out; the number of decisions is not limited. ${timing}
- Optional askWhen: a JavaScript expression over \`state\`. When it is false the engine is not asked and its last decision stays in force (keys stay held; a click is not repeated). Every decision costs wall time, so a game watched live plays much smoother when calm stretches skip the engine — but askWhen must be true at every moment where the choice matters, and it names no action. Omit it (null) when in doubt.
- Input: an action with "keys" holds those keys; keys chosen again next decision stay held (not re-pressed); other keys are released. An action with "click": true clicks the game's centre once; "click": {"x", "y"} clicks that point (fractions of the game's width and height). An action with "pointer": true (or {"x", "y"}) holds the mouse button down there while it is in force; choosing another action releases it. When the same action is chosen with no change in the state twice or more, its description is marked as ignored by the game.

GAME: ${game.goal}
SCORE: ${game.score.label} (measured from the game's own state; you never see that reading as a state field).
RAW INPUT FORMAT: ${rawFormat(game)}
FILES you may Read (in the current directory):
${input.files.map((f: { path: string; what: string }): string => `  - ${f.path}: ${f.what}`).join("\n")}

HISTORY OF VERSIONS TRIED (mean score each): ${JSON.stringify(input.history)}
${input.trainedHorizonS ? `\nThe best profile was trained on games of ${input.trainedHorizonS} s; these games run up to ${input.gameSeconds} s. Things perceived for the first time after ${input.trainedHorizonS} s are listed per episode as "novel" (with a crop where there is one): later phases of the game it has never seen.\n` : ""}
BEST PROFILE SO FAR (mean score ${input.bestResult.mean}):
${JSON.stringify(tunableProfile(input.best, withTeacher))}
ITS RESULTS: ${JSON.stringify(input.bestResult)}
${input.latest ? `\nLATEST PROFILE TRIED (mean score ${input.latest.result.mean}; NOT KEPT: ${input.latest.why ?? "it did not beat the best"}):\n${JSON.stringify(tunableProfile(input.latest.profile, withTeacher))}\nITS RESULTS: ${JSON.stringify(input.latest.result)}\n` : ""}
SAVED FAILURE WINDOWS (the raw frames the extractor saw last before a game ended, replayable offline): ${JSON.stringify(input.windows)}
EXISTING REGRESSION TESTS (a new profile must keep passing them): ${JSON.stringify(input.tests)}
${input.repair ? `\nYOUR PREVIOUS ATTEMPT FAILED THESE REGRESSION TESTS. The existing tests always run and cannot be changed: fix the profile so they pass. A test of your own (in newTests) that was wrong you may rewrite or leave out.\n${JSON.stringify(input.repair).slice(0, 20_000)}\n${input.attempted ? `THAT ATTEMPT (its profile and new tests):\n${JSON.stringify({ ...tunableProfile(input.attempted.profile, withTeacher), newTests: input.attempted.newTests })}\n` : ""}` : ""}
${userNoteRule(input.userNote)}Study the runs: what caused each game to end or stall? Is it the state (missing / wrong / hard-to-use fields, perception bugs), the instructions (wrong or unclear rule), the actions, or the timing (tickMs / decideOn)? Then write an improved profile, starting from the best one. Change what the evidence points to; keep what works.
Where you fix a failure, add regression tests that pin the fix down. A test runs the extractor over one saved window from its first frame (fresh memory; the first 3 frames are warm-up) and checks a JavaScript expression over \`state\` (and \`choice\`, the engine's decision, only if needsChoice) at the given frames ("all", or a list of frame indices). Tests may only name the windows listed above; a window's \`unread\` frames are ones the page could not be read on — the extractor never saw them, so a test checks nothing there.

Reply with ONLY a JSON object, no prose, no code fence:
{"analysis": "<what went wrong and what you changed, 2-4 sentences>", "instructions": "...", "extractor": "<full source of function extract(raw, memory, info) {...}>", "actions": [{"id": "...", "description": "...", "keys": [...] } or {"id": "...", "description": "...", "click": true | {"x": 0.25, "y": 0.5}} or {"id": "...", "description": "...", "pointer": true | {"x": 0.5, "y": 0.5}}], "decideOn": "tick" | "change", "tickMs": <number>, "maxHoldMs": <number>, "askWhen": "<expression over state>" | null,${input.rules ? ` "teacher": "<full source of function teach(state) {...}>",` : ""} "newTests": [{"window": "<id>", "ticks": "all" | [..], "needsChoice": false, "expect": "<expression over state (and choice)>", "why": "..."}]}`;
}
