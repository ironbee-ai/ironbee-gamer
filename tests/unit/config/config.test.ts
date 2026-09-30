import { DEFAULT_UI_PORT, GamerConfig, layaVenvPython, loadConfig } from "../../../src/config/config";
import { EngineKind } from "../../../src/engine";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("loadConfig", (): void => {
    it("defaults: Jev, the UI on 1986, headless, ~/.ibgamer", (): void => {
        const config: GamerConfig = loadConfig({ HOME: "/home/u", IBGAMER_HOME: "/home/u/.ibgamer" });
        expect(DEFAULT_UI_PORT).toBe(1986);
        expect(config.ui).toEqual({ host: "127.0.0.1", port: 1986 });
        expect(config.engine.kind).toBe(EngineKind.JEV);
        expect(config.engine.laya.url).toBe("http://127.0.0.1:8000");
        expect(config.daemon.headless).toBe(true);
        expect(config.libraryDir).toBe("/home/u/.ibgamer/library");
        expect(config.runsDir).toBe("/home/u/.ibgamer/runs");
        expect(config.claude).toEqual({ command: "claude", model: "opus" });
    });

    it("reads the engine, its keys and the places from the environment", (): void => {
        const config: GamerConfig = loadConfig({
            IBGAMER_ENGINE: "laya",
            LAYA_URL: "http://gpu:8000",
            LAYA_MODEL: "dino",
            JEV_API_KEY: "k",
            IBGAMER_UI_PORT: "2000",
            IBGAMER_HEADLESS: "false",
            IBGAMER_LIBRARY_DIR: "/lib",
        });
        expect(config.engine).toMatchObject({ kind: EngineKind.LAYA, jev: { apiKey: "k" }, laya: { url: "http://gpu:8000", model: "dino" } });
        expect(config.ui.port).toBe(2000);
        expect(config.daemon.headless).toBe(false);
        expect(config.libraryDir).toBe("/lib");
        expect((): GamerConfig => loadConfig({ IBGAMER_ENGINE: "other" })).toThrow(/IBGAMER_ENGINE/);
        expect((): GamerConfig => loadConfig({ IBGAMER_UI_PORT: "0" })).toThrow(/port/);
    });

    it("finds Laya's Python when it is used: the environment's, else the one laya setup made since, else python3", (): void => {
        const home: string = mkdtempSync(path.join(tmpdir(), "ibgamer-config-"));
        try {
            const config: GamerConfig = loadConfig({ IBGAMER_HOME: home });
            expect(config.layaRuntime.python).toBe("python3");
            mkdirSync(path.dirname(layaVenvPython(home)), { recursive: true });
            writeFileSync(layaVenvPython(home), "");
            expect(config.layaRuntime.python).toBe(layaVenvPython(home));
            expect(loadConfig({ IBGAMER_HOME: home, IBGAMER_LAYA_PYTHON: "/opt/laya/bin/python" }).layaRuntime.python).toBe("/opt/laya/bin/python");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("reads the trainer's time limit in minutes as whole milliseconds, and refuses one that is not a number", (): void => {
        expect(loadConfig({ IBGAMER_TRAINER_TIMEOUT_MINUTES: "30" }).claude.timeoutMs).toBe(1_800_000);
        expect(loadConfig({ IBGAMER_TRAINER_TIMEOUT_MINUTES: "1.33" }).claude.timeoutMs).toBe(79_800);
        expect(loadConfig({ IBGAMER_TRAINER_TIMEOUT_MINUTES: "0.5" }).claude.timeoutMs).toBe(60_000);
        expect(loadConfig({ IBGAMER_TRAINER_TIMEOUT_MINUTES: "" }).claude.timeoutMs).toBeUndefined();
        for (const bad of ["30m", "0", "-5", "Infinity", "1e9"]) {
            expect((): GamerConfig => loadConfig({ IBGAMER_TRAINER_TIMEOUT_MINUTES: bad })).toThrow(/IBGAMER_TRAINER_TIMEOUT_MINUTES/);
        }
    });
});
