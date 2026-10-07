/**
 * `game_open`: loads a game page with its perception installed and its clock
 * frozen. Every game starts from a fresh load — a game that did not end is
 * never "restarted" into the next (its restart key would be taken as a move).
 *
 * Order matters: the clock is installed first (a document runs its init
 * scripts in the order they were added, and some of ours act on the clock);
 * the adapters go in before the page runs; the clock is paused again, and set
 * to the game's start on an empty page, where the windows the game before
 * opened are closed and what it stored is cleared; then the game's own scripts go in —
 * its session storage clearing, its init scripts and its seed, so they read
 * the clock as the page will — and the clock is paused once more (a pause that
 * moves nothing); the page loads with time standing still, then boots
 * frame by frame in game time, the network and the page's work off its thread
 * (decoding, compiling, its database) waited for between frames, and is left
 * exactly on an animation frame — so how long the loading took in real time changes nothing,
 * and a seed replays the same game frame for frame. Time then moves only by
 * `game_step`. An error the page's own code throws as it boots is reported,
 * not thrown. The page's time zone is UTC.
 * With `freezeClock: false` the page boots and runs in real time, its boot time counted once what it loads has come.
 *
 * Only http(s) pages: the DevTools daemon answers anyone who can reach its
 * port (it binds every interface, with no auth), so this tool opens no file:,
 * data:, javascript: or browser pages.
 */

import { Adapter, GameTool, OpenRequest, OpenResult, PAGE_NAMESPACE } from "../devtools/protocol";
import { pluginApi } from "./api";
import type { BrowserToolSessionContext, Tool, ToolInput, ToolInputSchema, ToolOutput, ToolOutputSchema } from "./host";
import { installAnimationClock } from "./page/animations";
import { installInputCounter } from "./page/inputs";
import { installCanvas2dRecorder } from "./page/canvas2d";
import { replayClockLog } from "./page/clock";
import { installCocosAdapter } from "./page/cocos";
import { installDecodeCounter } from "./page/decodes";
import { installPhaserAdapter } from "./page/phaser";
import { installPixelsAdapter } from "./page/pixels";
import { installPixiAdapter } from "./page/pixi";
import { installProbe } from "./page/probe";
import { installThreeAdapter } from "./page/three";
import { seedRandom } from "./page/seed";
import { clearSessionStorage } from "./page/storage";
import { installTimerNudge } from "./page/timers";
import { GamePageState, GameSessionState, pageState, releaseAll, sessionState } from "./state";
import { inputCount } from "./step";
import { clockMomentPassed, FRAME_MS, pageThrew, runGameTime, takeAnimations } from "./time";
import type { Browser, CDPSession, Disposable, Frame, Page, Request, Response } from "playwright-core";

const DEFAULT_BOOT_MS: number = 2_500;
const MAX_BOOT_MS: number = 30_000;
const LOAD_TIMEOUT_MS: number = 45_000;
/** Frozen a moment after boot, as a player would press start. */
const PAUSE_AFTER_MS: number = 200;
/** Tries at stopping the clock, the moment widening each time (a loaded machine is slow to land the call). */
const PAUSE_ATTEMPTS: number = 4;
/**
 * Every frozen game starts from the same wall-clock time (set just before its load: the page reads exactly
 * this as it loads). Timers that fire at fractional intervals (1000 / 60 ms) are summed onto the clock's
 * absolute time, and in floating point whether the 30th lands on 500 ms or just past it depended on the
 * time the page was opened at — a physics tick more or less in one run than the next (a sprite a physics
 * step off). The session's first pause is at this moment too: a document's clock takes the first
 * moment its log sets as its origin (`performance.timeOrigin`), so every session's is the same.
 */
const GAME_EPOCH_MS: number = Date.UTC(2026, 0, 1);
/** An empty document, loaded between games: the clock finds its frames on it, and the page before is gone. */
const BLANK_PAGE: string = "data:text/html,<title>ibgamer</title>";
/** The pages a game may be: the daemon answers anyone who reaches its port, so no file:, data:, javascript: or browser pages. */
const GAME_PROTOCOLS: Set<string> = new Set(["http:", "https:"]);
/** Real time a boot frame waits at most for the page's requests and its work off its thread to finish. */
const FRAME_NETWORK_WAIT_MS: number = 2_000;
/** A request open longer than this (a long poll, a stream), or a job off the page's thread, is not waited for. */
const STALE_REQUEST_MS: number = 5_000;
/**
 * Real time, a live boot waits for a request longer than a frozen boot frame does, data coming or not (a slow host's
 * first byte): nothing else holds a live page's start. One still receiving data is waited for however long it is open.
 */
const LIVE_STALE_REQUEST_MS: number = 15_000;
/**
 * Real time a boot waits at most for a page still loading: its data still coming (followData), frozen or not, and a live
 * boot's whole wait for its loading to settle, before its boot time and after it together. A cold load (nothing cached:
 * a session's first game) brought a 1.8 MB sound over 11–25 s before its menu came.
 */
