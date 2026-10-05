/**
 * The trainer's LLM: which coding-agent CLI it is — the Claude Code CLI (claude.ts) or the Codex CLI (codex.ts) —
 * and which of its models. One choice for the whole app, not a game's: made in the UI (the Trainer pill), kept in
 * `<home>/settings.json`, or given by the environment (`IBGAMER_TRAINER_PROVIDER`, `IBGAMER_TRAINER_MODEL`), which
 * wins and locks the UI's.
 */

import { askClaude, claudeModelFor, findOnPath, TrainerModel, TrainerProvider } from "./claude";
import { askCodex, codexModels } from "./codex";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface TrainerModelInfo {
    id: string;
    name: string;
    default?: boolean;
}

/** Claude Code's model aliases: each is the latest model of its family. Opus is picked unless another is chosen. */
export const CLAUDE_CODE_MODELS: TrainerModelInfo[] = [
    { id: "haiku", name: "Haiku" },
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus", default: true },
    { id: "fable", name: "Fable" },
];

export const TRAINER_LABELS: Record<TrainerProvider, string> = {
    [TrainerProvider.CLAUDE_CODE]: "Claude Code CLI",
    [TrainerProvider.CODEX]: "Codex CLI",
};

/** What each reads of the files it is pointed at, in words (the UI says it where the trainer is chosen). */
export const TRAINER_READS: Record<TrainerProvider, string> = {
    [TrainerProvider.CLAUDE_CODE]: "Reads the training run's own folder only.",
    [TrainerProvider.CODEX]: "Runs in its read-only sandbox: it writes nothing and reaches no network, but it can read any file of this user, not the run's folder only.",
};

/** A model id as a CLI takes one: no spaces, nothing a shell or a path would read. */
const MODEL_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}$/;

/** The models a provider's CLI offers (Codex: the ones it lists on this machine). */
export function trainerModels(provider: TrainerProvider, env: NodeJS.ProcessEnv = process.env): TrainerModelInfo[] {
    return provider === TrainerProvider.CODEX ? codexModels(env.CODEX_HOME || undefined) : CLAUDE_CODE_MODELS.map((m: TrainerModelInfo): TrainerModelInfo => ({ ...m }));
}

/** The model a provider is asked with when none is chosen. */
export function defaultTrainerModel(provider: TrainerProvider, env: NodeJS.ProcessEnv = process.env): string {
    const models: TrainerModelInfo[] = trainerModels(provider, env);
    return (models.find((m: TrainerModelInfo): boolean => m.default === true) ?? models[0]).id;
}

/** The executable of a provider's CLI: `CLAUDE_CODE_CLI` / `CODEX_CLI`, else `claude` / `codex`. */
export function trainerCommand(provider: TrainerProvider, env: NodeJS.ProcessEnv = process.env): string {
    return provider === TrainerProvider.CODEX ? env.CODEX_CLI || "codex" : env.CLAUDE_CODE_CLI || "claude";
}

/**
 * Asks the trainer's CLI once, in `workDir`; returns its final text. The model the Claude Code CLI ran the call with is
 * noted in the trainer's home (Codex is asked for a model by its own name).
 */
export function askTrainer(trainer: TrainerModel, prompt: string, workDir: string, signal?: AbortSignal): Promise<string> {
    if (trainer.provider === TrainerProvider.CODEX) {
        return askCodex(trainer, prompt, workDir, signal);
    }
    const home: string | undefined = trainer.home;
    return askClaude(trainer, prompt, workDir, signal, home ? (model: string): void => noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, trainer.model, model) : undefined);
}

/**
 * Whether the trainer's CLI is there, in words: the UI's status shows it, and a training is refused without it (the UI's
 * and `ibgamer train`) — it would play every measuring game, then fail each tuning.
 */
export function trainerHealth(trainer: TrainerModel): { ok: boolean; detail: string } {
    const label: string = TRAINER_LABELS[trainer.provider ?? TrainerProvider.CLAUDE_CODE];
    return findOnPath(trainer.command) ? { ok: true, detail: `${label} (${trainer.model})` } : { ok: false, detail: `${trainer.command} is not on PATH: training needs the ${label}` };
}

/** The trainer as chosen in the UI and kept in `<home>/settings.json`. */
export interface TrainerChoice {
    provider: TrainerProvider;
    model: string;
}

/** A choice as it may be kept or asked for: a provider there is, and a model id a CLI takes; else why not. */
export function parseTrainerChoice(value: unknown): TrainerChoice | string {
    const v: { provider?: unknown; model?: unknown } = (value ?? {}) as { provider?: unknown; model?: unknown };
    if (typeof v.provider !== "string" || !Object.values(TrainerProvider).includes(v.provider as TrainerProvider)) {
        return `provider is one of ${Object.values(TrainerProvider).join(", ")}`;
    }
    if (typeof v.model !== "string" || !MODEL_ID.test(v.model)) {
        return "model is a model id of that provider (letters, digits, . _ : -)";
    }
    return { provider: v.provider as TrainerProvider, model: v.model };
}

