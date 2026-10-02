/**
 * Train's check (with something to check: improve.ts): how a game plays with an engine on a clock, and what is to be
 * fixed when it plays badly — found by the app, never by the person playing. The engine's games are played beside the
 * version's rules on the same clock, its reference. Where the rules play a seed well and the engine does not, the
 * engine is what to fix (Laya taught more on that clock, Jev's instructions trained); where the rules themselves play
 * worse than their record (the clock running: than they were measured in real time), the rules are. Before each game
 * the engine plays worse, the decisions where it chose otherwise than the rules would have on the same state show where
 * it went wrong. Nothing here knows a game.
 */

import { GameBrowser } from "../devtools/client";
import { RulesTeacher } from "../distill/teacher";
import { DecisionEngine, EngineKind } from "../engine";
import { GameDefinition, Profile } from "../game/types";
import { Library } from "../library/store";
import { EpisodeResult, isExtractorErrorState, Pace, PlayResult, TickEvent } from "../play/player";
import { playGame } from "../run/play";
import { DEFAULT_TRAIN_SEEDS } from "../train/trainer";

/** What is to be fixed for an engine on a clock. */
export enum Verdict {
    /** It plays as well as its reference: nothing found. */
    NOTHING = "nothing",
    /** The engine plays worse than the rules on the same clock (or than its record, a version without rules). */
    ENGINE = "engine",
    /** The rules play worse than their record on this clock: the version is what to train. */
    RULES = "rules",
}

/** Games a seed is played with the clock running: each one differs, and one bad game in five is found where three often miss it. */
export const LIVE_GAMES_PER_SEED: number = 5;
/** With the clock paused a game replays the same: once a seed. */
export const PAUSED_GAMES_PER_SEED: number = 1;
/** Below this share of its reference's mean on a seed, a side plays the seed worse (live games vary: a rules game in five may lose). */
export const WORSE_SHARE: { live: number; paused: number } = { live: 0.9, paused: 0.98 };
/** How far before a game's end its decisions are looked at for where it went wrong. */
const EVIDENCE_WINDOW_MS: number = 3_000;
/** Decisions shown per game that went wrong. */
const EVIDENCE_PER_GAME: number = 5;
/** Real time: inputs landing this much past the floor are late — the engine answered slower than the version is played at. */
const LATE_MS: number = 10;

/** Where a game the engine played worse went another way than the rules: a decision before its end. */
export interface Divergence {
    atS: number;
    score?: number;
    chose: string;
    rules: string;
}

export interface CheckGame {
    seed: number;
    score: number;
    seconds: number;
    over: boolean;
    /** Real time: the lag its inputs landed at (median). */
    lagMs?: number;
    /** The engine's own time a decision (median). */
    engineMs?: number;
    decisions: number;
    /** Decisions the rules would have made otherwise (asked about every state the engine decided on). */
    disagreements: number;
    /** Played below its reference on its seed: the decisions before its end where it chose otherwise than the rules. */
    divergences?: Divergence[];
}

export interface CheckSide {
    label: string;
    games: CheckGame[];
    /** Per seed, the mean of its games. */
    means: Record<number, number>;
}

export interface CheckReport {
    gameId: string;
    version: number;
    engine: EngineKind;
    live: boolean;
    /** The engine checked. */
    played: CheckSide;
    /** The version's rules on the same clock, beside it (none when the version has none, or they are what was checked). */
    rules?: CheckSide;
    /** The version's recorded scores per seed the rules are held to: in real time as measured there, else paused. */
    record?: Record<number, number>;
    /** What to fix first: the rules, which the engine learns from, then the engine. */
    verdict: Verdict;
    /** In words, every finding, with the seeds and the numbers. */
    why: string;
    /** Seeds the rules play below their record on this clock. */
    rulesWorse: number[];
    /** Seeds the engine plays below the rules on the same clock (or, a version without rules, below its record). */
    engineWorse: number[];
    /** Every seed played below its reference, the rules' and the engine's: what a fix must lessen. */
    worseSeeds: number[];
    /** Share of the engine's decisions the rules would have made otherwise (none: no rules to ask). */
    disagreement?: number;
    /**
     * With the clock paused, every seed played the very same game — the same score in as many decisions (the rules', else
     * the engine's): the seeds do not change this game, and the check saw one game.
     */
    sameGames?: boolean;
    stopped: boolean;
}

