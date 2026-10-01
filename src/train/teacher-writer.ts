/**
 * The trainer writes a profile's teacher: its rules as `teach(state)`, for distilling a small
 * local engine. The instructions stay what the engine reads; the teacher is the same rules as code.
 *
 * It is checked before it teaches:
 * - on the sample states it was shown: it must answer every one (not throw) — a repair round with
 *   the errors and the states they came from (a teacher the setup wrote with the extractor gets
 *   this check alone: `checkedOnSamples`);
 * - against the decisions an engine already made applying the instructions (the profile's
 *   decision log), when there are some: it must answer every one of those states and agree on
 *   nearly all of them — one repair round with the errors and the disagreements;
 * - by playing: the teacher itself plays the profile's seeds, must fail on none of their states
 *   and score about as well as the profile did (when the profile has a score) — one repair round
 *   with the errors, or the ends of the games it lost.
 */

import { GameBrowser } from "../devtools/client";
import { RulesTeacher } from "../distill/teacher";
import { GameAction, GameDefinition, Profile } from "../game/types";
import { validateProfile } from "../game/validate";
import { Library } from "../library/store";
import { EpisodeResult, isExtractorErrorState, Pace, Player, PlayResult, TickRecord } from "../play/player";
import { ScriptError, Teacher } from "../play/sandbox";
import { DecisionRow } from "../run/decision-log";
import { customScriptOf } from "../run/play";
import { forEachJsonRow, sayingSkippedRows, SkippedRows } from "../util/rows";
import { parseJsonObject, TrainerError } from "./claude";
import { NO_STATE_FRAMES, TEACHER_TIME } from "./prompts";

import { writeFileSync } from "fs";
import path from "path";

/**
 * Agreement with the engine's logged decisions a teacher needs, per action the engine chose and
 * averaged (a game's decisions can be nearly all one action: overall agreement would pass a
 * teacher that never chooses the others).
 */
export const MIN_AGREEMENT: number = 0.95;
/** How close to the profile's own score the teacher's play must come. */
const MIN_SCORE_SHARE: number = 0.9;
const SAMPLE_STATES: number = 40;
const SHOWN_DISAGREEMENTS: number = 30;
/** States a repair is shown the teacher's errors on. */
const SHOWN_ERRORS: number = 12;
/** The most characters of one kind of a repair's evidence — the states it failed on, the ends of its lost games. */
const SHOWN_CHARS: number = 30_000;
const CHECKED_ROWS: number = 6_000;

export interface TeacherWriterDeps {
    library: Library;
    ask(prompt: string, workDir: string, signal?: AbortSignal): Promise<string>;
    openBrowser(): GameBrowser;
}

export interface TeacherCheck {
    /** Balanced: per action the engine chose, then averaged. */
    agreement?: number;
    perAction?: Record<string, string>;
    checkedRows?: number;
    /** The teacher's own games on the profile's seeds. */
    scores?: number[];
    mean?: number;
}

/** Up to `limit` of a log's rows, spread over it; a line that is no row is skipped, and said (`skipped`). */
async function rowsOf(file: string, limit: number, skipped?: SkippedRows): Promise<DecisionRow[]> {
    // Read as a stream, twice: the log only grows, and one string of it would fail past V8's limit (src/util/rows.ts).
    let count: number = 0;
    await forEachJsonRow(file, (): void => {
        count++;
    });
    // Spread over the whole log, not its first game.
    const every: number = Math.max(1, Math.floor(count / limit));
    const rows: DecisionRow[] = [];
    let i: number = 0;
    await forEachJsonRow(
        file,
        (row: DecisionRow): void => {
            if (i++ % every === 0 && rows.length < limit) {
                rows.push(row);
            }
        },
        { skipped }
    );
    // A frame with no state, which an engine was asked about before the player stopped asking: no state of the game.
    return rows.filter((r: DecisionRow): boolean => !isExtractorErrorState(r.state));
}

/**
 * Up to `n` items spread over their kinds: the rare kinds in full, the common ones sampled — with more kinds than `n`, one
 * item of each of `n` kinds spread over them. One of each kind, however many, once put every state a teacher failed on in
 * its repair prompt when its error text differed from state to state (a kind each): up to CHECKED_ROWS, a few KB each.
 */
