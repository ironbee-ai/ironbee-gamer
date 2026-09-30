import { GameBrowser } from "../../../src/devtools/client";
import { StepRequest } from "../../../src/devtools/protocol";
import { InputStep, Profile } from "../../../src/game/types";
import { checkReplay, CheckResult, firstDifference } from "../../../src/run/check";
import { fakeGameDefinition, FakeGame, fakeProfile, RoundsFakeGame } from "../../helpers/fake-game";

/** The runner's right rule as code: its plays are the same frame for frame. */
const RIGHT: string = "function teach(state) { return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";

describe("checkReplay", (): void => {
    it("finds a game that replays the same, frame for frame, one play after the other or both at once", async (): Promise<void> => {
        for (const parallel of [false, true]) {
            const result: CheckResult = await checkReplay((): GameBrowser => new FakeGame(), fakeGameDefinition(), fakeProfile({ teacher: RIGHT }), { seed: 101, gameSeconds: 3, parallel });
            expect(result.diverged).toBeUndefined();
            expect(result.frames).toBeGreaterThan(100);
            expect(result.ends[0]).toBe(result.ends[1]);
        }
    });

    it("reports the first frame that differs, and where", async (): Promise<void> => {
        // A page that shows something its seed does not decide (here: which browser drew it), after half a second.
        let made: number = 0;
        class Wobbly extends FakeGame {
            private readonly id: number = made++;
            override raw(): unknown {
                const frame: Array<Record<string, unknown>> = super.raw() as Array<Record<string, unknown>>;
                return this.t >= 500 ? [...frame, { k: "text", t: `browser ${this.id}`, x: 0, y: 0, w: 0, h: 0 }] : frame;
            }
        }
        const result: CheckResult = await checkReplay((): GameBrowser => new Wobbly(), fakeGameDefinition(), fakeProfile({ teacher: RIGHT }), { seed: 101, gameSeconds: 3 });
        expect(result.diverged).toMatchObject({ frame: 25, gameMs: 500, where: 'raw[3].t: "browser 0" ≠ "browser 1"' });
    });

    it("plays a pointer action as the player does: held while it is in force, let go when another is", async (): Promise<void> => {
        const browsers: FakeGame[] = [];
        const profile: Profile = fakeProfile({
            actions: [
                { id: "WAIT", description: "wait", keys: [] },
                { id: "CHARGE", description: "press and hold", pointer: true },
            ],
            // Charging while the obstacle is between 200 and 100 px away (the runner does not jump on it: it dies later).
            teacher: "function teach(state) { return state.dx !== null && state.dx >= 100 && state.dx < 200 ? 'CHARGE' : 'WAIT'; }",
        });
        const openBrowser = (): GameBrowser => {
            const browser: FakeGame = new FakeGame();
            browsers.push(browser);
            return browser;
        };
        const result: CheckResult = await checkReplay(openBrowser, fakeGameDefinition(), profile, { seed: 101, gameSeconds: 2 });
        expect(result.diverged).toBeUndefined();
        const pointer: unknown[] = browsers[0].steps
            .filter((s: StepRequest): boolean => s.advanceMs === profile.tickMs && s.observe === false)
            .map((s: StepRequest): unknown => s.pointer);
        // Held while charging (held again, it stays down), let go once when the obstacle is past, nothing said while waiting.
        expect(pointer.filter((p: unknown): boolean => p === true).length).toBeGreaterThan(10);
        expect(pointer).toContain(false);
        expect(pointer.every((p: unknown, i: number): boolean => (p === false ? pointer[i - 1] === true : p === undefined ? pointer[i - 1] !== true : true))).toBe(true);
    });

    it("takes a game waiting between rounds on as the player does: keys let go, then its resume, at most three in a row", async (): Promise<void> => {
        const plays = async (resume: InputStep[]): Promise<{ result: CheckResult; browsers: RoundsFakeGame[] }> => {
            const browsers: RoundsFakeGame[] = [];
            const openBrowser = (): GameBrowser => {
                const browser: RoundsFakeGame = new RoundsFakeGame(1_000);
                browsers.push(browser);
                return browser;
            };
            const result: CheckResult = await checkReplay(openBrowser, fakeGameDefinition({ resume }), fakeProfile({ teacher: RIGHT }), { seed: 101, gameSeconds: 3.5 });
            return { result, browsers };
        };
        const taken: { result: CheckResult; browsers: RoundsFakeGame[] } = await plays([{ click: true, advanceMs: 100 }]);
        expect(taken.result.diverged).toBeUndefined();
        expect(taken.browsers.map((b: RoundsFakeGame): number => b.round)).toEqual([4, 4]);
        const steps: StepRequest[] = taken.browsers[0].steps;
        const clicks: number[] = steps.flatMap((s: StepRequest, i: number): number[] => (s.click ? [i] : []));
        expect(clicks.length).toBe(3);
        for (const i of clicks) {
            expect(steps[i - 1]).toEqual({ hold: [], advanceMs: 0, observe: false });
            expect(steps[i]).toEqual({ click: true, advanceMs: 100, observe: false });
        }
        // A resume that does not take the game on: three in a row, then it is played on as it is.
        const stuck: { result: CheckResult; browsers: RoundsFakeGame[] } = await plays([{ press: ["Enter"], advanceMs: 100 }]);
        expect(stuck.result.diverged).toBeUndefined();
        expect(stuck.browsers[0].round).toBe(1);
        expect(stuck.browsers[0].steps.filter((s: StepRequest): boolean => s.press?.[0] === "Enter").length).toBe(3);
    });

    it("takes the game's start as the player does: the keys a holdFrom step names let go by the next step", async (): Promise<void> => {
        const browsers: FakeGame[] = [];
        const openBrowser = (): GameBrowser => {
            const browser: FakeGame = new FakeGame();
            browsers.push(browser);
            return browser;
        };
        const start: InputStep[] = [{ holdFrom: "window.way", advanceMs: 70 }, { press: ["Enter"], advanceMs: 30 }];
        await checkReplay(openBrowser, fakeGameDefinition({ start }), fakeProfile({ teacher: RIGHT }), { seed: 101, gameSeconds: 0.5 });
        expect(browsers[0].steps.slice(0, 2)).toEqual([
            { holdFrom: "window.way", advanceMs: 70, observe: false },
            { hold: [], press: ["Enter"], advanceMs: 30, observe: false },
        ]);
    });

    it("names the first path two values differ at", (): void => {
        expect(firstDifference({ a: [1, { x: 2 }] }, { a: [1, { x: 3 }] })).toBe("a[1].x: 2 ≠ 3");
        expect(firstDifference({ a: 1 }, { a: 1, b: null })).toBe("b: undefined ≠ null");
        expect(firstDifference([1, 2], [1, 2])).toBeUndefined();
        expect(firstDifference({ px: "a".repeat(100) + "b" + "a".repeat(20) }, { px: "a".repeat(100) + "c" + "a".repeat(20) })).toBe('px[100 of 121]: …"aaaaaabaaaaa"… ≠ …"aaaaaacaaaaa"…');
    });
});
