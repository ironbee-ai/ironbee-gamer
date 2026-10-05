/**
 * Does a game replay? The same seed played twice — the profile's rules deciding, so the same frames
 * make the same inputs, and a game waiting between rounds taken on with its `resume` as the player takes
 * it on — must show the same frames, tick by tick. The first frame that differs is
 * reported with where it differs (`raw.pipes[1].x: 612 ≠ 613`): a page that draws from the real time,
 * an RNG the seed does not reach, a CSS animation off the game clock, storage left from a game before.
 * Two plays one after the other, or at the same time (`parallel`: what training's evaluations do).
 */

import { GameBrowser } from "../devtools/client";
import { ScoreReading, StepRequest, StepResult } from "../devtools/protocol";
import { pausedTickMs } from "../game/configs";
import { openRequest } from "../game/open";
import { GameAction, GameDefinition, Profile } from "../game/types";
import { guardState } from "../play/guard";
import { inputSteps, Resumes } from "../play/rounds";
import { Extractor, Teacher } from "../play/sandbox";

/** Game time between two frames compared when the game has no profile to take its tick from. */
const DEFAULT_TICK_MS: number = 96;
/** What a play did on a frame the game waited on between rounds (`choices`), instead of an action. */
const RESUMED: string = "(resume)";

export interface CheckOptions {
    seed: number;
    gameSeconds: number;
    /** Both plays at the same time, each in its own browser session. Default: one after the other. */
    parallel?: boolean;
    customScript?: string;
}

/** One play: each frame's raw input and reading, and the actions taken. */
interface Played {
    frames: Array<{ raw: unknown; score: ScoreReading | undefined; gameMs: number }>;
    choices: string[];
}

export interface CheckResult {
    frames: number;
    /** The first frame the two plays differ in; none: they are the same all along. */
    diverged?: { frame: number; gameMs: number; where: string; choices?: [string | undefined, string | undefined] };
    /** Where each play ended: the game over, or the budget. */
    ends: [string, string];
}

/** The places two JSON values differ (at most `limit`), each a path and both values. */
export function differences(a: unknown, b: unknown, limit: number): string[] {
    const found: string[] = [];
    const walk: (x: unknown, y: unknown, path: string) => void = (x: unknown, y: unknown, path: string): void => {
        if (found.length >= limit || x === y) {
            return;
        }
        if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
            const keys: string[] = Array.isArray(x)
                ? Array.from({ length: Math.max(x.length, (y as unknown[]).length) }, (_: unknown, i: number): string => String(i))
                : [...new Set([...Object.keys(x as object), ...Object.keys(y as object)])];
            for (const key of keys) {
                walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], Array.isArray(x) ? `${path}[${key}]` : path ? `${path}.${key}` : key);
            }
            return;
        }
        const one: string | undefined = firstDifference(x, y, path);
        if (one) {
            found.push(one);
        }
    };
    walk(a, b, "");
    return found;
}

/** The first place two JSON values differ, as a path and both values; undefined when they are equal. */
export function firstDifference(a: unknown, b: unknown, path: string = ""): string | undefined {
    if (a === b) {
        return undefined;
    }
    const show: (v: unknown) => string = (v: unknown): string => {
        const text: string = JSON.stringify(v) ?? String(v);
        return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    };
    if (typeof a === "string" && typeof b === "string" && (a.length > 60 || b.length > 60)) {
        // A long string (a pixel grid): where it first differs, with a little around it.
        let i: number = 0;
        while (i < a.length && a[i] === b[i]) {
            i++;
        }
        const around: (s: string) => string = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 6), i + 6));
        return `${path || "(the value)"}[${i} of ${a.length}]: …${around(a)}… ≠ …${around(b)}…`;
    }
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
        const keys: string[] = Array.isArray(a)
            ? Array.from({ length: Math.max(a.length, (b as unknown[]).length) }, (_: unknown, i: number): string => String(i))
            : [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
        for (const key of keys) {
            const next: string = Array.isArray(a) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
            const found: string | undefined = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], next);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    return `${path || "(the value)"}: ${show(a)} ≠ ${show(b)}`;
}

