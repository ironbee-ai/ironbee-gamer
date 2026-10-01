import { DistillOptions, DistillResult } from "../../../src/distill/distiller";
import { EngineKind } from "../../../src/engine";
import { Library } from "../../../src/library/store";
import { profileHash } from "../../../src/run/decision-log";
import { layaToTeach, trainFor, TrainForDeps, TrainForResult } from "../../../src/train/train-for";
import { Decider, TrainOptions, TrainResult } from "../../../src/train/trainer";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("trainFor", (): void => {
    let root: string;
    let library: Library;
    let trains: TrainOptions[];
    let distills: DistillOptions[];
    /** What the fake training keeps: a new version, or nothing. */
    let keeps: boolean;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-train-for-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never);
        trains = [];
        distills = [];
        keeps = true;
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    /** Laya's checkpoint of a version, as a distillation leaves it. */
    function checkpoint(version: number): void {
        const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v${version}-${profileHash(library.profile("fake-runner", version)!)}-r0`);
        mkdirSync(dir, { recursive: true });
        for (const file of ["model.safetensors", "rl_agent_config.json", "training.json"]) {
            writeFileSync(path.join(dir, file), "{}");
        }
    }

    const deps = (): TrainForDeps => ({
        library,
        train: async (options: TrainOptions): Promise<TrainResult> => {
            trains.push(options);
            if (!keeps) {
                return { bestVersion: 1, savedVersions: [], history: [], stopped: false };
            }
            const kept = library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'JUMP'; }", lagAware: true }) } as never);
            return { bestVersion: kept.version, bestMean: 50, savedVersions: [kept.version], history: [], stopped: false };
        },
        distill: async (options: DistillOptions): Promise<DistillResult> => {
            distills.push(options);
            return { checkpoint: "/laya/vN-r0", teacher: "rules", profileVersion: options.profileVersion as number } as DistillResult;
        },
        distillDefaults: { teacher: "rules" as never, minRows: 100, gameSeconds: 5, parallel: 1, rounds: 1, studentGames: 2, epochs: 1, port: 1 },
    });

    async function train(engine: EngineKind, more: Partial<Parameters<typeof trainFor>[1]> = {}): Promise<{ result: TrainForResult; taught: Array<[number, boolean]> }> {
        const taught: Array<[number, boolean]> = [];
        const result: TrainForResult = await trainFor(deps(), {
            gameId: "fake-runner",
            engine,
            iterations: 2,
            workDir: path.join(root, "work"),
            hooks: { onTeach: (v: number, alone: boolean): number => taught.push([v, alone]) },
            ...more,
        });
        return { result, taught };
    }

    it("for Jev trains its rules in words, Jev deciding — and nothing more", async (): Promise<void> => {
        await train(EngineKind.JEV);
        expect(trains).toEqual([expect.objectContaining({ decider: Decider.ENGINE, iterations: 2 })]);
        expect(distills).toEqual([]);
    });

    it("for Rules (code) trains the rules as code — and nothing more", async (): Promise<void> => {
        await train(EngineKind.RULES, { realtime: true });
        expect(trains).toEqual([expect.objectContaining({ decider: Decider.RULES, realtime: true, simulated: true })]);
        expect(distills).toEqual([]);
    });

    it("for Laya trains the rules, then teaches Laya the version kept (with the lag, one trained for real time)", async (): Promise<void> => {
        checkpoint(1);
        const { result, taught } = await train(EngineKind.LAYA);
        expect(trains).toEqual([expect.objectContaining({ decider: Decider.RULES })]);
        expect(distills).toEqual([expect.objectContaining({ profileVersion: 2, lag: expect.any(Object), workDir: path.join(root, "work", "distill") })]);
        expect(taught).toEqual([[2, false]]);
        expect(result.taught?.version).toBe(2);
    });

    it("for Laya, a training that keeps no version teaches nothing: Laya plays the version it learnt", async (): Promise<void> => {
        checkpoint(1);
        keeps = false;
        const { result } = await train(EngineKind.LAYA);
        expect(distills).toEqual([]);
        expect(result.untaught).toMatch(/no version beat v1/);
    });

    it("for Laya with no model of the version it plays, teaches that version alone: nothing trained", async (): Promise<void> => {
        const { result, taught } = await train(EngineKind.LAYA);
        expect(trains).toEqual([]);
        expect(distills).toEqual([expect.objectContaining({ profileVersion: 1 })]);
        expect(taught).toEqual([[1, true]]);
        expect(result.trained).toBeUndefined();
    });

    it("knows which version Laya is to play: the active one, for real time the one its live config pins", (): void => {
        const game = library.game("fake-runner");
        expect(layaToTeach(library, game, false)).toBe(1);
        checkpoint(1);
        expect(layaToTeach(library, game, false)).toBeUndefined();
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }" }) } as never, { activate: false });
        library.saveGame({ ...game, configs: [{ engine: EngineKind.LAYA }, { engine: EngineKind.LAYA, live: true, version: 2, lagMs: 50 }] });
        expect(layaToTeach(library, library.game("fake-runner"), true)).toBe(2);
    });
});