function spread<T>(items: T[], kind: (item: T) => string, n: number): T[] {
    const byKind: Map<string, T[]> = new Map();
    for (const item of items) {
        const list: T[] | undefined = byKind.get(kind(item));
        if (list) {
            list.push(item);
        } else {
            byKind.set(kind(item), [item]);
        }
    }
    const lists: T[][] = [...byKind.values()];
    const kinds: T[][] = lists.length > n ? Array.from({ length: n }, (_: unknown, k: number): T[] => lists[Math.floor((k * lists.length) / n)]) : lists;
    const out: T[] = [];
    const per: number = Math.max(1, Math.floor(n / Math.max(1, kinds.length)));
    for (const list of kinds) {
        const every: number = Math.max(1, Math.floor(list.length / per));
        out.push(...list.filter((_: T, i: number): boolean => i % every === 0).slice(0, per));
    }
    return out;
}

export function teacherPrompt(input: {
    game: GameDefinition;
    profile: Profile;
    samples: Array<{ state: unknown; choice?: string }>;
    repair?: {
        current: string;
        /** Why it does not compile (the sandbox's error). */
        error?: string;
        /** States it failed on (it threw, or answered no action), with the error; a state is not known for every error. */
        failures?: Array<{ state?: unknown; error: string }>;
        /** Playing by itself: how many of its games' states it failed on (the last decision stood there). */
        failedInGames?: number;
        disagreements?: Array<{ state: unknown; expected: string; teacher: string }>;
        lostGames?: Array<{ seed?: number; score: number; lastTicks: TickRecord[] }>;
        profileMean?: number;
    };
}): string {
    const { game, profile } = input;
    return `You are writing the TEACHER for a small, fast, local decision model that will play a browser game. It learns from examples: states labelled with the right action. Your teacher labels them.

The game: ${game.goal}
A per-game extractor turns the page into a JSON state every decision (you do not change it):
${profile.extractor}

The rules the decision engine applies to that state (the INSTRUCTIONS), and the actions:
${profile.instructions}
ACTIONS: ${JSON.stringify(profile.actions.map((a: GameAction): { id: string; description: string } => ({ id: a.id, description: a.description })))}

Write \`function teach(state) { … }\`: the same rules as code. It returns an action id ("${profile.actions[0].id}", …), or an object of probabilities by action id where the rules leave the choice open. Implement the INSTRUCTIONS exactly as written, field by field and in their order — they are what a reference engine applied, and the model must learn the same decisions. It runs in a bare JavaScript sandbox (no DOM, no console, no require), once per state, with no memory between calls. ${TEACHER_TIME} ${NO_STATE_FRAMES} It never changes the state: it labels training data, and it plays the game by itself too — its own games are one of its checks, and it decides wherever the rules are chosen to play.

SAMPLE STATES${input.samples.some((s: { choice?: string }): boolean => s.choice !== undefined) ? " with the action the reference engine chose applying the instructions" : ""}:
${input.samples.map((s: { state: unknown; choice?: string }): string => `${s.choice !== undefined ? `${s.choice} <- ` : ""}${JSON.stringify(s.state)}`).join("\n")}
${input.repair ? `
YOUR PREVIOUS TEACHER:
${input.repair.current}
${input.repair.error ? `\nIT DOES NOT COMPILE: ${input.repair.error}\n` : ""}${input.repair.failures?.length ? `\nIT FAILS ON STATES IT IS GIVEN — it threw, or answered no action${input.repair.failedInGames ? `; playing by itself it failed on ${input.repair.failedInGames} states, where the last decision stood` : ""}. It must answer every state (error : state):\n${input.repair.failures.map((f: { state?: unknown; error: string }): string => `${f.error}${f.state !== undefined ? ` : ${JSON.stringify(f.state)}` : ""}`).join("\n").slice(0, SHOWN_CHARS)}\n` : ""}${input.repair.disagreements?.length ? `\nIT DISAGREES WITH THE REFERENCE ENGINE HERE (expected <- teacher : state):\n${input.repair.disagreements.map((d: { state: unknown; expected: string; teacher: string }): string => `${d.expected} <- ${d.teacher} : ${JSON.stringify(d.state)}`).join("\n")}\n` : ""}${input.repair.lostGames?.length ? `\nPLAYING BY ITSELF IT SCORED LESS THAN THE PROFILE (${input.repair.profileMean ?? "?"}). The last decisions of the games it played (state, its choice):\n${JSON.stringify(input.repair.lostGames).slice(0, SHOWN_CHARS)}\n` : ""}Fix the teacher. Where the instructions are wrong for a case the evidence shows, follow what the reference engine did.
` : ""}
Reply with ONLY a JSON object, no prose, no code fence:
{"teacher": "<the full source of function teach(state) {...}>", "notes": "<one or two sentences>"}`;
}

