import { Adapter } from "../../../src/devtools/protocol";
import { openRequest, rawFormat } from "../../../src/game/open";
import { Perception } from "../../../src/game/types";
import { InvalidDefinitionError, MAX_EPISODES, validateGame, validateProfile, validateRegressionTest } from "../../../src/game/validate";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

describe("validateGame", (): void => {
    it("accepts a game and keeps only what it knows", (): void => {
        const game: Record<string, unknown> = { ...fakeGameDefinition(), extra: "dropped", start: [{ press: ["Space"], advanceMs: 100 }] };
        expect(validateGame(game)).toEqual({ ...fakeGameDefinition(), start: [{ press: ["Space"], advanceMs: 100 }] });
    });

    it("lets a Phaser game read its own state, the adapter still installed", (): void => {
        const perception = { adapter: "phaser", read: "window.__ibgamer.phaser.game().scene.getScene('x').board", format: "the board" };
        const game = validateGame({ ...fakeGameDefinition(), perception });
        expect(game.perception).toEqual({ ...perception, adapter: Perception.PHASER });
        expect(openRequest(game)).toMatchObject({ adapters: [Adapter.PHASER], read: perception.read });
        expect(rawFormat(game)).toBe("the board");
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "phaser", read: "x" } })).toThrow(/perception\.format/);
    });

    it("reads a Three.js game by its scene, or by its own state with the adapter still installed", (): void => {
        const plain = validateGame({ ...fakeGameDefinition(), perception: { adapter: "three" } });
        expect(plain.perception).toEqual({ adapter: Perception.THREE });
        expect(openRequest(plain)).toMatchObject({ adapters: [Adapter.THREE], read: "window.__ibgamer.three.dump()" });
        expect(rawFormat(plain)).toMatch(/Three\.js scene/);
        const perception = { adapter: "three", read: "window.__ibgamer.three.scene().getObjectByName('car').userData", format: "the car" };
        const own = validateGame({ ...fakeGameDefinition(), perception });
        expect(openRequest(own)).toMatchObject({ adapters: [Adapter.THREE], read: perception.read });
        expect(rawFormat(own)).toBe("the car");
    });

    it("reads a game by its pixels, as a colour grid of the size it asks for", (): void => {
        const plain = validateGame({ ...fakeGameDefinition(), perception: { adapter: "pixels" } });
        expect(plain.perception).toEqual({ adapter: Perception.PIXELS });
        expect(openRequest(plain)).toMatchObject({ adapters: [Adapter.PIXELS], read: "window.__ibgamer.pixels.grab(64)" });
        const sized = validateGame({ ...fakeGameDefinition(), perception: { adapter: "pixels", grid: { width: 48, height: 27 } } });
        expect(sized.perception.grid).toEqual({ width: 48, height: 27 });
        expect(openRequest(sized).read).toBe("window.__ibgamer.pixels.grab(48, 27)");
        expect(rawFormat(sized)).toMatch(/3 hex digits a cell/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "pixels", grid: { width: 4 } } })).toThrow(/perception\.grid\.width/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "pixels", grid: { width: 64, height: 400 } } })).toThrow(/perception\.grid\.height/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "pixels", grid: 64 } })).toThrow(/perception\.grid/);
    });

    it("takes a real-time wait in the start steps, up to the UI's longest loading time", (): void => {
        const start = [{ press: ["Space"], advanceMs: 700 }, { waitMs: 1000 }, { advanceMs: 800 }];
        expect(validateGame({ ...fakeGameDefinition(), start }).start).toEqual(start);
        expect(validateGame({ ...fakeGameDefinition(), start: [{ waitMs: 20_000, advanceMs: 500 }] }).start).toEqual([{ waitMs: 20_000, advanceMs: 500 }]);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), start: [{ waitMs: 20_001 }] })).toThrow(/start\[0\]\.waitMs: must be a number in \[0, 20000\]/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), start: [{ waitMs: 60_000 }] })).toThrow(/start\[0\]\.waitMs/);
    });

    it("takes the steps that resume a game waiting between rounds, checked like the start's", (): void => {
        const resume = [{ click: true, advanceMs: 500 }];
        expect(validateGame({ ...fakeGameDefinition(), resume }).resume).toEqual(resume);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), resume: { click: true } })).toThrow(/resume/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), resume: [{ waitMs: 60_000 }] })).toThrow(/resume\[0\]\.waitMs/);
    });

    it("takes a plan of moments for a slow engine, within bounds", (): void => {
        const base = { ...fakeProfile(), plan: { slots: 8, slotMs: 50 } };
        expect(validateProfile(base).plan).toEqual({ slots: 8, slotMs: 50 });
        expect((): unknown => validateProfile({ ...base, plan: { slots: 1, slotMs: 50 } })).toThrow(/plan\.slots/);
        expect((): unknown => validateProfile({ ...base, plan: { slots: 8, slotMs: 5_000 } })).toThrow(/plan\.slotMs/);
        expect((): unknown => validateProfile({ ...base, plan: { slots: 2.5, slotMs: 50 } })).toThrow(/plan\.slots/);
    });

    it("takes the ways a game is played, and the one it starts with, which must be one of them", (): void => {
        const configs = [{ engine: "laya", live: true }, { engine: "rules" }, { engine: "jev", live: true, version: 6 }];
        const game = validateGame({ ...fakeGameDefinition(), configs, preferredConfig: { engine: "laya", live: true } });
        expect(game.configs).toEqual(configs);
        expect(game.preferredConfig).toEqual({ engine: "laya", live: true });
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [{ engine: "laya" }, { engine: "laya", live: false }] })).toThrow(/same clock twice/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs, preferredConfig: { engine: "laya" } })).toThrow(/preferredConfig.*one of the configs/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [{ engine: "gpt" }] })).toThrow(/configs\[0\]\.engine/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [] })).toThrow(/configs/);
    });

    it("takes game time in whole milliseconds only: a profile's tick, a start step's wait and advance", (): void => {
        expect((): unknown => validateGame({ ...fakeGameDefinition(), start: [{ advanceMs: 33.3 }] })).toThrow(/start\[0\]\.advanceMs.*whole/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), resume: [{ waitMs: 0.5 }] })).toThrow(/resume\[0\]\.waitMs.*whole/);
        expect((): unknown => validateProfile({ ...fakeProfile(), tickMs: 16.67 })).toThrow(/tickMs.*whole/);
        expect(validateProfile({ ...fakeProfile(), tickMs: 16 }).tickMs).toBe(16);
    });

    it("takes budgets in whole seconds and games, as many games as the UI and the CLI play", (): void => {
        const budgets: (b: Record<string, unknown>) => () => unknown = (b: Record<string, unknown>): (() => unknown) => (): unknown => validateGame({ ...fakeGameDefinition(), budgets: b });
        expect(budgets({ gameSeconds: 60, episodes: MAX_EPISODES, trainSeconds: 90 })()).toMatchObject({ budgets: { gameSeconds: 60, episodes: 50, trainSeconds: 90 } });
        expect(budgets({ gameSeconds: 60, episodes: 51 })).toThrow(/budgets\.episodes: must be a number in \[1, 50\]/);
        expect(budgets({ gameSeconds: 60, episodes: 1.5 })).toThrow(/budgets\.episodes: must be a whole number/);
        expect(budgets({ gameSeconds: 59.5, episodes: 1 })).toThrow(/budgets\.gameSeconds: must be a whole number/);
        expect(budgets({ gameSeconds: 60, episodes: 1, trainSeconds: 45.2 })).toThrow(/budgets\.trainSeconds: must be a whole number/);
    });

    it("takes the boot time in whole milliseconds and the viewport in whole pixels, as game_open does", (): void => {
        expect(validateGame({ ...fakeGameDefinition(), bootMs: 2500, viewport: { width: 800, height: 600 } })).toMatchObject({ bootMs: 2500, viewport: { width: 800, height: 600 } });
        expect((): unknown => validateGame({ ...fakeGameDefinition(), bootMs: 2500.5 })).toThrow(/bootMs.*whole/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), viewport: { width: 800.5, height: 600 } })).toThrow(/viewport\.width.*whole/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), viewport: { width: 800, height: 599.9 } })).toThrow(/viewport\.height.*whole/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), viewport: { width: 50, height: 600 } })).toThrow(/viewport\.width/);
    });

    it("takes a page style for the game's page, as text of a page's length", (): void => {
        expect(validateGame({ ...fakeGameDefinition(), pageStyle: "#controls { display: none }" }).pageStyle).toBe("#controls { display: none }");
        expect((): unknown => validateGame({ ...fakeGameDefinition(), pageStyle: " " })).toThrow(/pageStyle/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), pageStyle: "x".repeat(20_001) })).toThrow(/pageStyle.*at most/);
    });

    it("takes a start step whose held keys a page expression names, and nothing else there", (): void => {
        const start = [{ hold: ["s"], advanceMs: 500 }, { holdFrom: "window.nextKey()", advanceMs: 300 }];
        expect(validateGame({ ...fakeGameDefinition(), start }).start).toEqual(start);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), start: [{ holdFrom: 3 }] })).toThrow(/start\[0\]\.holdFrom/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), resume: [{ holdFrom: " " }] })).toThrow(/resume\[0\]\.holdFrom/);
    });

    it("takes a live config's lag floor, and only a live one's", (): void => {
        const live = { engine: "laya", live: true, version: 7, lagMs: 45 };
        expect(validateGame({ ...fakeGameDefinition(), configs: [live] }).configs).toEqual([live]);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [{ engine: "laya", lagMs: 45 }] })).toThrow(/configs\[0\]\.lagMs.*live config/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [{ ...live, lagMs: 5_000 }] })).toThrow(/configs\[0\]\.lagMs/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), configs: [{ ...live, lagMs: -1 }] })).toThrow(/configs\[0\]\.lagMs/);
    });

    it("takes the version a game names active until one is set, a version number", (): void => {
        expect(validateGame({ ...fakeGameDefinition(), activeVersion: 6 }).activeVersion).toBe(6);
        expect(validateGame(fakeGameDefinition()).activeVersion).toBeUndefined();
        for (const bad of [0, 1.5, "6"]) {
            expect((): unknown => validateGame({ ...fakeGameDefinition(), activeVersion: bad })).toThrow(/activeVersion/);
        }
    });

    it("names the field that is wrong", (): void => {
        expect((): unknown => validateGame({ ...fakeGameDefinition(), id: "Bad Id" })).toThrow(/game\.json\.id/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), url: "javascript:alert(1)" })).toThrow(/url/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), score: { label: "x" } })).toThrow(/expression, or fromState/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "webgl" } })).toThrow(/perception\.adapter/);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), perception: { adapter: "custom", read: "x", script: "../x.js" } })).toThrow(InvalidDefinitionError);
        expect((): unknown => validateGame({ ...fakeGameDefinition(), budgets: { gameSeconds: 0, episodes: 1 } })).toThrow(/gameSeconds/);
    });
});

