import { GameBrowser } from "../../../src/devtools/client";
import { OpenRequest, OpenResult, StepRequest, StepResult } from "../../../src/devtools/protocol";
import { RulesTeacher } from "../../../src/distill/teacher";
import { DecisionEngine, EngineKind, Question } from "../../../src/engine";
import { DecisionEngineError, RequestTooLargeError, SystemOneResponse } from "../../../src/engine/systemone";
import { LIVE_LATENCY } from "../../../src/game/configs";
import { FailureWindow, Perception, Profile, ProfileResults, RegressionTest } from "../../../src/game/types";
import { Library } from "../../../src/library/store";
import { EpisodeResult, Pace, Player } from "../../../src/play/player";
import { CALL_TIMEOUT_MS } from "../../../src/play/sandbox";
import { DecisionLog } from "../../../src/run/decision-log";
import { finalReply, parseJsonObject } from "../../../src/train/claude";
import { setupPrompt } from "../../../src/train/prompts";
import { runRegressionTests, TestResult } from "../../../src/train/regression";
import { Decider, playsUnseenWell, Trainer, TrainOptions, TrainResult, UNSEEN_TOLERANCE } from "../../../src/train/trainer";
import { FakeEngine, jumpWhenClose } from "../../helpers/fake-engine";
import { fakeGameDefinition, FakeGame, fakeProfile, RealtimeFakeGame, RUNNER_EXTRACTOR } from "../../helpers/fake-game";

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** A tuner that answers with the runner's right rule (and a test pinning it), or with what it is given. */
function tunerReply(overrides: Record<string, unknown> = {}): string {
    return `Here it is:\n${JSON.stringify({
        analysis: "It never jumped: the rule now jumps when the obstacle is close.",
        instructions: "If air is false and dx is between 10 and 40, choose JUMP. Otherwise choose NOOP.",
        extractor: RUNNER_EXTRACTOR,
        actions: [
            { id: "NOOP", description: "Keep running", keys: [] },
            { id: "JUMP", description: "Jump", keys: ["Space"] },
        ],
        decideOn: "tick",
        tickMs: 20,
        askWhen: null,
        newTests: [],
        ...overrides,
    })}`;
}

/** An engine applying the instructions it is asked with: "Always …" never jumps, any other jumps when close. */
function instructionsEngine(): DecisionEngine {
    const never: FakeEngine = new FakeEngine((): string => "NOOP");
    const obeying: FakeEngine = new FakeEngine(jumpWhenClose);
    return {
        kind: never.kind,
        label: "fake",
        ask: (state: unknown, questions: never): Promise<never> =>
            (String((questions as any).action.instructions.instructions).startsWith("Always") ? never : obeying).ask(state, questions) as Promise<never>,
        health: never.health.bind(never),
    };
}

describe("Trainer", (): void => {
    let root: string;
    let library: Library;
    const browsers: FakeGame[] = [];
    const openBrowser: () => GameBrowser = (): GameBrowser => {
        const b: FakeGame = new FakeGame();
        browsers.push(b);
        return b;
    };

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-train-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
        browsers.length = 0;
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("keeps a version only when it scores higher, with the failures saved as windows", async (): Promise<void> => {
        // v1 never jumps: it dies at the first obstacle. The engine obeys the rule in the instructions.
        library.saveProfile("fake-runner", { ...fakeProfile({ instructions: "Always choose NOOP." }), version: undefined } as never);
        const engine: FakeEngine = new FakeEngine((state: any): string => (state.rule === false ? "NOOP" : "NOOP"));
        const obeying: FakeEngine = new FakeEngine(jumpWhenClose);
        const prompts: string[] = [];
        let calls: number = 0;
        const trainer: Trainer = new Trainer({
            library,
            // The first version is played by an engine that never jumps; the tuner's by one applying its rule.
            engine: {
                kind: engine.kind,
                label: "fake",
                ask: (state: unknown, questions: never): Promise<never> =>
                    (String((questions as any).action.instructions.instructions).startsWith("Always") ? engine : obeying).ask(state, questions) as Promise<never>,
                health: engine.health.bind(engine),
            },
            openBrowser,
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                calls++;
                return calls === 1
                    ? tunerReply({
                        newTests: [{ window: "v1-seed1", ticks: "all", needsChoice: false, expect: "state.dx === null || typeof state.dx === 'number'", why: "dx is a number" }],
                    })
                    : tunerReply({ analysis: "no change" });
            },
        });
        const log: string[] = [];
        const result: TrainResult = await trainer.train({
            gameId: "fake-runner",
            iterations: 3,
            workDir: path.join(root, "work"),
            hooks: { onLog: (line: string): number => log.push(line) },
        });
        expect(result.savedVersions).toEqual([2]);
        expect(result.bestVersion).toBe(2);
        expect(library.activeVersion("fake-runner")).toBe(2);
        const v2: Profile = library.profile("fake-runner", 2)!;
        expect(v2).toMatchObject({ origin: "tuner", parent: 1, note: expect.stringMatching(/never jumped/), results: { seeds: [1, 2], gameSeconds: 3 } });
        // Played on seeds the tuner never sees, and measured against random play.
        expect(v2.results?.test).toMatchObject({ seeds: [1001, 2002, 3003], scores: [30, 30, 30] });
        expect(v2.results?.random?.scores).toHaveLength(2);
        expect(log.some((l: string): boolean => /v1 on seeds it is never shown \(1001, 2002, 3003\)/.test(l))).toBe(true);
        expect(prompts.join("\n")).not.toContain("seed1001");
        expect(v2.tests).toHaveLength(1);
        expect(library.window("fake-runner", "v1-seed1")?.rawFrames.length).toBeGreaterThan(0);
        // The tuner saw the evidence and the rules of the game it tunes.
        expect(prompts[0]).toContain("DIVISION OF LABOR");
        expect(prompts[0]).toContain('"over":true');
        expect(prompts[0]).toContain("v1-seed1");
        // Two tuner answers that did not beat v2 end the training early.
        expect(calls).toBe(3);
        expect(log.some((l: string): boolean => /training stops here/.test(l))).toBe(true);
        // Every evaluation played its seeds in browsers of their own, all closed.
        expect(browsers.every((b: FakeGame): boolean => b.closed || b.opened.length === 0)).toBe(true);
    });

    it("rejects a version that fails a regression test, after one repair", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ tests: [] }) } as never);
        library.saveWindow("fake-runner", { id: "w1", profileVersion: 1, rawFrames: [[], [], [], [], []] });
        const prompts: string[] = [];
        const trainer: Trainer = new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser,
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return tunerReply({
                    instructions: "Jump when dx is between 10 and 40 (the attempt).",
                    newTests: [{ window: "w1", ticks: "all", expect: "state.dx === 12345", why: "impossible" }],
                });
            },
        });
        const result: TrainResult = await trainer.train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work") });
        expect(result.savedVersions).toEqual([]);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("YOUR PREVIOUS ATTEMPT FAILED THESE REGRESSION TESTS");
        // What it failed with, and what may change: the profile, and its own tests only.
        expect(prompts[1]).toContain("The existing tests always run and cannot be changed");
        expect(prompts[1]).toMatch(/THAT ATTEMPT .*\n.*\(the attempt\)/);
        expect(prompts[0]).not.toContain("(the attempt)");
        expect(result.history.at(-1)).toMatchObject({ mean: null });
    });

    it("sets a new game up: samples it, asks for the first profile, saves it as v1", async (): Promise<void> => {
        const prompts: string[] = [];
        const trainer: Trainer = new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser,
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string, workDir: string): Promise<string> => {
                prompts.push(prompt);
                if (prompt.startsWith("You are setting up")) {
                    const sample: { sprites: Record<string, unknown>; watching: unknown[]; blindPlay: unknown[] } = JSON.parse(readFileSync(path.join(workDir, "raw-sample.json"), "utf-8"));
                    expect(Object.keys(sample.sprites)).toEqual(expect.arrayContaining(["i1:0,0,20,20", "i1:40,0,20,20"]));
                    // The game running on its own (first and last frame), then blind play.
                    expect(sample.watching).toHaveLength(2);
                    expect(sample.blindPlay.length).toBeGreaterThan(0);
                    return JSON.stringify({
                        extractor: RUNNER_EXTRACTOR,
                        actions: [
                            { id: "NOOP", description: "Keep running", keys: [] },
                            { id: "JUMP", description: "Jump", keys: ["Space"] },
                        ],
                        notes: "Jump when dx is between 10 and 40 and air is false.",
                        tickMs: 20,
                    });
                }
                return tunerReply({ analysis: "unchanged" });
            },
        });
        const result: TrainResult = await trainer.train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work") });
        expect(result.savedVersions[0]).toBe(1);
        const v1: Profile = library.profile("fake-runner", 1)!;
        expect(v1.origin).toBe("setup");
        expect(v1.instructions).toContain("Jump when dx is between 10 and 40");
        // Its first measurement is recorded on it, although no later version beat it.
        expect(v1.results).toMatchObject({ mean: result.history[0].mean, seeds: expect.any(Array), gameSeconds: expect.any(Number) });
        expect(library.file("fake-runner", "samples/raw-sample.json")).toBeDefined();
        expect(library.file("fake-runner", "samples/setup.json")).toBeDefined();
        expect(prompts[0]).toContain("DIVISION OF LABOR");
    });

    it("sets a new game up with its start as the player sends it: the keys a holdFrom step names are let go before the game is watched", async (): Promise<void> => {
        library.saveGame(
            fakeGameDefinition({
                budgets: { gameSeconds: 3, episodes: 1 },
                trainSeeds: [1, 2],
                start: [{ holdFrom: "window.way", advanceMs: 70 }, { press: ["Enter"], advanceMs: 30 }, { holdFrom: "window.way", advanceMs: 70 }],
            })
        );
        const trainer: Trainer = new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser,
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> =>
                JSON.stringify({
                    extractor: RUNNER_EXTRACTOR,
                    actions: [
                        { id: "NOOP", description: "Keep running", keys: [] },
                        { id: "JUMP", description: "Jump", keys: ["Space"] },
                    ],
                    notes: "Jump when dx is between 10 and 40 and air is false.",
                    tickMs: 20,
                }),
        });
        await trainer.train({ gameId: "fake-runner", iterations: 0, workDir: path.join(root, "work") });
        // The setup's game: its start, the keys the last step named let go (they were held through the watch and the blind play),
        // then the game watched running on its own.
        expect(browsers[0].steps.slice(0, 5)).toEqual([
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], press: ["Enter"], advanceMs: 30, observe: false },
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], advanceMs: 0, observe: false },
            { advanceMs: 100 },
        ]);
    });

    it("fails a setup whose answer was cut off, or is no profile, and keeps nothing of it as the setup's answer", async (): Promise<void> => {
        const setup = (reply: string): Trainer =>
            new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser,
                trainer: { command: "claude", model: "opus" },
                ask: async (): Promise<string> => reply,
            });
        // Cut off at the output limit: an empty object in the extractor's source once passed for the answer, and was kept.
        const cut: string = '{"extractor": "function extract(raw, memory) {\\n  memory.seen = memory.seen || {};\\n  var o = raw';
        const workDir: string = path.join(root, "work");
        await expect(setup(cut).train({ gameId: "fake-runner", iterations: 1, workDir })).rejects.toThrow(/^the reply holds no complete JSON object/);
        expect(library.file("fake-runner", "samples/setup.json")).toBeUndefined();
        expect(existsSync(path.join(workDir, "setup.json"))).toBe(false);
        // What it answered stays beside its prompt.
        expect(readFileSync(path.join(workDir, "setup-reply.txt"), "utf-8")).toBe(cut);
        // An answer that parses to no profile is none either.
        await expect(setup("{}").train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work-2") })).rejects.toThrow(/the setup's profile/);
        expect(library.file("fake-runner", "samples/setup.json")).toBeUndefined();
        expect(library.profile("fake-runner")).toBeUndefined();
    });

    it("keeps the setup's answer only once it made a profile: not one with no teacher while the rules decide, nor one whose extractor throws on every sample", async (): Promise<void> => {
        const setup = (reply: Record<string, unknown>): Trainer =>
            new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser,
                trainer: { command: "claude", model: "opus" },
                ask: async (): Promise<string> => JSON.stringify(reply),
            });
        const answer: Record<string, unknown> = {
            extractor: RUNNER_EXTRACTOR,
            actions: [
                { id: "NOOP", description: "Keep running", keys: [] },
                { id: "JUMP", description: "Jump", keys: ["Space"] },
            ],
            notes: "Jump when dx is between 10 and 40 and air is false.",
            tickMs: 20,
        };
        const kept = (workDir: string): boolean => library.file("fake-runner", "samples/setup.json") !== undefined || existsSync(path.join(workDir, "setup.json"));
        // The rules decide, and it wrote no teacher: it once was kept all the same, before the refusal.
        const noTeacher: string = path.join(root, "work");
        await expect(setup(answer).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 0, workDir: noTeacher })).rejects.toThrow(/the setup wrote no teacher/);
        expect(kept(noTeacher)).toBe(false);
        const throwing: string = path.join(root, "work-2");
        await expect(setup({ ...answer, extractor: "function extract() { throw new Error('no'); }" }).train({ gameId: "fake-runner", iterations: 0, workDir: throwing })).rejects.toThrow(
            /the setup's extractor throws on every sample/
        );
        expect(kept(throwing)).toBe(false);
        expect(library.profiles("fake-runner")).toEqual([]);
        // One that made a profile is kept.
        const made: string = path.join(root, "work-3");
        await setup(answer).train({ gameId: "fake-runner", iterations: 0, workDir: made });
        expect(JSON.parse(readFileSync(path.join(made, "setup.json"), "utf-8"))).toEqual(answer);
        expect(library.file("fake-runner", "samples/setup.json")).toBeDefined();
    });
});

