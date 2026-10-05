/**
 * The trainer's LLM as the Codex CLI (`codex exec`), on its own login — no key is read here.
 *
 * One call runs the CLI once, non-interactively, in the training run's own work directory, in its
 * read-only sandbox: it reads the files it is pointed at (the samples, sprite crops and end screens) with its
 * own tools, writes nothing and reaches no network. No saved session, none of the user's Codex configuration
 * (its MCP servers, hooks and rules stay out of a training), and an environment with none of this process's keys
 * (`childEnv`). Its answer is its last message, which the CLI itself writes to a file outside the work directory.
 *
 * Unlike the Claude Code CLI, whose Read is allowed for the work directory only, Codex's read-only sandbox reads
 * any file this user can: the prompt carries text the game page drew, so a page could talk it into reading
 * something else and repeating it in what it writes (a profile's rules reach a hosted engine, and a shared
 * library). The UI says so where the trainer is chosen.
 */

import { cliFailure, childEnv, DEFAULT_TRAINER_TIMEOUT_MS, findOnPath, TrainerError, TrainerModel } from "./claude";

import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

/** What the CLI prints on the way (its commands' output, the files it reads). */
const MAX_OUTPUT_BYTES: number = 64 * 1024 * 1024;

/** The model Codex itself picks (no `-m`): offered when it lists none. */
export const CODEX_DEFAULT_MODEL: string = "default";

/** The Codex family picked unless another model is chosen: its newest listed model. */
const CODEX_PREFERRED_FAMILY: RegExp = /-sol$/i;

export interface CodexModel {
    id: string;
    name: string;
    default?: boolean;
    /** The reasoning efforts the model takes, as Codex lists them, and the one it uses when none is asked for. */
    efforts?: string[];
    defaultEffort?: string;
}

/** An effort level's name as a CLI takes one. */
const EFFORT: RegExp = /^[a-z]{2,12}$/;

/** Where the Codex CLI keeps its login and what it fetched (`CODEX_HOME`, else `~/.codex`). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Codex's models. The CLI has no list command, but it keeps the list it fetched in `<home>/models_cache.json`: the
 * ones it shows, in its own order, the newest Sol model marked the default (else the first listed). Without the
 * cache (Codex never ran), only Codex's own default.
 */
export function codexModels(home: string = codexHome()): CodexModel[] {
    const models: CodexModel[] = [];
    try {
        const cache: { models?: CachedModel[] } = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf-8")) as { models?: CachedModel[] };
        const listed: CachedModel[] = (Array.isArray(cache.models) ? cache.models : [])
            .filter((m: CachedModel): boolean => typeof m?.slug === "string" && m.slug.length > 0 && m.visibility !== "hide")
            .sort((a: CachedModel, b: CachedModel): number => (typeof a.priority === "number" ? a.priority : 0) - (typeof b.priority === "number" ? b.priority : 0));
        for (const m of listed) {
            // Its reasoning efforts: listed as { effort } entries (or plain names), least to most.
            const efforts: string[] = (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
                .map((level: unknown): unknown => (level && typeof level === "object" ? (level as { effort?: unknown }).effort : level))
                .filter((level: unknown): level is string => typeof level === "string" && EFFORT.test(level));
            models.push({
                id: m.slug as string,
                name: typeof m.display_name === "string" && m.display_name ? m.display_name : (m.slug as string),
                ...(efforts.length > 0 ? { efforts } : {}),
                ...(typeof m.default_reasoning_level === "string" && EFFORT.test(m.default_reasoning_level) ? { defaultEffort: m.default_reasoning_level } : {}),
            });
        }
    } catch {
        // no cache yet, or not one this reads
    }
    if (models.length === 0) {
        return [{ id: CODEX_DEFAULT_MODEL, name: "Codex's own default", default: true }];
    }
    (models.find((m: CodexModel): boolean => CODEX_PREFERRED_FAMILY.test(m.id)) ?? models[0]).default = true;
    return models;
}

/** A model as Codex's cache of them lists it (what is read of it). */
interface CachedModel {
    slug?: unknown;
    display_name?: unknown;
    visibility?: unknown;
    priority?: unknown;
    supported_reasoning_levels?: unknown;
    default_reasoning_level?: unknown;
}

/**
 * The arguments of one trainer call: read-only, nothing saved, nothing of the user's configuration, the last message into
 * `lastMessage`; `effort`: its reasoning effort (none: the model's own default).
 */
export function codexArgs(model: string, lastMessage: string, effort?: string): string[] {
    return [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-o",
        lastMessage,
        ...(model && model !== CODEX_DEFAULT_MODEL ? ["-m", model] : []),
        ...(effort && EFFORT.test(effort) ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        "-",
    ];
}

/** Asks the CLI once, in `workDir`; returns its final text. */
export function askCodex(trainer: TrainerModel, prompt: string, workDir: string, signal?: AbortSignal): Promise<string> {
    const command: string | undefined = findOnPath(trainer.command);
    if (!command) {
        return Promise.reject(new TrainerError(`The Codex CLI (${trainer.command}) is not installed: training with it needs it`));
    }
    const timeoutMs: number = trainer.timeoutMs ?? DEFAULT_TRAINER_TIMEOUT_MS;
    // Its last message goes to a file of the CLI's own, outside the work directory: the trainer reads that directory.
    const dir: string = mkdtempSync(join(tmpdir(), "ibgamer-codex-"));
    const last: string = join(dir, "last-message.txt");
    return new Promise<string>((resolve: (text: string) => void, reject: (err: Error) => void): void => {
        const child: ReturnType<typeof execFile> = execFile(
            command,
            codexArgs(trainer.model, last, trainer.effort),
            { cwd: workDir, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: childEnv(), ...(signal ? { signal } : {}) },
            (err: Error | null, stdout: string, stderr: string): void => {
                try {
                    if (err) {
                        reject(cliFailure("codex", err, stdout, stderr, timeoutMs));
                        return;
                    }
                    let answer: string = "";
                    try {
                        answer = readFileSync(last, "utf-8");
                    } catch {
                        // it wrote none
                    }
                    if (answer.trim()) {
                        resolve(answer);
                    } else {
                        reject(new TrainerError("codex returned no result"));
                    }
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            }
        );
        // A child that exits before draining a long prompt (a start-up failure) gives the pipe EPIPE; the exit says why.
        child.stdin?.on("error", (): void => undefined);
        child.stdin?.end(prompt);
    });
}
