/**
 * Laya on this machine: the Python that has it, the checkpoints fine-tuned per game, the server that
 * answers for them (`laya/serve.py`) and the fine-tuning run (`laya/finetune.py`). The scripts ship
 * with the package; Python and `pip install "laya[serve]"` are the user's.
 */

import { Library } from "../library/store";
import { sleep } from "../util/time";

import { ChildProcess, execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { uptime } from "os";
import path from "path";

const START_TIMEOUT_MS: number = 180_000;
const HEALTH_TIMEOUT_MS: number = 1_500;
/** A server asked to stop gets this long to exit (and free its port) before it is killed. */
const STOP_TIMEOUT_MS: number = 5_000;
/** Lines of a failed fine-tuning's stderr its error carries. */
const FAILURE_LINES: number = 3;
/** A run's lock taken this long before the machine started, or longer, is no run's (a clock set at start-up is allowed for). */
const BOOT_LEEWAY_MS: number = 60_000;

export interface LayaCheckpoint {
    gameId: string;
    /** The directory name: `v<profile version>-<profile hash>[-…]`. */
    name: string;
    dir: string;
    /** What finetune.py wrote about the run (training.json). */
    training?: Record<string, unknown>;
    /** The student's mean on the profile's seeds, recorded when it was distilled (distill.json); none: never measured. */
    studentMean?: number;
    createdAt: number;
}

/** The directory the Python scripts ship in (the package's `laya/`). */
export function layaScriptsDir(): string {
    return path.resolve(__dirname, "..", "..", "laya");
}

/** Whether `python` can import laya; never throws. */
export function checkLayaPython(python: string): Promise<{ ok: boolean; detail: string }> {
    return new Promise<{ ok: boolean; detail: string }>((resolve: (r: { ok: boolean; detail: string }) => void): void => {
        execFile(python, ["-c", "import laya, torch; print(laya.__version__ if hasattr(laya, '__version__') else 'laya')"], { timeout: 60_000 }, (err: Error | null, stdout: string): void => {
            resolve(err ? { ok: false, detail: `${python} cannot import laya: pip install "laya[serve]"` } : { ok: true, detail: `${python}: ${stdout.trim()}` });
        });
    });
}

/** The student's mean recorded when a checkpoint was distilled (its distill.json), if it was. */
export function recordedStudentMean(checkpoint: string): number | undefined {
    try {
        const mean: unknown = (JSON.parse(readFileSync(path.join(checkpoint, "distill.json"), "utf-8")) as { student?: { mean?: unknown } }).student?.mean;
        return typeof mean === "number" ? mean : undefined;
    } catch {
        return undefined;
    }
}

/** A game's fine-tuned checkpoints, newest first. */
export function layaCheckpoints(library: Library, gameId: string): LayaCheckpoint[] {
    const root: string = path.join(library.userDir, gameId, "laya");
    if (!existsSync(root)) {
        return [];
    }
    const out: LayaCheckpoint[] = [];
    for (const name of readdirSync(root)) {
        const dir: string = path.join(root, name);
        if (!existsSync(path.join(dir, "model.safetensors")) || !existsSync(path.join(dir, "rl_agent_config.json"))) {
            continue;
        }
        let training: Record<string, unknown> | undefined;
        try {
            training = JSON.parse(readFileSync(path.join(dir, "training.json"), "utf-8")) as Record<string, unknown>;
        } catch {
            // a checkpoint without its training notes still serves
        }
        const studentMean: number | undefined = recordedStudentMean(dir);
        out.push({
            gameId,
            name,
            dir,
            ...(training ? { training } : {}),
            ...(studentMean !== undefined ? { studentMean } : {}),
            createdAt: statSync(path.join(dir, "model.safetensors")).mtimeMs,
        });
    }
    return out.sort((a: LayaCheckpoint, b: LayaCheckpoint): number => b.createdAt - a.createdAt);
}

export interface LayaServerHandle {
    url: string;
    /** The model names it answers for: game ids. */
    models: string[];
    stop(): Promise<void>;
}

/** What a Laya server says it answers for: its model names, the directory each checkpoint was loaded from, and when its weights were written. */
interface LayaHealth {
    loaded: string[];
    /** Model name → checkpoint directory (a server from before serve.py reported them: none). */
    checkpoints: Record<string, string>;
    /**
     * Model name → the mtime (ns, a decimal string) of the checkpoint's weights file as the server loaded it: a
     * checkpoint made again under the same directory name has another (a server from before serve.py reported them: none).
     */
    weights: Record<string, string>;
}

/** A Laya server answers at `url`. */
export async function layaServerUp(url: string): Promise<boolean> {
    return (await healthy(url)) !== undefined;
}

/** A Laya server answers at `url` for every one of these checkpoints (model name → directory), loaded from that very directory as it is now. */
export async function layaServerServes(url: string, checkpoints: Record<string, string>): Promise<boolean> {
    const health: LayaHealth | undefined = await healthy(url);
    return health !== undefined && notServed(health, checkpoints).length === 0;
}

/** A /health field of model name → string, anything else left out. */
function namedStrings(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (value && typeof value === "object") {
        for (const [name, text] of Object.entries(value as Record<string, unknown>)) {
            if (typeof text === "string") {
                out[name] = text;
            }
        }
    }
    return out;
}

async function healthy(url: string): Promise<LayaHealth | undefined> {
    try {
        const response: Response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (!response.ok) {
            return undefined;
        }
        const body: { loaded?: unknown; checkpoints?: unknown; weights_mtime_ns?: unknown } = (await response.json()) as {
            loaded?: unknown;
            checkpoints?: unknown;
            weights_mtime_ns?: unknown;
        };
        return {
            loaded: Array.isArray(body.loaded) ? body.loaded.filter((n: unknown): boolean => typeof n === "string") : [],
            checkpoints: namedStrings(body.checkpoints),
            weights: namedStrings(body.weights_mtime_ns),
        };
    } catch {
        return undefined;
    }
}

/** A directory as one spelling (symbolic links resolved): two paths to one checkpoint compare equal. */
function canonicalDir(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        return path.resolve(dir);
    }
}

