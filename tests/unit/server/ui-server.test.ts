/**
 * The UI server's run bookkeeping, over HTTP on a port of its own: a run that cannot start leaves no run
 * in progress behind, one run at a time, and nothing started is left behind by close(). No DevTools daemon
 * is started: a run fails before it would be, at a daemon that does not answer, or at a stand-in for one.
 */

import { GamerConfig, loadConfig } from "../../../src/config/config";
import { freePort } from "../../../src/devtools/daemon";
import { layaPortLockFile } from "../../../src/distill/laya-runtime";
import { Profile } from "../../../src/game/types";
import { Library } from "../../../src/library/store";
import { EpisodeResult } from "../../../src/play/player";
import { profileHash } from "../../../src/run/decision-log";
import { keepThumbnail, startUiServer, UiServerHandle } from "../../../src/server/ui-server";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { ClientRequest, IncomingMessage, request } from "http";
import { connect, Socket } from "net";
import { tmpdir } from "os";
import path from "path";

/** A daemon address that does not answer (TEST-NET-1): a run fails there, and no daemon is started for it. */
const UNREACHABLE_DAEMON: string = "http://192.0.2.1:9";

/**
 * A stand-in for the DevTools daemon (its script, started as the daemon is): it answers its health and a session's
 * close, never a tool call (a run or a reader waits on it), and ends on /shutdown. It logs "start <pid>" and "stop <pid>".
 */
const FAKE_DAEMON: string = `const { appendFileSync } = require("fs");
const { createServer } = require("http");
const { join } = require("path");
const log = (what) => appendFileSync(join(__dirname, "daemons.log"), what + " " + process.pid + "\\n");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => {
    if (req.url === "/health" || req.method === "DELETE") {
        res.end("{}");
    } else if (req.url === "/shutdown") {
        log("stop");
        res.end("{}", () => process.exit(0));
    }
}).listen(port, "127.0.0.1", () => log("start"));
`;

function call(port: number, method: string, route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve: (value: { status: number; body: Record<string, unknown> }) => void, reject: (err: Error) => void): void => {
        const origin: string = `http://127.0.0.1:${port}`;
        const req: ClientRequest = request(`${origin}${route}`, { method, headers: { origin, "content-type": "application/json" } }, (res: IncomingMessage): void => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer): void => {
                chunks.push(chunk);
            });
            res.on("end", (): void => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

/** A POST whose body is sent `delayMs` after its headers: the server has let the request in and waits for the body. */
function postLate(port: number, route: string, body: unknown, delayMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve: (value: { status: number; body: Record<string, unknown> }) => void, reject: (err: Error) => void): void => {
        const origin: string = `http://127.0.0.1:${port}`;
        const text: string = JSON.stringify(body);
        const headers: Record<string, string> = { origin, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
        const req: ClientRequest = request(`${origin}${route}`, { method: "POST", headers }, (res: IncomingMessage): void => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer): void => {
                chunks.push(chunk);
            });
            res.on("end", (): void => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") }));
        });
        req.on("error", reject);
        req.flushHeaders();
        setTimeout((): void => {
            req.end(text);
        }, delayMs);
    });
}

/** A request written as raw bytes (a target a client library would not send): what the server answered before it closed. */
function rawRequest(port: number, text: string): Promise<string> {
    return new Promise((resolve: (answer: string) => void, reject: (err: Error) => void): void => {
        const socket: Socket = connect(port, "127.0.0.1", (): void => {
            socket.write(text);
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer): void => {
            chunks.push(chunk);
        });
        socket.on("close", (): void => resolve(Buffer.concat(chunks).toString("utf-8")));
        socket.on("error", reject);
    });
}

/** Waits for `done` (checked every 50 ms), failing after `timeoutMs`. */
async function until(done: () => boolean, what: string, timeoutMs: number = 10_000): Promise<void> {
    const deadline: number = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() > deadline) {
            throw new Error(`waited ${timeoutMs} ms for ${what}`);
        }
        await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, 50);
        });
    }
}

