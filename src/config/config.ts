/**
 * All configuration, from the environment (a `.env` in the working directory
 * is loaded by the CLI first). CLI flags and the UI override per run.
 */

import { EngineConfig } from "../engine";
import { EngineKind } from "../engine/types";
import { TrainerModel, TrainerProvider } from "../train/claude";
import { resolveTrainer, TrainerChoice, trainerCommand } from "../train/trainer-cli";

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_DAEMON_PORT: number = 2072;
export const DEFAULT_UI_PORT: number = 1986;
/** The local Laya server the app starts (laya/serve.py); a hand-started laya-serve keeps 8000. */
export const DEFAULT_LAYA_PORT: number = 8601;

export interface DaemonConfig {
    /** A running daemon to use (started with the game tools); unset = start one. */
    url?: string;
    /** Port for a daemon the CLI starts (the UI picks a free one). */
    port: number;
    /** daemon-server.js to start; else the installed @ironbee-ai/devtools. */
    script?: string;
    headless: boolean;
}

export interface GamerConfig {
    engine: EngineConfig;
    daemon: DaemonConfig;
    ui: { host: string; port: number };
    /** Where this app keeps what it makes: the user library, runs, training. */
    home: string;
    /** The user library: games added here and every trained profile version. */
    libraryDir: string;
    /** Where runs keep their videos, screenshots and results. */
    runsDir: string;
    /**
     * The trainer: the coding-agent CLI training runs with (the Claude Code CLI or the Codex CLI, each on its own
     * login), its model, and how long one call may take. The environment's when it names one (`fromEnv`), else the
     * one chosen in the UI (`<home>/settings.json`), else the Claude Code CLI with Opus.
     */
    trainer: TrainerModel & { provider: TrainerProvider; fromEnv: boolean };
    /**
     * Local Laya: the Python that has it — found when read: `ibgamer laya setup` may make one while the UI
     * runs — and the port its server answers on.
     */
    layaRuntime: { python: string; port: number };
}

/** The Python of the virtual environment `ibgamer laya setup` makes. */
export function layaVenvPython(home: string): string {
    return process.platform === "win32" ? join(home, "laya-venv", "Scripts", "python.exe") : join(home, "laya-venv", "bin", "python");
}

function parseEnum<T extends string>(value: string | undefined, allowed: Record<string, T>, name: string, fallback: T): T {
    if (value === undefined || value === "") {
        return fallback;
    }
    const values: string[] = Object.values(allowed);
    if (!values.includes(value)) {
        throw new Error(`${name} must be one of ${values.join(", ")} (got ${value})`);
    }
    return value as T;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === "") {
        return fallback;
    }
    return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

/** The longest a timer waits: a longer one fires at once. */
const MAX_TIMEOUT_MS: number = 2_147_483_647;

/** Minutes (a fraction too; at least one) as whole milliseconds; undefined when unset. */
function parseMinutes(value: string | undefined, name: string): number | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }
    const minutes: number = Number(value);
    const ms: number = Math.round(Math.max(1, minutes) * 60_000);
    if (!Number.isFinite(minutes) || minutes <= 0 || ms > MAX_TIMEOUT_MS) {
        throw new Error(`${name} must be a number of minutes above 0, at most ${Math.floor(MAX_TIMEOUT_MS / 60_000)} (got ${value})`);
    }
    return ms;
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
    if (value === undefined || value === "") {
        return fallback;
    }
    const port: number = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} must be a port number (got ${value})`);
    }
    return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GamerConfig {
    const home: string = env.IBGAMER_HOME || join(homedir(), ".ibgamer");
    const trainerTimeoutMs: number | undefined = parseMinutes(env.IBGAMER_TRAINER_TIMEOUT_MINUTES, "IBGAMER_TRAINER_TIMEOUT_MINUTES");
    const trainer: TrainerChoice & { fromEnv: boolean } = resolveTrainer(home, env);
    return {
        engine: {
            kind: parseEnum(env.IBGAMER_ENGINE, EngineKind, "IBGAMER_ENGINE", EngineKind.JEV),
            jev: {
                apiKey: env.TYPESAFE_API_KEY || env.JEV_API_KEY || "",
                ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}),
                ...(env.TYPESAFE_URL ? { url: env.TYPESAFE_URL } : {}),
            },
            laya: {
                url: env.LAYA_URL || "http://127.0.0.1:8000",
                ...(env.LAYA_API_KEY ? { apiKey: env.LAYA_API_KEY } : {}),
                ...(env.LAYA_MODEL ? { model: env.LAYA_MODEL } : {}),
            },
        },
        daemon: {
            ...(env.IBGAMER_DAEMON_URL ? { url: env.IBGAMER_DAEMON_URL } : {}),
            port: parsePort(env.IBGAMER_DAEMON_PORT, "IBGAMER_DAEMON_PORT", DEFAULT_DAEMON_PORT),
            ...(env.IRONBEE_DEVTOOLS_DAEMON_SCRIPT ? { script: env.IRONBEE_DEVTOOLS_DAEMON_SCRIPT } : {}),
            headless: parseBool(env.IBGAMER_HEADLESS, true),
        },
        ui: {
            host: env.IBGAMER_UI_HOST || "127.0.0.1",
            port: parsePort(env.IBGAMER_UI_PORT, "IBGAMER_UI_PORT", DEFAULT_UI_PORT),
        },
        home,
        libraryDir: env.IBGAMER_LIBRARY_DIR || join(home, "library"),
        runsDir: env.IBGAMER_RUNS_DIR || join(home, "runs"),
        trainer: {
            provider: trainer.provider,
            command: trainerCommand(trainer.provider, env),
            model: trainer.model,
            ...(trainerTimeoutMs !== undefined ? { timeoutMs: trainerTimeoutMs } : {}),
            fromEnv: trainer.fromEnv,
            home,
        },
        layaRuntime: {
            // `ibgamer laya setup` makes <home>/laya-venv; a Python named here wins.
            get python(): string {
                return env.IBGAMER_LAYA_PYTHON || (existsSync(layaVenvPython(home)) ? layaVenvPython(home) : "python3");
            },
            port: parsePort(env.IBGAMER_LAYA_PORT, "IBGAMER_LAYA_PORT", DEFAULT_LAYA_PORT),
        },
    };
}

/** Loads `<cwd>/.env` into the environment without overriding what is already set. */
export function loadDotEnv(file: string = ".env"): void {
    try {
        process.loadEnvFile(file);
    } catch {
        // No .env — the environment alone configures the run.
    }
}
