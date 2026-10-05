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
import { TrainerProvider } from "../../../src/train/claude";
import { noteTrainerModel } from "../../../src/train/trainer-cli";
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
            (c: GamerConfig, root: string): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, trainer: { ...c.trainer, command: script(root, "claude", "exit 0") } })
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
            // Notes for the trainer: text, at most 2000 characters (they go into every prompt), refused before anything starts.
            const long: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules", note: "x".repeat(2001) });
            expect(long.status).toBe(400);
            expect(String(long.body.error)).toMatch(/^note must be at most 2000 characters/);
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules", note: 7 })).status).toBe(400);
            // Trained for the rules engine (or Laya), the rules as code decide: Jev is not asked. The notes ride with the run.
            const started: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules", note: "  keep low  " });
            expect(started.status).toBe(202);
            expect((started.body.run as { settings: { note?: string } }).settings.note).toBe("keep low");
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
        }
    });

    it("asks the Claude Code CLI which models its aliases stand for, when asked to, and names them as they are read", async (): Promise<void> => {
        const tools: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-aliases-"));
        // A stand-in CLI that says the model an alias stands for at its start, as the real one does.
        const claude: string = script(
            tools,
            "claude",
            'M=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--model" ]; then M="$2"; fi; shift; done\ncat > /dev/null\necho "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"model\\":\\"claude-$M-9-1\\"}"\nexec sleep 20'
        );
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, trainer: { ...c.trainer, command: claude } }));
        try {
            const models = (body: Record<string, unknown>): Array<Record<string, unknown>> => (body.providers as Array<Record<string, unknown>>)[0].models as Array<Record<string, unknown>>;
            // Not known yet: the aliases alone, and the CLI is to be asked.
            const before: Record<string, unknown> = (await call(t.port, "GET", "/api/trainer")).body;
            expect(before.aliasesDue).toBe(true);
            expect(models(before).map((m: Record<string, unknown>): unknown => m.answeredBy)).toEqual([undefined, undefined, undefined, undefined]);
            const asked: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/trainer/models");
            expect(asked.status).toBe(200);
            expect(asked.body.aliasesDue).toBe(false);
            expect(models(asked.body).map((m: Record<string, unknown>): unknown => [m.id, m.answeredBy, m.answeredByName])).toEqual([
                ["haiku", "claude-haiku-9-1", "Haiku 9.1"],
                ["sonnet", "claude-sonnet-9-1", "Sonnet 9.1"],
                ["opus", "claude-opus-9-1", "Opus 9.1"],
                ["fable", "claude-fable-9-1", "Fable 9.1"],
            ]);
            // The trainer's pill names the model its alias stands for.
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toMatchObject({ model: "opus", answeredBy: "claude-opus-9-1", answeredByName: "Opus 9.1" });
        } finally {
            await t.ui.close();
            for (const dir of [tools, t.root]) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    }, 30_000);

    it("says which CLI the trainer is and keeps another one chosen, for all games: a model its CLI lists, unless the environment names the trainer", async (): Promise<void> => {
        const tools: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-trainer-"));
        // A Codex CLI on this machine, and the models it fetched.
        const codex: string = path.join(tools, "codex");
        writeFileSync(codex, "#!/bin/sh\nexit 0\n");
        chmodSync(codex, 0o755);
        writeFileSync(
            path.join(tools, "models_cache.json"),
            JSON.stringify({ models: [{ slug: "gpt-9-sol", display_name: "GPT-9-Sol", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }, { slug: "gpt-9-luna" }] })
        );
        const before: { CODEX_HOME?: string; CODEX_CLI?: string } = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CLI: process.env.CODEX_CLI };
        process.env.CODEX_HOME = tools;
        process.env.CODEX_CLI = codex;
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON } }));
        const named: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON } }), { IBGAMER_TRAINER_MODEL: "sonnet" });
        try {
            const shown: { status: number; body: Record<string, unknown> } = await call(t.port, "GET", "/api/trainer");
            expect(shown.body).toMatchObject({ provider: "claude-code", model: "opus", fromEnv: false });
            const providers: Array<Record<string, unknown>> = shown.body.providers as Array<Record<string, unknown>>;
            expect(providers.map((p: Record<string, unknown>): unknown => p.provider)).toEqual(["claude-code", "codex"]);
            expect(providers[1]).toMatchObject({
                label: "Codex CLI",
                ok: true,
                detail: codex,
                models: [
                    { id: "gpt-9-sol", name: "GPT-9-Sol", default: true, efforts: ["low", "high"], defaultEffort: "low" },
                    { id: "gpt-9-luna", name: "gpt-9-luna" },
                ],
            });
            // No effort chosen: its CLI's own.
            expect(shown.body.effort).toBeNull();
            // What each reads of the machine is said where it is chosen.
            expect(String(providers[0].reads)).toMatch(/own folder only/);
            expect(String(providers[1].reads)).toMatch(/can read any file of this user/);

            // An alias says which model it last answered as, once a call has (noted in the home's settings).
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toEqual({ ok: true, detail: "Claude Code CLI (opus)", provider: "claude-code", model: "opus" });
            noteTrainerModel(t.root, TrainerProvider.CLAUDE_CODE, "opus", "claude-opus-9-1");
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toMatchObject({ model: "opus", answeredBy: "claude-opus-9-1" });
            const opus: Record<string, unknown> | undefined = (((await call(t.port, "GET", "/api/trainer")).body.providers as Array<Record<string, unknown>>)[0].models as Array<Record<string, unknown>>).find(
                (m: Record<string, unknown>): boolean => m.id === "opus"
            );
            expect(opus).toEqual({ id: "opus", name: "Opus", default: true, efforts: ["low", "medium", "high", "xhigh", "max"], answeredBy: "claude-opus-9-1", answeredByName: "Opus 9.1" });
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toMatchObject({ answeredByName: "Opus 9.1" });
            rmSync(path.join(t.root, "settings.json"));

            // Not a provider, not a model its CLI lists: refused, nothing kept.
            expect((await call(t.port, "POST", "/api/trainer", { provider: "gemini", model: "x" })).status).toBe(400);
            const unlisted: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-1" });
            expect(unlisted.status).toBe(400);
            expect(String(unlisted.body.error)).toBe("The Codex CLI lists no model gpt-1.");
            expect(existsSync(path.join(t.root, "settings.json"))).toBe(false);

            const chosen: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-9-sol" });
            expect(chosen.status).toBe(200);
            expect(chosen.body).toMatchObject({ provider: "codex", model: "gpt-9-sol" });
            // Every training from now on asks it, and the next start of the app too.
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toEqual({ ok: true, detail: "Codex CLI (gpt-9-sol)", provider: "codex", model: "gpt-9-sol" });
            expect(JSON.parse(readFileSync(path.join(t.root, "settings.json"), "utf-8"))).toEqual({ trainer: { provider: "codex", model: "gpt-9-sol" } });
            expect(loadConfig({ IBGAMER_HOME: t.root }).trainer).toMatchObject({ provider: "codex", model: "gpt-9-sol", fromEnv: false });

            // With an effort: one its model takes — kept, said in the status, and given up again by choosing none.
            const tooMuch: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-9-sol", effort: "max" });
            expect(tooMuch.status).toBe(400);
            expect(String(tooMuch.body.error)).toBe("GPT-9-Sol takes no max effort: low, high, or none for its default.");
            expect((await call(t.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-9-sol", effort: "high" })).body).toMatchObject({ model: "gpt-9-sol", effort: "high" });
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toEqual({ ok: true, detail: "Codex CLI (gpt-9-sol, high effort)", provider: "codex", model: "gpt-9-sol", effort: "high" });
            expect(loadConfig({ IBGAMER_HOME: t.root }).trainer).toMatchObject({ provider: "codex", model: "gpt-9-sol", effort: "high" });
            expect((await call(t.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-9-sol", effort: null })).body.effort).toBeNull();
            expect("effort" in loadConfig({ IBGAMER_HOME: t.root }).trainer).toBe(false);
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toMatchObject({ detail: "Codex CLI (gpt-9-sol)" });

            // Named by the environment: shown, not chosen here.
            expect((await call(named.port, "GET", "/api/trainer")).body).toMatchObject({ provider: "claude-code", model: "sonnet", fromEnv: true });
            const locked: { status: number; body: Record<string, unknown> } = await call(named.port, "POST", "/api/trainer", { provider: "codex", model: "gpt-9-sol" });
            expect(locked.status).toBe(409);
            expect(String(locked.body.error)).toMatch(/named by the environment/);
        } finally {
            await t.ui.close();
            await named.ui.close();
            for (const name of ["CODEX_HOME", "CODEX_CLI"] as const) {
                if (before[name] === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = before[name];
                }
            }
            for (const dir of [tools, t.root, named.root]) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("refuses a training it could not carry out — Jev on the running clock, a version the game does not have, no trainer — a 400 saying why, before any run starts", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-train-"));
        const missing: string = path.join(root, "no-claude");
        const t: TestUi = await startTestUi((c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, trainer: { ...c.trainer, command: missing } }));
        try {
            // The clock running, as the UI's Clock says it (`live`): never Jev.
            const live: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "jev", live: true });
            expect(live.status).toBe(400);
            expect(String(live.body.error)).toMatch(/^Jev answers in hundreds of ms/);
            // A version to check that the game does not have.
            const noVersion: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules", version: 9 });
            expect(noVersion).toEqual({ status: 400, body: { error: "fake-runner has no profile v9" } });
            // With something to check (Jev plays v1) a fix may train; with nothing (v1 has no rules as code) it trains: the trainer either way.
            const trainerError: string = `The trainer is not ready: ${missing} is not on PATH: training needs the Claude Code CLI`;
            expect(await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "jev" })).toEqual({ status: 400, body: { error: trainerError } });
            expect(await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules" })).toEqual({ status: 400, body: { error: trainerError } });
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "no-such-game", engine: "rules" })).status).toBe(404);
            expect((await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine: "rules", note: "x".repeat(2001) })).status).toBe(400);
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
        } finally {
            await t.ui.close();
            rmSync(t.root, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses any training while the trainer's CLI is not there: a 400 naming it, as the status does, before any run starts", async (): Promise<void> => {
        const root: string = mkdtempSync(path.join(tmpdir(), "ibgamer-ui-python-"));
        // A Python that has Laya, for the status.
        const python: string = script(root, "python", "echo laya");
        const missing: string = path.join(root, "no-claude");
        const t: TestUi = await startTestUi(
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, trainer: { ...c.trainer, command: missing } }),
            { IBGAMER_LAYA_PYTHON: python }
        );
        try {
            const detail: string = `${missing} is not on PATH: training needs the Claude Code CLI`;
            for (const engine of ["rules", "laya", "jev"]) {
                const refused: { status: number; body: Record<string, unknown> } = await call(t.port, "POST", "/api/runs", { kind: "train", gameId: "fake-runner", engine });
                expect(refused).toEqual({ status: 400, body: { error: `The trainer is not ready: ${detail}` } });
            }
            expect((await call(t.port, "GET", "/api/runs")).body).toMatchObject({ runs: [], current: null });
            expect((await call(t.port, "GET", "/api/status")).body.trainer).toEqual({ ok: false, detail, provider: "claude-code", model: "opus" });
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
            expect(String(other.body.error)).toMatch(/^Fake Runner v2 has no Laya checkpoint: Train with Laya teaches it that version/);
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
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, url: UNREACHABLE_DAEMON }, trainer: { ...c.trainer, command: missing } }),
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
            (c: GamerConfig): GamerConfig => ({ ...c, daemon: { ...c.daemon, script: daemon.script }, trainer: { ...c.trainer, command: script(root, "claude", "exit 0") } }),
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