export class TeacherWriter {
    constructor(private readonly deps: TeacherWriterDeps) {}

    /**
     * Checks a teacher against logged decisions: balanced agreement, per action, and where it differs; apart from that,
     * the states it fails on (it throws, or answers no action) — not a disagreement: a state it cannot label is never
     * learnt, so none may fail (a row it fails on agrees with nothing).
     */
    agreement(
        profile: Profile,
        teacher: string,
        rows: DecisionRow[]
    ): {
        agreement: number;
        perAction: Record<string, string>;
        disagreements: Array<{ state: unknown; expected: string; teacher: string }>;
        errors: Array<{ state: unknown; error: string }>;
    } {
        const t: Teacher = new Teacher(teacher, profile.actions.map((a: GameAction): string => a.id));
        const seen: Map<string, { agree: number; total: number }> = new Map();
        const disagreements: Array<{ state: unknown; expected: string; teacher: string }> = [];
        const errors: Array<{ state: unknown; error: string }> = [];
        for (const r of rows) {
            let label: string | undefined;
            let agrees: boolean = false;
            try {
                const p: Record<string, number> = t.label(r.state);
                label = Object.keys(p).reduce((a: string, b: string): string => (p[b] > p[a] ? b : a));
                // The choice agrees when the teacher gives it the highest probability: a tie the rules leave open agrees either way.
                agrees = (p[r.choice] ?? -1) >= p[label] - 1e-6;
            } catch (err: unknown) {
                errors.push({ state: r.state, error: err instanceof Error ? err.message : String(err) });
            }
            const tally: { agree: number; total: number } = seen.get(r.choice) ?? { agree: 0, total: 0 };
            tally.total++;
            if (agrees) {
                tally.agree++;
            } else if (label !== undefined) {
                disagreements.push({ state: r.state, expected: r.choice, teacher: label });
            }
            seen.set(r.choice, tally);
        }
        const tallies: Array<[string, { agree: number; total: number }]> = [...seen.entries()];
        return {
            agreement: tallies.length ? tallies.reduce((a: number, [, v]: [string, { agree: number; total: number }]): number => a + v.agree / v.total, 0) / tallies.length : 1,
            perAction: Object.fromEntries(tallies.map(([k, v]: [string, { agree: number; total: number }]): [string, string] => [k, `${v.agree}/${v.total}`])),
            disagreements,
            errors,
        };
    }

    /** The states a teacher fails on — it throws, or answers no action — with the error: how many, and up to `limit` of them spread over the errors. */
    failures(profile: Profile, teacher: string, states: unknown[], limit: number): { count: number; shown: Array<{ state: unknown; error: string }> } {
        const t: Teacher = new Teacher(teacher, profile.actions.map((a: GameAction): string => a.id));
        const failed: Array<{ state: unknown; error: string }> = [];
        for (const state of states) {
            try {
                t.label(state);
            } catch (err: unknown) {
                failed.push({ state, error: err instanceof Error ? err.message : String(err) });
            }
        }
        return { count: failed.length, shown: spread(failed, (f: { error: string }): string => f.error, limit) };
    }