/** The mtime (ns, as serve.py reports it) of a checkpoint's weights file as it is now; undefined when there is none. */
function weightsMtime(dir: string): string | undefined {
    try {
        return String(statSync(path.join(dir, "model.safetensors"), { bigint: true }).mtimeNs);
    } catch {
        return undefined;
    }
}

/** A server loaded a checkpoint from the very directory asked for (whatever it holds now). */
function sameDirectory(health: LayaHealth, name: string, dir: string): boolean {
    const served: string | undefined = health.checkpoints[name];
    return health.loaded.includes(name) && served !== undefined && canonicalDir(served) === canonicalDir(dir);
}

/**
 * The checkpoints asked for that a server does not answer for: loaded from another directory, or from the same one
 * before the checkpoint there was made again (a round folder removed and its name used again) — the weights it
 * holds are not the file's. A server that does not say when its weights were written (from before serve.py did)
 * cannot be told from one holding stale weights: it is not taken for one serving the checkpoint either.
 */
function notServed(health: LayaHealth, checkpoints: Record<string, string>): string[] {
    return Object.entries(checkpoints)
        .filter(([name, dir]: [string, string]): boolean => {
            if (!sameDirectory(health, name, dir)) {
                return true;
            }
            const loaded: string | undefined = health.weights[name];
            return loaded === undefined || loaded !== weightsMtime(dir);
        })
        .map(([name]: [string, string]): string => name);
}

/** What a server answers for, for an error: each model with its directory. */
function servedBy(health: LayaHealth): string {
    return health.loaded.map((n: string): string => (health.checkpoints[n] ? `${n} (${health.checkpoints[n]})` : n)).join(", ") || "nothing";
}

/** Stops a server process and waits for it to exit, so its port is free; one that does not exit in time is killed. */
async function stopProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited: Promise<void> = new Promise<void>((resolve: () => void): void => {
        child.once("exit", (): void => resolve());
    });
    child.kill();
    if (!(await Promise.race([exited.then((): boolean => true), sleep(STOP_TIMEOUT_MS).then((): boolean => false)]))) {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
    }
}

/**
 * The server already on `port`, if any, for these checkpoints (model name → directory): one that answers
 * for all of them from the same directories, with the weights in them as they are now, is reused (its model
 * names are returned); one that holds another checkpoint under one of the names (another version of the
 * game, or one loaded before its checkpoint was made again) is refused with an error: it would play, and be
 * measured as, another model. Nothing there: undefined.
 */
