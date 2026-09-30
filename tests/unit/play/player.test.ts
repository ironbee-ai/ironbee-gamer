import { OpenRequest, OpenResult, StepRequest, StepResult } from "../../../src/devtools/protocol";
import { RulesTeacher } from "../../../src/distill/teacher";
import { DecisionEngine, EngineHealth, Question } from "../../../src/engine";
import { SystemOneResponse } from "../../../src/engine/systemone";
import { DecideOn, GameDefinition, InputStep, Profile } from "../../../src/game/types";
import { DecisionRecord, EpisodeResult, isExtractorErrorState, Pace, Player, PlayOptions, PlayResult, TickEvent, WindowFrameInfo } from "../../../src/play/player";
import { FakeEngine, jumpWhenClose, PlanFakeEngine, ScriptedPlanEngine } from "../../helpers/fake-engine";
import { fakeGameDefinition, FakeGame, fakeProfile, RealtimeFakeGame, RoundsFakeGame, RUNNER_EXTRACTOR } from "../../helpers/fake-game";

async function play(
    options: { game?: GameDefinition; profile?: Profile; engine?: FakeEngine; browser?: FakeGame; seconds?: number; episodes?: number } = {}
): Promise<{ result: PlayResult; browser: FakeGame; engine: FakeEngine; ticks: TickEvent[] }> {
    const browser: FakeGame = options.browser ?? new FakeGame();
    const engine: FakeEngine = options.engine ?? new FakeEngine(jumpWhenClose);
    const ticks: TickEvent[] = [];
    const result: PlayResult = await new Player(browser, engine).play({
        game: options.game ?? fakeGameDefinition(),
        profile: options.profile ?? fakeProfile(),
        episodes: options.episodes ?? 1,
        gameSeconds: options.seconds ?? 5,
        pace: Pace.TURN,
        hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
    });
    return { result, browser, engine, ticks };
}

/**
 * The fake game in rounds with its clock running: after every `roundMs` of game time it waits for a click.
 * The round shows on the page, and the game never ends (only its rounds matter).
 */
class RealtimeRoundsFakeGame extends FakeGame {
    round: number = 1;
    private waiting: boolean = false;
    private wall: number = Date.now();

    constructor(private readonly roundMs: number) {
        super();
    }

    override async open(request: OpenRequest): Promise<OpenResult> {
        this.round = 1;
        this.waiting = false;
        this.wall = Date.now();
        return super.open(request);
    }

    override raw(): unknown {
        return [...(super.raw() as unknown[]), { k: "text", t: `round ${this.round}`, x: 0, y: 0, w: 0, h: 0 }];
    }

    override async step(request: StepRequest): Promise<StepResult> {
        if (request.waitMs) {
            await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, request.waitMs));
        }
        const now: number = Date.now();
        const elapsed: number = now - this.wall;
        this.wall = now;
        if (this.waiting) {
            // Waiting: the clock runs, nothing moves, and only a click takes the game on.
            this.steps.push(request);
            this.t += elapsed;
            if (request.click) {
                this.round++;
                this.waiting = false;
            }
            return request.observe === false ? {} : { raw: this.raw(), score: { over: false, score: 0, waiting: this.waiting }, clockMs: this.t };
        }
        const result: StepResult = await super.step({ ...request, advanceMs: elapsed + (request.advanceMs ?? 0) });
        this.over = false;
        this.waiting = this.t >= this.round * this.roundMs;
        return result.score ? { ...result, score: { ...result.score, over: false, waiting: this.waiting } } : result;
    }
}