    /** Why a teacher does not compile (a syntax error, or not a function); undefined when it does. */
    private compileError(profile: Profile, teacher: string): string | undefined {
        try {
            new Teacher(teacher, profile.actions.map((a: GameAction): string => a.id));
            return undefined;
        } catch (err: unknown) {
            return err instanceof ScriptError ? err.message : String(err);
        }
    }

    /**
     * A teacher written with the profile (the setup's, with the first extractor), checked as one written here is first:
     * it must compile and answer every sample state — the extractor's states of frames the game showed. One repair
     * round, told why it does not compile, or the errors and the states; the teacher that passed, else a TrainerError.
     */
    async checkedOnSamples(
        game: GameDefinition,
        profile: Profile,
        states: unknown[],
        options: { workDir: string; log?: (line: string) => void; signal?: AbortSignal }
    ): Promise<string> {
        const say: (line: string) => void = options.log ?? ((): void => undefined);
        const every: number = Math.max(1, Math.floor(states.length / SAMPLE_STATES));
        const samples: Array<{ state: unknown }> = states
            .filter((_: unknown, i: number): boolean => i % every === 0)
            .slice(0, SAMPLE_STATES)
            .map((state: unknown): { state: unknown } => ({ state }));
        let teacher: string = profile.teacher ?? "";
        for (let attempt: number = 0; ; attempt++) {
            const error: string | undefined = this.compileError(profile, teacher);
            const failed: { count: number; shown: Array<{ state: unknown; error: string }> } =
                error === undefined ? this.failures(profile, teacher, states, SHOWN_ERRORS) : { count: 0, shown: [] };
            if (error === undefined && failed.count === 0) {
                return teacher;
            }
            const why: string = error !== undefined ? `does not compile: ${error}` : `fails on ${failed.count} of the ${states.length} sample states: ${failed.shown[0].error}`;
            say(`  the teacher ${why}`);
            if (attempt > 0) {
                throw new TrainerError(`the teacher still ${why}`);
            }
            const prompt: string = teacherPrompt({ game, profile, samples, repair: { current: teacher, ...(error !== undefined ? { error } : { failures: failed.shown }) } });
            writeFileSync(path.join(options.workDir, "teacher-repair-prompt.md"), prompt);
            const reply: Record<string, unknown> = parseJsonObject(await this.deps.ask(prompt, options.workDir, options.signal));
            if (typeof reply.teacher !== "string") {
                throw new TrainerError("the reply has no teacher");
            }
            teacher = reply.teacher;
        }
    }

    /** The teacher playing the profile's seeds (one game each, at once). */
    async play(game: GameDefinition, profile: Profile, seeds: number[], gameSeconds: number, signal?: AbortSignal): Promise<PlayResult[]> {
        const customScript: string | undefined = customScriptOf(this.deps.library, { game });
        return Promise.all(
            seeds.map(async (seed: number): Promise<PlayResult> => {
                const browser: GameBrowser = this.deps.openBrowser();
                try {
                    return await new Player(browser, new RulesTeacher(profile)).play({
                        game,
                        profile,
                        episodes: 1,
                        gameSeconds,
                        seeds: [seed],
                        pace: Pace.TURN,
                        ...(customScript ? { customScript } : {}),
                        ...(signal ? { signal } : {}),
                    });
                } finally {
                    await browser.close();
                }
            })
        );
    }

