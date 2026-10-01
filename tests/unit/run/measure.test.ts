import { GameBrowser } from "../../../src/devtools/client";
import { GameDefinition, Profile, ProfileResults } from "../../../src/game/types";
import { measureVersion } from "../../../src/run/measure";
import { fakeGameDefinition, FakeGame, fakeProfile } from "../../helpers/fake-game";

/** The runner's right rule as code. */
const RIGHT: string = "function teach(state) { return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";

describe("measureVersion", (): void => {
    const game: GameDefinition = fakeGameDefinition({ trainSeeds: [101, 202], testSeeds: [303] });
    const recorded = (realtime: ProfileResults["realtime"]): ProfileResults => ({ mean: 10, scores: [10, 10], seeds: [101, 202], gameSeconds: 1, measuredAt: "2026-09-29T00:00:00.000Z", realtime });

    const measure = async (profile: Profile): Promise<{ results: ProfileResults; games: number }> => {
        let games: number = 0;
        const results: ProfileResults = await measureVersion((): GameBrowser => {
            games++;
            return new FakeGame();
        }, game, profile);
        return { results, games };
    };

    it("plays real time again at the lag it was measured with", async (): Promise<void> => {
        const { results, games } = await measure(fakeProfile({ teacher: RIGHT, results: recorded({ mean: 3, scores: [3, 3], lagMs: 30 }) }));
        // The training seeds paused, the unseen seed, random play, and real time on the training seeds.
        expect(games).toBe(2 + 1 + 2 + 2);
        expect(results.realtime).toMatchObject({ lagMs: 30, scores: [expect.any(Number), expect.any(Number)] });
        expect(results.realtime?.mean).not.toBe(3);
    });

    it("plays real time again at each of its lag points, a seed's score the mean of its games there", async (): Promise<void> => {
        const { results, games } = await measure(fakeProfile({ teacher: RIGHT, results: recorded({ mean: 3, scores: [3, 3], lagMs: 30, lagPoints: [20, 30, 40] }) }));
        // The training seeds paused, the unseen seed, random play, and real time on the training seeds at each point.
        expect(games).toBe(2 + 1 + 2 + 2 * 3);
        expect(results.realtime).toMatchObject({ lagMs: 30, lagPoints: [20, 30, 40], scores: [expect.any(Number), expect.any(Number)] });
    });

    it("keeps the unseen seeds as training played them in real time, and measures them again with the clock paused", async (): Promise<void> => {
        const unseen: { mean: number; scores: number[]; seeds: number[] } = { mean: 7, scores: [7], seeds: [303] };
        const { results } = await measure(fakeProfile({ teacher: RIGHT, results: recorded({ mean: 3, scores: [3, 3], lagMs: 30, test: unseen }) }));
        expect(results.realtime).toMatchObject({ lagMs: 30, test: unseen });
        expect(results.test).toMatchObject({ seeds: [303], scores: [expect.any(Number)] });
    });

    it("keeps a plan profile's recorded real time: its lag is a plan's lead, and plans play only with the clock running", async (): Promise<void> => {
        const realtime: ProfileResults["realtime"] = { mean: 42, scores: [40, 44], lagMs: 455 };
        const { results, games } = await measure(fakeProfile({ teacher: RIGHT, plan: { slots: 8, slotMs: 50 }, results: recorded(realtime) }));
        expect(games).toBe(2 + 1 + 2);
        expect(results.realtime).toEqual(realtime);
        expect(results.scores).toHaveLength(2);
    });
});