const SLOW_LOAD_WAIT_MS: number = 60_000;
/** After a boot frame that moved the network, how long what the page's callbacks started gets to show before it is looked at again. */
const REQUEST_EVENT_GRACE_MS: number = 20;
/**
 * The most origins a game notes for the next open to clear (watchGameOrigins; clearing 64 took 75–150 ms): a page that
 * goes through more (an ad frame rotating through hosts) keeps the first, its load's, which every game of it goes through.
 */
const MAX_GAME_ORIGINS: number = 64;

const INSTALLERS: Record<Adapter, () => void> = {
    [Adapter.CANVAS2D]: installCanvas2dRecorder,
    [Adapter.PHASER]: installPhaserAdapter,
    [Adapter.PIXI]: installPixiAdapter,
    [Adapter.COCOS]: installCocosAdapter,
    [Adapter.THREE]: installThreeAdapter,
    [Adapter.PIXELS]: installPixelsAdapter,
    [Adapter.PROBE]: installProbe,
};

/** Waits real time (this process's clock: the page's is frozen). */
function _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, ms);
    });
}

/** The game's page style, once the page has loaded (a page that refuses it plays as it is). */
async function _addStyle(page: Page, css: string | undefined): Promise<void> {
    if (css) {
        await page.addStyleTag({ content: css }).catch((): undefined => undefined);
    }
}

/**
 * The work off its thread a page lists (page/decodes.ts: decoding, compiling WebAssembly, IndexedDB): the jobs still
 * running, by id, and how many started or ended so far.
 */
interface PageJobs {
    open: string[];
    moves: number;
}

/**
 * The page's open requests and its work off its thread while it boots: a boot frame runs only once what it loads has
 * arrived and been decoded, compiled or read (the loader's callbacks then run in the same frame every time), however
 * long that takes.
 */
class InFlight {
    private readonly open: Map<Request, number> = new Map();
    /** The page's jobs off its thread still running, by id, and when each was first seen: waited for as a request is. */
    private jobs: Map<string, number> = new Map();
    /** The page's count of jobs started and ended, when last seen. */
    private jobMoves: number = 0;
    /** Requests or jobs started or ended since the page was last looked at. */
    private moved: number = 0;
    private readonly onRequest: (r: Request) => void = (r: Request): void => {
        this.open.set(r, Date.now());
        this.moved++;
    };
    private readonly onDone: (r: Request) => void = (r: Request): void => {
        this.open.delete(r);
        this.moved++;
    };
    /** followData: when the page last received data, until when that holds the boot, and the session it is heard on. */
    private lastData: number = 0;
    private dataUntil: number = 0;
    private dataSession: CDPSession | undefined;
    private readonly onData: () => void = (): void => {
        this.lastData = Date.now();
    };

    /** `staleMs`: a request or job open longer than this is not waited for (but see followData). */
    constructor(
        private readonly page: Page,
        private readonly staleMs: number = STALE_REQUEST_MS
    ) {
        page.on("request", this.onRequest);
        page.on("requestfinished", this.onDone);
        page.on("requestfailed", this.onDone);
    }

    /**
     * Waits (real time, at most FRAME_NETWORK_WAIT_MS) until no request and no job younger than `staleMs` is
     * open, then lets the page run its callbacks — which may ask for more (a loader fetching its files one after
     * another, decoding each), and what they start can show a moment after the page answered (an image's callback
     * waits for its decoding). So while the network or the jobs moved since the last look, the page is looked at
     * again, given that moment first when nothing is open: settled once a turn finds nothing moved.
     */
    async settled(): Promise<void> {
        const until: number = Date.now() + FRAME_NETWORK_WAIT_MS;
        for (;;) {
            while (Date.now() < until && this.busy()) {
                await _sleep(5);
                if (this.fresh(this.jobs)) {
                    // The network is seen from here; the jobs only in the page.
                    await this.turn();
                }
            }
            await this.turn();
            const moved: boolean = this.moved > 0;
            this.moved = 0;
            if (!moved || Date.now() >= until) {
                return;
            }
            if (!this.busy()) {
                await _sleep(REQUEST_EVENT_GRACE_MS);
            }
        }
    }

    /**
     * Real time: a request open however long is waited for while the page receives data within STALE_REQUEST_MS — a big
     * file over a slow host —, not one that has gone quiet (a long poll, a stream held open); for `limitMs` at most (a
     * stream that never ends holds no boot for longer).
     */
    async followData(limitMs: number): Promise<void> {
        this.dataUntil = Date.now() + limitMs;
        this.dataSession = await this.page
            .context()
            .newCDPSession(this.page)
            .catch((): undefined => undefined);
        this.dataSession?.on("Network.dataReceived", this.onData);
        await this.dataSession?.send("Network.enable").catch((): undefined => undefined);
    }

    /** As `settled`, again while anything is still open: a page loading its files one after another, until `until` at most (real time). */
    async quiet(until: number): Promise<void> {
        do {
            await this.settled();
        } while (this.busy() && Date.now() < until);
    }

    private busy(): boolean {
        return this.fresh(this.open) || this.fresh(this.jobs) || this.receiving();
    }

