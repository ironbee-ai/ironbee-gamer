/**
 * The generic Cocos adapter (Cocos Creator 2.x and 3.x, cocos2d-js 3.x): it walks the scene the
 * director runs and dumps what is drawn — `{ version, objects: [{ type, name?, tex?, x, y, w?, h?,
 * a?, tint?, alpha?, text? }] }`, the same shape as the Phaser and PixiJS dumps. Cocos puts the
 * origin at the bottom left with y up; x, y here are from the TOP left, y down, in the game's design
 * pixels (the visible size), so every dump reads the same way. a is the rotation in degrees,
 * clockwise on screen, when not 0.
 *
 * The engine's `cc` global is read when a dump is asked for: nothing is installed before the
 * page's scripts, so the adapter cannot disturb the game's boot.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installCocosAdapter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.cocos) {
        return;
    }
    const round: (v: number) => number = (v: number): number => Math.round(v * 10) / 10;
    const basename: (s: string) => string = (s: string): string => s.slice(s.lastIndexOf("/") + 1).split("?")[0];
    /** A node's children: Creator's `children`, cocos2d-js's `getChildren()`. */
    const childrenOf: (n: any) => any[] = (n: any): any[] => {
        if (Array.isArray(n.children)) {
            return n.children;
        }
        if (typeof n.getChildren === "function") {
            return n.getChildren() || [];
        }
        return Array.isArray(n._children) ? n._children : [];
    };
    const shown: (n: any) => boolean = (n: any): boolean => {
        if (n.active === false || n.activeInHierarchy === false || n._visible === false) {
            return false;
        }
        return typeof n.isVisible !== "function" || n.isVisible() !== false;
    };
    const classOf: (cc: any, c: any) => string = (cc: any, c: any): string => {
        try {
            if (cc.js && typeof cc.js.getClassName === "function") {
                return String(cc.js.getClassName(c) || "");
            }
        } catch {
            // a component this engine version names differently
        }
        return (c && c.constructor && c.constructor.name) || "";
    };
    /** The drawing a node carries: its Sprite, Label or Graphics component (cocos2d-js: the node is one). */
    const drawingOf: (cc: any, n: any) => { kind: string; comp: any } | undefined = (cc: any, n: any): { kind: string; comp: any } | undefined => {
        const comps: any[] = n.components || n._components || [];
        for (const c of comps) {
            if (!c || c.enabled === false) {
                continue;
            }
            const k: string = classOf(cc, c);
            if (/(^|\.)Sprite$/.test(k)) {
                return { kind: "Sprite", comp: c };
            }
            if (/(^|\.)(Label|RichText)$/.test(k)) {
                return { kind: "Label", comp: c };
            }
            if (/(^|\.)Graphics$/.test(k)) {
                return { kind: "Graphics", comp: c };
            }
        }
        if (!comps.length) {
            const k: string = classOf(cc, n);
            if (typeof n.getString === "function") {
                return { kind: "Label", comp: n };
            }
            if (/Sprite$/.test(k) || typeof n.getTexture === "function") {
                return { kind: "Sprite", comp: n };
            }
        }
        return undefined;
    };
    const textureOf: (comp: any) => string | undefined = (comp: any): string | undefined => {
        const frame: any = comp.spriteFrame;
        if (frame) {
            const name: any = frame.name || frame._name;
            if (typeof name === "string" && name) {
                return name;
            }
            const tex: any = frame._texture || frame.texture;
            const url: any = tex && (tex.nativeUrl || tex.url || tex._nativeUrl);
            if (typeof url === "string" && url) {
                return basename(url);
            }
        }
        if (typeof comp.getTexture === "function") {
            const tex: any = comp.getTexture();
            const url: any = tex && (tex.url || tex._htmlElementObj?.src);
            if (typeof url === "string" && url) {
                return basename(url);
            }
        }
        return undefined;
    };
    /** Where a node's anchor is in the world (design pixels, y up). */
    const worldOf: (cc: any, n: any) => { x: number; y: number } = (cc: any, n: any): { x: number; y: number } => {
        const wp: any = n.worldPosition;
        if (wp && typeof wp.x === "number") {
            return { x: wp.x, y: wp.y };
        }
        if (typeof n.convertToWorldSpaceAR === "function") {
            const zero: any = typeof cc.v2 === "function" ? cc.v2(0, 0) : typeof cc.p === "function" ? cc.p(0, 0) : { x: 0, y: 0 };
            const v: any = n.convertToWorldSpaceAR(zero);
            return { x: v.x, y: v.y };
        }
        return { x: n.x || 0, y: n.y || 0 };
    };
    /** Content size and anchor: 3.x keeps them on the UITransform component, 2.x and cocos2d-js on the node. */
    const boxOf: (cc: any, n: any) => { w: number; h: number; ax: number; ay: number } | undefined = (cc: any, n: any): { w: number; h: number; ax: number; ay: number } | undefined => {
        const ut: any = cc.UITransform && typeof n.getComponent === "function" ? n.getComponent(cc.UITransform) : undefined;
        if (ut && ut.contentSize) {
            return { w: ut.contentSize.width, h: ut.contentSize.height, ax: ut.anchorPoint ? ut.anchorPoint.x : 0.5, ay: ut.anchorPoint ? ut.anchorPoint.y : 0.5 };
        }
        if (typeof n.width === "number" && typeof n.height === "number") {
            return { w: n.width, h: n.height, ax: typeof n.anchorX === "number" ? n.anchorX : 0.5, ay: typeof n.anchorY === "number" ? n.anchorY : 0.5 };
        }
        if (typeof n.getContentSize === "function") {
            const s: any = n.getContentSize();
            const a: any = typeof n.getAnchorPoint === "function" ? n.getAnchorPoint() : { x: 0.5, y: 0.5 };
            return { w: s.width, h: s.height, ax: a.x, ay: a.y };
        }
        return undefined;
    };
    const node: (cc: any, n: any, height: number, scale: { x: number; y: number }, out: any[]) => void = (
        cc: any,
        n: any,
        height: number,
        scale: { x: number; y: number },
        out: any[]
    ): void => {
        if (!n || out.length > 400 || !shown(n)) {
            return;
        }
        // 3.x keeps the world scale; 2.x and cocos2d-js are multiplied down from the scene.
        const ws: { x: number; y: number } =
            n.worldScale && typeof n.worldScale.x === "number"
                ? { x: n.worldScale.x, y: n.worldScale.y }
                : { x: scale.x * (typeof n.scaleX === "number" ? n.scaleX : 1), y: scale.y * (typeof n.scaleY === "number" ? n.scaleY : 1) };
        const opacity: number = typeof n.opacity === "number" ? n.opacity : typeof n.getOpacity === "function" ? n.getOpacity() : 255;
        if (opacity === 0) {
            return;
        }
        const drawing: { kind: string; comp: any } | undefined = drawingOf(cc, n);
        if (drawing) {
            const at: { x: number; y: number } = worldOf(cc, n);
            const e: any = { type: drawing.kind };
            if (typeof n.name === "string" && n.name) {
                e.name = n.name;
            }
            const tex: string | undefined = drawing.kind === "Sprite" ? textureOf(drawing.comp) : undefined;
            if (tex) {
                e.tex = tex;
            }
            const box: { w: number; h: number; ax: number; ay: number } | undefined = boxOf(cc, n);
            if (box && box.w && box.h) {
                const w: number = Math.abs(box.w * ws.x);
                const h: number = Math.abs(box.h * ws.y);
                // The top left of the node's box, from the top left of the screen.
                e.x = round(at.x - box.ax * w);
                e.y = round(height - (at.y + (1 - box.ay) * h));
                e.w = round(w);
                e.h = round(h);
            } else {
                e.x = round(at.x);
                e.y = round(height - at.y);
            }
            // Cocos turns counter-clockwise for a positive angle (y up); cocos2d-js's rotation is clockwise.
            const a: number = typeof n.angle === "number" ? -n.angle : typeof n.rotation === "number" ? n.rotation : 0;
            if (a) {
                e.a = round(a);
            }
            const color: any = drawing.comp.color || n.color;
            if (color && typeof color.r === "number" && (color.r !== 255 || color.g !== 255 || color.b !== 255)) {
                e.tint = `#${[color.r, color.g, color.b].map((c: number): string => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
            }
            if (opacity < 255) {
                e.alpha = Math.round((opacity / 255) * 100) / 100;
            }
            if (drawing.kind === "Label") {
                const text: any = typeof drawing.comp.string === "string" ? drawing.comp.string : typeof drawing.comp.getString === "function" ? drawing.comp.getString() : undefined;
                if (typeof text === "string") {
                    e.text = text;
                }
            }
            out.push(e);
        }
        for (const c of childrenOf(n)) {
            node(cc, c, height, ws, out);
        }
    };
    ns.cocos = {
        dump: (): any => {
            const cc: any = W.cc;
            const director: any = cc && cc.director;
            if (!director) {
                return null;
            }
            const scene: any = typeof director.getScene === "function" ? director.getScene() : typeof director.getRunningScene === "function" ? director.getRunningScene() : undefined;
            if (!scene) {
                return null;
            }
            const size: any =
                (cc.view && typeof cc.view.getVisibleSize === "function" && cc.view.getVisibleSize()) || cc.winSize || { width: 0, height: 0 };
            const objects: any[] = [];
            for (const c of childrenOf(scene)) {
                node(cc, c, size.height, { x: 1, y: 1 }, objects);
            }
            return { version: cc.ENGINE_VERSION || cc.version, objects };
        },
    };
}
