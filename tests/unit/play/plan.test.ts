import { GameAction } from "../../../src/game/types";
import { planInputs, planInstructions, planQuestionId, planSlotOf, TimedInput } from "../../../src/play/plan";

const WAIT: GameAction = { id: "wait", description: "wait", keys: [] };
const TAP: GameAction = { id: "tap", description: "tap", click: true };
const NOOP: GameAction = { id: "NOOP", description: "run", keys: [] };
const JUMP: GameAction = { id: "JUMP", description: "jump", keys: ["Space"] };
const DUCK: GameAction = { id: "DUCK", description: "duck", keys: ["ArrowDown"] };

const slots = (...actions: GameAction[]): TimedInput[] => actions.map((action: GameAction, k: number): TimedInput => ({ at: 1_000 + k * 50, action }));
const ids = (inputs: TimedInput[]): string[] => inputs.map((i: TimedInput): string => `${i.action.id}@${i.at}`);

describe("a plan's inputs", (): void => {
    it("plays nothing for moments that change nothing", (): void => {
        expect(planInputs(slots(WAIT, WAIT, WAIT), WAIT)).toEqual([]);
        expect(planInputs(slots(JUMP, JUMP), JUMP)).toEqual([]);
    });

    it("plays its first click, and no second one: the moments after it were predicted without it", (): void => {
        expect(ids(planInputs(slots(WAIT, WAIT, TAP, WAIT, TAP, TAP), WAIT))).toEqual(["tap@1100"]);
    });

    it("after a new key, only the release back to what was held", (): void => {
        expect(ids(planInputs(slots(NOOP, JUMP, JUMP, NOOP, NOOP, JUMP), NOOP))).toEqual(["JUMP@1050", "NOOP@1150"]);
        expect(ids(planInputs(slots(DUCK, JUMP, NOOP), NOOP))).toEqual(["DUCK@1000"]);
    });

    it("starts from what is held when the plan begins", (): void => {
        // JUMP already down: holding it is no input; the release is the plan's one change.
        expect(ids(planInputs(slots(JUMP, NOOP, JUMP), JUMP))).toEqual(["NOOP@1050"]);
        expect(ids(planInputs(slots(JUMP), undefined))).toEqual(["JUMP@1000"]);
    });

    it("names a plan's questions by slot, and says what a plan is", (): void => {
        expect(planQuestionId(3)).toBe("slot3");
        expect(planSlotOf("slot3")).toBe(3);
        expect(planSlotOf("action")).toBeUndefined();
        expect(planInstructions(8, 50, 312.4)).toContain("each of the next 8 moments, 50 ms apart, the first 312 ms from now");
    });
});
