import { LatencyRange, latencyAt, RandomPlayer, RulesTeacher, seededRandom, TeacherLabel } from "../../../src/distill/teacher";
import { EngineKind } from "../../../src/engine";
import { GameBrowser } from "../../../src/devtools/client";
import { OpenRequest, StepRequest, StepResult } from "../../../src/devtools/protocol";
import { Perception, Profile } from "../../../src/game/types";
import { Library } from "../../../src/library/store";
import { Pace, Player, PlayResult } from "../../../src/play/player";
import { CALL_TIMEOUT_MS, ScriptError, Teacher } from "../../../src/play/sandbox";
import { DecisionLog, DecisionRow } from "../../../src/run/decision-log";
import { teacherPrompt, TeacherWriter } from "../../../src/train/teacher-writer";
import { FakeEngine, jumpWhenClose } from "../../helpers/fake-engine";
import { fakeGameDefinition, FakeGame, fakeProfile } from "../../helpers/fake-game";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** The fake runner's right rule, as a teacher. */
const RIGHT: string = "function teach(state) { return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";

/** The fake runner with every 10th page read failing: those frames have no state (`{ extractorError }`). */
class FlakyReads extends FakeGame {
    private reads: number = 0;

    override async step(request: StepRequest): Promise<StepResult> {
        const result: StepResult = await super.step(request);
        return request.observe !== false && ++this.reads % 10 === 0 ? { ...result, readError: "the page was busy" } : result;
    }
}

describe("Teacher", (): void => {
    it("labels a state: an action id as all the probability, probabilities normalised", (): void => {
        const t: Teacher = new Teacher("function teach(s) { return s.x > 1 ? 'JUMP' : { NOOP: 3, JUMP: 1, OTHER: 5 }; }", ["NOOP", "JUMP"]);
        expect(t.label({ x: 2 })).toEqual({ NOOP: 0, JUMP: 1 });
        expect(t.label({ x: 0 })).toEqual({ NOOP: 0.75, JUMP: 0.25 });
    });

    it("refuses an answer that is not an action", (): void => {
        expect((): unknown => new Teacher("function teach() { return 'FLY'; }", ["NOOP"]).label({})).toThrow(ScriptError);
        expect((): unknown => new Teacher("function teach() { return { NOOP: 0 }; }", ["NOOP"]).label({})).toThrow(/neither/);
        expect((): unknown => new Teacher("42", ["NOOP"])).toThrow(/not a function/);
    });
});