export async function reusableLayaServer(port: number, checkpoints: Record<string, string>): Promise<string[] | undefined> {
    const running: LayaHealth | undefined = await healthy(`http://127.0.0.1:${port}`);
    if (!running) {
        return undefined;
    }
    const other: string[] = notServed(running, checkpoints);
    if (other.length === 0) {
        return running.loaded;
    }
    const named: (n: string) => string = (n: string): string => `${n} (${checkpoints[n]})`;
    // The very directories: what differs is when their weights were written.
    if (other.every((n: string): boolean => sameDirectory(running, n, checkpoints[n]))) {
        const unsaid: boolean = other.some((n: string): boolean => running.weights[n] === undefined);
        throw new Error(
            `A Laya server on port ${port} answers for ${other.map(named).join(", ")} ` +
                (unsaid ? "without saying which weights it loaded (a server from before ibgamer checked them)" : "with weights loaded before that checkpoint was made again") +
                ": stop it or use another LAYA port"
        );
    }
    throw new Error(`A Laya server on port ${port} answers for ${servedBy(running)}, not ${other.map(named).join(", ")}: stop it or use another LAYA port`);
}

/**
 * Refuses any Laya server on `port`, for a run that serves checkpoints no server holds yet (a distillation's new
 * rounds): one found there would be refused only when the first of them is served — hours later. `why` says so.
 */
export async function refuseLayaServer(port: number, why: string): Promise<void> {
    const running: LayaHealth | undefined = await healthy(`http://127.0.0.1:${port}`);
    if (running) {
        throw new Error(`A Laya server on port ${port} answers for ${servedBy(running)}: ${why} — stop it or use another LAYA port`);
    }
}

/** Where a Laya port's lock is kept: the user library's directory, which the CLI and the UI share (a dot file: no game's id). */
export function layaPortLockFile(library: Library, port: number): string {
    return path.join(library.userDir, `.laya-port-${port}.lock`);
}

/** A port's lock: the process holding it, what for and since when; `token` tells this hold from any other. */
interface PortHold {
    pid: number;
    holder: string;
    since: string;
    token: string;
}

/** A lock file's hold; undefined when it is none this app wrote whole (empty, cut off, something else). */
function readHold(file: string): PortHold | undefined {
    try {
        const hold: Partial<PortHold> = JSON.parse(readFileSync(file, "utf-8")) as Partial<PortHold>;
        return typeof hold.pid === "number" && Number.isInteger(hold.pid) && hold.pid > 0 && typeof hold.token === "string" ? (hold as PortHold) : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a process runs: signal 0 sends nothing (EPERM: it runs, as another user). */
function processRuns(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Whether a run's hold stands: its process runs, and it was taken since this machine started — a lock left by a run a
 * reboot ended names a pid any process may have now, and would refuse every run for good.
 */
function holdStands(held: PortHold): boolean {
    return processRuns(held.pid) && !(Date.parse(held.since) < Date.now() - uptime() * 1000 - BOOT_LEEWAY_MS);
}

/**
 * Makes `file` from `tmp` (written whole) only when there is none, as the library creates a file: linked to its name,
 * which fails when another run made it first; a file system without links gets it created exclusively. False: it exists.
 */
function createExclusively(tmp: string, file: string, text: string): boolean {
    try {
        linkSync(tmp, file);
        return true;
    } catch (err: unknown) {
        const code: string | undefined = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
            return false;
        }
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
            throw err;
        }
    }
    try {
        writeFileSync(file, text, { flag: "wx" });
        return true;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
        }
        throw err;
    }
}

/**
 * Holds a Laya port for a run that serves on it for hours (a distillation, an evaluation), so that a second one is refused
 * at once, not hours later when its student's server is refused or cannot bind (holdRunLock). The refusal names the lock
 * file: one whose pid another process took since (its run ended) is left only by removing it.
 */
export function holdLayaPort(file: string, port: number, holder: string): () => void {
    return holdRunLock(
        file,
        holder,
        (held: { pid: number; holder: string; since: string }): Error =>
            new Error(
                `Laya port ${port} is held by ${held.holder} (pid ${held.pid}, since ${held.since}): wait for it to end, or use another LAYA port (its lock: ${file}; remove it if pid ${held.pid} is not that run)`
            )
    );
}

