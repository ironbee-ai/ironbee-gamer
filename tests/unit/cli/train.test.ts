/**
 * `ibgamer train` as the CLI runs it, up to the training: the daemon's start and the training itself are replaced, so
 * what starts before a training can be read — and without the trainer's CLI, nothing does. The fake runner has no
 * version yet: nothing to check, Train trains (as `--no-check` does, with the trainer's own options).
 */

import { Library } from "../../../src/library/store";
import { Decider, TrainOptions, TrainResult } from "../../../src/train/trainer";
import { fakeGameDefinition } from "../../helpers/fake-game";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** The daemon each run started and stopped ("start", "stop"), and what each training was asked for. */
const mockDaemon: string[] = [];
const mockTrained: TrainOptions[] = [];

jest.mock("../../../src/config/config", (): unknown => ({
    ...jest.requireActual("../../../src/config/config"),
    // No developer's .env.
    loadDotEnv: (): void => undefined,
}));
jest.mock("../../../src/devtools/daemon", (): unknown => ({
    freePort: async (): Promise<number> => 9,
    ensureDaemon: async (): Promise<unknown> => {
        mockDaemon.push("start");
        return {
            baseUrl: "http://127.0.0.1:9",
            owned: true,
            stop: async (): Promise<void> => {
                mockDaemon.push("stop");
            },
        };
    },
}));
jest.mock("../../../src/train/trainer", (): unknown => ({
    ...jest.requireActual("../../../src/train/trainer"),
    Trainer: class {
        async train(options: TrainOptions): Promise<TrainResult> {
            mockTrained.push(options);
            return { bestVersion: 1, savedVersions: [], history: [], stopped: false };
        }
    },
}));
jest.mock("../../../src/server/ui-server", (): unknown => ({ startUiServer: jest.fn() }));

describe("ibgamer train", (): void => {
    const argv: string[] = process.argv;
    let root: string;
    let exits: number[];
    let errors: string[];
    /** The signal listeners before a test: a training adds its own, taken away after. */
    let listening: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-cli-"));
        new Library(path.join(root, "built-in"), path.join(root, "user")).saveGame(fakeGameDefinition());
        process.env.IBGAMER_LIBRARY_DIR = path.join(root, "user");
        mockDaemon.length = 0;
        mockTrained.length = 0;
        exits = [];
        errors = [];
        listening = new Map((["SIGINT", "SIGTERM"] as NodeJS.Signals[]).map((s: NodeJS.Signals): [NodeJS.Signals, NodeJS.SignalsListener[]] => [s, process.listeners(s)]));
        jest.spyOn(process, "exit").mockImplementation(((code?: number): void => {
            exits.push(code ?? 0);
        }) as never);
        jest.spyOn(console, "error").mockImplementation((message: unknown): void => {
            errors.push(String(message));
        });
        jest.spyOn(console, "log").mockImplementation((): void => undefined);
    });

    afterEach((): void => {
        for (const [signal, before] of listening) {
            for (const listener of process.listeners(signal)) {
                if (!before.includes(listener)) {
                    process.removeListener(signal, listener);
                }
            }
        }
        jest.restoreAllMocks();
        process.argv = argv;
        delete process.env.IBGAMER_LIBRARY_DIR;
        delete process.env.CLAUDE_CODE_CLI;
        rmSync(root, { recursive: true, force: true });
    });

    /** `ibgamer train fake-runner <args>` with the trainer's CLI at `claude`, until it ended: refused, or its daemon stopped. */
    async function train(claude: string, args: string[]): Promise<void> {
        process.env.CLAUDE_CODE_CLI = claude;
        process.argv = [process.execPath, "ibgamer", "train", "fake-runner", "--work", path.join(root, "work"), ...args];
        jest.isolateModules((): void => {
            require("../../../src/cli/main");
        });
        for (let i: number = 0; i < 500 && !mockDaemon.includes("stop") && exits.length === 0; i++) {
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, 2);
            });
        }
    }

    it("refuses a training while the trainer's CLI is not there, whatever decides it: before Jev is asked, and before the daemon starts", async (): Promise<void> => {
        const missing: string = path.join(root, "no-claude");
        for (const args of [[], ["--engine", "rules"], ["--no-check", "--decider", "rules"]]) {
            exits.length = 0;
            errors.length = 0;
            await train(missing, args);
            expect(exits).toEqual([1]);
            // Jev has no key here: asked first, it would be the one named.
            expect(errors).toEqual([`The trainer is not ready: ${missing} is not on PATH: training needs the Claude Code CLI`]);
        }
        expect(mockDaemon).toEqual([]);
        expect(mockTrained).toEqual([]);
    });

    it("trains once the trainer's CLI is there, Jev still asked first when it decides", async (): Promise<void> => {
        const claude: string = path.join(root, "claude");
        writeFileSync(claude, "#!/bin/sh\nexit 0\n");
        chmodSync(claude, 0o755);
        await train(claude, ["--engine", "rules"]);
        expect(exits).toEqual([]);
        expect(mockTrained).toEqual([expect.objectContaining({ gameId: "fake-runner", decider: Decider.RULES, workDir: path.join(root, "work") })]);
        expect(mockDaemon).toEqual(["start", "stop"]);

        // Without the check, the trainer's own options: the rules deciding a training for Jev.
        mockDaemon.length = 0;
        mockTrained.length = 0;
        await train(claude, ["--no-check", "--decider", "rules", "--seeds", "4,5"]);
        expect(exits).toEqual([]);
        expect(mockTrained).toEqual([expect.objectContaining({ decider: Decider.RULES, seeds: [4, 5] })]);

        mockDaemon.length = 0;
        mockTrained.length = 0;
        await train(claude, []);
        expect(exits).toEqual([1]);
        expect(errors.join("\n")).toContain("TYPESAFE_API_KEY / JEV_API_KEY is not set");
        expect(mockDaemon).toEqual([]);
        expect(mockTrained).toEqual([]);
    });

    it("tells the trainer the notes given (trimmed), and refuses notes too long for every prompt", async (): Promise<void> => {
        const claude: string = path.join(root, "claude");
        writeFileSync(claude, "#!/bin/sh\nexit 0\n");
        chmodSync(claude, 0o755);
        await train(claude, ["--engine", "rules", "--note", "  use the long bar in the well on the right  "]);
        expect(mockTrained).toEqual([expect.objectContaining({ note: "use the long bar in the well on the right" })]);

        mockDaemon.length = 0;
        mockTrained.length = 0;
        // Commander says why on stderr, then exits (mocked here: it goes on to exit again).
        const said: string[] = [];
        jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => said.push(String(chunk)) > 0) as never);
        await train(claude, ["--engine", "rules", "--note", "x".repeat(2001)]);
        expect(exits[0]).toBe(1);
        expect(said.join("")).toMatch(/--note.*at most 2000 characters/);
        expect(mockTrained).toEqual([]);
    });

    it("keeps the trainer's own options to a training without the check: refused with the check, before anything starts", async (): Promise<void> => {
        const claude: string = path.join(root, "claude");
        writeFileSync(claude, "#!/bin/sh\nexit 0\n");
        chmodSync(claude, 0o755);
        await train(claude, ["--engine", "rules", "--seeds", "1,2", "--decider", "rules"]);
        expect(exits).toEqual([1]);
        expect(errors).toEqual(["--seeds, --decider: the trainer's own, for a training without the check (--no-check)"]);
        expect(mockDaemon).toEqual([]);
        expect(mockTrained).toEqual([]);
    });
});