    /**
     * Writes (or repairs) the profile's teacher and saves the profile with it as a new version.
     * `decisionLog`: the engine's logged decisions for this profile, when there are any. `activate`
     * (default true): the new version is made active — the caller's decision (not when it teaches a
     * version other than the active one).
     */
    async write(
        game: GameDefinition,
        profile: Profile,
        options: { decisionLog?: string; workDir: string; log?: (line: string) => void; activate?: boolean; signal?: AbortSignal }
    ): Promise<{ profile: Profile; check: TeacherCheck }> {
        const say: (line: string) => void = options.log ?? ((): void => undefined);
        const logged: DecisionRow[] = options.decisionLog ? await rowsOf(options.decisionLog, CHECKED_ROWS, sayingSkippedRows(say)) : [];
        const samples: Array<{ state: unknown; choice?: string }> = logged.length
            ? spread(logged, (r: DecisionRow): string => r.choice, SAMPLE_STATES).map((r: DecisionRow): { state: unknown; choice: string } => ({ state: r.state, choice: r.choice }))
            : await this.sampleStates(game, profile, options.signal);
        const seeds: number[] = profile.results?.seeds ?? game.trainSeeds ?? [101, 202, 303];
        const gameSeconds: number = profile.results?.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
        let repair: Parameters<typeof teacherPrompt>[0]["repair"];
        let teacher: string = "";
        const check: TeacherCheck = {};
        for (let attempt: number = 0; attempt < 3; attempt++) {
            const prompt: string = teacherPrompt({ game, profile, samples, ...(repair ? { repair } : {}) });
            writeFileSync(path.join(options.workDir, `teacher-prompt-${attempt + 1}.md`), prompt);
            const started: number = Date.now();
            const reply: Record<string, unknown> = parseJsonObject(await this.deps.ask(prompt, options.workDir, options.signal));
            if (typeof reply.teacher !== "string") {
                throw new TrainerError("the reply has no teacher");
            }
            teacher = reply.teacher;
            const error: string | undefined = this.compileError(profile, teacher);
            if (error !== undefined) {
                say(`  the teacher does not compile: ${error}`);
                // The repair is told why: a syntax error, or not a function.
                repair = { current: teacher, error };
                continue;
            }
            say(`  teacher written (${Math.round((Date.now() - started) / 1000)} s): ${String(reply.notes ?? "").slice(0, 300)}`);
            // The states it was shown, first: a field it reads that the state does not have needs no game to be found, and
            // the repair is told the error (its own games would show only a stale decision where it failed).
            const onSamples: { count: number; shown: Array<{ state: unknown; error: string }> } = this.failures(
                profile,
                teacher,
                samples.map((x: { state: unknown }): unknown => x.state),
                SHOWN_ERRORS
            );
            if (onSamples.count > 0) {
                say(`  the teacher fails on ${onSamples.count} of the ${samples.length} sample states: ${onSamples.shown[0].error}`);
                repair = { current: teacher, failures: onSamples.shown };
                continue;
            }
            if (logged.length) {
                const a: ReturnType<TeacherWriter["agreement"]> = this.agreement(profile, teacher, logged);
                check.agreement = a.agreement;
                check.perAction = a.perAction;
                check.checkedRows = logged.length;
                say(`  agreement with the engine's ${logged.length} logged decisions: ${(a.agreement * 100).toFixed(1)}% balanced ${JSON.stringify(a.perAction)}`);
                if (a.errors.length > 0) {
                    say(`  the teacher fails on ${a.errors.length} of the engine's ${logged.length} logged states: ${a.errors[0].error}`);
                }
                // Every state the engine answered must be answered (one it fails on is never learnt), nearly all of them alike.
                if (a.errors.length > 0 || a.agreement < MIN_AGREEMENT) {
                    repair = {
                        current: teacher,
                        ...(a.errors.length > 0 ? { failures: spread(a.errors, (f: { error: string }): string => f.error, SHOWN_ERRORS) } : {}),
                        ...(a.agreement < MIN_AGREEMENT
                            ? { disagreements: spread(a.disagreements, (d: { expected: string; teacher: string }): string => `${d.expected}<-${d.teacher}`, SHOWN_DISAGREEMENTS) }
                            : {}),
                    };
                    continue;
                }
            }
            const candidate: Profile = { ...profile, teacher };
            const played: PlayResult[] = await this.play(game, candidate, seeds, gameSeconds, options.signal);
            // Stopped part of the way: its scores are partial, and must not pass (or fail) the teacher.
            if (options.signal?.aborted || played.some((r: PlayResult): boolean => r.stopped)) {
                throw new TrainerError("stopped");
            }
            const episodes: EpisodeResult[] = played.map((r: PlayResult): EpisodeResult => r.episodes[0]);
            check.scores = episodes.map((e: EpisodeResult): number => e.score);
            check.mean = check.scores.reduce((x: number, y: number): number => x + y, 0) / Math.max(1, check.scores.length);
            // A state of its games it failed on (it threw, or answered no action): the last decision stood there, and
            // distilled, that state would never be labelled — whether or not the profile has a score to compare with.
            const invalid: number = episodes.reduce((x: number, e: EpisodeResult): number => x + e.invalidAnswers, 0);
            say(
                `  the teacher's own games (seeds ${seeds.join(", ")}, ${gameSeconds} s): ${check.scores.join(", ")}${profile.results ? ` — the profile's: ${profile.results.scores.join(", ")}` : ""}` +
                    (invalid > 0 ? `; it failed on ${invalid} of their states` : "")
            );
            if (invalid > 0) {
                // Where: the states of its games it fails on (their last decisions and samples; a frame with no state was never
                // its to answer), else the first error the games met.
                const seen: { count: number; shown: Array<{ state: unknown; error: string }> } = this.failures(
                    profile,
                    teacher,
                    episodes
                        .flatMap((e: EpisodeResult): unknown[] => [...e.samples, ...e.lastTicks].map((t: TickRecord): unknown => t.state))
                        .filter((state: unknown): boolean => !isExtractorErrorState(state)),
                    SHOWN_ERRORS
                );
                const first: string | undefined = episodes.find((e: EpisodeResult): boolean => e.firstInvalidAnswer !== undefined)?.firstInvalidAnswer;
                repair = { current: teacher, failures: seen.count > 0 ? seen.shown : [{ error: first ?? "it failed on states of its games" }], failedInGames: invalid };
                continue;
            }
            if (profile.results && check.mean < MIN_SCORE_SHARE * profile.results.mean) {
                repair = {
                    current: teacher,
                    lostGames: episodes.map((e: EpisodeResult): { seed?: number; score: number; lastTicks: TickRecord[] } => ({ ...(e.seed !== undefined ? { seed: e.seed } : {}), score: e.score, lastTicks: e.lastTicks.slice(-12) })),
                    profileMean: profile.results.mean,
                };
                continue;
            }
            const saved: Profile = this.deps.library.saveProfile(
                game.id,
                validateProfile({
                    ...profile,
                    version: profile.version + 1,
                    createdAt: new Date().toISOString(),
                    parent: profile.version,
                    origin: "teacher",
                    note: `v${profile.version} with its rules as a teacher for distillation${check.agreement !== undefined ? ` (agrees with ${(check.agreement * 100).toFixed(1)}% of ${check.checkedRows} logged decisions)` : ""}; the teacher's own games: ${check.scores.join(", ")}.`,
                    teacher,
                }),
                { activate: options.activate !== false }
            );
            return { profile: saved, check };
        }
        throw new TrainerError("no teacher passed its checks in three attempts");
    }

