/**
 * A game and the profile that plays it.
 *
 * The GAME says only how to reach, start and measure it — never how to play.
 * The PROFILE is how to play it, written by an LLM and tuned from the games it
 * plays: the perception script that turns the page into a small state, the
 * rules the decision engine applies, and the actions. The engine makes every
 * live decision; the state carries features, never the answer.
 */

import { PixelGrid, Viewport } from "../devtools/protocol";
import { EngineKind } from "../engine/types";

export enum Perception {
    /** The 2D-canvas draw recorder: any game drawn with a 2D canvas. */
    CANVAS2D = "canvas2d",
    /** The Phaser engine adapter: any Phaser game. */
    PHASER = "phaser",
    /** The PixiJS adapter: any game drawn with PixiJS loaded as the PIXI global (WebGL or canvas). */
    PIXI = "pixi",
    /** The Cocos adapter: any game on the Cocos engine (Creator 2.x / 3.x, cocos2d-js), read from the `cc` global. */
    COCOS = "cocos",
    /** Pixel perception: the largest canvas as a small colour grid — any game a canvas shows, less exact. */
    PIXELS = "pixels",
    /** The game's own page script (`script`) and read expression (`read`). */
    CUSTOM = "custom",
}

export interface GamePerception {
    adapter: Perception;
    /** Phaser: include the tilemaps in the dump. */
    maps?: boolean;
    /** Custom: a page script in the game's directory, installed before the page runs. */
    script?: string;
    /**
     * Custom: the page expression that reads the raw input. Phaser: one that reads the game's own
     * state instead of the generic dump (`window.__ibgamer.phaser.game()` is the game), the adapter
     * still installed (seeded RNG, frame-exact boot).
     */
    read?: string;
    /** What that raw input looks like, in words (for the tuner). */
    format?: string;
    /** Pixels: the grid's size, `width` cells across (default 64), `height` down (default: the canvas's aspect). */
    grid?: PixelGrid;
}

/** One input step of a game's start: keys pressed / held, a click, then time. */
export interface InputStep {
    press?: string[];
    /**
     * A page expression naming the keys held for this step, released by the next (after a last step, before
     * play; the next step's own `hold` keys stay down) — a key name, a list, or nothing: a start or resume step
     * whose way on depends on the page — a menu, a world map drawn from the seed.
     */
    holdFrom?: string;
    hold?: string[];
    click?: boolean | { x: number; y: number };
    /**
     * Real time waited after the input, the clock still frozen (ms): what runs in real time — a CSS
     * animation the game starts on the end of (an intro) — then ends at the same game time in every run.
     */
    waitMs?: number;
    /** Game time run after the input (ms). */
    advanceMs?: number;
}

export interface GameScore {
    /**
     * Page expression returning `{ over, score, … }`, read for measuring only:
     * never shown to the decision engine, never to the tuner as a field to use.
     * `waiting: true` says the game waits for the player between rounds: its `resume` inputs run.
     */
    expression?: string;
    /**
     * No expression: the state's own `over` / `score` fields are the measure.
     * Self-reported — a tuner could inflate it — so a game should give an expression when it can.
     */
    fromState?: boolean;
    /** What the score counts, e.g. "distance", "walls passed". */
    label: string;
    /** The most a game can score (100 % of a level, say): a game that reaches it is won, and training stops there. */
    max?: number;
}

export interface GameBudgets {
    /** Game time per episode (s). */
    gameSeconds: number;
    episodes: number;
    /** Game time per training episode (s); defaults to gameSeconds. */
    trainSeconds?: number;
}

export interface GameDefinition {
    /** Directory name in the library: lowercase letters, digits and dashes. */
    id: string;
    name: string;
    description?: string;
    url: string;
    /** The game's own instructions, as a player reads them: the goal every decision is asked under. */
    goal: string;
    perception: GamePerception;
    viewport?: Viewport;
    /** Game time the page boots in, frame by frame, before the first step (ms). */
    bootMs?: number;
    start?: InputStep[];
    /**
     * What takes the game on when it waits for the player between rounds (a level's end screen that
     * asks for a click): run as a player would, whenever the score expression reports `waiting`.
     */
    resume?: InputStep[];
    score: GameScore;
    /** CSS selector a click action clicks the centre of (default: the first canvas). */
    clickTarget?: string;
    /**
     * CSS added to the game's page once it has loaded — a settings panel, a page header, instructions
     * hidden, the game made larger — so the live view and the videos show the game. Looks only: the game
     * plays the same.
     */
    pageStyle?: string;
    /**
     * The game moves things with CSS animations or transitions: they are held and run on game time with
     * the clock, instead of in real time while the game waits for a decision. Off for a game whose CSS
     * only decorates, or whose start waits for a CSS animation in real time (`waitMs`).
     */
    animationClock?: boolean;
    /** Whether seeding Math.random reproduces a course (default true). */
    seedable?: boolean;
    budgets: GameBudgets;
    /** The seeds training compares profile versions on. */
    trainSeeds?: number[];
    /** Seeds a kept version must not play worse on, never shown to the tuner (default 1001, 2002, 3003). */
    testSeeds?: number[];
    tags?: string[];
    /** Who made the game (the library only points at it). */
    credits?: string;
    /** The engine the game is meant to be played with (chosen when it was added): what it is trained for. */
    preferredEngine?: EngineKind;
    /**
     * The ways the game plays well — engine, clock, and the profile version when it matters: the UI
     * offers only these. None listed: every engine that is ready, with either clock.
     */
    configs?: PlayConfig[];
    /** How the UI plays the game when it is picked (one of `configs`); none: `preferredEngine`, clock paused. */
    preferredConfig?: PlayConfig;
}