    /** A request open, and data received within STALE_REQUEST_MS (followData: none heard of otherwise, nor after its limit). */
    private receiving(): boolean {
        const now: number = Date.now();
        return this.open.size > 0 && now - this.lastData < STALE_REQUEST_MS && now < this.dataUntil;
    }

    /** Whether one of these, open since the time it maps to, is younger than `staleMs` (an older one is not waited for). */
    private fresh(since: Map<unknown, number>): boolean {
        const now: number = Date.now();
        return [...since.values()].some((at: number): boolean => now - at < this.staleMs);
    }

    /**
     * One turn of the page's own event loop (a message, not a timer: timers are frozen), for load callbacks; then the
     * jobs the page lists. A page that lists none (or cannot be read: it is navigating) has none to wait for.
     */
    private async turn(): Promise<void> {
        const listed: PageJobs | null | undefined = await this.page
            .evaluate(
                (ns: string): Promise<PageJobs | null> =>
                    new Promise<PageJobs | null>((resolve: (jobs: PageJobs | null) => void): void => {
                        const channel: MessageChannel = new MessageChannel();
                        channel.port1.onmessage = (): void => {
                            const decodes: any = (window as any)[ns] ? (window as any)[ns].decodes : undefined;
                            resolve(decodes ? { open: Object.keys(decodes.open), moves: Number(decodes.moves) } : null);
                        };
                        channel.port2.postMessage(0);
                    }),
                PAGE_NAMESPACE
            )
            .catch((): undefined => undefined);
        const now: number = Date.now();
        const jobs: Map<string, number> = new Map();
        for (const id of listed?.open ?? []) {
            jobs.set(id, this.jobs.get(id) ?? now);
        }
        this.jobs = jobs;
        if (listed && listed.moves !== this.jobMoves) {
            this.jobMoves = listed.moves;
            this.moved++;
        }
    }

    dispose(): void {
        this.page.off("request", this.onRequest);
        this.page.off("requestfinished", this.onDone);
        this.page.off("requestfailed", this.onDone);
        if (this.dataSession) {
            this.dataSession.off("Network.dataReceived", this.onData);
            this.dataSession.detach().catch((): undefined => undefined);
        }
    }
}