describe("Trainer with the rules deciding", (): void => {
    it("plays every game with the profile's teacher, never the engine, and keeps a better teacher", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-rules-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            const engine: FakeEngine = new FakeEngine((): string => "NOOP");
            const right: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
            const prompts: string[] = [];
            const result: TrainResult = await new Trainer({
                library,
                engine,
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: right });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, workDir: path.join(root, "work") });
            expect(engine.asked).toHaveLength(0);
            expect(prompts[0]).toContain("Every decision is made by your TEACHER");
            expect(prompts[0]).toContain('"teacher":');
            expect(result.savedVersions).toEqual([2]);
            expect(library.profile("fake-runner", 2)?.teacher).toBe(right);
            expect(library.profile("fake-runner", 2)?.results?.scores).toEqual([30, 30]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("Trainer for real-time play", (): void => {
    it("plays every game with the clock running, tells the tuner how late a decision acts, and records both clocks", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-realtime-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            const browsers: FakeGame[] = [];
            const prompts: string[] = [];
            const log: string[] = [];
            await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => {
                    const b: FakeGame = new RealtimeFakeGame();
                    browsers.push(b);
                    return b;
                },
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }" });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, realtime: true, latency: { minMs: 20, maxMs: 20 }, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
            const opened: OpenRequest[] = browsers.flatMap((b: FakeGame): OpenRequest[] => b.opened);
            // Real time to be trained for, and each version played with the clock paused as well.
            expect(opened.some((r: OpenRequest): boolean => r.freezeClock === false)).toBe(true);
            expect(opened.some((r: OpenRequest): boolean => r.freezeClock === undefined)).toBe(true);
            expect(prompts[0]).toContain("REAL TIME");
            expect(prompts[0]).toContain("about 25 ms later");
            expect(prompts[0]).not.toContain("decideOn and maxHoldMs are not used");
            expect(prompts[0]).toContain("function extract(raw, memory, info)");
            expect(log.some((l: string): boolean => /v1 with the clock paused: mean/.test(l))).toBe(true);
            // The kept version is recorded with the clock paused, as the library compares versions, and in real time beside it.
            expect(library.profile("fake-runner", 2)?.results).toMatchObject({ scores: [30], realtime: { mean: expect.any(Number), lagMs: expect.any(Number) } });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe("Trainer for real time simulated on the paused clock", (): void => {
    it("plays every game with the clock paused, each decision landing the lag late, and records it as real time", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-simulated-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            const browsers: FakeGame[] = [];
            const prompts: string[] = [];
            const started: number = Date.now();
            await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => {
                    const b: FakeGame = new RealtimeFakeGame();
                    browsers.push(b);
                    return b;
                },
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }" });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, realtime: true, simulated: true, latency: { minMs: 20, maxMs: 40 }, workDir: path.join(root, "work") });
            // No game ran on the real clock, and none waited for one: 3 s of game time each, in far less.
            expect(browsers.flatMap((b: FakeGame): OpenRequest[] => b.opened).every((r: OpenRequest): boolean => r.freezeClock === undefined)).toBe(true);
            expect(Date.now() - started).toBeLessThan(3_000);
            expect(prompts[0]).toContain("REAL TIME");
            // Decided every max(tickMs, lag): decideOn "change" is not played in these games.
            expect(prompts[0]).toContain("decideOn and maxHoldMs are not used");
            expect(library.profile("fake-runner", 2)?.results).toMatchObject({ realtime: { mean: expect.any(Number), lagMs: expect.any(Number) } });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("plays each seed at the range's low end, middle and high end, shows the tuner each game's lag, and records the points", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-lag-points-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 2, episodes: 1 }, trainSeeds: [1, 2] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            const prompts: string[] = [];
            let opened: number = 0;
            await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => {
                    opened++;
                    return new RealtimeFakeGame();
                },
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: RIGHT_RULES });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, realtime: true, simulated: true, latency: { minMs: 20, maxMs: 40 }, workDir: path.join(root, "work") });
            expect(prompts[0]).toContain("Each seed is played once at each of 20, 30, 40 ms");
            for (const lag of [20, 30, 40]) {
                expect(prompts[0]).toContain(`"lagMs":${lag}`);
            }
            // Measured and kept over all six real-time games: a seed's score is the mean of its three.
            const realtime: NonNullable<ProfileResults["realtime"]> | undefined = library.profile("fake-runner", 2)?.results?.realtime;
            expect(realtime?.lagPoints).toEqual([20, 30, 40]);
            expect(realtime?.scores).toHaveLength(2);
            expect(realtime?.lagMs).toBe(30);
            // Real time at three points for both versions and their unseen seeds; paused and random once a seed.
            expect(opened).toBeGreaterThanOrEqual(2 * (6 + 9) + 2 * 2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("defaults to the lag Laya plays at live when simulated, and plays one lag once", (): void => {
        const trainer: Trainer = new Trainer({ library: new Library("/nonexistent-a", "/nonexistent-b"), engine: new FakeEngine((): string => "NOOP"), openBrowser: (): GameBrowser => new FakeGame(), trainer: { command: "claude", model: "opus" } });
        const options = (more: Partial<TrainOptions>): TrainOptions => ({ gameId: "fake-runner", iterations: 1, workDir: "/nonexistent", realtime: true, decider: Decider.RULES, ...more });
        expect((trainer as any).latencyRange(options({ simulated: true }))).toEqual(LIVE_LATENCY);
        expect((trainer as any).lagPoints(options({ simulated: true }))).toEqual([LIVE_LATENCY.minMs, Math.round((LIVE_LATENCY.minMs + LIVE_LATENCY.maxMs) / 2), LIVE_LATENCY.maxMs]);
        expect((trainer as any).lagPoints(options({ simulated: true, latency: { minMs: 50, maxMs: 50 } }))).toBeUndefined();
        expect((trainer as any).lagPoints(options({}))).toBeUndefined();
        expect((trainer as any).paceOf(options({ simulated: true }), 53)).toEqual({ pace: Pace.TURN, simulatedLag: { minMs: 53, maxMs: 53 } });
    });
});

describe("Trainer notes", (): void => {
    it("tells the tuner the notes of the person training, in its every prompt, and logs them at the start", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-notes-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 2, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT_RULES }) } as never);
            const prompts: string[] = [];
            const log: string[] = [];
            await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: RIGHT_RULES });
                },
            }).train({
                gameId: "fake-runner",
                decider: Decider.RULES,
                iterations: 2,
                note: "  jump only on the last moment  ",
                workDir: path.join(root, "work"),
                hooks: { onLog: (l: string): number => log.push(l) },
            });
            expect(prompts.length).toBeGreaterThanOrEqual(2);
            for (const prompt of prompts) {
                expect(prompt).toContain("NOTES FROM THE PERSON TRAINING THIS GAME");
                expect(prompt).toContain("<<<\njump only on the last moment\n>>>");
            }
            expect(log[0]).toBe('the notes for this training, told to the trainer: "jump only on the last moment"');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("says nothing of notes when none are given", (): void => {
        const prompt: string = setupPrompt({ game: fakeGameDefinition(), files: [] });
        expect(prompt).not.toContain("NOTES FROM THE PERSON TRAINING THIS GAME");
        expect(setupPrompt({ game: fakeGameDefinition(), files: [], userNote: "keep low" })).toContain("<<<\nkeep low\n>>>");
    });
});

