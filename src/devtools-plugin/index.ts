/**
 * The game tools as an IronBee DevTools tool plugin: DevTools loads this
 * module at start-up (TOOL_PLUGINS=<path to the built game-tools.mjs>) and
 * registers its tools beside its own, in the browser session they act on.
 *
 * - `game_open`: a fresh load of the game with its perception installed and
 *   its clock frozen after boot.
 * - `game_step`: one move — input, game time, then the raw input and score.
 * - `game_probe`: which rendering tech and engine a page uses.
 * - `game_sprite-crops`: what a recorded sprite looks like.
 *
 * Built by scripts/build-devtools-plugin.js into one ESM file with nothing to
 * resolve: DevTools hands it zod (api.ts); Playwright comes with the session.
 */

import { setPluginApi } from "./api";
import { PLUGIN_API_VERSION, PlatformTools, PluginApi, ToolPlugin } from "./host";
import { OpenGame } from "./open";
import { ProbeGame, SpriteCrops } from "./probe";
import { StepGame } from "./step";

export default function gameToolsPlugin(api: PluginApi): ToolPlugin {
    setPluginApi(api);
    return {
        name: "ironbee-gamer game tools",
        apiVersion: PLUGIN_API_VERSION,
        platforms: {
            browser: (): PlatformTools => ({
                tools: [new OpenGame(), new StepGame(), new ProbeGame(), new SpriteCrops()],
            }),
        },
    };
}