export function settingsFile(home: string): string {
    return join(home, "settings.json");
}

/** The trainer kept in the settings file; none when there is no file, or it holds none this reads. */
export function readTrainerChoice(home: string): TrainerChoice | undefined {
    try {
        const settings: { trainer?: unknown } = JSON.parse(readFileSync(settingsFile(home), "utf-8")) as { trainer?: unknown };
        const choice: TrainerChoice | string = parseTrainerChoice(settings?.trainer);
        return typeof choice === "string" ? undefined : choice;
    } catch {
        return undefined;
    }
}

/** Keeps the trainer in the settings file, whatever else it holds kept (written beside it, then renamed into place). */
export function writeTrainerChoice(home: string, choice: TrainerChoice): void {
    const file: string = settingsFile(home);
    let settings: Record<string, unknown> = {};
    try {
        const read: unknown = JSON.parse(readFileSync(file, "utf-8"));
        if (read && typeof read === "object" && !Array.isArray(read)) {
            settings = read as Record<string, unknown>;
        }
    } catch {
        // none yet
    }
    mkdirSync(dirname(file), { recursive: true });
    const draft: string = `${file}.${process.pid}.tmp`;
    writeFileSync(draft, `${JSON.stringify({ ...settings, trainer: { provider: choice.provider, model: choice.model } }, null, 2)}\n`);
    renameSync(draft, file);
}

/** The models a provider's aliases last stood for, by alias: `{ "claude-code": { "opus": "claude-opus-5-5" } }`. */
export type TrainerModelsSeen = Partial<Record<TrainerProvider, Record<string, string>>>;

/** A model's full name as a CLI reports it (`claude-opus-5-5`, `claude-sonnet-5-5[1m]`): shown, never run. */
const SEEN_MODEL: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,99}$/;

/** What the settings file holds of the models the trainer's aliases stood for; nothing when it holds none this reads. */
export function readTrainerModelsSeen(home: string): TrainerModelsSeen {
    const out: TrainerModelsSeen = {};
    try {
        const settings: { trainerModels?: unknown } = JSON.parse(readFileSync(settingsFile(home), "utf-8")) as { trainerModels?: unknown };
        for (const provider of Object.values(TrainerProvider)) {
            const kept: unknown = (settings?.trainerModels as Record<string, unknown> | undefined)?.[provider];
            if (kept && typeof kept === "object" && !Array.isArray(kept)) {
                const models: Array<[string, string]> = Object.entries(kept as Record<string, unknown>).filter(
                    (entry: [string, unknown]): entry is [string, string] => MODEL_ID.test(entry[0]) && typeof entry[1] === "string" && SEEN_MODEL.test(entry[1])
                );
                if (models.length > 0) {
                    out[provider] = Object.fromEntries(models);
                }
            }
        }
    } catch {
        // none yet
    }
    return out;
}

/**
 * Notes the model a call was answered by, for the alias it was asked with — `opus` is whichever Opus is the latest, and
 * the UI shows which one that was (the Trainer pill, its dialog). Written only when it is news: a training asks many times.
 */
export function noteTrainerModel(home: string, provider: TrainerProvider, alias: string, model: string): void {
    if (!MODEL_ID.test(alias) || !SEEN_MODEL.test(model) || model === alias) {
        return;
    }
    const seen: TrainerModelsSeen = readTrainerModelsSeen(home);
    if (seen[provider]?.[alias] === model) {
        return;
    }
    const file: string = settingsFile(home);
    let settings: Record<string, unknown> = {};
    try {
        const read: unknown = JSON.parse(readFileSync(file, "utf-8"));
        if (read && typeof read === "object" && !Array.isArray(read)) {
            settings = read as Record<string, unknown>;
        }
    } catch {
        // none yet
    }
    mkdirSync(dirname(file), { recursive: true });
    const draft: string = `${file}.${process.pid}.tmp`;
    writeFileSync(draft, `${JSON.stringify({ ...settings, trainerModels: { ...seen, [provider]: { ...(seen[provider] ?? {}), [alias]: model } } }, null, 2)}\n`);
    renameSync(draft, file);
}

/**
 * A model's id as a person reads it, the way a provider names its models: `claude-opus-5-5` is "Opus 5.5",
 * `claude-haiku-4-5-20251001` "Haiku 4.5", `claude-sonnet-5-5[1m]` "Sonnet 5.5 (1M context)" — its family and version, read
 * off the id (nothing here knows which versions there are). An id of another shape is shown as it is.
 */
