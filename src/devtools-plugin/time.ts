/**
 * Game time on a frozen page: the clock runs it, and with the animation clock (page/animations.ts)
 * the page's CSS animations follow it, frame by frame.
 *
 * An error the page's own code throws in a callback the clock runs (a timer, a frame) does not stop game
 * time: Playwright's clock runs the whole slice, then throws the first such error — which a page on its
 * own clock would only have logged. It is returned (its first line) for the result to report; a closed
 * or crashed page still throws.
 *
 * Nor does a native dialog (`alert`, `confirm`, `prompt`) one of them opens: Playwright's call comes back at
 * the dialog, while the page's own run goes on in real time once the dialog is answered (dismissed: DevTools'
 * default). So a slice is waited for until the page's clock has run all of it (`_caughtUp`).
 */

import { PAGE_NAMESPACE } from "../devtools/protocol";
import type { Page } from "playwright-core";

/** An animation frame of game time (the page draws one every 16 ms). */
export const FRAME_MS: number = 16;
/** How much of a page error's message is kept. */
const PAGE_ERROR_CHARS: number = 300;
/** Real time a slice of game time is waited for at most once Playwright's call has come back short of it (_caughtUp). */
const CATCH_UP_MS: number = 2_000;
/** How often the page's clock is read while it catches up (real time). */
const CATCH_UP_POLL_MS: number = 2;
/**
 * The time Playwright's clock has run in the page's main frame (what `performance.now()` reads there), from the clock
 * itself (a page may replace its `performance`); null without one.
 */
const CLOCK_READ: string = `(() => { const c = globalThis.__pwClock && globalThis.__pwClock.controller; return c && typeof c.performanceNow === "function" ? c.performanceNow() : null; })()`;

/** Waits real time (this process's clock: the page's is frozen). */
function _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, ms);
    });
}

/**
 * Runs `ms` of game time; with `animations`, in frames, the page's CSS animations moved on after each.
 * Returns the first error the page's own code threw meanwhile, if one did (or that the page's clock fell
 * short of the time asked: _caughtUp).
 */
export async function runGameTime(page: Page, ms: number, animations: boolean): Promise<string | undefined> {
    const start: number | undefined = await _clockAt(page);
    if (!animations) {
        const error: string | undefined = await _runFor(page, ms);
        const short: string | undefined = await _caughtUp(page, start, ms);
        return error ?? short;
    }
    let pageError: string | undefined;
    let ran: number = 0;
    for (let left: number = ms; left > 0; left -= FRAME_MS) {
        const dt: number = Math.min(FRAME_MS, left);
        const error: string | undefined = await _runFor(page, dt);
        ran += dt;
        // All of the frame first: the animations move on only once the page's timers and frames have.
        const short: string | undefined = await _caughtUp(page, start, ran);
        pageError = pageError ?? error ?? short;
        await takeAnimations(page, dt);
    }
    return pageError;
}

/** The time the page's clock has run (its main frame's: CLOCK_READ); undefined without a clock, or when the page cannot be read (navigating, closed). */
async function _clockAt(page: Page): Promise<number | undefined> {
    const at: unknown = await page.evaluate(CLOCK_READ).catch((): undefined => undefined);
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/**
 * Waits (real time, at most CATCH_UP_MS) until the page's clock has run `ms` from `start`. Playwright's call comes back
 * as soon as a native dialog opens in a timer or frame it runs (it drops its evaluations then; an `alert` at game over),
 * and the page's own run goes on in real time once the dialog is answered: until 2026-09-30 a step of 1000 ms came back
 * in 12 ms with `performance.now()` at 176 for 1032, and the rest ran on alone, into the next steps. Undefined once the
 * clock is there — a new document (the page navigated) replays the whole log, so is there at once — or when it cannot be
 * told (no clock, the page closed, its document replaced as it was read); else how far it got, reported as the page's
 * errors are. The main frame's clock only: a game in a frame of its own is not waited for.
 */
async function _caughtUp(page: Page, start: number | undefined, ms: number): Promise<string | undefined> {
    if (start === undefined) {
        return undefined;
    }
    const until: number = Date.now() + CATCH_UP_MS;
    for (;;) {
        const at: number | undefined = await _clockAt(page);
        if (at === undefined || at >= start + ms) {
            return undefined;
        }
        if (Date.now() >= until) {
            return `game time ran short: the page's clock ran ${Math.round(at - start)} of ${ms} ms`;
        }
        await _sleep(CATCH_UP_POLL_MS);
    }
}

/** Runs the clock `ms` on; an error the page's own code threw in it is returned (the slice has run), anything else thrown. */
async function _runFor(page: Page, ms: number): Promise<string | undefined> {
    try {
        await page.clock.runFor(ms);
        return undefined;
    } catch (err: unknown) {
        if (!(await pageThrew(page, err))) {
            throw err;
        }
        return pageErrorMessage(err);
    }
}

/**
 * Whether a clock call's error is the page's own (a callback the clock ran threw): Playwright throws it as it
 * throws a failure, so the page is asked — a page that still answers threw it; a closed or crashed one did not.
 */
export async function pageThrew(page: Page, err: unknown): Promise<boolean> {
    if (!(err instanceof Error) || page.isClosed()) {
        return false;
    }
    return page.evaluate("0").then(
        (): boolean => true,
        (): boolean => false
    );
}

/**
 * Whether a clock call failed because the moment it was given had passed: Playwright's own message, looked for on
 * its first line only — the rest is a stack, and the page's script and function names in it are the page's (a
 * frame throwing from `pasta.js` is no such failure).
 */
export function clockMomentPassed(err: unknown): boolean {
    const message: string = err instanceof Error ? err.message : String(err);
    return /Cannot fast-forward to the past/.test(message.split("\n")[0]);
}

/** The first line of a page error, without the clock call Playwright names first ("clock.runFor: TypeError: …"). */
export function pageErrorMessage(err: unknown): string {
    const message: string = err instanceof Error ? err.message : String(err);
    return message
        .replace(/^clock\.\w+: /, "")
        .split("\n")[0]
        .slice(0, PAGE_ERROR_CHARS);
}

/** Moves the page's CSS animations on by `dt` ms of game time (0: only takes over the new ones). */
export async function takeAnimations(page: Page, dt: number): Promise<void> {
    await page.evaluate(`window.${PAGE_NAMESPACE}.animations && window.${PAGE_NAMESPACE}.animations.advance(${dt})`).catch((): void => undefined);
}