describe("validateProfile", (): void => {
    it("accepts a profile, defaulting decideOn to tick and tests to none", (): void => {
        const { decideOn: _d, tests: _t, ...rest } = fakeProfile();
        expect(validateProfile(rest)).toMatchObject({ decideOn: "tick", tests: [] });
    });

    it("refuses duplicate or missing actions and a tick out of range", (): void => {
        const p: Record<string, unknown> = { ...fakeProfile() };
        expect((): unknown => validateProfile({ ...p, actions: [] })).toThrow(/actions/);
        expect((): unknown => validateProfile({ ...p, actions: [{ id: "A", description: "a" }, { id: "A", description: "b" }] })).toThrow(/distinct/);
        expect((): unknown => validateProfile({ ...p, tickMs: 1 })).toThrow(/tickMs/);
        expect((): unknown => validateProfile({ ...p, decideOn: "sometimes" })).toThrow(/decideOn/);
    });

    it("takes a click at the centre or at a point of the game, as fractions", (): void => {
        const p: Record<string, unknown> = { ...fakeProfile() };
        const actions = [
            { id: "A", description: "a", click: true },
            { id: "B", description: "b", click: { x: 0.25, y: 0.5 } },
        ];
        expect(validateProfile({ ...p, actions }).actions).toEqual(actions);
        expect((): unknown => validateProfile({ ...p, actions: [{ id: "A", description: "a", click: { x: 2, y: 0 } }] })).toThrow(/click\.x/);
        expect((): unknown => validateProfile({ ...p, actions: [{ id: "A", description: "a", click: "left" }] })).toThrow(/click/);
    });

    it("takes a held pointer at the centre or at a point", (): void => {
        const p: Record<string, unknown> = { ...fakeProfile() };
        const actions = [
            { id: "A", description: "a", pointer: true },
            { id: "B", description: "b", pointer: { x: 0.5, y: 0.9 } },
        ];
        expect(validateProfile({ ...p, actions }).actions).toEqual(actions);
        expect((): unknown => validateProfile({ ...p, actions: [{ id: "A", description: "a", pointer: { x: 0.5, y: -1 } }] })).toThrow(/pointer\.y/);
    });

    it("checks a regression test's frames", (): void => {
        expect(validateRegressionTest({ window: "w", ticks: [1, 2], expect: "true" })).toEqual({ window: "w", ticks: [1, 2], expect: "true" });
        expect((): unknown => validateRegressionTest({ window: "w", ticks: "some", expect: "true" })).toThrow(/ticks/);
    });

    it("takes a version's results as training records them, keeping fields it does not know", (): void => {
        const results: Record<string, unknown> = {
            mean: 30.5,
            scores: [30, 31],
            seeds: [101, 202],
            gameSeconds: 45,
            measuredAt: "2026-09-29T10:00:00.000Z",
            realtime: { mean: 20, scores: [19, 21], lagMs: 35 },
            test: { mean: 28, scores: [27, 29], seeds: [1001, 2002] },
            random: { mean: 2, scores: [1, 3] },
            note: "kept",
        };
        expect(validateProfile({ ...fakeProfile(), results }).results).toEqual(results);
        // Trained for real time: the unseen seeds as training played them, beside the real-time scores.
        const realtime: Record<string, unknown> = { ...results, test: undefined, realtime: { mean: 20, scores: [19, 21], lagMs: 35, test: { mean: 18, scores: [17, 19], seeds: [1001, 2002] } } };
        delete realtime.test;
        expect(validateProfile({ ...fakeProfile(), results: realtime }).results).toEqual(realtime);
        const minimal: Record<string, unknown> = { mean: 5, scores: [5], gameSeconds: 5, measuredAt: "x" };
        expect(validateProfile({ ...fakeProfile(), results: minimal }).results).toEqual(minimal);
        expect(validateProfile(fakeProfile()).results).toBeUndefined();
    });

    it("refuses results the UI or a replay could not use, naming the field", (): void => {
        const base: Record<string, unknown> = { mean: 5, scores: [5], seeds: [1], gameSeconds: 5, measuredAt: "x" };
        const bad: (results: unknown) => () => unknown = (results: unknown): (() => unknown) => (): unknown => validateProfile({ ...fakeProfile(), results });
        expect(bad({ ...base, mean: "<img src=x onerror=alert(1)>" })).toThrow(/results\.mean/);
        expect(bad({ ...base, mean: null })).toThrow(/results\.mean/);
        expect(bad({ mean: 5 })).toThrow(/results\.scores/);
        expect(bad({ ...base, scores: [5, "6"] })).toThrow(/results\.scores/);
        expect(bad({ ...base, seeds: "101" })).toThrow(/results\.seeds/);
        expect(bad({ ...base, seeds: [1.5] })).toThrow(/results\.seeds/);
        expect(bad({ ...base, gameSeconds: "45" })).toThrow(/results\.gameSeconds/);
        expect(bad({ ...base, measuredAt: 1 })).toThrow(/results\.measuredAt/);
        expect(bad({ ...base, realtime: { mean: 5 } })).toThrow(/results\.realtime\.scores/);
        expect(bad({ ...base, realtime: { mean: 5, scores: [5], lagMs: "35" } })).toThrow(/results\.realtime\.lagMs/);
        expect(bad({ ...base, test: { mean: 5, scores: [5] } })).toThrow(/results\.test\.seeds/);
        expect(bad({ ...base, realtime: { mean: 5, scores: [5], test: { mean: 5, scores: [5] } } })).toThrow(/results\.realtime\.test\.seeds/);
        expect(bad({ ...base, realtime: { mean: 5, scores: [5], test: { mean: "5", scores: [5], seeds: [1] } } })).toThrow(/results\.realtime\.test\.mean/);
        expect(bad({ ...base, random: [] })).toThrow(/results\.random/);
        expect(bad("30")).toThrow(/results/);
        expect(bad(null)).toThrow(/results/);
    });
});