export function modelDisplayName(id: string): string {
    const window: string = /\[1m\]$/i.test(id) ? " (1M context)" : "";
    const bare: string = id.replace(/\[[^\]]*\]$/, "");
    // claude-<family>-<major>[-<minor>][-<date>], and the older claude-<major>[-<minor>]-<family>[-<date>]
    const m: RegExpExecArray | null = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare) ?? null;
    const old: RegExpExecArray | null = m ? null : /^claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(bare);
    const family: string | undefined = m?.[1] ?? old?.[3];
    const major: string | undefined = m?.[2] ?? old?.[1];
    const minor: string | undefined = m?.[3] ?? old?.[2];
    if (!family || !major) {
        return id;
    }
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor !== undefined ? `.${minor}` : ""}${window}`;
}

/** How long what the Claude Code CLI's aliases stand for is taken as still so: a newer CLI may move one. */
const ALIASES_ASKED_EVERY_MS: number = 7 * 24 * 60 * 60 * 1000;

/** When the Claude Code CLI was last asked what its aliases stand for (the settings file's `trainerModelsAt`). */
function aliasesAskedAt(home: string): number | undefined {
    try {
        const settings: { trainerModelsAt?: unknown } = JSON.parse(readFileSync(settingsFile(home), "utf-8")) as { trainerModelsAt?: unknown };
        const at: number = Date.parse(String(settings?.trainerModelsAt ?? ""));
        return Number.isFinite(at) ? at : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Whether the Claude Code CLI should be asked what its aliases stand for: one of them is not known yet, or they were last
 * asked a week or more ago.
 */
export function claudeAliasesDue(home: string, now: number = Date.now()): boolean {
    const seen: Record<string, string> = readTrainerModelsSeen(home)[TrainerProvider.CLAUDE_CODE] ?? {};
    const at: number | undefined = aliasesAskedAt(home);
    return CLAUDE_CODE_MODELS.some((m: TrainerModelInfo): boolean => seen[m.id] === undefined) || at === undefined || now - at >= ALIASES_ASKED_EVERY_MS;
}

/**
 * Asks the Claude Code CLI what each of its aliases stands for now (all at once, a second or two: claudeModelFor) and
 * notes the answers and when; one it does not answer for keeps what was known of it.
 */
export async function askClaudeAliases(home: string, command: string, now: number = Date.now()): Promise<void> {
    const answers: Array<string | undefined> = await Promise.all(CLAUDE_CODE_MODELS.map((m: TrainerModelInfo): Promise<string | undefined> => claudeModelFor(command, m.id)));
    CLAUDE_CODE_MODELS.forEach((m: TrainerModelInfo, i: number): void => {
        const model: string | undefined = answers[i];
        if (model !== undefined) {
            noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, m.id, model);
        }
    });
    // Only when it answered at all: a CLI that said nothing (not logged in, no network) is asked again next time.
    if (answers.some((a: string | undefined): boolean => a !== undefined)) {
        const file: string = settingsFile(home);
        let settings: Record<string, unknown> = {};
        try {
            const read: unknown = JSON.parse(readFileSync(file, "utf-8"));
            if (read && typeof read === "object" && !Array.isArray(read)) {
                settings = read as Record<string, unknown>;
            }
        } catch {
            // none yet
        }
        mkdirSync(dirname(file), { recursive: true });
        const draft: string = `${file}.${process.pid}.tmp`;
        writeFileSync(draft, `${JSON.stringify({ ...settings, trainerModelsAt: new Date(now).toISOString() }, null, 2)}\n`);
        renameSync(draft, file);
    }
}

/**
 * The trainer this process asks: the environment's when it names one (`IBGAMER_TRAINER_PROVIDER` and / or
 * `IBGAMER_TRAINER_MODEL`: `fromEnv`, which the UI cannot change), else the one kept in the settings file, else the
 * Claude Code CLI with its default model.
 */
export function resolveTrainer(home: string, env: NodeJS.ProcessEnv = process.env): TrainerChoice & { fromEnv: boolean } {
    const named: string = (env.IBGAMER_TRAINER_PROVIDER ?? "").trim();
    if (named && !Object.values(TrainerProvider).includes(named as TrainerProvider)) {
        throw new Error(`IBGAMER_TRAINER_PROVIDER must be one of ${Object.values(TrainerProvider).join(", ")} (got ${named})`);
    }
    const model: string = (env.IBGAMER_TRAINER_MODEL ?? "").trim();
    if (named || model) {
        const provider: TrainerProvider = named ? (named as TrainerProvider) : TrainerProvider.CLAUDE_CODE;
        return { provider, model: model || defaultTrainerModel(provider, env), fromEnv: true };
    }
    const kept: TrainerChoice | undefined = readTrainerChoice(home);
    if (kept) {
        return { ...kept, fromEnv: false };
    }
    return { provider: TrainerProvider.CLAUDE_CODE, model: defaultTrainerModel(TrainerProvider.CLAUDE_CODE, env), fromEnv: false };
}