interface TestUi {
    ui: UiServerHandle;
    port: number;
    root: string;
    library: Library;
}

/** A UI server over a library of its own holding the fake runner and one profile of it; `tune` changes its config. */
async function startTestUi(tune: (config: GamerConfig, root: string) => GamerConfig, env: Record<string, string> = {}): Promise<TestUi> {
    const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-"));
    const library: Library = new Library(path.join(root, "none"), path.join(root, "user"));
    library.saveGame(fakeGameDefinition());
    const { version: _, ...draft } = fakeProfile();
    library.saveProfile("fake-runner", draft);
    const port: number = await freePort();
    const config: GamerConfig = { ...loadConfig({ IBGAMER_HOME: root, ...env }), libraryDir: path.join(root, "user"), runsDir: path.join(root, "runs"), ui: { host: "127.0.0.1", port } };
    return { ui: await startUiServer(tune(config, root)), port, root, library };
}

/** The stand-in daemon's script, written in `dir`: what it logged, and an end to any it left up (a test that failed). */
function fakeDaemon(dir: string): { script: string; logged: () => string[]; killAll: () => void } {
    const script: string = path.join(dir, "fake-daemon.js");
    writeFileSync(script, FAKE_DAEMON);
    const log: string = path.join(dir, "daemons.log");
    const logged: () => string[] = (): string[] => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []);
    return {
        script,
        logged,
        killAll: (): void => {
            for (const line of logged()) {
                try {
                    process.kill(Number(line.split(" ")[1]));
                } catch {
                    // gone already
                }
            }
        },
    };
}

/** Whether every run recorded under `root` has ended: an aborted run writes its record last, after close() may have returned. */
function runsEnded(root: string): boolean {
    const dir: string = path.join(root, "runs");
    return (
        !existsSync(dir) ||
        readdirSync(dir).every((id: string): boolean => {
            const file: string = path.join(dir, id, "run.json");
            return !existsSync(file) || (JSON.parse(readFileSync(file, "utf-8")) as { status: string }).status !== "running";
        })
    );
}

/** An executable shell script in `dir` (a stand-in for a Python). */
function script(dir: string, name: string, body: string): string {
    const file: string = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
}

