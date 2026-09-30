/**
 * Progress read from what runs already report: real phases and log lines, as the trainer and the
 * distiller print them.
 */

import { ProgressTracker, RunProgress, StageState } from "../../../src/run/progress";
import { RunKind } from "../../../src/run/runs";

function states(p: RunProgress): string {
    return p.stages.map((s: { state: StageState }): string => s.state[0]).join("");
}

describe("ProgressTracker", (): void => {
    it("follows a distillation: the teacher's games, the fine-tuning with its ETA, the DAgger round, the test games", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.DISTILL, { rounds: 1 });
        t.onPhase("the teacher plays: 10472/12000 labelled states");
        expect(t.progress.stages[0].detail).toBe("10,472 of 12,000 labelled states");
        expect(t.progress.fraction).toBeCloseTo(0.873, 2);
        t.onPhase("fine-tuning Laya (round 2)");
        t.onLog("  step 300/740 loss 0.094 0.44 it/s ETA 16m50s | mps 6.4 GB");
        expect(states(t.progress)).toBe("dctt" + "t");
        expect(t.progress.eta).toBe("~17 min");
        expect(t.progress.stages[1].detail).toBe("step 300/740");
        t.onPhase("round 2: Laya plays, the teacher labels what it saw");
        t.onLog("  Laya games: 204, 676, 1485*, 901");
        t.onLog("  the teacher labelled 11247 states the student visited; it chose otherwise in 2864");
        expect(t.progress.stages[2].detail).toBe("Laya's scores: 204, 676, 1485*, 901 · the teacher corrected 2864 of 11247 decisions");
        t.onPhase("fine-tuning Laya (round 3)");
        t.onLog("  early stop at step 600/726: the validation sample is learnt");
        expect(states(t.progress)).toBe("dddct");
        expect(t.progress.fraction).toBe(1);
        t.onPhase("Laya plays the profile's seeds (101, 202, 303, 90 s)");
        t.onLog("Laya on the profile's seeds: 1485, 1485, 1485 (mean 1485.0, 23 ms a decision, ×1.1 of the game's speed) — its teacher (rules v4) on the same games: 1485, 1485, 1485");
        t.finish();
        expect(states(t.progress)).toBe("ddddd");
        expect(t.progress.overall).toBe(1);
        expect(t.progress.results[0]).toMatch(/^Laya: 1485, 1485, 1485/);
    });

    it("skips the rounds a student that agrees everywhere does not need", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.DISTILL, { rounds: 2 });
        t.onPhase("fine-tuning Laya (round 0)");
        t.onPhase("round 0: Laya plays, the teacher labels what it saw");
        t.onLog("  the student agrees with the teacher everywhere it went: no more DAgger rounds");
        t.onPhase("Laya plays the profile's seeds (101, 202, 60 s)");
        expect(states(t.progress)).toBe("dddsssc");
    });

    it("follows a training run: setup, measuring, iterations with their results, and the time the rest may take", (): void => {
        let now: number = 0;
        const t: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 3, setup: true }, (): number => now);
        t.onPhase("setting up: sampling the game");
        t.onPhase("setting up: the trainer is writing the first profile");
        t.onLog("setup: v1 saved — actions tap, wait, tick 32 ms");
        t.onPhase("measuring v1 on seeds 101, 202, 303");
        t.onLog("  v1: mean 13.0 [8, 18, 13] (* = survived the budget)");
        t.onPhase("iteration 1/3: the tuner is reading the runs");
        expect(states(t.progress)).toBe("ddctt");
        expect(t.progress.eta).toBeUndefined();
        now = 20 * 60_000;
        t.onPhase("iteration 1: playing the new version");
        t.onLog("  => v2 saved: 44.7 beats 13.0");
        expect(t.progress.stages[2]).toMatchObject({ state: StageState.DONE, detail: "kept as v2: 44.7" });
        expect(t.progress.eta).toBe("~40 min");
        t.onPhase("iteration 2/3: the tuner is reading the runs");
        now = 30 * 60_000;
        t.onLog("  => not kept: 40.0 does not beat 44.7");
        t.onLog("  2 versions in a row did not beat v2: training stops here");
        expect(states(t.progress)).toBe("dddds");
        expect(t.progress.results).toEqual(["v1 written", "v1 scores 13.0", "v2 saved: 44.7 (was 13.0)", "not kept: 40.0 (best 44.7)"]);
    });

    it("counts an iteration turned away for playing worse paused, or on unseen seeds, as done", (): void => {
        let now: number = 0;
        const t: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 3 }, (): number => now);
        t.onPhase("measuring v3 on seeds 101, 202, 303");
        t.onPhase("iteration 1/3: the tuner is reading the runs");
        now = 20 * 60_000;
        // The trainer's lines, as it logs them.
        t.onLog("  => not kept: 51.0 beats 44.7 in real time, but with the clock paused it plays 30.0 against v3's 38.3");
        expect(t.progress.stages[1]).toMatchObject({ state: StageState.DONE, detail: "not kept: worse with the clock paused (30.0)" });
        expect(t.progress.eta).toBe("~40 min");
        t.onPhase("iteration 2/3: the tuner is reading the runs");
        now = 30 * 60_000;
        t.onLog("  => not kept: 50.3 beats 44.7 on the training seeds, but on seeds it is never shown it plays 12.0 against 20.7");
        expect(t.progress.stages[2]).toMatchObject({ state: StageState.DONE, detail: "not kept: worse on unseen seeds (12.0)" });
        expect(states(t.progress)).toBe("dddt");
        expect(t.progress.eta).toBe("~15 min");
        expect(t.progress.results).toEqual(["not kept: 51.0 in real time, but 30.0 paused (v3 38.3)", "not kept: 50.3, but 12.0 on unseen seeds (best 20.7)"]);
    });

    it("counts an iteration whose tuner or play failed as done: no version came of it", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 2 }, (): number => 0);
        t.onPhase("measuring v1 on seeds 101, 202, 303");
        t.onPhase("iteration 1/2: the tuner is reading the runs");
        t.onLog("  the tuner failed: the new version still fails its regression tests");
        expect(t.progress.stages[1]).toMatchObject({ state: StageState.DONE, detail: "the tuner failed" });
        t.onPhase("iteration 2/2: the tuner is reading the runs");
        t.onLog("  playing it failed: the daemon is not reachable");
        expect(t.progress.stages[2]).toMatchObject({ state: StageState.DONE, detail: "playing it failed" });
        expect(t.progress.results).toEqual([
            "no version: the tuner failed (the new version still fails its regression tests)",
            "no version: playing it failed (the daemon is not reachable)",
        ]);
    });

    it("ends a run with the stages it never came to skipped, not done: training stops without a word after two failed tunings", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 4 }, (): number => 0);
        t.onPhase("measuring v3 on seeds 101, 202, 303");
        t.onPhase("iteration 1/4: the tuner is reading the runs");
        t.onLog("  the tuner failed: the script uses `import`, which is not allowed");
        t.onPhase("iteration 2/4: the tuner is reading the runs");
        t.onLog("  the tuner failed: timed out");
        t.finish();
        expect(states(t.progress)).toBe("dddss");
        expect(t.progress.stages[3]).toMatchObject({ state: StageState.SKIPPED, detail: "the run ended before it" });
        expect(t.progress.overall).toBe(1);
        // The stage a run was in when it ended is done.
        const top: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 2 }, (): number => 0);
        top.onPhase("measuring v5 on seeds 101, 202, 303");
        top.finish();
        expect(states(top.progress)).toBe("dss");
    });

    it("ends training early only on the trainer's own lines, not on the tuner's words logged with them", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 3 }, (): number => 0);
        t.onPhase("measuring v3 on seeds 101, 202, 303");
        t.onPhase("iteration 1/3: the tuner is reading the runs");
        // The tuner's analysis and a regression test's reason, as they wrote them.
        t.onLog("  tuner (512 s): Seed 202 dies at the second pit; nothing left to train in the extractor, so if this fails training stops here.");
        t.onLog("  regression tests: 3/4 pass — failing: v3 reaches the top score (100) on every seed: nothing left to train");
        expect(states(t.progress)).toBe("dctt");
        t.onLog("  => not kept: 40.0 does not beat 44.7");
        t.onPhase("iteration 2/3: the tuner is reading the runs");
        t.onLog("  => not kept: 41.0 does not beat 44.7");
        t.onLog("  2 versions in a row did not beat v3: training stops here");
        expect(states(t.progress)).toBe("ddds");
        expect(t.progress.stages[3].detail).toBe("stopped: the last versions did not score higher");
        const top: ProgressTracker = new ProgressTracker(RunKind.TRAIN, { iterations: 2 }, (): number => 0);
        top.onPhase("measuring v5 on seeds 101, 202, 303");
        top.onLog("v5 reaches the top score (100) on every seed: nothing left to train");
        expect(states(top.progress)).toBe("css");
        expect(top.progress.stages[1].detail).toBe("not needed: the top score is reached");
    });

    it("ends a distillation's rounds and reports its checkpoint only on the distiller's own lines, not on the trainer's notes", (): void => {
        const t: ProgressTracker = new ProgressTracker(RunKind.DISTILL, { rounds: 2 });
        t.onPhase("the trainer writes the teacher (the rules as code)");
        t.onLog("  teacher written (95 s): the student agrees with the teacher everywhere it went: no more DAgger rounds; r2 played better (mean 3): it stays, the new checkpoint is dropped");
        expect(states(t.progress)).toBe("ctttttt");
        expect(t.progress.results).toEqual([]);
        t.onPhase("fine-tuning Laya (round 0)");
        t.onPhase("round 0: Laya plays, the teacher labels what it saw");
        t.onLog("  the student agrees with the teacher everywhere it went: no more DAgger rounds");
        t.onPhase("Laya plays the profile's seeds (101, 202, 60 s)");
        t.onLog("v4-1a2b3c4d-r1 played better (mean 812.5): it stays, the new checkpoint is dropped");
        expect(states(t.progress)).toBe("dddsssc");
        expect(t.progress.results).toEqual(["v4-1a2b3c4d-r1 played better (mean 812.5): it stays, the new checkpoint is dropped"]);
    });
});
