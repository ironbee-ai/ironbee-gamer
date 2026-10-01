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

/** A check's games: how many it plays, how many have ended, and how long each took. */
interface CheckCount {
    planned: number;
    played: number;
    lastAt?: number;
    gameMs: number[];
}

/** The share of a checked training each check counts for in the bar (the fix: the rest). */
const CHECK_SHARE: number = 0.2;

/**
 * A checked training's progress (Train with something to check: src/improve/): the check, the fix — a training's or a
 * distillation's own stages, followed by the trackers above — and the check after it, read from the Improver's phases and
 * check games and the fix's own lines. The bar is weighed (each check a fifth, the fix the rest), so it never runs back
 * when the fix's stages appear.
 */
export class ImproveTracker {
    private readonly checks: { before: CheckCount; after: CheckCount } = {
        before: { planned: 0, played: 0, gameMs: [] },
        after: { planned: 0, played: 0, gameMs: [] },
    };
    private part: "before" | "fix" | "after" | "done" = "before";
    private training?: ProgressTracker;
    private distilling?: ProgressTracker;
    private readonly results: string[] = [];

    constructor(private readonly now: () => number = Date.now) {}

    /** A check begins: the games it plays. */
    onCheckStart(when: "before" | "after", games: number): void {
        this.part = when;
        this.checks[when] = { planned: games, played: 0, lastAt: this.now(), gameMs: [] };
    }

    /** One of the check's games ended. */
    onGame(): void {
        if (this.part !== "before" && this.part !== "after") {
            return;
        }
        const check: CheckCount = this.checks[this.part];
        const at: number = this.now();
        if (check.lastAt !== undefined) {
            check.gameMs.push(at - check.lastAt);
        }
        check.lastAt = at;
        check.played++;
    }

    /** A check ended: what it found. */
    onCheck(when: "before" | "after", verdict: string, why: string): void {
        this.results.push(`${when === "before" ? "found" : "now"}: ${verdict === "nothing" ? "nothing played worse" : why}`);
        if (when === "before") {
            this.part = "fix";
        }
    }

    /** The Improver's phases: the fix it starts. */
    onPhase(text: string): void {
        let m: RegExpExecArray | null;
        if ((m = /^training .*\((\d+) iterations\)$/.exec(text))) {
            this.part = "fix";
            this.training = new ProgressTracker(RunKind.TRAIN, { iterations: Number(m[1]) }, this.now);
        } else if ((m = /^(?:teaching Laya more|distilling Laya for v\d+).*?(\d+) rounds/.exec(text))) {
            this.part = "fix";
            this.distilling = new ProgressTracker(RunKind.DISTILL, { rounds: Number(m[1]) }, this.now);
        }
    }

    onTrainLog(line: string): void {
        this.training?.onLog(line);
    }

    onTrainPhase(text: string): void {
        this.training?.onPhase(text);
    }

    onDistillLog(line: string): void {
        this.distilling?.onLog(line);
    }

    onDistillPhase(text: string): void {
        this.distilling?.onPhase(text);
    }

    /** The training is over: what it came to. */
    finish(outcome: string): void {
        this.training?.finish();
        this.distilling?.finish();
        this.part = "done";
        this.results.push(outcome);
    }

    private checkStage(label: string, when: "before" | "after", reached: boolean): ProgressStage {
        const check: CheckCount = this.checks[when];
        const state: StageState = this.part === when ? StageState.CURRENT : reached ? StageState.DONE : StageState.TODO;
        return { label, state, ...(check.planned ? { detail: `${check.played} of ${check.planned} games` } : {}) };
    }

