/**
 * How far a training or distillation run has got, for whoever is watching it: its stages in
 * order, which one is running and what it is doing, how much of it is done and how long the rest
 * may take, and what has come out so far. It is read from the phases and log lines the run
 * already reports — the trainer and the distiller know nothing about it.
 */

import { RunKind } from "./runs";

export enum StageState {
    DONE = "done",
    CURRENT = "current",
    TODO = "todo",
    SKIPPED = "skipped",
}

export interface ProgressStage {
    label: string;
    state: StageState;
    /** What the stage is doing or came to: "10,472 labelled states", "step 300/740". */
    detail?: string;
}

export interface RunProgress {
    stages: ProgressStage[];
    /** Of the current stage, 0 to 1, when it can be told. */
    fraction?: number;
    /** Of the whole run, 0 to 1. */
    overall: number;
    /** How long the rest may take, in words, when it can be told. */
    eta?: string;
    /** What came out so far, in order. */
    results: string[];
}

/**
 * The trainer's and the distiller's own lines that end stages early or name the checkpoint kept, matched
 * whole: the tuner's analysis and the trainer's notes on a teacher are logged as written, and may say anything.
 */
const TRAINING_STOPS: RegExp = /^\d+ versions in a row did not beat v\d+: training stops here$/;
const TOP_SCORE_REACHED: RegExp = /^v\d+ reaches the top score \([^)]*\) on every seed: nothing left to train$/;
const NO_MORE_ROUNDS: RegExp = /^the student agrees with the teacher everywhere it went: no more DAgger rounds$/;
const OLDER_CHECKPOINT_STAYS: RegExp = /^\S+ played better \(mean [^)]*\): it stays, the new checkpoint is dropped$/;

function minutes(ms: number): string {
    const m: number = Math.max(1, Math.round(ms / 60_000));
    return m >= 60 ? `~${Math.floor(m / 60)} h ${m % 60} min` : `~${m} min`;
}

/** Follows one run's reports. `now` is injectable for tests. */
export class ProgressTracker {
    private readonly stages: ProgressStage[];
    private current: number = 0;
    private fraction?: number;
    private eta?: string;
    private readonly results: string[] = [];
    /** Training: when each iteration started, and how long the finished ones took. */
    private iterationStartedAt?: number;
    private readonly iterationMs: number[] = [];
    private readonly firstIteration: number;
    private readonly iterations: number;

    constructor(
        private readonly kind: RunKind,
        options: { iterations?: number; rounds?: number; setup?: boolean },
        private readonly now: () => number = Date.now
    ) {
        if (kind === RunKind.DISTILL) {
            const rounds: number = options.rounds ?? 1;
            this.stages = [
                { label: "The teacher plays", state: StageState.CURRENT },
                { label: "Laya learns", state: StageState.TODO },
                ...Array.from({ length: rounds }, (_: unknown, i: number): ProgressStage[] => [
                    { label: `Laya plays, the teacher corrects${rounds > 1 ? ` (${i + 1})` : ""}`, state: StageState.TODO },
                    { label: `Laya learns from it${rounds > 1 ? ` (${i + 1})` : ""}`, state: StageState.TODO },
                ]).flat(),
                { label: "Laya plays the test games", state: StageState.TODO },
            ];
            this.firstIteration = 0;
            this.iterations = 0;
        } else {
            this.iterations = options.iterations ?? 3;
            this.stages = [
                ...(options.setup ? [{ label: "Setup: the trainer writes the first profile", state: StageState.CURRENT }] : []),
                { label: "Measuring the profile", state: options.setup ? StageState.TODO : StageState.CURRENT },
                ...Array.from({ length: this.iterations }, (_: unknown, i: number): ProgressStage => ({ label: `Iteration ${i + 1}/${this.iterations}`, state: StageState.TODO })),
            ];
            this.firstIteration = options.setup ? 2 : 1;
        }
    }

    get progress(): RunProgress {
        const done: number = this.stages.filter((s: ProgressStage): boolean => s.state === StageState.DONE || s.state === StageState.SKIPPED).length;
        const active: boolean = this.stages[this.current]?.state === StageState.CURRENT;
        return {
            stages: this.stages.map((s: ProgressStage): ProgressStage => ({ ...s })),
            ...(this.fraction !== undefined ? { fraction: this.fraction } : {}),
            overall: Math.min(1, (done + (active ? (this.fraction ?? 0) : 0)) / this.stages.length),
            ...(this.eta ? { eta: this.eta } : {}),
            results: [...this.results],
        };
    }