async function playOnce(browser: GameBrowser, game: GameDefinition, profile: Profile | undefined, options: CheckOptions): Promise<Played> {
    const ids: string[] = (profile?.actions ?? []).map((a: GameAction): string => a.id);
    const extractor: Extractor | undefined = profile ? new Extractor(profile.extractor, options.seed) : undefined;
    const teacher: Teacher | undefined = profile?.teacher ? new Teacher(profile.teacher, ids) : undefined;
    // As the player plays it with the clock paused: the version's tick, the paused clock's shortest at least.
    const tickMs: number = profile ? pausedTickMs(profile) : DEFAULT_TICK_MS;
    await browser.open(openRequest(game, { seed: options.seed, ...(options.customScript ? { customScript: options.customScript } : {}) }));
    for (const s of inputSteps(game.start)) {
        await browser.step(s);
    }
    const played: Played = { frames: [], choices: [] };
    const resumes: Resumes = new Resumes(game);
    let last: string | undefined;
    /** The mouse button is held down (the last action held the pointer). */
    let pointerHeld: boolean = false;
    let gameMs: number = 0;
    while (gameMs <= options.gameSeconds * 1000) {
        const seen: StepResult = await browser.step({});
        played.frames.push({ raw: seen.raw, score: seen.score, gameMs });
        if (seen.score?.over) {
            break;
        }
        // Between rounds the game waits for the player: taken on as the player takes it on, the next round decided afresh.
        const resume: StepRequest[] = resumes.stepsAfter(seen.score, pointerHeld);
        if (resume.length > 0) {
            for (const s of resume) {
                await browser.step(s);
            }
            pointerHeld = false;
            last = undefined;
            played.choices.push(RESUMED);
            gameMs += resume.reduce((ms: number, s: StepRequest): number => ms + (s.advanceMs ?? 0), 0);
            continue;
        }
        // The rules decide (the idle first action without them): the same frames give the same inputs.
        let action: GameAction | undefined = profile?.actions[0];
        if (profile && extractor && teacher) {
            try {
                const state: unknown = guardState(extractor.extract(seen.raw, { lagMs: 0, nowMs: gameMs }), ids).state;
                const p: Record<string, number> = teacher.label(state);
                const choice: string = ids.reduce((best: string, id: string): string => (p[id] > p[best] ? id : best), ids[0]);
                action = profile.actions.find((a: GameAction): boolean => a.id === choice) ?? action;
            } catch {
                // a frame the scripts cannot read: the idle action, the same in both plays
            }
        }
        played.choices.push(action?.id ?? "");
        const input: StepRequest = {
            ...(action ? { hold: action.keys ?? [] } : {}),
            // The pointer as the player sends it: held while a pointer action is in force, let go when another is.
            ...(action?.pointer || pointerHeld ? { pointer: action?.pointer ?? false } : {}),
            ...(action?.click && action.id !== last ? { click: action.click } : {}),
            advanceMs: tickMs,
            observe: false,
        };
        last = action?.id;
        pointerHeld = Boolean(action?.pointer);
        await browser.step(input);
        gameMs += tickMs;
    }
    await browser.step({ hold: [], ...(pointerHeld ? { pointer: false } : {}), observe: false }).catch((): void => undefined);
    return played;
}

/** Plays the seed twice and compares the frames. */
export async function checkReplay(
    openBrowser: () => GameBrowser,
    game: GameDefinition,
    profile: Profile | undefined,
    options: CheckOptions
): Promise<CheckResult> {
    const play: () => Promise<Played> = async (): Promise<Played> => {
        const browser: GameBrowser = openBrowser();
        try {
            return await playOnce(browser, game, profile, options);
        } finally {
            await browser.close();
        }
    };
    const [a, b]: Played[] = options.parallel ? await Promise.all([play(), play()]) : [await play(), await play()];
    const end: (p: Played) => string = (p: Played): string => {
        const lastFrame: Played["frames"][number] | undefined = p.frames[p.frames.length - 1];
        return `${lastFrame?.score?.over ? "game over" : "budget"} at ${((lastFrame?.gameMs ?? 0) / 1000).toFixed(2)} s, score ${lastFrame?.score?.score ?? "?"}`;
    };
    const n: number = Math.max(a.frames.length, b.frames.length);
    for (let i: number = 0; i < n; i++) {
        const fa: Played["frames"][number] | undefined = a.frames[i];
        const fb: Played["frames"][number] | undefined = b.frames[i];
        const all: string[] = !fa || !fb ? ["one play ended here"] : differences({ raw: fa.raw, score: fa.score }, { raw: fb.raw, score: fb.score }, 5);
        const where: string | undefined = all.length ? all.join("; ") : undefined;
        if (where) {
            return {
                frames: i,
                diverged: { frame: i, gameMs: (fa ?? fb)?.gameMs ?? 0, where, choices: [a.choices[i - 1], b.choices[i - 1]] },
                ends: [end(a), end(b)],
            };
        }
    }
    return { frames: n, ends: [end(a), end(b)] };
}