    get progress(): RunProgress {
        const fixed: boolean = this.part === "after" || this.part === "done";
        const stages: ProgressStage[] = [this.checkStage("Checking how it plays", "before", this.part !== "before")];
        const inner: Array<{ prefix: string; tracker: ProgressTracker }> = [
            ...(this.training ? [{ prefix: "Training", tracker: this.training }] : []),
            ...(this.distilling ? [{ prefix: "Laya", tracker: this.distilling }] : []),
        ];
        for (const { prefix, tracker } of inner) {
            stages.push(...tracker.progress.stages.map((s: ProgressStage): ProgressStage => ({ ...s, label: `${prefix}: ${s.label}` })));
        }
        if (!inner.length) {
            stages.push({ label: "Training", state: this.part === "before" ? StageState.TODO : fixed ? StageState.DONE : StageState.CURRENT });
        }
        const after: ProgressStage = this.checkStage("Checking again", "after", this.part === "done" && this.checks.after.planned > 0);
        // Over with no check after it: nothing new to play (the training kept no version, the lesson the checkpoint before it).
        stages.push(this.part === "done" && !this.checks.after.planned ? { ...after, state: StageState.SKIPPED, detail: "nothing new to check" } : after);

        // The current part: its share done and its time left.
        let fraction: number | undefined;
        let eta: string | undefined;
        if (this.part === "before" || this.part === "after") {
            const check: CheckCount = this.checks[this.part];
            if (check.planned) {
                fraction = Math.min(1, check.played / check.planned);
                const mean: number = check.gameMs.length ? check.gameMs.reduce((a: number, b: number): number => a + b, 0) / check.gameMs.length : 0;
                eta = mean ? minutes(mean * Math.max(0, check.planned - check.played)) : undefined;
            }
        } else if (this.part === "fix") {
            const running: ProgressTracker | undefined = this.distilling ?? this.training;
            fraction = running?.progress.fraction;
            eta = running?.progress.eta;
        }
        const share: (when: "before" | "after") => number = (when: "before" | "after"): number =>
            this.part === "done" || (when === "before" && this.part !== "before") ? 1 : this.part === when ? (fraction ?? 0) : 0;
        const fixShare: number = fixed
            ? 1
            : inner.length
                ? inner.reduce((a: number, i: { tracker: ProgressTracker }): number => a + i.tracker.progress.overall, 0) / inner.length
                : 0;
        const overall: number = this.part === "done" ? 1 : CHECK_SHARE * share("before") + (1 - 2 * CHECK_SHARE) * fixShare + CHECK_SHARE * share("after");
        return {
            stages,
            ...(fraction !== undefined ? { fraction } : {}),
            overall: Math.min(1, overall),
            ...(eta ? { eta } : {}),
            results: [...this.results, ...inner.flatMap((i: { prefix: string; tracker: ProgressTracker }): string[] => i.tracker.progress.results.map((r: string): string => `${i.prefix}: ${r}`))],
        };
    }
}

/** The share of a training for Laya the rules' training counts for in the bar (Laya's lesson: the rest). */
const TRAINING_SHARE: number = 0.6;

/**
 * A training for Laya (src/train/train-for.ts): the rules trained — a training's stages —, then Laya taught the version
 * kept — a distillation's —; or, Laya having no model of the version it plays, the distillation alone.
 */
export class LayaTrainingTracker {
    private readonly training?: ProgressTracker;
    private distilling?: ProgressTracker;
    /** Why Laya was not taught (no version kept): its stage skipped, saying so. */
    private untaught?: string;
    private finished: boolean = false;

    constructor(
        options: { iterations?: number; setup?: boolean; alone: boolean },
        private readonly now: () => number = Date.now
    ) {
        if (options.alone) {
            this.distilling = new ProgressTracker(RunKind.DISTILL, { rounds: 1 }, now);
        } else {
            this.training = new ProgressTracker(RunKind.TRAIN, { iterations: options.iterations, ...(options.setup ? { setup: true } : {}) }, now);
        }
    }

    onTrainLog(line: string): void {
        this.training?.onLog(line);
    }

    onTrainPhase(text: string): void {
        this.training?.onPhase(text);
    }

    /** Laya is taught now: the training (if any) is over. */
    onTeach(rounds: number): void {
        this.training?.finish();
        this.distilling ??= new ProgressTracker(RunKind.DISTILL, { rounds }, this.now);
    }

    onDistillLog(line: string): void {
        this.distilling?.onLog(line);
    }

    onDistillPhase(text: string): void {
        this.distilling?.onPhase(text);
    }

    finish(untaught?: string): void {
        this.training?.finish();
        this.distilling?.finish();
        this.untaught = untaught;
        this.finished = true;
    }

    get progress(): RunProgress {
        const training: RunProgress | undefined = this.training?.progress;
        const distilling: RunProgress | undefined = this.distilling?.progress;
        const stages: ProgressStage[] = [
            ...(training?.stages.map((s: ProgressStage): ProgressStage => ({ ...s, label: `Training: ${s.label}` })) ?? []),
            ...(distilling
                ? distilling.stages.map((s: ProgressStage): ProgressStage => ({ ...s, label: `Laya: ${s.label}` }))
                : [
                    {
                        label: "Laya: learns the version kept",
                        state: this.untaught || this.finished ? StageState.SKIPPED : StageState.TODO,
                        ...(this.untaught ? { detail: this.untaught } : {}),
                    },
                ]),
        ];
        const current: RunProgress | undefined = distilling ?? training;
        const overall: number = this.finished
            ? 1
            : !training
                ? (distilling?.overall ?? 0)
                : TRAINING_SHARE * training.overall + (1 - TRAINING_SHARE) * (distilling?.overall ?? 0);
        return {
            stages,
            ...(current?.fraction !== undefined ? { fraction: current.fraction } : {}),
            overall: Math.min(1, overall),
            ...(current?.eta ? { eta: current.eta } : {}),
            results: [...(training?.results ?? []), ...(distilling?.results ?? []).map((r: string): string => `Laya: ${r}`)],
        };
    }
}
