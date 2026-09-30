/**
 * The generic 2D-canvas draw recorder, installed before any page script runs.
 * It knows nothing about any game: it records what each frame draws onto the
 * canvases on the page, as `{ k: "img", s: "<imageId>:<sx>,<sy>,<sw>,<sh>" }`
 * (which sprite), `{ k: "rect", c }` and `{ k: "text", t }`, each with where it
 * landed (`x, y, w, h`: the box around it, transform applied).
 *
 * An image id is given only to a source drawn onto the picture (a canvas on the page), the same one for as long as the
 * source lives, and the source is held weakly: a game that draws a fresh buffer every frame lets each one go as it would
 * without the recorder. (Until 2026-09-30 every source drawn anywhere, offscreen too, was held for good: 800×600
 * buffers made each frame took the renderer from 688 to 3656 MB in 30 s.)
 *
 * Handed to Playwright as a function: its source is sent to the page, so it
 * must not reference anything outside itself.
 */

export function installCanvas2dRecorder(): void {
    const w: any = window as any;
    const ns: any = (w.__ibgamer = w.__ibgamer || {});
    if (ns.canvas2d) {
        return;
    }
    // imgIds: source → id; sources: id → a weak reference to the source, dropped once the source is collected.
    const rec: any = { frame: [], last: [], frames: 0, open: false, imgIds: new WeakMap(), nextImg: 1, sources: new Map() };
    ns.canvas2d = rec;
    const collected: FinalizationRegistry<string> | undefined =
        typeof FinalizationRegistry === "function"
            ? new FinalizationRegistry((id: string): void => {
                rec.sources.delete(id);
            })
            : undefined;
    // Each image / canvas drawn onto the picture as a sprite source gets a short id, kept while the source lives.
    const srcId: (img: any) => string = (img: any): string => {
        let id: string | undefined = rec.imgIds.get(img);
        if (!id) {
            id = "i" + rec.nextImg++;
            rec.imgIds.set(img, id);
            rec.sources.set(id, new WeakRef(img));
            collected?.register(img, id);
        }
        return id as string;
    };
    // A frame is everything drawn in one task (one rAF callback): it closes at the next microtask. A draw from a source
    // (`img`) is keyed by the source's id, given here: only a draw onto the picture gives one.
    const push: (ctx: any, item: any, img?: any) => void = (ctx: any, item: any, img?: any): void => {
        const cv: any = ctx.canvas;
        if (!cv.isConnected) {
            return; // offscreen scratch canvases are not the picture
        }
        if (img !== undefined) {
            item.s = srcId(img) + ":" + item.s;
        }
        if (!rec.open) {
            rec.open = true;
            rec.frame = [];
            queueMicrotask((): void => {
                rec.open = false;
                rec.last = rec.frame;
                rec.frames++;
            });
        }
        // Where the rect landed: the box around its transformed corners (a mirrored or turned draw included).
        const t: any = ctx.getTransform();
        const x0: number = item.x;
        const y0: number = item.y;
        const w: number = item.w;
        const h: number = item.h;
        item.x = Math.round(Math.min(t.a * x0, t.a * (x0 + w)) + Math.min(t.c * y0, t.c * (y0 + h)) + t.e);
        item.y = Math.round(Math.min(t.b * x0, t.b * (x0 + w)) + Math.min(t.d * y0, t.d * (y0 + h)) + t.f);
        item.w = Math.round(Math.abs(t.a * w) + Math.abs(t.c * h));
        item.h = Math.round(Math.abs(t.b * w) + Math.abs(t.d * h));
        item.cv = cv.id || cv.className || "canvas";
        rec.frame.push(item);
    };
    const P: any = CanvasRenderingContext2D.prototype;
    const drawImage: any = P.drawImage;
    const fillRect: any = P.fillRect;
    const fillText: any = P.fillText;
    P.drawImage = function (this: any, img: any, ...a: any[]): any {
        try {
            let sx: number = 0;
            let sy: number = 0;
            let sw: number = img.width;
            let sh: number = img.height;
            let dx: number;
            let dy: number;
            let dw: number;
            let dh: number;
            if (a.length === 2) {
                [dx, dy] = a;
                dw = sw;
                dh = sh;
            } else if (a.length === 4) {
                [dx, dy, dw, dh] = a;
            } else {
                [sx, sy, sw, sh, dx, dy, dw, dh] = a;
            }
            push(this, { k: "img", s: [sx, sy, sw, sh].map(Math.round).join(","), x: dx, y: dy, w: dw, h: dh }, img);
        } catch {
            // never break the page's drawing
        }
        return drawImage.call(this, img, ...a);
    };
    P.fillRect = function (this: any, x: number, y: number, rw: number, rh: number): any {
        try {
            push(this, { k: "rect", c: String(this.fillStyle), x, y, w: rw, h: rh });
        } catch {
            // never break the page's drawing
        }
        return fillRect.call(this, x, y, rw, rh);
    };
    P.fillText = function (this: any, text: string, x: number, y: number, ...r: any[]): any {
        try {
            push(this, { k: "text", t: String(text), x, y, w: 0, h: 0 });
        } catch {
            // never break the page's drawing
        }
        return fillText.call(this, text, x, y, ...r);
    };
    // A crop of one sprite, as a PNG data URL (to label it once); nothing once its source is gone.
    rec.crop = (key: string): string | undefined => {
        const [id, rect]: string[] = key.split(":");
        const img: any = rec.sources.get(id)?.deref();
        if (!img || !rect) {
            return undefined;
        }
        const [sx, sy, sw, sh]: number[] = rect.split(",").map(Number);
        if (![sx, sy, sw, sh].every(Number.isFinite)) {
            return undefined;
        }
        const c: HTMLCanvasElement = document.createElement("canvas");
        c.width = Math.max(1, sw);
        c.height = Math.max(1, sh);
        drawImage.call(c.getContext("2d"), img, sx, sy, sw, sh, 0, 0, sw, sh);
        return c.toDataURL("image/png");
    };
}
