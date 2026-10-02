import { DistillOptions, DistillResult } from "../../../src/distill/distiller";
import { DecisionEngine, EngineHealth, EngineKind } from "../../../src/engine";
import { Question, SystemOneResponse } from "../../../src/engine/systemone";
import { CheckReport, Verdict } from "../../../src/improve/check";
import { ImproveEngines, ImproveOutcome, ImproveResult, Improver, nothingToCheck, playsBetter } from "../../../src/improve/improve";
import { Library } from "../../../src/library/store";
import { profileHash } from "../../../src/run/decision-log";
import { TrainOptions, TrainResult } from "../../../src/train/trainer";
import { fakeGameDefinition, FakeGame, fakeProfile, RealtimeFakeGame } from "../../helpers/fake-game";

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";

/** Jumps the obstacle (the fake runner's right rules). */
const RIGHT: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";

/** An engine of a kind that jumps right, or never jumps. */
class Plays implements DecisionEngine {
    readonly label: string;

    constructor(
        readonly kind: EngineKind,
        private readonly right: boolean
    ) {
        this.label = `${kind} (${right ? "right" : "never jumps"})`;
    }

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const s: { dx: number | null; air: boolean } = (state as { game: { dx: number | null; air: boolean } }).game;
        const jump: boolean = this.right && !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40;
        const choice: string = jump ? "JUMP" : "NOOP";
        return { answers: Object.fromEntries(Object.keys(questions).map((q: string): [string, unknown] => [q, { choice, probabilities: { NOOP: jump ? 0 : 1, JUMP: jump ? 1 : 0 }, confidence: 1 }])) };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: "fake" };
    }
}

