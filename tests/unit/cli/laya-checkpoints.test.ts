/**
 * The CLI and a game's Laya checkpoints: `library games` and `laya list` tell those a play takes (that learnt their
 * version as it is now) from the others, and `laya serve` leaves a port a distillation in another process holds. No
 * Laya server starts: its start is replaced, so what it was asked to serve can be read.
 */

import { layaPortLockFile, LayaServerHandle } from "../../../src/distill/laya-runtime";
import { Library } from "../../../src/library/store";
import { profileHash } from "../../../src/run/decision-log";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/** What each `laya serve` asked a server for (model name → checkpoint directory). */
const mockServed: Array<Record<string, string>> = [];

jest.mock("../../../src/config/config", (): unknown => ({
    ...jest.requireActual("../../../src/config/config"),
    // No developer's .env.
    loadDotEnv: (): void => undefined,
}));
jest.mock("../../../src/distill/laya-runtime", (): unknown => ({
    ...jest.requireActual("../../../src/distill/laya-runtime"),
    startLayaServer: async (options: { checkpoints: Record<string, string> }): Promise<LayaServerHandle> => {
        mockServed.push(options.checkpoints);
        return { url: "http://127.0.0.1:9", models: Object.keys(options.checkpoints), stop: async (): Promise<void> => undefined };
    },
}));
jest.mock("../../../src/server/ui-server", (): unknown => ({ startUiServer: jest.fn() }));

describe("the CLI and a game's Laya checkpoints", (): void => {
    const argv: string[] = process.argv;
    let root: string;
    let library: Library;
    let hash: string;
    let exits: number[];
    let errors: string[];
    let printed: string[];
    /** The signal listeners before a test: `laya serve` adds its own, taken away after. */
    let listening: Map<NodeJS.Signals, NodeJS.SignalsListener[]>;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-cli-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        const { version: _, ...draft } = fakeProfile();
        hash = profileHash(library.saveProfile("fake-runner", draft));
        process.env.IBGAMER_LIBRARY_DIR = path.join(root, "user");
        mockServed.length = 0;
        exits = [];
        errors = [];
        printed = [];
        listening = new Map((["SIGINT", "SIGTERM"] as NodeJS.Signals[]).map((s: NodeJS.Signals): [NodeJS.Signals, NodeJS.SignalsListener[]] => [s, process.listeners(s)]));
        jest.spyOn(process, "exit").mockImplementation(((code?: number): void => {
            exits.push(code ?? 0);
        }) as never);
        jest.spyOn(console, "error").mockImplementation((message: unknown): void => {
            errors.push(String(message));
        });
        jest.spyOn(console, "log").mockImplementation((message: unknown): void => {
            printed.push(String(message));
        });
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
        rmSync(root, { recursive: true, force: true });
    });

    /** A checkpoint of the fake runner, as a distillation leaves one. */
    function checkpoint(name: string): string {
        const dir: string = path.join(root, "user", "fake-runner", "laya", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), "");
        writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
        return dir;
    }

    /** `ibgamer <args>`, until it printed, asked for a server or exited. */
    async function run(args: string[]): Promise<void> {
        process.argv = [process.execPath, "ibgamer", ...args];
        jest.isolateModules((): void => {
            require("../../../src/cli/main");
        });
        for (let i: number = 0; i < 500 && printed.length === 0 && mockServed.length === 0 && exits.length === 0; i++) {
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, 2);
            });
        }
    }

    /** The fake runner as `library games` prints it. */
    async function listed(): Promise<{ id: string; hasLaya: boolean } | undefined> {
        printed.length = 0;
        await run(["library", "games"]);
        return (JSON.parse(printed.join("\n")) as Array<{ id: string; hasLaya: boolean }>).find((g: { id: string }): boolean => g.id === "fake-runner");
    }

    it("marks a game's Laya by the checkpoints a play takes, as the UI does: one of its version before it was edited is none", async (): Promise<void> => {
        checkpoint("v1-0badc0de-r1");
        expect(await listed()).toMatchObject({ hasLaya: false });
        checkpoint(`v1-${hash}-r2`);
        expect(await listed()).toMatchObject({ hasLaya: true });
    });

    it("lists every checkpoint, marking those no play takes as stale", async (): Promise<void> => {
        checkpoint("v1-0badc0de-r1");
        checkpoint(`v1-${hash}-r2`);
        // Of a version no longer there.
        checkpoint(`v7-${hash}-r0`);
        await run(["laya", "list"]);
        const line: (name: string) => string | undefined = (name: string): string | undefined => printed.find((l: string): boolean => l.includes(` ${name} `));
        expect(line("v1-0badc0de-r1")).toMatch(/\(stale: its version changed since, or is gone\)$/);
        expect(line(`v7-${hash}-r0`)).toMatch(/\(stale: its version changed since, or is gone\)$/);
        expect(line(`v1-${hash}-r2`)).not.toContain("stale");
    });

    it("serves nothing on a port a distillation in another process holds, naming it; on one whose holder is gone, serves", async (): Promise<void> => {
        const dir: string = checkpoint(`v1-${hash}-r1`);
        const file: string = layaPortLockFile(library, 8765);
        const since: string = new Date().toISOString();
        const hold: (pid: number) => void = (pid: number): void => {
            writeFileSync(file, JSON.stringify({ pid, holder: "a distillation of fake-runner", since, token: "t" }));
        };
        // Between its students' games (a process that runs: this one's parent), the port is free.
        hold(process.ppid);
        await run(["laya", "serve", "--port", "8765"]);
        expect(exits).toEqual([1]);
        expect(errors.join("\n")).toContain(
            `Laya port 8765 is held by a distillation of fake-runner (pid ${process.ppid}, since ${since}): wait for it to end, or use another LAYA port ` +
                `(its lock: ${file}; remove it if pid ${process.ppid} is not that run)`
        );
        expect(mockServed).toHaveLength(0);
        // Killed while it distilled: the port is free to serve on.
        exits.length = 0;
        hold(spawnSync(process.execPath, ["-e", ""]).pid as number);
        await run(["laya", "serve", "--port", "8765"]);
        expect(mockServed).toEqual([{ "fake-runner": dir }]);
        expect(exits).toHaveLength(0);
    });
});
