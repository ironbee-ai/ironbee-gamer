/**
 * `ibgamer laya distill` as the CLI runs it, up to the distillation: what starts a process (the daemon, the Python
 * check) and the distillation itself are replaced, so the options can be read as the distiller would get them — and
 * what is refused before the daemon starts.
 */

import { DistillOptions, DistillResult } from "../../../src/distill/distiller";
import { Library } from "../../../src/library/store";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** What each run asked the distiller for, the daemons it started, what the Python check answers, and the teacher a distillation reports. */
const mockDistilled: DistillOptions[] = [];
const mockDaemon: string[] = [];
const mockPython: { ok: boolean; detail: string } = { ok: true, detail: "python: laya" };
const mockTaught: { teacher: string } = { teacher: "rules v1" };

jest.mock("../../../src/config/config", (): unknown => ({
    ...jest.requireActual("../../../src/config/config"),
    // No developer's .env.
    loadDotEnv: (): void => undefined,
}));
jest.mock("../../../src/devtools/daemon", (): unknown => ({
    freePort: async (): Promise<number> => 9,
    ensureDaemon: async (): Promise<unknown> => {
        mockDaemon.push("start");
        return { baseUrl: "http://127.0.0.1:9", owned: true, stop: async (): Promise<void> => undefined };
    },
}));
jest.mock("../../../src/distill/laya-runtime", (): unknown => ({
    ...jest.requireActual("../../../src/distill/laya-runtime"),
    checkLayaPython: async (): Promise<{ ok: boolean; detail: string }> => ({ ...mockPython }),
}));
jest.mock("../../../src/distill/distiller", (): unknown => ({
    ...jest.requireActual("../../../src/distill/distiller"),
    Distiller: class {
        async distill(options: DistillOptions): Promise<DistillResult> {
            mockDistilled.push(options);
            return { checkpoint: "v1-abc-r0", teacher: mockTaught.teacher, profileVersion: 1, teacherRows: 0, daggerRows: 0 };
        }
    },
}));
jest.mock("../../../src/server/ui-server", (): unknown => ({ startUiServer: jest.fn() }));