describe("Trainer for real time: the paused bar", (): void => {
    /** Trains two iterations in simulated real time, each evaluation's mean set by its label — `it<i>` in real time, `it<i>-paused` paused (the games themselves are the fake runner's). */
    const trainWith = async (means: Record<string, number>): Promise<{ library: Library; log: string[]; prompts: string[]; root: string }> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-paused-bar-"));
        const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 2, episodes: 1 }, trainSeeds: [1] }));
        const rule: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: rule }) } as never);
        const log: string[] = [];
        const prompts: string[] = [];
        const evaluate: (...args: unknown[]) => Promise<{ result: { mean: number } }> = (Trainer.prototype as any).evaluate;
        const spy: jest.SpyInstance = jest.spyOn(Trainer.prototype as any, "evaluate").mockImplementation(async function (this: unknown, ...args: unknown[]): Promise<unknown> {
            const e: { result: { mean: number } } = await evaluate.apply(this, args);
            const label: string = args[4] as string;
            return label in means ? { ...e, result: { ...e.result, mean: means[label] } } : e;
        });
        try {
            await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => new RealtimeFakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: rule });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 2, realtime: true, simulated: true, latency: { minMs: 20, maxMs: 20 }, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        } finally {
            spy.mockRestore();
        }
        return { library, log, prompts, root };
    };

    it("is where training began: a version kept for playing better paused does not raise it", async (): Promise<void> => {
        // v1 plays 10 both ways; iteration 1 is better in real time and paused (kept); iteration 2 is better
        // in real time still, and paused worse than iteration 1 but not than v1: it is kept.
        const { library, log, root } = await trainWith({ v1: 10, "v1-paused": 10, it1: 20, "it1-paused": 20, it2: 25, "it2-paused": 15 });
        try {
            expect(log.filter((l: string): boolean => /=> v\d+ saved/.test(l))).toHaveLength(2);
            expect(library.profile("fake-runner", 3)).toBeDefined();
            expect(log.some((l: string): boolean => /not kept/.test(l))).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("keeps a version better in real time but worse paused for real time only — never made active — and tells the tuner so", async (): Promise<void> => {
        const { library, prompts, root } = await trainWith({ v1: 10, "v1-paused": 10, it1: 20, "it1-paused": 5 });
        try {
            expect(library.profile("fake-runner", 2)?.liveOnly).toBe(true);
            expect(library.activeVersion("fake-runner")).toBe(1);
            expect(prompts[1]).toContain("KEPT FOR REAL TIME ONLY (with the clock paused it plays 5.0 against v1's 10.0; not made active)");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("measures paused play against where training began: one worse there is kept for real time only, the active version staying the paused clock's", async (): Promise<void> => {
        const { library, log, root } = await trainWith({ v1: 10, "v1-paused": 10, it1: 20, "it1-paused": 20, it2: 25, "it2-paused": 5 });
        try {
            expect(library.profile("fake-runner", 2)?.liveOnly).toBeUndefined();
            expect(library.profile("fake-runner", 3)?.liveOnly).toBe(true);
            expect(library.activeVersion("fake-runner")).toBe(2);
            expect(log).toContainEqual("  => v3 saved for real time only: 25.0 beats 20.0 in real time, but with the clock paused it plays 5.0 against v1's 10.0 (not made active)");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("goes on from a version kept for real time only, and makes active a later one that plays both clocks well", async (): Promise<void> => {
        const { library, root } = await trainWith({ v1: 10, "v1-paused": 10, it1: 20, "it1-paused": 5, it2: 25, "it2-paused": 12 });
        try {
            expect(library.profile("fake-runner", 2)?.liveOnly).toBe(true);
            expect(library.profile("fake-runner", 3)?.liveOnly).toBeUndefined();
            expect(library.profile("fake-runner", 3)?.parent).toBe(2);
            expect(library.activeVersion("fake-runner")).toBe(3);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe("Trainer for plan mode", (): void => {
    it("trains versions that play in plans, told how, and refuses plans without real time", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-plan-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 2, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            const prompts: string[] = [];
            const trainer: Trainer = new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => new RealtimeFakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }" });
                },
            });
            const plan = { slots: 6, slotMs: 50 };
            await expect(trainer.train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, plan, workDir: path.join(root, "work") })).rejects.toThrow(/realtime/);
            await trainer.train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, realtime: true, latency: { minMs: 60, maxMs: 60 }, plan, workDir: path.join(root, "work") });
            expect(prompts[0]).toContain("PLAN MODE");
            expect(prompts[0]).toContain("the next 6 moments, 50 ms apart");
            expect(library.profile("fake-runner", 2)?.plan).toEqual(plan);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe("Trainer from a version that is not active", (): void => {
    it("starts from it and keeps its versions without making them active", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-from-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
            library.setActive("fake-runner", 1);
            const prompts: string[] = [];
            const result: TrainResult = await new Trainer({
                library,
                engine: new FakeEngine((): string => "NOOP"),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply({ teacher: "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }" });
                },
            }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, fromVersion: 2, workDir: path.join(root, "work") });
            expect(result.startVersion).toBe(2);
            expect(result.savedVersions).toEqual([3]);
            expect(library.activeVersion("fake-runner")).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("Trainer at the top score", (): void => {
    it("stops without asking the tuner when the best version already reaches the game's top score", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-max-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1], score: { expression: "x", label: "tenths", max: 30 } }));
            library.saveProfile("fake-runner", { ...fakeProfile() } as never);
            const log: string[] = [];
            const result: TrainResult = await new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (): Promise<string> => {
                    throw new Error("the tuner must not be asked");
                },
            }).train({ gameId: "fake-runner", iterations: 3, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
            expect(result.savedVersions).toEqual([]);
            expect(log.some((l: string): boolean => /reaches the top score/.test(l))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("runRegressionTests", (): void => {
    it("replays a window through the extractor and checks the state, and the engine's choice when asked", async (): Promise<void> => {
        const game: FakeGame = new FakeGame();
        const frames: unknown[] = [];
        for (let i: number = 0; i < 8; i++) {
            await game.step({ advanceMs: 100 });
            frames.push(game.raw());
        }
        const window = (id: string): { id: string; profileVersion: number; rawFrames: unknown[] } | undefined =>
            id === "w" ? { id, profileVersion: 1, rawFrames: frames } : undefined;
        const player: Player = new Player(new FakeGame(), new FakeEngine(jumpWhenClose));
        const results: TestResult[] = await runRegressionTests(
            fakeGameDefinition(),
            fakeProfile(),
            [
                { window: "w", ticks: "all", expect: "state.seenFrames >= 4" },
                { window: "w", ticks: [7], needsChoice: true, expect: "choice === 'NOOP'" },
                { window: "w", ticks: [1], expect: "state.dx === 0" },
                { window: "missing", ticks: "all", expect: "true" },
            ],
            window,
            player
        );
        expect(results.map((r: TestResult): boolean => r.pass)).toEqual([true, true, false, false]);
        expect(results[2].failedAt).toMatchObject({ frame: 1, state: { dx: expect.any(Number) } });
    });

    it("replays each frame of a window with what its extractor was told then (game time, a plan's moments)", async (): Promise<void> => {
        const window = (id: string): FailureWindow | undefined => ({
            id,
            profileVersion: 1,
            rawFrames: [{}, {}],
            lagMs: 40,
            frameInfo: [
                { lagMs: 300, nowMs: 1_000, slots: [300, 350] },
                { lagMs: 320, nowMs: 1_450, slots: [320, 370], pending: [{ inMs: 20, action: "JUMP" }] },
            ],
        });
        const profile: Profile = { ...fakeProfile(), extractor: "function (raw, memory, info) { return { lag: info.lagMs, now: info.nowMs, moments: (info.slots || []).length, soon: (info.pending || []).length }; }" };
        const results: TestResult[] = await runRegressionTests(
            fakeGameDefinition(),
            profile,
            [{ window: "w", ticks: [1], expect: "state.lag === 320 && state.now === 1450 && state.moments === 2 && state.soon === 1" }],
            window,
            new Player(new FakeGame(), new FakeEngine(jumpWhenClose))
        );
        expect(results[0].pass).toBe(true);
    });

    it("replays a window played in real time with the lag its extractor was told then", async (): Promise<void> => {
        const window = (id: string): FailureWindow | undefined => ({ id, profileVersion: 1, rawFrames: [{}, {}], lagMs: 40 });
        const profile: Profile = { ...fakeProfile(), extractor: "function (raw, memory, info) { return { lag: info.lagMs }; }" };
        const results: TestResult[] = await runRegressionTests(fakeGameDefinition(), profile, [{ window: "w", ticks: "all", expect: "state.lag === 40" }], window, new Player(new FakeGame(), new FakeEngine(jumpWhenClose)));
        expect(results[0].pass).toBe(true);
    });

    it("gives the extractor no frame the page could not be read on in play: its memory stays as the player left it, and nothing is checked there", async (): Promise<void> => {
        const frames: unknown[] = [{ x: 1 }, { x: 2 }, null, { x: 4 }, { x: 5 }];
        const frameInfo: FailureWindow["frameInfo"] = frames.map((raw: unknown): { lagMs: number; unread?: boolean } => (raw === null ? { lagMs: 0, unread: true } : { lagMs: 0 }));
        // Counts the frames it is given, and throws on a null one.
        const profile: Profile = { ...fakeProfile(), extractor: "function (raw, memory) { memory.seen = (memory.seen || 0) + 1; return { x: raw.x, seen: memory.seen }; }" };
        const tests: RegressionTest[] = [
            { window: "w", ticks: [3, 4], expect: "state.seen === state.x - 1" },
            // Pinned to that frame alone: no state was made of it, and nothing decided — nothing to check, nothing asked.
            { window: "w", ticks: [2], needsChoice: true, expect: "false" },
        ];
        const engine: FakeEngine = new FakeEngine(jumpWhenClose);
        const player: Player = new Player(new FakeGame(), engine);
        const marked: TestResult[] = await runRegressionTests(fakeGameDefinition(), profile, tests, (id: string): FailureWindow => ({ id, profileVersion: 1, rawFrames: frames, frameInfo }), player);
        expect(marked.map((r: TestResult): boolean => r.pass)).toEqual([true, true]);
        expect(engine.asked).toHaveLength(0);
        // A window saved before frames were marked replays every one, as before: its null frame reaches the extractor.
        const unmarked: TestResult[] = await runRegressionTests(fakeGameDefinition(), profile, [tests[0]], (id: string): FailureWindow => ({ id, profileVersion: 1, rawFrames: frames }), player);
        expect(unmarked[0]).toMatchObject({ pass: false, failedAt: { frame: 2, detail: expect.stringMatching(/^the extractor threw/) } });
    });

    it("replays a window the player saved with a frame the page could not be read on, as the player played it", async (): Promise<void> => {
        // The page read fails on the game-over frame (the player's sprite gone). The runner's extractor fails on a null frame.
        class UnreadEndFakeGame extends FakeGame {
            override async step(request: StepRequest): Promise<StepResult> {
                const result: StepResult = await super.step(request);
                return this.over && request.observe !== false ? { readError: "Cannot read properties of undefined (reading 'x')", score: result.score, clockMs: result.clockMs } : result;
            }
        }
        const played: EpisodeResult = (
            await new Player(new UnreadEndFakeGame(), new FakeEngine((): string => "NOOP")).play({
                game: fakeGameDefinition(),
                profile: fakeProfile(),
                episodes: 1,
                gameSeconds: 5,
                pace: Pace.TURN,
                collect: { windowFrames: 5 },
            })
        ).episodes[0];
        // As the trainer saves it (JSON: the unread frame is null).
        const saved: FailureWindow = JSON.parse(JSON.stringify({ id: "w", profileVersion: 1, rawFrames: played.failureWindow, frameInfo: played.failureInfo }));
        expect(saved.rawFrames[4]).toBeNull();
        const results: TestResult[] = await runRegressionTests(
            fakeGameDefinition(),
            fakeProfile(),
            [
                { window: "w", ticks: "all", expect: "state.dx !== null && state.seenFrames >= 4" },
                { window: "w", ticks: [4], expect: "false" },
            ],
            (): FailureWindow => saved,
            new Player(new FakeGame(), new FakeEngine(jumpWhenClose))
        );
        expect(results.map((r: TestResult): boolean => r.pass)).toEqual([true, true]);
    });

    it("fails a test whose decision the candidate cannot get — no action, its teacher failing, a state too large —, and throws an engine outage: no failure of the candidate's", async (): Promise<void> => {
        const window = (id: string): FailureWindow | undefined => ({ id, profileVersion: 1, rawFrames: [[], [], [], [], []] });
        const tests: RegressionTest[] = [{ window: "w", ticks: [4], needsChoice: true, expect: "choice === 'NOOP'" }];
        const answering = (ask: () => Promise<SystemOneResponse>): Player =>
            new Player(new FakeGame(), { kind: EngineKind.JEV, label: "jev", ask, health: async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "jev" }) });
        const run = (profile: Profile, player: Player): Promise<TestResult[]> => runRegressionTests(fakeGameDefinition(), profile, tests, window, player);
        // An answer that is no action (asked again, as the player asks); a state too large for the engine, which the extractor made.
        const noAction: TestResult[] = await run(fakeProfile(), answering(async (): Promise<SystemOneResponse> => ({ answers: { action: { choice: "DUCK", probabilities: { DUCK: 1 }, confidence: 1 } } })));
        expect(noAction[0]).toMatchObject({ pass: false, failedAt: { frame: 4, detail: "no decision: Invalid choice answer; no action executed" } });
        const tooLarge: string = 'jev: HTTP 400 {"detail": {"error_type": "max_tokens_exceeded"}}; no action executed';
        const large: TestResult[] = await run(
            fakeProfile(),
            answering(async (): Promise<SystemOneResponse> => {
                throw new RequestTooLargeError(tooLarge);
            })
        );
        expect(large[0]).toMatchObject({ pass: false, failedAt: { frame: 4, detail: `no decision: ${tooLarge}` } });
        // The rules deciding, its teacher throwing on the state.
        const throwing: Profile = fakeProfile({ teacher: "function teach() { throw new Error('no rule'); }" });
        const rules: TestResult[] = await run(throwing, new Player(new FakeGame(), new RulesTeacher(throwing)));
        expect(rules[0]).toMatchObject({ pass: false, failedAt: { frame: 4, detail: "no decision: no rule" } });
        // An engine that cannot be reached: thrown — the tuner was once sent a repair round for a test it did not fail.
        const down: string = "jev: connection to https://api.typesafe.ai/v1/systemone failed; no action executed";
        await expect(
            run(
                fakeProfile(),
                answering(async (): Promise<SystemOneResponse> => {
                    throw new DecisionEngineError(down);
                })
            )
        ).rejects.toThrow(down);
    });
});

describe("finalReply", (): void => {
    const line = (event: unknown): string => JSON.stringify(event);

    it("joins an answer the model's output limit cut into several messages, after its last tool call", (): void => {
        const stream: string = [
            line({ type: "system", subtype: "init" }),
            line({ type: "assistant", message: { content: [{ type: "text", text: "I will read the samples first." }] } }),
            line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
            line({ type: "user", message: { content: [{ type: "tool_result", content: "{ big file }" }] } }),
            line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } }),
            line({ type: "assistant", message: { content: [{ type: "text", text: '{"extractor": "function extract(raw) { return { x: 1' }] } }),
            line({ type: "assistant", message: { content: [{ type: "text", text: ' }; }", "notes": "ok"}' }] } }),
            line({ type: "result", subtype: "success", is_error: false, result: ' }; }", "notes": "ok"}' }),
        ].join("\n");
        expect(parseJsonObject(finalReply(stream))).toEqual({ extractor: "function extract(raw) { return { x: 1 }; }", notes: "ok" });
    });

    it("reports a failed run", (): void => {
        expect((): string => finalReply(line({ type: "result", is_error: true, result: "overloaded" }))).toThrow(/no result: overloaded/);
    });
});

describe("playsUnseenWell", (): void => {
    it("passes a candidate no more than 1 % worse than the best on the seeds it is never shown: a point on one seed is noise", (): void => {
        expect(UNSEEN_TOLERANCE).toBe(0.01);
        // 35 against 36 on one seed of three (a candidate playing 1266 against 494 was turned away for it).
        expect(playsUnseenWell(859.0, 859.3)).toBe(true);
        expect(playsUnseenWell(850.8, 859.3)).toBe(true);
        expect(playsUnseenWell(850, 859.3)).toBe(false);
        expect(playsUnseenWell(900, 859.3)).toBe(true);
        // A best of 0: 1 % of it is nothing, so no worse at all.
        expect(playsUnseenWell(0, 0)).toBe(true);
        expect(playsUnseenWell(-0.1, 0)).toBe(false);
        // Below zero, 1 % of its size.
        expect(playsUnseenWell(-101, -100)).toBe(true);
        expect(playsUnseenWell(-101.5, -100)).toBe(false);
    });
});

describe("parseJsonObject", (): void => {
    it("finds the object in a reply with prose or a fence around it", (): void => {
        expect(parseJsonObject('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
        expect((): unknown => parseJsonObject("no json")).toThrow(/no JSON/);
    });

    it("skips braces in the prose before the object", (): void => {
        expect(parseJsonObject('The state {dx, air} now leads by lagMs.\n{"analysis": "x", "extractor": "function extract(raw) { return {}; }"}')).toEqual({
            analysis: "x",
            extractor: "function extract(raw) { return {}; }",
        });
        expect((): unknown => parseJsonObject("{not json}")).toThrow();
    });

    it("skips braces in the prose after the object, and counts none inside its strings", (): void => {
        const answer: Record<string, string> = { analysis: "x", extractor: "function extract(raw) { return {a: 1}; }" };
        expect(parseJsonObject(`${JSON.stringify(answer)}\n\nNote: the state now has {dx, air}.`)).toEqual(answer);
        expect(parseJsonObject(`Before {dx} and after:\n${JSON.stringify(answer)}\nthen {air, "quoted} and {unclosed`)).toEqual(answer);
        // Braces and escaped quotes inside strings are the strings' own.
        const tricky: Record<string, string> = { extractor: 'function extract(raw) { var s = "}{\\"}"; return { s: s }; }', notes: "a } b { c" };
        expect(parseJsonObject(`Here:\n${JSON.stringify(tricky)} — done {x}`)).toEqual(tricky);
    });

    it("takes the largest object, and never one nested in an answer that does not parse", (): void => {
        expect(parseJsonObject('An example: {"a": 1}. The answer: {"analysis": "x", "newTests": [{"window": "w"}]}')).toEqual({ analysis: "x", newTests: [{ window: "w" }] });
        // A trailing comma: the answer's own error, not its first action as the reply.
        expect((): unknown => parseJsonObject('{"actions": [{"id": "NOOP", "keys": []}], "notes": "n",}')).toThrow(SyntaxError);
        // Cut off at the output limit: the answer never closes — said so, even where a part of it does close.
        expect((): unknown => parseJsonObject('{"extractor": "function extract(raw) { return { x: 1')).toThrow(/^the reply holds no complete JSON object$/);
        expect((): unknown => parseJsonObject('{"extractor": "function extract(raw) { var a = {b: 1}; return {c')).toThrow(/^the reply holds no complete JSON object \(.+\)$/);
    });

    it("takes nothing inside an answer cut off at the output limit — no span in its strings — whatever came before it", (): void => {
        // A complete answer whose extractor holds empty object literals: taken whole.
        const answer: Record<string, string> = {
            analysis: "a",
            extractor: 'function extract(raw, memory, info) { memory.p = memory.p || {}; if (raw.kind === "bird") { return {}; } return { dx: 1 }; }',
            teacher: 'function teach(s) { return "JUMP"; }',
        };
        const full: string = JSON.stringify(answer);
        expect(parseJsonObject(full)).toEqual(answer);
        // Cut off in the teacher's source: an empty object in the extractor's once passed for the answer.
        expect((): unknown => parseJsonObject(full.slice(0, full.indexOf("teacher") + 25))).toThrow(/^the reply holds no complete JSON object/);
        expect((): unknown => parseJsonObject('{"analysis": "x", "extractor": "function extract(raw, memory, info) {\\n  memory.seen = memory.seen || {};\\n  var o = raw.objects')).toThrow(
            /^the reply holds no complete JSON object/
        );
        // Written out on lines, after an example in the prose: the answer cut off all the same, not the example.
        expect((): unknown =>
            parseJsonObject(`An example: {"a": 1}. The answer:\n{\n  "analysis": "x",\n  "extractor": "function extract(raw) { var s = {}; return s; }",\n  "teacher": "function teach(s) { return {`)
        ).toThrow(/^the reply holds no complete JSON object/);
        // A brace of the prose that never closes is no answer cut off: the answer after it is taken.
        expect(parseJsonObject(`The state {dx now leads by lagMs.\n${full}`)).toEqual(answer);
    });

    it("takes the answer after prose that quotes a brace: only one opening with a key and its colon is an answer cut off", (): void => {
        const answer: Record<string, string> = { analysis: "a", extractor: 'function extract(raw) { var s = {}; return { dx: 1, s: "{" }; }' };
        const full: string = JSON.stringify(answer);
        // The quoted brace never closes, and `{"` once passed for an answer cut off: the complete one after it failed.
        expect(parseJsonObject(`I escaped the "{" character.\n${full}`)).toEqual(answer);
        expect(parseJsonObject(`The "{" opens it, then: ${full}`)).toEqual(answer);
        // An answer cut off opens with its first key: still no answer, on one line or on several.
        expect((): unknown => parseJsonObject(`I escaped the "{" character.\n${full.slice(0, full.indexOf("extractor") + 30)}`)).toThrow(/^the reply holds no complete JSON object/);
        expect((): unknown => parseJsonObject(`An example: {"a": 1}. The answer:\n{\n  "analysis": "x",\n  "extractor": "function extract(raw) { return {`)).toThrow(
            /^the reply holds no complete JSON object/
        );
    });
});

describe("Trainer: what it records and hands on", (): void => {
    let root: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-train-record-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("hands each failure window on once: tuned on again, the best version saves no empty window", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const log: string[] = [];
        // The engine never jumps: every version dies, none is kept, and v1 is tuned on twice.
        await new Trainer({
            library,
            engine: new FakeEngine((): string => "NOOP"),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => tunerReply(),
        }).train({ gameId: "fake-runner", iterations: 2, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        const windows: string[] = readdirSync(path.join(root, "user", "fake-runner", "windows")).sort();
        expect(windows).toEqual(["v1-seed1.json", "v1-seed2.json"]);
        expect(windows.every((w: string): boolean => (library.window("fake-runner", w.slice(0, -5))?.rawFrames.length ?? 0) > 0)).toBe(true);
        expect(log.filter((l: string): boolean => /^iteration \d: tuning/.test(l)).map((l: string): string | undefined => /(\d+) new windows/.exec(l)?.[1])).toEqual(["2", "0"]);
    });

    it("records nothing of a start measurement a stop cut short", async (): Promise<void> => {
        // No results yet (a version fresh from setup): the start's measurement would be its record.
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const abort: AbortController = new AbortController();
        const result: TrainResult = await new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => {
                throw new Error("the tuner must not be asked");
            },
        }).train({
            gameId: "fake-runner",
            iterations: 1,
            workDir: path.join(root, "work"),
            signal: abort.signal,
            // Stopped while random play measures the floor.
            hooks: {
                onLog: (l: string): void => {
                    if (/never shown/.test(l)) {
                        abort.abort();
                    }
                },
            },
        });
        expect(result.stopped).toBe(true);
        expect(library.profile("fake-runner", 1)?.results).toBeUndefined();
    });

    it("measures a kept version's random floor with its own profile, and keeps no version a stop cut short", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ instructions: "Always choose NOOP." }) } as never);
        const floors: number[] = [];
        const scoreOn: (...args: unknown[]) => Promise<unknown> = (Trainer.prototype as any).scoreOn;
        const spy: jest.SpyInstance = jest.spyOn(Trainer.prototype as any, "scoreOn").mockImplementation(async function (this: unknown, ...args: unknown[]): Promise<unknown> {
            if (args[5]) {
                floors.push((args[1] as Profile).version);
            }
            return scoreOn.apply(this, args);
        });
        const train = (signal?: AbortSignal, onLog?: (l: string) => void): Promise<TrainResult> =>
            new Trainer({
                library,
                engine: instructionsEngine(),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (): Promise<string> => tunerReply(),
            }).train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work"), ...(signal ? { signal } : {}), ...(onLog ? { hooks: { onLog } } : {}) });
        try {
            // Stopped after the unseen seeds, while the floor is measured: nothing is kept.
            const abort: AbortController = new AbortController();
            const stopped: TrainResult = await train(abort.signal, (l: string): void => {
                if (/iteration 1 on the unseen seeds/.test(l)) {
                    abort.abort();
                }
            });
            expect(stopped).toMatchObject({ stopped: true, savedVersions: [] });
            floors.length = 0;
            const result: TrainResult = await train();
            expect(result.savedVersions).toEqual([2]);
            // The start's floor with v1, the kept version's with its own profile (the candidate, v2).
            expect(floors).toEqual([1, 2]);
            expect(library.profile("fake-runner", 2)?.results?.random?.scores).toHaveLength(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps a better candidate that plays the seeds it is never shown no more than 1 % worse, and turns away one worse than that, saying so", async (): Promise<void> => {
        const scoreOn: (...args: unknown[]) => Promise<unknown> = (Trainer.prototype as any).scoreOn;
        const run = async (candidate: number, work: string): Promise<{ result: TrainResult; log: string[] }> => {
            // The unseen seeds' means: the best's first, then the candidate's (the random floor is played).
            const unseen: number[] = [859.3, candidate];
            const spy: jest.SpyInstance = jest.spyOn(Trainer.prototype as any, "scoreOn").mockImplementation(async function (this: unknown, ...args: unknown[]): Promise<unknown> {
                if (args[5]) {
                    return scoreOn.apply(this, args);
                }
                const mean: number = unseen.shift() as number;
                return { mean, scores: [mean, mean, mean], stopped: false, invalidAnswers: 0 };
            });
            try {
                const log: string[] = [];
                const result: TrainResult = await new Trainer({
                    library,
                    engine: instructionsEngine(),
                    openBrowser: (): GameBrowser => new FakeGame(),
                    trainer: { command: "claude", model: "opus" },
                    ask: async (): Promise<string> => tunerReply(),
                }).train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, work), hooks: { onLog: (l: string): number => log.push(l) } });
                return { result, log };
            } finally {
                spy.mockRestore();
            }
        };
        library.saveProfile("fake-runner", { ...fakeProfile({ instructions: "Always choose NOOP." }) } as never);
        // Far better on the training seeds, 0.3 worse on the unseen ones (a point on one seed): it once was turned away.
        expect((await run(859.0, "work-1")).result.savedVersions).toEqual([2]);
        library.setActive("fake-runner", 1);
        const refused: { result: TrainResult; log: string[] } = await run(850, "work-2");
        expect(refused.result.savedVersions).toEqual([]);
        expect(refused.log).toContainEqual(
            expect.stringMatching(/^ {2}=> not kept: \d+\.\d beats \d+\.\d on the training seeds, but on seeds it is never shown it plays 850\.0 against 859\.3 \(more than 1 % worse\)$/)
        );
        expect(refused.result.history[1]).toMatchObject({
            kept: false,
            note: expect.stringMatching(/^NOT KEPT although better on the training seeds: on other seeds, never shown, it played 850\.0 against 859\.3 \(more than 1 % worse\) — /),
        });
    });

    it("started from a version that is not active, the teacher it writes first is not made active either", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        library.setActive("fake-runner", 1);
        const right: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        await new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> =>
                prompt.startsWith("You are writing the TEACHER") ? JSON.stringify({ teacher: right, notes: "the rules as code" }) : tunerReply({ teacher: right }),
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, fromVersion: 2, workDir: path.join(root, "work") });
        expect(library.profile("fake-runner", 3)).toMatchObject({ origin: "teacher", parent: 2, teacher: right });
        expect(library.activeVersion("fake-runner")).toBe(1);
    });

    it("keeps a teacher the reply did not rewrite only while it holds: the rules decide, or nothing it was written for changed", (): void => {
        const trainer: Trainer = new Trainer({ library, engine: new FakeEngine(jumpWhenClose), openBrowser: (): GameBrowser => new FakeGame(), trainer: { command: "claude", model: "opus" } });
        const best: Profile = fakeProfile({ teacher: "function teach() { return 'NOOP'; }" });
        const candidate = (reply: string, decider?: Decider): Profile =>
            (trainer as any).candidateFrom(parseJsonObject(reply), best, { gameId: "fake-runner", iterations: 1, workDir: root, ...(decider ? { decider } : {}) });
        // The engine decides: new rules in words, a new extractor or new actions leave it out (the teacher writer writes one again).
        expect(candidate(tunerReply({ instructions: "Jump when dx is below 30." })).teacher).toBeUndefined();
        expect(candidate(tunerReply({ extractor: `${RUNNER_EXTRACTOR}\n` })).teacher).toBeUndefined();
        expect(candidate(tunerReply({ actions: [{ id: "NOOP", description: "Keep running", keys: [] }, { id: "JUMP", description: "Jump", keys: ["ArrowUp"] }] })).teacher).toBeUndefined();
        // Only the timing changed: it still holds.
        expect(candidate(tunerReply({ tickMs: 32 })).teacher).toBe(best.teacher);
        // The rules decide: it played the candidate's games, so it stays with them.
        expect(candidate(tunerReply({ instructions: "Jump when dx is below 30." }), Decider.RULES).teacher).toBe(best.teacher);
        // One the reply wrote is the candidate's when the rules decide: it is what plays.
        expect(candidate(tunerReply({ teacher: "function teach() { return 'JUMP'; }" }), Decider.RULES).teacher).toBe("function teach() { return 'JUMP'; }");
        // The engine decides: one in the reply is ignored, the teacher is only ever inherited — a copied-back one over a
        // new extractor is not kept.
        expect(candidate(tunerReply({ teacher: "function teach() { return 'JUMP'; }" })).teacher).toBe(best.teacher);
        expect(candidate(tunerReply({ extractor: `${RUNNER_EXTRACTOR}\n`, teacher: best.teacher })).teacher).toBeUndefined();
    });

    it("with the engine deciding, shows the tuner no teacher and keeps none it copied back over a new extractor", async (): Promise<void> => {
        const taught: string = "function teach() { return 'NOOP'; }";
        library.saveProfile("fake-runner", { ...fakeProfile({ instructions: "Always choose NOOP.", teacher: taught }) } as never);
        const prompts: string[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine: instructionsEngine(),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                // New rules and a new extractor, and v1's teacher copied back as if from the profile shown.
                return tunerReply({ extractor: `${RUNNER_EXTRACTOR}\n`, teacher: taught });
            },
        }).train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work") });
        expect(prompts[0]).not.toContain(taught);
        expect(result.savedVersions).toEqual([2]);
        // Kept for its score, without a teacher written for v1's state: the teacher writer writes one where it is needed.
        expect(library.profile("fake-runner", 2)?.teacher).toBeUndefined();
    });

    it("asks the regression tests' choices of the rules without the latency real time trains for: offline it only waits", async (): Promise<void> => {
        const rule: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const best: Profile = library.saveProfile("fake-runner", { ...fakeProfile({ teacher: rule }) } as never);
        // A saved window of the runner's frames, and a new test asking the choice on each after the warm-up (8 of them).
        const game: FakeGame = new FakeGame();
        const frames: unknown[] = [];
        for (let i: number = 0; i < 11; i++) {
            await game.step({ advanceMs: 100 });
            frames.push(game.raw());
        }
        library.saveWindow("fake-runner", { id: "w1", profileVersion: 1, rawFrames: frames });
        const trainer: Trainer = new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> =>
                tunerReply({ teacher: rule, newTests: [{ window: "w1", ticks: "all", needsChoice: true, expect: "choice === 'NOOP' || choice === 'JUMP'", why: "a choice" }] }),
        });
        const workDir: string = path.join(root, "work");
        mkdirSync(workDir, { recursive: true });
        const played = { result: { mean: 0, episodes: [], decisions: 0, extractErrors: 0, adviceFieldsDropped: 0, stopped: false }, evidence: { mean: 0, extractErrors: 0, adviceFieldsDropped: 0, episodes: [] }, failures: [] };
        const started: number = Date.now();
        // Real real time, the rules answering 1 s late in its games: 8 choices answered so would take 8 s.
        const tuned: { newTests: unknown[] } = await (trainer as any).tune(library.game("fake-runner"), best, played, undefined, [], 3, undefined, {
            gameId: "fake-runner",
            decider: Decider.RULES,
            iterations: 1,
            realtime: true,
            latency: { minMs: 1_000, maxMs: 1_000 },
            workDir,
        });
        expect(tuned.newTests).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("reports the version the teacher writer saves as every save is reported (the run's versions, the library view)", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const right: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const reported: number[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> =>
                prompt.startsWith("You are writing the TEACHER") ? JSON.stringify({ teacher: right, notes: "the rules as code" }) : tunerReply({ teacher: right }),
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, workDir: path.join(root, "work"), hooks: { onSaved: (p: Profile): number => reported.push(p.version) } });
        expect(library.profile("fake-runner", 2)).toMatchObject({ origin: "teacher", teacher: right });
        expect(reported[0]).toBe(2);
        expect(reported).toEqual(result.savedVersions);
    });

    it("opens every game it plays with the game's own perception script", async (): Promise<void> => {
        library.saveGame(
            fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2], perception: { adapter: Perception.CUSTOM, script: "perceive.js", read: "window.perceived" } })
        );
        library.writeFile("fake-runner", "perceive.js", "window.perceived = [];");
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const browsers: FakeGame[] = [];
        await new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => {
                const b: FakeGame = new FakeGame();
                browsers.push(b);
                return b;
            },
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => tunerReply({ analysis: "unchanged" }),
        }).train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work") });
        const opened: OpenRequest[] = browsers.flatMap((b: FakeGame): OpenRequest[] => b.opened);
        // The version measured, its unseen seeds, its random floor, the candidate's games.
        expect(opened.length).toBeGreaterThanOrEqual(9);
        expect(opened.every((r: OpenRequest): boolean => r.initScripts?.[0] === "window.perceived = [];")).toBe(true);
    });
});

