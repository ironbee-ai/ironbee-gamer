/**
 * The ways a game is played (`configs`): which engine, which clock, which profile version. A game that
 * lists them is offered only those — the UI and the play request both hold to them. A game that lists
 * none is offered the ways its versions have earned (playConfigs), so no one has to write them.
 */

import { EngineKind } from "../engine/types";
import { GameDefinition, PlayConfig, Profile, ProfileResults } from "./types";

/**
 * Real time for a fast engine (Laya, the rules): the lag its inputs land at when a game is played live — an answer in
 * tens of ms (Laya: 25–40 ms a decision, measured 2026-09) and the frame's step, held to a floor (LIVE_FLOOR_MS). Training
 * for real time simulates it, and a version trained so is distilled with it.
 */
export const LIVE_LATENCY: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };

/** A lag-aware version's inputs land no sooner than this live when neither its config nor its own results name a floor. */
export const LIVE_FLOOR_MS: number = 50;

/**
 * The share of its score with the clock paused a version must keep in real time (simulated, as training measured it)
 * for a game with no configs to be offered live with it: below it, the game is better played paused.
 */
export const LIVE_SHARE: number = 0.8;

/** What a profile version tells about how it plays (a profile, or the library's summary of one). */
export interface VersionFacts {
    version: number;
    lagAware?: boolean;
    hasTeacher?: boolean;
    results?: ProfileResults;
}

/** A game played live with a version: which, and the floor its inputs are held to — or, when none can, why. */
export interface LiveReadiness {
    version?: number;
    floorMs?: number;
    /** Its real-time and paused means, as training measured them. */
    realtimeMean?: number;
    pausedMean?: number;
    why?: string;
}

/**
 * The floor a lag-aware version's inputs land at live: its config's, else the lag training measured it at (where its
 * extractor's timing holds), else LIVE_FLOOR_MS. None for a version that does not make up for the lag: its inputs are
 * played as soon as they are decided.
 */
export function liveFloorMs(profile: Pick<Profile, "lagAware" | "results">, config?: PlayConfig): number | undefined {
    if (config?.lagMs !== undefined) {
        return config.lagMs;
    }
    return profile.lagAware ? (profile.results?.realtime?.lagMs ?? LIVE_FLOOR_MS) : undefined;
}

/**
 * The newest version fit to be played live: trained for real time (lag-aware), with its real-time score measured and
 * at least LIVE_SHARE of its paused one. Otherwise, why none is.
 */
export function liveReadiness(versions: VersionFacts[]): LiveReadiness {
    const trained: VersionFacts[] = versions.filter((v: VersionFacts): boolean => v.lagAware === true).sort((a: VersionFacts, b: VersionFacts): number => b.version - a.version);
    if (!trained.length) {
        return { why: "no version is trained for real time" };
    }
    for (const v of trained) {
        const realtime: number | undefined = v.results?.realtime?.mean;
        const paused: number | undefined = v.results?.mean;
        if (realtime !== undefined && paused !== undefined && realtime >= LIVE_SHARE * paused) {
            return { version: v.version, floorMs: liveFloorMs(v) as number, realtimeMean: realtime, pausedMean: paused };
        }
    }
    const newest: VersionFacts = trained[0];
    const realtime: number | undefined = newest.results?.realtime?.mean;
    return {
        why:
            realtime === undefined
                ? `v${newest.version} is trained for real time, but its real-time score is not measured`
                : `v${newest.version} plays ${realtime} in real time against ${newest.results?.mean} paused: better played paused`,
    };
}

/**
 * The ways a game is played: its own `configs`, else those its versions earn — every engine with the clock paused, and
 * live Laya and the rules on the version liveReadiness names (pinned, its inputs held to its floor; the rules only when it
 * carries them as code); never Jev, whose hundreds of ms a decision a game that does not wait cannot give.
 */
export function playConfigs(game: GameDefinition, versions: VersionFacts[]): PlayConfig[] {
    if (game.configs) {
        return game.configs;
    }
    const configs: PlayConfig[] = Object.values(EngineKind).map((engine: EngineKind): PlayConfig => ({ engine }));
    const live: LiveReadiness = liveReadiness(versions);
    if (live.version !== undefined) {
        const floor: { lagMs?: number } = live.floorMs !== undefined ? { lagMs: live.floorMs } : {};
        configs.push({ engine: EngineKind.LAYA, live: true, version: live.version, ...floor });
        if (versions.find((v: VersionFacts): boolean => v.version === live.version)?.hasTeacher) {
            configs.push({ engine: EngineKind.RULES, live: true, version: live.version, ...floor });
        }
    }
    return configs;
}

/** The config `configs` offers `engine` with that clock under, if any. */
export function offeredConfig(configs: PlayConfig[], engine: EngineKind, live: boolean): PlayConfig | undefined {
    return configs.find((c: PlayConfig): boolean => c.engine === engine && Boolean(c.live) === live);
}

/** How a config reads: "laya, live, v5, inputs ≥ 45 ms". */
export function describeConfig(config: PlayConfig): string {
    return [
        config.engine,
        config.live ? "live" : "paused",
        ...(config.version !== undefined ? [`v${config.version}`] : []),
        ...(config.lagMs !== undefined ? [`inputs ≥ ${config.lagMs} ms`] : []),
    ].join(", ");
}
