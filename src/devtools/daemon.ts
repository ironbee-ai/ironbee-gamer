/**
 * Makes sure an IronBee DevTools daemon with the game tools is up before a
 * game: reuses a healthy one, or starts one and waits for it. A started daemon
 * is owned by this process and stopped by it.
 *
 * A daemon exits by itself once it has had no session for two idle checks,
 * and every run closes its session at the end — so a daemon given by URL may be
 * gone by the next run. When that URL is on this machine, a new daemon is
 * started on the same port instead of failing; two processes reviving it at
 * once both use the one that got the port.
 */

import { sleep } from "../util/time";

import { ChildProcess, spawn } from "child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "fs";
import { AddressInfo, createServer as createNetServer, Server as NetServer } from "net";
import { tmpdir } from "os";
import path from "path";

const HEALTH_TIMEOUT_MS: number = 1_000;
const START_TIMEOUT_MS: number = 30_000;
const POLL_MS: number = 200;
const LOCAL_HOSTS: Set<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** Where a daemon started without a URL listens and is asked for. */
const DEFAULT_HOST: string = "127.0.0.1";
/** The game tools' bundle, as the build names it. */
const GAME_TOOLS_FILE: string = "game-tools.mjs";
/** How much of the end of a daemon's stderr an error about its start carries. */
const STDERR_TAIL_BYTES: number = 2_000;

/** A started daemon lingers ~10 min without sessions (two 5-min checks). */
export const DEFAULT_IDLE_CHECK_SECONDS: number = 300;

export interface StartDaemonOptions {
    /** A daemon to use; revived on its port when it is local and not answering. */
    url?: string;
    /** Port for a daemon started without a URL. */
    port: number;
    headless: boolean;
    /** Path to the daemon script; else IRONBEE_DEVTOOLS_DAEMON_SCRIPT, else the installed package. */
    daemonScript?: string;
    /** Extra environment for the daemon (e.g. the live-view hub). */
    env?: Record<string, string>;
    /** How long a started daemon lingers with no session (DevTools exits after two idle checks). */
    idleCheckSeconds?: number;
}

export interface DaemonHandle {
    baseUrl: string;
    /** True when this process started the daemon (and so should stop it). */
    owned: boolean;
    stop(): Promise<void>;
}

/** A port nothing listens on right now (for a daemon of our own). */
export function freePort(): Promise<number> {
    return new Promise<number>((resolve: (port: number) => void, reject: (err: Error) => void): void => {
        const probe: NetServer = createNetServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", (): void => {
            const port: number = (probe.address() as AddressInfo).port;
            probe.close((): void => resolve(port));
        });
    });
}

export async function isDaemonHealthy(baseUrl: string): Promise<boolean> {
    try {
        const response: Response = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * The built game-tools plugin (scripts/build-devtools-plugin.js) DevTools loads
 * with TOOL_PLUGINS: next to this module in dist/, or in dist/ when this runs
 * from src/ (tests).
 */
export function gameToolsPluginPath(): string {
    const beside: string = path.join(__dirname, "..", "devtools-plugin", GAME_TOOLS_FILE);
    if (existsSync(beside)) {
        return beside;
    }
    return path.resolve(__dirname, "..", "..", "dist", "devtools-plugin", GAME_TOOLS_FILE);
}

/**
 * The daemon's TOOL_PLUGINS: the plugins the given lists name, then `gameTools` (this build's game tools), each path
 * once — DevTools refuses a tool name registered twice, and exits on it. Another install's game tools (a
 * `game-tools.mjs` elsewhere: a shell set up for a daemon started by hand) are left out: they are these tools again.
 */
export function toolPluginsEnv(gameTools: string, ...lists: (string | undefined)[]): string {
    const seen: Set<string> = new Set();
    for (const list of lists) {
        for (const entry of (list ?? "").split(path.delimiter)) {
            const trimmed: string = entry.trim();
            if (trimmed && path.basename(trimmed) !== GAME_TOOLS_FILE) {
                seen.add(path.resolve(trimmed));
            }
        }
    }
    seen.add(path.resolve(gameTools));
    return [...seen].join(path.delimiter);
}

/** A file a started daemon's stderr goes to (see `ensureDaemon`), and the descriptor it is handed. */
interface StderrLog {
    dir: string;
    file: string;
    fd: number;
}

/** A file for a started daemon's stderr; undefined when none can be made (its stderr then goes nowhere). */
function openStderrLog(): StderrLog | undefined {
    let dir: string | undefined;
    try {
        dir = mkdtempSync(path.join(tmpdir(), "ibgamer-daemon-stderr-"));
        const file: string = path.join(dir, "stderr.log");
        return { dir, file, fd: openSync(file, "w") };
    } catch {
        removeStderrLog(dir);
        return undefined;
    }
}

/**
 * Removes a daemon's stderr file. A daemon still running writes on to it unseen (its descriptor keeps the file until it
 * exits); where an open file cannot be removed (Windows), it stays in the temp directory.
 */
function removeStderrLog(dir: string | undefined): void {
    if (dir !== undefined) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // left for the temp directory's own clearing
        }
    }
}