describe("Trainer for real time simulated, the engine deciding", (): void => {
    it("tells the tuner the lag the games are played at, not a hosted engine's", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-train-simulated-engine-"));
        try {
            const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
            library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 2, episodes: 1 }, trainSeeds: [1] }));
            library.saveProfile("fake-runner", { ...fakeProfile() } as never);
            const prompts: string[] = [];
            await new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser: (): GameBrowser => new RealtimeFakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return tunerReply();
                },
            }).train({ gameId: "fake-runner", iterations: 1, realtime: true, simulated: true, latency: { minMs: 20, maxMs: 40 }, workDir: path.join(root, "work") });
            // Each decision lands exactly the lag after its frame: no step on top, as there is in real time.
            expect(prompts[0]).toContain("takes effect 20–40 ms later (the engine's time)");
            expect(prompts[0]).not.toContain("285 ms");
            expect(prompts[0]).toContain("decideOn and maxHoldMs are not used");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/** The runner's right rule as code. */
const RIGHT_RULES: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";

/** The fake runner, its end screens saved as the screenshot tool names them: to the second, all games alike. */
class ShotGame extends FakeGame {
    override async screenshot(...[dir, name]: string[]): Promise<string | undefined> {
        const file: string = path.join(dir, `${name}-20260930-120000.png`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, `${name}\n`);
        return file;
    }
}

