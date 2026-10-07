/**
 * The generic Three.js adapter, installed before any page script runs. Three.js announces every
 * `Scene` and `WebGLRenderer` it makes to `window.__THREE_DEVTOOLS__` (the hook its browser devtools
 * use) — a module or bundled build too, which sets no `THREE` global — so the adapter puts an event
 * target there, keeps the scenes and renderers, and wraps each renderer's `render` to know which
 * scene each draws with which camera. The dump is of the main scene — the largest one the largest
 * canvas's renderer drew of late, through the camera it drew it to the screen with (else the last) —:
 * `{ version, camera, canvas, total, objects: [{ type, name?, group?, geo?, x, y, z, r?, yaw?, d?, sx?,
 * sy?, off?, col?, tex?, n?, parts? }], hud }`, the drawn objects (meshes, sprites, points, lines) nearest
 * the camera first, the pieces drawn at the very same place (one model's meshes) listed once — the first, its size the
 * largest's, `parts` how many. x, y, z are world units (y up); sx, sy where it shows on the canvas (CSS pixels from
 * its top-left), `off` when it is outside the picture or behind the camera; d its distance to the
 * camera; yaw the way its own +z axis points, in degrees about y (0 along +z, 90 along +x; the
 * camera's, the way it looks, likewise). `hud` is the page's own text over
 * the game (a 3D game draws its speedometer, timer and menus as page elements): `[{ t, x, y, id? }]`,
 * placed as the objects are.
 *
 * `scene()`, `camera()` and `renderer()` hand over what the dump reads, for a reader written for one
 * game (the page reader's): the game's objects, where the page keeps them in a closure.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installThreeAdapter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.three) {
        return;
    }
    /** Nodes a dump looks at, at most (a city is thousands of meshes). */
    const MAX_NODES: number = 20_000;
    /** Objects a dump lists, the nearest the camera. */
    const MAX_OBJECTS: number = 120;
    const MAX_HUD: number = 40;
    const MAX_SCENES: number = 32;
    /** Scenes a renderer's recent draws are kept for: the main one, a minimap's, a post-processing quad's. */
    const RECENT_SCENES: number = 8;
    const WRAPPED: string = "__ibgamerWrapped";
    let revision: string | undefined;
    const scenes: any[] = [];
    const renderers: Array<{ r: any; recent: Map<any, { camera: any; screenCamera?: any }> }> = [];

    const addScene: (s: any) => void = (s: any): void => {
        if (!s || scenes.includes(s)) {
            return;
        }
        scenes.push(s);
        if (scenes.length > MAX_SCENES) {
            scenes.shift();
        }
    };
    const stateOf: (r: any) => { r: any; recent: Map<any, { camera: any; screenCamera?: any }> } = (r: any): { r: any; recent: Map<any, { camera: any; screenCamera?: any }> } => {
        let s: { r: any; recent: Map<any, { camera: any; screenCamera?: any }> } | undefined = renderers.find((x: { r: any }): boolean => x.r === r);
        if (!s) {
            s = { r, recent: new Map() };
            renderers.push(s);
        }
        return s;
    };
    /** What the renderer just drew: the scene, the camera, and whether it went to the screen (no render target). */
    const note: (r: any, scene: any, camera: any) => void = (r: any, scene: any, camera: any): void => {
        if (!scene || typeof scene !== "object") {
            return;
        }
        const recent: Map<any, { camera: any; screenCamera?: any }> = stateOf(r).recent;
        let entry: { camera: any; screenCamera?: any } | undefined = recent.get(scene);
        if (entry) {
            recent.delete(scene);
        } else {
            entry = { camera };
        }
        recent.set(scene, entry);
        if (recent.size > RECENT_SCENES) {
            recent.delete(recent.keys().next().value);
        }
        entry.camera = camera;
        let toScreen: boolean = true;
        try {
            toScreen = typeof r.getRenderTarget !== "function" || r.getRenderTarget() === null;
        } catch {
            // a renderer in an odd state: taken as drawing to the screen
        }
        if (toScreen) {
            entry.screenCamera = camera;
        }
    };
    /** A renderer's own `render` (three sets it on the instance, in its constructor), wrapped once. */
    const wrapRenderer: (r: any) => void = (r: any): void => {
        if (!r || typeof r.render !== "function" || r.render[WRAPPED]) {
            return;
        }
        stateOf(r);
        const render: any = r.render;
        const wrapped: any = function (this: any, scene: any, camera: any, ...rest: any[]): any {
            try {
                note(r, scene, camera);
            } catch {
                // never in the game's way
            }
            return render.call(this, scene, camera, ...rest);
        };
        wrapped[WRAPPED] = true;
        r.render = wrapped;
    };
    const observe: (o: any) => void = (o: any): void => {
        if (!o || typeof o !== "object") {
            return;
        }
        if (o.isScene) {
            addScene(o);
        } else if (typeof o.render === "function" && o.domElement) {
            wrapRenderer(o);
            // A build that sets `render` after announcing the renderer: wrapped again once its constructor is done.
            Promise.resolve().then((): void => wrapRenderer(o));
        }
    };
    try {
        const existing: any = W.__THREE_DEVTOOLS__;
        // The Three.js browser extension may have put its own there: it is listened to as it is.
        const hub: any = existing && typeof existing.addEventListener === "function" ? existing : new EventTarget();
        hub.addEventListener("observe", (e: any): void => {
            try {
                observe(e && e.detail);
            } catch {
                // an object this adapter does not know
            }
        });
        hub.addEventListener("register", (e: any): void => {
            if (e && e.detail && e.detail.revision !== undefined) {
                revision = String(e.detail.revision);
            }
        });
        if (hub !== existing) {
            W.__THREE_DEVTOOLS__ = hub;
        }
    } catch {
        // no EventTarget: the page globals below only
    }

    /** Nodes under an object (bounded): which of the scenes drawn is the game's world. */
    const size: (root: any) => number = (root: any): number => {
        let n: number = 0;
        const stack: any[] = [root];
        while (stack.length && n < MAX_NODES) {
            const o: any = stack.pop();
            n++;
            if (o && Array.isArray(o.children)) {
                stack.push(...o.children);
            }
        }
        return n;
    };
    const largest: (list: any[]) => any = (list: any[]): any => {
        let best: any;
        let bestSize: number = -1;
        for (const s of list) {
            const n: number = size(s);
            if (n > bestSize) {
                best = s;
                bestSize = n;
            }
        }
        return best;
    };
    const area: (r: any) => number = (r: any): number => {
        try {
            const el: any = r.domElement;
            if (!el || el.isConnected === false) {
                return -1;
            }
            const b: any = el.getBoundingClientRect();
            return b.width * b.height;
        } catch {
            return 0;
        }
    };
    /** Before any scene is announced (a build without the hook): scenes and renderers page globals hold. */
    const fromGlobals: () => void = (): void => {
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
            try {
                for (const o of [value, value.scene, value.renderer]) {
                    if (o && typeof o === "object") {
                        observe(o);
                    }
                }
            } catch {
                // a global that throws when read
            }
        }
    };
    /** The renderer of the largest canvas that drew of late, the largest scene it drew, and the camera it drew it with. */
    const pick: () => { renderer?: any; scene?: any; camera?: any } = (): { renderer?: any; scene?: any; camera?: any } => {
        if (!scenes.length && !renderers.length) {
            fromGlobals();
        }
        const drawing: Array<{ r: any; recent: Map<any, { camera: any; screenCamera?: any }> }> = renderers.filter((x: { recent: Map<any, unknown> }): boolean => x.recent.size > 0);
        if (drawing.length) {
            const best: { r: any; recent: Map<any, { camera: any; screenCamera?: any }> } = drawing.reduce(
                (a: { r: any }, b: { r: any }): any => (area(b.r) > area(a.r) ? b : a)
            ) as { r: any; recent: Map<any, { camera: any; screenCamera?: any }> };
            const scene: any = largest([...best.recent.keys()]);
            const entry: { camera: any; screenCamera?: any } | undefined = best.recent.get(scene);
            return { renderer: best.r, scene, camera: entry && (entry.screenCamera || entry.camera) };
        }
        return { renderer: renderers.length ? renderers[0].r : undefined, scene: largest(scenes) };
    };

    const r2: (v: number) => number = (v: number): number => Math.round(v * 100) / 100;
    /** Whole degrees, -180 folded into 180 (the same way, told apart only by a signed zero). */
    const deg: (rad: number) => number = (rad: number): number => {
        const d: number = Math.round((rad * 180) / Math.PI);
        return d === -180 ? 180 : d;
    };
    /** A material's colour and texture: what tells one car from another. */
    const looks: (o: any, e: any) => void = (o: any, e: any): void => {
        const m: any = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!m) {
            return;
        }
        if (m.color && typeof m.color.getHex === "function") {
            e.col = `#${m.color.getHex().toString(16).padStart(6, "0")}`;
        }
        const map: any = m.map;
        if (map) {
            const img: any = map.image || (map.source && map.source.data);
            const src: any = (typeof map.name === "string" && map.name) || (img && (img.currentSrc || img.src));
            if (typeof src === "string" && src) {
                e.tex = src.startsWith("data:") ? "data" : src.slice(src.lastIndexOf("/") + 1).split("?")[0];
            }
        }
    };
    /** The page's own text over the game: leaf elements that show a short text, placed from the canvas's top-left. */
    const hudOf: (box: any) => any[] = (box: any): any[] => {
        const out: any[] = [];
        if (typeof document === "undefined" || !document.body) {
            return out;
        }
        const all: any = document.body.getElementsByTagName("*");
        for (let i: number = 0; i < all.length && i < 5_000 && out.length < MAX_HUD; i++) {
            const el: any = all[i];
            const tag: string = el.localName;
            if (tag === "script" || tag === "style" || tag === "canvas" || tag === "noscript") {
                continue;
            }
            let own: string = "";
            for (let c: any = el.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === 3) {
                    own += c.nodeValue;
                }
            }
            own = own.replace(/\s+/g, " ").trim();
            if (!own || own.length > 60) {
                continue;
            }
            const b: any = el.getBoundingClientRect();
            if (!b.width || !b.height) {
                continue;
            }
            const style: any = getComputedStyle(el);
            if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
                continue;
            }
            const e: any = { t: own, x: Math.round(b.x - (box ? box.x : 0)), y: Math.round(b.y - (box ? box.y : 0)) };
            if (el.id) {
                e.id = el.id;
            }
            out.push(e);
        }
        return out;
    };

    const dump: () => any = (): any => {
        const { renderer, scene, camera } = pick();
        if (!scene) {
            return null;
        }
        let box: any;
        try {
            box = renderer && renderer.domElement ? renderer.domElement.getBoundingClientRect() : undefined;
        } catch {
            box = undefined;
        }
        const cw: number = box ? box.width : 0;
        const ch: number = box ? box.height : 0;
        const V: any = camera && camera.matrixWorldInverse && camera.matrixWorldInverse.elements;
        const P: any = camera && camera.projectionMatrix && camera.projectionMatrix.elements;
        const C: any = camera && camera.matrixWorld && camera.matrixWorld.elements;
        const layers: any = camera && camera.layers;
        const found: any[] = [];
        /** One model's pieces (a car's body, its lights, a wheel's tyre and rim) share a node's place: listed once. */
        const byPlace: Map<string, any> = new Map();
        let total: number = 0;
        let nodes: number = 0;
        const stack: any[] = [scene];
        while (stack.length && nodes < MAX_NODES) {
            const o: any = stack.pop();
            nodes++;
            if (!o || o.visible === false) {
                continue;
            }
            if (Array.isArray(o.children)) {
                for (let i: number = o.children.length - 1; i >= 0; i--) {
                    stack.push(o.children[i]);
                }
            }
            if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) {
                continue;
            }
            if (layers && o.layers && typeof layers.mask === "number" && (layers.mask & o.layers.mask) === 0) {
                continue;
            }
            const m: any = Array.isArray(o.material) ? o.material[0] : o.material;
            if (m && m.visible === false) {
                continue;
            }
            total++;
            const M: any = o.matrixWorld && o.matrixWorld.elements;
            const x: number = M ? M[12] : (o.position && o.position.x) || 0;
            const y: number = M ? M[13] : (o.position && o.position.y) || 0;
            const z: number = M ? M[14] : (o.position && o.position.z) || 0;
            const e: any = { type: o.type || (o.constructor && o.constructor.name) || "Object3D" };
            if (typeof o.name === "string" && o.name) {
                e.name = o.name;
            }
            // The nearest named ancestor: a car's wheel says which car it is.
            for (let p: any = o.parent, up: number = 0; p && p !== scene && up < 8; p = p.parent, up++) {
                if (typeof p.name === "string" && p.name) {
                    e.group = p.name;
                    break;
                }
            }
            const geo: any = o.geometry && o.geometry.type;
            if (typeof geo === "string" && geo !== "BufferGeometry") {
                e.geo = geo;
            }
            e.x = r2(x);
            e.y = r2(y);
            e.z = r2(z);
            const sphere: any = o.geometry && o.geometry.boundingSphere;
            if (M && sphere && typeof sphere.radius === "number" && isFinite(sphere.radius)) {
                const scale: number = Math.max(Math.hypot(M[0], M[1], M[2]), Math.hypot(M[4], M[5], M[6]), Math.hypot(M[8], M[9], M[10]));
                e.r = r2(sphere.radius * scale);
            }
            if (M && (M[8] || M[10])) {
                e.yaw = deg(Math.atan2(M[8], M[10]));
            }
            if (C) {
                e.d = r2(Math.hypot(x - C[12], y - C[13], z - C[14]));
            }
            if (V && P && cw && ch) {
                const vx: number = V[0] * x + V[4] * y + V[8] * z + V[12];
                const vy: number = V[1] * x + V[5] * y + V[9] * z + V[13];
                const vz: number = V[2] * x + V[6] * y + V[10] * z + V[14];
                const vw: number = V[3] * x + V[7] * y + V[11] * z + V[15];
                const cx: number = P[0] * vx + P[4] * vy + P[8] * vz + P[12] * vw;
                const cy: number = P[1] * vx + P[5] * vy + P[9] * vz + P[13] * vw;
                const cz: number = P[2] * vx + P[6] * vy + P[10] * vz + P[14] * vw;
                const cW: number = P[3] * vx + P[7] * vy + P[11] * vz + P[15] * vw;
                if (cW > 0) {
                    const nx: number = cx / cW;
                    const ny: number = cy / cW;
                    e.sx = Math.round(((nx + 1) / 2) * cw);
                    e.sy = Math.round(((1 - ny) / 2) * ch);
                    if (Math.abs(nx) > 1 || Math.abs(ny) > 1 || cz / cW > 1) {
                        e.off = true;
                    }
                } else {
                    e.off = true;
                }
            }
            looks(o, e);
            if (o.isInstancedMesh && typeof o.count === "number") {
                e.n = o.count;
            }
            const place: string = `${e.x},${e.y},${e.z}`;
            const same: any = byPlace.get(place);
            if (same) {
                same.parts = (same.parts || 1) + 1;
                if ((e.r || 0) > (same.r || 0)) {
                    same.r = e.r;
                }
                continue;
            }
            byPlace.set(place, e);
            found.push(e);
        }
        if (C) {
            found.sort((a: any, b: any): number => a.d - b.d);
        }
        let cam: any = null;
        if (camera && C) {
            const len: number = Math.hypot(C[8], C[9], C[10]) || 1;
            cam = { type: camera.type, x: r2(C[12]), y: r2(C[13]), z: r2(C[14]), yaw: deg(Math.atan2(-C[8], -C[10])), pitch: deg(Math.asin(Math.max(-1, Math.min(1, -C[9] / len)))) };
            if (typeof camera.fov === "number") {
                cam.fov = camera.fov;
            }
        }
        return {
            version: revision || (typeof W.__THREE__ === "string" ? W.__THREE__ : undefined),
            camera: cam,
            canvas: { w: Math.round(cw), h: Math.round(ch) },
            total,
            objects: found.slice(0, MAX_OBJECTS),
            hud: hudOf(box),
        };
    };

    ns.three = {
        dump,
        scene: (): any => pick().scene,
        camera: (): any => pick().camera,
        renderer: (): any => pick().renderer,
        scenes: (): any[] => scenes.slice(),
    };
}
