/**
 * A decision engine answers typed questions (choice) about a state. The player
 * is written against this interface only; which engine runs is configuration.
 */

import { Question, SystemOneResponse } from "./systemone";

export enum EngineKind {
    /** TypeSafe Jev, hosted. */
    JEV = "jev",
    /** Laya, served on this machine (laya-serve). */
    LAYA = "laya",
    /** The profile's own rules as code (`teach(state)`, written by the trainer): on this machine, instant. */
    RULES = "rules",
}

export interface DecisionEngine {
    readonly kind: EngineKind;
    /** Human-readable, e.g. "jev (jev-latest)". */
    readonly label: string;
    ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse>;
    /** Opens the connection ahead of the first question, while the page loads; optional. */
    warmUp?(): void;
    /**
     * Real-time play: keeps a local model from idling down while it waits between decisions (and while the
     * page loads) by asking again — the last question, before any `question` — until the stop it returns is
     * called. Optional: a hosted engine, whose questions cost, has none.
     */
    keepWarm?(question: Record<string, Question>): () => void;
    /** Whether the engine is configured; never throws. */
    health(): Promise<EngineHealth>;
}

export interface EngineHealth {
    ok: boolean;
    detail: string;
}
