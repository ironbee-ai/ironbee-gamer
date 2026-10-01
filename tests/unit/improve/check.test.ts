import { RulesTeacher } from "../../../src/distill/teacher";
import { DecisionEngine } from "../../../src/engine";
import { Profile } from "../../../src/game/types";
import { checkPlay, CheckReport, Verdict } from "../../../src/improve/check";
import { Library } from "../../../src/library/store";
import { FakeEngine, jumpWhenClose } from "../../helpers/fake-engine";
import { fakeGameDefinition, FakeGame, fakeProfile } from "../../helpers/fake-game";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** Jumps the obstacle (the fake runner's right rules): survives a 5 s game, 50 tenths. */
const RIGHT_RULES: string = "function teach(s) { return !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40 ? 'JUMP' : 'NOOP'; }";

describe("checkPlay", (): void => {
    let root: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-check-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    /** A version measured at 50 on seeds 1 and 2 (the rules survive the 5 s game), with or without its rules. */
    function version(overrides: Partial<Profile> = {}): Profile {
        return fakeProfile({ teacher: RIGHT_RULES, results: { mean: 50, scores: [50, 50], seeds: [1, 2], gameSeconds: 5, measuredAt: "x" }, ...overrides });
    }

    async function check(profile: Profile, engine: DecisionEngine): Promise<CheckReport> {
        return checkPlay((): FakeGame => new FakeGame(), library, { game: fakeGameDefinition(), profile, engine, live: false });
    }

    it("finds the engine to fix where it loses what the rules win on the same clock, and where it chose otherwise before the end", async (): Promise<void> => {
        const report: CheckReport = await check(version(), new FakeEngine((): string => "NOOP"));
        expect(report.verdict).toBe(Verdict.ENGINE);
        expect(report.worseSeeds).toEqual([1, 2]);
        expect(report.rules?.means).toEqual({ 1: 50, 2: 50 });
        expect(report.played.means[1]).toBeLessThan(50);
        // Never jumping, it went otherwise than the rules right before it hit the obstacle.
        expect(report.played.games[0].divergences?.[0]).toMatchObject({ chose: "NOOP", rules: "JUMP" });
        expect(report.why).toMatch(/below the rules.*NOOP where the rules choose JUMP/);
        expect(report.disagreement).toBeGreaterThan(0);
    });

    it("finds the rules to fix where they play below their record, whatever engine is checked", async (): Promise<void> => {
        const record: Profile = version({ results: { mean: 80, scores: [80, 80], seeds: [1, 2], gameSeconds: 5, measuredAt: "x" } });
        const report: CheckReport = await check(record, new RulesTeacher(record));
        expect(report.verdict).toBe(Verdict.RULES);
        expect(report.why).toMatch(/the rules play seeds 1, 2 with the clock paused below their record: 50, 50 against 80, 80/);
        expect(report.rules).toBeUndefined();
    });

    it("reports every finding: the rules below their record, and the engine below the rules — the rules to fix first", async (): Promise<void> => {
        const record: Profile = version({ results: { mean: 80, scores: [80, 80], seeds: [1, 2], gameSeconds: 5, measuredAt: "x" } });
        const report: CheckReport = await check(record, new FakeEngine((): string => "NOOP"));
        expect(report.verdict).toBe(Verdict.RULES);
        expect(report.rulesWorse).toEqual([1, 2]);
        expect(report.engineWorse).toEqual([1, 2]);
        expect(report.worseSeeds).toEqual([1, 2]);
        expect(report.why).toMatch(/^the rules play seeds 1, 2 .* below their record.*; and fake plays seeds 1, 2 .* below the rules/);
    });

    it("finds nothing to fix in an engine that plays as the rules do, and says so with the numbers", async (): Promise<void> => {
        const report: CheckReport = await check(version(), new FakeEngine(jumpWhenClose));
        expect(report.verdict).toBe(Verdict.NOTHING);
        expect(report.disagreement).toBe(0);
        expect(report.why).toMatch(/as well as the rules: 50, 50 against 50, 50/);
    });

    it("holds an engine playing a version without rules (one trained for Jev) to the version's record", async (): Promise<void> => {
        const report: CheckReport = await check(version({ teacher: undefined }), new FakeEngine((): string => "NOOP"));
        expect(report.verdict).toBe(Verdict.ENGINE);
        expect(report.rules).toBeUndefined();
        expect(report.disagreement).toBeUndefined();
        expect(report.why).toMatch(/below its record/);
    });
});