describe("the UI server", (): void => {
    it("leaves no run in progress when a run cannot start (its folder cannot be made): the next one is not refused as busy", async (): Promise<void> => {
        // Root writes into any folder: the failure is not made there.
        if (process.getuid?.() === 0) {
            return;
        }
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-"));
        const library: Library = new Library(path.join(root, "none"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        const { version: _, ...draft } = fakeProfile();
        library.saveProfile("fake-runner", draft);
        const runsDir: string = path.join(root, "runs");
        mkdirSync(runsDir);
        chmodSync(runsDir, 0o500);
        const port: number = await freePort();
        const config: GamerConfig = { ...loadConfig({ IBGAMER_HOME: root }), libraryDir: path.join(root, "user"), runsDir, ui: { host: "127.0.0.1", port } };
        const ui: UiServerHandle = await startUiServer(config);
        try {
            const play: Record<string, unknown> = { gameId: "fake-runner", engine: "jev", pace: "turn" };
            const first: { status: number; body: Record<string, unknown> } = await call(port, "POST", "/api/runs", play);
            expect(first.status).toBe(400);
            expect(String(first.body.error)).toMatch(/EACCES/);
            expect((await call(port, "GET", "/api/runs")).body.current).toBeNull();
            const second: { status: number; body: Record<string, unknown> } = await call(port, "POST", "/api/runs", play);
            expect(second.status).toBe(400);
            expect(String(second.body.error)).not.toMatch(/in progress/);
        } finally {
            await ui.close();
            chmodSync(runsDir, 0o700);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("answers a game definition the library refuses with a 400 naming the field", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-"));
        const port: number = await freePort();
        const config: GamerConfig = { ...loadConfig({ IBGAMER_HOME: root }), libraryDir: path.join(root, "user"), runsDir: path.join(root, "runs"), ui: { host: "127.0.0.1", port } };
        const ui: UiServerHandle = await startUiServer(config);
        try {
            const game: Record<string, unknown> = { ...fakeGameDefinition({ id: "slow-start" }), start: [{ waitMs: 25_000, advanceMs: 500 }] };
            const refused: { status: number; body: Record<string, unknown> } = await call(port, "POST", "/api/games", game);
            expect(refused.status).toBe(400);
            expect(String(refused.body.error)).toMatch(/start\[0\]\.waitMs/);
            const added: { status: number; body: Record<string, unknown> } = await call(port, "POST", "/api/games", { ...game, start: [{ waitMs: 20_000, advanceMs: 500 }] });
            expect(added.status).toBe(201);
        } finally {
            await ui.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("answers a request target that does not parse (`//`) with a 400, and closes such an upgrade, and keeps serving", async (): Promise<void> => {
        const { ui, port, root }: TestUi = await startTestUi((config: GamerConfig): GamerConfig => config);
        try {
            const host: string = `Host: 127.0.0.1:${port}`;
            expect(await rawRequest(port, `GET // HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/);
            const upgrade: string = `GET //@ HTTP/1.1\r\n${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
            expect(await rawRequest(port, upgrade)).toBe("");
            expect((await call(port, "GET", "/api/games")).status).toBe(200);
        } finally {
            await ui.close();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("starts one run of two whose bodies arrive after both were let in: the other is refused as busy", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-daemon-"));
        const daemon: { script: string; logged: () => string[]; killAll: () => void } = fakeDaemon(root);
        // The run that starts stays in progress: its browser's first tool call is never answered.
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, script: daemon.script } }));
        try {
            const play: Record<string, unknown> = { gameId: "fake-runner", engine: "jev", pace: "turn" };
            const answers: Array<{ status: number; body: Record<string, unknown> }> = await Promise.all([
                postLate(t.port, "/api/runs", play, 150),
                postLate(t.port, "/api/runs", play, 150),
            ]);
            expect(answers.map((a: { status: number }): number => a.status).sort()).toEqual([202, 409]);
            expect(answers.find((a: { status: number }): boolean => a.status === 409)?.body.error).toBe("a run is in progress");
            expect((await call(t.port, "GET", "/api/runs")).body.runs).toHaveLength(1);
        } finally {
            await t.ui.close();
            daemon.killAll();
            // The run that began ends on its stopped daemon a moment later: its folder is removed after its record.
            await until((): boolean => runsEnded(t.root), "the run's end").catch((): undefined => undefined);
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("refuses a training Jev would decide while Jev is not ready: a 400 saying why, before any run starts", async (): Promise<void> => {
        // The trainer's CLI is there (a stand-in): what is refused is Jev.
        const t: TestUi = await startTestUi(
            (c: GamerConfig, root: string): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, claude: { ...c.claude, command: script(root, "claude", "exit 0") } })
        );
        try {
            const refused: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "jev" });
            expect(refused.status).toBe(400);
            expect(String(refused.body.error)).toBe("jev (jev-latest) is not ready: TYPESAFE_API_KEY / JEV_API_KEY is not set");
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
            // A game that is not there is said so first.
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "no-such-game", engine: "jev" })).status).toBe(404);
            // For real time only with a fast engine: Jev's hundreds of ms play no game live — refused before Jev is looked at.
            const live: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "jev", realtime: true });
            expect(live.status).toBe(400);
            expect(String(live.body.error)).toMatch(/^Jev answers in hundreds of ms/);
            // Trained for the rules engine (or Laya), the rules as code decide: Jev is not asked.
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules" })).status).toBe(202);
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
        }
    });

    it("refuses any training while the trainer's CLI is not there: a 400 naming it, as the status does, before any run starts", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python that has Laya, for the status.
        const python: string = script(root, "python", "echo laya");
        const missing: string = path.join(root, "no-claude");
        const t: TestUi = await startTestUi(
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, claude: { ...c.claude, command: missing } }),
            { IBGAMER_LAYA_PYTHON: python }
        );
        try {
            const detail: string = `${missing} is not on PATH: training needs the Claude Code CLI`;
            for (const engine of ["rules", "laya", "jev"]) {
                const refused: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine });
                expect(refused).toEqual({ status: 400, body: { error: `The trainer is not ready: ${detail}` } });
            }
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toEqual({ ok: false, detail });
            // A game that is not there is still said so first.
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "no-such-game", engine: "rules" })).status).toBe(404);
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("leaves the Laya port to a distillation in another process: a warm skips it quietly, a play is refused with a 409 naming it", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python that says what it was asked to serve, and ends: no Laya server starts.
        const python: string = script(root, "python", `echo "$@" >> "${path.join(root, "python.log")}"`);
        const layaPort: number = await freePort();
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => c, { IBGAMER_LAYA_PYTHON: python, IBGAMER_LAYA_PORT: String(layaPort) });
        const log: string = path.join(root, "python.log");
        const served: () => boolean = (): boolean => existsSync(log) && readFileSync(log, "utf-8").includes("--checkpoint");
        const file: string = layaPortLockFile(t.library, layaPort);
        const since: string = new Date().toISOString();
        const hold: (pid: number) => void = (pid: number): void => {
            writeFileSync(file, JSON.stringify({ pid, holder: "a distillation of fake-runner", since, token: "t" }));
        };
        try {
            const dir: string = path.join(t.library.userDir, "fake-runner", "laya", `v1-${profileHash(t.library.profile("fake-runner", 1) as Profile)}-r1`);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "model.safetensors"), "");
            writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
            // A CLI distillation between its students' games (a process that runs: this one's parent): the port is free.
            hold(process.ppid);
            expect((await call(t.port, "POST", "/api/laya/warm", { gameId: "fake-runner", version: 1 })).body).toEqual({ warming: false });
            const play: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { gameId: "fake-runner", engine: "laya", pace: "turn", version: 1 });
            expect(play).toEqual({
                status: 409,
                body: {
                    error:
                        `Laya port ${layaPort} is held by a distillation of fake-runner (pid ${process.ppid}, since ${since}): wait for it to end, or use another LAYA port ` +
                        `(its lock: ${file}; remove it if pid ${process.ppid} is not that run)`,
                },
            });
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, 500);
            });
            expect(served()).toBe(false);
            // Its process gone (killed while it distilled): warmed as before.
            hold(spawnSync(process.execPath, ["-e", ""]).pid as number);
            expect((await call(t.port, "POST", "/api/laya/warm", { gameId: "fake-runner", version: 1 })).body).toEqual({ warming: true });
            await until(served, "the Laya server's start");
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("warms Laya with the checkpoint of the version asked for, as a play of that version takes it", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python that says what it was asked to serve, and ends: no Laya server starts.
        const python: string = script(root, "python", `echo "$@" >> "${path.join(root, "python.log")}"`);
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => c, { IBGAMER_LAYA_PYTHON: python, IBGAMER_LAYA_PORT: String(await freePort()) });
        try {
            const { version: _, ...draft } = fakeProfile();
            t.library.saveProfile("fake-runner", draft);
            // v2 is the active version; v1 is the one a config would pin. Each checkpoint learnt its version as it is.
            const hash: string = profileHash(t.library.profile("fake-runner", 1) as Profile);
            for (const name of [`v1-${hash}-r1`, `v2-${hash}-r1`]) {
                const dir: string = path.join(t.library.userDir, "fake-runner", "laya", name);
                mkdirSync(dir, { recursive: true });
                writeFileSync(path.join(dir, "model.safetensors"), "");
                writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
            }
            expect((await call(t.port, "POST", "/api/laya/warm", { gameId: "fake-runner", version: "x" })).status).toBe(400);
            const none: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/laya/warm", { gameId: "fake-runner", version: 3 });
            expect(none.status).toBe(404);
            expect(String(none.body.error)).toMatch(/fake-runner v3 has no Laya checkpoint/);
            expect((await call(t.port, "POST", "/api/laya/warm", { gameId: "fake-runner", version: 1 })).body).toEqual({ warming: true });
            const log: string = path.join(root, "python.log");
            await until((): boolean => existsSync(log), "the Laya server's start");
            expect(readFileSync(log, "utf-8")).toMatch(new RegExp(`--checkpoint fake-runner=\\S*/laya/v1-${hash}-r1\\b`));
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("lists, counts and plays only the Laya checkpoints that learnt their version as it is now", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python that has Laya, and a Laya server that says what it was asked to serve and ends.
        const python: string = script(root, "python", `echo "$@" >> "${path.join(root, "python.log")}"\necho laya`);
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => c, { IBGAMER_LAYA_PYTHON: python, IBGAMER_LAYA_PORT: String(await freePort()) });
        const checkpoint: (name: string) => void = (name: string): void => {
            const dir: string = path.join(t.library.userDir, "fake-runner", "laya", name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "model.safetensors"), "");
            writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
        };
        const offered: () => Promise<{ laya: unknown; card: unknown; status: unknown }> = async (): Promise<{ laya: unknown; card: unknown; status: unknown }> => ({
            laya: ((await call(t.port, "GET", "/api/games/fake-runner")).body.laya as Array<{ name: string }>).map((c: { name: string }): string => c.name),
            card: ((await call(t.port, "GET", "/api/games")).body.games as Array<{ id: string; hasLaya: boolean }>).find((g: { id: string }): boolean => g.id === "fake-runner")?.hasLaya,
            status: ((await call(t.port, "GET", "/api/status")).body.engines as Record<string, { ok: boolean; detail: string }>).laya,
        });
        const play: (version: number) => Promise<{ status: number; body: Record<string, unknown> }> = (version: number): Promise<{ status: number; body: Record<string, unknown> }> =>
            call(t.port, "POST", "/api/runs", { gameId: "fake-runner", engine: "laya", pace: "turn", version });
        try {
            const { version: _, ...draft } = fakeProfile();
            t.library.saveProfile("fake-runner", draft);
            const hash: string = profileHash(t.library.profile("fake-runner", 1) as Profile);
            // Its Python, apart: all a new game chosen for Laya needs (the add-a-game dialog shows it).
            const ready: { ok: boolean; detail: string } = { ok: true, detail: `${python}: laya` };
            // v2's only checkpoint learnt it before it was edited in place: another hash.
            checkpoint("v2-0badc0de-r1");
            expect(await offered()).toEqual({ laya: [], card: false, status: { ok: false, detail: expect.stringMatching(/^no game has a fine-tuned checkpoint yet/), python: ready } });
            const stale: { status: number; body: Record<string, unknown> } = await play(2);
            expect(stale.status).toBe(400);
            expect(String(stale.body.error)).toMatch(/^Fake Runner has no Laya checkpoint yet/);
            checkpoint(`v1-${hash}-r1`);
            expect(await offered()).toEqual({ laya: [`v1-${hash}-r1`], card: true, status: { ok: true, detail: "local, fine-tuned for fake-runner", python: ready } });
            const other: { status: number; body: Record<string, unknown> } = await play(2);
            expect(other.status).toBe(400);
            expect(String(other.body.error)).toMatch(/^Fake Runner v2 has no Laya checkpoint: distill one first \(ibgamer laya distill fake-runner --profile-version 2\)/);
            const played: { status: number; body: Record<string, unknown> } = await play(1);
            expect(played.status).toBe(202);
            expect((played.body.run as { engine: string }).engine).toBe(`laya (fake-runner v1-${hash}-r1)`);
            const log: string = path.join(root, "python.log");
            await until((): boolean => existsSync(log) && readFileSync(log, "utf-8").includes("--checkpoint"), "the Laya server's start");
            expect(readFileSync(log, "utf-8")).toMatch(new RegExp(`--checkpoint fake-runner=\\S*/laya/v1-${hash}-r1\\b`));
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a distillation Laya's Python, or the trainer for rules not yet written as code, is missing for — a 400 saying which —, and one on a port another process holds — a 409 —, before any run starts", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python without Laya until it is given one: a failed check is made again at the next request.
        const python: string = script(root, "python", "exit 1");
        const missing: string = path.join(root, "no-claude");
        const layaPort: number = await freePort();
        const t: TestUi = await startTestUi(
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, claude: { ...c.claude, command: missing } }),
            { IBGAMER_LAYA_PYTHON: python, IBGAMER_LAYA_PORT: String(layaPort) }
        );
        const distill: (gameId?: string) => Promise<{ status: number; body: Record<string, unknown> }> = (gameId: string = "fake-runner"): Promise<{ status: number; body: Record<string, unknown> }> =>
            call(t.port, "POST", "/api/runs", { kind: "distill", gameId });
        const file: string = layaPortLockFile(t.library, layaPort);
        const since: string = new Date().toISOString();
        const hold: (pid: number) => void = (pid: number): void => {
            writeFileSync(file, JSON.stringify({ pid, holder: "a distillation of fake-runner", since, token: "t" }));
        };
        try {
            // A game that is not there is said so first.
            expect((await distill("no-such-game")).status).toBe(404);
            // Laya's Python before the trainer, both missing.
            expect(await distill()).toEqual({ status: 400, body: { error: `${python} cannot import laya: pip install "laya[serve]" (or set IBGAMER_LAYA_PYTHON)` } });
            script(root, "python", "echo laya");
            // v1 has no rules as code: the trainer would write them first.
            expect(await distill()).toEqual({
                status: 400,
                body: { error: `The trainer is not ready: ${missing} is not on PATH: training needs the Claude Code CLI (Fake Runner v1 has no rules as code, and the trainer writes them first)` },
            });
            // v2 (now the active one) has them: no trainer is asked. A distillation in another process (a process that runs:
            // this one's parent) holds the port the distiller serves its students on.
            const { version: _, ...draft } = fakeProfile({ teacher: "function teach(state) { return 'NOOP'; }" });
            t.library.saveProfile("fake-runner", draft);
            hold(process.ppid);
            expect(await distill()).toEqual({
                status: 409,
                body: {
                    error:
                        `Laya port ${layaPort} is held by a distillation of fake-runner (pid ${process.ppid}, since ${since}): wait for it to end, or use another LAYA port ` +
                        `(its lock: ${file}; remove it if pid ${process.ppid} is not that run)`,
                },
            });
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
            // Its process gone: the run begins (and fails at the daemon, which does not answer).
            hold(spawnSync(process.execPath, ["-e", ""]).pid as number);
            expect((await distill()).status).toBe(202);
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("records a distillation that was stopped as stopped, as a stopped play or training is, not as failed", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-daemon-"));
        const daemon: { script: string; logged: () => string[]; killAll: () => void } = fakeDaemon(root);
        // A Python that has Laya after a second: the run's start is still checking it when the run is stopped.
        const python: string = script(root, "python", "sleep 1\necho laya");
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, script: daemon.script } }), {
            IBGAMER_LAYA_PYTHON: python,
            IBGAMER_LAYA_PORT: String(await freePort()),
        });
        try {
            // Its rules as code: the distiller asks no trainer, and meets the stop before the teacher's first game.
            const { version: _, ...draft } = fakeProfile({ teacher: "function teach(state) { return 'NOOP'; }" });
            t.library.saveProfile("fake-runner", draft);
            const started: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "distill", gameId: "fake-runner" });
            expect(started.status).toBe(202);
            expect((await call(t.port, "POST", "/api/runs/stop")).body).toEqual({ stopping: true });
            await until((): boolean => runsEnded(t.root), "the run's end");
            const id: string = String((started.body.run as { id: string }).id);
            const record: Record<string, unknown> = JSON.parse(readFileSync(path.join(t.root, "runs", id, "run.json"), "utf-8")) as Record<string, unknown>;
            expect(record).toMatchObject({ kind: "distill", status: "stopped", phase: "stopped" });
            expect(record).not.toHaveProperty("error");
        } finally {
            await t.ui.close();
            daemon.killAll();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);

    it("starts nothing once closing: a run still starting is waited for and gets no daemon, a reader's daemon is stopped", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-daemon-"));
        const daemon: { script: string; logged: () => string[]; killAll: () => void } = fakeDaemon(root);
        const logged: () => string[] = daemon.logged;
        // A Python that has Laya after a second: a distillation's start is still checking it when close() begins. The
        // trainer's CLI is there (a stand-in): the version has no rules as code, and it would write them first.
        const python: string = script(root, "python", "sleep 1\necho laya");
        const t: TestUi = await startTestUi(
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, script: daemon.script }, claude: { ...c.claude, command: script(root, "claude", "exit 0") } }),
            { IBGAMER_LAYA_PYTHON: python, IBGAMER_LAYA_PORT: String(await freePort()) }
        );
        let closed: boolean = false;
        try {
            // A reader on a browser of its own, waiting on the page's first tool call.
            expect((await call(t.port, "POST", "/api/reader", { url: "http://127.0.0.1:9/game.html" })).status).toBe(202);
            await until((): boolean => logged().length === 1, "the reader's daemon");
            const distill: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "distill", gameId: "fake-runner" });
            expect(distill.status).toBe(202);
            await t.ui.close();
            closed = true;
            const [started, ...rest]: string[] = logged();
            expect(rest).toEqual([started.replace("start", "stop")]);
            const id: string = String((distill.body.run as { id: string }).id);
            const record: { status: string; error?: string } = JSON.parse(readFileSync(path.join(t.root, "runs", id, "run.json"), "utf-8")) as { status: string; error?: string };
            expect(record).toMatchObject({ status: "failed", error: "the UI is closing" });
        } finally {
            if (!closed) {
                await t.ui.close();
            }
            daemon.killAll();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    }, 30_000);
});