/** One way a game is played. */
export interface PlayConfig {
    engine: EngineKind;
    /** The clock never pauses: the game does not wait for a decision. Default false: it waits. */
    live?: boolean;
    /** The profile version it plays; default the active one (Laya: the version its model learnt). */
    version?: number;
    /**
     * Live, a lag-aware version: its inputs land no sooner than this many ms after their frame, however
     * fast the engine answers — the lag the version was trained at, where its extractor's timing holds.
     */
    lagMs?: number;
}

export enum DecideOn {
    /** A decision every `tickMs` of game time. */
    TICK = "tick",
    /** The action is held until the state changes, at most `maxHoldMs`. */
    CHANGE = "change",
}

export interface GameAction {
    id: string;
    description: string;
    /** Keys held while this action is in force (a key chosen again stays held). */
    keys?: string[];
    /** One click on the game: its centre (true), or a point as fractions of its width and height. */
    click?: boolean | { x: number; y: number };
    /** The mouse button held down while this action is in force (charge-and-release games): at the centre (true) or a point. */
    pointer?: boolean | { x: number; y: number };
}

/**
 * A check a new profile version must pass offline, over the raw frames saved
 * from a failure (a window): the extractor runs over the window from its first
 * frame with fresh memory, and `expect` is a JavaScript expression over `state`
 * — and `choice`, the engine's decision, when `needsChoice`.
 */
export interface RegressionTest {
    window: string;
    /** "all", or the frame indices checked. */
    ticks: "all" | number[];
    needsChoice?: boolean;
    expect: string;
    why?: string;
}

export interface ProfileResults {
    mean: number;
    scores: number[];
    seeds?: number[];
    gameSeconds: number;
    measuredAt: string;
    /**
     * Trained for real-time play: the same seeds with the clock never paused (the rest is with it paused) — and
     * the seeds training never shows the tuner, as training played them (`test`). Simulated over a range of lags,
     * each seed was played at every one of `lagPoints` (its score is the mean of those games); `lagMs` is the mean
     * lag of them all.
     */
    realtime?: { mean: number; scores: number[]; lagMs?: number; lagPoints?: number[]; test?: { mean: number; scores: number[]; seeds: number[] } };
    /** Seeds training never shows the tuner, with the clock paused: what the version plays on games it was not fitted to. */
    test?: { mean: number; scores: number[]; seeds: number[] };
    /** A random action every decision, on the same seeds: the floor the version is measured from. */
    random?: { mean: number; scores: number[] };
}

/** How a plan is cut: `slots` moments, `slotMs` apart. */
export interface PlanConfig {
    slots: number;
    slotMs: number;
}

export interface Profile {
    version: number;
    createdAt: string;
    /** The version this one was made from. */
    parent?: number;
    /** Who made it: `setup`, `tuner`, `import`, `research`, `manual`. */
    origin: string;
    /** Why: the tuner's analysis, a note. */
    note?: string;
    /** `function extract(raw, memory, info) { … }`: the raw input to the state (`info.lagMs`: how late the decision acts). */
    extractor: string;
    /** The rules the engine applies, in terms of the state's fields. */
    instructions: string;
    actions: GameAction[];
    decideOn: DecideOn;
    tickMs: number;
    maxHoldMs?: number;
    /**
     * A JavaScript expression over `state`: when false, the engine is not asked
     * and its last decision stays in force (a click is not repeated). Only the
     * engine chooses actions; this says only when a decision is worth asking for.
     */
    askWhen?: string;
    /**
     * The same rules as code: `function teach(state) { … }` returns an action id, or probabilities
     * by action id. It labels states for training a small local engine (Laya distillation) and plays
     * when chosen as the engine (the rules engine); it is never put into a state.
     */
    teacher?: string;
    /**
     * Its extractor makes up for `info.lagMs` (trained for real time): with the clock running, each input
     * is held to land the lag the extractor was told after its frame — a jitter buffer. A profile that
     * does not make up for the lag plays its inputs as soon as they are decided: holding them only delays.
     */
    lagAware?: boolean;
    /**
     * For real time only: training for real time kept it for playing better with the clock running, though it plays
     * worse paused than the version training began from — so it is never made active, and a game is played live with
     * it (a config's pin, or the configs its versions earn) while the active version keeps the paused clock.
     */
    liveOnly?: boolean;
    /**
     * Plan mode, for real time with a slow engine: one request decides the next `slots` moments,
     * `slotMs` apart, from the extractor's prediction of each (`info.slots`, `info.pending`). Only with
     * the clock running; paused, the profile plays one decision a tick as any other.
     */
    plan?: PlanConfig;
    tests: RegressionTest[];
    results?: ProfileResults;
}

/** Saved raw frames: the last decisions before a failure, replayable offline. */
export interface FailureWindow {
    id: string;
    seed?: number;
    profileVersion: number;
    rawFrames: unknown[];
    /** Played in real time: the lag the extractor was told then, and is told again on a replay. */
    lagMs?: number;
    /**
     * What the extractor was told with each frame (lag, game time, a plan's moments): told again on a replay. `unread`: the
     * page could not be read on that frame (its raw frame is null), so the extractor never saw it — nor does a replay.
     */
    frameInfo?: Array<{ lagMs: number; nowMs?: number; slots?: number[]; pending?: Array<{ inMs: number; action: string }>; unread?: boolean }>;
}

export const GAME_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9-]{0,62}$/;
