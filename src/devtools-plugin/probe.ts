/**
 * `game_probe` and `game_sprite-crops`: what adding and training a game need
 * to look at — which rendering tech a page uses (after a `game_open` with the
 * probe adapter), and what a recorded sprite looks like.
 */

import { adapterReadExpression, Adapter, GameTool, PAGE_NAMESPACE, ProbeResult, SpriteCropsResult } from "../devtools/protocol";
import { pluginApi } from "./api";
import type { BrowserToolSessionContext, Tool, ToolInput, ToolInputSchema, ToolOutput, ToolOutputSchema } from "./host";

const MAX_CROPS: number = 200;

export class ProbeGame implements Tool {
    name(): string {
        return GameTool.PROBE;
    }

    description(): string {
        return "Which canvases, drawing calls and engines the page opened with the probe adapter uses, and the perception adapter that fits.";
    }

    inputSchema(): ToolInputSchema {
        return {};
    }

    outputSchema(): ToolOutputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            title: z.string(),
            url: z.string(),
            viewport: z.object({ width: z.number(), height: z.number() }).optional(),
            canvases: z.array(
                z.object({
                    width: z.number(),
                    height: z.number(),
                    context: z.string().optional(),
                    box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
                    selector: z.string().optional(),
                })
            ),
            body: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
            calls: z.record(z.number()),
            engines: z.array(z.string()),
            suggested: z.nativeEnum(Adapter).optional(),
            bodyText: z.string(),
            scripts: z.array(z.string()).optional(),
            inlineScripts: z.array(z.string()).optional(),
            globals: z.array(z.string()).optional(),
        };
    }

    async handle(context: BrowserToolSessionContext): Promise<ToolOutput> {
        const probe: ProbeResult | undefined = (await context.page.evaluate(
            `window.${PAGE_NAMESPACE} && window.${PAGE_NAMESPACE}.probe ? ${adapterReadExpression(Adapter.PROBE)} : undefined`
        )) as ProbeResult | undefined;
        if (!probe) {
            throw new Error(`the page was not opened with the ${Adapter.PROBE} adapter`);
        }
        return { ...probe };
    }
}

export class SpriteCrops implements Tool {
    name(): string {
        return GameTool.SPRITE_CROPS;
    }

    description(): string {
        return "PNG crops of sprites the canvas2d adapter recorded, by sprite key (\"<imageId>:<sx>,<sy>,<sw>,<sh>\").";
    }

    inputSchema(): ToolInputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            keys: z.array(z.string()).max(MAX_CROPS).describe("Sprite keys."),
        };
    }

    outputSchema(): ToolOutputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            crops: z.record(z.string()),
        };
    }

    async handle(context: BrowserToolSessionContext, input: ToolInput): Promise<ToolOutput> {
        const args: { keys: string[] } = input as { keys: string[] };
        const crops: Record<string, string> = (await context.page.evaluate(
            ({ ns, keys }: { ns: string; keys: string[] }): Record<string, string> => {
                const rec: { crop?: (key: string) => string | undefined } | undefined = (window as any)[ns]?.canvas2d;
                const out: Record<string, string> = {};
                for (const key of keys) {
                    try {
                        const url: string | undefined = rec?.crop?.(key);
                        if (url) {
                            out[key] = url;
                        }
                    } catch {
                        // a source that cannot be read back (a tainted image)
                    }
                }
                return out;
            },
            { ns: PAGE_NAMESPACE, keys: args.keys }
        )) as Record<string, string>;
        const result: SpriteCropsResult = { crops };
        return { ...result };
    }
}
