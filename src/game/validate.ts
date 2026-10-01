/**
 * Checks what a library file holds before it is used: a game or a profile
 * comes from the library on disk, an import or the tuner, and a wrong shape
 * should fail here, naming the field, not three calls into a game.
 */

import { Viewport } from "../devtools/protocol";
import { EngineKind } from "../engine/types";
import {
    DecideOn,
    GAME_ID_PATTERN,
    GameAction,
    GameDefinition,
    GamePerception,
    InputStep,
    Perception,
    PlanConfig,
    PlayConfig,
    Profile,
    ProfileResults,
    RegressionTest,
} from "./types";

export class InvalidDefinitionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidDefinitionError";
    }
}

const MAX_TICK_MS: number = 5_000;
const MIN_TICK_MS: number = 10;
/** A pixel grid's cells across (and at most down): coarser sees nothing, finer is a state no model reads. */
const MIN_PIXEL_GRID_WIDTH: number = 8;
const MIN_PIXEL_GRID_HEIGHT: number = 4;
const MAX_PIXEL_GRID: number = 160;
const MAX_PLAN_SLOTS: number = 16;
const MAX_PLAN_SLOT_MS: number = 1_000;
/** A live config's lag floor: past a second the game is played on a stale frame whatever the engine does. */
const MAX_CONFIG_LAG_MS: number = 1_000;
const MAX_PAGE_STYLE: number = 20_000;
/**
 * The real time a start or resume step waits (the UI's "loading time" at most): `game_step` waits 30 s at
 * most, and a game played in real time waits a step's advance too.
 */
const MAX_WAIT_MS: number = 20_000;
/** The games one play is: a game's budget, the UI's and the CLI's most. */
export const MAX_EPISODES: number = 50;