export interface CheckOptions {
    game: GameDefinition;
    /** The version that engine and clock play (a config's, else the active one). */
    profile: Profile;
    engine: DecisionEngine;
    live: boolean;
    /** Real time: how late a lag-aware version's inputs land at the soonest (its config's lagMs). */
    minLagMs?: number;
    /** Default: the seeds the version was measured on. */
    seeds?: number[];
    /** Default: LIVE_GAMES_PER_SEED with the clock running, PAUSED_GAMES_PER_SEED paused. */
    gamesPerSeed?: number;
    signal?: AbortSignal;
    /** Before the first game: how many games the check plays, every side's. */
    onStart?(games: number): void;
    /** Each game as it ends, under its side's label. */
    onGame?(side: string, game: CheckGame): void;
    /** Each tick of every game (the UI's live view). */
    onTick?(event: TickEvent): void;
}

/** A decision the engine made, and what the rules would have chosen on its state. */
interface Asked {
    gameMs: number;
    score?: number;
    chose: string;
    rules?: string;
}

/** The action the rules give the most to, and whether `chose` is among those they give it to (a tie agrees either way). */
function rulesChoice(teacher: RulesTeacher, state: unknown, chose: string): { rules: string; agrees: boolean } | undefined {
    if (isExtractorErrorState(state)) {
        return undefined;
    }
    let probabilities: Record<string, number>;
    try {
        probabilities = teacher.teach(state);
    } catch {
        // A state the rules cannot read is not counted.
        return undefined;
    }
    const entries: Array<[string, number]> = Object.entries(probabilities);
    if (entries.length === 0) {
        return undefined;
    }
    const top: number = Math.max(...entries.map(([, p]: [string, number]): number => p));
    const rules: string = (entries.find(([, p]: [string, number]): boolean => p === top) as [string, number])[0];
    return { rules, agrees: (probabilities[chose] ?? 0) >= top };
}

function meansOf(games: CheckGame[]): Record<number, number> {
    const bySeed: Map<number, number[]> = new Map();
    for (const g of games) {
        bySeed.set(g.seed, [...(bySeed.get(g.seed) ?? []), g.score]);
    }
    return Object.fromEntries(
        [...bySeed.entries()].map(([seed, scores]: [number, number[]]): [number, number] => [
            seed,
            Number((scores.reduce((a: number, b: number): number => a + b, 0) / scores.length).toFixed(2)),
        ])
    );
}

/** The version's recorded score per seed: on a running clock as measured in real time (its lag simulated), else paused. */
function recordOf(profile: Profile, live: boolean): Record<number, number> | undefined {
    const results: Profile["results"] = profile.results;
    const seeds: number[] | undefined = results?.seeds;
    const scores: number[] | undefined = live && results?.realtime ? results.realtime.scores : results?.scores;
    if (!seeds || !scores || scores.length !== seeds.length) {
        return undefined;
    }
    return Object.fromEntries(seeds.map((seed: number, i: number): [number, number] => [seed, scores[i]]));
}

