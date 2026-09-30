/**
 * Measures a version again, as training records it: its rules as code on the training seeds with the
 * clock paused, on the seeds training never shows, random play for the floor — and, for a version
 * trained for real time, real time simulated at the lag it was measured with (a plan profile's real
 * time is kept as recorded: plans play only with the clock running). For when the player or the page
 * changed under recorded scores (a new seed generator, another pixel read).
 */

import { RandomPlayer, RulesTeacher } from "../distill/teacher";
import { GameBrowser } from "../devtools/client";
import { DecisionEngine } from "../engine";
import { GameDefinition, Profile, ProfileResults } from "../game/types";
import { Pace, Player, PlayOptions, PlayResult } from "../play/player";
import { DEFAULT_TEST_SEEDS, DEFAULT_TRAIN_SEEDS } from "../train/trainer";

export interface MeasureOptions {
    customScript?: string;
    signal?: AbortSignal;
}

function mean(values: number[]): number {
    return values.length ? values.reduce((a: number, b: number): number => a + b, 0) / values.length : 0;
}

/** Plays the seeds at once, each in its own browser. */
async function scores(
    openBrowser: () => GameBrowser,
    game: GameDefinition,
    profile: Profile,
    seeds: number[],
    gameSeconds: number,
    engineFor: (seed: number) => DecisionEngine,
    extra: Partial<PlayOptions>,
    options: MeasureOptions
): Promise<number[]> {
    return Promise.all(
        seeds.map(async (seed: number): Promise<number> => {
            const browser: GameBrowser = openBrowser();
            try {
                const result: PlayResult = await new Player(browser, engineFor(seed)).play({
                    game,
                    profile,
                    episodes: 1,
                    gameSeconds,
                    seeds: [seed],
                    pace: Pace.TURN,
                    ...(options.customScript ? { customScript: options.customScript } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                    ...extra,
                });
                return result.episodes[0]?.score ?? 0;
            } finally {
                await browser.close();
            }
        })
    );
}

/** A version's results measured again (not saved: the caller saves them). */
export async function measureVersion(openBrowser: () => GameBrowser, game: GameDefinition, profile: Profile, options: MeasureOptions = {}): Promise<ProfileResults> {
    if (!profile.teacher) {
        throw new Error(`${game.name} v${profile.version} has no rules as code to measure it with`);
    }
    const seeds: number[] = profile.results?.seeds ?? game.trainSeeds ?? DEFAULT_TRAIN_SEEDS;
    const testSeeds: number[] = game.testSeeds ?? DEFAULT_TEST_SEEDS;
    const gameSeconds: number = profile.results?.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
    const rules: () => DecisionEngine = (): DecisionEngine => new RulesTeacher(profile);
    const [paused, test, random]: number[][] = await Promise.all([
        scores(openBrowser, game, profile, seeds, gameSeconds, rules, {}, options),
        scores(openBrowser, game, profile, testSeeds, gameSeconds, rules, {}, options),
        scores(openBrowser, game, profile, seeds, gameSeconds, (seed: number): DecisionEngine => new RandomPlayer(seed), {}, options),
    ]);
    // Real time, as the version was measured in it: its lag, simulated on the paused clock. Not a plan
    // profile's: its lag is a plan's lead, and plans play only with the clock running — tick by tick that
    // far behind is another game. A real-time score not measured again is kept as recorded, and so are the
    // unseen seeds' as training played them in real time (`realtime.test`): `test` is theirs paused.
    const recorded: ProfileResults["realtime"] = profile.results?.realtime;
    const lagMs: number | undefined = profile.plan ? undefined : recorded?.lagMs;
    const realtime: number[] | undefined =
        lagMs !== undefined ? await scores(openBrowser, game, profile, seeds, gameSeconds, rules, { simulatedLag: { minMs: lagMs, maxMs: lagMs } }, options) : undefined;
    return {
        mean: Number(mean(paused).toFixed(2)),
        scores: paused,
        seeds,
        gameSeconds,
        measuredAt: new Date().toISOString(),
        ...(realtime && lagMs !== undefined
            ? { realtime: { mean: Number(mean(realtime).toFixed(2)), scores: realtime, lagMs, ...(recorded?.test ? { test: recorded.test } : {}) } }
            : recorded
                ? { realtime: recorded }
                : {}),
        test: { mean: Number(mean(test).toFixed(2)), scores: test, seeds: testSeeds },
        random: { mean: Number(mean(random).toFixed(2)), scores: random },
    };
}