    /** Moves on to stage `index` (the ones before it are done). */
    private enter(index: number, detail?: string): void {
        if (index < 0 || index >= this.stages.length) {
            return;
        }
        for (let i: number = 0; i < index; i++) {
            if (this.stages[i].state !== StageState.SKIPPED) {
                this.stages[i].state = StageState.DONE;
            }
        }
        if (index !== this.current) {
            this.fraction = undefined;
            this.eta = undefined;
        }
        this.current = index;
        this.stages[index].state = StageState.CURRENT;
        if (detail !== undefined) {
            this.stages[index].detail = detail;
        }
    }

    /** The next stage whose label starts with `prefix`, from the current one on. */
    private next(prefix: string): number {
        for (let i: number = this.current; i < this.stages.length; i++) {
            if (this.stages[i].label.startsWith(prefix) && (this.stages[i].state !== StageState.DONE || i === this.current)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * The run is over: the stage it was in is done, and those it never came to are skipped — a training run
     * whose tuner fails twice in a row stops without a word.
     */
    finish(): void {
        for (const s of this.stages) {
            if (s.state === StageState.CURRENT) {
                s.state = StageState.DONE;
            } else if (s.state === StageState.TODO) {
                s.state = StageState.SKIPPED;
                s.detail ??= "the run ended before it";
            }
        }
        this.current = this.stages.length - 1;
        this.fraction = undefined;
        this.eta = undefined;
    }

    onPhase(text: string): void {
        if (this.kind === RunKind.DISTILL) {
            this.distillPhase(text);
        } else {
            this.trainPhase(text);
        }
    }

    onLog(line: string): void {
        if (this.kind === RunKind.DISTILL) {
            this.distillLog(line.trim());
        } else {
            this.trainLog(line.trim());
        }
    }

    private distillPhase(text: string): void {
        let m: RegExpExecArray | null;
        if ((m = /the teacher plays: (\d+)\/(\d+)/.exec(text))) {
            this.enter(0, `${Number(m[1]).toLocaleString("en")} of ${Number(m[2]).toLocaleString("en")} labelled states`);
            this.fraction = Math.min(1, Number(m[1]) / Math.max(1, Number(m[2])));
        } else if (/the trainer writes the teacher/.test(text)) {
            this.stages[0].detail = "the trainer writes the rules as code first";
        } else if (/^fine-tuning Laya/.test(text)) {
            // The first "Laya learns" still to do, then each round's.
            this.enter(this.next("Laya learns"));
        } else if (/Laya plays, the teacher labels/.test(text)) {
            this.enter(this.next("Laya plays, the teacher"));
        } else if (/Laya plays the profile's seeds/.test(text)) {
            this.enter(this.stages.length - 1);
        }
    }

    private distillLog(line: string): void {
        let m: RegExpExecArray | null;
        if ((m = /(\d+) distinct labelled states$/.exec(line))) {
            this.stages[0].detail = `${Number(m[1]).toLocaleString("en")} labelled states`;
        } else if ((m = /^step (\d+)\/(\d+) .*ETA (\d+)m(\d+)s/.exec(line))) {
            this.fraction = Math.min(1, Number(m[1]) / Math.max(1, Number(m[2])));
            this.eta = minutes((Number(m[3]) * 60 + Number(m[4])) * 1000);
            this.stages[this.current].detail = `step ${m[1]}/${m[2]}`;
        } else if (/^early stop/.test(line)) {
            this.fraction = 1;
            this.eta = undefined;
            this.stages[this.current].detail = "learnt: stopped early";
        } else if ((m = /^Laya games: (.*)$/.exec(line))) {
            this.stages[this.current].detail = `Laya's scores: ${m[1]}`;
        } else if ((m = /labelled (\d+) states the student visited; it chose otherwise in (\d+)/.exec(line))) {
            this.stages[this.current].detail = `${this.stages[this.current].detail ? `${this.stages[this.current].detail} · ` : ""}the teacher corrected ${m[2]} of ${m[1]} decisions`;
        } else if (NO_MORE_ROUNDS.test(line)) {
            for (const s of this.stages) {
                if (s.state === StageState.TODO && s.label !== this.stages[this.stages.length - 1].label) {
                    s.state = StageState.SKIPPED;
                    s.detail = "not needed: Laya agreed with the teacher everywhere";
                }
            }
        } else if ((m = /^Laya on the profile's seeds: (.*)$/.exec(line))) {
            this.results.push(`Laya: ${m[1]}`);
        } else if (OLDER_CHECKPOINT_STAYS.test(line)) {
            this.results.push(line);
        }
    }

    private trainPhase(text: string): void {
        let m: RegExpExecArray | null;
        if (/^setting up/.test(text)) {
            this.enter(0, /writing/.test(text) ? "the trainer (an LLM) writes the extractor, the actions and the rules — usually 10–25 min" : "sampling the game");
        } else if ((m = /has no teacher: the trainer writes one/.exec(text))) {
            this.stages[this.current].detail = "the trainer writes the rules as code";
        } else if ((m = /^measuring v(\d+)/.exec(text))) {
            this.enter(this.next("Measuring"), `v${m[1]} plays the training seeds`);
        } else if ((m = /^iteration (\d+)\/\d+: the tuner is reading the runs/.exec(text))) {
            const index: number = this.firstIteration + Number(m[1]) - 1;
            this.enter(index, "the trainer (an LLM) reads the games and writes a better version — usually 10–25 min");
            this.iterationStartedAt = this.now();
            this.estimate();
        } else if ((m = /^iteration (\d+): playing the new version/.exec(text))) {
            this.enter(this.firstIteration + Number(m[1]) - 1, "the new version plays the training seeds");
        }
    }

    private trainLog(line: string): void {
        let m: RegExpExecArray | null;
        if ((m = /^setup: v(\d+) saved/.exec(line))) {
            this.results.push(`v${m[1]} written`);
        } else if ((m = /^v(\d+): mean ([\d.]+)/.exec(line))) {
            this.results.push(`v${m[1]} scores ${m[2]}`);
        } else if ((m = /^=> v(\d+) saved: ([\d.]+) beats ([\d.]+)/.exec(line))) {
            this.results.push(`v${m[1]} saved: ${m[2]} (was ${m[3]})`);
            this.iterationDone(`kept as v${m[1]}: ${m[2]}`);
        } else if ((m = /^=> not kept: ([\d.]+) does not beat ([\d.]+)/.exec(line))) {
            this.results.push(`not kept: ${m[1]} (best ${m[2]})`);
            this.iterationDone(`not better: ${m[1]}`);
        } else if ((m = /^=> not kept: ([\d.]+) beats [\d.]+ in real time, but with the clock paused it plays ([\d.]+) against v(\d+)'s ([\d.]+)/.exec(line))) {
            this.results.push(`not kept: ${m[1]} in real time, but ${m[2]} paused (v${m[3]} ${m[4]})`);
            this.iterationDone(`not kept: worse with the clock paused (${m[2]})`);
        } else if ((m = /^=> not kept: ([\d.]+) beats [\d.]+ on the training seeds, but on seeds it is never shown it plays ([\d.]+) against ([\d.]+)/.exec(line))) {
            this.results.push(`not kept: ${m[1]}, but ${m[2]} on unseen seeds (best ${m[3]})`);
            this.iterationDone(`not kept: worse on unseen seeds (${m[2]})`);
        } else if ((m = /^the tuner failed: (.*)/.exec(line))) {
            this.results.push(`no version: the tuner failed (${m[1].slice(0, 80)})`);
            this.iterationDone("the tuner failed");
        } else if ((m = /^playing it failed: (.*)/.exec(line))) {
            this.results.push(`no version: playing it failed (${m[1].slice(0, 80)})`);
            this.iterationDone("playing it failed");
        } else if (TRAINING_STOPS.test(line) || TOP_SCORE_REACHED.test(line)) {
            for (const s of this.stages) {
                if (s.state === StageState.TODO) {
                    s.state = StageState.SKIPPED;
                    s.detail = TOP_SCORE_REACHED.test(line) ? "not needed: the top score is reached" : "stopped: the last versions did not score higher";
                }
            }
        }
    }

    private iterationDone(detail: string): void {
        this.stages[this.current].detail = detail;
        this.stages[this.current].state = StageState.DONE;
        if (this.iterationStartedAt !== undefined) {
            this.iterationMs.push(this.now() - this.iterationStartedAt);
            this.iterationStartedAt = undefined;
        }
        this.fraction = undefined;
        this.estimate();
    }

    /** Training: the iterations left at the pace of the finished ones. */
    private estimate(): void {
        if (!this.iterationMs.length) {
            this.eta = undefined;
            return;
        }
        const average: number = this.iterationMs.reduce((a: number, b: number): number => a + b, 0) / this.iterationMs.length;
        const left: number = this.stages.filter((s: ProgressStage): boolean => s.state === StageState.TODO || s.state === StageState.CURRENT).length;
        const running: number = this.iterationStartedAt !== undefined ? this.now() - this.iterationStartedAt : 0;
        this.eta = left ? minutes(Math.max(60_000, left * average - running)) : undefined;
    }
}