/**
 * Holds a lock for a run of hours (a Laya port, a profile version's round folders): a file, made only when there is
 * none, naming this process and what for (`holder`). One held by a running process — another, or this one (the UI
 * distils in its own) — refuses the run at once with `refused`; one whose process is gone (killed, crashed), or taken
 * before this machine started (a reboot ended its run; its pid may be any process's now), is taken over. Returns the
 * release, which removes the file only while it is still this hold's.
 */
export function holdRunLock(file: string, holder: string, refused: (held: { pid: number; holder: string; since: string }) => Error): () => void {
    const hold: PortHold = { pid: process.pid, holder, since: new Date().toISOString(), token: randomUUID() };
    const text: string = JSON.stringify(hold);
    const tmp: string = `${file}.${hold.token}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, text);
    try {
        for (let attempt: number = 0; attempt < 5; attempt++) {
            if (createExclusively(tmp, file, text)) {
                return (): void => {
                    if (readHold(file)?.token === hold.token) {
                        rmSync(file, { force: true });
                    }
                };
            }
            const held: PortHold | undefined = readHold(file);
            if (held && holdStands(held)) {
                throw refused({ pid: held.pid, holder: held.holder, since: held.since });
            }
            // Its run is gone: taken over. Moved aside first, so that of two runs taking it over at once one moves it;
            // what was moved is removed only if it is the lock found stale (another run's, just taken, is put back).
            const aside: string = `${tmp}.stale`;
            try {
                renameSync(file, aside);
            } catch {
                continue;
            }
            if (readHold(aside)?.token !== held?.token) {
                createExclusively(aside, file, readFileSync(aside, "utf-8"));
            }
            rmSync(aside, { force: true });
        }
    } finally {
        rmSync(tmp, { force: true });
    }
    throw new Error(`the lock ${file} could not be taken`);
}

/** Who holds a Laya port's lock: the process, what for and since when. */
export interface LayaPortHolder {
    pid: number;
    holder: string;
    since: string;
}

/** A Laya port another running process holds (layaPortHeldByOther): nothing is started on it here. Worded as holdLayaPort's refusal. */
export class LayaPortHeldError extends Error {
    constructor(port: number, held: LayaPortHolder, file: string) {
        super(
            `Laya port ${port} is held by ${held.holder} (pid ${held.pid}, since ${held.since}): wait for it to end, or use another LAYA port (its lock: ${file}; remove it if pid ${held.pid} is not that run)`
        );
        this.name = "LayaPortHeldError";
    }
}

/**
 * The hold another running process has on a Laya port (its lock `file`), if any — one that stands as a run's does
 * (holdStands): a distillation or an evaluation, whose server is up only while its students play — hours of teacher's
 * games and fine-tuning go by with the port free. A server started there meanwhile (a play, `laya serve`) would stand
 * where its next student is served, and the run would die then. Those refuse the port instead; they never take the
 * lock (short-lived, interactive). This process's own hold is none: its runs are one at a time (the UI's).
 */
export function layaPortHeldByOther(file: string): LayaPortHolder | undefined {
    const held: PortHold | undefined = readHold(file);
    return held && held.pid !== process.pid && holdStands(held) ? { pid: held.pid, holder: held.holder, since: held.since } : undefined;
}

/** Refuses a Laya port another running process holds (layaPortHeldByOther), naming the holder. */
export function refuseHeldLayaPort(file: string, port: number): void {
    const held: LayaPortHolder | undefined = layaPortHeldByOther(file);
    if (held) {
        throw new LayaPortHeldError(port, held, file);
    }
}

/**
 * Starts `laya/serve.py` for the given checkpoints (model name → directory) on `port`, or reuses a
 * server already there that answers for all of them from the same directories, as they are now; one
 * holding another checkpoint under one of the names is refused (reusableLayaServer).
 */
export async function startLayaServer(options: {
    python: string;
    port: number;
    checkpoints: Record<string, string>;
    device?: string;
    onLine?: (line: string) => void;
}): Promise<LayaServerHandle> {
    const url: string = `http://127.0.0.1:${options.port}`;
    const names: string[] = Object.keys(options.checkpoints);
    const reused: string[] | undefined = await reusableLayaServer(options.port, options.checkpoints);
    if (reused) {
        return { url, models: reused, stop: async (): Promise<void> => {} };
    }
    const args: string[] = [path.join(layaScriptsDir(), "serve.py"), "--port", String(options.port)];
    for (const [name, dir] of Object.entries(options.checkpoints)) {
        args.push("--checkpoint", `${name}=${dir}`);
    }
    if (options.device) {
        args.push("--device", options.device);
    }
    const child: ChildProcess = spawn(options.python, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TOKENIZERS_PARALLELISM: "false" } });
    // A Python that is not there (ENOENT) is an 'error' event: unheard, it would end this process.
    let failed: Error | undefined;
    child.on("error", (err: Error): void => {
        failed = err;
    });
    const lines: string[] = [];
    const collect: (chunk: Buffer) => void = (chunk: Buffer): void => {
        for (const line of chunk.toString("utf-8").split("\n").filter(Boolean)) {
            lines.push(line);
            options.onLine?.(line);
        }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const deadline: number = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (failed) {
            throw new Error(`The Laya server could not be started with ${options.python}: ${failed.message}`);
        }
        // Killed by a signal (an MPS assertion's SIGABRT, the OS's SIGKILL when memory runs out) it has no exit code.
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`The Laya server ${child.signalCode !== null ? `was killed by ${child.signalCode}` : "exited"} during start: ${lines.slice(-3).join(" | ").slice(0, 400)}`);
        }
        const up: LayaHealth | undefined = await healthy(url);
        if (up && notServed(up, options.checkpoints).length === 0) {
            return {
                url,
                models: names,
                stop: (): Promise<void> => stopProcess(child),
            };
        }
        await sleep(500);
    }
    await stopProcess(child);
    throw new Error("The Laya server did not become healthy in time");
}

