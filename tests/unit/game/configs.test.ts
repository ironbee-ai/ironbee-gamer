/**
 * The ways a game is played: its own configs, else those its versions earn — live only on a version trained for real
 * time that kept its score there, its inputs held to the lag it was measured at.
 */

import { EngineKind } from "../../../src/engine";
import { LIVE_FLOOR_MS, liveFloorMs, liveReadiness, playConfigs, VersionFacts } from "../../../src/game/configs";
import { ProfileResults } from "../../../src/game/types";
import { fakeGameDefinition } from "../../helpers/fake-game";

/** A version's results: paused, and — given — real time at a lag. */
function results(paused: number, realtime?: number, lagMs?: number): ProfileResults {
    return {
        mean: paused,
        scores: [paused],
        gameSeconds: 10,
        measuredAt: "2026-09-30T00:00:00.000Z",
        ...(realtime !== undefined ? { realtime: { mean: realtime, scores: [realtime], ...(lagMs !== undefined ? { lagMs } : {}) } } : {}),
    };
}

describe("liveFloorMs", (): void => {
    it("is a config's floor, else a lag-aware version's measured lag, else the default; none for a version that is not lag-aware", (): void => {
        expect(liveFloorMs({ lagAware: true, results: results(10, 9, 53) }, { engine: EngineKind.LAYA, live: true, lagMs: 45 })).toBe(45);
        expect(liveFloorMs({ lagAware: true, results: results(10, 9, 53) })).toBe(53);
        expect(liveFloorMs({ lagAware: true, results: results(10) })).toBe(LIVE_FLOOR_MS);
        expect(liveFloorMs({ results: results(10, 9, 53) })).toBeUndefined();
    });
});

describe("playConfigs", (): void => {
    it("keeps a game's own configs as they are", (): void => {
        const configs = [{ engine: EngineKind.RULES }];
        expect(playConfigs(fakeGameDefinition({ configs }), [{ version: 1, lagAware: true, hasTeacher: true, results: results(10, 10, 50) }])).toBe(configs);
    });

    it("offers every engine paused, and live the newest version trained for real time that kept LIVE_SHARE of its score there", (): void => {
        const game = fakeGameDefinition();
        const paused: VersionFacts = { version: 1, hasTeacher: true, results: results(100) };
        expect(playConfigs(game, [paused])).toEqual([{ engine: EngineKind.JEV }, { engine: EngineKind.LAYA }, { engine: EngineKind.RULES }]);
        expect(liveReadiness([paused]).why).toBe("no version is trained for real time");
        // The newest trained version fell short live; an older one did not: that one is played live, pinned, its floor held.
        const short: VersionFacts = { version: 3, lagAware: true, hasTeacher: true, results: results(100, 60, 50) };
        const kept: VersionFacts = { version: 2, lagAware: true, hasTeacher: false, results: results(100, 85, 55) };
        expect(playConfigs(game, [short, kept, paused])).toContainEqual({ engine: EngineKind.LAYA, live: true, version: 2, lagMs: 55 });
        // Its rules are not code: the rules engine cannot play it live.
        expect(playConfigs(game, [short, kept, paused]).some((c): boolean => c.engine === EngineKind.RULES && c.live === true)).toBe(false);
        expect(liveReadiness([short, paused]).why).toBe("v3 plays 60 in real time against 100 paused: better played paused");
        expect(liveReadiness([{ version: 4, lagAware: true, results: results(100) }]).why).toBe("v4 is trained for real time, but its real-time score is not measured");
        // Never Jev live.
        expect(playConfigs(game, [kept]).some((c): boolean => c.engine === EngineKind.JEV && c.live === true)).toBe(false);
    });

    it("measures a version kept for real time only against the active version's paused score, not its own", (): void => {
        const active: VersionFacts = { version: 1, active: true, hasTeacher: true, results: results(70) };
        // 50 in real time: far above its own paused 20, short of 80 % of the 70 the game plays paused.
        expect(liveReadiness([{ version: 2, lagAware: true, liveOnly: true, hasTeacher: true, results: results(20, 50, 53) }, active]).why).toBe(
            "v2 plays 50 in real time against 70 paused: better played paused"
        );
        expect(liveReadiness([{ version: 3, lagAware: true, liveOnly: true, hasTeacher: true, results: results(40, 61, 53) }, active])).toMatchObject({ version: 3, floorMs: 53, pausedMean: 70 });
    });
});