describe("a game's thumbnail", (): void => {
    it("is the first end screen a play saved, never written over one there; a copy that fails is logged, not thrown", (): void => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-thumbnail-"));
        const library: Library = new Library(path.join(root, "none"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
        const shot: string = path.join(root, "end.png");
        writeFileSync(shot, "first");
        const episodes: EpisodeResult[] = [{ endScreenshot: shot } as unknown as EpisodeResult];
        const logged: jest.SpyInstance = jest.spyOn(console, "error").mockImplementation((): void => undefined);
        try {
            // A game folder it may not write to (root writes into any): the play ends done all the same.
            if (process.getuid?.() !== 0) {
                const dir: string = library.userDirFor("fake-runner");
                chmodSync(dir, 0o500);
                try {
                    expect((): void => keepThumbnail(library, "fake-runner", episodes)).not.toThrow();
                } finally {
                    chmodSync(dir, 0o700);
                }
                expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^ibgamer ui: the thumbnail of fake-runner was not kept: .*EACCES/));
            }
            keepThumbnail(library, "fake-runner", episodes);
            writeFileSync(shot, "second");
            keepThumbnail(library, "fake-runner", episodes);
            expect(readFileSync(String(library.file("fake-runner", "thumbnail.png")), "utf-8")).toBe("first");
        } finally {
            logged.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
