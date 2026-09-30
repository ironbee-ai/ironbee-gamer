/**
 * A decision engine that applies a function to the state: the player's and the
 * trainer's tests decide without a network.
 */

import { Question, SystemOneResponse } from "../../src/engine/systemone";
import { DecisionEngine, EngineHealth, EngineKind } from "../../src/engine/types";

export type Decider = (state: any, criteria: Record<string, string>) => string;

export class FakeEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.JEV;
    readonly label: string = "fake";
    readonly asked: Array<{ state: any; questions: Record<string, Question> }> = [];

    constructor(private readonly decider: Decider) {}

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        this.asked.push({ state, questions });
        const q: Question = questions.action;
        const options: string[] = Object.keys(q.criteria);
        const choice: string = this.decider((state as { game: unknown }).game, q.criteria as Record<string, string>);
        const probabilities: Record<string, number> = Object.fromEntries(options.map((o: string): [string, number] => [o, o === choice ? 1 : 0]));
        return { answers: { action: { choice, probabilities, confidence: 1 } } };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: "fake" };
    }
}

/** Jumps when the obstacle is close and the player is on the ground (the fake runner's right rule). */
export const jumpWhenClose: Decider = (state: any): string => (!state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? "JUMP" : "NOOP");

/**
 * A slow engine that answers plans: a plan question (`slotK`) from the moment the state predicts
 * (`game.slots[K-1]`), any other from the present. It records how many requests were in flight at once.
 */
export class PlanFakeEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.JEV;
    readonly label: string = "fake planner";
    readonly asked: Array<{ state: any; questions: Record<string, Question> }> = [];
    inFlight: number = 0;
    maxInFlight: number = 0;

    constructor(
        private readonly decider: Decider,
        private readonly delayMs: number
    ) {}

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        this.asked.push({ state, questions });
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, this.delayMs));
        this.inFlight--;
        const game: any = (state as { game: any }).game;
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(questions)) {
            const slot: RegExpExecArray | null = /^slot(\d+)$/.exec(id);
            const seen: any = slot && Array.isArray(game?.slots) ? game.slots[Number(slot[1]) - 1] : game;
            const choice: string = this.decider(seen, q.criteria as Record<string, string>);
            answers[id] = { choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map((o: string): [string, number] => [o, o === choice ? 1 : 0])), confidence: 1 };
        }
        return { answers };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: "fake planner" };
    }
}

/**
 * A plan engine the test scripts: request k (in the order asked, from 0) answers `plan(k)`, one action per slot
 * (NOOP past its end), `delayMs` after it was asked — on a fake clock, answers come in an order the test sets.
 */
export class ScriptedPlanEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.JEV;
    readonly label: string = "scripted planner";
    readonly asked: Array<{ state: any; questions: Record<string, Question> }> = [];

    constructor(
        private readonly plan: (request: number) => string[],
        private readonly delayMs: number
    ) {}

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        const request: number = this.asked.push({ state, questions }) - 1;
        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, this.delayMs));
        const choices: string[] = this.plan(request);
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(questions)) {
            const slot: RegExpExecArray | null = /^slot(\d+)$/.exec(id);
            const choice: string = choices[slot ? Number(slot[1]) - 1 : 0] ?? "NOOP";
            answers[id] = { choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map((o: string): [string, number] => [o, o === choice ? 1 : 0])), confidence: 1 };
        }
        return { answers };
    }

    async health(): Promise<EngineHealth> {
        return { ok: true, detail: "scripted planner" };
    }
}