describe("Improver", (): void => {
    let root: string;
    let library: Library;
    /** Whether Laya has been taught (the fake distillation teaches it) — and whether teaching it works. */
    let taught: boolean;
    let teachingWorks: boolean;
    /** The versions Jev plays right (a fake training keeps one). */
    let jevPlaysRight: Set<number>;
    let trains: TrainOptions[];
    let distills: DistillOptions[];
    /** What the fake distillation does: teach (default), keep the checkpoint before it, or stop after a round. */
    let distillAs: "teach" | "keepPrevious" | "stopPartWay";
    /** What each distillation in turn does, before `distillAs` does. */
    let distillPlan: Array<"teach" | "keepPrevious" | "stopPartWay">;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-improve-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT }), results: { mean: 50, scores: [50, 50], seeds: [1, 2], gameSeconds: 5, measuredAt: "x" } } as never);
        taught = false;
        teachingWorks = true;
        jevPlaysRight = new Set();
        trains = [];
        distills = [];
        distillAs = "teach";
        distillPlan = [];
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    /** v1's Laya checkpoint as a distillation leaves it. */
    function checkpoint(round: number): string {
        const profile = library.profile("fake-runner", 1)!;
        const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v1-${profileHash(profile)}-r${round}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), `round ${round}`);
        writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
        writeFileSync(path.join(dir, "training.json"), "{}");
        return dir;
    }

    function improver(browser: () => FakeGame = (): FakeGame => new FakeGame(), port: number = 1): Improver {
        const engines: ImproveEngines = {
            engineFor: async (kind: EngineKind, version: number | undefined): Promise<{ engine: DecisionEngine; profileVersion: number }> => {
                const v: number = version ?? (library.activeVersion("fake-runner") as number);
                const right: boolean = kind === EngineKind.LAYA ? taught && teachingWorks : kind === EngineKind.JEV ? jevPlaysRight.has(v) : true;
                return { engine: new Plays(kind, right), profileVersion: v };
            },
            release: async (): Promise<void> => {},
        };
        return new Improver({
            library,
            openBrowser: browser,
            engines,
            train: async (options: TrainOptions): Promise<TrainResult> => {
                trains.push(options);
                const kept = library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, origin: "tuner" }) } as never, { activate: options.activate !== false });
                if (options.decider === "engine") {
                    jevPlaysRight.add(kept.version);
                }
                return { bestVersion: kept.version, savedVersions: [kept.version], history: [], stopped: false };
            },
            distill: async (options: DistillOptions): Promise<DistillResult> => {
                distills.push(options);
                const laya: string = path.join(library.userDirFor("fake-runner"), "laya");
                const as: "teach" | "keepPrevious" | "stopPartWay" = distillPlan.shift() ?? distillAs;
                if (as === "keepPrevious") {
                    return { checkpoint: path.join(laya, readdirSync(laya)[0]), teacher: "rules v1", profileVersion: options.profileVersion as number } as DistillResult;
                }
                if (as === "stopPartWay") {
                    // A round fine-tuned, then the stop: a distillation throws on one.
                    checkpoint(5);
                    throw new Error("stopped");
                }
                taught = true;
                // As the distiller keeps one checkpoint a version: the new one, the one before dropped.
                const before: string = path.join(library.userDirFor("fake-runner"), "laya");
                for (const old of existsSync(before) ? readdirSync(before) : []) {
                    rmSync(path.join(before, old), { recursive: true, force: true });
                }
                return { checkpoint: checkpoint(9), teacher: "rules v1", profileVersion: options.profileVersion as number } as DistillResult;
            },
            distillDefaults: { teacher: "rules" as never, minRows: 100, gameSeconds: 5, parallel: 1, epochs: 1, port },
        });
    }

    async function improve(engine: EngineKind, note?: string): Promise<ImproveResult> {
        return improver().improve({ gameId: "fake-runner", engine, live: false, ...(note ? { note } : {}), workDir: path.join(root, "work") });
    }

    it("teaches Laya more where it plays worse than its rules, and keeps the lesson that plays better", async (): Promise<void> => {
        checkpoint(0);
        const result: ImproveResult = await improve(EngineKind.LAYA);
        expect(result.outcome).toBe(ImproveOutcome.IMPROVED);
        expect(result.before.verdict).toBe("engine");
        expect(result.after?.verdict).toBe("nothing");
        expect(distills).toEqual([expect.objectContaining({ profileVersion: 1, resume: true, rounds: 2, studentGames: 8 })]);
        expect(trains).toEqual([]);
        expect(readdirSync(path.join(library.userDirFor("fake-runner"), "laya"))).toEqual([expect.stringMatching(/-r9$/)]);
    });

    it("undoes a lesson that plays no better, and the next one — the version learnt again from the base model — too: Laya's checkpoint before them comes back", async (): Promise<void> => {
        const before: string = checkpoint(0);
        teachingWorks = false;
        const result: ImproveResult = await improve(EngineKind.LAYA);
        expect(result.outcome).toBe(ImproveOutcome.NOT_IMPROVED);
        // More rounds from the checkpoint, then from the base model on every state gathered (not resumed).
        expect(distills.map((d: DistillOptions): boolean | undefined => d.resume)).toEqual([true, false]);
        expect(readdirSync(path.join(library.userDirFor("fake-runner"), "laya"))).toEqual([path.basename(before)]);
        expect(result.done.filter((d: string): boolean => /undone: Laya's checkpoint before it is back/.test(d))).toHaveLength(2);
        expect(result.done.join("\n")).toMatch(/Laya learnt the version again from the base model with the clock paused \(2 rounds\)/);
    });

    it("teaches Laya the next way when more rounds play no better (the checkpoint before them stays), and keeps that lesson when it plays better", async (): Promise<void> => {
        checkpoint(0);
        distillPlan = ["keepPrevious", "teach"];
        const checks: string[] = [];
        const result: ImproveResult = await improver().improve({
            gameId: "fake-runner",
            engine: EngineKind.LAYA,
            live: false,
            workDir: path.join(root, "work"),
            hooks: { onCheck: (when: "before" | "after"): number => checks.push(when) },
        });
        expect(result.outcome).toBe(ImproveOutcome.IMPROVED);
        expect(distills.map((d: DistillOptions): boolean | undefined => d.resume)).toEqual([true, false]);
        // The first lesson kept the checkpoint before it: nothing new to check after it, only after the second.
        expect(checks).toEqual(["before", "after"]);
        expect(result.done.join("\n")).toMatch(/Laya taught more, but the checkpoint before it played better: it stays/);
        expect(readdirSync(path.join(library.userDirFor("fake-runner"), "laya"))).toEqual([expect.stringMatching(/-r9$/)]);
    });

    it("keeps a lesson the distillation turned away (the checkpoint before it played better): nothing new, nothing checked again", async (): Promise<void> => {
        const before: string = checkpoint(0);
        distillAs = "keepPrevious";
        const checks: string[] = [];
        const result: ImproveResult = await improver().improve({
            gameId: "fake-runner",
            engine: EngineKind.LAYA,
            live: false,
            workDir: path.join(root, "work"),
            hooks: { onCheck: (when: "before" | "after"): number => checks.push(when) },
        });
        expect(result.outcome).toBe(ImproveOutcome.NOT_IMPROVED);
        expect(checks).toEqual(["before"]);
        expect(readdirSync(path.join(library.userDirFor("fake-runner"), "laya"))).toEqual([path.basename(before)]);
    });

    it("undoes a lesson stopped part way: its rounds go — a resume would go on from them — and the checkpoint before it stays", async (): Promise<void> => {
        const before: string = checkpoint(0);
        distillAs = "stopPartWay";
        await expect(improve(EngineKind.LAYA)).rejects.toThrow("stopped");
        expect(readdirSync(path.join(library.userDirFor("fake-runner"), "laya"))).toEqual([path.basename(before)]);
    });

    it("refuses Laya before the check when a server another process holds is on the port a lesson needs", async (): Promise<void> => {
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": "/elsewhere" } }));
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", resolve);
        });
        try {
            const port: number = (server.address() as AddressInfo).port;
            const busy: Improver = improver(undefined, port);
            const checked: string[] = [];
            await expect(
                busy.improve({ gameId: "fake-runner", engine: EngineKind.LAYA, live: false, workDir: path.join(root, "work"), hooks: { onCheck: (w: "before" | "after"): number => checked.push(w) } })
            ).rejects.toThrow(/A Laya server on port \d+ answers/);
            expect(checked).toEqual([]);
        } finally {
            server.close();
        }
    });

    it("trains Jev's instructions where Jev plays worse, Jev deciding: the version kept is Jev's, not made active", async (): Promise<void> => {
        const result: ImproveResult = await improve(EngineKind.JEV);
        expect(result.outcome).toBe(ImproveOutcome.IMPROVED);
        expect(trains).toEqual([expect.objectContaining({ decider: "engine", fromVersion: 1, activate: false })]);
        expect(result.version).toBe(2);
        expect(library.activeVersion("fake-runner")).toBe(1);
        expect(library.game("fake-runner").configs).toContainEqual({ engine: EngineKind.JEV, version: 2 });
    });

    it("trains the rules where they play below their record, then distils Laya for the version kept: Laya and the rules play it", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT }), results: { mean: 80, scores: [80, 80], seeds: [1, 2], gameSeconds: 5, measuredAt: "x" } } as never);
        const result: ImproveResult = await improve(EngineKind.LAYA);
        expect(result.before.verdict).toBe("rules");
        expect(trains).toEqual([expect.objectContaining({ decider: "rules", fromVersion: 2 })]);
        expect(distills).toEqual([expect.objectContaining({ profileVersion: 3 })]);
        expect(result.outcome).toBe(ImproveOutcome.IMPROVED);
        expect(library.game("fake-runner").configs).toEqual(
            expect.arrayContaining([
                { engine: EngineKind.LAYA, version: 3 },
                { engine: EngineKind.RULES, version: 3 },
            ])
        );
    });

    it("on the running clock trains the version live, as it is played: its games for real, not simulated", async (): Promise<void> => {
        // One-second games: the live checks take their time.
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT }), results: { mean: 10, scores: [10, 10], seeds: [1, 2], gameSeconds: 1, measuredAt: "x" } } as never);
        await improver((): FakeGame => new RealtimeFakeGame()).improve({
            gameId: "fake-runner",
            engine: EngineKind.RULES,
            live: true,
            note: "jump earlier",
            gamesPerSeed: 1,
            workDir: path.join(root, "work"),
        });
        // Its games' floors spread up to as late as a busy machine lands a fast engine's inputs.
        expect(trains).toEqual([expect.objectContaining({ decider: "rules", realtime: true, live: { minLagMs: 0, maxLagMs: 90, gamesPerSeed: 1 }, note: "jump earlier" })]);
        expect(trains[0].simulated).toBeUndefined();
    }, 60_000);

    it("trains for a higher score where nothing plays worse, with the iterations asked for, and keeps a version only if it plays better", async (): Promise<void> => {
        const result: ImproveResult = await improver().improve({ gameId: "fake-runner", engine: EngineKind.RULES, live: false, iterations: 5, workDir: path.join(root, "work") });
        expect(result.before.verdict).toBe("nothing");
        expect(trains).toEqual([expect.objectContaining({ decider: "rules", fromVersion: 1, iterations: 5 })]);
        expect(trains[0].note).toBeUndefined();
        // v2 plays as v1 did: no better, undone — v1 stays the active version, v2 in the library.
        expect(result.outcome).toBe(ImproveOutcome.NOT_IMPROVED);
        expect(library.activeVersion("fake-runner")).toBe(1);
        expect(library.profile("fake-runner", 2)).toBeDefined();
    });

    it("says why there is nothing to check yet — Train then trains from there — and nothing once there is", (): void => {
        const game = library.game("fake-runner");
        // v1 carries its rules as code: the rules and Jev can play it paused; Laya has no model of it yet.
        expect(nothingToCheck(library, game, EngineKind.RULES, false)).toBeUndefined();
        expect(nothingToCheck(library, game, EngineKind.JEV, false)).toBeUndefined();
        expect(nothingToCheck(library, game, EngineKind.LAYA, false)).toBe("Laya has no model of v1 yet");
        checkpoint(0);
        expect(nothingToCheck(library, game, EngineKind.LAYA, false)).toBeUndefined();
        // No version trained for real time: the running clock is not played yet.
        expect(nothingToCheck(library, game, EngineKind.RULES, true)).toBe("not played with rules with the clock running yet");
        // A version without its rules as code: nothing the rules could play.
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        expect(nothingToCheck(library, game, EngineKind.RULES, false)).toBe("v2 has no rules as code yet");
        expect(nothingToCheck(library, game, EngineKind.RULES, false, 1)).toBeUndefined();
        expect(() => nothingToCheck(library, game, EngineKind.RULES, false, 9)).toThrow("fake-runner has no profile v9");
        // A game with no version at all.
        library.saveGame(fakeGameDefinition({ id: "fresh", name: "Fresh" }));
        expect(nothingToCheck(library, library.game("fresh"), EngineKind.LAYA, false)).toBe("no version trained yet");
    });

    it("trains with the person's notes whatever the check finds, and undoes a version that plays no better: the active one stays", async (): Promise<void> => {
        const result: ImproveResult = await improve(EngineKind.RULES, "jump earlier");
        expect(trains).toEqual([expect.objectContaining({ decider: "rules", note: "jump earlier", fromVersion: 1 })]);
        expect(result.outcome).toBe(ImproveOutcome.NOT_IMPROVED);
        expect(library.activeVersion("fake-runner")).toBe(1);
        expect(result.done.join("\n")).toMatch(/undone: v1 is the active version again \(v2 stays in the library\)/);
    });
});