/** The end of a daemon's stderr file: its last whole lines, at most `bytes`; "" when it wrote nothing (or cannot be read). */
export function stderrTail(file: string, bytes: number = STDERR_TAIL_BYTES): string {
    let fd: number | undefined;
    try {
        fd = openSync(file, "r");
        const size: number = fstatSync(fd).size;
        const length: number = Math.min(size, bytes);
        const buffer: Buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const text: string = buffer.toString("utf8");
        // Cut short: from its first whole line.
        return (length < size ? text.slice(text.indexOf("\n") + 1) : text).trim();
    } catch {
        return "";
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

/** An error about a daemon's start, with the end of what it wrote to its stderr (the reason DevTools gives is there). */
function startError(message: string, log: StderrLog | undefined): Error {
    const tail: string = log ? stderrTail(log.file) : "";
    return new Error(tail ? `${message}; its stderr ended:\n${tail}` : message);
}

function resolveDaemonScript(explicit?: string): string {
    const candidate: string | undefined = explicit ?? process.env.IRONBEE_DEVTOOLS_DAEMON_SCRIPT;
    if (candidate) {
        if (!existsSync(candidate)) {
            throw new Error(`Daemon script not found: ${candidate}`);
        }
        return candidate;
    }
    try {
        return require.resolve("@ironbee-ai/devtools/dist/daemon-server.js");
    } catch {
        throw new Error(
            "No IronBee DevTools daemon is reachable and none could be started: " +
                "install @ironbee-ai/devtools, set IRONBEE_DEVTOOLS_DAEMON_SCRIPT, " +
                "or pass --daemon-url to a running daemon."
        );
    }
}

/** Where Google Chrome is installed: the paths Playwright's `chrome` channel launches from. */
export function installedChromePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
    switch (platform) {
        case "darwin":
            return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
        case "linux":
            return ["/opt/google/chrome/chrome"];
        case "win32":
            return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
                .filter((dir: string | undefined): dir is string => dir !== undefined)
                .map((dir: string): string => path.win32.join(dir, "Google", "Chrome", "Application", "chrome.exe"));
        default:
            return [];
    }
}

function hasInstalledChrome(): boolean {
    return installedChromePaths().some((p: string): boolean => existsSync(p));
}

/**
 * The browser a started daemon runs: the Google Chrome installed on this machine when there is one
 * (a person's browser, with its media codecs). Left out when `base` already sets it.
 */
export function browserDefaults(
    base: NodeJS.ProcessEnv,
    machine: { chromeInstalled: boolean } = { chromeInstalled: hasInstalledChrome() }
): Record<string, string> {
    const defaults: Record<string, string> = {};
    if (base.BROWSER_USE_INSTALLED_ON_SYSTEM === undefined && machine.chromeInstalled) {
        defaults.BROWSER_USE_INSTALLED_ON_SYSTEM = "true";
    }
    return defaults;
}

/**
 * DevTools settings a started daemon does not take from this process's environment (a shell set up for DevTools used
 * elsewhere): each would take the game tools away or change the browser session they play in.
 * - AVAILABLE_TOOL_DOMAINS: only the domains it lists are served (`game_open` is "Tool Not Found").
 * - BROWSER_PERSISTENT_ENABLE, BROWSER_CDP_ENABLE, BROWSER_CDP_ENDPOINT_URL: every session in one browser context (a
 *   profile on disk, a running Chrome's own) — games at once would share its one clock, and each game's origins would
 *   be cleared in that profile.
 * - BROWSER_DIALOG_MODE: a game's dialog held open (its page stopped until someone answers) or accepted, not dismissed.
 * - BROWSER_FOLLOW_NEW_TABS: a tab the game opens (an ad) becomes the session's page.
 * - OTEL_ENABLE: OpenTelemetry put into every game page (its requests and events wrapped, its exports among the
 *   requests a boot waits for).
 * - LIVE_VIEW_WS_URL, LIVE_VIEW_TOKEN: the game streamed to another hub, whose input reaches it (the UI passes its own
 *   in `env`).
 * - BROWSER_ALLOWED_DOMAINS, BROWSER_ALLOWED_NAVIGATION_DOMAINS: DevTools' host allowlists (every request; a page's or
 *   a window's navigations): a game of any other host did not load (`net::ERR_BLOCKED_BY_CLIENT`), nor did the files,
 *   frames and pages of other hosts it needs.
 */
const NOT_INHERITED: string[] = [
    "AVAILABLE_TOOL_DOMAINS",
    "BROWSER_PERSISTENT_ENABLE",
    "BROWSER_CDP_ENABLE",
    "BROWSER_CDP_ENDPOINT_URL",
    "BROWSER_DIALOG_MODE",
    "BROWSER_FOLLOW_NEW_TABS",
    "OTEL_ENABLE",
    "LIVE_VIEW_WS_URL",
    "LIVE_VIEW_TOKEN",
    "BROWSER_ALLOWED_DOMAINS",
    "BROWSER_ALLOWED_NAVIGATION_DOMAINS",
];

/**
 * The address a started daemon listens on: the host of the URL it is revived for (`[::1]` without its brackets), else
 * the loopback address a daemon started without one is asked at. A DevTools that reads DAEMON_HOST listens on
 * 127.0.0.1 unless told otherwise, and one revived for a URL at [::1] with its port only listened there — its health
 * check at [::1] never answered; an older DevTools ignores the variable (it listens on every interface).
 */
export function daemonHost(url: string | undefined): string {
    if (url !== undefined) {
        try {
            return new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
        } catch {
            // not a URL: ensureDaemon refuses it before any daemon starts
        }
    }
    return DEFAULT_HOST;
}

/**
 * The environment a started daemon runs with: this process's (without the settings in NOT_INHERITED), the browser
 * defaults, the caller's `env`, then what must hold.
 */
export function daemonEnv(
    options: StartDaemonOptions,
    base: NodeJS.ProcessEnv = process.env,
    browser: Record<string, string> = browserDefaults(base)
): NodeJS.ProcessEnv {
    const inherited: NodeJS.ProcessEnv = { ...base };
    for (const name of NOT_INHERITED) {
        delete inherited[name];
    }
    return {
        ...inherited,
        ...browser,
        DAEMON_SESSION_IDLE_CHECK_SECONDS: String(options.idleCheckSeconds ?? DEFAULT_IDLE_CHECK_SECONDS),
        ...options.env,
        // The game tools run inside DevTools as its tool plugin, beside whatever other plugins the env names (each once).
        TOOL_PLUGINS: toolPluginsEnv(gameToolsPluginPath(), base.TOOL_PLUGINS, options.env?.TOOL_PLUGINS),
        PLATFORM: "browser",
        BROWSER_HEADLESS_ENABLE: String(options.headless),
        // Where it is asked for, whatever a shell's DAEMON_HOST says.
        DAEMON_HOST: daemonHost(options.url),
    };
}

export async function ensureDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
    let baseUrl: string = `http://${DEFAULT_HOST}:${options.port}`;
    let port: number = options.port;
    if (options.url) {
        const url: URL = new URL(options.url);
        baseUrl = options.url.replace(/\/$/, "");
        if (await isDaemonHealthy(baseUrl)) {
            return { baseUrl, owned: false, stop: async (): Promise<void> => {} };
        }
        if (!LOCAL_HOSTS.has(url.hostname)) {
            throw new Error(`The IronBee DevTools daemon at ${baseUrl} is not reachable`);
        }
        port = Number(url.port || 80);
    }
    // A given url was probed above; the default address is probed here.
    if (!options.url && (await isDaemonHealthy(baseUrl))) {
        return { baseUrl, owned: false, stop: async (): Promise<void> => {} };
    }
    const script: string = resolveDaemonScript(options.daemonScript);
    // A daemon revived for a given URL is shared, not ours: it outlives this process and ends by its own idle timeout.
    const shared: boolean = options.url !== undefined;
    // Its stderr goes to a file, read should it exit as it starts: why is written there (a plugin that registers a tool
    // twice). Not a pipe: one this process stopped reading would block the daemon once full, and one it left by exiting
    // (a shared daemon outlives it) breaks — a Node process then dies at its next line to stderr (measured: `write
    // EPIPE`, `console.error`'s too).
    const log: StderrLog | undefined = openStderrLog();
    const child: ChildProcess = spawn(process.execPath, [script, "--port", String(port)], {
        stdio: ["ignore", "ignore", log?.fd ?? "ignore"],
        detached: shared,
        env: daemonEnv(options),
    });
    if (log) {
        // The daemon has a descriptor of its own.
        closeSync(log.fd);
    }
    try {
        const deadline: number = Date.now() + START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            // Killed by a signal (the OS's SIGKILL when memory runs out, a crash's SIGABRT) it has no exit code.
            if (child.exitCode !== null || child.signalCode !== null) {
                // Another process reviving the same URL at once got the port first, and this daemon exited on it: the one
                // answering there is shared, as this one would have been.
                if (shared && (await isDaemonHealthy(baseUrl))) {
                    return { baseUrl, owned: false, stop: async (): Promise<void> => {} };
                }
                throw startError(`The DevTools daemon ${child.signalCode !== null ? `was killed by ${child.signalCode}` : `exited (code ${child.exitCode})`} during start`, log);
            }
            if (await isDaemonHealthy(baseUrl)) {
                if (shared) {
                    child.unref();
                    return { baseUrl, owned: false, stop: async (): Promise<void> => {} };
                }
                return {
                    baseUrl,
                    owned: true,
                    stop: async (): Promise<void> => {
                        try {
                            await fetch(`${baseUrl}/shutdown`, {
                                method: "POST",
                                signal: AbortSignal.timeout(3_000),
                            });
                        } catch {
                            child.kill();
                        }
                    },
                };
            }
            await sleep(POLL_MS);
        }
        child.kill();
        throw startError("The DevTools daemon did not become healthy in time", log);
    } finally {
        removeStderrLog(log?.dir);
    }
}
