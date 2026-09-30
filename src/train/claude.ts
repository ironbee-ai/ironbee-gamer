/**
 * The trainer's LLM: the Claude Code CLI (`claude -p`), on its own login — no key is read here.
 *
 * One call runs the CLI once, non-interactively, in the training run's own work directory, with
 * one tool: Read, allowed for that directory only (the samples, sprite crops and end screens it is
 * asked to look at). The prompt carries text the game page drew, so it must not be able to send
 * the CLI reading anything else. No MCP servers, no saved session, and an environment with none of
 * this process's keys (`childEnv`).
 */

import { execFile } from "child_process";
import { accessSync, constants, realpathSync } from "fs";
import { delimiter, join } from "path";

/** The CLI's whole stream: the files the trainer reads come back in it too (a pixel sample runs to MBs). */
const MAX_OUTPUT_BYTES: number = 64 * 1024 * 1024;
/** A tuning call reads the runs and thinks: 10–20 minutes is common. */
export const DEFAULT_TRAINER_TIMEOUT_MS: number = 30 * 60_000;

/**
 * Environment names the CLI gets as they are: where it runs, who runs it, how it reaches the
 * network, where it finds its own login.
 */
const CHILD_ENV_NAMES: Set<string> = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "LANG",
    "LC_ALL",
    "SHELL",
    "USER",
    "LOGNAME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
]);
const CHILD_ENV_PREFIXES: string[] = ["LC_", "XDG_"];

/** The CLI's environment: what it needs to run and find its login, none of this process's keys (TYPESAFE_*, …). */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && (CHILD_ENV_NAMES.has(name) || CHILD_ENV_PREFIXES.some((prefix: string): boolean => name.startsWith(prefix)))) {
            out[name] = value;
        }
    }
    return out;
}

/** The executable's path on PATH (or the path itself when it is one), or undefined. */
export function findOnPath(command: string, path: string | undefined = process.env.PATH): string | undefined {
    const candidates: string[] = command.includes("/") ? [command] : (path ?? "").split(delimiter).filter(Boolean).map((dir: string): string => join(dir, command));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // not here
        }
    }
    return undefined;
}

/** The permission rule that lets the CLI read the files under `dir` and nothing else (`//` starts an absolute path). */
export function readRuleFor(dir: string): string {
    return `Read(//${realpathSync(dir).replace(/^\/+/, "")}/**)`;
}

export interface TrainerModel {
    command: string;
    model: string;
    timeoutMs?: number;
}

/**
 * Whether the trainer's CLI is there, in words: the UI's status shows it, and a training is refused without it (the UI's
 * and `ibgamer train`) — it would play every measuring game, then fail each tuning.
 */
export function trainerHealth(trainer: TrainerModel): { ok: boolean; detail: string } {
    return findOnPath(trainer.command)
        ? { ok: true, detail: `Claude Code CLI (${trainer.model})` }
        : { ok: false, detail: `${trainer.command} is not on PATH: training needs the Claude Code CLI` };
}

export class TrainerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TrainerError";
    }
}

/**
 * The trainer's answer in the CLI's stream (`--output-format stream-json`): the text of every assistant
 * message after its last tool call, joined. A long answer is cut at the model's output limit and goes
 * on in the next message; the final `result` holds only that last piece — an extractor and a teacher
 * that searched came back as the tail of a string, from which no JSON parses.
 */
export function finalReply(stream: string): string {
    const messages: Array<{ tool: boolean; text: string }> = [];
    let result: { text?: string; error: boolean } | undefined;
    for (const line of stream.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: unknown; is_error?: boolean };
        try {
            event = JSON.parse(line) as typeof event;
        } catch {
            continue;
        }
        if (event.type === "assistant") {
            const content: Array<{ type?: string; text?: string }> = event.message?.content ?? [];
            messages.push({
                tool: content.some((c: { type?: string }): boolean => c.type === "tool_use"),
                text: content.map((c: { type?: string; text?: string }): string => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join(""),
            });
        } else if (event.type === "result") {
            result = { ...(typeof event.result === "string" ? { text: event.result } : {}), error: event.is_error === true };
        }
    }
    if (result?.error) {
        throw new TrainerError(`claude returned no result: ${String(result.text ?? "").slice(0, 200)}`);
    }
    let lastTool: number = -1;
    messages.forEach((m: { tool: boolean }, i: number): void => {
        if (m.tool) {
            lastTool = i;
        }
    });
    const answer: string = messages
        .slice(lastTool + 1)
        .map((m: { text: string }): string => m.text)
        .join("");
    if (answer.trim()) {
        return answer;
    }
    if (result?.text) {
        return result.text;
    }
    throw new TrainerError("claude returned no result");
}