describe("playsBetter", (): void => {
    /** A check of `version` whose engine played `means`, with these seeds below their reference. */
    function report(version: number, means: Record<number, number>, worseSeeds: number[]): CheckReport {
        return {
            gameId: "g",
            version,
            engine: EngineKind.LAYA,
            live: true,
            played: { label: "laya", games: [], means },
            verdict: worseSeeds.length ? Verdict.ENGINE : Verdict.NOTHING,
            why: "",
            rulesWorse: [],
            slowWorse: [],
            engineWorse: worseSeeds,
            worseSeeds,
            stopped: false,
        };
    }

    it("the same version, held to the same rules: fewer seeds below them with the mean no lower", (): void => {
        expect(playsBetter(report(6, { 1: 1000, 2: 1200 }, [1]), report(6, { 1: 1200, 2: 1200 }, []))).toBe(true);
        expect(playsBetter(report(6, { 1: 1000, 2: 1200 }, [1]), report(6, { 1: 990, 2: 1200 }, []))).toBe(false);
    });

    it("a new version whose rules lost at the slow end: kept when they play better there, its engine at the soonest no worse than live games vary", (): void => {
        const slow = (r: CheckReport, means: Record<number, number>, worse: number[]): CheckReport => ({ ...r, slow: { label: "rules", games: [], means }, slowWorse: worse });
        const before: CheckReport = slow(report(6, { 1: 1000, 2: 1000 }, []), { 1: 500, 2: 1000 }, [1]);
        expect(playsBetter(before, slow(report(7, { 1: 990, 2: 990 }, []), { 1: 1000, 2: 1000 }, []))).toBe(true);
        // Its engine at the soonest lower than live games vary: not kept.
        expect(playsBetter(before, slow(report(7, { 1: 900, 2: 900 }, []), { 1: 1000, 2: 1000 }, []))).toBe(false);
        // No better at the slow end: not kept either.
        expect(playsBetter(before, slow(report(7, { 1: 990, 2: 990 }, []), { 1: 500, 2: 1000 }, [1]))).toBe(false);
    });

    it("a new version, held to its own fresh record: only an engine that plays better outright", (): void => {
        expect(playsBetter(report(6, { 1: 1000, 2: 1000 }, [1, 2]), report(7, { 1: 990, 2: 990 }, []))).toBe(false);
        expect(playsBetter(report(6, { 1: 1000, 2: 1000 }, [1, 2]), report(7, { 1: 1100, 2: 1000 }, []))).toBe(true);
    });
});