/** The http(s) origin of a URL; undefined for anything else. */
function _webOrigin(url: string): string | undefined {
    try {
        const parsed: URL = new URL(url);
        return GAME_PROTOCOLS.has(parsed.protocol) ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
}

/** Throws unless `url` is an http(s) URL: `game_open` opens web pages only. */
export function checkGameUrl(url: string): void {
    if (_webOrigin(url) === undefined) {
        const scheme: string | undefined = /^[a-z][a-z0-9+.-]*:/i.exec(String(url))?.[0];
        throw new Error(`${GameTool.OPEN} opens http: and https: pages only${scheme ? `, not ${scheme.toLowerCase()}` : ""}`);
    }
}

/** Where a page is now: its URL and its frames' (a game sent on to another origin, a game in a frame). */
function _pageUrls(page: Page): string[] {
    try {
        return [page.url(), ...page.frames().map((frame: Frame): string => frame.url())];
    } catch {
        return [];
    }
}

/**
 * Keeps every window the game opens (a sponsor's, a leaderboard's: popup blocking is off, and DevTools does not follow
 * them) for the next open to close, with the windows those open in turn; what each goes through is noted as the page's
 * is (watchGameOrigins). Playwright reports a window as the page's popup whatever opened it: the page, a frame of
 * another site, a `noopener` call — and only once its first document's response has come: where the window is then is
 * noted at once (until 2026-09-30 a window that went on from its first document before the next open left that origin
 * uncleared: 1, 2, 3, 4 over four games). The first navigation's redirect hops are past by then too (cookies only: the
 * session's own context loses every cookie at each open, a browser's default context keeps them). Registered once per
 * page; a window leaves the list when it closes.
 */
export function watchGamePages(page: Page, session: GameSessionState): void {
    const opened: (popup: Page) => void = (popup: Page): void => {
        session.gamePages.add(popup);
        popup.once("close", (): void => {
            session.gamePages.delete(popup);
        });
        for (const url of _pageUrls(popup)) {
            _noteOrigin(session, url);
        }
        watchGameOrigins(popup, session);
        popup.on("popup", opened);
    };
    page.on("popup", opened);
}

/**
 * Closes the windows the game before opened (watchGamePages), never `page` itself (the session's), and returns where
 * each was, its frames included, for their origins to be cleared: left open, a window ran on in the next game — on its
 * clock, which is the context's, and writing into the origins cleared for it —, without the page scripts it would have
 * had as the game's page. Their `beforeunload` is not asked.
 */
export async function closeGamePages(page: Page, session: GameSessionState): Promise<string[]> {
    const urls: string[] = [];
    for (const opened of [...session.gamePages]) {
        session.gamePages.delete(opened);
        if (opened === page || opened.isClosed()) {
            continue;
        }
        urls.push(..._pageUrls(opened));
        await opened.close({ runBeforeUnload: false }).catch((): void => undefined);
    }
    return urls;
}

/** A target as the browser lists it (DevTools' `Target.getTargets`): the fields the windows' sweep reads. */
export interface ListedTarget {
    targetId: string;
    type: string;
    url: string;
    openerId?: string;
    browserContextId?: string;
}

/**
 * The windows the session's pages opened, as the browser lists them: the page targets of the page's context (`contextId`)
 * whose chain of openers leads to the page (`pageId`) or to a page no longer open — a window that closed, a page the
 * session replaced: in a context of its own, a page with an opener was opened by one of the session's pages. A page
 * with no opener (the session's, one DevTools made) and the windows it opened stay; never the page itself.
 */
export function openedTargets(pageId: string, contextId: string, targets: ListedTarget[]): ListedTarget[] {
    const pages: ListedTarget[] = targets.filter((t: ListedTarget): boolean => t.type === "page" && t.browserContextId === contextId);
    const listed: Set<string> = new Set(pages.map((t: ListedTarget): string => t.targetId));
    const reached: Set<string> = new Set([pageId]);
    let grew: boolean;
    do {
        grew = false;
        for (const target of pages) {
            const opener: string | undefined = target.openerId;
            if (!reached.has(target.targetId) && opener !== undefined && (reached.has(opener) || !listed.has(opener))) {
                reached.add(target.targetId);
                grew = true;
            }
        }
    } while (grew);
    return pages.filter((t: ListedTarget): boolean => t.targetId !== pageId && reached.has(t.targetId));
}

/** The page's own target (its id, its browser context's), from DevTools; undefined when it cannot be told (not Chromium, closing). */
async function _pageTarget(page: Page): Promise<{ targetId: string; browserContextId?: string } | undefined> {
    try {
        const cdp: CDPSession = await page.context().newCDPSession(page);
        try {
            const target: { targetInfo: { targetId: string; browserContextId?: string } } = await cdp.send("Target.getTargetInfo");
            return target.targetInfo;
        } finally {
            await cdp.detach().catch((): void => undefined);
        }
    } catch {
        return undefined;
    }
}

/**
 * Closes the windows the game before opened (closeGamePages) and, in the session's own context (`own`), those Playwright
 * has not reported yet: it reports a window only once its server has answered, so one opened as the game ended (a
 * leaderboard at game over) whose server was slow was in no list and ran on into the next game, writing into its freshly
 * cleared origin (measured 2026-09-30 with a 300 ms server; none with a 0 ms one). The browser lists it already, its
 * opener with it (a `noopener` one too): openedTargets, listed before any window is closed — a window's chain of openers
 * runs through the ones closed first. Returns where each was, for their origins to be cleared. A browser's default
 * context (a persistent profile, an attached Chrome) holds other sessions' pages and a person's tabs: there only the
 * reported windows are closed.
 */
async function _closeGameWindows(page: Page, session: GameSessionState, own: boolean | undefined): Promise<string[]> {
    const browser: Browser | null = own === true ? page.context().browser() : null;
    let browserSession: CDPSession | undefined;
    let unreported: ListedTarget[] = [];
    try {
        const target: { targetId: string; browserContextId?: string } | undefined = browser ? await _pageTarget(page) : undefined;
        if (browser && target?.browserContextId !== undefined) {
            browserSession = await browser.newBrowserCDPSession();
            const listed: { targetInfos: ListedTarget[] } = await browserSession.send("Target.getTargets");
            unreported = openedTargets(target.targetId, target.browserContextId, listed.targetInfos);
        }
    } catch {
        // not Chromium, or the browser is closing: the reported windows are still closed
    }
    try {
        const urls: string[] = await closeGamePages(page, session);
        for (const late of unreported) {
            // A reported one is closed already (closeGamePages): the browser no longer has it.
            urls.push(late.url);
            await browserSession?.send("Target.closeTarget", { targetId: late.targetId }).catch((): undefined => undefined);
        }
        return urls;
    } finally {
        await browserSession?.detach().catch((): void => undefined);
    }
}

/** Notes the web origin of `url` for the next open to clear (at most MAX_GAME_ORIGINS; not web: none). */
function _noteOrigin(session: GameSessionState, url: string): void {
    const origin: string | undefined = _webOrigin(url);
    if (origin !== undefined && session.gameOrigins.size < MAX_GAME_ORIGINS) {
        session.gameOrigins.add(origin);
    }
}

/**
 * Notes every web origin the game goes through, for the next open to clear: each one a document of the page commits
 * on — every frame's: a bounce through a sign-in or consent page as it loads, a frame it removes or sends elsewhere
 * later, a page it goes to in play, none of which the page is still on by then — and each one a navigation asks for (a
 * redirect's hops, which commit nothing and may set cookies). An about:, data: or blob: document is on its creator's
 * origin, noted with it, or on none. At most MAX_GAME_ORIGINS; registered once per page.
 */
export function watchGameOrigins(page: Page, session: GameSessionState): void {
    page.on("framenavigated", (frame: Frame): void => {
        _noteOrigin(session, frame.url());
    });
    page.on("request", (request: Request): void => {
        if (request.isNavigationRequest()) {
            _noteOrigin(session, request.url());
        }
    });
}

/** The origins the game before went through (watchGameOrigins), to clear; forgotten, so this game's are noted afresh. */
function _takeGameOrigins(session: GameSessionState): string[] {
    const origins: string[] = [...session.gameOrigins];
    session.gameOrigins.clear();
    return origins;
}

/**
 * Whether the page's browser context is the session's own — DevTools makes one per session (`newContext`) — and not the
 * browser's default context, which a persistent profile or an attached Chrome (a daemon started by hand) shares with every
 * session and, attached, with a person's own tabs. Asked once per session (DevTools: the page's context against the ones
 * made with `Target.createBrowserContext`, which the default one is not); undefined when it cannot be told (not Chromium),
 * asked again at the next open.
 */
async function _ownContext(page: Page, session: GameSessionState): Promise<boolean | undefined> {
    if (session.ownContext !== undefined) {
        return session.ownContext;
    }
    const browser: Browser | null = page.context().browser();
    if (!browser) {
        return undefined;
    }
    try {
        const browserSession: CDPSession = await browser.newBrowserCDPSession();
        try {
            const made: { browserContextIds: string[] } = await browserSession.send("Target.getBrowserContexts");
            const target: { browserContextId?: string } | undefined = await _pageTarget(page);
            if (target === undefined) {
                return undefined;
            }
            const id: string | undefined = target.browserContextId;
            session.ownContext = id !== undefined && made.browserContextIds.includes(id);
            return session.ownContext;
        } finally {
            await browserSession.detach().catch((): void => undefined);
        }
    } catch {
        return undefined;
    }
}

/**
 * Every game starts from a clean origin: what an earlier game left there — cookies, local storage, IndexedDB,
 * the cache (a high score, a tutorial marked seen) — is gone, so episode two plays as episode one. Run on the
 * empty page, after the page before has gone (what it writes as it goes is gone too), for the game's own origin,
 * every one the game before went through (watchGameOrigins) and those the page was on. The tab's session storage
 * of those origins it empties in Chrome, not in Playwright's headless shell: page/storage.ts empties it as the
 * game's documents start. In the session's own context (`own`) every cookie goes too: an origin's clearing leaves
 * its partitioned (CHIPS) cookies a frame of it set under the game's site, and the cookies of a host the game only
 * fetched from (its API) are no origin's it went through.
 */
async function _clearOrigins(page: Page, urls: string[], own: boolean | undefined): Promise<void> {
    const origins: Set<string> = new Set(urls.map(_webOrigin).filter((o: string | undefined): o is string => o !== undefined));
    if (origins.size > 0) {
        try {
            const cdp: CDPSession = await page.context().newCDPSession(page);
            try {
                for (const origin of origins) {
                    await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
                }
            } finally {
                await cdp.detach().catch((): void => undefined);
            }
        } catch {
            // not Chromium, or the page is closing: the game still plays, only not from a clean origin
        }
    }
    if (own === true) {
        await page
            .context()
            .clearCookies()
            .catch((): void => undefined);
    }
}

/**
 * Before a game loads: the windows the game before opened are closed (_closeGameWindows: in the session's own context
 * those not reported yet too), then the origins it went through and the page was on are cleared (`urls`: the game's own,
 * where the page was), the windows' with them, and in the session's own context every cookie. Run on the empty page: the
 * game before is gone.
 */
async function _cleanSlate(page: Page, session: GameSessionState, urls: string[]): Promise<void> {
    const own: boolean | undefined = await _ownContext(page, session);
    const opened: string[] = await _closeGameWindows(page, session, own);
    await _clearOrigins(page, [...urls, ...opened, ..._takeGameOrigins(session)], own);
}

/**
 * The page's time zone is UTC, whatever the machine's (a game that reads the local time — a day's level, a night theme —
 * reads 2026-01-01 00:00 at the game epoch everywhere: under America/Los_Angeles it read 31 Dec 16:00, under Asia/Tokyo
 * 1 Jan 09:00). DevTools sets none. Set for the page on a DevTools session kept open (closing it would lift the zone),
 * which holds across the page's loads; a replaced page gets its own at its next open. A zone already in force (one
 * DevTools or Playwright set) is left as it is. A frame of another site that runs in a process of its own (Chrome's site
 * isolation) keeps the machine's zone.
 */
async function _utcTimeZone(page: Page, state: GamePageState): Promise<void> {
    if (state.timezoneSession) {
        return;
    }
    let cdp: CDPSession | undefined;
    try {
        cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
        state.timezoneSession = cdp;
    } catch {
        // not Chromium, a zone already in force, or the page is closing: the machine's zone stays (tried again next open)
        await cdp?.detach().catch((): void => undefined);
    }
}

/** Removes init scripts; one the page no longer has is gone already. */
async function _dispose(scripts: (Disposable | undefined)[]): Promise<void> {
    for (const script of scripts) {
        await script?.dispose().catch((): void => undefined);
    }
}

/**
 * This open's token for the session storage clearing (page/storage.ts): a storage marked with it was emptied in this
 * game already. Digits only: the game can read it, and it parses as JSON.
 */
function _openToken(): string {
    return String(1 + Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1)));
}