describe("ibgamer laya distill", (): void => {
    const argv: string[] = process.argv;
    let root: string;
    let exits: number[];
    let errors: string[];
    let logs: string[];

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-cli-"));
        new Library(path.join(root, "built-in"), path.join(root, "user")).saveGame(fakeGameDefinition());
        process.env.IBGAMER_LIBRARY_DIR = path.join(root, "user");
        mockDistilled.length = 0;
        mockDaemon.length = 0;
        Object.assign(mockPython, { ok: true, detail: "python: laya" });
        mockTaught.teacher = "rules v1";
        exits = [];
        errors = [];
        logs = [];
        jest.spyOn(process, "exit").mockImplementation(((code?: number): void => {
            exits.push(code ?? 0);
        }) as never);
        jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => errors.push(String(chunk)) > 0);
        jest.spyOn(console, "error").mockImplementation((message: unknown): void => {
            errors.push(String(message));
        });
        jest.spyOn(console, "log").mockImplementation((message: unknown): void => {
            logs.push(String(message));
        });
    });

    afterEach((): void => {
        jest.restoreAllMocks();
        process.argv = argv;
        delete process.env.IBGAMER_LIBRARY_DIR;
        delete process.env.CLAUDE_CODE_CLI;
        rmSync(root, { recursive: true, force: true });
    });

    /** `ibgamer laya distill fake-runner <args>`, until it asked for a distillation or exited. */
    async function distill(args: string[]): Promise<DistillOptions | undefined> {
        process.argv = [process.execPath, "ibgamer", "laya", "distill", "fake-runner", "--work", path.join(root, "work"), ...args];
        jest.isolateModules((): void => {
            require("../../../src/cli/main");
        });
        for (let i: number = 0; i < 500 && mockDistilled.length === 0 && exits.length === 0; i++) {
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, 2);
            });
        }
        return mockDistilled[0];
    }

    /** A profile version of the fake runner in the test's library (the newest is the active one). */
    function saveProfile(teacher?: string): void {
        const { version: _, ...draft } = fakeProfile(teacher ? { teacher } : {});
        new Library(path.join(root, "built-in"), path.join(root, "user")).saveProfile("fake-runner", draft);
    }

    it("passes --lag on as parsed for `play --lag`: a range, or one lag", async (): Promise<void> => {
        expect(await distill(["--lag", "45-60"])).toMatchObject({ gameId: "fake-runner", lag: { minMs: 45, maxMs: 60 }, workDir: path.join(root, "work") });
        mockDistilled.length = 0;
        expect((await distill(["--lag", "50"]))?.lag).toEqual({ minMs: 50, maxMs: 50 });
    });

    it("asks for no lag without --lag", async (): Promise<void> => {
        const options: DistillOptions | undefined = await distill([]);
        expect(options).toMatchObject({ gameId: "fake-runner" });
        expect(options).not.toHaveProperty("lag");
    });

    it("refuses a lag `play --lag` refuses, before anything starts", async (): Promise<void> => {
        expect(await distill(["--lag", "60-45"])).toBeUndefined();
        expect(exits[0]).toBe(1);
        expect(errors.join("")).toContain("latency is ms (35) or a range of ms (250-600), at most 2000");
    });

    it("refuses a version without its rules as code while the trainer's CLI is not there, which would write them: after Laya's Python, before the daemon starts", async (): Promise<void> => {
        saveProfile();
        const missing: string = path.join(root, "no-claude");
        process.env.CLAUDE_CODE_CLI = missing;
        // Laya's Python is checked first.
        Object.assign(mockPython, { ok: false, detail: "python3 cannot import laya" });
        expect(await distill([])).toBeUndefined();
        expect(exits).toEqual([1]);
        expect(errors).toEqual(["python3 cannot import laya (or point IBGAMER_LAYA_PYTHON at a Python that has it)"]);
        exits.length = 0;
        errors.length = 0;
        Object.assign(mockPython, { ok: true, detail: "python: laya" });
        expect(await distill([])).toBeUndefined();
        expect(exits).toEqual([1]);
        expect(errors).toEqual([`The trainer is not ready: ${missing} is not on PATH: training needs the Claude Code CLI (Fake Runner v1 has no rules as code, and the trainer writes them first)`]);
        expect(mockDaemon).toEqual([]);
    });

    it("asks for no trainer when none would write: the version has its rules as code, an engine teaches, or a resume (refused by the distiller instead)", async (): Promise<void> => {
        saveProfile();
        process.env.CLAUDE_CODE_CLI = path.join(root, "no-claude");
        // An engine teaches: Jev is what is asked for (it has no key here), not the trainer.
        expect(await distill(["--teacher", "engine"])).toBeUndefined();
        expect(exits).toEqual([1]);
        expect(errors.join("\n")).toContain("TYPESAFE_API_KEY / JEV_API_KEY is not set");
        expect(errors.join("\n")).not.toContain("trainer");
        exits.length = 0;
        // A resume of a version without its rules as code: the distiller refuses it, and no trainer is asked.
        expect(await distill(["--resume"])).toMatchObject({ gameId: "fake-runner", resume: true });
        mockDistilled.length = 0;
        // v2 has them.
        saveProfile("function teach(state) { return 'NOOP'; }");
        expect(await distill([])).toMatchObject({ gameId: "fake-runner" });
        expect(exits).toEqual([]);
        expect(mockDaemon).toEqual(["start", "start"]);
    });

    it("names the teacher the checkpoint was taught by, and leaves that out when none is known (a resumed checkpoint whose record names none)", async (): Promise<void> => {
        await distill([]);
        expect(logs).toContain("checkpoint v1-abc-r0 (profile v1, taught by rules v1)");
        mockDistilled.length = 0;
        logs.length = 0;
        mockTaught.teacher = "";
        await distill(["--resume"]);
        expect(logs).toContain("checkpoint v1-abc-r0 (profile v1)");
    });
});
