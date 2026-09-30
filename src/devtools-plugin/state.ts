/**
 * What the game tools keep between calls, in DevTools' own session and page
 * state: the clock and the storage are the browser context's (one per
 * session), the scripts, the listeners and the held keys are the page's (a
 * replaced page starts clean).
 */

import type { CDPSession, Disposable, Page } from "playwright-core";
import type { BrowserToolSessionContext } from "./host";

const SESSION_KEY: string = "ibgamer.session";
const PAGE_KEY: string = "ibgamer.page";

export interface GameSessionState {
    /** The clock is installed (by the first `pauseAt`): the context's timers, rAF and Date are Playwright's. */
    clockInstalled: boolean;
    /**
     * The origins the current game went through (open.ts `watchGameOrigins`: its documents', its navigations'), cleared
     * with the next game's own at its open and noted afresh from there. Kept here, not with the page: the storage they
     * name is the context's, and a replaced page's game left it there too.
     */
    gameOrigins: Set<string>;
    /**
     * The windows the current game opened (open.ts `watchGamePages`: its popups, and theirs), closed at the next game's
     * open. Kept here, not with the page: a replaced page's windows are still open.
     */
    gamePages: Set<Page>;
    /**
     * The session's browser context is its own (DevTools makes one per session), not the browser's default one a
     * persistent profile or an attached Chrome shares: every cookie in it is the games'. Asked once (open.ts).
     */
    ownContext?: boolean;
}

export interface GamePageState {
    /** What is installed once for the page: its scripts (the adapters, the counters, the clock's), the origin watch. */
    installed: Set<string>;
    /**
     * The current game's scripts, added again for every game just before its load, in this order: its session storage
     * clearing (page/storage.ts, with the open's token), its own init scripts, its seed. Kept until the next game starts.
     */
    sessionClear?: Disposable;
    gameScripts: Disposable[];
    seedScript?: Disposable;
    /** Keys held down now. */
    held: Set<string>;
    /** The mouse button is held down now. */
    pointerDown?: boolean;
    read?: string;
    score?: string;
    clickTarget: string;
    /** The click target's box, measured at the first click in a document (step.ts). */
    clickBox?: { x: number; y: number; width: number; height: number };
    /** The document the click target's box was measured in (page/inputs.ts's id): another one measures it again. */
    clickBoxDoc?: string;
    /** The page's CSS animations follow game time (page/animations.ts). */
    animationClock?: boolean;
    /** The DevTools session that holds the page's animation timeline still (kept open: closing it would let it go). */
    animationSession?: CDPSession;
    /** The DevTools session that keeps the page's time zone UTC (kept open: closing it would lift it). */
    timezoneSession?: CDPSession;
    /** Key and pointer events sent to the page's document (the page counts those it received: page/inputs.ts). */
    inputsSent: number;
    /** The document they are counted in (page/inputs.ts gives each its own id): another one counts from zero. */
    inputsDoc?: string;
}

export function sessionState(context: BrowserToolSessionContext): GameSessionState {
    let state: GameSessionState | undefined = context.sessionState().get(SESSION_KEY) as GameSessionState | undefined;
    if (!state) {
        state = { clockInstalled: false, gameOrigins: new Set(), gamePages: new Set() };
        context.sessionState().set(SESSION_KEY, state);
    }
    return state;
}

export function pageState(context: BrowserToolSessionContext): GamePageState {
    let state: GamePageState | undefined = context.pageState().get(PAGE_KEY) as GamePageState | undefined;
    if (!state) {
        state = { installed: new Set(), gameScripts: [], held: new Set(), clickTarget: "canvas", inputsSent: 0 };
        context.pageState().set(PAGE_KEY, state);
    }
    return state;
}

/** Lets go of every held key and the pointer (a new game, a released action). */
export async function releaseAll(context: BrowserToolSessionContext, state: GamePageState): Promise<void> {
    for (const key of [...state.held]) {
        state.held.delete(key);
        await context.page.keyboard.up(key).catch((): void => undefined);
    }
    if (state.pointerDown) {
        state.pointerDown = false;
        await context.page.mouse.up().catch((): void => undefined);
    }
}
