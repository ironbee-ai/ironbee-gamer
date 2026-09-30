/**
 * A game played in rounds: between two, its score expression reports `waiting: true` (a level's end
 * screen that asks for a click) and a player takes it on — lets go of the keys and the pointer, then
 * runs the game's `resume` steps. The player and the replay check (run/check.ts) take it on alike, and
 * send a game's `start` and `resume` steps alike (`inputSteps`).
 */

import { ScoreReading, StepRequest } from "../devtools/protocol";
import { GameDefinition, InputStep } from "../game/types";

/** A game still waiting after its `resume` ran this many times in a row is played on as it is. */
const MAX_RESUMES_IN_A_ROW: number = 3;

/** A start or resume step as the browser takes it: its input, then its game time; nothing is read. */
function inputStep(s: InputStep): StepRequest {
    return {
        ...(s.press ? { press: s.press } : {}),
        ...(s.holdFrom ? { holdFrom: s.holdFrom } : {}),
        ...(s.hold ? { hold: s.hold } : {}),
        ...(s.click ? { click: s.click } : {}),
        ...(s.waitMs ? { waitMs: s.waitMs } : {}),
        advanceMs: s.advanceMs ?? 0,
        observe: false,
    };
}

/**
 * A start or resume sequence as the browser takes it. The keys a `holdFrom` step names are held for that step:
 * the next lets them go with its own input when it names no keys to hold (the step's own `hold` keys stay down,
 * as `hold` does), and after a last step they are let go before play — the player then holds what it decides.
 */
export function inputSteps(steps: InputStep[] | undefined): StepRequest[] {
    const requests: StepRequest[] = [];
    let before: InputStep | undefined;
    for (const s of steps ?? []) {
        const request: StepRequest = inputStep(s);
        requests.push(before?.holdFrom && !s.hold && !s.holdFrom ? { hold: before.hold ?? [], ...request } : request);
        before = s;
    }
    if (before?.holdFrom) {
        requests.push({ hold: before.hold ?? [], advanceMs: 0, observe: false });
    }
    return requests;
}

/** One game's resumes, counted while it keeps waiting: a `resume` that does not take it on cannot loop. */
export class Resumes {
    private inARow: number = 0;

    constructor(private readonly game: GameDefinition) {}

    /**
     * The steps that take the game on from this reading — the keys and the pointer let go, then its
     * `resume` —, or none: it is not waiting, has no `resume`, or still waits after the last ones.
     */
    stepsAfter(reading: ScoreReading | undefined, pointerHeld: boolean): StepRequest[] {
        if (reading?.waiting !== true) {
            this.inARow = 0;
            return [];
        }
        if (!this.game.resume?.length || this.inARow >= MAX_RESUMES_IN_A_ROW) {
            return [];
        }
        this.inARow++;
        return [{ hold: [], ...(pointerHeld ? { pointer: false } : {}), advanceMs: 0, observe: false }, ...inputSteps(this.game.resume)];
    }
}