function fail(where: string, message: string): never {
    throw new InvalidDefinitionError(`${where}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CSS for a game's page: text, and a page's worth at most. */
function pageStyleOf(value: unknown, where: string): string {
    const css: string = str(value, where) as string;
    if (css.length > MAX_PAGE_STYLE) {
        fail(where, `must be at most ${MAX_PAGE_STYLE} characters`);
    }
    return css;
}

function str(value: unknown, where: string, optional: boolean = false): string | undefined {
    if (value === undefined && optional) {
        return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
        fail(where, "must be a non-empty string");
    }
    return value;
}

function num(value: unknown, where: string, min: number, max: number, optional: boolean = false): number | undefined {
    if (value === undefined && optional) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        fail(where, `must be a number in [${min}, ${max}]`);
    }
    return value;
}

/**
 * Whole milliseconds of game time: the frozen clock runs a step to the next whole ms but replays the
 * fraction to every later page, which then starts off its frame (and `game_step` refuses a fraction).
 */
function wholeMs(value: unknown, where: string, min: number, max: number, optional: boolean = false): number | undefined {
    const ms: number | undefined = num(value, where, min, max, optional);
    if (ms !== undefined && !Number.isInteger(ms)) {
        fail(where, "must be a whole number of milliseconds");
    }
    return ms;
}

function finite(value: unknown, where: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(where, "must be a number");
    }
    return value;
}

/** Scores (any numbers), or seeds (non-negative integers). */
function numberList(value: unknown, where: string, seeds: boolean = false): number[] {
    const fits: (v: unknown) => boolean = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && (!seeds || (Number.isInteger(v) && v >= 0));
    if (!Array.isArray(value) || !value.every(fits)) {
        fail(where, seeds ? "must be a list of non-negative integers" : "must be a list of numbers");
    }
    return value as number[];
}

function strings(value: unknown, where: string): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || !value.every((v: unknown): boolean => typeof v === "string" && v !== "")) {
        fail(where, "must be a list of non-empty strings");
    }
    return value as string[];
}

/** Whole CSS pixels, as `game_open` takes a viewport: a fraction would pass here and fail every open. */
function pixels(value: unknown, where: string): number {
    const n: number = num(value, where, 100, 4000) as number;
    if (!Number.isInteger(n)) {
        fail(where, "must be a whole number of pixels");
    }
    return n;
}

function viewport(value: unknown, where: string): Viewport | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isObject(value)) {
        fail(where, "must be { width, height }");
    }
    return {
        width: pixels(value.width, `${where}.width`),
        height: pixels(value.height, `${where}.height`),
    };
}

function perception(value: unknown, where: string): GamePerception {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const adapter: unknown = value.adapter;
    if (!Object.values(Perception).includes(adapter as Perception)) {
        fail(`${where}.adapter`, `must be one of ${Object.values(Perception).join(", ")}`);
    }
    const out: GamePerception = { adapter: adapter as Perception };
    if (value.maps !== undefined) {
        out.maps = Boolean(value.maps);
    }
    if ((adapter === Perception.PHASER || adapter === Perception.PIXI || adapter === Perception.COCOS) && value.read !== undefined) {
        out.read = str(value.read, `${where}.read`);
        out.format = str(value.format, `${where}.format`);
    }
    if (adapter === Perception.CUSTOM) {
        out.script = str(value.script, `${where}.script`, true);
        out.read = str(value.read, `${where}.read`);
        out.format = str(value.format, `${where}.format`, true);
        if (out.script && !/^[\w.-]+\.js$/.test(out.script)) {
            fail(`${where}.script`, "must be a .js file name in the game's directory");
        }
    }
    if (adapter === Perception.PIXELS && value.grid !== undefined) {
        if (!isObject(value.grid)) {
            fail(`${where}.grid`, "must be { width, height? }");
        }
        const height: number | undefined = num(value.grid.height, `${where}.grid.height`, MIN_PIXEL_GRID_HEIGHT, MAX_PIXEL_GRID, true);
        out.grid = { width: num(value.grid.width, `${where}.grid.width`, MIN_PIXEL_GRID_WIDTH, MAX_PIXEL_GRID) as number, ...(height !== undefined ? { height } : {}) };
    }
    return out;
}

/** A click: true (the centre), or { x, y } as fractions of the game's width and height. */
function clickOf(value: unknown, where: string): boolean | { x: number; y: number } | undefined {
    if (value === undefined || value === false) {
        return undefined;
    }
    if (value === true) {
        return true;
    }
    if (isObject(value)) {
        return { x: num(value.x, `${where}.x`, 0, 1) as number, y: num(value.y, `${where}.y`, 0, 1) as number };
    }
    fail(where, "must be true or { x, y } (fractions of the game's width and height)");
}

function inputStep(value: unknown, where: string): InputStep {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const step: InputStep = {};
    const press: string[] | undefined = strings(value.press, `${where}.press`);
    const hold: string[] | undefined = strings(value.hold, `${where}.hold`);
    if (press) {
        step.press = press;
    }
    if (value.holdFrom !== undefined) {
        if (typeof value.holdFrom !== "string" || !value.holdFrom.trim()) {
            fail(`${where}.holdFrom`, "must be a page expression naming the keys to hold");
        }
        step.holdFrom = value.holdFrom;
    }
    if (hold) {
        step.hold = hold;
    }
    const click: InputStep["click"] = clickOf(value.click, `${where}.click`);
    if (click) {
        step.click = click;
    }
    const wait: number | undefined = wholeMs(value.waitMs, `${where}.waitMs`, 0, MAX_WAIT_MS, true);
    if (wait !== undefined) {
        step.waitMs = wait;
    }
    const advance: number | undefined = wholeMs(value.advanceMs, `${where}.advanceMs`, 0, 60_000, true);
    if (advance !== undefined) {
        step.advanceMs = advance;
    }
    return step;
}

export function validateGame(value: unknown, where: string = "game.json"): GameDefinition {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const id: string = str(value.id, `${where}.id`) as string;
    if (!GAME_ID_PATTERN.test(id)) {
        fail(`${where}.id`, "must be lowercase letters, digits and dashes");
    }
    const url: string = str(value.url, `${where}.url`) as string;
    if (!/^https?:\/\//.test(url)) {
        fail(`${where}.url`, "must be an http(s) URL");
    }
    if (!isObject(value.score)) {
        fail(`${where}.score`, "must be an object");
    }
    const score: Record<string, unknown> = value.score;
    const expression: string | undefined = str(score.expression, `${where}.score.expression`, true);
    if (!expression && score.fromState !== true) {
        fail(`${where}.score`, "needs an expression, or fromState: true");
    }
    if (!isObject(value.budgets)) {
        fail(`${where}.budgets`, "must be an object");
    }
    const budgets: Record<string, unknown> = value.budgets;
    // Whole seconds and games: the UI and the CLI take no fraction, and a play asked for one would not match.
    const whole: (field: string, max: number) => number = (field: string, max: number): number => {
        const n: number = num(budgets[field], `${where}.budgets.${field}`, 1, max) as number;
        if (!Number.isInteger(n)) {
            fail(`${where}.budgets.${field}`, "must be a whole number");
        }
        return n;
    };
    const start: unknown = value.start;
    if (start !== undefined && !Array.isArray(start)) {
        fail(`${where}.start`, "must be a list of input steps");
    }
    const resume: unknown = value.resume;
    if (resume !== undefined && !Array.isArray(resume)) {
        fail(`${where}.resume`, "must be a list of input steps");
    }
    const seedList: (list: unknown, field: string) => number[] | undefined = (list: unknown, field: string): number[] | undefined => {
        if (list === undefined) {
            return undefined;
        }
        if (!Array.isArray(list) || !list.every((s: unknown): boolean => Number.isInteger(s) && (s as number) >= 0)) {
            fail(`${where}.${field}`, "must be a list of non-negative integers");
        }
        return list as number[];
    };
    const trainSeeds: number[] | undefined = seedList(value.trainSeeds, "trainSeeds");
    const testSeeds: number[] | undefined = seedList(value.testSeeds, "testSeeds");
    return {
        id,
        name: str(value.name, `${where}.name`) as string,
        ...(value.description !== undefined ? { description: str(value.description, `${where}.description`) } : {}),
        url,
        goal: str(value.goal, `${where}.goal`) as string,
        perception: perception(value.perception, `${where}.perception`),
        ...(value.viewport !== undefined ? { viewport: viewport(value.viewport, `${where}.viewport`) } : {}),
        ...(value.bootMs !== undefined ? { bootMs: wholeMs(value.bootMs, `${where}.bootMs`, 0, 30_000) } : {}),
        ...(Array.isArray(start) ? { start: start.map((s: unknown, i: number): InputStep => inputStep(s, `${where}.start[${i}]`)) } : {}),
        ...(Array.isArray(resume) ? { resume: resume.map((s: unknown, i: number): InputStep => inputStep(s, `${where}.resume[${i}]`)) } : {}),
        score: {
            ...(expression ? { expression } : {}),
            ...(score.fromState === true ? { fromState: true } : {}),
            label: str(score.label, `${where}.score.label`) as string,
            ...(score.max !== undefined ? { max: num(score.max, `${where}.score.max`, 0, 1e12) } : {}),
        },
        ...(value.clickTarget !== undefined ? { clickTarget: str(value.clickTarget, `${where}.clickTarget`) } : {}),
        ...(value.pageStyle !== undefined ? { pageStyle: pageStyleOf(value.pageStyle, `${where}.pageStyle`) } : {}),
        ...(value.seedable !== undefined ? { seedable: Boolean(value.seedable) } : {}),
        ...(value.animationClock === true ? { animationClock: true } : {}),
        budgets: {
            gameSeconds: whole("gameSeconds", 3_600),
            episodes: whole("episodes", MAX_EPISODES),
            ...(budgets.trainSeconds !== undefined ? { trainSeconds: whole("trainSeconds", 3_600) } : {}),
        },
        ...(trainSeeds ? { trainSeeds } : {}),
        ...(testSeeds ? { testSeeds } : {}),
        ...(value.tags !== undefined ? { tags: strings(value.tags, `${where}.tags`) } : {}),
        ...(value.credits !== undefined ? { credits: str(value.credits, `${where}.credits`) } : {}),
        ...(value.preferredEngine !== undefined ? { preferredEngine: preferredEngine(value.preferredEngine, `${where}.preferredEngine`) } : {}),
        ...playConfigs(value, where),
    };
}

function playConfig(value: unknown, where: string): PlayConfig {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const version: number | undefined = value.version !== undefined ? (num(value.version, `${where}.version`, 1, 1_000_000) as number) : undefined;
    if (version !== undefined && !Number.isInteger(version)) {
        fail(`${where}.version`, "must be an integer");
    }
    const lagMs: number | undefined = value.lagMs !== undefined ? (num(value.lagMs, `${where}.lagMs`, 0, MAX_CONFIG_LAG_MS) as number) : undefined;
    if (lagMs !== undefined && value.live !== true) {
        fail(`${where}.lagMs`, "is for a live config: with the clock paused a decision is never late");
    }
    return {
        engine: preferredEngine(value.engine, `${where}.engine`),
        ...(value.live === true ? { live: true } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(lagMs !== undefined ? { lagMs } : {}),
    };
}

/** A game's configs (one per engine and clock) and the one it is played with first. */
function playConfigs(value: Record<string, unknown>, where: string): { configs?: PlayConfig[]; preferredConfig?: PlayConfig } {
    if (value.configs !== undefined && (!Array.isArray(value.configs) || value.configs.length === 0)) {
        fail(`${where}.configs`, "must be a non-empty list of configs");
    }
    const configs: PlayConfig[] | undefined = Array.isArray(value.configs)
        ? value.configs.map((c: unknown, i: number): PlayConfig => playConfig(c, `${where}.configs[${i}]`))
        : undefined;
    const key: (c: PlayConfig) => string = (c: PlayConfig): string => `${c.engine}/${Boolean(c.live)}`;
    if (configs && new Set(configs.map(key)).size !== configs.length) {
        fail(`${where}.configs`, "lists an engine with the same clock twice");
    }
    const preferred: PlayConfig | undefined = value.preferredConfig !== undefined ? playConfig(value.preferredConfig, `${where}.preferredConfig`) : undefined;
    if (preferred && configs && !configs.some((c: PlayConfig): boolean => key(c) === key(preferred))) {
        fail(`${where}.preferredConfig`, "must be one of the configs");
    }
    return { ...(configs ? { configs } : {}), ...(preferred ? { preferredConfig: preferred } : {}) };
}

function planConfig(value: unknown, where: string): PlanConfig {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const slots: number = num(value.slots, `${where}.slots`, 2, MAX_PLAN_SLOTS) as number;
    const slotMs: number = num(value.slotMs, `${where}.slotMs`, MIN_TICK_MS, MAX_PLAN_SLOT_MS) as number;
    if (!Number.isInteger(slots)) {
        fail(`${where}.slots`, "must be an integer");
    }
    return { slots, slotMs };
}

function preferredEngine(value: unknown, where: string): EngineKind {
    if (!Object.values(EngineKind).includes(value as EngineKind)) {
        fail(where, `must be one of ${Object.values(EngineKind).join(", ")}`);
    }
    return value as EngineKind;
}

function action(value: unknown, where: string): GameAction {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const id: string = str(value.id, `${where}.id`) as string;
    if (!/^[\w-]{1,40}$/.test(id)) {
        fail(`${where}.id`, "must be a short word (letters, digits, _ and -)");
    }
    const keys: string[] | undefined = strings(value.keys, `${where}.keys`);
    const click: GameAction["click"] = clickOf(value.click, `${where}.click`);
    const pointer: GameAction["pointer"] = clickOf(value.pointer, `${where}.pointer`);
    return {
        id,
        description: str(value.description, `${where}.description`) as string,
        ...(keys ? { keys } : {}),
        ...(click ? { click } : {}),
        ...(pointer ? { pointer } : {}),
    };
}

export function validateRegressionTest(value: unknown, where: string = "test"): RegressionTest {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const ticks: unknown = value.ticks;
    if (ticks !== "all" && !(Array.isArray(ticks) && ticks.every((t: unknown): boolean => Number.isInteger(t) && (t as number) >= 0))) {
        fail(`${where}.ticks`, 'must be "all" or a list of frame indices');
    }
    return {
        window: str(value.window, `${where}.window`) as string,
        ticks: ticks as "all" | number[],
        ...(value.needsChoice === true ? { needsChoice: true } : {}),
        expect: str(value.expect, `${where}.expect`) as string,
        ...(value.why !== undefined ? { why: str(value.why, `${where}.why`) } : {}),
    };
}

/** One measurement: its mean and scores, its seeds when it names them; anything else it holds kept. */
function measurement(value: unknown, where: string): Record<string, unknown> & { mean: number; scores: number[] } {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    return {
        ...value,
        mean: finite(value.mean, `${where}.mean`),
        scores: numberList(value.scores, `${where}.scores`),
        ...(value.seeds !== undefined ? { seeds: numberList(value.seeds, `${where}.seeds`, true) } : {}),
    };
}

/** Scores on the seeds training never shows the tuner: a measurement that names its seeds. */
function unseenSeeds(value: unknown, where: string): Record<string, unknown> {
    const test: Record<string, unknown> = measurement(value, where);
    return { ...test, seeds: numberList(test.seeds, `${where}.seeds`, true) };
}

/**
 * How a version scored. The numbers the UI shows and the trainer and distiller replay are checked (an
 * imported or hand-edited profile is rendered and played from them); other fields are kept as they are.
 */
function profileResults(value: unknown, where: string): ProfileResults {
    const results: Record<string, unknown> & { mean: number; scores: number[] } = measurement(value, where);
    const out: Record<string, unknown> = {
        ...results,
        gameSeconds: finite(results.gameSeconds, `${where}.gameSeconds`),
        measuredAt: str(results.measuredAt, `${where}.measuredAt`),
    };
    if (results.realtime !== undefined) {
        const realtime: Record<string, unknown> = measurement(results.realtime, `${where}.realtime`);
        out.realtime = {
            ...realtime,
            ...(realtime.lagMs !== undefined ? { lagMs: finite(realtime.lagMs, `${where}.realtime.lagMs`) } : {}),
            // Lags are whole ms, as the seeds are whole numbers: measure replays each one.
            ...(realtime.lagPoints !== undefined ? { lagPoints: numberList(realtime.lagPoints, `${where}.realtime.lagPoints`, true) } : {}),
            ...(realtime.test !== undefined ? { test: unseenSeeds(realtime.test, `${where}.realtime.test`) } : {}),
        };
    }
    if (results.test !== undefined) {
        out.test = unseenSeeds(results.test, `${where}.test`);
    }
    if (results.random !== undefined) {
        out.random = measurement(results.random, `${where}.random`);
    }
    return out as unknown as ProfileResults;
}

export function validateProfile(value: unknown, where: string = "profile"): Profile {
    if (!isObject(value)) {
        fail(where, "must be an object");
    }
    const actions: unknown = value.actions;
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 32) {
        fail(`${where}.actions`, "must list 1 to 32 actions");
    }
    const parsed: GameAction[] = actions.map((a: unknown, i: number): GameAction => action(a, `${where}.actions[${i}]`));
    const ids: Set<string> = new Set(parsed.map((a: GameAction): string => a.id));
    if (ids.size !== parsed.length) {
        fail(`${where}.actions`, "action ids must be distinct");
    }
    const decideOn: unknown = value.decideOn ?? DecideOn.TICK;
    if (!Object.values(DecideOn).includes(decideOn as DecideOn)) {
        fail(`${where}.decideOn`, `must be one of ${Object.values(DecideOn).join(", ")}`);
    }
    const tests: unknown = value.tests ?? [];
    if (!Array.isArray(tests)) {
        fail(`${where}.tests`, "must be a list");
    }
    return {
        version: num(value.version, `${where}.version`, 1, 1_000_000) as number,
        createdAt: str(value.createdAt, `${where}.createdAt`) as string,
        ...(value.parent !== undefined ? { parent: num(value.parent, `${where}.parent`, 1, 1_000_000) } : {}),
        origin: str(value.origin, `${where}.origin`) as string,
        ...(value.note !== undefined ? { note: str(value.note, `${where}.note`) } : {}),
        extractor: str(value.extractor, `${where}.extractor`) as string,
        instructions: str(value.instructions, `${where}.instructions`) as string,
        actions: parsed,
        decideOn: decideOn as DecideOn,
        tickMs: wholeMs(value.tickMs, `${where}.tickMs`, MIN_TICK_MS, MAX_TICK_MS) as number,
        ...(value.maxHoldMs !== undefined ? { maxHoldMs: num(value.maxHoldMs, `${where}.maxHoldMs`, MIN_TICK_MS, 10_000) } : {}),
        ...(value.askWhen !== undefined ? { askWhen: str(value.askWhen, `${where}.askWhen`) } : {}),
        ...(value.teacher !== undefined ? { teacher: str(value.teacher, `${where}.teacher`) } : {}),
        ...(value.lagAware === true ? { lagAware: true } : {}),
        ...(value.plan !== undefined ? { plan: planConfig(value.plan, `${where}.plan`) } : {}),
        tests: tests.map((t: unknown, i: number): RegressionTest => validateRegressionTest(t, `${where}.tests[${i}]`)),
        ...(value.results !== undefined ? { results: profileResults(value.results, `${where}.results`) } : {}),
    };
}