/**
 * This game's own page scripts, in this order: its session storage clearing (page/storage.ts, with this open's token),
 * its `initScripts`, its seed. Kept for the whole game — the load, the boot and play: a document that starts late (a
 * frame added in the boot, a lazy frame, a page the game loads) still finds its storage emptied once, and what the game
 * stored kept — and removed at the next game's start (a closed page takes them with it).
 */
async function _addGameScripts(page: Page, state: GamePageState, args: OpenRequest): Promise<void> {
    state.sessionClear = await page.addInitScript(clearSessionStorage, _openToken());
    for (const script of args.initScripts ?? []) {
        state.gameScripts.push(await page.addInitScript({ content: script }));
    }
    state.seedScript = args.seed !== undefined ? await page.addInitScript(seedRandom, args.seed) : undefined;
}

/**
 * With the animation clock, the page's animation timeline is held still (DevTools: playback rate 0), so
 * an animation or transition the page starts does not move at all until game time moves it — else one
 * started inside a slice of game time ran in real time until it was taken over, and a short transition
 * could end there on a loaded machine and not on an idle one (a sprite's tilt). Without it,
 * the timeline runs again.
 */
async function _holdTimeline(page: Page, state: GamePageState, hold: boolean): Promise<void> {
    try {
        if (!state.animationSession) {
            if (!hold) {
                return;
            }
            state.animationSession = await page.context().newCDPSession(page);
            await state.animationSession.send("Animation.enable");
        }
        await state.animationSession.send("Animation.setPlaybackRate", { playbackRate: hold ? 0 : 1 });
    } catch {
        // not Chromium, or the page is closing: the animation clock still takes animations over as it sees them
    }
}