/** Asks the CLI once, in `workDir`; returns its final text. */
export function askClaude(trainer: TrainerModel, prompt: string, workDir: string, signal?: AbortSignal): Promise<string> {
    const command: string | undefined = findOnPath(trainer.command);
    if (!command) {
        return Promise.reject(new TrainerError(`The Claude Code CLI (${trainer.command}) is not installed: training needs it`));
    }
    return new Promise<string>((resolve: (text: string) => void, reject: (err: Error) => void): void => {
        const child: ReturnType<typeof execFile> = execFile(
            command,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                trainer.model,
                "--tools",
                "Read",
                "--allowedTools",
                readRuleFor(workDir),
                "--strict-mcp-config",
                "--no-session-persistence",
            ],
            { cwd: workDir, timeout: trainer.timeoutMs ?? DEFAULT_TRAINER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env: childEnv(), ...(signal ? { signal } : {}) },
            (err: Error | null, stdout: string, stderr: string): void => {
                if (err) {
                    const e: Error & { killed?: boolean; signal?: string | null; code?: number | string } = err as Error & {
                        killed?: boolean;
                        signal?: string | null;
                        code?: number | string;
                    };
                    const minutes: number = Math.round((trainer.timeoutMs ?? DEFAULT_TRAINER_TIMEOUT_MS) / 60_000);
                    const why: string = e.killed || e.signal ? `stopped (${e.signal ?? "killed"}): over its ${minutes}-minute limit` : `exited with ${String(e.code ?? "an error")}`;
                    // The command line is not the reason: what the CLI said is.
                    const detail: string = (stderr || stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
                    reject(new TrainerError(`claude ${why}${detail ? `: ${detail}` : ""}`));
                    return;
                }
                try {
                    resolve(finalReply(stdout));
                } catch (e: unknown) {
                    reject(e instanceof TrainerError ? e : new TrainerError("claude's output was not a stream of JSON events"));
                }
            }
        );
        child.stdin?.on("error", (): void => undefined);
        child.stdin?.end(prompt);
    });
}

/**
 * Where the braces opened at `start` close, reading as JSON does: a brace inside a string (an extractor's source)
 * is not counted, nor is an escaped quote taken for the string's end; -1 when they never close (prose, a cut reply).
 */
function closingBrace(text: string, start: number): number {
    let depth: number = 0;
    let inString: boolean = false;
    for (let i: number = start; i < text.length; i++) {
        const c: string = text[i];
        if (inString) {
            if (c === "\\") {
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
        } else if (c === "{") {
            depth++;
        } else if (c === "}" && --depth === 0) {
            return i;
        }
    }
    return -1;
}

/**
 * Whether the brace at `start` opens as a JSON object does: `{"key":`, whitespace between allowed — a key and its colon,
 * not a quote alone: prose quoting a brace (`I escaped the "{" character.`) opens no object, and the answer after it is taken.
 */
function opensObject(text: string, start: number): boolean {
    const opening: RegExp = /\{\s*"(?:[^"\\\n]|\\.)*"\s*:/y;
    opening.lastIndex = start;
    return opening.test(text);
}

/**
 * The JSON object in a model's reply: a fence or sentences around it are dropped, braces of their own among them
 * ("the state {dx, air}", before the object or after it). Of the top-level balanced spans that parse to an object,
 * the largest. None parses: the error of the largest span that did not (a malformed answer) — or, where a brace
 * never closes, that the reply holds no complete object (an answer cut off at the output limit), with that error.
 * A brace that never closes and opens as an object does (`{"key":`) is the answer cut off: the reply holds no complete
 * object whatever came before it (an example in the prose is not the answer), and no span inside it is taken — the
 * scan for the next brace goes on inside its strings, where an extractor's `memory.seen || {}` once parsed and passed
 * for the answer.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
    if (text.indexOf("{") < 0) {
        throw new TrainerError("the reply holds no JSON object");
    }
    let best: { value: Record<string, unknown>; length: number } | undefined;
    let failed: { error: Error; length: number } | undefined;
    let unclosed: boolean = false;
    /** An answer cut off was met: every span after it is inside it. */
    let cut: boolean = false;
    for (let start: number = text.indexOf("{"); start >= 0; ) {
        const end: number = closingBrace(text, start);
        if (end < 0) {
            // An opening brace that never closes is prose, or a cut answer: the next one may start the object.
            unclosed = true;
            cut ||= opensObject(text, start);
            start = text.indexOf("{", start + 1);
            continue;
        }
        const length: number = end + 1 - start;
        try {
            const value: unknown = JSON.parse(text.slice(start, end + 1));
            if (!cut && value && typeof value === "object" && !Array.isArray(value) && length > (best?.length ?? 0)) {
                best = { value: value as Record<string, unknown>, length };
            }
        } catch (err: unknown) {
            if (length > (failed?.length ?? 0)) {
                failed = { error: err instanceof Error ? err : new Error(String(err)), length };
            }
        }
        // The braces inside a span are its own: an object nested in a malformed answer is not the answer.
        start = text.indexOf("{", end + 1);
    }
    if (best && !cut) {
        return best.value;
    }
    if (unclosed || !failed) {
        throw new TrainerError(`the reply holds no complete JSON object${failed ? ` (${failed.error.message})` : ""}`);
    }
    throw failed.error;
}
