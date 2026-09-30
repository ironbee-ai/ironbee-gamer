/**
 * The plugin API DevTools handed this plugin at start-up (its zod and logger).
 * Read through here, after index.ts set it.
 */

import type { PluginApi } from "./host";

let common: PluginApi | undefined;

export function setPluginApi(api: PluginApi): void {
    common = api;
}

export function pluginApi(): PluginApi {
    if (!common) {
        throw new Error("the game tools plugin is used before DevTools loaded it");
    }
    return common;
}