describe("Player in real time", (): void => {
    const gaps = (ticks: TickEvent[]): number[] => ticks.filter((t: TickEvent): boolean => t.asked).map((t: TickEvent, i: number, a: TickEvent[]): number => (i ? t.gameMs - a[i - 1].gameMs : 0)).slice(1);

    it("opens the game with its clock running, and the game does not wait for a slow decision", async (): Promise<void> => {
        const browser: RealtimeFakeGame = new RealtimeFakeGame();
        const slow: FakeEngine = new FakeEngine(jumpWhenClose);
        const ask: FakeEngine["ask"] = slow.ask.bind(slow);
        slow.ask = async (...a: Parameters<FakeEngine["ask"]>): ReturnType<FakeEngine["ask"]> => {
            await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, 60));
            return ask(...a);
        };
        const ticks: TickEvent[] = [];
        await new Player(browser, slow).play({
            game: fakeGameDefinition(),
            profile: fakeProfile(),
            episodes: 1,
            gameSeconds: 1,
            pace: Pace.REALTIME,
            hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
        });
        expect(browser.opened[0]).toMatchObject({ freezeClock: false });
        // Each 60 ms decision is 60 ms of game gone by: far more than a tick.
        expect(Math.min(...gaps(ticks))).toBeGreaterThanOrEqual(55);
    });

    it("with a fast engine, decides once a tick of real time, no faster", async (): Promise<void> => {
        const browser: RealtimeFakeGame = new RealtimeFakeGame();
        const profile: Profile = fakeProfile({ tickMs: 40 });
        const ticks: TickEvent[] = [];
        const started: number = Date.now();
        await new Player(browser, new FakeEngine(jumpWhenClose)).play({
            game: fakeGameDefinition(),
            profile,
            episodes: 1,
            gameSeconds: 1,
            pace: Pace.REALTIME,
            hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(950);
        expect(Math.min(...gaps(ticks))).toBeGreaterThanOrEqual(35);
    });

    it("in real time, sleeps itself what a start step waits beyond one game_step's limit", async (): Promise<void> => {
        /** Records the waits asked of the page and waits none of them. */
        class Waits extends RealtimeFakeGame {
            readonly waits: number[] = [];

            override async step(request: StepRequest): Promise<StepResult> {
                if (request.waitMs) {
                    this.waits.push(request.waitMs);
                }
                return super.step({ ...request, waitMs: 0 });
            }
        }
        const browser: Waits = new Waits();
        const started: number = Date.now();
        await new Player(browser, new FakeEngine(jumpWhenClose)).play({
            game: fakeGameDefinition({ start: [{ advanceMs: 30_080 }] }),
            profile: fakeProfile(),
            episodes: 1,
            gameSeconds: 0.2,
            pace: Pace.REALTIME,
        });
        expect(browser.waits[0]).toBe(30_000);
        expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    });

    it("tells the extractor how late a decision acts: nothing while the game waits, the engine's recent time in real time", async (): Promise<void> => {
        // The runner's own extractor, and the lag it was told as a state field.
        const base: Profile = fakeProfile();
        const profile: Profile = { ...base, extractor: `function (raw, memory, info) { var s = (${base.extractor})(raw, memory); s.lag = info.lagMs; return s; }` };
        const lags = (ticks: TickEvent[]): number[] => ticks.filter((t: TickEvent): boolean => t.asked).map((t: TickEvent): number => (t.state as { lag: number }).lag);

        const frozen: TickEvent[] = (await play({ profile, seconds: 1 })).ticks;
        expect(new Set(lags(frozen))).toEqual(new Set([0]));

        const slow: FakeEngine = new FakeEngine(jumpWhenClose);
        const ask: FakeEngine["ask"] = slow.ask.bind(slow);
        slow.ask = async (...a: Parameters<FakeEngine["ask"]>): ReturnType<FakeEngine["ask"]> => {
            await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, 40));
            return ask(...a);
        };
        const ticks: TickEvent[] = [];
        const result: PlayResult = await new Player(new RealtimeFakeGame(), slow).play({
            game: fakeGameDefinition(),
            profile,
            episodes: 1,
            gameSeconds: 1,
            pace: Pace.REALTIME,
            expectedLagMs: 25,
            hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
        });
        const told: number[] = lags(ticks);
        // Before any decision was timed, the expected lag; then the engine's recent 40 ms, and the step that lands the input.
        expect(told[0]).toBe(30);
        expect(Math.min(...told.slice(3))).toBeGreaterThanOrEqual(45);
        expect(result.episodes[0].lagMs).toBeGreaterThanOrEqual(45);
    });

    it("marks each decision row with the lag it was made with: none paused, a simulated lag's range, in real time the lag its state was made for", async (): Promise<void> => {
        const base: Profile = fakeProfile();
        const profile: Profile = { ...base, extractor: `function (raw, memory, info) { var s = (${base.extractor})(raw, memory); s.lag = info.lagMs; return s; }` };
        const rowsOf = async (browser: FakeGame, pace: Pace, more: Partial<PlayOptions> = {}): Promise<DecisionRecord[]> => {
            const rows: DecisionRecord[] = [];
            await new Player(browser, new FakeEngine(jumpWhenClose)).play({
                game: fakeGameDefinition(),
                profile,
                episodes: 1,
                gameSeconds: 1,
                seeds: [3],
                pace,
                ...more,
                hooks: { onDecision: (d: DecisionRecord): number => rows.push(d) },
            });
            return rows;
        };
        const lagOf = (rows: DecisionRecord[]): string[] => [...new Set(rows.map((r: DecisionRecord): string => JSON.stringify(r.lag ?? null)))];
        const paused: DecisionRecord[] = await rowsOf(new FakeGame(), Pace.TURN);
        expect(paused.length).toBeGreaterThan(10);
        expect(paused.every((r: DecisionRecord): boolean => r.seed === 3)).toBe(true);
        expect(lagOf(paused)).toEqual(["null"]);
        // An engine's decision log is distillation data, counted by lag: rows made with one once passed for paused ones.
        expect(lagOf(await rowsOf(new FakeGame(), Pace.TURN, { simulatedLag: { minMs: 45, maxMs: 60 } }))).toEqual([JSON.stringify({ minMs: 45, maxMs: 60 })]);
        const live: DecisionRecord[] = await rowsOf(new RealtimeFakeGame(), Pace.REALTIME);
        expect(live.length).toBeGreaterThan(5);
        expect(live.every((r: DecisionRecord): boolean => r.lag !== undefined && r.lag.minMs > 0 && r.lag.minMs === (r.state as { lag: number }).lag && r.lag.maxMs === r.lag.minMs)).toBe(true);
    });

    it("for a lag-aware profile, lands every input the same time after its frame, however long each decision took", async (): Promise<void> => {
        // When each frame was read and when each input was sent.
        class Timed extends RealtimeFakeGame {
            readAt: number = 0;
            gaps: number[] = [];
            override async step(request: StepRequest): Promise<StepResult> {
                if (request.observe === false) {
                    this.gaps.push(Date.now() - this.readAt);
                }
                const result: StepResult = await super.step(request);
                if (request.observe !== false) {
                    this.readAt = Date.now();
                }
                return result;
            }
        }
        const run = async (profile: Profile): Promise<number[]> => {
            const browser: Timed = new Timed();
            const jittery: FakeEngine = new FakeEngine(jumpWhenClose);
            const ask: FakeEngine["ask"] = jittery.ask.bind(jittery);
            let n: number = 0;
            jittery.ask = async (...a: Parameters<FakeEngine["ask"]>): ReturnType<FakeEngine["ask"]> => {
                await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, n++ % 2 ? 40 : 5));
                return ask(...a);
            };
            await new Player(browser, jittery).play({ game: fakeGameDefinition(), profile, episodes: 1, gameSeconds: 1.5, pace: Pace.REALTIME, expectedLagMs: 40 });
            return browser.gaps.slice(4);
        };
        // A 5 ms answer waits for the slow end of the recent ones: both land ~40 ms after their frame.
        const held: number[] = await run({ ...fakeProfile(), lagAware: true });
        expect(Math.min(...held)).toBeGreaterThanOrEqual(35);
        expect(Math.max(...held) - Math.min(...held)).toBeLessThan(20);
        // A profile that does not make up for the lag plays each input as soon as it is decided.
        const asap: number[] = await run(fakeProfile());
        expect(Math.min(...asap)).toBeLessThan(20);
    });

    it("for a lag-aware profile with a lag floor, lands inputs no sooner than it, and tells the extractor so", async (): Promise<void> => {
        class Timed extends RealtimeFakeGame {
            readAt: number = 0;
            gaps: number[] = [];
            override async step(request: StepRequest): Promise<StepResult> {
                if (request.observe === false) {
                    this.gaps.push(Date.now() - this.readAt);
                }
                const result: StepResult = await super.step(request);
                if (request.observe !== false) {
                    this.readAt = Date.now();
                }
                return result;
            }
        }
        // The runner's own extractor, and the lag it was told as a state field.
        const base: Profile = fakeProfile();
        const telling: Profile = { ...base, extractor: `function (raw, memory, info) { var s = (${base.extractor})(raw, memory); s.lag = info.lagMs; return s; }` };
        const lags = (ticks: TickEvent[]): number[] => ticks.filter((t: TickEvent): boolean => t.asked).map((t: TickEvent): number => (t.state as { lag: number }).lag);
        const run = async (profile: Profile): Promise<{ gaps: number[]; told: number[] }> => {
            const browser: Timed = new Timed();
            const ticks: TickEvent[] = [];
            // A fast engine: a few ms a decision.
            await new Player(browser, new FakeEngine(jumpWhenClose)).play({
                game: fakeGameDefinition(),
                profile,
                episodes: 1,
                gameSeconds: 1.5,
                pace: Pace.REALTIME,
                minLagMs: 60,
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            return { gaps: browser.gaps.slice(2), told: lags(ticks) };
        };
        const floored: { gaps: number[]; told: number[] } = await run({ ...telling, lagAware: true });
        expect(Math.min(...floored.gaps)).toBeGreaterThanOrEqual(50);
        expect(Math.min(...floored.told)).toBeGreaterThanOrEqual(60);
        // A profile that does not make up for the lag is not held: the floor is not its lag.
        const asap: { gaps: number[]; told: number[] } = await run(telling);
        expect(Math.min(...asap.gaps)).toBeLessThan(20);
        expect(Math.max(...asap.told)).toBeLessThan(60);
    });

    describe("in plan mode", (): void => {
        /** The runner's features now and, when a plan is asked for, at each of its moments (the obstacle runs 0.3 px/ms, a jump lasts 400 ms). */
        const PLAN_EXTRACTOR: string = `function extract(raw, memory, info) {
            var obstacle = raw.filter(function (d) { return d.s === "i1:0,0,20,20"; })[0];
            var player = raw.filter(function (d) { return d.s === "i1:40,0,20,20"; })[0];
            var dx = obstacle ? obstacle.x : null, air = player ? player.y < 100 : false;
            var state = { dx: dx, air: air, info: info };
            if (!info.slots) return state;
            var jumps = (info.pending || []).filter(function (p) { return p.action === "JUMP"; });
            state.jumpIn = jumps.map(function (p) { return p.inMs; });
            state.slots = info.slots.map(function (ms) {
                var x = dx === null ? null : dx - 0.3 * ms;
                while (x !== null && x < -20) x += 320;
                var up = (air && ms < 200) || jumps.some(function (p) { return ms >= p.inMs && ms < p.inMs + 400; });
                return { dx: x === null ? null : Math.round(x), air: up };
            });
            return state;
        }`;
        const planProfile = (overrides: Partial<Profile> = {}): Profile => fakeProfile({ extractor: PLAN_EXTRACTOR, plan: { slots: 8, slotMs: 50 }, ...overrides });

        /**
         * Plays on jest's fake clock: the game's time, the engine's answers and the player's waits all run on it, each
         * when its timer falls — the same every run, whatever else the machine is doing.
         */
        const onFakeClock = async (play: () => Promise<PlayResult>): Promise<PlayResult> => {
            jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
            try {
                const played: Promise<PlayResult> = play();
                let done: boolean = false;
                played.then(
                    (): void => {
                        done = true;
                    },
                    (): void => {
                        done = true;
                    }
                );
                while (!done) {
                    await jest.advanceTimersByTimeAsync(10);
                }
                return await played;
            } finally {
                jest.useRealTimers();
            }
        };

        it("keeps one request in flight, asks for every moment at once, and a slow engine still clears the obstacles", async (): Promise<void> => {
            const engine: PlanFakeEngine = new PlanFakeEngine(jumpWhenClose, 150);
            const ticks: TickEvent[] = [];
            const result: PlayResult = await new Player(new RealtimeFakeGame(), engine).play({
                game: fakeGameDefinition(),
                profile: planProfile(),
                episodes: 1,
                gameSeconds: 3,
                pace: Pace.REALTIME,
                expectedLagMs: 150,
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            const e: EpisodeResult = result.episodes[0];
            expect(e.over).toBe(false);
            expect(e.actionCounts.JUMP).toBeGreaterThanOrEqual(2);
            expect(engine.maxInFlight).toBe(1);
            expect(Object.keys(engine.asked[0].questions)).toEqual(["slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7", "slot8"]);
            expect((engine.asked[0].questions.slot3.instructions as { instructions: string }).instructions).toMatch(/PLAN: .*This question: slot 3\.$/);
            // What the extractor was told: the plan's moments from the expected lag on, 50 ms apart, and the game time.
            const info = (ticks.find((t: TickEvent): boolean => t.asked)?.state as { info: { slots: number[]; nowMs: number } }).info;
            expect(info.slots).toEqual([155, 205, 255, 305, 355, 405, 455, 505]);
            expect(typeof info.nowMs).toBe("number");
            expect(ticks.some((t: TickEvent): boolean => Array.isArray(t.plan) && t.plan.length === 8)).toBe(true);
        });

        it("tells the extractor the jump a plan scheduled, until it has taken effect", async (): Promise<void> => {
            const engine: PlanFakeEngine = new PlanFakeEngine(jumpWhenClose, 120);
            const ticks: TickEvent[] = [];
            await new Player(new RealtimeFakeGame(), engine).play({
                game: fakeGameDefinition(),
                profile: planProfile(),
                episodes: 1,
                gameSeconds: 2,
                pace: Pace.REALTIME,
                expectedLagMs: 120,
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            // (The state names no action — the guard would drop it — so the extractor reports when the jump lands.)
            const jumpIn: number[] = engine.asked.flatMap((a: { state: any }): number[] => a.state.game.jumpIn ?? []);
            expect(jumpIn.length).toBeGreaterThan(0);
            expect(Math.min(...jumpIn)).toBeGreaterThanOrEqual(0);
            // A pending jump shows in the moments it covers.
            const told = engine.asked.find((a: { state: any }): boolean => (a.state.game.jumpIn ?? []).length > 0) as { state: any };
            expect(told.state.game.slots.some((s: { air: boolean }): boolean => s.air)).toBe(true);
        });

        it("tells a request of every input scheduled and not played yet, one that fell due while the page was read too", async (): Promise<void> => {
            /** Reading the page takes 30 ms (a browser round trip); when each of a plan's inputs reached the game. The runner never lands. */
            class SlowRead extends RealtimeFakeGame {
                inputsAt: number[] = [];
                override async open(request: OpenRequest): Promise<OpenResult> {
                    const opened: OpenResult = await super.open(request);
                    this.airUntil = Infinity;
                    return opened;
                }
                override async step(request: StepRequest): Promise<StepResult> {
                    // A plan's input names no game time to run (the keys let go at the end name none at all).
                    if (request.hold && request.advanceMs === 0) {
                        this.inputsAt.push(Date.now());
                    }
                    const result: StepResult = await super.step(request);
                    if (request.observe !== false) {
                        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, 30));
                    }
                    return result;
                }
            }
            // Every plan jumps at its first moment, due about when its answer comes: while the next request reads the page.
            const extractor: string = `function (raw, memory, info) {
                var s = { pendingIn: (info.pending || []).map(function (p) { return p.inMs; }) };
                if (info.slots) { s.slots = info.slots.map(function (ms, k) { return { first: k === 0 }; }); }
                return s;
            }`;
            const engine: PlanFakeEngine = new PlanFakeEngine((s: any): string => (s.first ? "JUMP" : "NOOP"), 60);
            const asks: Array<{ at: number; pendingIn: number[] }> = [];
            const ask: PlanFakeEngine["ask"] = engine.ask.bind(engine);
            engine.ask = async (...a: Parameters<PlanFakeEngine["ask"]>): ReturnType<PlanFakeEngine["ask"]> => {
                asks.push({ at: Date.now(), pendingIn: (a[0] as { game: { pendingIn: number[] } }).game.pendingIn });
                return ask(...a);
            };
            const browser: SlowRead = new SlowRead();
            await new Player(browser, engine).play({
                game: fakeGameDefinition(),
                profile: planProfile({ extractor }),
                episodes: 1,
                gameSeconds: 1.5,
                pace: Pace.REALTIME,
                expectedLagMs: 60,
            });
            expect(asks.length).toBeGreaterThan(5);
            // What was played before a request's answer came (60 ms) was scheduled before it: every input of it told as pending.
            const untold = asks.filter((a: { at: number; pendingIn: number[] }): boolean => browser.inputsAt.filter((at: number): boolean => at >= a.at && at < a.at + 50).length > a.pendingIn.length);
            expect(untold).toEqual([]);
            // The first moment of the plan before, gone by while the page was read: due at once.
            expect(asks.filter((a: { pendingIn: number[] }): boolean => a.pendingIn[0] === 0).length).toBeGreaterThan(3);
        });

        it("with a request every so often, keeps several in flight and still clears the obstacles", async (): Promise<void> => {
            // On the fake clock each answer comes 200 ms after its request: in the order they were sent, every run alike.
            const engine: PlanFakeEngine = new PlanFakeEngine(jumpWhenClose, 200);
            const result: PlayResult = await onFakeClock(
                (): Promise<PlayResult> =>
                    new Player(new RealtimeFakeGame(), engine).play({
                        game: fakeGameDefinition(),
                        profile: planProfile(),
                        episodes: 1,
                        gameSeconds: 2.5,
                        pace: Pace.REALTIME,
                        expectedLagMs: 200,
                        planEveryMs: 60,
                    })
            );
            expect(engine.maxInFlight).toBeGreaterThanOrEqual(3);
            expect(result.episodes[0].over).toBe(false);
            expect(result.episodes[0].actionCounts.JUMP).toBeGreaterThanOrEqual(2);
            expect(result.episodes[0].decisions).toBeGreaterThan(20);
        });

        it("with several in flight, never drops a jump a plan was told is coming: that plan is dropped instead once older ones moved it", async (): Promise<void> => {
            /** When Space went down, in game time. */
            class Presses extends RealtimeFakeGame {
                pressedAt: number[] = [];

                override async step(request: StepRequest): Promise<StepResult> {
                    const down: boolean = this.held.has("Space");
                    const result: StepResult = await super.step(request);
                    if (!down && this.held.has("Space")) {
                        this.pressedAt.push(this.t);
                    }
                    return result;
                }
            }
            // A request every 60 ms, each answered 150 ms later: a plan's first moment is 155 ms after its frame. Requests
            // 7, 8 and 9 each jump at their third moment, none told of another's jump (it was merged after their frame);
            // request 10 is told of request 7's jump, 75 ms ahead, and plans nothing. Merged as they came, 8 and 9 moved the
            // jump past 10's first moment, 10's merge dropped it, and the obstacle hit at 1000 ms with no jump played.
            const engine: ScriptedPlanEngine = new ScriptedPlanEngine((k: number): string[] => (k >= 7 && k <= 9 ? ["NOOP", "NOOP", "JUMP"] : []), 150);
            const browser: Presses = new Presses();
            const result: PlayResult = await onFakeClock(
                (): Promise<PlayResult> =>
                    new Player(browser, engine).play({
                        game: fakeGameDefinition(),
                        profile: planProfile(),
                        episodes: 1,
                        gameSeconds: 1.5,
                        pace: Pace.REALTIME,
                        expectedLagMs: 150,
                        planEveryMs: 60,
                    })
            );
            expect(engine.asked[10].state.game.jumpIn).toEqual([75]);
            // Request 8's jump stands (9 and 10 were told of the jumps 8 moved): played once, in time.
            expect(browser.pressedAt).toEqual([735]);
            expect(result.episodes[0].over).toBe(false);
        });

        it("asks one question when the extractor predicts no moments, and plays it as a one-moment plan", async (): Promise<void> => {
            const engine: PlanFakeEngine = new PlanFakeEngine(jumpWhenClose, 30);
            const result: PlayResult = await new Player(new RealtimeFakeGame(), engine).play({
                game: fakeGameDefinition(),
                profile: fakeProfile({ plan: { slots: 8, slotMs: 50 } }),
                episodes: 1,
                gameSeconds: 1,
                pace: Pace.REALTIME,
                expectedLagMs: 30,
            });
            expect(engine.asked.length).toBeGreaterThan(3);
            expect(engine.asked.every((a: { questions: Record<string, unknown> }): boolean => Object.keys(a.questions).join() === "action")).toBe(true);
            expect(result.episodes[0].decisions).toBe(engine.asked.length);
        });

        it("plays a plan profile tick by tick while the game waits for decisions", async (): Promise<void> => {
            const { result, engine } = await play({ profile: planProfile(), seconds: 2 });
            expect(engine.asked.every((a: { questions: Record<string, unknown> }): boolean => Object.keys(a.questions).join() === "action")).toBe(true);
            expect(result.episodes[0].over).toBe(false);
        });

        it("records a plan's tick with the frame it was asked about: its state and its game time", async (): Promise<void> => {
            const engine: PlanFakeEngine = new PlanFakeEngine(jumpWhenClose, 150);
            const ticks: TickEvent[] = [];
            await new Player(new RealtimeFakeGame(), engine).play({
                game: fakeGameDefinition(),
                profile: planProfile(),
                episodes: 1,
                gameSeconds: 1.5,
                pace: Pace.REALTIME,
                expectedLagMs: 150,
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            const asked: Set<unknown> = new Set(engine.asked.map((a: { state: any }): unknown => a.state.game));
            const plans: TickEvent[] = ticks.filter((t: TickEvent): boolean => t.plan !== undefined);
            expect(plans.length).toBeGreaterThan(3);
            for (const tick of plans) {
                expect(asked.has(tick.state)).toBe(true);
                expect(tick.gameMs).toBe((tick.state as { info: { nowMs: number } }).info.nowMs);
            }
        });

        it("keeps playing when the rules as code fail on a frame: the schedule stands", async (): Promise<void> => {
            // Rules that fail on every third state they are shown.
            const teacher: string = `(function () { var n = 0; return function teach(state) {
                if (++n % 3 === 0) { throw new Error("the rules failed"); }
                return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? "JUMP" : "NOOP";
            }; })()`;
            const profile: Profile = planProfile({ teacher });
            const result: PlayResult = await new Player(new RealtimeFakeGame(), new RulesTeacher(profile)).play({
                game: fakeGameDefinition(),
                profile,
                episodes: 1,
                gameSeconds: 1,
                pace: Pace.REALTIME,
            });
            expect(result.episodes[0].invalidAnswers).toBeGreaterThan(0);
            expect(result.episodes[0].firstInvalidAnswer).toBe("the rules failed");
            expect(result.episodes[0].decisions).toBeGreaterThan(result.episodes[0].invalidAnswers);
        });

        it("plans from no frame with no state: the schedule stands, counted as an extractor error", async (): Promise<void> => {
            // Every fifth frame read has no state, and rules that would fail on one.
            const extractor: string = `function (raw, memory, info) { memory.n = (memory.n || 0) + 1; if (memory.n % 5 === 0) { throw new Error("no player"); } return (${PLAN_EXTRACTOR})(raw, memory, info); }`;
            const teacher: string =
                "function teach(state) { if (state.extractorError) { throw new Error('no state to plan from'); } return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";
            const profile: Profile = planProfile({ extractor, teacher });
            const result: PlayResult = await new Player(new RealtimeFakeGame(), new RulesTeacher(profile)).play({ game: fakeGameDefinition(), profile, episodes: 1, gameSeconds: 1, pace: Pace.REALTIME });
            const e: EpisodeResult = result.episodes[0];
            expect(e.extractErrors).toBeGreaterThan(0);
            expect(e.firstExtractError).toBe("no player");
            expect(e.invalidAnswers).toBe(0);
            expect(e.decisions).toBeGreaterThan(0);
        });

        it("plans a new round afresh: no answer about a frame before the resume is played after it", async (): Promise<void> => {
            const browser: RealtimeRoundsFakeGame = new RealtimeRoundsFakeGame(500);
            // The runner's features, the plan's moments and the round the page shows.
            const extractor: string = `function (raw, memory, info) {
                var s = (${PLAN_EXTRACTOR})(raw, memory, info);
                var r = raw.filter(function (d) { return d.k === "text" && /^round /.test(d.t); })[0];
                s.round = r ? Number(r.t.slice(6)) : 0;
                return s;
            }`;
            const planned: Array<{ asked: number; now: number }> = [];
            await new Player(browser, new PlanFakeEngine(jumpWhenClose, 120)).play({
                game: fakeGameDefinition({ resume: [{ click: true, advanceMs: 0 }] }),
                profile: planProfile({ extractor }),
                episodes: 1,
                gameSeconds: 2,
                pace: Pace.REALTIME,
                expectedLagMs: 120,
                hooks: {
                    onTick: (t: TickEvent): void => {
                        if (t.plan) {
                            planned.push({ asked: (t.state as { round: number }).round, now: browser.round });
                        }
                    },
                },
            });
            expect(browser.round).toBeGreaterThanOrEqual(3);
            expect(planned.some((p: { now: number }): boolean => p.now > 1)).toBe(true);
            // Every plan played was asked about a frame of the round it is played in.
            expect(planned.filter((p: { asked: number; now: number }): boolean => p.asked !== p.now)).toEqual([]);
        });
    });

    it("simulates an engine's lag on the paused clock as real time plays it: each input lands that long after its frame, the next frame is read after it, the same every run", async (): Promise<void> => {
        // When each key change reached the game and each frame was read (its own time), and what the extractor was told.
        class Landing extends FakeGame {
            holds: Array<{ t: number; hold: string[] }> = [];
            frames: number[] = [];
            override async step(request: StepRequest): Promise<StepResult> {
                if (request.hold) {
                    this.holds.push({ t: this.t, hold: request.hold });
                }
                const result: StepResult = await super.step(request);
                if (request.observe !== false) {
                    this.frames.push(this.t);
                }
                return result;
            }
        }
        const base: Profile = fakeProfile();
        const profile: Profile = { ...base, extractor: `function (raw, memory, info) { var s = (${base.extractor})(raw, memory); s.lag = info.lagMs; return s; }` };
        const run = async (): Promise<{ browser: Landing; result: PlayResult; ticks: TickEvent[] }> => {
            const browser: Landing = new Landing();
            const ticks: TickEvent[] = [];
            const result: PlayResult = await new Player(browser, new FakeEngine(jumpWhenClose)).play({
                game: fakeGameDefinition(),
                profile,
                episodes: 1,
                gameSeconds: 2,
                seeds: [7],
                pace: Pace.TURN,
                simulatedLag: { minMs: 30, maxMs: 30 },
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            return { browser, result, ticks };
        };
        const a = await run();
        // Each input lands 30 ms after the frame it was decided on (the keys let go at the end aside), and the next
        // frame is read after it: 30 ms (more than the 20 ms tick) plus the step's own 2–6 ms, not a tick later
        // with the decision still on its way.
        const played: Array<{ t: number }> = a.browser.holds.slice(0, -1);
        expect(played.length).toBeGreaterThan(20);
        expect(played.every((h: { t: number }, i: number): boolean => h.t === a.browser.frames[i] + 30)).toBe(true);
        const gaps: number[] = a.browser.frames.slice(1).map((f: number, i: number): number => f - a.browser.frames[i]);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(32);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(36);
        expect(new Set(gaps).size).toBeGreaterThan(1);
        expect(new Set(a.ticks.map((t: TickEvent): number => (t.state as { lag: number }).lag))).toEqual(new Set([30]));
        expect(a.result.episodes[0].lagMs).toBe(30);
        const b = await run();
        expect(b.browser.holds).toEqual(a.browser.holds);
        expect(b.result.episodes[0].score).toBe(a.result.episodes[0].score);
    });

    it("a frozen game is opened frozen", async (): Promise<void> => {
        const { browser } = await play({ seconds: 1 });
        expect(browser.opened[0].freezeClock).toBeUndefined();
    });
});

describe("Player", (): void => {
    it("plays until the budget with the engine's right rule, and reads the score from the game", async (): Promise<void> => {
        const { result, engine } = await play({ seconds: 5 });
        const e: EpisodeResult = result.episodes[0];
        expect(e.over).toBe(false);
        expect(e.gameSeconds).toBe(5);
        expect(e.score).toBe(50);
        expect(e.actionCounts.JUMP).toBeGreaterThan(0);
        expect(engine.asked.length).toBe(e.decisions);
        // The question: the state under `game`, the actions as criteria, the goal and the rules.
        expect(engine.asked[0].state.game).toEqual({ dx: expect.any(Number), air: false, seenFrames: 1 });
        expect(engine.asked[0].questions.action.instructions).toEqual({
            goal: fakeGameDefinition().goal,
            instructions: fakeProfile().instructions,
        });
    });

    it("ends an episode at game over", async (): Promise<void> => {
        const { result } = await play({ engine: new FakeEngine((): string => "NOOP") });
        expect(result.episodes[0].over).toBe(true);
        expect(result.episodes[0].gameSeconds).toBeLessThan(2);
    });

    it("opens a fresh page per episode, with the game's seed", async (): Promise<void> => {
        const browser: FakeGame = new FakeGame();
        const player: Player = new Player(browser, new FakeEngine(jumpWhenClose));
        await player.play({ game: fakeGameDefinition(), profile: fakeProfile(), episodes: 2, gameSeconds: 1, seeds: [7, 8], pace: Pace.TURN });
        expect(browser.opened.map((o: { seed?: number }): number | undefined => o.seed)).toEqual([7, 8]);
        await player.play({ game: fakeGameDefinition({ seedable: false }), profile: fakeProfile(), episodes: 1, gameSeconds: 1, seeds: [7], pace: Pace.TURN });
        expect(browser.opened[2].seed).toBeUndefined();
    });

    it("runs the game's start as given, a real-time wait included", async (): Promise<void> => {
        const { browser } = await play({ game: fakeGameDefinition({ start: [{ press: ["Space"], advanceMs: 700 }, { waitMs: 1000 }] }), seconds: 1 });
        expect(browser.steps.slice(0, 2)).toEqual([
            { press: ["Space"], advanceMs: 700, observe: false },
            { waitMs: 1000, advanceMs: 0, observe: false },
        ]);
    });

    it("lets the keys a holdFrom start step names go with the next step, and before play after a last one", async (): Promise<void> => {
        const start: InputStep[] = [{ holdFrom: "window.way", advanceMs: 70 }, { press: ["Enter"], advanceMs: 30 }, { holdFrom: "window.way", advanceMs: 70 }];
        const { browser } = await play({ game: fakeGameDefinition({ start }), seconds: 0.2 });
        expect(browser.steps.slice(0, 5)).toEqual([
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], press: ["Enter"], advanceMs: 30, observe: false },
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], advanceMs: 0, observe: false },
            // Then the first frame is read.
            { advanceMs: 0 },
        ]);
    });

    it("holds a key chosen again instead of re-pressing it", async (): Promise<void> => {
        const { browser } = await play({ engine: new FakeEngine((): string => "JUMP"), seconds: 1 });
        const holds: string[][] = browser.steps.filter((s: { hold?: string[] }): boolean => Array.isArray(s.hold) && s.hold.length > 0).map((s: { hold?: string[] }): string[] => s.hold!);
        expect(holds.length).toBeGreaterThan(5);
        expect(holds.every((h: string[]): boolean => h.join() === "Space")).toBe(true);
    });

    it("does not ask while askWhen is false: the last decision stays in force", async (): Promise<void> => {
        const plain: { result: PlayResult } = await play({ seconds: 3 });
        const lazy: { result: PlayResult; ticks: TickEvent[] } = await play({ seconds: 3, profile: fakeProfile({ askWhen: "state.dx !== null && state.dx < 60" }) });
        expect(lazy.result.episodes[0].over).toBe(false);
        expect(lazy.result.decisions).toBeLessThan(plain.result.decisions / 2);
        expect(lazy.result.episodes[0].lastTicks.some((t: { asked: boolean }): boolean => !t.asked)).toBe(true);
    });

    it("marks an action the game ignores for the engine", async (): Promise<void> => {
        // A frozen raw input: the state never changes, whatever is chosen.
        const browser: FakeGame = new FakeGame();
        browser.raw = (): unknown => [{ k: "img", s: "i1:0,0,20,20", x: 100, y: 100, w: 20, h: 20 }];
        const profile: Profile = fakeProfile({ extractor: "function extract(raw) { return { dx: raw[0].x }; }" });
        const { engine } = await play({ browser, profile, seconds: 1, engine: new FakeEngine((): string => "NOOP") });
        const criteria: string[] = engine.asked.map((a: { questions: any }): string => a.questions.action.criteria.NOOP);
        expect(criteria[0]).toBe("Keep running");
        expect(criteria[1]).toBe("Keep running");
        expect(criteria[2]).toMatch(/CHOSEN 2 TIMES IN A ROW WITH NO EFFECT/);
    });

    it("sees a change in a field whose name only holds a counter's letters: a boss's damage is no age", async (): Promise<void> => {
        // The boss takes a hit every step Space (FIRE) is held; nothing else changes. A signature without `bossDamage`
        // stayed the same, and FIRE was marked ignored by the game while every shot hit.
        class BossFakeGame extends FakeGame {
            damage: number = 0;

            override async step(request: StepRequest): Promise<StepResult> {
                this.steps.push(request);
                if (request.hold) {
                    this.held = new Set(request.hold);
                }
                this.t += request.advanceMs ?? 0;
                if ((request.advanceMs ?? 0) > 0 && this.held.has("Space")) {
                    this.damage++;
                }
                return request.observe === false ? {} : { raw: { damage: this.damage }, score: { over: false, score: this.damage }, clockMs: this.t };
            }
        }
        const profile: Profile = fakeProfile({
            extractor: "function extract(raw) { return { bossDamage: raw.damage }; }",
            actions: [
                { id: "WAIT", description: "Wait", keys: [] },
                { id: "FIRE", description: "Fire at the boss", keys: ["Space"] },
            ],
        });
        const { engine } = await play({ browser: new BossFakeGame(), profile, seconds: 0.2, engine: new FakeEngine((): string => "FIRE") });
        const criteria: string[] = engine.asked.map((a: { questions: any }): string => a.questions.action.criteria.FIRE);
        expect(criteria.length).toBeGreaterThan(5);
        expect(criteria.every((c: string): boolean => c === "Fire at the boss")).toBe(true);
    });

    it("strips advice from the state before the engine sees it, and counts it", async (): Promise<void> => {
        const profile: Profile = fakeProfile({
            extractor: "function extract(raw) { return { dx: raw[0].x, advice: 'JUMP', next: 'JUMP' }; }",
        });
        const { result, engine } = await play({ profile, seconds: 1 });
        expect(engine.asked[0].state.game).toEqual({ dx: expect.any(Number) });
        expect(result.adviceFieldsDropped).toBe(2 * result.episodes[0].steps + 2);
    });

    it("keeps playing through extractor errors: a frame with no state is not asked about, and the first error is reported", async (): Promise<void> => {
        const profile: Profile = fakeProfile({ extractor: "function extract(raw) { return raw.nothing.here; }" });
        const { result, engine } = await play({ profile, seconds: 1, engine: new FakeEngine((): string => "NOOP") });
        expect(result.extractErrors).toBeGreaterThan(0);
        expect(result.episodes[0].firstExtractError).toMatch(/undefined/);
        // Nothing to answer on any frame: never asked, and no input before a first decision.
        expect(engine.asked).toHaveLength(0);
        expect(result.episodes[0]).toMatchObject({ decisions: 0, invalidAnswers: 0, actionCounts: {} });
    });

    it("decideOn change holds an action until the state changes", async (): Promise<void> => {
        const browser: FakeGame = new FakeGame();
        let calls: number = 0;
        browser.raw = (): unknown => [{ k: "img", s: "i1:0,0,20,20", x: Math.floor(++calls / 5), y: 100, w: 20, h: 20 }];
        const profile: Profile = fakeProfile({
            extractor: "function extract(raw) { return { cell: raw[0].x }; }",
            decideOn: DecideOn.CHANGE,
            tickMs: 60,
            maxHoldMs: 400,
        });
        const { result, browser: b } = await play({ browser, profile, seconds: 2, engine: new FakeEngine((): string => "NOOP") });
        // Several steps per decision: the action is held while the cell stays the same.
        expect(b.steps.length).toBeGreaterThan(result.episodes[0].decisions * 3);
    });

    it("collects a failure window and what is new after the trained horizon", async (): Promise<void> => {
        const browser: FakeGame = new FakeGame();
        browser.lateSpriteAtMs = 300;
        const player: Player = new Player(browser, new FakeEngine((): string => "NOOP"));
        const result: PlayResult = await player.play({
            game: fakeGameDefinition(),
            profile: fakeProfile(),
            episodes: 1,
            gameSeconds: 5,
            pace: Pace.TURN,
            collect: { windowFrames: 10, noveltyAfterMs: 200 },
        });
        const e: EpisodeResult = result.episodes[0];
        expect(e.over).toBe(true);
        expect(e.failureWindow).toHaveLength(10);
        expect(e.novel?.map((n: { key: string }): string => n.key)).toEqual(["i1:90,0,9,9"]);
    });

    it("marks a failure window's frame the page could not be read on: the extractor never saw it", async (): Promise<void> => {
        // The page read fails on the game-over frame (the player's sprite gone), as a page reader's expression can.
        class UnreadEndFakeGame extends FakeGame {
            override async step(request: StepRequest): Promise<StepResult> {
                const result: StepResult = await super.step(request);
                return this.over && request.observe !== false ? { readError: "Cannot read properties of undefined (reading 'x')", score: result.score, clockMs: result.clockMs } : result;
            }
        }
        const result: PlayResult = await new Player(new UnreadEndFakeGame(), new FakeEngine((): string => "NOOP")).play({
            game: fakeGameDefinition(),
            profile: fakeProfile(),
            episodes: 1,
            gameSeconds: 5,
            pace: Pace.TURN,
            collect: { windowFrames: 4 },
        });
        const e: EpisodeResult = result.episodes[0];
        expect(e).toMatchObject({ over: true, extractErrors: 1 });
        expect(e.failureWindow?.map((raw: unknown): boolean => raw === undefined)).toEqual([false, false, false, true]);
        expect(e.failureInfo?.map((info: WindowFrameInfo): boolean => info.unread === true)).toEqual([false, false, false, true]);
    });

    it("stops at an abort, and records the whole run", async (): Promise<void> => {
        const browser: FakeGame = new FakeGame();
        const abort: AbortController = new AbortController();
        let ticks: number = 0;
        const result: PlayResult = await new Player(browser, new FakeEngine(jumpWhenClose)).play({
            game: fakeGameDefinition(),
            profile: fakeProfile(),
            episodes: 3,
            gameSeconds: 5,
            pace: Pace.TURN,
            recordDir: "/tmp/x",
            signal: abort.signal,
            hooks: {
                onTick: (): void => {
                    if (++ticks === 20) {
                        abort.abort();
                    }
                },
            },
        });
        expect(result.stopped).toBe(true);
        expect(result.episodes).toHaveLength(1);
        expect(result.videoPath).toBe("/tmp/fake-video.webm");
        expect(browser.recording).toBe(false);
    });

    it("clicks where the action says, only when it was just decided", async (): Promise<void> => {
        const profile: Profile = fakeProfile({
            actions: [
                { id: "WAIT", description: "wait", keys: [] },
                { id: "LEFT", description: "tap the left half", click: { x: 0.25, y: 0.5 } },
            ],
            askWhen: "state.dx !== null && state.dx < 200",
        });
        const { browser } = await play({ profile, seconds: 1, engine: new FakeEngine((): string => "LEFT") });
        const clicks: unknown[] = browser.steps.filter((s: { click?: unknown }): boolean => s.click !== undefined).map((s: { click?: unknown }): unknown => s.click);
        expect(clicks.length).toBeGreaterThan(0);
        expect(clicks.every((c: unknown): boolean => JSON.stringify(c) === JSON.stringify({ x: 0.25, y: 0.5 }))).toBe(true);
    });

    it("holds the pointer while a pointer action is in force, and lets it go when another is chosen", async (): Promise<void> => {
        const profile: Profile = fakeProfile({
            actions: [
                { id: "WAIT", description: "wait", keys: [] },
                { id: "CHARGE", description: "press and hold", pointer: true },
            ],
        });
        let n: number = 0;
        const { browser } = await play({ profile, seconds: 1, engine: new FakeEngine((): string => (n++ % 6 < 3 ? "CHARGE" : "WAIT")) });
        const decided: Array<{ pointer?: unknown }> = browser.steps.filter((s: { advanceMs?: number; observe?: boolean }): boolean => s.observe !== false && (s.advanceMs ?? 0) > 0);
        // Held from the first CHARGE on, released on the first WAIT after it; a WAIT after a WAIT says nothing.
        expect(decided.slice(0, 7).map((s: { pointer?: unknown }): unknown => s.pointer)).toEqual([true, true, true, false, undefined, undefined, true]);
        expect(browser.steps.at(-1)).toMatchObject({ hold: [], observe: false });
    });

    it("scores from the state when the game has no score expression", async (): Promise<void> => {
        const profile: Profile = fakeProfile({ extractor: "function extract(raw, m) { m.n = (m.n || 0) + 1; return { score: m.n, over: m.n > 10 }; }" });
        const { result } = await play({ game: fakeGameDefinition({ score: { fromState: true, label: "frames" } }), profile, seconds: 5 });
        expect(result.episodes[0].over).toBe(true);
        expect(result.episodes[0].score).toBe(11);
    });

    it("takes a game waiting between rounds on with its resume, keys let go first", async (): Promise<void> => {
        const browser: RoundsFakeGame = new RoundsFakeGame(1_000);
        const { result } = await play({ game: fakeGameDefinition({ resume: [{ click: true, advanceMs: 100 }] }), browser, seconds: 3.5 });
        expect(browser.round).toBe(4);
        expect(result.episodes[0].over).toBe(false);
        const clicks: number[] = browser.steps.flatMap((s: StepRequest, i: number): number[] => (s.click ? [i] : []));
        expect(clicks.length).toBe(3);
        for (const i of clicks) {
            expect(browser.steps[i - 1]).toEqual({ hold: [], advanceMs: 0, observe: false });
            expect(browser.steps[i]).toEqual({ click: true, advanceMs: 100, observe: false });
        }
    });

    it("plays a waiting game on as it is when the game has no resume, or its resume does not take it on", async (): Promise<void> => {
        const still: RoundsFakeGame = new RoundsFakeGame(1_000);
        await play({ browser: still, seconds: 2 });
        expect(still.round).toBe(1);
        expect(still.steps).not.toContainEqual({ hold: [], advanceMs: 0, observe: false });

        const stuck: RoundsFakeGame = new RoundsFakeGame(1_000);
        const { result } = await play({ game: fakeGameDefinition({ resume: [{ press: ["Enter"], advanceMs: 100 }] }), browser: stuck, seconds: 2 });
        expect(stuck.round).toBe(1);
        expect(stuck.steps.filter((s: StepRequest): boolean => s.press?.[0] === "Enter").length).toBe(3);
        expect(result.episodes[0].gameSeconds).toBe(2);
    });

    describe("when an answer is no action", (): void => {
        const tapGame: Partial<Profile> = {
            actions: [
                { id: "TAP", description: "tap", click: true },
                { id: "WAIT", description: "wait", keys: [] },
            ],
        };

        it("keeps the last decision in force without clicking again", async (): Promise<void> => {
            let n: number = 0;
            // One tap, then answers that are no action.
            const { result, browser } = await play({ profile: fakeProfile(tapGame), seconds: 1, engine: new FakeEngine((): string => (n++ === 0 ? "TAP" : "FLY")) });
            expect(browser.steps.filter((s: StepRequest): boolean => s.click !== undefined)).toHaveLength(1);
            expect(result.episodes[0].invalidAnswers).toBe(result.episodes[0].steps - 1);
            expect(result.episodes[0].firstInvalidAnswer).toMatch(/Invalid choice answer/);
            expect(result.episodes[0].actionCounts).toEqual({ TAP: result.episodes[0].steps });
        });

        it("sends no input before the first decision", async (): Promise<void> => {
            let n: number = 0;
            // The first question's answers (asked three times) are no action; then WAIT.
            const { result, browser } = await play({ profile: fakeProfile(tapGame), seconds: 1, engine: new FakeEngine((): string => (n++ < 3 ? "FLY" : "WAIT")) });
            expect(browser.steps[1]).toEqual({ advanceMs: 20 });
            expect(browser.steps.filter((s: StepRequest): boolean => s.click !== undefined)).toHaveLength(0);
            expect(result.episodes[0].actionCounts.TAP).toBeUndefined();
            expect(result.episodes[0].invalidAnswers).toBe(1);
            expect(result.episodes[0].steps).toBe(49);
        });

        it("keeps playing when the rules as code fail on a state: the last decision stands", async (): Promise<void> => {
            const profile: Profile = fakeProfile({
                teacher: "function teach(state) { if (state.air) { throw new Error('BOOM in the air'); } return state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }",
            });
            const result: PlayResult = await new Player(new FakeGame(), new RulesTeacher(profile)).play({ game: fakeGameDefinition(), profile, episodes: 1, gameSeconds: 2, pace: Pace.TURN });
            const e: EpisodeResult = result.episodes[0];
            expect(e.invalidAnswers).toBeGreaterThan(0);
            // Why, the first time: what the rules threw.
            expect(e.firstInvalidAnswer).toBe("BOOM in the air");
            // A game with none says nothing.
            expect((await play({ seconds: 1 })).result.episodes[0].firstInvalidAnswer).toBeUndefined();
        });

        it("keeps playing when the rules as code make their input read-only: the last decision stands", async (): Promise<void> => {
            // Before, taking the input back threw a TypeError here, and the play ended with it.
            const profile: Profile = fakeProfile({
                teacher: `function teach(state) { if (state.seenFrames === 5) { Object.defineProperty(globalThis, "__in", { writable: false }); } return "NOOP"; }`,
            });
            const result: PlayResult = await new Player(new FakeGame(), new RulesTeacher(profile)).play({ game: fakeGameDefinition(), profile, episodes: 1, gameSeconds: 1, pace: Pace.TURN });
            const e: EpisodeResult = result.episodes[0];
            expect(e.gameSeconds).toBe(1);
            expect(e.invalidAnswers).toBe(e.decisions - 4);
            expect(e.firstInvalidAnswer).toBe("the script made its input (__in) read-only");
        });

        it("does not ask about a frame with no state (the extractor or the page read failed): the last decision stands, an extractor error", async (): Promise<void> => {
            const profile: Profile = fakeProfile({
                extractor: `function (raw, memory) { memory.n = (memory.n || 0) + 1; if (memory.n % 7 === 0) { throw new Error("no player"); } return (${RUNNER_EXTRACTOR})(raw, {}); }`,
                teacher: "function teach(state) { if (state.extractorError) { throw new Error('no state to decide on'); } return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }",
            });
            const rules: RulesTeacher = new RulesTeacher(profile);
            const asked: unknown[] = [];
            const engine: DecisionEngine = {
                kind: rules.kind,
                label: rules.label,
                ask: (state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> => {
                    asked.push((state as { game: unknown }).game);
                    return rules.ask(state, questions);
                },
                health: (): Promise<EngineHealth> => rules.health(),
            };
            const result: PlayResult = await new Player(new FakeGame(), engine).play({ game: fakeGameDefinition(), profile, episodes: 1, gameSeconds: 2, pace: Pace.TURN });
            const e: EpisodeResult = result.episodes[0];
            // Counted as extractor errors, with why — not as the rules failing.
            expect(e.extractErrors).toBeGreaterThan(0);
            expect(e.firstExtractError).toBe("no player");
            expect(e.invalidAnswers).toBe(0);
            // Never asked about one; the decision in force played on through it.
            expect(asked.some((s: unknown): boolean => isExtractorErrorState(s))).toBe(false);
            expect(e.decisions).toBe(asked.length);
            expect(e.steps).toBeGreaterThan(e.decisions);
        });
    });

    it("names each game's end screen for its seed: games played at once into one folder keep their own", async (): Promise<void> => {
        /** The screenshot tool names a file to the second: two games ending in the same second share a name but for theirs. */
        class Shots extends FakeGame {
            readonly names: string[] = [];
            override async screenshot(...[dir, name]: string[]): Promise<string | undefined> {
                this.names.push(name);
                return `${dir}/${name}-20260930-120000.png`;
            }
        }
        const endOf = async (options: { seeds?: number[]; game?: GameDefinition }): Promise<string | undefined> => {
            const browser: Shots = new Shots();
            const result: PlayResult = await new Player(browser, new FakeEngine((): string => "NOOP")).play({
                game: options.game ?? fakeGameDefinition(),
                profile: fakeProfile(),
                episodes: 1,
                gameSeconds: 2,
                ...(options.seeds ? { seeds: options.seeds } : {}),
                pace: Pace.TURN,
                screenshotDir: "/shots",
            });
            return result.episodes[0].endScreenshot;
        };
        const [a, b] = await Promise.all([endOf({ seeds: [101] }), endOf({ seeds: [202] })]);
        expect(a).toBe("/shots/episode-1-seed101-end-20260930-120000.png");
        expect(b).toBe("/shots/episode-1-seed202-end-20260930-120000.png");
        // A game the page cannot seed: named for the seed it was asked for; none asked for, as before.
        expect(await endOf({ seeds: [303], game: fakeGameDefinition({ seedable: false }) })).toBe("/shots/episode-1-seed303-end-20260930-120000.png");
        expect(await endOf({})).toBe("/shots/episode-1-end-20260930-120000.png");
    });

    it("marks an action ignored only while that same action is chosen again", async (): Promise<void> => {
        // A frozen raw input: the state never changes. NOOP twice, then JUMP from then on.
        const browser: FakeGame = new FakeGame();
        browser.raw = (): unknown => [{ k: "img", s: "i1:0,0,20,20", x: 100, y: 100, w: 20, h: 20 }];
        let n: number = 0;
        const profile: Profile = fakeProfile({ extractor: "function extract(raw) { return { dx: raw[0].x }; }" });
        const { engine } = await play({ browser, profile, seconds: 1, engine: new FakeEngine((): string => (n++ < 2 ? "NOOP" : "JUMP")) });
        const criteria: Array<Record<string, string>> = engine.asked.map((a: { questions: any }): Record<string, string> => a.questions.action.criteria);
        expect(criteria[2].NOOP).toMatch(/CHOSEN 2 TIMES IN A ROW WITH NO EFFECT/);
        // JUMP was chosen once so far: NOOP's repeats are not its.
        expect(criteria[3]).toEqual({ NOOP: "Keep running", JUMP: "Jump" });
        expect(criteria[4].JUMP).toMatch(/CHOSEN 2 TIMES IN A ROW WITH NO EFFECT/);
    });

    it("counts every step of a long episode, not only the ticks it keeps", async (): Promise<void> => {
        const { result } = await play({ seconds: 25 });
        expect(result.episodes[0].over).toBe(false);
        expect(result.episodes[0].steps).toBe(1_250);
        expect(result.episodes[0].lastTicks).toHaveLength(25);
    });

    it("never shows the engine a state that is itself an action id", async (): Promise<void> => {
        const profile: Profile = fakeProfile({ extractor: "function extract() { return 'JUMP'; }" });
        const { result, engine } = await play({ profile, seconds: 1, engine: new FakeEngine((): string => "NOOP") });
        expect(engine.asked.every((a: { state: any }): boolean => a.state.game === null)).toBe(true);
        expect(result.adviceFieldsDropped).toBe(result.episodes[0].steps + 1);
    });

    it("counts the frames whose score expression failed on the page", async (): Promise<void> => {
        class Unscored extends FakeGame {
            override async step(request: StepRequest): Promise<StepResult> {
                const result: StepResult = await super.step(request);
                return request.observe === false || this.t < 500 ? result : { raw: result.raw, clockMs: result.clockMs, scoreError: "ReferenceError: fake is not defined" };
            }
        }
        const { result } = await play({ browser: new Unscored(), seconds: 1, episodes: 2 });
        // The frames from 500 ms on, 20 ms apart, in each game.
        expect(result.episodes.map((e: EpisodeResult): number | undefined => e.scoreErrors)).toEqual([26, 26]);
        expect(result.scoreErrors).toBe(52);
        expect(result.episodes[0].score).toBe(0);
        const plain: PlayResult = (await play({ seconds: 1 })).result;
        expect(plain.scoreErrors).toBeUndefined();
        expect(plain.episodes[0].scoreErrors).toBeUndefined();
    });

    it("draws askWhen's random numbers from the game's seed: the same seed, the same questions", async (): Promise<void> => {
        const askedAt = async (seed: number): Promise<number[]> => {
            const ticks: TickEvent[] = [];
            await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({
                game: fakeGameDefinition(),
                profile: fakeProfile({ askWhen: "Math.random() < 0.5" }),
                episodes: 1,
                gameSeconds: 1,
                seeds: [seed],
                pace: Pace.TURN,
                hooks: { onTick: (t: TickEvent): number => ticks.push(t) },
            });
            return ticks.filter((t: TickEvent): boolean => t.asked).map((t: TickEvent): number => t.t);
        };
        const first: number[] = await askedAt(7);
        expect(first.length).toBeGreaterThan(5);
        expect(await askedAt(7)).toEqual(first);
        expect(await askedAt(8)).not.toEqual(first);
    });

    it("plays a seed the same in every game with one teacher whose rules draw random numbers", async (): Promise<void> => {
        // The runner's right rule as code, jumping in the window on a coin flip; its probabilities carry the draw.
        const profile: Profile = fakeProfile({
            teacher: "function teach(s) { var r = Math.random(); return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 && r < 0.5 ? { JUMP: 1, NOOP: r } : { NOOP: 1, JUMP: r / 2 }; }",
        });
        const decided: Array<Array<Record<string, number>>> = [[], []];
        let episode: number = 0;
        await new Player(new FakeGame(), new RulesTeacher(profile)).play({
            game: fakeGameDefinition(),
            profile,
            episodes: 2,
            gameSeconds: 2,
            seeds: [101],
            pace: Pace.TURN,
            hooks: {
                onEpisodeStart: (ep: number): void => {
                    episode = ep;
                },
                onDecision: (d: { probabilities: Record<string, number> }): number => decided[episode - 1].push(d.probabilities),
            },
        });
        expect(decided[0].length).toBeGreaterThan(50);
        expect(decided[1]).toEqual(decided[0]);
    });
});
