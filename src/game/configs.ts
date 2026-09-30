/**
 * The ways a game is played (`configs`): which engine, which clock, which profile version. A game that
 * lists them is offered only those — the UI and the play request both hold to them.
 */

import { EngineKind } from "../engine/types";
import { GameDefinition, PlayConfig } from "./types";

/** The config a game offers `engine` with that clock under — every one, when the game lists none. */
export function offeredConfig(game: GameDefinition, engine: EngineKind, live: boolean): PlayConfig | undefined {
    if (!game.configs) {
        return { engine, ...(live ? { live } : {}) };
    }
    return game.configs.find((c: PlayConfig): boolean => c.engine === engine && Boolean(c.live) === live);
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