describe("Trainer: what fails, and where it is recorded", (): void => {
    let root: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-train-fails-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("with the rules deciding, keeps no version whose teacher failed on a state of its games, and tells the log and the tuner why", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
        // Jumps when close as the right rule does (so it scores higher), but throws once in the air.
        const throwing: string = "function teach(s) { if (s.air) { throw new Error('BOOM in the air'); } return s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const prompts: string[] = [];
        const log: string[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine: new FakeEngine((): string => "NOOP"),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return tunerReply({ teacher: prompts.length === 1 ? throwing : RIGHT_RULES });
            },
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 2, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        // Its games, then why it was not kept — as a play that failed, which the run's progress reads.
        expect(log.some((l: string): boolean => /^ {2}iteration 1: mean .* \| invalid answers [1-9]\d* \(the first: BOOM in the air\)$/.test(l))).toBe(true);
        expect(log.some((l: string): boolean => /^ {2}playing it failed: its teacher failed on \d+ states in its games \(the first: BOOM in the air\)$/.test(l))).toBe(true);
        expect(result.history[1]).toMatchObject({ kept: false, note: expect.stringMatching(/^NOT KEPT: its teacher failed on \d+ states in its games/) });
        // The next tuner reads why, and in its games' evidence how often and with what error.
        expect(prompts[1]).toMatch(/NOT KEPT: its teacher failed on \d+ states in its games \(the first: BOOM in the air\): teach\(state\) must answer every state/);
        expect(prompts[1]).toMatch(/"invalidAnswers":[1-9]\d*,"firstInvalidAnswer":"BOOM in the air"/);
        // The version the next reply wrote answers every state: kept.
        expect(result.savedVersions).toEqual([2]);
        expect(library.profile("fake-runner", 2)?.teacher).toBe(RIGHT_RULES);
    });

    it("fails an iteration, not the training, when a candidate's games fail after its first ones (a DevTools timeout)", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ instructions: "Always choose NOOP." }) } as never);
        let unseen: number = 0;
        /** The first game on an unseen seed (the start's) plays; later ones time out. */
        class TimingOut extends FakeGame {
            override async open(request: OpenRequest): Promise<OpenResult> {
                if (request.seed === 1001 && ++unseen > 1) {
                    throw new Error("the DevTools call timed out");
                }
                return super.open(request);
            }
        }
        const log: string[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine: instructionsEngine(),
            openBrowser: (): GameBrowser => new TimingOut(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => tunerReply(),
        }).train({ gameId: "fake-runner", iterations: 2, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        // Each candidate beat v1 and failed on the unseen seeds: two failed iterations, and training ends as it does.
        expect(result).toMatchObject({ savedVersions: [], stopped: false });
        expect(log.filter((l: string): boolean => /^ {2}playing it failed: the DevTools call timed out$/.test(l))).toHaveLength(2);
        expect(result.history.slice(1)).toEqual([
            { mean: null, note: "crashed: the DevTools call timed out" },
            { mean: null, note: "crashed: the DevTools call timed out" },
        ]);
    });

    it("fails an iteration with the engine's error, asking the tuner for no repair, when the engine cannot be reached while a regression test asks it for a decision", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ tests: [] }) } as never);
        library.saveWindow("fake-runner", { id: "w1", profileVersion: 1, rawFrames: [[], [], [], [], []] });
        // It plays every game; asked about the window's frames (nothing drawn: no obstacle), it is down.
        const down: string = "jev: connection to https://api.typesafe.ai/v1/systemone failed; no action executed";
        const playing: FakeEngine = new FakeEngine(jumpWhenClose);
        const engine: DecisionEngine = {
            kind: playing.kind,
            label: "jev",
            ask: async (state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> => {
                if ((state as { game: { dx: number | null } }).game.dx === null) {
                    throw new DecisionEngineError(down);
                }
                return playing.ask(state, questions);
            },
            health: playing.health.bind(playing),
        };
        const prompts: string[] = [];
        const log: string[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine,
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return tunerReply({ newTests: [{ window: "w1", ticks: [4], needsChoice: true, expect: "choice === 'NOOP'", why: "nothing close: no jump" }] });
            },
        }).train({ gameId: "fake-runner", iterations: 1, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        // Its test failed only because no decision came: no repair round (it once was one), and the iteration fails with the reason.
        expect(prompts).toHaveLength(1);
        // Logged as playing it that failed, not the tuner: the tuner answered.
        expect(log).toContain(`  playing it failed: ${down}`);
        expect(result.savedVersions).toEqual([]);
        expect(result.history.at(-1)).toEqual({ mean: null, note: `playing failed: ${down}` });
    });

    it("tells the player the engine's time while the engine decides in real time, the rules' when they do", (): void => {
        const trainer: Trainer = new Trainer({ library, engine: new FakeEngine(jumpWhenClose), openBrowser: (): GameBrowser => new FakeGame(), trainer: { command: "claude", model: "opus" } });
        const options = (more: Partial<TrainOptions>): TrainOptions => ({ gameId: "fake-runner", iterations: 1, workDir: root, realtime: true, ...more });
        const pace = (more: Partial<TrainOptions>): unknown => (trainer as any).paceOf(options(more));
        // The engine deciding: its own time, as the tuner is told (the step that lands the input on top of it).
        expect(pace({})).toEqual({ pace: Pace.REALTIME, expectedLagMs: 280, minLagMs: 0 });
        expect(pace({ latency: { minMs: 20, maxMs: 40 } })).toEqual({ pace: Pace.REALTIME, expectedLagMs: 280, minLagMs: 0 });
        expect((trainer as any).realtimeTraining(options({})).minMs).toBe(285);
        // The rules deciding: as late as they answer.
        expect(pace({ decider: Decider.RULES, latency: { minMs: 250, maxMs: 600 } })).toEqual({ pace: Pace.REALTIME, expectedLagMs: 425, minLagMs: 0 });
        expect(pace({ decider: Decider.RULES })).toEqual({ pace: Pace.REALTIME, expectedLagMs: 30, minLagMs: 0 });
        // Simulated, whatever decides: the lag it is played at.
        expect(pace({ simulated: true, latency: { minMs: 20, maxMs: 40 } })).toEqual({ pace: Pace.TURN, simulatedLag: { minMs: 20, maxMs: 40 } });
        expect(pace({ realtime: false })).toEqual({ pace: Pace.TURN });
    });

    it("sets a game up with no teacher while the engine decides, whatever the reply holds", async (): Promise<void> => {
        const trainer = (decider?: Decider): Trainer =>
            new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> =>
                    prompt.startsWith("You are setting up")
                        ? JSON.stringify({
                            extractor: RUNNER_EXTRACTOR,
                            actions: [
                                { id: "NOOP", description: "Keep running", keys: [] },
                                { id: "JUMP", description: "Jump", keys: ["Space"] },
                            ],
                            notes: "Jump when dx is between 10 and 40 and air is false.",
                            tickMs: 20,
                            // Not asked for with the engine deciding, and never checked then.
                            teacher: RIGHT_RULES,
                        })
                        : tunerReply({ teacher: RIGHT_RULES }),
            });
        await trainer().train({ gameId: "fake-runner", iterations: 0, workDir: path.join(root, "work") });
        expect(library.profile("fake-runner", 1)?.teacher).toBeUndefined();
        library.removeUserPart("fake-runner");
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
        await trainer(Decider.RULES).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 0, workDir: path.join(root, "work-rules") });
        expect(library.profile("fake-runner", 1)?.teacher).toBe(RIGHT_RULES);
    });

    it("checks the teacher it writes first against the engine's logged decisions, when the version has some", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const logged: DecisionLog = new DecisionLog(library, "fake-runner", v1, "engine");
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({
            game: library.game("fake-runner"),
            profile: v1,
            episodes: 1,
            gameSeconds: 3,
            pace: Pace.TURN,
            hooks: { onDecision: (d): void => logged.append(d) },
        });
        const prompts: string[] = [];
        const log: string[] = [];
        await new Trainer({
            library,
            engine: new FakeEngine(jumpWhenClose),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return JSON.stringify({ teacher: RIGHT_RULES, notes: "the rules as code" });
            },
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 0, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        // The states it is shown are the engine's, with what the engine chose; it is checked against them.
        expect(prompts[0]).toContain("with the action the reference engine chose applying the instructions");
        expect(prompts[0]).toMatch(/JUMP <- \{/);
        expect(log.some((l: string): boolean => /agreement with the engine's \d+ logged decisions: 100\.0% balanced/.test(l))).toBe(true);
        expect(library.profile("fake-runner", 2)).toMatchObject({ origin: "teacher", teacher: RIGHT_RULES });
    });

    it("trained for real time, records the unseen seeds' real-time scores beside the real-time ones, and leaves `test` to a paused measurement", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
        await new Trainer({
            library,
            engine: new FakeEngine((): string => "NOOP"),
            openBrowser: (): GameBrowser => new FakeGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => tunerReply({ teacher: RIGHT_RULES }),
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, realtime: true, simulated: true, latency: { minMs: 20, maxMs: 20 }, workDir: path.join(root, "work") });
        for (const version of [1, 2]) {
            const results: Profile["results"] = library.profile("fake-runner", version)?.results;
            expect(results?.realtime?.test).toMatchObject({ seeds: [1001, 2002, 3003], scores: [expect.any(Number), expect.any(Number), expect.any(Number)] });
            expect(results?.test).toBeUndefined();
        }
    });

    it("reports a candidate's games under the number it would be saved as, and names every end screen for its game in folders the UI serves", async (): Promise<void> => {
        for (const teacher of ["function teach() { return 'NOOP'; }", "function teach() { return 'NOOP'; }", RIGHT_RULES]) {
            library.saveProfile("fake-runner", { ...fakeProfile({ teacher }) } as never);
        }
        // Training from v2, the active version, while v3 exists: a candidate is v4.
        library.setActive("fake-runner", 2);
        const reported: Array<number | undefined> = [];
        const workDir: string = path.join(root, "work");
        const result: TrainResult = await new Trainer({
            library,
            engine: new FakeEngine((): string => "NOOP"),
            openBrowser: (): GameBrowser => new ShotGame(),
            trainer: { command: "claude", model: "opus" },
            ask: async (): Promise<string> => tunerReply({ teacher: RIGHT_RULES }),
        }).train({
            gameId: "fake-runner",
            decider: Decider.RULES,
            iterations: 1,
            realtime: true,
            simulated: true,
            latency: { minMs: 20, maxMs: 20 },
            workDir,
            hooks: { onEpisodeEnd: (_: EpisodeResult, version: number | undefined): number => reported.push(version) },
        });
        expect(result.savedVersions).toEqual([4]);
        expect([...new Set(reported)]).toEqual([2, 4]);
        // One folder per evaluation, no spaces (the run-file route's pattern), each game's end screen its own.
        const folders: string[] = readdirSync(workDir).filter((f: string): boolean => f.startsWith("shots-")).sort();
        expect(folders).toEqual(["shots-it1", "shots-it1-paused", "shots-v2", "shots-v2-paused"]);
        for (const folder of folders) {
            expect(readdirSync(path.join(workDir, folder)).sort()).toEqual(["episode-1-seed1-end-20260930-120000.png", "episode-1-seed2-end-20260930-120000.png"]);
        }
    });

    it("with the rules deciding, keeps a better candidate whose games met a page read that failed: a frame with no state is not its teacher's", async (): Promise<void> => {
        /** The fake runner, its 20th page read failing (a DevTools hiccup): that frame has no state. */
        class OneBadRead extends FakeGame {
            private reads: number = 0;
            override async step(request: StepRequest): Promise<StepResult> {
                const result: StepResult = await super.step(request);
                return request.observe !== false && ++this.reads === 20 ? { ...result, readError: "Target page, context or browser has been closed" } : result;
            }
        }
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
        // The right rule, reading a field every state the extractor makes has — a frame with no state has none.
        const reading: string = "function teach(s) { var frames = s.seenFrames.toFixed(0); return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const prompts: string[] = [];
        const log: string[] = [];
        const result: TrainResult = await new Trainer({
            library,
            engine: new FakeEngine((): string => "NOOP"),
            openBrowser: (): GameBrowser => new OneBadRead(),
            trainer: { command: "claude", model: "opus" },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return tunerReply({ teacher: reading });
            },
        }).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 1, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => log.push(l) } });
        // 30 against 10, one read failing in each game: kept, the frames counted as extractor errors with why.
        expect(result.savedVersions).toEqual([2]);
        expect(
            log.some((l: string): boolean =>
                /^ {2}iteration 1: mean 30\.0 .*\| extractor errors 2 \(the first: reading the page failed: Target page, context or browser has been closed\) \|.*\| invalid answers 0$/.test(l)
            )
        ).toBe(true);
        // The tuner reads why in the evidence, and that such a frame is never the teacher's to answer.
        expect(prompts[0]).toMatch(/"firstExtractError":"reading the page failed: Target page/);
        expect(prompts[0]).toContain("counts as an extractor error, not as the teacher failing");
        // And the teacher's time, from the sandbox's limit.
        expect(prompts[0]).toContain(`It has ${CALL_TIMEOUT_MS} ms a call`);
    });

    it("with the rules deciding, sets a game up with a teacher that answers every sample state: one that fails is repaired once, told the errors and the states", async (): Promise<void> => {
        const failing: string = "function teach(state) { return state.player.dx > 1 ? 'JUMP' : 'NOOP'; }";
        const prompts: string[] = [];
        const trainer = (repaired: string): Trainer =>
            new Trainer({
                library,
                engine: new FakeEngine(jumpWhenClose),
                openBrowser: (): GameBrowser => new FakeGame(),
                trainer: { command: "claude", model: "opus" },
                ask: async (prompt: string): Promise<string> => {
                    prompts.push(prompt);
                    return prompt.startsWith("You are setting up")
                        ? JSON.stringify({
                            extractor: RUNNER_EXTRACTOR,
                            actions: [
                                { id: "NOOP", description: "Keep running", keys: [] },
                                { id: "JUMP", description: "Jump", keys: ["Space"] },
                            ],
                            notes: "Jump when dx is between 10 and 40 and air is false.",
                            tickMs: 20,
                            teacher: failing,
                        })
                        : JSON.stringify({ teacher: repaired, notes: "the rules as code" });
                },
            });
        await trainer(RIGHT_RULES).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 0, workDir: path.join(root, "work") });
        expect(prompts[0]).toContain(`It has ${CALL_TIMEOUT_MS} ms a call`);
        // Its teacher threw on the states the extractor made of the frames sampled: repaired once, then saved.
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("IT FAILS ON STATES IT IS GIVEN");
        expect(prompts[1]).toMatch(/Cannot read properties of undefined \(reading 'dx'\) : \{"dx":/);
        expect(library.profile("fake-runner", 1)?.teacher).toBe(RIGHT_RULES);
        // A repair that still fails: no first version.
        library.removeUserPart("fake-runner");
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 3, episodes: 1 }, trainSeeds: [1, 2] }));
        await expect(trainer(failing).train({ gameId: "fake-runner", decider: Decider.RULES, iterations: 0, workDir: path.join(root, "work-2") })).rejects.toThrow(
            /the teacher still fails on \d+ of the \d+ sample states: Cannot read properties of undefined \(reading 'dx'\)/
        );
        expect(library.profiles("fake-runner")).toEqual([]);
        // Nor is its answer kept: it made no profile.
        expect(library.file("fake-runner", "samples/setup.json")).toBeUndefined();
        expect(existsSync(path.join(root, "work-2", "setup.json"))).toBe(false);
    });

    it("rounds and clamps a tickMs the tuner wrote, as the setup's, rather than failing the iteration on it", (): void => {
        const trainer: Trainer = new Trainer({ library, engine: new FakeEngine(jumpWhenClose), openBrowser: (): GameBrowser => new FakeGame(), trainer: { command: "claude", model: "opus" } });
        const tickOf = (tickMs: unknown): number =>
            ((trainer as any).candidateFrom(parseJsonObject(tunerReply({ tickMs })), fakeProfile({ tickMs: 32 }), { gameId: "fake-runner", iterations: 1, workDir: root }) as Profile).tickMs;
        expect(tickOf(16.7)).toBe(17);
        expect(tickOf(3)).toBe(16);
        expect(tickOf(9_000)).toBe(500);
        // Not a number: the best version's.
        expect(tickOf("fast")).toBe(32);
    });

    it("rounds and clamps a maxHoldMs the tuner wrote into the range a profile takes, rather than failing the iteration on it", (): void => {
        const trainer: Trainer = new Trainer({ library, engine: new FakeEngine(jumpWhenClose), openBrowser: (): GameBrowser => new FakeGame(), trainer: { command: "claude", model: "opus" } });
        const holdOf = (maxHoldMs: unknown, best?: number): number | undefined =>
            (
                (trainer as any).candidateFrom(parseJsonObject(tunerReply({ maxHoldMs })), fakeProfile(best !== undefined ? { maxHoldMs: best } : {}), {
                    gameId: "fake-runner",
                    iterations: 1,
                    workDir: root,
                }) as Profile
            ).maxHoldMs;
        // Whole, as the tick; out of the range the validation takes (as written, the iteration failed), clamped into it.
        expect(holdOf(412.6)).toBe(413);
        expect(holdOf(2)).toBe(10);
        expect(holdOf(60_000)).toBe(10_000);
        // Not a number: the best version's, and none when it has none.
        expect(holdOf("long", 800)).toBe(800);
        expect(holdOf(undefined)).toBeUndefined();
    });
});
