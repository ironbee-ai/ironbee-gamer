import { guardState, stateSignature } from "../../../src/play/guard";

describe("guardState", (): void => {
    const ids: string[] = ["UP", "DOWN", "JUMP"];

    it("drops fields that name or recommend an action, and counts them", (): void => {
        const state: Record<string, unknown> = {
            threat: { dx: 40, recommendedAction: "JUMP" },
            advice: "jump now",
            shouldJump: true,
            choice: "UP",
            bestAction: "DOWN",
            dx: 40,
        };
        const { state: out, dropped } = guardState(state, ids);
        expect(out).toEqual({ threat: { dx: 40 }, dx: 40 });
        expect(dropped).toBe(5);
    });

    it("drops a value equal to an action id unless its key names a fact", (): void => {
        const { state: out, dropped } = guardState({ go: "up", heading: "UP", lastMove: "DOWN", status: "JUMP" }, ids);
        expect(out).toEqual({ heading: "UP", lastMove: "DOWN", status: "JUMP" });
        expect(dropped).toBe(1);
    });

    it("matches names at their start or whole: todo is not in onShortestPathToDot", (): void => {
        const { state: out, dropped } = guardState({ onShortestPathToDot: true, actions: { UP: { possible: true } } }, ids);
        expect(out).toEqual({ onShortestPathToDot: true, actions: { UP: { possible: true } } });
        expect(dropped).toBe(0);
    });

    it("drops action ids from a list (a planned route), unless the list names a fact", (): void => {
        const { state: out, dropped } = guardState({ route: ["UP", "UP", "cell"], previousMoves: ["DOWN"] }, ids);
        expect(out).toEqual({ route: ["cell"], previousMoves: ["DOWN"] });
        expect(dropped).toBe(2);
    });

    it("replaces a state that is itself an action id by null, and drops them from a state that is a list", (): void => {
        expect(guardState("jump", ids)).toEqual({ state: null, dropped: 1 });
        expect(guardState("cell", ids)).toEqual({ state: "cell", dropped: 0 });
        expect(guardState(["JUMP", "cell", ["UP", 3]], ids)).toEqual({ state: ["cell", [3]], dropped: 2 });
    });
    it("keeps a list longer than a call's argument limit (a flattened grid), dropping its action ids", (): void => {
        const grid: unknown[] = new Array(150_000).fill(1);
        grid[7] = "JUMP";
        const { state: out, dropped } = guardState({ grid }, ids);
        expect(dropped).toBe(1);
        expect((out as { grid: unknown[] }).grid.length).toBe(149_999);
    });

    it("refuses a state nested deeper than 64 levels (its serializing could overflow the stack), and keeps one of 64", (): void => {
        const nest = (levels: number): unknown => {
            let o: unknown = [1];
            for (let i = 1; i < levels; i++) {
                o = [o];
            }
            return { deep: o };
        };
        expect((): unknown => guardState(nest(3000), ids)).toThrow(/deeper than 64 levels/);
        expect(guardState(nest(63), ids).dropped).toBe(0);
    });
});

describe("stateSignature", (): void => {
    it("ignores counters: a state that changed only in them has not changed", (): void => {
        expect(stateSignature({ dx: 3, tick: 1, frameCount: 9 })).toBe(stateSignature({ dx: 3, tick: 2, frameCount: 10 }));
        expect(stateSignature({ dx: 3 })).not.toBe(stateSignature({ dx: 4 }));
    });

    it("knows a counter by a whole word of its key — camelCase, snake_case, kebab-case —, not by letters inside another word", (): void => {
        const counters: string[] = ["tick", "ticks", "frameCount", "time_left", "lastFrameAt", "TIMER_MS", "HPTimer", "blueTicks", "age-ms", "timestamp", "counter2"];
        for (const key of counters) {
            expect([key, stateSignature({ dx: 3, [key]: 1 })]).toEqual([key, stateSignature({ dx: 3, [key]: 2 })]);
        }
        // A boss's damage is no age, a stage no age, an account no count, a joystick no tick: a change in them is a change.
        const words: string[] = ["bossDamage", "stage", "message", "image", "page", "percentage", "average", "account", "joystick", "countdown", "lifetime", "keyframe"];
        for (const key of words) {
            expect([key, stateSignature({ dx: 3, [key]: 1 })]).not.toEqual([key, stateSignature({ dx: 3, [key]: 2 })]);
        }
        // At any depth, and a list's items are kept whatever their index.
        expect(stateSignature({ boss: { damage: 1, ageMs: 5 } })).toBe(stateSignature({ boss: { damage: 1, ageMs: 9 } }));
        expect(stateSignature({ boss: { damage: 1 } })).not.toBe(stateSignature({ boss: { damage: 2 } }));
        expect(stateSignature({ cells: [1, 2] })).not.toBe(stateSignature({ cells: [1, 3] }));
    });
});