describe("RulesTeacher", (): void => {
    it("plays like the rules and records every label", async (): Promise<void> => {
        const labels: TeacherLabel[] = [];
        const teacher: RulesTeacher = new RulesTeacher(fakeProfile({ teacher: RIGHT }), { onLabel: (l: TeacherLabel): number => labels.push(l) });
        const result: PlayResult = await new Player(new FakeGame(), teacher).play({
            game: fakeGameDefinition(),
            profile: fakeProfile({ teacher: RIGHT }),
            episodes: 1,
            gameSeconds: 3,
            pace: Pace.TURN,
        });
        expect(result.episodes[0].over).toBe(false);
        expect(labels.length).toBe(result.decisions);
        expect(labels.some((l: TeacherLabel): boolean => l.choice === "JUMP")).toBe(true);
        expect(labels[0]).toMatchObject({ criteria: { NOOP: "Keep running", JUMP: "Jump" }, probabilities: { NOOP: 1, JUMP: 0 } });
    });

    it("answers each moment of a plan from the state predicted for it, the present for any other question", async (): Promise<void> => {
        const teacher: RulesTeacher = new RulesTeacher(fakeProfile({ teacher: RIGHT }));
        const q = { type: "choice" as const, criteria: { NOOP: "Keep running", JUMP: "Jump" }, instructions: {} };
        const game = { dx: 200, air: false, slots: [{ dx: 60, air: false }, { dx: 30, air: false }, { dx: 30, air: true }] };
        const response = await teacher.ask({ game }, { slot1: q, slot2: q, slot3: q, action: q });
        const choices: Record<string, string> = Object.fromEntries(Object.entries(response.answers).map(([id, a]: [string, unknown]): [string, string] => [id, (a as { choice: string }).choice]));
        expect(choices).toEqual({ slot1: "NOOP", slot2: "JUMP", slot3: "NOOP", action: "NOOP" });
    });

    it("is an engine of its own kind: the rules as code can play a game when chosen", (): void => {
        const teacher: RulesTeacher = new RulesTeacher(fakeProfile({ teacher: RIGHT }));
        expect(teacher.kind).toBe(EngineKind.RULES);
        expect(teacher.label).toBe("rules v1");
    });

    it("answers late when asked to, as the small model it teaches would (training for real time)", async (): Promise<void> => {
        const teacher: RulesTeacher = new RulesTeacher(fakeProfile({ teacher: RIGHT }), { latency: { minMs: 40, maxMs: 40 } });
        const started: number = Date.now();
        await teacher.ask({ game: { dx: 20, air: false } }, { action: { type: "choice", criteria: { NOOP: "run", JUMP: "jump" }, instructions: {} } });
        expect(Date.now() - started).toBeGreaterThanOrEqual(38);
    });

    it("answers within a latency range that differs from game to game and drifts within one", (): void => {
        const range: LatencyRange = { minMs: 250, maxMs: 600 };
        const starts: number[] = [1, 2, 3, 4, 5].map((seed: number): number => latencyAt({ ...range, seed }, 0));
        expect(new Set(starts.map((ms: number): number => Math.round(ms))).size).toBeGreaterThan(3);
        const game: number[] = Array.from({ length: 40 }, (_: unknown, i: number): number => latencyAt({ ...range, seed: 7 }, i * 500));
        expect(Math.min(...game)).toBeGreaterThanOrEqual(250);
        expect(Math.max(...game)).toBeLessThanOrEqual(600);
        // It drifts: the same game is not answered at one latency throughout.
        expect(Math.max(...game) - Math.min(...game)).toBeGreaterThan(100);
        expect(latencyAt({ ...range, seed: 7 }, 1234)).toBe(latencyAt({ ...range, seed: 7 }, 1234));
    });

    it("explores: random moves are played, the recorded labels stay the teacher's", async (): Promise<void> => {
        const labels: TeacherLabel[] = [];
        let n: number = 0;
        const teacher: RulesTeacher = new RulesTeacher(fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }), {
            epsilon: 1,
            random: (): number => (n++ % 2 === 0 ? 0 : 0.99),
            onLabel: (l: TeacherLabel): number => labels.push(l),
        });
        const answer: any = await teacher.ask({ game: {} }, { action: { type: "choice", criteria: { NOOP: "a", JUMP: "b" }, instructions: "x" } });
        expect(answer.answers.action).toEqual({ choice: "JUMP", probabilities: { NOOP: 0, JUMP: 1 }, confidence: 1 });
        expect(labels[0].probabilities).toEqual({ NOOP: 1, JUMP: 0 });
    });

    it("draws random numbers from a seed: the same seed, the same moves (random play's as before)", async (): Promise<void> => {
        const draw = (seed: number): number[] => {
            const next: () => number = seededRandom(seed);
            return Array.from({ length: 5 }, (): number => next());
        };
        expect(draw(20_000)).toEqual(draw(20_000));
        expect(draw(20_000)).not.toEqual(draw(20_001));
        expect(draw(1).every((x: number): boolean => x >= 0 && x < 1)).toBe(true);
        // Random play's moves on a seed are the ones recorded floors were measured with.
        const player: RandomPlayer = new RandomPlayer(7);
        const q = { type: "choice" as const, criteria: { NOOP: "a", JUMP: "b", LEFT: "c" }, instructions: {} };
        const moves: string[] = [];
        for (let i: number = 0; i < 12; i++) {
            moves.push(((await player.ask({ game: {} }, { action: q })).answers.action as { choice: string }).choice);
        }
        expect(moves).toEqual(["LEFT", "JUMP", "NOOP", "NOOP", "LEFT", "JUMP", "LEFT", "NOOP", "NOOP", "LEFT", "LEFT", "NOOP"]);
    });
});

