/**
 * The trainer's rules as a teacher: a profile's `teach(state)` answering the System One question
 * the player asks, so it can stand where an engine stands — it plays the data-collection games and
 * labels the states a student visited, and it plays wherever the rules decide: a profile trained with
 * the rules, a teacher's check games, a watched game with "Rules (code)" chosen as the engine. Local
 * and instant: labelling costs nothing next to the fine-tuning.
 */

import { Question, SystemOneResponse } from "../engine/systemone";
import { DecisionEngine, EngineHealth, EngineKind } from "../engine/types";
import { GameAction, Profile } from "../game/types";
import { LatencyRange, latencyAt } from "../play/latency";
import { planSlotOf } from "../play/plan";
import { Teacher } from "../play/sandbox";

export { LatencyRange, latencyAt };

/**
 * How late the rules answer while trained for real time, as the engine that will play does: a range,
 * because an engine's time differs from game to game and drifts within one (a hosted engine slows down
 * and speeds up). Each game starts somewhere in the range (from its seed) and drifts across it.
 */
/** One labelled state: the question as the player asked it, and the teacher's probabilities. */
export interface TeacherLabel {
    state: unknown;
    criteria: Record<string, string>;
    instructions: { goal: string; instructions: string };
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
    ms: number;
}

export class RulesTeacher implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.RULES;
    readonly label: string;
    private readonly teacher: Teacher;
    private readonly ids: string[];
    /** Exploration: this share of moves is a random action (what is recorded stays the teacher's label). */
    private readonly epsilon: number;
    private readonly random: () => number;
    private readonly onLabel?: (label: TeacherLabel) => void;
    /** Answers this late, as a slower engine would: training for real-time play, where lateness costs. */
    private readonly latency?: LatencyRange;
    private startedAt?: number;

    constructor(
        profile: Profile,
        options: { epsilon?: number; random?: () => number; onLabel?: (label: TeacherLabel) => void; latency?: LatencyRange } = {}
    ) {
        if (!profile.teacher) {
            throw new Error(`profile v${profile.version} has no teacher`);
        }
        this.ids = profile.actions.map((a: GameAction): string => a.id);
        this.teacher = new Teacher(profile.teacher, this.ids);
        this.label = `rules v${profile.version}`;
        this.epsilon = options.epsilon ?? 0;
        this.random = options.random ?? Math.random;
        this.onLabel = options.onLabel;
        this.latency = options.latency && options.latency.maxMs > 0 ? options.latency : undefined;
    }

    /** The teacher's probabilities for a state (what training learns). */
    teach(state: unknown): Record<string, number> {
        return this.teacher.label(state);
    }

    private best(probabilities: Record<string, number>): string {
        return this.ids.reduce((best: string, id: string): string => (probabilities[id] > probabilities[best] ? id : best), this.ids[0]);
    }

    /** A plan's question (`slotK`) is about the moment `game.slots[K-1]` predicts; any other, the present. */
    private stateFor(game: unknown, questionId: string): unknown {
        const slot: number | undefined = planSlotOf(questionId);
        const slots: unknown = (game as { slots?: unknown } | null)?.slots;
        return slot !== undefined && Array.isArray(slots) && slots[slot - 1] !== undefined ? slots[slot - 1] : game;
    }

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const started: number = Date.now();
        const game: unknown = (state as { game?: unknown })?.game;
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(questions)) {
            const seen: unknown = this.stateFor(game, id);
            const probabilities: Record<string, number> = this.teach(seen);
            const taught: string = this.best(probabilities);
            this.onLabel?.({
                state: seen,
                criteria: question.criteria as Record<string, string>,
                instructions: question.instructions as { goal: string; instructions: string },
                choice: taught,
                probabilities,
                confidence: probabilities[taught],
                ms: Date.now() - started,
            });
            if (this.epsilon > 0 && this.random() < this.epsilon) {
                // A random move, answered as a sure one: the game goes somewhere the teacher would not take it.
                const move: string = this.ids[Math.floor(this.random() * this.ids.length)];
                answers[id] = { choice: move, probabilities: Object.fromEntries(this.ids.map((a: string): [string, number] => [a, a === move ? 1 : 0])), confidence: 1 };
            } else {
                answers[id] = { choice: taught, probabilities, confidence: probabilities[taught] };
            }
        }
        if (this.latency) {
            this.startedAt ??= Date.now();
            const ms: number = latencyAt(this.latency, Date.now() - this.startedAt);
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, ms);
            });
        }
        return { answers, model: this.label };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: this.label };
    }
}

/** Random numbers in [0, 1) from a seed: the same seed, the same numbers (a game's moves replay with it). */
export function seededRandom(seed: number): () => number {
    let state: number = (seed ^ 0x5bd1e995) >>> 0 || 1;
    return (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t: number = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A random action every decision, seeded (the same seed, the same moves): the floor a profile's score
 * is measured from — a version that plays no better than it has learnt nothing, whatever it scores.
 */
export class RandomPlayer implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.RULES;
    readonly label: string = "random";
    private readonly next: () => number;

    constructor(seed: number) {
        this.next = seededRandom(seed);
    }

    async ask(_state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(questions)) {
            const options: string[] = Object.keys(question.criteria);
            const choice: string = options[Math.floor(this.next() * options.length)];
            answers[id] = { choice, probabilities: Object.fromEntries(options.map((o: string): [string, number] => [o, o === choice ? 1 : 0])), confidence: 1 };
        }
        return { answers, model: this.label };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: this.label };
    }
}
