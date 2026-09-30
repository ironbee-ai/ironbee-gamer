/**
 * Which Laya server plays: one found on the port is reused only when it serves the very checkpoints
 * asked for (its /health says which directory each model came from, and when the weights it loaded
 * were written), and a server that cannot start fails the start with a clear error, as a fine-tuning
 * that fails does. No Python runs: /health is answered by a fake server, and a shell script stands in
 * for Python where a process must start.
 */

import { LayaServers } from "../../../src/distill/laya-play";
import {
    layaPortHeldByOther,
    LayaPortHeldError,
    layaPortLockFile,
    LayaServerHandle,
    refuseHeldLayaPort,
    refuseLayaServer,
    reusableLayaServer,
    runFinetune,
    startLayaServer,
} from "../../../src/distill/laya-runtime";
import { Library } from "../../../src/library/store";
import { profileHash } from "../../../src/run/decision-log";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";

describe("Laya servers", (): void => {
    let root: string;
    let server: Server | undefined;
    /** What the fake server's /health says. */
    let health: Record<string, unknown> = {};

    /** A fake Laya server answering /health; its port. */
    const serve = async (): Promise<number> => {
        server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
            res.end(JSON.stringify(req.url === "/health" ? health : { detail: "not found" }));
        });
        await new Promise<void>((resolve: () => void): void => {
            (server as Server).listen(0, "127.0.0.1", resolve);
        });
        return ((server as Server).address() as AddressInfo).port;
    };

    /** A checkpoint directory of the fake runner, as distillation leaves one. */
    const checkpoint = (name: string): string => {
        const dir: string = path.join(root, "user", "fake-runner", "laya", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), "x");
        writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
        return dir;
    };

    /** When a checkpoint's weights file was written, as serve.py reports the one it loaded (ns, a decimal string). */
    const stamp = (dir: string): string => String(statSync(path.join(dir, "model.safetensors"), { bigint: true }).mtimeNs);

    /** A port nothing answers on. */
    const unusedPort = async (): Promise<number> => {
        const port: number = await serve();
        await new Promise<void>((resolve: () => void): void => {
            (server as Server).close((): void => resolve());
        });
        server = undefined;
        return port;
    };

    /** A stand-in for Python: a shell script doing `body`, whatever it is asked to run. */
    const fakePython = (body: string): string => {
        const file: string = path.join(root, "python");
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
        return file;
    };

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-laya-runtime-"));
    });

    afterEach(async (): Promise<void> => {
        await new Promise<void>((resolve: () => void): void => {
            if (server) {
                server.close((): void => resolve());
            } else {
                resolve();
            }
        });
        server = undefined;
        health = {};
        rmSync(root, { recursive: true, force: true });
    });

    it("reuses a server that serves the very checkpoint asked for, however its path is spelt", async (): Promise<void> => {
        const dir: string = checkpoint("v1-aaaa-r0");
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": realpathSync(dir) }, weights_mtime_ns: { "fake-runner": stamp(dir) } };
        const port: number = await serve();
        const handle: LayaServerHandle = await startLayaServer({ python: "python-not-used", port, checkpoints: { "fake-runner": dir } });
        expect(handle).toMatchObject({ url: `http://127.0.0.1:${port}`, models: ["fake-runner"] });
        // Not started here: stopping it leaves it running.
        await handle.stop();
        expect((await fetch(`${handle.url}/health`)).ok).toBe(true);
    });

    it("refuses a server that holds another checkpoint of the game, or does not say which", async (): Promise<void> => {
        const wanted: string = checkpoint("v2-bbbb-r0");
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": checkpoint("v1-aaaa-r0") } };
        const port: number = await serve();
        await expect(startLayaServer({ python: "python-not-used", port, checkpoints: { "fake-runner": wanted } })).rejects.toThrow(
            /answers for fake-runner \(.*v1-aaaa-r0\), not fake-runner \(.*v2-bbbb-r0\): stop it/
        );
        // A server from before /health named the directories: which model it holds is not known.
        health = { status: "ok", loaded: ["fake-runner"] };
        await expect(startLayaServer({ python: "python-not-used", port, checkpoints: { "fake-runner": wanted } })).rejects.toThrow(/answers for fake-runner, not/);
    });

    it("keeps one server per checkpoint: another version's server on the port is refused, not played", async (): Promise<void> => {
        const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        // Named as the distiller names them: the version, and the hash of what its states are made of.
        const name: string = `v1-${profileHash(library.saveProfile("fake-runner", { ...fakeProfile() } as never))}`;
        const older: string = checkpoint(`${name}-r0`);
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": older }, weights_mtime_ns: { "fake-runner": stamp(older) } };
        const port: number = await serve();
        const servers: LayaServers = new LayaServers(library, "python-not-used", port);
        await expect(servers.engineFor("fake-runner", 1)).resolves.toMatchObject({ profileVersion: 1 });
        // A newer checkpoint of the version: the server there still holds the older one.
        const newer: string = checkpoint(`${name}-r1`);
        const later: Date = new Date(Date.now() + 60_000);
        utimesSync(path.join(newer, "model.safetensors"), later, later);
        await expect(servers.engineFor("fake-runner", 1)).rejects.toThrow(new RegExp(`${name}-r0\\), not fake-runner \\(.*${name}-r1\\)`));
        // A newer one still, of the version before it was edited in place: not played, whatever the server holds.
        const stale: string = checkpoint("v1-0123abcd-r2");
        const latest: Date = new Date(Date.now() + 120_000);
        utimesSync(path.join(stale, "model.safetensors"), latest, latest);
        await expect(servers.engineFor("fake-runner", 1)).rejects.toThrow(new RegExp(`not fake-runner \\(.*${name}-r1\\)`));
        await servers.stop();
    });

    it("leaves a port a distillation in another process holds: refused, naming it, with nothing started there", async (): Promise<void> => {
        const library: Library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        checkpoint(`v1-${profileHash(library.saveProfile("fake-runner", { ...fakeProfile() } as never))}-r0`);
        const log: string = path.join(root, "python.log");
        // A Python that says what it was asked to serve, and ends.
        const python: string = fakePython(`echo "$@" >> "${log}"`);
        const port: number = await unusedPort();
        const file: string = layaPortLockFile(library, port);
        const since: string = new Date().toISOString();
        const hold: (pid: number) => void = (pid: number): void => {
            writeFileSync(file, JSON.stringify({ pid, holder: "a distillation of fake-runner", since, token: "t" }));
        };
        // A CLI distillation between its students' games (a process that runs: this one's parent): the port is free.
        hold(process.ppid);
        const servers: LayaServers = new LayaServers(library, python, port);
        await expect(servers.engineFor("fake-runner")).rejects.toThrow(
            `Laya port ${port} is held by a distillation of fake-runner (pid ${process.ppid}, since ${since}): wait for it to end, or use another LAYA port ` +
                `(its lock: ${file}; remove it if pid ${process.ppid} is not that run)`
        );
        expect(existsSync(log)).toBe(false);
        // Its process gone (killed while it distilled): the port is this play's.
        hold(spawnSync(process.execPath, ["-e", ""]).pid as number);
        await expect(servers.engineFor("fake-runner")).rejects.toThrow(/The Laya server exited during start/);
        expect(readFileSync(log, "utf-8")).toMatch(/--checkpoint fake-runner=\S*\/laya\/v1-\w+-r0\b/);
        await servers.stop();
    });

    it("fails the start with a clear error when the Python is not there", async (): Promise<void> => {
        // A free port: nothing answers there.
        const port: number = await serve();
        await new Promise<void>((resolve: () => void): void => {
            (server as Server).close((): void => resolve());
        });
        server = undefined;
        await expect(
            startLayaServer({ python: path.join(root, "no-such-python"), port, checkpoints: { "fake-runner": checkpoint("v1-aaaa-r0") } })
        ).rejects.toThrow(/could not be started with .*no-such-python: .*ENOENT/);
    });

    it("says before anything starts whether a server on the port can be reused: none there, the very checkpoint, or refused", async (): Promise<void> => {
        const dir: string = checkpoint("v1-aaaa-r0");
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": dir }, weights_mtime_ns: { "fake-runner": stamp(dir) } };
        const port: number = await serve();
        await expect(reusableLayaServer(port, { "fake-runner": dir })).resolves.toEqual(["fake-runner"]);
        // A checkpoint not made yet (a distillation's first round): the one there is another.
        await expect(reusableLayaServer(port, { "fake-runner": path.join(path.dirname(dir), "v1-aaaa-r1") })).rejects.toThrow(
            /A Laya server on port \d+ answers for fake-runner \(.*v1-aaaa-r0\), not fake-runner \(.*v1-aaaa-r1\): stop it or use another LAYA port/
        );
        await new Promise<void>((resolve: () => void): void => {
            (server as Server).close((): void => resolve());
        });
        server = undefined;
        await expect(reusableLayaServer(port, { "fake-runner": dir })).resolves.toBeUndefined();
    });

    it("refuses a server that loaded the very directory before its checkpoint was made again, or does not say what it loaded", async (): Promise<void> => {
        const dir: string = checkpoint("v1-aaaa-r0");
        // What the server loaded, before the round folder was removed and a later distillation made it again.
        const loaded: string = stamp(dir);
        const later: Date = new Date(Date.now() + 60_000);
        utimesSync(path.join(dir, "model.safetensors"), later, later);
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": dir }, weights_mtime_ns: { "fake-runner": loaded } };
        const port: number = await serve();
        await expect(reusableLayaServer(port, { "fake-runner": dir })).rejects.toThrow(
            /A Laya server on port \d+ answers for fake-runner \(.*v1-aaaa-r0\) with weights loaded before that checkpoint was made again: stop it or use another LAYA port/
        );
        // As it is now: reused.
        health = { ...health, weights_mtime_ns: { "fake-runner": stamp(dir) } };
        await expect(reusableLayaServer(port, { "fake-runner": dir })).resolves.toEqual(["fake-runner"]);
        // A server from before serve.py said when its weights were written: which weights it holds is not known.
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": dir } };
        await expect(reusableLayaServer(port, { "fake-runner": dir })).rejects.toThrow(/answers for fake-runner \(.*v1-aaaa-r0\) without saying which weights it loaded/);
    });

    it("refuses any server on the port for a run that serves checkpoints no server holds yet, saying what it answers for", async (): Promise<void> => {
        const free: number = await unusedPort();
        await expect(refuseLayaServer(free, "it fine-tunes its own")).resolves.toBeUndefined();
        const dir: string = checkpoint("v1-aaaa-r0");
        health = { status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": dir }, weights_mtime_ns: { "fake-runner": stamp(dir) } };
        const port: number = await serve();
        await expect(refuseLayaServer(port, "it fine-tunes its own")).rejects.toThrow(
            /A Laya server on port \d+ answers for fake-runner \(.*v1-aaaa-r0\): it fine-tunes its own — stop it or use another LAYA port/
        );
    });

    it("fails the start at once, with the signal and its last output, when the server is killed while it starts", async (): Promise<void> => {
        const port: number = await unusedPort();
        // As an MPS assertion (SIGABRT) or the OS out of memory (SIGKILL) ends it: no exit code, a signal.
        const python: string = fakePython("echo 'loading the checkpoint'\necho 'Assertion failed: out of memory' >&2\nkill -9 $$");
        const started: number = Date.now();
        await expect(startLayaServer({ python, port, checkpoints: { "fake-runner": checkpoint("v1-aaaa-r0") } })).rejects.toThrow(
            /The Laya server was killed by SIGKILL during start: .*Assertion failed: out of memory/
        );
        // Not after the start's time limit (3 minutes).
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("says why a fine-tuning failed: the last lines it wrote to stderr", async (): Promise<void> => {
        const python: string = fakePython(
            [
                "echo 'rows 10 unique'",
                "echo 'Traceback (most recent call last):' >&2",
                "echo '  File \"finetune.py\", line 74, in resolve_base' >&2",
                "echo '--base must be a checkpoint directory or one of english, multilingual, typed-decisions' >&2",
                "exit 1",
            ].join("\n")
        );
        const failure: Error = await runFinetune({ python, data: [path.join(root, "rows.jsonl")], out: path.join(root, "out"), name: "fake-runner", base: "no-such-base", retries: 0 }).then(
            (): Error => new Error("it did not fail"),
            (err: Error): Error => err
        );
        expect(failure.message).toMatch(/^fine-tuning failed \(exit 1\): Traceback .*--base must be a checkpoint directory/);
        // Its error output only: the progress it printed is not why it failed.
        expect(failure.message).not.toContain("rows 10 unique");
    });
});

describe("a Laya port another process holds", (): void => {
    it("is one whose lock names another process that runs: not this process's own, a gone one's, one from before this machine started, or a file this app did not write", (): void => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-laya-port-"));
        const file: string = path.join(root, ".laya-port-1.lock");
        const now: string = new Date().toISOString();
        const hold: (pid: number, since?: string) => void = (pid: number, since: string = now): void => {
            writeFileSync(file, JSON.stringify({ pid, holder: "a distillation of fake-runner", since, token: "t" }));
        };
        try {
            expect(layaPortHeldByOther(file)).toBeUndefined();
            // This process's own runs are one at a time (the UI's distillation): its hold refuses nothing here.
            hold(process.pid);
            expect(layaPortHeldByOther(file)).toBeUndefined();
            hold(spawnSync(process.execPath, ["-e", ""]).pid as number);
            expect(layaPortHeldByOther(file)).toBeUndefined();
            // A reboot ended its run: the pid it names may be any process's now.
            hold(process.ppid, "2000-01-01T00:00:00.000Z");
            expect(layaPortHeldByOther(file)).toBeUndefined();
            writeFileSync(file, "{");
            expect(layaPortHeldByOther(file)).toBeUndefined();
            expect((): void => refuseHeldLayaPort(file, 1)).not.toThrow();
            hold(process.ppid);
            expect(layaPortHeldByOther(file)).toEqual({ pid: process.ppid, holder: "a distillation of fake-runner", since: now });
            expect((): void => refuseHeldLayaPort(file, 1)).toThrow(LayaPortHeldError);
            expect((): void => refuseHeldLayaPort(file, 1)).toThrow(
                `Laya port 1 is held by a distillation of fake-runner (pid ${process.ppid}, since ${now}): wait for it to end, or use another LAYA port ` +
                    `(its lock: ${file}; remove it if pid ${process.ppid} is not that run)`
            );
            // Only read: the lock stays the holder's.
            expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ pid: process.ppid, token: "t" });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