describe("TeacherWriter", (): void => {
    let root: string;
    let library: Library;
    const openBrowser: () => GameBrowser = (): GameBrowser => new FakeGame();

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-teacher-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ trainSeeds: [1, 2] }));
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("writes the teacher, checks it against logged decisions and by playing, repairs once, saves a new version", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", {
            ...fakeProfile(),
            results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        // The engine's decisions, applying the instructions.
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v1, "engine");
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({
            game: fakeGameDefinition(),
            profile: v1,
            episodes: 1,
            gameSeconds: 3,
            pace: Pace.TURN,
            hooks: { onDecision: (d): void => log.append(d) },
        });
        const prompts: string[] = [];
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser,
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                // First a teacher that never jumps, then the right one.
                return JSON.stringify({ teacher: prompts.length === 1 ? "function teach() { return 'NOOP'; }" : RIGHT, notes: "n" });
            },
        });
        const lines: string[] = [];
        const { profile, check } = await writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, {
            decisionLog: log.file,
            workDir: root,
            log: (l: string): number => lines.push(l),
        });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain("function teach(state)");
        expect(prompts[0]).toMatch(/JUMP <- \{/);
        expect(prompts[1]).toContain("IT DISAGREES WITH THE REFERENCE ENGINE HERE");
        expect(check.agreement).toBe(1);
        expect(check.scores).toEqual([30, 30]);
        expect(profile).toMatchObject({ version: 2, parent: 1, origin: "teacher", teacher: RIGHT });
        expect(library.activeVersion("fake-runner")).toBe(2);
    });

    it("reads the engine's logged decisions past a row cut short — one the next row went on after, or the last line —, saying so once, naming the log", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v1, "engine");
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({ game: fakeGameDefinition(), profile: v1, episodes: 1, gameSeconds: 3, pace: Pace.TURN, hooks: { onDecision: (d): void => log.append(d) } });
        const rows: string[] = readFileSync(log.file, "utf-8").trim().split("\n");
        // The sixth row cut short, the seventh after its bytes on its line; and a row cut short at the end.
        writeFileSync(log.file, `${[...rows.slice(0, 5), `${rows[5].slice(0, 40)}${rows[6]}`, ...rows.slice(7)].join("\n")}\n${rows[0].slice(0, 30)}`);
        const said: string[] = [];
        const { check } = await new TeacherWriter({ library, openBrowser, ask: async (): Promise<string> => JSON.stringify({ teacher: RIGHT, notes: "n" }) }).write(
            fakeGameDefinition({ trainSeeds: [1, 2] }),
            v1,
            { decisionLog: log.file, workDir: root, log: (l: string): number => said.push(l) }
        );
        // It once failed at the first of them with "Unexpected end of JSON input" (or another SyntaxError), naming no file.
        expect(check).toMatchObject({ agreement: 1, checkedRows: rows.length - 2 });
        expect(said.filter((l: string): boolean => l.includes(" no row "))).toEqual([
            expect.stringMatching(new RegExp(`^ {2}skipped 2 lines of ${log.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} that are no row \\(the first: .+\\) — a row cut short by a write that failed$`)),
        ]);
    });

    it("shows a repair a dozen of the states its teacher fails on, however its error text varies, in 30,000 characters at most", (): void => {
        const writer: TeacherWriter = new TeacherWriter({ library, openBrowser, ask: async (): Promise<string> => "" });
        // Its error text differs from state to state: every state it fails on a kind of error of its own.
        const teacher: string = "function teach(s) { throw new Error('no rule for ' + JSON.stringify(s)); }";
        const states: Array<{ n: number; text: string }> = Array.from({ length: 500 }, (_: unknown, n: number): { n: number; text: string } => ({ n, text: "x".repeat(3_000) }));
        const failed: ReturnType<TeacherWriter["failures"]> = writer.failures(fakeProfile(), teacher, states, 12);
        expect(failed.count).toBe(500);
        // One of each kind once put all 500 (~3 KB each) in the repair prompt: a dozen, spread over them.
        expect(failed.shown.map((f: { state: unknown }): number => (f.state as { n: number }).n)).toEqual(
            Array.from({ length: 12 }, (_: unknown, k: number): number => Math.floor((k * 500) / 12))
        );
        // However long each is, the list stops at 30,000 characters, as the ends of lost games do.
        const prompt: string = teacherPrompt({ game: fakeGameDefinition(), profile: fakeProfile({ teacher }), samples: [], repair: { current: teacher, failures: failed.shown } });
        const from: number = prompt.indexOf("(error : state):\n") + "(error : state):\n".length;
        expect(prompt.indexOf("\nFix the teacher.", from) - from).toBe(30_000);
        // With fewer kinds than that: as before, each kind's share, the rare ones in full.
        const kinds: ReturnType<TeacherWriter["failures"]> = writer.failures(fakeProfile(), "function teach(s) { throw new Error(s.n % 5 === 0 ? 'rare' : 'common'); }", states.slice(0, 50), 12);
        expect(kinds.shown.map((f: { error: string }): string => f.error)).toEqual([...Array(6).fill("rare"), ...Array(6).fill("common")]);
    });

    it("tells the repair why the teacher it wrote does not compile", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const prompts: string[] = [];
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser,
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                // First a value that is no function, then the right one.
                return JSON.stringify({ teacher: prompts.length === 1 ? "42" : RIGHT, notes: "n" });
            },
        });
        const { profile } = await writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { workDir: root });
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).not.toContain("IT DOES NOT COMPILE");
        expect(prompts[1]).toContain("YOUR PREVIOUS TEACHER:\n42\n");
        expect(prompts[1]).toContain("IT DOES NOT COMPILE: the teacher is not a function");
        expect(profile.teacher).toBe(RIGHT);
    });

    it("tells the repair the error of a teacher that throws on the states it was shown, before it plays", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const browsers: FakeGame[] = [];
        const prompts: string[] = [];
        const opened: number[] = [];
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser: (): GameBrowser => {
                const b: FakeGame = new FakeGame();
                browsers.push(b);
                return b;
            },
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                opened.push(browsers.length);
                // First a teacher reading a field the state does not have (it throws on every state), then the right one.
                return JSON.stringify({ teacher: prompts.length === 1 ? "function teach(state) { return state.player.dx > 1 ? 'JUMP' : 'NOOP'; }" : RIGHT, notes: "n" });
            },
        });
        const { profile } = await writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { workDir: root });
        expect(prompts).toHaveLength(2);
        const repair: string = prompts[1].slice(prompts[1].indexOf("YOUR PREVIOUS TEACHER"));
        expect(repair).toContain("IT FAILS ON STATES IT IS GIVEN");
        // The error and a state it came from, not the empty last ticks of games it could not play.
        expect(repair).toMatch(/Cannot read properties of undefined \(reading 'dx'\) : \{"dx":/);
        expect(repair).not.toContain('"lastTicks":[]');
        // Found on the states it was shown (one sampling game), before any game of its own.
        expect(opened).toEqual([1, 1]);
        expect(profile.teacher).toBe(RIGHT);
    });

    it("requires its own games to fail on no state, and says where they did — also when the profile has no score", async (): Promise<void> => {
        // No recorded score: before, its own games checked nothing then.
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        // Answers every state it was shown (the sampling game never jumps), throws once in the air.
        const airborne: string = "function teach(s) { if (s.air) { throw new Error('BOOM in the air'); } return s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const prompts: string[] = [];
        const lines: string[] = [];
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser,
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return JSON.stringify({ teacher: prompts.length === 1 ? airborne : RIGHT, notes: "n" });
            },
        });
        const { profile } = await writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { workDir: root, log: (l: string): number => lines.push(l) });
        expect(prompts).toHaveLength(2);
        expect(lines.some((l: string): boolean => /the teacher's own games .*; it failed on \d+ of their states/.test(l))).toBe(true);
        expect(prompts[1]).toMatch(/playing by itself it failed on \d+ states, where the last decision stood/);
        expect(prompts[1]).toMatch(/BOOM in the air : \{[^}]*"air":true/);
        expect(profile).toMatchObject({ version: 2, teacher: RIGHT });
    });

    it("saves no teacher that fails on every state, whether or not the profile has a score", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser,
            ask: async (): Promise<string> => JSON.stringify({ teacher: "function teach(state) { return state.player.dx > 1 ? 'JUMP' : 'NOOP'; }", notes: "n" }),
        });
        await expect(writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { workDir: root })).rejects.toThrow(/no teacher passed its checks/);
        expect((): unknown => library.profile("fake-runner", 2)).toThrow(/no profile v2/);
    });

    it("counts a choice the teacher leaves open as agreeing: a tie is no disagreement", (): void => {
        const writer: TeacherWriter = new TeacherWriter({ library, openBrowser, ask: async (): Promise<string> => "" });
        const row = (choice: string): DecisionRow => ({ state: { dx: 20, air: false }, choice } as DecisionRow);
        const tie: string = "function teach() { return { NOOP: 1, JUMP: 1 }; }";
        expect(writer.agreement(fakeProfile(), tie, [row("NOOP"), row("JUMP")])).toMatchObject({ agreement: 1, perAction: { NOOP: "1/1", JUMP: "1/1" }, disagreements: [] });
        expect(writer.agreement(fakeProfile(), "function teach() { return { NOOP: 0.4, JUMP: 0.6 }; }", [row("NOOP"), row("JUMP")])).toMatchObject({
            agreement: 0.5,
            disagreements: [{ expected: "NOOP", teacher: "JUMP" }],
        });
    });

    it("counts the logged states a teacher fails on apart from its disagreements: agreeing with nothing", (): void => {
        const writer: TeacherWriter = new TeacherWriter({ library, openBrowser, ask: async (): Promise<string> => "" });
        const row = (choice: string, state: Record<string, unknown>): DecisionRow => ({ state, choice } as DecisionRow);
        const teacher: string = "function teach(s) { if (s.night) { throw new Error('no rule at night'); } return s.dx < 30 ? 'JUMP' : 'NOOP'; }";
        const a = writer.agreement(fakeProfile(), teacher, [row("JUMP", { dx: 20 }), row("NOOP", { dx: 20 }), row("NOOP", { dx: 20, night: true })]);
        expect(a.errors).toEqual([{ state: { dx: 20, night: true }, error: "no rule at night" }]);
        expect(a.disagreements).toEqual([{ state: { dx: 20 }, expected: "NOOP", teacher: "JUMP" }]);
        expect(a.perAction).toEqual({ JUMP: "1/1", NOOP: "0/2" });
    });

    it("requires the teacher to answer every state the engine logged: one that throws on a few is repaired with them, not passed as disagreements", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v1, "engine");
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({ game: fakeGameDefinition(), profile: v1, episodes: 1, gameSeconds: 3, pace: Pace.TURN, hooks: { onDecision: (d): void => log.append(d) } });
        // A phase its own games never reach, logged by the engine (three NOOP rows the 40 sample states skip): 2 % of them.
        let noop: number = -1;
        const lines: string[] = readFileSync(log.file, "utf-8").trim().split("\n");
        writeFileSync(
            log.file,
            `${lines
                .map((l: string): string => {
                    const r: DecisionRow = JSON.parse(l) as DecisionRow;
                    return r.choice === "NOOP" && [1, 3, 5].includes(++noop) ? JSON.stringify({ ...r, state: { ...(r.state as object), phase: "night" } }) : l;
                })
                .join("\n")}\n`
        );
        const throwsAtNight: string = "function teach(s) { if (s.phase === 'night') { throw new Error('night: no rule'); } return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const prompts: string[] = [];
        const said: string[] = [];
        const { profile } = await new TeacherWriter({
            library,
            openBrowser,
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return JSON.stringify({ teacher: prompts.length === 1 ? throwsAtNight : RIGHT, notes: "n" });
            },
        }).write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { decisionLog: log.file, workDir: root, log: (l: string): number => said.push(l) });
        expect(said.some((l: string): boolean => new RegExp(`the teacher fails on 3 of the engine's ${lines.length} logged states: night: no rule`).test(l))).toBe(true);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("IT FAILS ON STATES IT IS GIVEN");
        expect(prompts[1]).toMatch(/night: no rule : \{[^}]*"phase":"night"/);
        expect(profile.teacher).toBe(RIGHT);
    });

    it("never holds a frame with no state against a teacher: not in the logged decisions, nor in its own games", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        // Rows an engine was asked about on frames with no state, before the player stopped asking.
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v1, "engine");
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({ game: fakeGameDefinition(), profile: v1, episodes: 1, gameSeconds: 3, pace: Pace.TURN, hooks: { onDecision: (d): void => log.append(d) } });
        const row: DecisionRow = JSON.parse(readFileSync(log.file, "utf-8").split("\n")[0]) as DecisionRow;
        for (let i: number = 0; i < 20; i++) {
            log.append({ ...row, state: { extractorError: "reading the page failed: the page was busy" } });
        }
        // Reads a field every state the extractor makes has, and throws in the air (its own games), until repaired.
        const reads: string = "function teach(s) { var frames = s.seenFrames.toFixed(0); return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        const airborne: string = reads.replace("var frames", "if (s.air) { throw new Error('BOOM in the air'); } var frames");
        const prompts: string[] = [];
        const said: string[] = [];
        const { profile } = await new TeacherWriter({
            library,
            // Every 10th frame of its own games has no state.
            openBrowser: (): GameBrowser => new FlakyReads(),
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                return JSON.stringify({ teacher: prompts.length === 1 ? airborne : reads, notes: "n" });
            },
        }).write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, { decisionLog: log.file, workDir: root, log: (l: string): number => said.push(l) });
        // Checked against the engine's real decisions only: none of the frames with no state among its samples or its rows.
        expect(prompts[0]).not.toContain('{"extractorError"');
        expect(said.some((l: string): boolean => /agreement with the engine's \d+ logged decisions: 100\.0% balanced/.test(l))).toBe(true);
        expect(said.some((l: string): boolean => /logged states/.test(l))).toBe(false);
        // Its own games: repaired for what it failed on in the air, never for a frame it was not asked about.
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toMatch(/BOOM in the air : \{[^}]*"air":true/);
        expect(prompts[1]).not.toContain("reading 'toFixed'");
        expect(profile.teacher).toBe(reads);
        // The prompt says so, and gives the teacher its time from the sandbox's limit.
        expect(prompts[0]).toContain("counts as an extractor error, not as the teacher failing");
        expect(prompts[0]).toContain(`It has ${CALL_TIMEOUT_MS} ms a call — a call that takes longer fails, as a throw does — so aim for ${Math.round(CALL_TIMEOUT_MS / 10)} ms or less.`);
    });

    it("saves the version it writes without making it active when told, and plays with the game's perception script", async (): Promise<void> => {
        library.saveGame(fakeGameDefinition({ trainSeeds: [1, 2], perception: { adapter: Perception.CUSTOM, script: "perceive.js", read: "window.perceived" } }));
        library.writeFile("fake-runner", "perceive.js", "window.perceived = [];");
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        library.saveProfile("fake-runner", { ...fakeProfile({ tickMs: 32 }) } as never);
        const browsers: FakeGame[] = [];
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser: (): GameBrowser => {
                const b: FakeGame = new FakeGame();
                browsers.push(b);
                return b;
            },
            ask: async (): Promise<string> => JSON.stringify({ teacher: RIGHT, notes: "n" }),
        });
        const { profile } = await writer.write(library.game("fake-runner"), v1, { workDir: root, activate: false });
        expect(profile).toMatchObject({ version: 3, parent: 1, origin: "teacher" });
        expect(library.activeVersion("fake-runner")).toBe(2);
        // The states it was shown and its own games: every page opened with the script.
        const opened: OpenRequest[] = browsers.flatMap((b: FakeGame): OpenRequest[] => b.opened);
        expect(opened).toHaveLength(3);
        expect(opened.every((r: OpenRequest): boolean => r.initScripts?.[0] === "window.perceived = [];")).toBe(true);
    });

    it("stopped while its own games are played, it saves nothing", async (): Promise<void> => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile(), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const abort: AbortController = new AbortController();
        const writer: TeacherWriter = new TeacherWriter({
            library,
            openBrowser,
            ask: async (): Promise<string> => JSON.stringify({ teacher: RIGHT, notes: "n" }),
        });
        await expect(
            writer.write(fakeGameDefinition({ trainSeeds: [1, 2] }), v1, {
                workDir: root,
                signal: abort.signal,
                log: (l: string): void => {
                    // Written: its own games come next.
                    if (/teacher written/.test(l)) {
                        abort.abort();
                    }
                },
            })
        ).rejects.toThrow(/stopped/);
        expect(library.activeVersion("fake-runner")).toBe(1);
        expect((): unknown => library.profile("fake-runner", 2)).toThrow(/no profile v2/);
    });
});
