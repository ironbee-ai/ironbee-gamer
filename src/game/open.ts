/**
 * How a game is opened: its definition turned into the `game_open` request
 * (the adapter, the read and score expressions, the seed).
 */

import { Adapter, adapterReadExpression, OpenRequest } from "../devtools/protocol";
import { GameDefinition, Perception } from "./types";

export const DEFAULT_BOOT_MS: number = 2_500;

/** The raw input's format, in words, for the tuner: what `extract(raw, memory)` is handed. */
export function rawFormat(game: GameDefinition): string {
    switch (game.perception.adapter) {
        case Perception.CANVAS2D:
            return (
                'the list of what the page drew on its canvas in the last frame: { k: "img", s: "<imageId>:<sx>,<sy>,<sw>,<sh>" (which sprite: ' +
                "the source image and the rectangle cut from it), x, y, w, h (where it landed, canvas pixels) } | " +
                '{ k: "rect", c: fillStyle, x, y, w, h } | { k: "text", t, x, y }.'
            );
        case Perception.PHASER:
            if (game.perception.read) {
                return game.perception.format ?? "what the game's own read expression returns.";
            }
            return (
                "a dump of the game engine (Phaser): { version, objects: [{ type, tex, frame?, x, y, w?, h?, a?, tint?, v?: [vx, vy], text?, name? }], " +
                "maps: [{ name, tileW, tileH, grid: tile index rows (-1 = empty) }] } (maps only when the game asks for them). x, y are world pixels " +
                "(the object's anchor point); a is its rotation in degrees (when not 0); tint is its tint colour (when not white)."
            );
        case Perception.PIXI:
            if (game.perception.read) {
                return game.perception.format ?? "what the game's own read expression returns.";
            }
            return (
                "a dump of the game's PixiJS display tree: { version, objects: [{ type, tex?, x, y, w?, h?, a?, fill?, tint?, alpha?, text?, name? }] }. " +
                "x, y are where the object is on the canvas (its world position; for drawn shapes, the top-left of what is drawn); a is its rotation in degrees (when not 0); " +
                "tex names its texture (an image file or a frame), type its kind (Sprite, Text, Graphics, …), fill a drawn shape's colour."
            );
        case Perception.COCOS:
            if (game.perception.read) {
                return game.perception.format ?? "what the game's own read expression returns.";
            }
            return (
                "a dump of the scene the game's Cocos engine runs: { version, objects: [{ type, name?, tex?, x, y, w?, h?, a?, tint?, alpha?, text? }] }. " +
                "type is what draws it (Sprite, Label, Graphics); x, y are the top-left of its box in the game's design pixels, from the top-left of the screen " +
                "(y down); a is its rotation in degrees, clockwise (when not 0); tex names its sprite frame or image; name is the node's name in the scene."
            );
        case Perception.PIXELS:
            return (
                "the game's canvas as a small colour grid: { w, h, box: { x, y, width, height } (the canvas on the page), px }, px a string of w*h cells, " +
                "row by row from the top-left, 3 hex digits a cell (red, green, blue at 4 bits each: \"f80\" is orange). The cell at column x, row y is " +
                "px.substr((y * w + x) * 3, 3); its channels parseInt(cell[0], 16) … (0–15). The grid knows no objects: find them by their colours " +
                "(what the screenshots show), as the cells of a colour and their bounding boxes. null when the page shows no canvas."
            );
        case Perception.CUSTOM:
            return game.perception.format ?? "what the game's own perception script returns.";
    }
}

export function openRequest(game: GameDefinition, options: { seed?: number; customScript?: string; realtime?: boolean } = {}): OpenRequest {
    const adapter: Perception = game.perception.adapter;
    const adapters: Adapter[] =
        adapter === Perception.CANVAS2D ? [Adapter.CANVAS2D] : adapter === Perception.PHASER ? [Adapter.PHASER] : adapter === Perception.PIXI ? [Adapter.PIXI] : adapter === Perception.COCOS ? [Adapter.COCOS] : adapter === Perception.PIXELS ? [Adapter.PIXELS] : [];
    const read: string | undefined =
        adapter === Perception.CANVAS2D
            ? adapterReadExpression(Adapter.CANVAS2D)
            : adapter === Perception.PHASER
                ? (game.perception.read ?? adapterReadExpression(Adapter.PHASER, { maps: game.perception.maps === true }))
                : adapter === Perception.PIXI
                    ? (game.perception.read ?? adapterReadExpression(Adapter.PIXI))
                    : adapter === Perception.COCOS
                        ? (game.perception.read ?? adapterReadExpression(Adapter.COCOS))
                        : adapter === Perception.PIXELS
                            ? adapterReadExpression(Adapter.PIXELS, game.perception.grid ? { grid: game.perception.grid } : {})
                            : game.perception.read;
    const seeded: boolean = game.seedable !== false && options.seed !== undefined;
    return {
        url: game.url,
        adapters,
        ...(options.customScript ? { initScripts: [options.customScript] } : {}),
        ...(seeded ? { seed: options.seed } : {}),
        ...(game.viewport ? { viewport: game.viewport } : {}),
        bootMs: game.bootMs ?? DEFAULT_BOOT_MS,
        ...(read ? { read } : {}),
        ...(game.score.expression ? { score: game.score.expression } : {}),
        ...(game.clickTarget ? { clickTarget: game.clickTarget } : {}),
        ...(game.animationClock ? { animationClock: true } : {}),
        ...(game.pageStyle ? { style: game.pageStyle } : {}),
        ...(options.realtime ? { freezeClock: false } : {}),
    };
}

/** What identifies a perceived thing across frames, for novelty: a sprite, an engine object kind. */
export function perceivedKinds(game: GameDefinition, raw: unknown): Array<{ key: string; example: Record<string, unknown> }> {
    const out: Array<{ key: string; example: Record<string, unknown> }> = [];
    if (game.perception.adapter === Perception.CANVAS2D && Array.isArray(raw)) {
        for (const item of raw as Array<Record<string, unknown>>) {
            if (item && item.k === "img" && typeof item.s === "string") {
                out.push({ key: item.s, example: { x: item.x, y: item.y, w: item.w, h: item.h } });
            }
        }
    } else if (
        (game.perception.adapter === Perception.PHASER || game.perception.adapter === Perception.PIXI || game.perception.adapter === Perception.COCOS) &&
        raw &&
        typeof raw === "object"
    ) {
        const objects: unknown = (raw as { objects?: unknown }).objects;
        if (Array.isArray(objects)) {
            for (const o of objects as Array<Record<string, unknown>>) {
                if (o) {
                    out.push({
                        key: `${String(o.type)}/${String(o.tex ?? "")}${o.frame !== undefined ? `#${String(o.frame)}` : ""}`,
                        example: { x: o.x, y: o.y, w: o.w, h: o.h },
                    });
                }
            }
        }
    }
    return out;
}
