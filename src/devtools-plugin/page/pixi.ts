/**
 * The generic PixiJS adapter (v4 to v8), installed before any page script runs: it catches the
 * `PIXI` namespace as the page's build assigns it, wraps its renderers' `render` to keep the root
 * each frame draws, and dumps that display tree — `{ version, objects: [{ type, tex?, x, y, w?,
 * h?, a?, fill?, tint?, alpha?, text?, name? }] }`, the same shape as the Phaser dump (fill: a drawn
 * shape's colour). x, y are where the
 * object is on the canvas (its world position); a is its rotation in degrees when not 0.
 *
 * It needs the `PIXI` global (the browser builds set it); a game bundled with PixiJS as a module
 * keeps it private, and is read by a reader the trainer writes from the page's code instead.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installPixiAdapter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.pixi) {
        return;
    }
    let P: any;
    let root: any;
    const wrapped: WeakSet<any> = new WeakSet();
    /** Every renderer class's `render` keeps the display object it is handed (v8: `{ container }` too). */
    const wrap: (pixi: any) => void = (pixi: any): void => {
        if (!pixi) {
            return;
        }
        for (const name of ["Renderer", "WebGLRenderer", "CanvasRenderer", "WebGPURenderer", "AbstractRenderer", "SystemRenderer", "Application"]) {
            const proto: any = pixi[name] && pixi[name].prototype;
            if (!proto || wrapped.has(proto) || typeof proto.render !== "function") {
                continue;
            }
            wrapped.add(proto);
            const render: any = proto.render;
            proto.render = function (this: any, target: any, ...rest: any[]): any {
                const r: any = target && target.container ? target.container : target;
                if (r && typeof r === "object" && Array.isArray(r.children)) {
                    root = r;
                } else if (this && this.stage && Array.isArray(this.stage.children)) {
                    root = this.stage;
                }
                return render.call(this, target, ...rest);
            };
        }
    };
    try {
        Object.defineProperty(W, "PIXI", {
            configurable: true,
            get: (): any => P,
            set: (v: any): void => {
                P = v;
                try {
                    wrap(v);
                } catch {
                    // a build this adapter does not know
                }
            },
        });
    } catch {
        // PIXI defined non-configurably: wrapped when first read below
    }
    const textureOf: (o: any) => string | undefined = (o: any): string | undefined => {
        const t: any = o.texture;
        if (!t) {
            return undefined;
        }
        const ids: any = t.textureCacheIds;
        if (Array.isArray(ids) && ids.length) {
            return String(ids[0]);
        }
        if (typeof t.label === "string" && t.label) {
            return t.label;
        }
        const base: any = t.baseTexture || t.source || {};
        const src: any = (base.resource && (base.resource.url || base.resource.src)) || base.imageUrl || base.label || (base.source && base.source.src);
        if (typeof src === "string" && src) {
            return src.slice(src.lastIndexOf("/") + 1).split("?")[0];
        }
        const frame: any = t.frame;
        return frame ? `texture@${frame.x},${frame.y},${frame.width},${frame.height}` : undefined;
    };
    const node: (o: any, out: any[]) => void = (o: any, out: any[]): void => {
        if (!o || out.length > 400 || o.visible === false || o.renderable === false || o.worldAlpha === 0) {
            return;
        }
        const type: string = (o.constructor && o.constructor.name) || "DisplayObject";
        const tex: string | undefined = textureOf(o);
        const text: string | undefined = typeof o.text === "string" ? o.text : undefined;
        // Leaves and anything drawn (sprites, text, graphics); a bare container is its children.
        const drawn: boolean = Boolean(tex || text !== undefined || o.geometry || o.graphicsData || o.context);
        if (drawn) {
            const wt: any = o.worldTransform || (o.transform && o.transform.worldTransform);
            const e: any = { type, x: Math.round(wt ? wt.tx : o.x), y: Math.round(wt ? wt.ty : o.y) };
            if (tex) {
                e.tex = tex;
            }
            try {
                if (!tex && typeof o.getBounds === "function") {
                    // Graphics: where the drawing lies, not the origin it was drawn from.
                    const b: any = o.getBounds();
                    e.x = Math.round(b.x);
                    e.y = Math.round(b.y);
                    e.w = Math.round(b.width);
                    e.h = Math.round(b.height);
                } else if (o.width) {
                    e.w = Math.round(o.width);
                    e.h = Math.round(o.height);
                }
            } catch {
                // bounds of an object in an odd state: its position only
            }
            if (typeof o.rotation === "number" && o.rotation !== 0) {
                e.a = Math.round(((o.rotation * 180) / Math.PI) * 10) / 10;
            }
            // A drawn shape's own colour (v3–v4 graphicsData, v5–v7 geometry, v8 context): what tells a brick from a paddle.
            const shapes: any[] = o.graphicsData || (o.geometry && o.geometry.graphicsData) || [];
            const first: any = shapes[0];
            const fill: any = first && (first.fillColor ?? (first.fillStyle && first.fillStyle.visible !== false ? first.fillStyle.color : undefined));
            if (typeof fill === "number") {
                e.fill = `#${fill.toString(16).padStart(6, "0")}`;
            }
            if (typeof o.tint === "number" && o.tint !== 0xffffff) {
                e.tint = `#${o.tint.toString(16).padStart(6, "0")}`;
            }
            if (typeof o.alpha === "number" && o.alpha < 1) {
                e.alpha = Math.round(o.alpha * 100) / 100;
            }
            if (text !== undefined) {
                e.text = text;
            }
            const name: any = o.label || o.name;
            if (typeof name === "string" && name) {
                e.name = name;
            }
            out.push(e);
        }
        if (Array.isArray(o.children)) {
            for (const c of o.children) {
                node(c, out);
            }
        }
    };
    /** Display objects under a container (bounded): which of two candidate roots holds the game. */
    const size: (c: any, budget: number) => number = (c: any, budget: number): number => {
        let n: number = 0;
        const stack: any[] = [c];
        while (stack.length && n < budget) {
            const o: any = stack.pop();
            n++;
            if (o && Array.isArray(o.children)) {
                stack.push(...o.children);
            }
        }
        return n;
    };
    /**
     * Before the game renders a frame (a menu waiting for a key draws once, or not at all): the
     * biggest PixiJS container a page global holds — the stage, or an application's.
     */
    const findRoot: () => any = (): any => {
        const pixi: any = P || W.PIXI;
        const Container: any = pixi && (pixi.Container || pixi.DisplayObjectContainer || pixi.Stage);
        if (typeof Container !== "function") {
            return undefined;
        }
        let best: any;
        let bestSize: number = 0;
        for (const key of Object.getOwnPropertyNames(W)) {
            let value: any;
            try {
                value = W[key];
            } catch {
                continue;
            }
            if (!value || typeof value !== "object") {
                continue;
            }
            const candidate: any = value.stage instanceof Container ? value.stage : value instanceof Container ? value : undefined;
            if (candidate && !candidate.parent) {
                const n: number = size(candidate, 5_000);
                if (n > bestSize) {
                    best = candidate;
                    bestSize = n;
                }
            }
        }
        return best;
    };
    ns.pixi = {
        dump: (): any => {
            if (!root) {
                // A build that was not caught on assignment is wrapped now; until a frame is rendered, the stage a global holds.
                wrap(P || W.PIXI);
                const found: any = findRoot();
                if (!found) {
                    return null;
                }
                root = found;
            }
            const objects: any[] = [];
            node(root, objects);
            return { version: (P || W.PIXI || {}).VERSION, objects };
        },
    };
}