/** Runs `laya/finetune.py`; resolves when it saved the checkpoint. MPS can drop a command buffer mid-run: it resumes, up to `retries` times. */
export async function runFinetune(options: {
    python: string;
    data: string[];
    trainOnly?: string[];
    out: string;
    name: string;
    base?: string;
    epochs?: number;
    device?: string;
    /** Seconds of rest after each step: the machine stays usable while it trains. */
    pause?: number;
    retries?: number;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
}): Promise<void> {
    const args: string[] = [path.join(layaScriptsDir(), "finetune.py"), "--out", options.out, "--name", options.name];
    for (const d of options.data) {
        args.push("--data", d);
    }
    for (const d of options.trainOnly ?? []) {
        args.push("--train-only", d);
    }
    if (options.base) {
        args.push("--base", options.base);
    }
    if (options.epochs !== undefined) {
        args.push("--epochs", String(options.epochs));
    }
    if (options.device) {
        args.push("--device", options.device);
    }
    if (options.pause) {
        args.push("--pause", String(options.pause));
    }
    for (let attempt: number = 0; ; attempt++) {
        // The last lines it wrote to stderr: a run that fails says why (a Python traceback ends in its error).
        const errors: string[] = [];
        const code: number = await new Promise<number>((resolve: (code: number) => void): void => {
            const child: ChildProcess = spawn(options.python, attempt > 0 ? [...args, "--resume"] : args, {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, TOKENIZERS_PARALLELISM: "false", PYTORCH_ENABLE_MPS_FALLBACK: "1" },
                ...(options.signal ? { signal: options.signal } : {}),
            });
            /** A chunk's lines, handed on but for warnings and download progress. */
            const forward: (chunk: Buffer) => string[] = (chunk: Buffer): string[] => {
                const lines: string[] = chunk.toString("utf-8").split("\n").filter(Boolean);
                for (const line of lines) {
                    if (!/warning|Fetching \d+ files/i.test(line)) {
                        options.onLine?.(line);
                    }
                }
                return lines;
            };
            child.stdout?.on("data", (chunk: Buffer): void => {
                forward(chunk);
            });
            child.stderr?.on("data", (chunk: Buffer): void => {
                errors.push(...forward(chunk));
                errors.splice(0, Math.max(0, errors.length - FAILURE_LINES));
            });
            child.on("error", (err: Error): void => {
                errors.push(err.message);
                resolve(-1);
            });
            // Once its output is closed, not at its exit: the traceback it ends with is read by then.
            child.on("close", (c: number | null): void => resolve(c ?? -1));
        });
        if (code === 0) {
            return;
        }
        if (options.signal?.aborted || attempt >= (options.retries ?? 2)) {
            throw new Error(`fine-tuning failed (exit ${code})${errors.length ? `: ${errors.join(" | ").slice(-400)}` : ""}`);
        }
        options.onLine?.(`fine-tuning stopped (exit ${code}); resuming from the last saved step`);
    }
}
