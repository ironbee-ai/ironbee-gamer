/**
 * Plan mode: real time with an engine slower than the game. One request decides a plan — an action
 * for each of the next `slots` moments, `slotMs` apart, the first when the answer is expected to have
 * arrived — from the extractor's prediction of each moment (`info.slots`, given the inputs already
 * scheduled, `info.pending`). A request is always in flight: each answer's plan replaces what the
 * earlier one scheduled from its first moment on.
 *
 * The moments of a plan are predicted without the plan's own inputs (they are not known yet), so a
 * plan plays at most one change — its first moment that changes something (a click, keys or the
 * pointer going down or up) — and, when that change pressed something, the release back to what was
 * held when the plan began. The next plan, told of those inputs as pending, decides the rest.
 */

import { GameAction } from "../game/types";

const QUESTION_PREFIX: string = "slot";

/** The engine question of slot `k` (1-based) of a plan. */
export function planQuestionId(k: number): string {
    return `${QUESTION_PREFIX}${k}`;
}

/** The slot (1-based) a plan question asks about; undefined for any other question. */
export function planSlotOf(questionId: string): number | undefined {
    const match: RegExpExecArray | null = /^slot(\d+)$/.exec(questionId);
    return match ? Number(match[1]) : undefined;
}

/** What the engine is told about a plan, after the profile's rules. */
export function planInstructions(slots: number, slotMs: number, leadMs: number): string {
    return (
        ` PLAN: you decide now for each of the next ${slots} moments, ${slotMs} ms apart, the first ${Math.round(leadMs)} ms from now. ` +
        `Slot k is described by game.slots[k-1], exactly as the game state is described (the other fields describe the present). ` +
        `Your answers for earlier slots are actions you will have taken by then: keep the plan consistent (an action that only works once is chosen once).`
    );
}

/** An input at a wall-clock time. */
export interface TimedInput {
    at: number;
    action: GameAction;
}

/** What an action keeps down: its keys and pointer. */
function holdKey(action: GameAction | undefined): string {
    return action ? JSON.stringify([[...(action.keys ?? [])].sort(), action.pointer ?? false]) : JSON.stringify([[], false]);
}

/** Whether playing `action` while `held` is down changes anything: a click, or other keys or pointer. */
export function changesInput(action: GameAction, held: GameAction | undefined): boolean {
    return Boolean(action.click) || holdKey(action) !== holdKey(held);
}

/** Whether `action` puts down something `held` does not keep down: a key, the pointer. */
function presses(action: GameAction, held: GameAction | undefined): boolean {
    const down: Set<string> = new Set(held?.keys ?? []);
    return (action.keys ?? []).some((key: string): boolean => !down.has(key)) || (Boolean(action.pointer) && !held?.pointer);
}

/**
 * The inputs a plan's slots come to, `heldAtStart` being what is down when its first slot begins:
 * slots that change nothing need no input; the first that does is played; after it, when it pressed
 * keys or the pointer, only their release back to `heldAtStart`; any other change ends the plan there.
 */
export function planInputs(slots: TimedInput[], heldAtStart: GameAction | undefined): TimedInput[] {
    const inputs: TimedInput[] = [];
    let held: GameAction | undefined = heldAtStart;
    for (const slot of slots) {
        if (!changesInput(slot.action, held)) {
            continue;
        }
        if (inputs.length === 0) {
            inputs.push(slot);
            held = slot.action;
            continue;
        }
        const first: GameAction = inputs[0].action;
        if (!first.click && presses(first, heldAtStart) && !slot.action.click && holdKey(slot.action) === holdKey(heldAtStart)) {
            inputs.push(slot);
        }
        break;
    }
    return inputs;
}
