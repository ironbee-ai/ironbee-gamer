/**
 * The probe, installed before any page script runs when a game is being
 * added: which canvases the page draws on, with which context, and how (2D
 * calls counted by method) — what decides the perception adapter —, and a
 * selector for each, which the game's clicks can be aimed at.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it
 * must not reference anything outside itself.
 */

export function installProbe(): void {
    const w: any = window as any;
    const ns: any = (w.__ibgamer = w.__ibgamer || {});
    if (ns.probe) {
        return;
    }
    // What the window holds before any page script runs: whatever is added later is the page's own.
    const baseline: Set<string> = new Set(Object.getOwnPropertyNames(w));
    const contexts: WeakMap<any, string> = new WeakMap();
    const calls: Record<string, number> = {};
    const getContext: any = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: any, type: string, ...rest: any[]): any {
        const ctx: any = getContext.call(this, type, ...rest);
        if (ctx && !contexts.has(this)) {
            contexts.set(this, type);
        }
        return ctx;
    } as any;
    const P: any = CanvasRenderingContext2D.prototype;
    for (const m of ["fillRect", "strokeRect", "drawImage", "fillText", "fill", "stroke", "putImageData"]) {
        const original: any = P[m];
        P[m] = function (this: any, ...a: any[]): any {
            if (this.canvas && this.canvas.isConnected) {
                calls[m] = (calls[m] || 0) + 1;
            }
            return original.apply(this, a);
        };
    }
    const ENGINES: string[] = [
        "Phaser",
        "PIXI",
        "__PIXI_APP__",
        "THREE",
        // Three.js sets its revision here as it loads, a module or bundled build too (no THREE global).
        "__THREE__",
        "cc",
        "createjs",
        "unityInstance",
        "createUnityInstance",
        "c3_runtimeInterface",
        "Godot",
    ];
    // A selector that finds an element again on the next load (what a game's clicks land on): its id, else its
    // place under the nearest ancestor with one, or under the body. None when the page's DOM makes it fail.
    const selectorOf: (el: any) => string | undefined = (el: any): string | undefined => {
        try {
            const parts: string[] = [];
            let node: any = el;
            while (node && node !== document.body && node !== document.documentElement) {
                if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
                    return [`#${CSS.escape(node.id)}`, ...parts].join(" > ");
                }
                let n: number = 1;
                for (let s: any = node.previousElementSibling; s; s = s.previousElementSibling) {
                    if (s.localName === node.localName) {
                        n++;
                    }
                }
                parts.unshift(`${node.localName}:nth-of-type(${n})`);
                node = node.parentElement;
            }
            return [node === document.body ? "body" : "html", ...parts].join(" > ");
        } catch {
            return undefined;
        }
    };
    // Where an element is on the page (CSS pixels): a point picked on a screenshot becomes a fraction of it.
    const boxOf: (el: any) => any = (el: any): any => {
        const r: any = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    ns.probe = {
        read: (): any => {
            const canvases: any[] = Array.from(document.querySelectorAll("canvas")).map((c: any): any => ({
                width: c.width,
                height: c.height,
                context: contexts.get(c),
                box: boxOf(c),
                selector: selectorOf(c),
            }));
            // Set, not only declared: the adapters' own window.Phaser / window.PIXI accessors are there without an engine.
            const engines: string[] = ENGINES.filter((k: string): boolean => {
                try {
                    return w[k] != null;
                } catch {
                    return false;
                }
            });
            const draws2d: number = Object.values(calls).reduce((a: number, b: number): number => a + b, 0);
            // The game is on the largest canvas: a small 2D one beside a WebGL game (a frame-rate panel) is not it.
            const largest: any = [...canvases].sort((a: any, b: any): number => b.box.width * b.box.height - a.box.width * a.box.height)[0];
            let suggested: string | undefined;
            if (engines.includes("Phaser")) {
                suggested = "phaser";
            } else if (engines.includes("PIXI")) {
                suggested = "pixi";
            } else if (engines.includes("cc") && w.cc && w.cc.director) {
                suggested = "cocos";
            } else if ((engines.includes("THREE") || engines.includes("__THREE__")) && largest && /webgl/.test(largest.context || "")) {
                suggested = "three";
            } else if (draws2d > 0 && largest && largest.context === "2d") {
                suggested = "canvas2d";
            } else if (largest && largest.box.width > 0 && largest.box.height > 0) {
                // A canvas nothing above reads (WebGL from an engine without an adapter): its pixels.
                suggested = "pixels";
            }
            return {
                title: document.title,
                url: location.href,
                viewport: { width: w.innerWidth, height: w.innerHeight },
                canvases,
                // What a click is measured on when there is no canvas.
                ...(document.body ? { body: boxOf(document.body) } : {}),
                calls: { ...calls },
                engines,
                suggested,
                bodyText: (document.body ? document.body.innerText : "").slice(0, 400).replace(/\s+/g, " "),
                // The page's code: where a game keeps its state, for a reader to be written from.
                scripts: Array.from(
                    new Set([
                        ...Array.from(document.scripts)
                            .map((s: any): string => s.src)
                            .filter(Boolean),
                        ...performance
                            .getEntriesByType("resource")
                            .filter((e: any): boolean => e.initiatorType === "script" || /\.m?js(\?|$)/.test(e.name))
                            .map((e: any): string => e.name),
                    ])
                ).slice(0, 60),
                inlineScripts: Array.from(document.scripts)
                    .filter((s: any): boolean => !s.src && s.textContent.trim().length > 0)
                    .map((s: any): string => s.textContent.slice(0, 100_000))
                    .slice(0, 10),
                globals: Object.getOwnPropertyNames(w)
                    .filter((k: string): boolean => !baseline.has(k) && k !== "__ibgamer")
                    .slice(0, 200)
                    .map((k: string): string => {
                        let kind: string = "?";
                        try {
                            kind = w[k] === null ? "null" : Array.isArray(w[k]) ? "array" : typeof w[k];
                        } catch {
                            // a getter that throws
                        }
                        return `${k}: ${kind}`;
                    }),
            };
        },
    };
}
