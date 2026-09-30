import { InputStep } from "../../../src/game/types";
import { inputSteps, Resumes } from "../../../src/play/rounds";
import { fakeGameDefinition } from "../../helpers/fake-game";

describe("a start or resume sequence as the browser takes it", (): void => {
    it("sends each step's input, then runs its game time, and reads nothing", (): void => {
        expect(inputSteps([{ press: ["Space"], advanceMs: 700 }, { hold: ["a"], click: true, waitMs: 1000 }])).toEqual([
            { press: ["Space"], advanceMs: 700, observe: false },
            { hold: ["a"], click: true, waitMs: 1000, advanceMs: 0, observe: false },
        ]);
        expect(inputSteps(undefined)).toEqual([]);
    });

    it("lets the keys a holdFrom step named go with the next step, when that one names no keys to hold", (): void => {
        // Before, a press-only step after it kept the key down, into play.
        expect(inputSteps([{ holdFrom: "window.way", advanceMs: 70 }, { press: ["Enter"], advanceMs: 450 }])).toEqual([
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], press: ["Enter"], advanceMs: 450, observe: false },
        ]);
        // The step's own hold keys stay down, as hold keeps them.
        expect(inputSteps([{ hold: ["s"], holdFrom: "window.way", advanceMs: 70 }, { advanceMs: 450 }])[1]).toEqual({ hold: ["s"], advanceMs: 450, observe: false });
    });

    it("leaves a next step that names keys to hold as it is: they replace the held ones", (): void => {
        const steps: InputStep[] = [{ holdFrom: "window.way", advanceMs: 70 }, { hold: ["x"], advanceMs: 450 }, { holdFrom: "window.way" }, { holdFrom: "window.next" }, { hold: [] }];
        expect(inputSteps(steps).slice(1)).toEqual([
            { hold: ["x"], advanceMs: 450, observe: false },
            { holdFrom: "window.way", advanceMs: 0, observe: false },
            { holdFrom: "window.next", advanceMs: 0, observe: false },
            { hold: [], advanceMs: 0, observe: false },
        ]);
    });

    it("lets the keys of a last holdFrom step go before play", (): void => {
        expect(inputSteps([{ press: ["Enter"] }, { holdFrom: "window.way", advanceMs: 70 }])).toEqual([
            { press: ["Enter"], advanceMs: 0, observe: false },
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], advanceMs: 0, observe: false },
        ]);
    });

    it("takes a waiting game on with its resume sequence alike, the keys and the pointer let go first", (): void => {
        const resumes: Resumes = new Resumes(fakeGameDefinition({ resume: [{ holdFrom: "window.way", advanceMs: 70 }, { click: true }] }));
        expect(resumes.stepsAfter({ waiting: true }, true)).toEqual([
            { hold: [], pointer: false, advanceMs: 0, observe: false },
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], click: true, advanceMs: 0, observe: false },
        ]);
        expect(resumes.stepsAfter({ waiting: false }, false)).toEqual([]);
    });
});
