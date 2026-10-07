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
        case Perception.THREE:
            if (game.perception.read) {
                return game.perception.format ?? "what the game's own read expression returns.";
            }
            return (
                "a dump of the game's Three.js scene: { version, camera: { type, x, y, z, yaw, pitch, fov? } | null, canvas: { w, h }, total, " +
                "objects: [{ type, name?, group?, geo?, x, y, z, r?, yaw?, d?, sx?, sy?, off?, col?, tex?, n?, parts? }], hud: [{ t, x, y, id? }] } | null (no scene yet). " +
                "objects are what is drawn (Mesh, Sprite, Points, Line), the nearest the camera first (at most 120 of `total`): x, y, z its world position " +
                "(y up, the game's own units); r its size (bounding radius); yaw the way it faces, in degrees about y (0 along +z, 90 along +x); d its distance to the camera; sx, sy " +
                "where it shows on the canvas (CSS pixels from the top-left), off when it is outside the picture or behind the camera; name its own name, " +
                "group the nearest named object it is part of; geo its geometry's kind (BoxGeometry, …); col its material's colour, tex its texture; n an " +
                "instanced mesh's count; parts how many pieces drawn at that very place (one model's meshes: a car's body and lights) it stands for, " +
                "named as the first. The camera's yaw and pitch are where it looks. hud is the page's own text shown over the game (a speedometer, " +
                "a timer, a menu), placed as sx, sy are."
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
        adapter === Perception.CANVAS2D ? [Adapter.CANVAS2D] : adapter === Perception.PHASER ? [Adapter.PHASER] : adapter === Perception.PIXI ? [Adapter.PIXI] : adapter === Perception.COCOS ? [Adapter.COCOS] : adapter === Perception.THREE ? [Adapter.THREE] : adapter === Perception.PIXELS ? [Adapter.PIXELS] : [];
    const read: string | undefined =
        adapter === Perception.CANVAS2D
            ? adapterReadExpression(Adapter.CANVAS2D)
            : adapter === Perception.PHASER
                ? (game.perception.read ?? adapterReadExpression(Adapter.PHASER, { maps: game.perception.maps === true }))
                : adapter === Perception.PIXI
                    ? (game.perception.read ?? adapterReadExpression(Adapter.PIXI))
                    : adapter === Perception.COCOS
                        ? (game.perception.read ?? adapterReadExpression(Adapter.COCOS))
                        : adapter === Perception.THREE
                            ? (game.perception.read ?? adapterReadExpression(Adapter.THREE))
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
        (game.perception.adapter === Perception.PHASER ||
            game.perception.adapter === Perception.PIXI ||
            game.perception.adapter === Perception.COCOS ||
            game.perception.adapter === Perception.THREE) &&
        raw &&
        typeof raw === "object"
    ) {
        const objects: unknown = (raw as { objects?: unknown }).objects;
        if (Array.isArray(objects)) {
            for (const o of objects as Array<Record<string, unknown>>) {
                if (o) {
                    // A 3D object is told by its name (or the named object it is part of) more than by a texture.
                    const kind: unknown = game.perception.adapter === Perception.THREE ? (o.name ?? o.group ?? o.tex ?? o.geo) : o.tex;
                    out.push({
                        key: `${String(o.type)}/${String(kind ?? "")}${o.frame !== undefined ? `#${String(o.frame)}` : ""}`,
                        example: game.perception.adapter === Perception.THREE ? { x: o.x, y: o.y, z: o.z, sx: o.sx, sy: o.sy } : { x: o.x, y: o.y, w: o.w, h: o.h },
                    });
                }
            }
        }
    }
    return out;
}
