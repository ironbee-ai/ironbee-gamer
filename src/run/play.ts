/**
 * One play of a game with a profile, as the CLI and the UI start it: the
 * game's own perception script (a custom adapter) read from the library.
 */

import { GameBrowser } from "../devtools/client";
import { DecisionEngine } from "../engine";
import { Perception } from "../game/types";
import { Library } from "../library/store";
import { Player, PlayOptions, PlayResult } from "../play/player";

import { readFileSync } from "fs";

export function customScriptOf(library: Library, options: Pick<PlayOptions, "game">): string | undefined {
    const perception: PlayOptions["game"]["perception"] = options.game.perception;
    if (perception.adapter !== Perception.CUSTOM || !perception.script) {
        return undefined;
    }
    const file: string | undefined = library.file(options.game.id, perception.script);
    if (!file) {
        throw new Error(`${options.game.id}: its perception script ${perception.script} is not in the library`);
    }
    return readFileSync(file, "utf-8");
}

export function playGame(browser: GameBrowser, engine: DecisionEngine, library: Library, options: Omit<PlayOptions, "customScript">): Promise<PlayResult> {
    const customScript: string | undefined = customScriptOf(library, options);
    return new Player(browser, engine).play({ ...options, ...(customScript ? { customScript } : {}) });
}
