/**
 * The generic Phaser adapter (v2 / CE and v3), installed before any page script
 * runs: it finds the game instance without the page exposing it and dumps what
 * the engine holds — `{ version, objects: [{ type, tex, frame?, x, y, w?, h?,
 * a?, tint?, v?: [vx, vy], text?, name? }], maps?: [{ name, tileW, tileH, grid }] }`.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it
 * must not reference anything outside itself.
 */

export function installPhaserAdapter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.phaser) {
        return;
    }
    const games: any[] = [];
    // A seeded page (page/seed.ts): Phaser seeds its RNG from Date.now() * Math.random(), and Date.now() at
    // load is the real time — so the RNG is sown again from the seeded Math.random when it is made.
    const reseed: (rnd: any) => void = (rnd: any): void => {
        if (ns.seeded && rnd && typeof rnd.sow === "function") {
            rnd.sow([String(Math.random())]);
        }
    };
    // v2 makes `game.rnd` at boot: watched from the moment the game registers itself in Phaser.GAMES.
    const watchRnd: (g: any) => void = (g: any): void => {
        let rnd: any = g.rnd;
        Object.defineProperty(g, "rnd", {
            configurable: true,
            enumerable: true,
            get: (): any => rnd,
            set: (r: any): void => {
                rnd = r;
                reseed(r);
            },
        });
    };
    // v3 keeps no registry: catch instances as they boot.
    let P: any;
    try {
        Object.defineProperty(W, "Phaser", {
            configurable: true,
            get: (): any => P,
            set: (v: any): void => {
                P = v;
                try {
                    if (v && v.Game && String(v.VERSION || "").startsWith("3")) {
                        const boot: any = v.Game.prototype.boot;
                        v.Game.prototype.boot = function (this: any, ...a: any[]): any {
                            games.push(this);
                            const out: any = boot.apply(this, a);
                            reseed(v.Math && v.Math.RND);
                            return out;
                        };
                    } else if (v && Array.isArray(v.GAMES) && !v.GAMES.__ibgamer) {
                        const list: any = v.GAMES;
                        const push: any = list.push;
                        list.__ibgamer = true;
                        list.push = function (this: any, ...items: any[]): number {
                            for (const g of items) {
                                if (g && typeof g === "object") {
                                    watchRnd(g);
                                }
                            }
                            return push.apply(this, items);
                        };
                    }
                } catch {
                    // an engine shape this adapter does not know
                }
            },
        });
    } catch {
        // Phaser already defined non-configurably: v2 is still found through Phaser.GAMES
    }
    const game: () => any = (): any => (P && P.GAMES && P.GAMES.find(Boolean)) || games[0] || (W.Phaser && W.Phaser.GAMES && W.Phaser.GAMES.find(Boolean));
    const node: (o: any, out: any[]) => void = (o: any, out: any[]): void => {
        if (!o || out.length > 400) {
            return;
        }
        const tex: any = o.key != null ? (typeof o.key === "string" ? o.key : o.key.key) : o.texture && o.texture.key;
        const frame: any = o.frameName ?? (o.frame && (o.frame.name ?? o.frame)) ?? undefined;
        const isLayer: boolean = !!(o.layer && o.map) || o.type === "TilemapLayer" || !!o.tilemap;
        if (o.visible !== false && o.alive !== false && o.active !== false && !isLayer) {
            const e: any = {
                type: o.type != null ? String(o.type) : o.constructor && o.constructor.name,
                tex,
                x: Math.round(o.world ? o.world.x : o.x),
                y: Math.round(o.world ? o.world.y : o.y),
            };
            if (frame != null && frame !== "__BASE" && typeof frame !== "object") {
                e.frame = String(frame);
            }
            if (o.width) {
                e.w = Math.round(o.width);
                e.h = Math.round(o.height);
            }
            if (typeof o.text === "string") {
                e.text = o.text;
            }
            // Rotation (degrees) and a tint other than white: state a position alone does not show.
            if (typeof o.angle === "number" && o.angle !== 0) {
                e.a = Math.round(o.angle * 10) / 10;
            }
            if (typeof o.tint === "number" && o.tint !== 0xffffff) {
                e.tint = `#${o.tint.toString(16).padStart(6, "0")}`;
            }
            if (o.body && o.body.velocity) {
                e.v = [Math.round(o.body.velocity.x), Math.round(o.body.velocity.y)];
            }
            if (o.name) {
                e.name = o.name;
            }
            if (tex || e.text) {
                out.push(e);
            }
        }
        const kids: any = o.children || o.list || (o.getChildren && o.getChildren());
        if (Array.isArray(kids)) {
            for (const c of kids) {
                node(c, out);
            }
        }
    };
    // Tilemaps: each layer as a grid of tile indices (-1 = empty).
    const maps: (g: any) => any[] = (g: any): any[] => {
        const out: any[] = [];
        const seen: Set<any> = new Set();
        const visit: (o: any) => void = (o: any): void => {
            if (!o) {
                return;
            }
            const layerData: any = o.layer && o.layer.data;
            if (Array.isArray(layerData) && !seen.has(o.layer)) {
                seen.add(o.layer);
                out.push({
                    name: o.layer.name,
                    tileW: o.layer.tileWidth || (o.map && o.map.tileWidth),
                    tileH: o.layer.tileHeight || (o.map && o.map.tileHeight),
                    grid: layerData.map((row: any[]): number[] => row.map((t: any): number => (t ? t.index : -1))),
                });
            }
            const kids: any = o.children || o.list;
            if (Array.isArray(kids)) {
                kids.forEach(visit);
            }
        };
        if (g.world) {
            visit(g.world);
        }
        if (g.scene && g.scene.scenes) {
            g.scene.scenes.forEach((s: any): void => {
                if (s.sys && s.sys.displayList) {
                    visit({ list: s.sys.displayList.list });
                }
            });
        }
        return out;
    };
    ns.phaser = {
        /** The game instance (v2 or v3): what a game definition's own `read` / score expression starts from. */
        game: (): any => game(),
        /**
         * Called once the clock is frozen: the engine's frame-time carry-over from the boot (real time) is
         * dropped, so the updates each later frame runs are the same in every run of a seed.
         */
        settle: (): void => {
            const all: any[] = [...((P && P.GAMES) || []), ...games].filter(Boolean);
            for (const g of all) {
                if (typeof g._deltaTime === "number") {
                    g._deltaTime = 0;
                }
                if (g.loop && typeof g.loop.resetDelta === "function") {
                    g.loop.resetDelta();
                }
            }
        },
        dump: (withMaps: boolean): any => {
            const g: any = game();
            if (!g) {
                return null;
            }
            const objects: any[] = [];
            if (g.world) {
                node(g.world, objects);
            }
            if (g.scene && g.scene.scenes) {
                for (const s of g.scene.scenes) {
                    if (s.sys && s.sys.settings.active) {
                        node({ list: s.sys.displayList.list }, objects);
                    }
                }
            }
            return { version: (P || W.Phaser || {}).VERSION, objects, maps: withMaps ? maps(g) : undefined };
        },
    };
}