/** `a` below `share` of `b` (nothing is below a reference of 0 or less). */
/** The middle of some numbers (the upper middle of an even count), whole. */
function median(values: number[]): number {
    const sorted: number[] = [...values].sort((a: number, b: number): number => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

function worse(a: number | undefined, b: number | undefined, share: number): boolean {
    return a !== undefined && b !== undefined && b > 0 && a < b * share;
}

function list(seeds: number[], means: Record<number, number>): string {
    return seeds.map((s: number): string => `${means[s] ?? "–"}`).join(", ");
}

/**
 * Plays the engine on the clock asked (and the version's rules beside it, a different engine) on each seed, and says what to fix.
 * Games run one at a time: with the clock running, games side by side would slow each other.
 */
export async function checkPlay(openBrowser: () => GameBrowser, library: Library, options: CheckOptions): Promise<CheckReport> {
    const { game, profile, engine, live } = options;
    const seeds: number[] = options.seeds ?? profile.results?.seeds ?? game.trainSeeds ?? DEFAULT_TRAIN_SEEDS;
    const gameSeconds: number = profile.results?.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
    const perSeed: number = options.gamesPerSeed ?? (live ? LIVE_GAMES_PER_SEED : PAUSED_GAMES_PER_SEED);
    const share: number = live ? WORSE_SHARE.live : WORSE_SHARE.paused;
    const teacher: RulesTeacher | undefined = profile.teacher ? new RulesTeacher(profile) : undefined;
    const checkingRules: boolean = engine.kind === EngineKind.RULES;
    let stopped: boolean = false;
    /** The engine's decisions per game it played, labelled by the rules: kept until the reference says which games went wrong. */
    const askedOf: Map<CheckGame, Asked[]> = new Map();

    const playSide: (side: DecisionEngine, label: string, labelByRules: boolean) => Promise<CheckSide> = async (
        side: DecisionEngine,
        label: string,
        labelByRules: boolean
    ): Promise<CheckSide> => {
        const games: CheckGame[] = [];
        for (const seed of seeds) {
            for (let i: number = 0; i < perSeed && !stopped; i++) {
                const asked: Array<Asked & { state?: unknown }> = [];
                const browser: GameBrowser = openBrowser();
                let result: PlayResult;
                try {
                    result = await playGame(browser, side, library, {
                        game,
                        profile,
                        episodes: 1,
                        gameSeconds,
                        seeds: [seed],
                        pace: live ? Pace.REALTIME : Pace.TURN,
                        ...(live && options.minLagMs !== undefined ? { minLagMs: options.minLagMs } : {}),
                        ...(options.signal ? { signal: options.signal } : {}),
                        hooks: {
                            onTick: (t: TickEvent): void => {
                                if (t.asked) {
                                    asked.push({ gameMs: t.gameMs, ...(t.score !== undefined ? { score: t.score } : {}), chose: t.choice, state: t.state });
                                }
                                options.onTick?.(t);
                            },
                        },
                    });
                } finally {
                    await browser.close();
                }
                const e: EpisodeResult | undefined = result.episodes[0];
                if (result.stopped || !e) {
                    stopped = true;
                    break;
                }
                // The rules asked about each state after the game: in its time they would slow a running clock's decisions.
                let disagreements: number = 0;
                const labelled: Asked[] = asked.map((a: Asked & { state?: unknown }): Asked => {
                    const answer: { rules: string; agrees: boolean } | undefined = labelByRules && teacher ? rulesChoice(teacher, a.state, a.chose) : undefined;
                    if (answer && !answer.agrees) {
                        disagreements++;
                    }
                    return { gameMs: a.gameMs, ...(a.score !== undefined ? { score: a.score } : {}), chose: a.chose, ...(answer && !answer.agrees ? { rules: answer.rules } : {}) };
                });
                const checked: CheckGame = {
                    seed,
                    score: e.score,
                    seconds: e.gameSeconds,
                    over: e.over,
                    ...(e.lagMs !== undefined ? { lagMs: e.lagMs } : {}),
                    ...(e.engineMedianMs !== undefined ? { engineMs: Math.round(e.engineMedianMs) } : {}),
                    decisions: asked.length,
                    disagreements,
                };
                if (labelByRules) {
                    askedOf.set(checked, labelled);
                }
                games.push(checked);
                options.onGame?.(label, checked);
            }
        }
        return { label, games, means: meansOf(games) };
    };

    options.onStart?.(seeds.length * perSeed * (!checkingRules && teacher ? 2 : 1));
    const played: CheckSide = await playSide(engine, engine.label, !checkingRules && teacher !== undefined);
    const rules: CheckSide | undefined = !checkingRules && teacher && !stopped ? await playSide(teacher, teacher.label, false) : undefined;
    const record: Record<number, number> | undefined = recordOf(profile, live);
    const clock: string = live ? "with the clock running" : "with the clock paused";
    const labelled: number = played.games.reduce((n: number, g: CheckGame): number => n + (askedOf.has(g) ? g.decisions : 0), 0);
    const disagreed: number = played.games.reduce((n: number, g: CheckGame): number => n + g.disagreements, 0);
    const same: CheckGame[] = (rules ?? played).games;
    const sameGames: boolean =
        !live && seeds.length > 1 && same.length > 1 && same.every((g: CheckGame): boolean => g.score === same[0].score && g.decisions === same[0].decisions);
    const base: Omit<CheckReport, "verdict" | "why" | "rulesWorse" | "engineWorse" | "worseSeeds"> = {
        gameId: game.id,
        version: profile.version,
        engine: engine.kind,
        live,
        played,
        ...(rules ? { rules } : {}),
        ...(record ? { record } : {}),
        ...(labelled > 0 ? { disagreement: Number((disagreed / labelled).toFixed(3)) } : {}),
        ...(sameGames ? { sameGames: true } : {}),
        stopped,
    };
    if (stopped) {
        return { ...base, verdict: Verdict.NOTHING, why: "stopped before every game was played: nothing concluded", rulesWorse: [], engineWorse: [], worseSeeds: [] };
    }

    const seedsText: (worseOnes: number[]) => string = (worseOnes: number[]): string => (worseOnes.length === 1 ? `seed ${worseOnes[0]}` : `seeds ${worseOnes.join(", ")}`);
    const findings: string[] = [];
    // The rules below their record on this clock: the version is what to fix there.
    const rulesSide: CheckSide | undefined = checkingRules ? played : rules;
    const rulesWorse: number[] = rulesSide && record ? seeds.filter((s: number): boolean => worse(rulesSide.means[s], record[s], share)) : [];
    if (rulesSide && record && rulesWorse.length > 0) {
        findings.push(
            `the rules play ${seedsText(rulesWorse)} ${clock} below their record: ${list(rulesWorse, rulesSide.means)} against ${list(rulesWorse, record)}` +
                `${live && profile.results?.realtime ? " (measured with the lag simulated)" : ""}`
        );
    }
    // The engine below the rules on the same clock — or, a version without rules (one trained for Jev), below its record.
    const reference: Record<number, number> | undefined = checkingRules ? undefined : (rules?.means ?? record);
    const engineWorse: number[] = reference ? seeds.filter((s: number): boolean => worse(played.means[s], reference[s], share)) : [];
    if (reference && engineWorse.length > 0) {
        const evidence: string[] = [];
        for (const g of played.games) {
            if (!engineWorse.includes(g.seed) || !worse(g.score, reference[g.seed], share)) {
                continue;
            }
            const asked: Asked[] = askedOf.get(g) ?? [];
            const end: number = asked.length ? asked[asked.length - 1].gameMs : 0;
            g.divergences = asked
                .filter((a: Asked): boolean => a.rules !== undefined && a.gameMs >= end - EVIDENCE_WINDOW_MS)
                .slice(0, EVIDENCE_PER_GAME)
                .map((a: Asked): Divergence => ({ atS: Number((a.gameMs / 1000).toFixed(1)), ...(a.score !== undefined ? { score: a.score } : {}), chose: a.chose, rules: a.rules as string }));
            const first: Divergence | undefined = g.divergences[0];
            if (first && evidence.length < 3) {
                evidence.push(`seed ${g.seed}, ${first.atS} s${first.score !== undefined ? ` at ${first.score}` : ""}: ${first.chose} where the rules choose ${first.rules}`);
            }
        }
        const there: CheckGame[] = played.games.filter((g: CheckGame): boolean => engineWorse.includes(g.seed));
        const lostGames: CheckGame[] = there.filter((g: CheckGame): boolean => worse(g.score, reference[g.seed], share));
        // Real time, the games it lost with its inputs landing well past their floor: it answered slower than the version is
        // played at — the engine's speed, not its lessons.
        const floor: number | undefined = live ? (options.minLagMs ?? 0) : undefined;
        const late: CheckGame[] = floor !== undefined ? lostGames.filter((g: CheckGame): boolean => g.lagMs !== undefined && g.lagMs > floor + LATE_MS) : [];
        const lateText: string = late.length
            ? `; its inputs landed late in ${late.length} of them: at ${median(late.map((g: CheckGame): number => g.lagMs as number))} ms where they land at ${floor} ms at the soonest` +
              (late.some((g: CheckGame): boolean => g.engineMs !== undefined)
                  ? ` (${median(late.filter((g: CheckGame): boolean => g.engineMs !== undefined).map((g: CheckGame): number => g.engineMs as number))} ms a decision)`
                  : "")
            : "";
        findings.push(
            `${engine.label} plays ${seedsText(engineWorse)} ${clock} below ${rules ? "the rules" : "its record"}: ` +
                `${list(engineWorse, played.means)} against ${list(engineWorse, reference)} (${lostGames.length} of ${there.length} games there)` +
                lateText +
                (evidence.length ? `; before the end it went otherwise than the rules — ${evidence.join("; ")}` : "")
        );
    }
    // What to fix first: the rules (the engine learns from them), then the engine.
    const verdict: Verdict = rulesWorse.length > 0 ? Verdict.RULES : engineWorse.length > 0 ? Verdict.ENGINE : Verdict.NOTHING;
    if (verdict !== Verdict.NOTHING) {
        const worseSeeds: number[] = [...new Set([...rulesWorse, ...engineWorse])].sort((a: number, b: number): number => a - b);
        return { ...base, verdict, rulesWorse, engineWorse, worseSeeds, why: findings.join("; and ") };
    }
    const against: Record<number, number> | undefined = checkingRules ? record : (rules?.means ?? record);
    return {
        ...base,
        verdict: Verdict.NOTHING,
        rulesWorse: [],
        engineWorse: [],
        worseSeeds: [],
        why: against
            ? `${engine.label} plays every seed ${clock} as well as ${!checkingRules && rules ? "the rules" : "its record"}: ${list(seeds, played.means)} against ${list(seeds, against)}`
            : `${engine.label} played ${list(seeds, played.means)} ${clock}, with nothing to hold it to (no rules beside it, no record)`,
    };
}
