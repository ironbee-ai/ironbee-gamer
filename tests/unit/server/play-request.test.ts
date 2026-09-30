import { EngineKind } from "../../../src/engine";
import { MAX_EPISODES } from "../../../src/game/validate";
import { Library } from "../../../src/library/store";
import { Pace } from "../../../src/play/player";
import { parsePlayRequest, PlayRequest } from "../../../src/server/ui-server";
import { fakeGameDefinition } from "../../helpers/fake-game";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("a play request", (): void => {
    let root: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-play-request-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("plays any engine with either clock when the game lists no configs", (): void => {
        library.saveGame(fakeGameDefinition());
        const request: PlayRequest = parsePlayRequest({ gameId: "fake-runner", engine: "jev", pace: "realtime" }, library, EngineKind.LAYA);
        expect(request).toMatchObject({ engine: EngineKind.JEV, pace: Pace.REALTIME });
    });

    it("holds to the game's configs, and plays a config's version when none is asked for", (): void => {
        library.saveGame(
            fakeGameDefinition({
                configs: [{ engine: EngineKind.LAYA, live: true }, { engine: EngineKind.RULES }, { engine: EngineKind.JEV, live: true, version: 6 }],
                preferredConfig: { engine: EngineKind.LAYA, live: true },
            })
        );
        expect(parsePlayRequest({ gameId: "fake-runner", engine: "laya", pace: "realtime" }, library, EngineKind.JEV)).toMatchObject({ engine: EngineKind.LAYA });
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", engine: "laya", pace: "watch" }, library, EngineKind.JEV)).toThrow(
            /not played that way; it is played: laya, live; rules, paused; jev, live, v6/
        );
        expect(parsePlayRequest({ gameId: "fake-runner", engine: "jev", pace: "realtime" }, library, EngineKind.JEV).version).toBe(6);
        expect(parsePlayRequest({ gameId: "fake-runner", engine: "jev", pace: "realtime", version: 4 }, library, EngineKind.JEV).version).toBe(4);
    });

    it("refuses a play that names no engine (none was ready to choose) as that, and a kind there is not by the kinds", (): void => {
        library.saveGame(fakeGameDefinition());
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", engine: "" }, library, EngineKind.JEV)).toThrow("no engine is ready to play Fake Runner: none was chosen");
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", engine: "gpt" }, library, EngineKind.JEV)).toThrow("engine must be one of jev, laya, rules");
        // Not sent at all, the server's default plays.
        expect(parsePlayRequest({ gameId: "fake-runner" }, library, EngineKind.RULES).engine).toBe(EngineKind.RULES);
    });

    it("plays as many episodes as a game's budget may name, in whole games", (): void => {
        library.saveGame(fakeGameDefinition({ budgets: { gameSeconds: 30, episodes: MAX_EPISODES } }));
        expect(parsePlayRequest({ gameId: "fake-runner" }, library, EngineKind.JEV).episodes).toBe(MAX_EPISODES);
        expect(parsePlayRequest({ gameId: "fake-runner", episodes: "50" }, library, EngineKind.JEV).episodes).toBe(50);
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", episodes: 51 }, library, EngineKind.JEV)).toThrow(/episodes must be a whole number in \[1, 50\]/);
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", episodes: 2.5 }, library, EngineKind.JEV)).toThrow(/episodes/);
    });

    it("carries a live config's lag floor to the player", (): void => {
        library.saveGame(fakeGameDefinition({ configs: [{ engine: EngineKind.LAYA }, { engine: EngineKind.LAYA, live: true, version: 7, lagMs: 45 }] }));
        expect(parsePlayRequest({ gameId: "fake-runner", engine: "laya", pace: "realtime" }, library, EngineKind.JEV)).toMatchObject({ version: 7, minLagMs: 45 });
        expect(parsePlayRequest({ gameId: "fake-runner", engine: "laya", pace: "turn" }, library, EngineKind.JEV).minLagMs).toBeUndefined();
        expect((): unknown => parsePlayRequest({ gameId: "fake-runner", engine: "rules", pace: "turn" }, library, EngineKind.JEV)).toThrow(/laya, live, v7, inputs ≥ 45 ms/);
    });
});
