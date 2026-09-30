/**
 * Pixel perception, for a game no other adapter reads (WebGL from an engine without an adapter, a
 * bundled engine): a read copies the page's largest canvas at its own size and averages it down, on
 * the CPU in whole numbers, into a small colour grid — the same frame gives the same grid whatever
 * the GPU was doing (the browser's scaling, used before, drew another grid when two WebGL pages
 * rendered at once) —
 * `{ w, h, box, px }`, `px` row-major with 3 hex digits a cell (4 bits a channel: "f80"), `box`
 * where the canvas is on the page. It reads whatever a canvas shows and knows nothing of what the
 * colours are: the trainer's extractor finds things by their colour.
 *
 * A WebGL context is created with `preserveDrawingBuffer: true` (merged into what the page asks
 * for): without it the drawing buffer is cleared once a frame is presented, and between two steps
 * — the clock frozen — a read would find the canvas blank.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installPixelsAdapter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.pixels) {
        return;
    }
    const HEX: string = "0123456789abcdef";
    const proto: any = HTMLCanvasElement.prototype;
    const getContext: any = proto.getContext;
    proto.getContext = function (this: any, type: any, attributes?: any, ...rest: any[]): any {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
            attributes = { ...(attributes && typeof attributes === "object" ? attributes : {}), preserveDrawingBuffer: true };
        }
        return getContext.call(this, type, attributes, ...rest);
    };
    let scratch: any;
    ns.pixels = {
        /** Why the last read returned nothing (no canvas, a canvas the page may not read back). */
        error: undefined,
        grab: (width: number, height?: number): any => {
            let game: any;
            let rect: any;
            let area: number = 0;
            for (const c of Array.from(document.querySelectorAll("canvas")) as any[]) {
                const r: any = c.getBoundingClientRect();
                if (c.width > 0 && c.height > 0 && r.width * r.height > area) {
                    game = c;
                    rect = r;
                    area = r.width * r.height;
                }
            }
            if (!game) {
                ns.pixels.error = "no canvas on the page";
                return null;
            }
            const w: number = Math.max(1, Math.round(width));
            const h: number = Math.max(4, Math.round(typeof height === "number" ? height : (w * game.height) / game.width));
            const W2: number = game.width;
            const H2: number = game.height;
            if (!scratch) {
                scratch = document.createElement("canvas");
            }
            if (scratch.width !== W2 || scratch.height !== H2) {
                scratch.width = W2;
                scratch.height = H2;
            }
            // A copy at the canvas's own size (no scaling, no smoothing: the pixels as they are)...
            const ctx: any = scratch.getContext("2d", { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, W2, H2);
            let data: any;
            try {
                ctx.drawImage(game, 0, 0);
                data = ctx.getImageData(0, 0, W2, H2).data;
            } catch (err: any) {
                // A canvas that drew another origin's image without CORS: the page itself may not read it.
                ns.pixels.error = String((err && err.message) || err).slice(0, 200);
                return null;
            }
            // ...then each cell the whole-number mean of the source pixels it covers.
            const cells: string[] = new Array(w * h);
            for (let cy: number = 0; cy < h; cy++) {
                const y0: number = Math.floor((cy * H2) / h);
                const y1: number = Math.max(y0 + 1, Math.floor(((cy + 1) * H2) / h));
                for (let cx: number = 0; cx < w; cx++) {
                    const x0: number = Math.floor((cx * W2) / w);
                    const x1: number = Math.max(x0 + 1, Math.floor(((cx + 1) * W2) / w));
                    let r: number = 0;
                    let g: number = 0;
                    let b: number = 0;
                    for (let y: number = y0; y < y1; y++) {
                        for (let x: number = x0, i: number = (y * W2 + x0) * 4; x < x1; x++, i += 4) {
                            r += data[i];
                            g += data[i + 1];
                            b += data[i + 2];
                        }
                    }
                    const n: number = (x1 - x0) * (y1 - y0);
                    const half: number = n >> 1;
                    cells[cy * w + cx] = HEX[(((r + half) / n) | 0) >> 4] + HEX[(((g + half) / n) | 0) >> 4] + HEX[(((b + half) / n) | 0) >> 4];
                }
            }
            ns.pixels.error = undefined;
            return {
                w,
                h,
                box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                px: cells.join(""),
            };
        },
    };
}