/**
 * Leaves the frozen clock exactly on an animation frame (the frame just run): the frames each later step
 * runs then fall the same way in every run, whatever phase the load left the clock in. Returns the first
 * error the page's own code threw in the frames it ran.
 */
async function _onFrame(page: Page, animations: boolean = false): Promise<string | undefined> {
    const key: string = `${PAGE_NAMESPACE}Frame`;
    let pageError: string | undefined;
    try {
        // Measured again after each move: a clock that ran in real time sits between milliseconds, and the move rounds.
        for (let attempt: number = 0; attempt < 3; attempt++) {
            await page.evaluate((k: string): void => {
                const w: any = window as any;
                w[k] = undefined;
                requestAnimationFrame((): void => {
                    w[k] = performance.now();
                });
            }, key);
            const framed: string | undefined = await runGameTime(page, FRAME_MS, animations);
            pageError = pageError ?? framed;
            const since: number | undefined = await page.evaluate((k: string): number | undefined => {
                const at: unknown = (window as any)[k];
                return typeof at === "number" ? performance.now() - at : undefined;
            }, key);
            if (since === undefined || since <= 0 || since >= FRAME_MS) {
                return pageError;
            }
            const moved: string | undefined = await runGameTime(page, Math.max(1, Math.round(FRAME_MS - since)), animations);
            pageError = pageError ?? moved;
        }
    } catch {
        // a page that cannot run it (closed, navigating): the game still plays, only less exactly replayed
    }
    return pageError;
}

/**
 * Stops the clock at `moment`; false when that moment had passed ("Cannot fast-forward to the past"), the clock not
 * stopped there. The page's timers run on to the pause, and one that throws (the game before, left frozen) stops
 * nothing: the pause has landed.
 */
async function _pauseAt(page: Page, moment: number): Promise<boolean> {
    try {
        await page.clock.pauseAt(moment);
        return true;
    } catch (err: unknown) {
        if (clockMomentPassed(err)) {
            return false;
        }
        if (await pageThrew(page, err)) {
            return true;
        }
        throw err;
    }
}

/**
 * Stops the clock at `at`, or a moment after the page's time (without `at`, or when the clock is already past it).
 * On a loaded machine that moment can pass before the call lands: read again, a wider moment.
 */
async function _pauseClock(page: Page, at?: number): Promise<void> {
    if (at !== undefined && (await _pauseAt(page, at))) {
        return;
    }
    for (let attempt: number = 1; attempt <= PAUSE_ATTEMPTS; attempt++) {
        const now: number = await page.evaluate((): number => Date.now()).catch((): number => Date.now());
        if (await _pauseAt(page, now + PAUSE_AFTER_MS * attempt * attempt)) {
            return;
        }
    }
    throw new Error(`${GameTool.OPEN} could not stop the page's clock: its time ran past every moment tried`);
}

export class OpenGame implements Tool {
    name(): string {
        return GameTool.OPEN;
    }

    description(): string {
        return "Loads a game page with its perception adapters installed and its clock frozen after boot; the game then moves only by <game_step>.";
    }