    /** States to show when no decisions are logged yet: a few seconds of the game with the first action held. */
    private async sampleStates(game: GameDefinition, profile: Profile, signal?: AbortSignal): Promise<Array<{ state: unknown }>> {
        const states: Array<{ state: unknown }> = [];
        const customScript: string | undefined = customScriptOf(this.deps.library, { game });
        const browser: GameBrowser = this.deps.openBrowser();
        const first: string = profile.actions[0].id;
        try {
            await new Player(browser, {
                kind: "jev" as never,
                label: "sampler",
                ask: async (state: unknown): Promise<never> => {
                    states.push({ state: (state as { game: unknown }).game });
                    return { answers: { action: { choice: first, probabilities: Object.fromEntries(profile.actions.map((a: GameAction): [string, number] => [a.id, a.id === first ? 1 : 0])), confidence: 1 } } } as never;
                },
                health: async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "sampler" }),
            }).play({ game, profile, episodes: 1, gameSeconds: 10, pace: Pace.TURN, ...(customScript ? { customScript } : {}), ...(signal ? { signal } : {}) });
        } finally {
            await browser.close();
        }
        const every: number = Math.max(1, Math.floor(states.length / SAMPLE_STATES));
        return states.filter((_: { state: unknown }, i: number): boolean => i % every === 0).slice(0, SAMPLE_STATES);
    }
}
