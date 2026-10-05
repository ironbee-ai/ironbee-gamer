/**
 * The game tools inside a real IronBee DevTools daemon, on a local fixture
 * game (tests/fixtures/runner.html): the clock is frozen after boot and moves
 * only by steps, the canvas recorder sees the sprites, held keys stay held,
 * a seed reproduces a course, sprites can be cropped, and the whole loop plays.
 * Also: every game on a clean origin and a fresh load (every origin the game
 * before went through cleared too: a bounce, a redirect's hop, a frame it
 * removed, the first document of a window it opened; the windows it opened
 * closed first, one whose server had not answered yet too; every cookie, a frame's
 * partitioned ones and an API host's too; the tab's session storage too, once for each storage in each game,
 * whenever its first document starts — a frame added in the boot, a lazy one
 * in play —, and what a game stores there kept: its own scripts, its frames, a
 * launcher, a relay frame of its own origin under another's, a bounce through
 * another origin), the same
 * moment at load in every session (its clock's origin too) and for a game's own
 * scripts in every game of a session, and steps that do not wait on inputs a page
 * cannot count; a page's fractional timers nudged in every game of a session, a
 * loader's chained files, decoding, WebAssembly and IndexedDB in the frame it
 * asked in, what a page set off as it loaded started in the boot, the page's own
 * errors reported, not thrown (and not taken for a clock that ran past its
 * pause), the game time asked run whole when the page shows a native dialog in
 * it, and expressions that end in a comment or do not compile; the local
 * time in UTC whatever the machine's zone, crypto's draws seeded, the click
 * target measured in each document, and image ids for the picture's sources only.
 *
 * Needs the built plugin (npm run build) and a browser; runs when IBGAMER_E2E=1.
 */

import { DevtoolsClient } from "../../src/devtools/client";
import { DaemonHandle, ensureDaemon, freePort } from "../../src/devtools/daemon";
import { Adapter, adapterReadExpression, OpenResult, StepResult } from "../../src/devtools/protocol";
import { GameDefinition, Perception } from "../../src/game/types";
import { Pace, Player, PlayResult } from "../../src/play/player";
import { FakeEngine } from "../helpers/fake-engine";
import { fakeProfile } from "../helpers/fake-game";

import { readFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import path from "path";

const live: boolean = process.env.IBGAMER_E2E === "1";
const describeLive: jest.Describe = live ? describe : describe.skip;

const SCORE: string = "({ over: window.game.over, score: window.game.score, gaps: window.game.gaps.slice(0, 3), downAt: window.game.downAt, ups: window.game.ups })";
/** How long the fixture server holds back /slow.js (a script the network is slow to bring). */
const SLOW_SCRIPT_MS: number = 400;
/** How long the server of the window game-over.html opens at its end takes to answer (the next game is opened meanwhile). */
const LATE_WINDOW_MS: number = 300;

describeLive("game tools in a DevTools daemon", (): void => {
    jest.setTimeout(120_000);
    let server: Server;
    /** The same pages on another port: another origin, for a game that sends the page on to one. */
    let otherServer: Server;
    let url: string;
    let otherUrl: string;
    let daemon: DaemonHandle;
    let client: DevtoolsClient;

    const listen: (s: Server) => Promise<string> = async (s: Server): Promise<string> => {
        await new Promise<void>((resolve: () => void): void => {
            s.listen(0, "127.0.0.1", resolve);
        });
        return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
    };

    beforeAll(async (): Promise<void> => {
        const fixture: (name: string) => string = (name: string): string => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf-8");
        const html: string = fixture("runner.html");
        const pages: Record<string, string> = {};
        for (const name of [
            "webgl.html",
            "css.html",
            "storage.html",
            "keys.html",
            "clock.html",
            "clock-slow.html",
            "pointer.html",
            "navigate.html",
            "timers.html",
            "chain.html",
            "loading.html",
            "throws.html",
            "stray.html",
            "decode.html",
            "pasta.html",
            "session.html",
            "session-frame.html",
            "launch.html",
            "launched.html",
            "late.html",
            "relay.html",
            "relay-frame.html",
            "relay-inner.html",
            "bounce.html",
            "bounce-away.html",
            "bounce-back.html",
            "sampled.html",
            "wasm.html",
            "idb.html",
            "through.html",
            "visited.html",
            "opener.html",
            "opened.html",
            "cookies.html",
            "partitioned.html",
            "menu.html",
            "zone.html",
            "rng.html",
            "buffers.html",
            "first-stop.html",
            "dialogs.html",
            "game-over.html",
            "leaderboard.html",
        ]) {
            pages[`/${name}`] = fixture(name);
        }
        const serve: (req: IncomingMessage, res: ServerResponse) => void = (req: IncomingMessage, res: ServerResponse): void => {
            const at: string = (req.url ?? "").split("?")[0];
            if (at === "/leaderboard.html") {
                // A window's page whose server is slow to answer (?ms=…).
                setTimeout((): void => {
                    res.writeHead(200, { "content-type": "text/html" });
                    res.end(pages[at]);
                }, Number(new URL(req.url ?? "", url).searchParams.get("ms") ?? 0));
                return;
            }
            if (at === "/slow.js") {
                setTimeout((): void => {
                    res.writeHead(200, { "content-type": "text/javascript" });
                    res.end("window.slow = true;");
                }, SLOW_SCRIPT_MS);
                return;
            }
            if (at === "/held") {
                // A file the network is slow to bring (?ms=…), and then does not have.
                setTimeout((): void => {
                    res.writeHead(404);
                    res.end();
                }, Number(new URL(req.url ?? "", url).searchParams.get("ms") ?? 0));
                return;
            }
            if (at === "/stream") {
                // A big file a slow host sends in pieces over ?ms=…: data all the way, the last piece at the end.
                const pieces: number = 20;
                let sent: number = 0;
                res.writeHead(200, { "content-type": "application/octet-stream" });
                const timer: NodeJS.Timeout = setInterval((): void => {
                    res.write(Buffer.alloc(1024));
                    if (++sent === pieces) {
                        clearInterval(timer);
                        res.end();
                    }
                }, Number(new URL(req.url ?? "", url).searchParams.get("ms") ?? 0) / pieces);
                return;
            }
            if (at === "/redirect") {
                res.writeHead(302, { location: `${otherUrl}storage.html` });
                res.end();
                return;
            }
            if (at === "/hop") {
                // A redirect a game's navigation goes through (sign-in, consent): counts its visits in a cookie of its
                // host and sends the tab back (?back=<url>) with the count. No document is ever on it.
                const hops: number = Number(/(?:^|; )hops=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? 0) + 1;
                const back: URL = new URL(new URL(req.url ?? "", url).searchParams.get("back") ?? url);
                back.searchParams.set("cookie", String(hops));
                res.writeHead(302, { "set-cookie": `hops=${hops}; max-age=3600`, location: back.href });
                res.end();
                return;
            }
            if (at === "/visit") {
                // An API a game of another host fetches with its credentials: counts the visits in a cookie of its own host
                // (a third party's: SameSite=None, which needs Secure — http://localhost has it).
                const visits: number = Number(/(?:^|; )api=(\d+)/.exec(req.headers.cookie ?? "")?.[1] ?? 0) + 1;
                res.writeHead(200, {
                    "content-type": "application/json",
                    "access-control-allow-origin": String(req.headers.origin ?? "*"),
                    "access-control-allow-credentials": "true",
                    "set-cookie": `api=${visits}; max-age=3600; SameSite=None; Secure`,
                });
                res.end(JSON.stringify({ visits }));
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end(pages[at] ?? html);
        };
        server = createServer(serve);
        otherServer = createServer(serve);
        url = await listen(server);
        otherUrl = await listen(otherServer);
        daemon = await ensureDaemon({ port: await freePort(), headless: true });
    });

    afterAll(async (): Promise<void> => {
        await client?.close();
        await daemon?.stop();
        server?.close();
        otherServer?.close();
    });

    beforeEach((): void => {
        client = new DevtoolsClient({ baseUrl: daemon.baseUrl });
    });

    afterEach(async (): Promise<void> => {
        await client.close();
    });

    /** Steps without game time until what the page reads passes `done` (what it learns in real time: a frame's message, a navigation), 5 s at most. */
    const readUntil = async <T>(done: (raw: T) => boolean): Promise<T> => {
        const deadline: number = Date.now() + 5_000;
        // A page that is navigating cannot be read: read again.
        const read = async (): Promise<T> => (await client.step({}).catch((): StepResult => ({}))).raw as T;
        let raw: T = await read();
        while (!done(raw) && Date.now() < deadline) {
            await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 50));
            raw = await read();
        }
        return raw;
    };

    /** What `read` says after `page` has booted, in a session of its own. */
    const afterBoot: (page: string, read: string) => Promise<unknown> = async (page: string, read: string): Promise<unknown> => {
        const fresh: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
        try {
            await fresh.open({ url: `${url}${page}`, adapters: [], read, score: "({ over: false, score: 0 })", bootMs: 200 });
            return (await fresh.step({})).raw;
        } finally {
            await fresh.close();
        }
    };

    const open = (seed?: number): Promise<unknown> =>
        client.open({
            url,
            adapters: [Adapter.CANVAS2D],
            read: adapterReadExpression(Adapter.CANVAS2D),
            score: SCORE,
            bootMs: 500,
            viewport: { width: 700, height: 300 },
            ...(seed !== undefined ? { seed } : {}),
        });

    it("freezes the clock: the game moves only by steps, by exactly the time asked", async (): Promise<void> => {
        await open(1);
        const a: StepResult = await client.step({});
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 500));
        const b: StepResult = await client.step({});
        expect(b.clockMs).toBe(a.clockMs);
        const c: StepResult = await client.step({ advanceMs: 1000 });
        expect((c.clockMs ?? 0) - (a.clockMs ?? 0)).toBe(1000);
        expect(c.score?.score).toBeGreaterThan(a.score?.score ?? 0);
    });

    it("runs the game time asked whole when the page shows a native dialog in it: in steps, frame by frame, and as it boots", async (): Promise<void> => {
        type Seen = { frame: number; dialogs: number; now: number };
        /**
         * The game time the page's clock ran by the end of each of `steps` of 500 ms, then after 300 ms more of real time
         * (from where the open left it), in a session's first game; and what the steps reported.
         */
        const played = async (animationClock: boolean, steps: number): Promise<{ ran: number[]; errors: string[]; after: Seen; later: number }> => {
            const fresh: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
            try {
                await fresh.open({ url: `${url}dialogs.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 0, animationClock });
                const start: number = ((await fresh.step({})).raw as Seen).now;
                const ran: number[] = [];
                const errors: string[] = [];
                for (let i: number = 0; i < steps; i++) {
                    const step: StepResult = await fresh.step({ advanceMs: 500 });
                    ran.push((step.raw as Seen).now - start);
                    errors.push(...(step.pageError ? [step.pageError] : []));
                }
                await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 300));
                const after: Seen = (await fresh.step({})).raw as Seen;
                return { ran, errors, after, later: after.now - start };
            } finally {
                await fresh.close();
            }
        };
        for (const animationClock of [false, true]) {
            // A timer of the game's loop opens a dialog in its 10th frame and every 20th after. Playwright's clock call came
            // back at the dialog, and the page ran the rest alone in real time: until 2026-09-30 six steps of 500 ms ran 145,
            // 480, 785, 1105, 1425, 1745 ms, and a step of 1000 ms read performance.now() 176, not 1032, the page going on to
            // 1032 with no game time asked.
            const { ran, errors, after, later } = await played(animationClock, 6);
            expect([animationClock, ran, errors]).toEqual([animationClock, [500, 1000, 1500, 2000, 2500, 3000], []]);
            // Nothing ran on between steps; the dialogs were shown (and dismissed).
            expect([animationClock, later]).toEqual([animationClock, 3000]);
            expect(after.dialogs).toBeGreaterThanOrEqual(8);
        }
        // The boot: it ends where a boot without dialogs does.
        const booted = async (query: string): Promise<{ opened: OpenResult; seen: Seen }> => {
            const fresh: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
            try {
                const opened: OpenResult = await fresh.open({ url: `${url}dialogs.html${query}`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 1000 });
                return { opened, seen: (await fresh.step({})).raw as Seen };
            } finally {
                await fresh.close();
            }
        };
        const quiet: { opened: OpenResult; seen: Seen } = await booted("?quiet");
        const loud: { opened: OpenResult; seen: Seen } = await booted("");
        expect([loud.seen.now, loud.seen.frame, loud.opened.pageError]).toEqual([quiet.seen.now, quiet.seen.frame, undefined]);
        expect(loud.seen.dialogs).toBeGreaterThanOrEqual(3);
    });

    it("runs a page's CSS animations on game time with the animation clock, and in real time without it", async (): Promise<void> => {
        const openCss = (animationClock: boolean): Promise<unknown> =>
            client.open({ url: `${url}css.html`, adapters: [], read: "window.pos()", score: "({ over: false, score: 0 })", bootMs: 100, ...(animationClock ? { animationClock } : {}) });
        const at = (r: StepResult): { box: number; held: number } => r.raw as { box: number; held: number };
        await openCss(true);
        const a: StepResult = await client.step({});
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 400));
        const b: StepResult = await client.step({});
        // Held while the game waits for a decision, then moved by exactly the game time a step runs.
        expect(at(b).box).toBe(at(a).box);
        const c: StepResult = await client.step({ advanceMs: 320 });
        expect(Math.abs(at(c).box - at(a).box - 320)).toBeLessThanOrEqual(2);
        // The one the page holds itself stays where it is.
        expect(at(c).held).toBe(at(a).held);
        await openCss(false);
        const d: StepResult = await client.step({});
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 400));
        const e: StepResult = await client.step({});
        expect(at(e).box - at(d).box).toBeGreaterThan(200);
    });

    it("opens every game on a clean origin: what an earlier game stored there, or wrote as it left, is gone", async (): Promise<void> => {
        const openStorage = (freezeClock: boolean): Promise<unknown> =>
            client.open({ url: `${url}storage.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100, ...(freezeClock ? {} : { freezeClock }) });
        // The tab's session storage too, which is not the origin's.
        for (const freezeClock of [true, true, false, false, true]) {
            await openStorage(freezeClock);
            expect((await client.step({})).raw).toEqual({ loads: 1, visits: 1, left: null, session: 1 });
        }
    });

    it("keeps what a game stores in the tab's session storage as it loads — its own scripts, beside the frames it adds — and empties it for the next game", async (): Promise<void> => {
        type Stored = { loads: number; afterBlank: number; init: string | null; framed: Record<string, number> };
        const own: string = new URL(url).origin;
        const other: string = new URL(otherUrl).origin;
        for (const freezeClock of [true, true, false]) {
            await client.open({
                url: `${url}session.html?other=${encodeURIComponent(otherUrl)}`,
                adapters: [],
                // The game's own script, which stores as each document starts.
                initScripts: ['sessionStorage.setItem("init", "stored by the game");'],
                read: "window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            // The frames tell the page in real time: read until both have.
            const deadline: number = Date.now() + 5_000;
            let stored: Stored = (await client.step({})).raw as Stored;
            while (Object.keys(stored.framed).length < 2 && Date.now() < deadline) {
                await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 50));
                stored = (await client.step({})).raw as Stored;
            }
            // What the page stored before its about:blank frame and a frame of its own origin started is still there;
            // in the next game each counts from one again, a frame of another origin in its own session storage too.
            expect(stored).toEqual({ loads: 1, afterBlank: 1, init: "stored by the game", framed: { [own]: 1, [other]: 1 } });
        }
    });

    it("keeps what a launcher stores in the tab's session storage for the page it sends the tab on to, and empties it for the next game", async (): Promise<void> => {
        for (const freezeClock of [true, true, false]) {
            await client.open({ url: `${url}launch.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100, ...(freezeClock ? {} : { freezeClock }) });
            expect((await client.step({})).raw).toEqual({ token: "from the launcher", loads: 1 });
        }
    });

    it("empties the session storage of a frame that starts after the load — added in the boot, or lazy and scrolled to in play — once in every game", async (): Promise<void> => {
        type Late = { loads: number; framed: number | null } | undefined;
        const late = async (frame: string, freezeClock: boolean): Promise<Late> => {
            await client.open({
                url: `${url}late.html?other=${encodeURIComponent(otherUrl)}&frame=${frame}`,
                adapters: [],
                read: "window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            if (frame === "lazy") {
                // Far down the page: not loaded, however long the page waits, until the game scrolls to it.
                expect(((await client.step({ waitMs: 200 })).raw as Late)?.framed).toBeNull();
                await client.step({ press: ["l"], advanceMs: 16 });
            }
            return readUntil<Late>((s: Late): boolean => s !== undefined && s.framed !== null);
        };
        // The page removes the frame once it has told it: the next game's origin clearing names its origin, but empties its
        // session storage in Chrome only, not in Playwright's headless shell.
        for (const freezeClock of [true, true, false, true]) {
            expect(await late("timer", freezeClock)).toEqual({ loads: 1, framed: 1 });
        }
        for (let i: number = 0; i < 2; i++) {
            expect(await late("lazy", true)).toEqual({ loads: 1, framed: 1 });
        }
    });

    it("keeps what a game stores in the tab's session storage when a frame of its own origin starts under a frame of another", async (): Promise<void> => {
        type Relayed = { loads: number; inner: string | null } | undefined;
        for (const freezeClock of [true, true, false]) {
            await client.open({
                url: `${url}relay.html?other=${encodeURIComponent(otherUrl)}`,
                adapters: [],
                read: "window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            // The inner frame read what the page stored, and the page still has it.
            expect(await readUntil<Relayed>((s: Relayed): boolean => s !== undefined && s.inner !== null)).toEqual({ loads: 1, inner: "1" });
        }
    });

    it("keeps what a game stores in the tab's session storage across a bounce through another origin as it loads", async (): Promise<void> => {
        type Bounced = { state: string | null; loads: number } | undefined;
        for (const freezeClock of [true, true, false]) {
            await client.open({
                url: `${url}bounce.html?other=${encodeURIComponent(otherUrl)}`,
                adapters: [],
                read: "window.state && window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            expect(await readUntil<Bounced>((s: Bounced): boolean => s !== undefined)).toEqual({ state: "from before the bounce", loads: 1 });
        }
    });

    it("loads a real-time game afresh too: the same URL with a #fragment is loaded again, on a clean origin", async (): Promise<void> => {
        for (let i: number = 0; i < 2; i++) {
            await client.open({ url: `${url}storage.html#level-2`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100, freezeClock: false });
            expect((await client.step({})).raw).toEqual({ loads: 1, visits: 1, left: null, session: 1 });
        }
    });

    it("clears the origin a game URL sent the page on to, as well as its own", async (): Promise<void> => {
        for (let i: number = 0; i < 2; i++) {
            const opened: { url: string } = (await client.open({ url: `${url}redirect`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100 })) as { url: string };
            expect(opened.url).toBe(`${otherUrl}storage.html`);
            expect((await client.step({})).raw).toMatchObject({ loads: 1, left: null, session: 1 });
        }
    });

    it("clears every origin the game before went through, which the page is no longer on: a bounce as it loaded, a redirect's hop, a frame it removed", async (): Promise<void> => {
        type Visit = { local?: number; cookie: number } | null | undefined;
        // Another host, not only another port: its cookies are its own, not the game's host's.
        const away: string = otherUrl.replace("127.0.0.1", "localhost");
        for (const via of ["bounce", "hop", "frame"]) {
            for (const freezeClock of [true, false, true]) {
                await client.open({
                    url: `${url}through.html?via=${via}&other=${encodeURIComponent(away)}`,
                    adapters: [],
                    read: "window.state && window.state()",
                    score: "({ over: false, score: 0 })",
                    bootMs: 100,
                    ...(freezeClock ? {} : { freezeClock }),
                });
                // Every game finds that host's local storage and cookie empty, and counts one visit (the hop in its cookie
                // only: no document is ever on it).
                const visit: Visit = await readUntil<Visit>((v: Visit): boolean => v !== undefined && v !== null);
                expect([via, freezeClock, visit]).toEqual([via, freezeClock, via === "hop" ? { cookie: 1 } : { local: 1, cookie: 1 }]);
            }
        }
    });

    it("empties the cookie jar for every game: a frame's partitioned cookie, and the cookie of a host the game only fetched from", async (): Promise<void> => {
        // Another host, not only another port: its cookies are its own. An origin's clearing leaves both: the partitioned
        // cookie is kept under the game's site, and the API's host is no origin the game went through.
        const away: string = otherUrl.replace("127.0.0.1", "localhost");
        for (const shape of ["frame", "api"]) {
            for (const freezeClock of [true, true, false, true]) {
                await client.open({
                    url: `${url}cookies.html?shape=${shape}&other=${encodeURIComponent(away)}`,
                    adapters: [],
                    read: "window.state()",
                    score: "({ over: false, score: 0 })",
                    bootMs: 100,
                    ...(freezeClock ? {} : { freezeClock }),
                });
                const seen: number | null | undefined = await readUntil<number | null | undefined>((n: number | null | undefined): boolean => typeof n === "number");
                expect([shape, freezeClock, seen]).toEqual([shape, freezeClock, 1]);
            }
        }
    });

    it("closes the windows a game opened before the next game loads: none runs on into it, and what they stored is cleared", async (): Promise<void> => {
        type Opened = { token: string; atLoad: string | null; writers: string[]; visits: number | null } | undefined;
        // Another host, not only another port: its storage is its own.
        const away: string = otherUrl.replace("127.0.0.1", "localhost");
        for (const freezeClock of [true, true, false, true]) {
            await client.open({
                url: `${url}opener.html?other=${encodeURIComponent(away)}`,
                adapters: [],
                read: "window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            // The windows load in real time and write on their clock, the context's: game time frozen, real time not.
            const deadline: number = Date.now() + 5_000;
            let seen: Opened = (await client.step({})).raw as Opened;
            while ((seen === undefined || seen.writers.length < 2 || seen.visits === null) && Date.now() < deadline) {
                await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 50));
                seen = (await client.step(freezeClock ? { advanceMs: 100 } : {})).raw as Opened;
            }
            // More of it: a window a game before left open would have written its game's token by now.
            seen = (await client.step(freezeClock ? { advanceMs: 500 } : { waitMs: 500 })).raw as Opened;
            const token: string = seen?.token ?? "";
            // This game's two windows only, on an origin empty as the game loaded; the other host's counts one visit.
            expect([freezeClock, seen]).toEqual([freezeClock, { token, atLoad: null, writers: [`${token}:1`, `${token}:2`], visits: 1 }]);
        }
    });

    it("clears the origin a window's first document was on, which the window left at once", async (): Promise<void> => {
        type Visit = { local: number; cookie: number } | null | undefined;
        // Another host, not only another port: its storage is its own.
        const away: string = otherUrl.replace("127.0.0.1", "localhost");
        for (const freezeClock of [true, true, false, true]) {
            await client.open({
                url: `${url}first-stop.html?other=${encodeURIComponent(away)}`,
                adapters: [],
                read: "window.state()",
                score: "({ over: false, score: 0 })",
                bootMs: 100,
                ...(freezeClock ? {} : { freezeClock }),
            });
            // Playwright reports the window as its first document's response comes: that host is noted then, and every game's
            // window finds its local storage empty (until 2026-09-30: 1, 2, 3, 4; its cookie went with the jar).
            const visit: Visit = await readUntil<Visit>((v: Visit): boolean => v !== undefined && v !== null);
            expect([freezeClock, visit]).toEqual([freezeClock, { local: 1, cookie: 1 }]);
        }
    });

    it("closes a window a game opened as it ended whose server had not answered yet: it runs into no later game", async (): Promise<void> => {
        type Board = { atLoad: { board: string | null; ticks: string | null }; board: string | null; ticks: string | null };
        for (let game: number = 1; game <= 4; game++) {
            await client.open({ url: `${url}game-over.html?ms=${LATE_WINDOW_MS}`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100 });
            // A leaderboard the game before left would have loaded by now and written into this game's freshly cleared origin,
            // ticking there in the game time a step runs (until 2026-09-30: "1" from the second game on, two pages open).
            await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, LATE_WINDOW_MS + 500));
            const seen: Board = (await client.step({ advanceMs: 500 })).raw as Board;
            expect([game, seen]).toEqual([game, { atLoad: { board: null, ticks: null }, board: null, ticks: null }]);
            // Game over at 1 s of game time: the game opens its leaderboard, and the next game is opened at once.
            await client.step({ advanceMs: 500, observe: false });
        }
    });

    it("opens http(s) pages only", async (): Promise<void> => {
        for (const page of ["file:///etc/hosts", "data:text/html,<title>x</title>", "javascript:void(0)"]) {
            await expect(client.open({ url: page, adapters: [] })).rejects.toThrow(/http: or https:/);
        }
    });

    it("starts a frozen game at the same moment in every fresh session: the same Date.now(), performance.now() and timeOrigin as it loads", async (): Promise<void> => {
        type LoadedAt = { date: number; perf: number; origin: number };
        const loadedAt: (page: string) => Promise<LoadedAt> = async (page: string): Promise<LoadedAt> => {
            const fresh: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
            try {
                await fresh.open({ url: `${url}${page}`, adapters: [], read: "window.loadedAt", score: "({ over: false, score: 0 })", bootMs: 100 });
                return (await fresh.step({})).raw as LoadedAt;
            } finally {
                await fresh.close();
            }
        };
        // Sessions at once, one of them a page that first reads the time after a script the network held back.
        const [a, b, slow]: LoadedAt[] = await Promise.all([loadedAt("clock.html"), loadedAt("clock.html"), loadedAt("clock-slow.html")]);
        expect(b).toEqual(a);
        expect(a.date).toBe(Date.UTC(2026, 0, 1));
        // The clock's origin is the session's first pause: a fixed moment, not the real time the session started at.
        expect(a.origin).toBe(Date.UTC(2026, 0, 1));
        // On an animation frame of the frozen clock.
        expect(a.perf % 16).toBe(0);
        // Held back by the network, a page still reads the same moment: the clock was stopped as its document started.
        expect(slow).toEqual(a);
    });

    it("has a page read its local time in UTC whatever the machine's time zone, frozen or not", async (): Promise<void> => {
        const utc: Record<string, unknown> = { hours: 0, date: 1, offset: 0, zone: "UTC" };
        const local = async (on: DevtoolsClient, freezeClock: boolean): Promise<unknown> => {
            await on.open({ url: `${url}zone.html`, adapters: [], read: "window.local", score: "({ over: false, score: 0 })", bootMs: 100, ...(freezeClock ? {} : { freezeClock }) });
            return (await on.step({})).raw;
        };
        for (const freezeClock of [true, false, true]) {
            expect([freezeClock, await local(client, freezeClock)]).toEqual([freezeClock, utc]);
        }
        // A daemon whose browser runs in Los Angeles' zone, where the game epoch was 31 Dec 16:00.
        const elsewhere: DaemonHandle = await ensureDaemon({ port: await freePort(), headless: true, env: { TZ: "America/Los_Angeles" } });
        const there: DevtoolsClient = new DevtoolsClient({ baseUrl: elsewhere.baseUrl });
        try {
            for (const freezeClock of [true, false]) {
                expect([freezeClock, await local(there, freezeClock)]).toEqual([freezeClock, utc]);
            }
        } finally {
            await there.close();
            await elsewhere.stop();
        }
    });

    it("starts a game's own scripts on the clock its page loads at, in every game of a session", async (): Promise<void> => {
        type Sampled = { init: number; date: number; samples: number[]; frames: number[] };
        // A game script (a custom perception's) that samples the clock from the moment it starts, every 20 ms of game time.
        const script: string =
            "window.sampled = { at: performance.now(), date: Date.now(), samples: [] };" +
            "(function sample() { window.sampled.samples.push(performance.now()); if (window.sampled.samples.length < 6) { setTimeout(sample, 20); } })();";
        const read: string =
            "({ init: window.sampled.at - window.loadAt, date: window.sampled.date - Date.UTC(2026, 0, 1), samples: window.sampled.samples.map(function (s) { return s - window.loadAt; }), frames: window.frameTimes.map(function (f) { return f - window.loadAt; }) })";
        const games: Sampled[] = [];
        // Games of different lengths (17 ms steps leave the clock off the frame grid), and one in real time between.
        for (const steps of [3, 5, -1, 1, 2]) {
            if (steps < 0) {
                await client.open({ url: `${url}keys.html`, adapters: [], read: "0", score: "({ over: false, score: 0 })", bootMs: 100, freezeClock: false });
                continue;
            }
            await client.open({ url: `${url}sampled.html`, adapters: [], initScripts: [script], seed: 7, read, score: "({ over: false, score: 0 })", bootMs: 64 });
            games.push((await client.step({})).raw as Sampled);
            for (let i: number = 0; i < steps; i++) {
                await client.step({ advanceMs: 17 });
            }
        }
        // The script reads the moment the page loads at — the same wall clock, and on its frames — in every game.
        expect(games[0]).toMatchObject({ init: 0, date: 0, frames: [16, 32, 48, 64] });
        for (const game of games) {
            expect(game).toEqual(games[0]);
        }
    });

    it("nudges a page's fractional timers in every game of a session: the same ticks in each", async (): Promise<void> => {
        type Timers = { ticks: number; interval: number | null; since: number };
        const episode: () => Promise<Timers[]> = async (): Promise<Timers[]> => {
            await client.open({ url: `${url}timers.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100 });
            const out: Timers[] = [];
            // Steps of 50 ms against ticks of 1000 / 60 from where the page set its interval: every step ends exactly
            // on a tick, in real numbers.
            const since: number = ((await client.step({})).raw as Timers).since;
            out.push((await client.step({ advanceMs: 50 - (since % 50) })).raw as Timers);
            for (let i: number = 0; i < 30; i++) {
                out.push((await client.step({ advanceMs: 50 })).raw as Timers);
            }
            return out;
        };
        const ticks = (e: Timers[]): number[] => e.map((t: Timers): number => t.ticks);
        const first: Timers[] = await episode();
        for (const game of [first, await episode(), await episode()]) {
            // The clock keeps the interval a millionth of a millisecond late: a tick that meets a step's end lands just after it.
            expect(game[0].interval).toBeCloseTo(1000 / 60 + 1e-6, 9);
            // A later game of the session starts where the clock's log left it, not at zero: the same ticks all the same.
            expect(ticks(game)).toEqual(ticks(first));
        }
    });

    it("boots a loader that asks for its files one after another: every file in the frame it asked in, however the network answers", async (): Promise<void> => {
        const loaded: () => Promise<unknown> = (): Promise<unknown> => afterBoot("chain.html", "window.loaded");
        // Sessions at once (a busier machine): a boot frame runs only once the file a callback asked for has come too.
        for (const files of await Promise.all([loaded(), loaded(), loaded()])) {
            expect(files).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
        }
    });

    it("boots a page that decodes off its thread (a sound, a bitmap, an image), each job started when the last was done: all in the frame it began in", async (): Promise<void> => {
        const decoded: () => Promise<unknown> = (): Promise<unknown> => afterBoot("decode.html", "window.decoded");
        // Sessions at once (a busier machine): a boot frame runs only once what the page decodes is done.
        for (const frames of await Promise.all([decoded(), decoded(), decoded()])) {
            expect(frames).toEqual([1, 1, 1, 1, 1]);
        }
    });

    it("boots a page that compiles WebAssembly, each module started when the last was done: all in the frame it began in, in every session", async (): Promise<void> => {
        // Sessions one after another: on an idle machine a boot frame runs at once, and a compile that took a moment
        // came in a frame later.
        for (let i: number = 0; i < 3; i++) {
            expect(await afterBoot("wasm.html", "window.compiled")).toEqual([1, 1, 1, 1, 1]);
        }
    });

    it("boots a game that reads its save from IndexedDB as it loads, each request started when the last was done: all in the frame it began in, in every session", async (): Promise<void> => {
        for (let i: number = 0; i < 3; i++) {
            expect(await afterBoot("idb.html", "window.saved")).toEqual([1, 1, 1, 1, 1]);
        }
    });

    it("boots a real-time page once what it loads after its load event has come: its files one after another, a slow host's first byte, and a big file still coming", async (): Promise<void> => {
        const booted: (query: string) => Promise<{ raw: unknown; ms: number }> = async (query: string): Promise<{ raw: unknown; ms: number }> => {
            const started: number = Date.now();
            await client.open({ url: `${url}loading.html?${query}`, adapters: [], read: "({ ready: window.ready, loaded: window.loaded })", score: "({ over: false, score: 0 })", bootMs: 100, freezeClock: false });
            return { raw: (await client.step({})).raw, ms: Date.now() - started };
        };
        // Four files of 400 ms: the start is not pressed on the loading screen, 100 ms into a 1.6 s load.
        const chain: { raw: unknown; ms: number } = await booted("files=4&ms=400");
        expect(chain.raw).toEqual({ ready: true, loaded: 4 });
        expect(chain.ms).toBeGreaterThanOrEqual(1_600);
        // One file of 6 s, nothing coming until then: past the 5 s a frozen boot frame gives a request.
        expect((await booted("files=1&ms=6000")).raw).toEqual({ ready: true, loaded: 1 });
        // One file coming in pieces over 17 s, as a cold load's sound did: waited for while its data comes, however long.
        const big: { raw: unknown; ms: number } = await booted("stream=17000");
        expect(big.raw).toEqual({ ready: true, loaded: 1 });
        expect(big.ms).toBeGreaterThanOrEqual(17_000);
    }, 90_000);

    it("boots a frozen page through a big file still coming: every boot frame waits while its data comes, however long it has been open", async (): Promise<void> => {
        const started: number = Date.now();
        // One file coming in pieces over 7 s: past the 5 s a boot frame gives a request with no data coming.
        expect(await afterBoot("loading.html?stream=7000", "({ ready: window.ready, loaded: window.loaded })")).toEqual({ ready: true, loaded: 1 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(7_000);
    }, 60_000);

    it("starts what a page set off as it loaded in the boot's first frame, however long the load took", async (): Promise<void> => {
        for (const ms of [10, 300]) {
            await client.open({ url: `${url}stray.html?ms=${ms}`, adapters: [], read: "window.started", score: "({ over: false, score: 0 })", bootMs: 100 });
            // Not by the clock's own real-time timer (100 ms into the document), during a load that took longer.
            expect((await client.step({})).raw).toEqual({ frame: 0, state: "complete" });
        }
    });

    it("runs on past an error the page's own code throws in a frame, and reports it", async (): Promise<void> => {
        const opened: OpenResult = await client.open({ url: `${url}throws.html`, adapters: [], read: "window.frame", score: "({ over: false, score: 0 })", bootMs: 100 });
        expect(opened.pageError).toMatch(/Cannot read properties of null/);
        const booted: number = (await client.step({})).raw as number;
        // Frame 40 throws in this one: the step still runs all its frames.
        const past: StepResult = await client.step({ advanceMs: 800 });
        expect(past.pageError).toMatch(/Cannot read properties of null/);
        expect(past.raw).toBe(booted + 50);
        const next: StepResult = await client.step({ advanceMs: 160 });
        expect(next.pageError).toBeUndefined();
        expect(next.raw).toBe(booted + 60);
    });

    it("opens the next game after one whose frames keep throwing, whatever its scripts are called", async (): Promise<void> => {
        await client.open({ url: `${url}pasta.html`, adapters: [], read: "window.frame", score: "({ over: false, score: 0 })", bootMs: 100 });
        expect((await client.step({ advanceMs: 400 })).pageError).toMatch(/Cannot read properties of null/);
        // Stopping the clock for the next game runs the frames of this one, which throw from past() on pasta.html: the
        // page's errors, not a moment the clock had run past.
        const next: OpenResult = await client.open({ url: `${url}clock.html`, adapters: [], read: "window.loadedAt", score: "({ over: false, score: 0 })", bootMs: 100 });
        expect(next.title).toBe("clock fixture");
    });

    it("does not wait on inputs a page swallows: a cancelled pointerdown sends no mouse events", async (): Promise<void> => {
        await client.open({ url: `${url}pointer.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100 });
        const started: number = Date.now();
        await client.step({ pointer: true, advanceMs: 16 });
        await client.step({ pointer: false, advanceMs: 16 });
        await client.step({ click: true, advanceMs: 16 });
        await client.step({ press: ["a"], advanceMs: 16 });
        // A step waits up to 5 s for an input it counts on: none of these did.
        expect(Date.now() - started).toBeLessThan(4_000);
        // Every input arrived, and the page got no mousedown: the mouse events a step used to count on never came.
        expect((await client.step({})).raw).toMatchObject({ pointerdown: 2, pointerup: 2, mousedown: 0, keydown: 1 });
    });

    it("counts the inputs of a page that loads itself again in its new document", async (): Promise<void> => {
        await client.open({ url: `${url}navigate.html`, adapters: [], read: "window.state()", score: "({ over: false, score: 0 })", bootMs: 100 });
        for (const key of ["a", "b", "c"]) {
            await client.step({ press: [key], advanceMs: 16 });
        }
        // "n" loads the page again (in real time: the frozen clock does not hold a navigation back).
        await client.step({ press: ["n"], observe: false });
        const deadline: number = Date.now() + 10_000;
        let again: boolean = false;
        while (!again && Date.now() < deadline) {
            const seen: StepResult | undefined = await client.step({}).catch((): undefined => undefined);
            again = (seen?.raw as { again?: boolean } | undefined)?.again === true;
        }
        expect(again).toBe(true);
        const started: number = Date.now();
        await client.step({ press: ["a"], advanceMs: 16 });
        await client.step({ press: ["b"], advanceMs: 16 });
        expect(Date.now() - started).toBeLessThan(4_000);
        // Its session storage emptied as the game loaded, and kept when it loads itself again, as in a player's tab.
        expect((await client.step({})).raw).toEqual({ again: true, keys: 2, loads: 2 });
    });

    it("records the sprites drawn, and crops them", async (): Promise<void> => {
        await open(1);
        const r: StepResult = await client.step({ advanceMs: 100 });
        const raw: Array<{ k: string; s?: string; x: number; y: number }> = r.raw as Array<{ k: string; s?: string; x: number; y: number }>;
        const player: { s?: string; x: number; y: number } | undefined = raw.find((d: { s?: string }): boolean => /:0,0,20,20$/.test(d.s ?? ""));
        expect(player).toMatchObject({ k: "img", x: 20, y: 120 });
        expect(raw.some((d: { k: string }): boolean => d.k === "text")).toBe(true);
        const crops: Record<string, string> = (await client.spriteCrops([player!.s!])).crops;
        expect(crops[player!.s!]).toMatch(/^data:image\/png;base64,/);
    });

    it("gives an image id only to a source drawn onto the picture: a game composing every frame offscreen on fresh canvases", async (): Promise<void> => {
        type Buffers = { drawn: number; ids: number; keys: string[] };
        await client.open({
            url: `${url}buffers.html`,
            adapters: [Adapter.CANVAS2D],
            read: "({ drawn: window.drawn, ids: window.__ibgamer.canvas2d.nextImg - 1, keys: window.__ibgamer.canvas2d.last.map(function (d) { return d.s; }) })",
            score: "({ over: false, score: 0 })",
            bootMs: 100,
        });
        const seen: Buffers = (await client.step({ advanceMs: 320 })).raw as Buffers;
        expect(seen.drawn).toBeGreaterThan(20);
        // One a frame, its buffer's: the stamps drawn only offscreen have none.
        expect(seen.ids).toBe(seen.drawn);
        expect(seen.keys).toEqual([`i${seen.drawn}:0,0,200,100`]);
    });

    it("adds the game's page style once the page has loaded, and none when there is none", async (): Promise<void> => {
        const colour = async (style?: string): Promise<unknown> => {
            await client.open({ url: `${url}keys.html`, adapters: [], read: "getComputedStyle(document.body).backgroundColor", score: "({ over: false, score: 0 })", bootMs: 100, ...(style ? { style } : {}) });
            return (await client.step({})).raw;
        };
        expect(await colour("body { background: rgb(1, 2, 3) }")).toBe("rgb(1, 2, 3)");
        expect(await colour()).toBe("rgba(0, 0, 0, 0)");
    });

    it("holds the keys a page expression names — one, a list, or none — and lets the others go", async (): Promise<void> => {
        // Expressions may end in a comment.
        await client.open({ url: `${url}keys.html`, adapters: [], read: "window.state() // what went down", score: "({ over: false, score: 0 }) // none", bootMs: 100 });
        expect((await client.step({ holdFrom: "window.way // where the page says to go", advanceMs: 16 })).raw).toEqual({ downs: ["ArrowRight"], held: ["ArrowRight"] });
        expect((await client.step({ holdFrom: "['s', 'ArrowUp']", advanceMs: 16 })).raw).toEqual({ downs: ["ArrowRight", "s", "ArrowUp"], held: ["ArrowUp", "s"] });
        // Beside `hold`, both are held; an expression naming nothing holds only what `hold` lists.
        expect((await client.step({ hold: ["a"], holdFrom: "null", advanceMs: 16 })).raw).toEqual({ downs: ["ArrowRight", "s", "ArrowUp", "a"], held: ["a"] });
        // One that throws names nothing.
        expect((await client.step({ holdFrom: "(() => { throw new Error('no way on'); })()", advanceMs: 16 })).raw).toEqual({ downs: ["ArrowRight", "s", "ArrowUp", "a"], held: [] });
    });

    it("reports a read or score that does not compile as that part's error, and reads the rest", async (): Promise<void> => {
        // Statements, not an expression: the page would refuse the whole reading, and the step with it.
        await client.open({ url: `${url}keys.html`, adapters: [], read: "window.state()", score: "const s = 1; ({ over: false, score: s })", bootMs: 100 });
        const scored: StepResult = await client.step({ advanceMs: 16 });
        expect(scored).toMatchObject({ raw: { downs: [], held: [] }, clockMs: expect.any(Number), scoreError: expect.stringMatching(/^SyntaxError: /) });
        expect(scored.score).toBeUndefined();
        // What this process's engine may not compile and the page's does (a regular expression's modifiers) is read.
        await client.open({ url: `${url}keys.html`, adapters: [], read: "let x = 1; x", score: "({ over: false, score: /(?i:k)eys/.test('Keys') ? 1 : 0 })", bootMs: 100 });
        const read: StepResult = await client.step({});
        expect(read).toMatchObject({ score: { over: false, score: 1 }, readError: expect.stringMatching(/^SyntaxError: /) });
        expect(read.raw).toBeUndefined();
    });

    it("holds a key across steps: a held Space jumps once and keeps the player up", async (): Promise<void> => {
        await open(1);
        const up: StepResult = await client.step({ hold: ["Space"], advanceMs: 150 });
        const player = (res: StepResult): { y: number } =>
            (res.raw as Array<{ s?: string; y: number }>).find((d: { s?: string }): boolean => /:0,0,20,20$/.test(d.s ?? ""))!;
        expect(player(up).y).toBeLessThan(120);
        const down: StepResult = await client.step({ hold: [], advanceMs: 1500 });
        expect(player(down).y).toBe(120);
    });

    it("holds the pointer across steps at a point of the game, and lets it go", async (): Promise<void> => {
        await open(1);
        const player = (res: StepResult): { y: number } =>
            (res.raw as Array<{ s?: string; y: number }>).find((d: { s?: string }): boolean => /:0,0,20,20$/.test(d.s ?? ""))!;
        const up: StepResult = await client.step({ pointer: { x: 0.25, y: 0.5 }, advanceMs: 150 });
        expect(player(up).y).toBeLessThan(120);
        expect(up.score?.downAt).toEqual([150, 75]);
        const still: StepResult = await client.step({ pointer: { x: 0.25, y: 0.5 }, advanceMs: 100 });
        expect(still.score?.ups).toBeUndefined();
        const down: StepResult = await client.step({ pointer: false, advanceMs: 1500 });
        expect(down.score?.ups).toBe(1);
        expect(player(down).y).toBe(120);
    });

    it("measures the click target in each document: a game gone on from its menu page is clicked on its play page's target", async (): Promise<void> => {
        type Menu = { page: string; hits: number; misses: number } | undefined;
        await client.open({
            url: `${url}menu.html`,
            adapters: [],
            read: "window.state()",
            score: "({ over: false, score: 0 })",
            bootMs: 100,
            viewport: { width: 800, height: 400 },
            clickTarget: "#c",
        });
        await client.step({ click: true, advanceMs: 16 });
        // The menu sends the tab on to the play page (in real time: the frozen clock does not hold a navigation back).
        expect(await readUntil<Menu>((m: Menu): boolean => m?.page === "play")).toMatchObject({ page: "play" });
        for (let i: number = 0; i < 3; i++) {
            await client.step({ click: true, advanceMs: 16 });
        }
        expect((await client.step({})).raw).toEqual({ page: "play", hits: 3, misses: 0 });
    });

    it("reproduces a course from a seed, and a new page load resets it", async (): Promise<void> => {
        const course = async (seed: number): Promise<unknown> => {
            await open(seed);
            return (await client.step({ advanceMs: 6000 })).score?.gaps;
        };
        const first: unknown = await course(42);
        expect(await course(42)).toEqual(first);
        expect(await course(43)).not.toEqual(first);
    });

    it("seeds crypto's random values as it seeds Math.random: the same draws in every session of a seed, as the browser's calls make them, the document ids their own", async (): Promise<void> => {
        type Drawn = { math: number[]; same: boolean; ints: number[]; odd: number[]; uuid: string; floats: string; tooMany: string; doc: string };
        const drawnIn = async (seed?: number): Promise<Drawn> => {
            const fresh: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
            try {
                await fresh.open({ url: `${url}rng.html`, adapters: [], read: "window.drawn", score: "({ over: false, score: 0 })", bootMs: 50, ...(seed !== undefined ? { seed } : {}) });
                return (await fresh.step({})).raw as Drawn;
            } finally {
                await fresh.close();
            }
        };
        const draws = (d: Drawn): Pick<Drawn, "math" | "ints" | "odd" | "uuid"> => ({ math: d.math, ints: d.ints, odd: d.odd, uuid: d.uuid });
        const [seven, again, eight, loose, looser]: Drawn[] = await Promise.all([drawnIn(7), drawnIn(7), drawnIn(8), drawnIn(), drawnIn()]);
        expect(draws(again)).toEqual(draws(seven));
        // Math.random draws as it always has for seed 7.
        expect(seven.math[0]).toBe(0.6779302430804819);
        expect(eight.ints).not.toEqual(seven.ints);
        expect(eight.uuid).not.toBe(seven.uuid);
        // Unseeded, crypto is the browser's.
        expect(looser.ints).not.toEqual(loose.ints);
        // The browser's checks and errors, the array handed back, a version 4 UUID.
        expect(seven).toMatchObject({ same: true, floats: "TypeMismatchError", tooMany: "QuotaExceededError" });
        expect(seven.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        // The input counter's document id is not the seed's: each document has its own.
        expect(seven.doc).toMatch(/^\d+-\d+$/);
        expect(again.doc).not.toBe(seven.doc);
    });

    it("replays a seed frame for frame, however long the page took to load", async (): Promise<void> => {
        const frames = async (): Promise<unknown[]> => {
            await open(42);
            const out: unknown[] = [];
            for (let i = 0; i < 20; i++) {
                // 17 ms steps against 16 ms frames: which step gets two frames depends on where the boot left the clock.
                out.push((await client.step({ hold: i % 7 === 0 ? ["Space"] : [], advanceMs: 17 })).raw);
            }
            return out;
        };
        const first: unknown[] = await frames();
        expect(await frames()).toEqual(first);
    });

    it("plays the whole loop: the engine's choices, held keys, the game's own score", async (): Promise<void> => {
        const game: GameDefinition = {
            id: "fixture-runner",
            name: "Fixture Runner",
            url,
            goal: "Press Space to jump over the obstacles.",
            perception: { adapter: Perception.CANVAS2D },
            viewport: { width: 700, height: 300 },
            bootMs: 500,
            score: { expression: SCORE, label: "tenths" },
            budgets: { gameSeconds: 4, episodes: 1 },
        };
        const profile = fakeProfile({
            extractor: `function extract(raw) {
                var p = raw.filter(function (d) { return /:0,0,20,20$/.test(d.s || ""); })[0];
                var obs = raw.filter(function (d) { return /:20,0,20,20$/.test(d.s || ""); }).sort(function (a, b) { return a.x - b.x; })[0];
                return { dx: obs ? obs.x - 40 : null, air: p ? p.y < 120 : false };
            }`,
            tickMs: 30,
        });
        const engine: FakeEngine = new FakeEngine((s: any): string => (!s.air && s.dx !== null && s.dx < 30 && s.dx > -10 ? "JUMP" : "NOOP"));
        const result: PlayResult = await new Player(client, engine).play({ game, profile, episodes: 1, gameSeconds: 4, seeds: [7], pace: Pace.TURN });
        expect(result.episodes[0]).toMatchObject({ over: false, gameSeconds: 4, extractErrors: 0 });
        expect(result.episodes[0].actionCounts.JUMP).toBeGreaterThan(0);
        expect(result.episodes[0].score).toBeGreaterThanOrEqual(39);
    });

    it("probes a page: its canvases, drawing calls, the adapter that fits and what its own code added", async (): Promise<void> => {
        await client.open({ url, adapters: [Adapter.PROBE], freezeClock: false, bootMs: 500 });
        const probe = await client.probe();
        // Each canvas with a selector the game's clicks can be aimed at, and the body a click falls back on.
        expect(probe.canvases).toEqual([{ width: 600, height: 150, context: "2d", box: { x: 0, y: 0, width: 600, height: 150 }, selector: "#game" }]);
        expect(probe.body).toEqual({ x: 0, y: 0, width: expect.any(Number), height: expect.any(Number) });
        expect(probe.calls.drawImage).toBeGreaterThan(0);
        expect(probe.suggested).toBe(Adapter.CANVAS2D);
        // What the add-a-game wizard shows and the page reader starts from: the page's globals, not the browser's.
        expect(probe.viewport).toEqual({ width: expect.any(Number), height: expect.any(Number) });
        expect(probe.globals).toEqual(expect.arrayContaining(["game: object"]));
        expect(probe.globals).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(document|fetch):/)]));
        expect(probe.inlineScripts?.[0]).toContain("window.game");
    });

    it("reads a 2D game by its pixels: the largest canvas as a colour grid of the size asked", async (): Promise<void> => {
        await client.open({ url, adapters: [Adapter.PIXELS], read: adapterReadExpression(Adapter.PIXELS, { grid: { width: 32 } }), bootMs: 500, viewport: { width: 700, height: 300 } });
        const step: StepResult = await client.step({ advanceMs: 200 });
        const raw: { w: number; h: number; box: { width: number; height: number }; px: string } = step.raw as { w: number; h: number; box: { width: number; height: number }; px: string };
        // 600 x 150 canvas, 32 cells across: 8 rows.
        expect(raw).toMatchObject({ w: 32, h: 8, box: { width: 600, height: 150 } });
        expect(raw.px).toMatch(/^[0-9a-f]+$/);
        expect(raw.px).toHaveLength(32 * 8 * 3);
        const colours: Set<string> = new Set(raw.px.match(/.{3}/g) ?? []);
        expect(colours.size).toBeGreaterThan(1);
    });

    it("reads a WebGL canvas by its pixels with the clock frozen: its drawing buffer is kept after the frame", async (): Promise<void> => {
        await client.open({
            url: `${url}webgl.html`,
            adapters: [Adapter.PIXELS],
            read: `({ grid: ${adapterReadExpression(Adapter.PIXELS, { grid: { width: 16, height: 8 } })}, gl: window.glInfo })`,
            bootMs: 500,
            viewport: { width: 700, height: 300 },
        });
        await client.step({ advanceMs: 100 });
        // Real time passes with the clock frozen: the last frame was presented long ago.
        await new Promise((r: (v: unknown) => void): unknown => setTimeout(r, 300));
        const step: StepResult = await client.step({});
        const raw: { grid: { w: number; h: number; px: string }; gl: { ok: boolean; preserve: boolean } } = step.raw as {
            grid: { w: number; h: number; px: string };
            gl: { ok: boolean; preserve: boolean };
        };
        expect(raw.gl).toEqual({ ok: true, preserve: true });
        expect(raw.grid).toMatchObject({ w: 16, h: 8 });
        // Cleared to magenta every frame: every cell reads "f0f".
        expect(new Set(raw.grid.px.match(/.{3}/g) ?? [])).toEqual(new Set(["f0f"]));
    });
});