    inputSchema(): ToolInputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            url: z
                .string()
                .url()
                .refine((url: string): boolean => _webOrigin(url) !== undefined, { message: "must be an http: or https: URL" })
                .describe("The game page (http or https)."),
            adapters: z.array(z.nativeEnum(Adapter)).default([]).describe("Perception adapters installed before the page runs."),
            initScripts: z.array(z.string()).optional().describe("The game's own page scripts, installed before the page's."),
            seed: z.number().int().optional().describe("Seeds Math.random and crypto's random values: the same seed plays the same course."),
            viewport: z.object({ width: z.number().int().min(100).max(4000), height: z.number().int().min(100).max(4000) }).optional(),
            bootMs: z
                .number()
                .int()
                .min(0)
                .max(MAX_BOOT_MS)
                .default(DEFAULT_BOOT_MS)
                .describe("Game time the page boots in, frame by frame, before the first step (ms); real time with freezeClock false."),
            freezeClock: z.boolean().default(true).describe("False: the page keeps its own clock."),
            read: z.string().optional().describe("Page expression that reads the raw input."),
            score: z.string().optional().describe("Page expression read for measuring: { over, score, … }."),
            clickTarget: z.string().default("canvas").describe("CSS selector a click clicks the centre of."),
            animationClock: z.boolean().default(false).describe("The page's CSS animations and transitions run on game time too."),
            style: z.string().optional().describe("CSS added to the page once it has loaded (what is not the game hidden)."),
        };
    }

    outputSchema(): ToolOutputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            url: z.string(),
            title: z.string(),
            status: z.number().optional(),
            pageError: z.string().optional(),
        };
    }

    async handle(context: BrowserToolSessionContext, input: ToolInput): Promise<ToolOutput> {
        const args: OpenRequest = input as unknown as OpenRequest;
        checkGameUrl(args.url);
        const page: BrowserToolSessionContext["page"] = context.page;
        const session: GameSessionState = sessionState(context);
        const state: GamePageState = pageState(context);
        const freeze: boolean = args.freezeClock !== false;
        // A game that moves things with CSS: its animations follow game time, as its timers do.
        const animations: boolean = freeze && args.animationClock === true;
        // Where the page is now (where the game before ended; before a session's first game, wherever the page was):
        // cleared with this game's own origin and every one the game before went through.
        const leaving: string[] = _pageUrls(page);

        await releaseAll(context, state);
        // The game before's own scripts go before anything loads: none runs in a document of this game (the empty page's
        // included). This game's are added just before its load (_addGameScripts).
        await _dispose([state.sessionClear, ...state.gameScripts, state.seedScript]);
        state.sessionClear = undefined;
        state.gameScripts = [];
        state.seedScript = undefined;
        // Before anything loads, frozen or not: every document of the page reads its local time in UTC.
        await _utcTimeZone(page, state);
        if (session.clockInstalled && !freeze) {
            // A paused clock left by the previous game: this page runs in real time.
            await page.clock.resume().catch((): void => undefined);
        }
        if (freeze && !session.clockInstalled) {
            // The clock goes in before any page script: a document runs its init scripts in the order they were added
            // (the clock's are the context's), and the timer nudge and the log replay act on the clock — added before it,
            // the nudge wrapped the native timers the clock then replaced, and the replay read no clock at all.
            // Stopped on an empty page: the session's first pauseAt installs the clock. Not install() before it: every
            // later document replays the clock's log, and an install would put the real time up to the pause into it.
            // At a fixed moment, not the real time: the first moment a document's log sets is its clock's origin
            // (`performance.timeOrigin`). A clock this pause injects starts at 0, long before it.
            await page.goto(BLANK_PAGE, { waitUntil: "load" }).catch((): null => null);
            session.clockInstalled = true;
            await _pauseClock(page, GAME_EPOCH_MS);
        }
        // A seeded game is the same game whatever reads it: the Phaser adapter sows a Phaser game's own RNG
        // from the seed (and drops its frame carry-over after the boot), so it comes whenever a seed does —
        // it does nothing on a page without Phaser. Read by its pixels, a Phaser game drew other walls each load.
        const adapters: Adapter[] = [...(args.adapters ?? [])];
        if (args.seed !== undefined && !adapters.includes(Adapter.PHASER)) {
            adapters.push(Adapter.PHASER);
        }
        for (const adapter of adapters) {
            if (!state.installed.has(adapter)) {
                await page.addInitScript(INSTALLERS[adapter]);
                state.installed.add(adapter);
            }
        }
        if (!state.installed.has("inputs")) {
            await page.addInitScript(installInputCounter);
            state.installed.add("inputs");
        }
        if (!state.installed.has("origins")) {
            // From here, every origin a game of this page goes through is noted, for the next open to clear, and every
            // window it opens kept, for the next open to close.
            watchGameOrigins(page, session);
            watchGamePages(page, session);
            state.installed.add("origins");
        }
        if (freeze && !state.installed.has("timers")) {
            // After the clock's own scripts (installed above): the nudge wraps the frozen clock's timers, and every
            // document reads the clock as it starts, so the clock's log is replayed at once.
            await page.addInitScript(replayClockLog);
            await page.addInitScript(installTimerNudge);
            state.installed.add("timers");
        }
        if (!state.installed.has("decodes")) {
            // What the page decodes, compiles or reads off its thread as it boots is waited for as its requests are:
            // frozen, between boot frames; in real time, before its boot time counts.
            await page.addInitScript(installDecodeCounter);
            state.installed.add("decodes");
        }
        if (animations && !state.installed.has("animations")) {
            await page.addInitScript(installAnimationClock);
            state.installed.add("animations");
        }
        await _holdTimeline(page, state, animations);
        if (args.viewport) {
            await page.setViewportSize(args.viewport);
        }
        state.read = args.read;
        state.score = args.score;
        state.clickTarget = args.clickTarget ?? "canvas";
        state.clickBox = undefined;
        state.clickBoxDoc = undefined;
        state.animationClock = animations;

        let response: Response | null;
        // The first error the page's own code threw as it booted: reported, not thrown (the boot ran on).
        let pageError: string | undefined;
        if (freeze) {
            // Stopped again after the page scripts: a document replays the clock's log in pieces — what came before the
            // first page script that reads the time (the replay's own), then the rest at the next read — and each piece
            // from running, so a piece that does not start with a pause runs the clock on in real time. Every page script
            // an open adds once for the page comes before this pause; the game's own come before one of their own.
            await _pauseClock(page);
            // Every game loads from the same footing: an empty page loaded with the clock stopped, left on a frame,
            // and the wall clock set just before the load. A page that takes its start time as it loads then reads
            // the same time and meets its first frame as many milliseconds later in every run, first game of a
            // session or not. (Aligned on the empty page, whose clock is the log's: the page before ran its own on
            // by the pause.)
            await page.goto(BLANK_PAGE, { waitUntil: "load" }).catch((): null => null);
            await _onFrame(page);
            await _cleanSlate(page, session, [args.url, ...leaving]);
            await page.clock.setSystemTime(GAME_EPOCH_MS);
            // The game's own scripts after the clock's log up to its load: one that reads the clock as a document starts
            // reads the moment the page loads at, in every game of a session (added before, from a session's second game
            // on, they read the clock where the game before had left it). Then a pause at that moment, which moves
            // nothing: the piece of the log a later document (a frame the game adds, a page it loads) replays after them
            // still starts with a pause.
            await _addGameScripts(page, state, args);
            await _pauseClock(page, GAME_EPOCH_MS);
            // A file still coming holds every boot frame, however long it has been open (a big file over a slow host):
            // a boot that ran on without it had the start pressed on the page's loading screen.
            const network: InFlight = new InFlight(page);
            try {
                await network.followData(SLOW_LOAD_WAIT_MS);
                response = await page.goto(args.url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
                await _addStyle(page, args.style);
                for (let t: number = 0; t < (args.bootMs ?? DEFAULT_BOOT_MS); t += FRAME_MS) {
                    await network.settled();
                    const error: string | undefined = await runGameTime(page, FRAME_MS, animations);
                    pageError = pageError ?? error;
                }
                await network.settled();
            } finally {
                network.dispose();
            }
            const aligning: string | undefined = await _onFrame(page, animations);
            pageError = pageError ?? aligning;
            if (animations) {
                // Held again on the game's own document, and whatever it started taken over where it stands.
                await _holdTimeline(page, state, true);
                await takeAnimations(page, 0);
            }
            if (adapters.includes(Adapter.PHASER)) {
                await page.evaluate(`window.${PAGE_NAMESPACE}.phaser && window.${PAGE_NAMESPACE}.phaser.settle()`).catch((): void => undefined);
            }
        } else {
            // A fresh load on a clean origin, as frozen: the page before (and every window its game opened) is gone before
            // the clearing (what it writes as it goes is cleared too), and the same URL with a #fragment is loaded again,
            // not scrolled to.
            await page.goto(BLANK_PAGE, { waitUntil: "load" }).catch((): null => null);
            await _cleanSlate(page, session, [args.url, ...leaving]);
            await _addGameScripts(page, state, args);
            // The boot's time counts once what the page loads has come — its files, what it decodes —, as no frozen boot
            // frame runs before it, and once more after it (what the boot set off, a menu loading its own): a page still
            // loading after its load event (nothing cached yet) had its start pressed on its loading screen, and played
            // its whole game on its menu.
            const network: InFlight = new InFlight(page, LIVE_STALE_REQUEST_MS);
            try {
                await network.followData(SLOW_LOAD_WAIT_MS);
                response = await page.goto(args.url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
                await _addStyle(page, args.style);
                const until: number = Date.now() + SLOW_LOAD_WAIT_MS;
                await network.quiet(until);
                await page.waitForTimeout(args.bootMs ?? DEFAULT_BOOT_MS);
                await network.quiet(until);
            } finally {
                network.dispose();
            }
        }
        // A new document counts its inputs from zero, under an id of its own.
        const inputs: { doc: string; received: number } | undefined = await inputCount(page);
        state.inputsDoc = inputs?.doc;
        state.inputsSent = inputs?.received ?? 0;
        const result: OpenResult = {
            url: page.url(),
            title: await page.title().catch((): string => ""),
            ...(response ? { status: response.status() } : {}),
            ...(pageError ? { pageError } : {}),
        };
        return { ...result };
    }
}
