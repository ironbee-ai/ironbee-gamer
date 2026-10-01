/**
 * Train, for whichever engine plays the game — one action, what that engine needs done:
 *   - Jev: its rules in words trained, Jev deciding;
 *   - Rules (code): the rules as code trained, the rules deciding;
 *   - Laya: the rules as code trained, then Laya taught the version kept (a distillation). Laya with no model of the
 *     version it is to play yet is taught that version, nothing trained: what is missing is Laya's, not the rules'.
 * Train with something to check (src/improve/: a version, the engine able to play it) builds on the same two steps, with
 * a check before and after them; this is where it starts when there is nothing to check yet.
 */

import { DistillOptions, DistillResult } from "../distill/distiller";
import { checkpointFor, currentCheckpoints } from "../distill/laya-play";
import { EngineKind } from "../engine";
import { LIVE_LATENCY, offeredConfig, playConfigs } from "../game/configs";
import { GameDefinition, Profile } from "../game/types";
import { Library } from "../library/store";
import { Decider, TrainHooks, TrainOptions, TrainResult } from "./trainer";

import path from "path";

export interface TrainForDeps {
    library: Library;
    train(options: TrainOptions): Promise<TrainResult>;
    distill(options: DistillOptions): Promise<DistillResult>;
    /** What a distillation needs besides the version: the port, the teacher's rows, the rounds, … */
    distillDefaults: Omit<DistillOptions, "gameId" | "profileVersion" | "lag" | "workDir" | "signal" | "hooks">;
    /** Before a distillation: a Laya server that holds the port it serves its student on stopped (the UI's own). */
    beforeDistill?(): Promise<void>;
}

export interface TrainForOptions {
    gameId: string;
    engine: EngineKind;
    iterations: number;
    gameSeconds?: number;
    /** For real time: the rules decide as a fast engine plays live, LIVE_LATENCY late, simulated on the paused clock. */
    realtime?: boolean;
    /** Notes for the trainer (told in its every prompt). */
    note?: string;
    /** More of the training's own options (the CLI's: seeds, a start version, plans, …). */
    trainOptions?: Partial<TrainOptions>;
    /** The training's directory (what it plays and reads); a distillation works in `distill/` under it. */
    workDir: string;
    recordDir?: string;
    signal?: AbortSignal;
    hooks?: {
        train?: TrainHooks;
        distill?: DistillOptions["hooks"];
        /** Laya is about to be taught `version`: after a training (the version kept), or alone (Laya had no model of it). */
        onTeach?(version: number, alone: boolean): void;
    };
}

export interface TrainForResult {
    trained?: TrainResult;
    taught?: { version: number; result: DistillResult };
    /** Laya: why it was not taught (the training kept no version: Laya plays the one it learnt). */
    untaught?: string;
}

/**
 * The version Laya is to play on a clock that it has no model of — the one its config for that clock pins, else the
 * active one — or nothing when it has one (it learnt the version it plays).
 */
export function layaToTeach(library: Library, game: GameDefinition, live: boolean): number | undefined {
    const active: number | undefined = library.activeVersion(game.id);
    const version: number | undefined = offeredConfig(playConfigs(game, library.profiles(game.id)), EngineKind.LAYA, live)?.version ?? active;
    return version !== undefined && !checkpointFor(currentCheckpoints(library, game.id), version, active) ? version : undefined;
}

export async function trainFor(deps: TrainForDeps, options: TrainForOptions): Promise<TrainForResult> {
    const library: Library = deps.library;
    const game: GameDefinition = library.game(options.gameId);
    const laya: boolean = options.engine === EngineKind.LAYA;
    // Trained for real time (the UI's way, or the CLI's own options), Laya is to play the version its live config pins.
    const live: boolean = options.realtime === true || options.trainOptions?.realtime === true;
    const alone: number | undefined = laya ? layaToTeach(library, game, live) : undefined;
    let trained: TrainResult | undefined;
    if (alone === undefined) {
        trained = await deps.train({
            gameId: game.id,
            decider: options.engine === EngineKind.JEV ? Decider.ENGINE : Decider.RULES,
            iterations: options.iterations,
            ...(options.gameSeconds !== undefined ? { gameSeconds: options.gameSeconds } : {}),
            // For real time: as Laya plays live, simulated on the paused clock (every run the same), from the active version.
            ...(options.realtime ? { realtime: true, simulated: true, latency: LIVE_LATENCY } : {}),
            ...(options.note ? { note: options.note } : {}),
            ...options.trainOptions,
            workDir: options.workDir,
            ...(options.recordDir ? { recordDir: options.recordDir } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.hooks?.train ? { hooks: options.hooks.train } : {}),
        });
        if (!laya || trained.stopped || options.signal?.aborted) {
            return { trained };
        }
        if (!trained.savedVersions.length || trained.bestVersion === undefined) {
            return { trained, untaught: `no version beat v${trained.bestVersion}: Laya plays the version it learnt` };
        }
    }
    const version: number = alone ?? (trained?.bestVersion as number);
    options.hooks?.onTeach?.(version, alone !== undefined);
    await deps.beforeDistill?.();
    const profile: Profile = library.profile(game.id, version) as Profile;
    const result: DistillResult = await deps.distill({
        ...deps.distillDefaults,
        gameId: game.id,
        profileVersion: version,
        // A version trained for real time learns its live states too: half its games with the lag it was trained for.
        ...(profile.lagAware ? { lag: LIVE_LATENCY } : {}),
        workDir: path.join(options.workDir, "distill"),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.hooks?.distill ? { hooks: options.hooks.distill } : {}),
    });
    return { ...(trained ? { trained } : {}), taught: { version, result } };
}
