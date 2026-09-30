/**
 * What the game tools use of IronBee DevTools, as shapes only: this plugin
 * runs inside DevTools (TOOL_PLUGINS) and never imports it. The values come in
 * at start-up through the plugin API (api.ts); these types describe them. They
 * mirror DevTools' plugin API version 1 and must change with it.
 */

import type { Page } from "playwright-core";
import type { z, ZodRawShape } from "zod";

/** The plugin API version these tools are written against. */
export const PLUGIN_API_VERSION: number = 1;

export interface ToolInput {
    [key: string]: unknown;
}

export interface ToolOutput {
    [key: string]: unknown;
}

export type ToolInputSchema = ZodRawShape;
export type ToolOutputSchema = ZodRawShape;

export interface Tool {
    name(): string;
    description(): string;
    inputSchema(): ToolInputSchema;
    outputSchema(): ToolOutputSchema;
    handle(context: BrowserToolSessionContext, args: ToolInput): Promise<ToolOutput>;
}

/** The browser session a tool acts in (the members these tools use). */
export interface BrowserToolSessionContext {
    readonly page: Page;
    /** Emptied when the page is replaced, another tab becomes active or the session closes. */
    pageState(): Map<string, unknown>;
    sessionState(): Map<string, unknown>;
}

/** What DevTools hands the plugin's factory, whatever the platform. */
export interface PluginApi {
    apiVersion: number;
    platform: string;
    z: typeof z;
    logger: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
}

/** A plugin's tools for one platform. */
export interface PlatformTools {
    tools: Tool[];
}

/** What the plugin's factory returns: its tools per platform. */
export interface ToolPlugin {
    name: string;
    apiVersion: number;
    platforms: {
        browser?: (platformApi: Record<string, unknown>) => PlatformTools;
    };
}
