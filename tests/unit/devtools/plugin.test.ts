import { DevtoolsClient, DevtoolsError } from "../../../src/devtools/client";
import { Adapter, adapterReadExpression } from "../../../src/devtools/protocol";
import { DaemonHandle, daemonEnv, daemonHost, ensureDaemon, freePort, gameToolsPluginPath, stderrTail, toolPluginsEnv } from "../../../src/devtools/daemon";
import { setPluginApi } from "../../../src/devtools-plugin/api";
import type { BrowserToolSessionContext } from "../../../src/devtools-plugin/host";
import { closeGamePages, ListedTarget, OpenGame, openedTargets, watchGameOrigins, watchGamePages } from "../../../src/devtools-plugin/open";
import { installCanvas2dRecorder } from "../../../src/devtools-plugin/page/canvas2d";
import { installCocosAdapter } from "../../../src/devtools-plugin/page/cocos";
import { installDecodeCounter } from "../../../src/devtools-plugin/page/decodes";
import { installInputCounter } from "../../../src/devtools-plugin/page/inputs";
import { installPhaserAdapter } from "../../../src/devtools-plugin/page/phaser";
import { installPixiAdapter } from "../../../src/devtools-plugin/page/pixi";
import { installProbe } from "../../../src/devtools-plugin/page/probe";
import { installThreeAdapter } from "../../../src/devtools-plugin/page/three";
import { seedRandom } from "../../../src/devtools-plugin/page/seed";
import { clearSessionStorage } from "../../../src/devtools-plugin/page/storage";
import { GamePageState, GameSessionState, pageState } from "../../../src/devtools-plugin/state";
import { observeExpression, PartErrors, StepGame, syntaxErrors } from "../../../src/devtools-plugin/step";
import { clockMomentPassed, runGameTime } from "../../../src/devtools-plugin/time";

import { webcrypto } from "crypto";
import { EventEmitter } from "events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import v8 from "v8";
import vm from "vm";

import { z } from "zod";

setPluginApi({ apiVersion: 1, platform: "browser", z, logger: { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} } });

describe("observeExpression", (): void => {
    it("reads the raw input, the score and the clock in one expression, each failure its own", (): void => {
        const page: vm.Context = vm.createContext({ Date: { now: (): number => 1234 }, game: { frame: [1, 2], score: 7 } });
        expect(vm.runInContext(observeExpression("game.frame", "({ over: false, score: game.score })"), page)).toEqual({
            raw: [1, 2],
            score: { over: false, score: 7 },
            clockMs: 1234,
        });
        const broken: { readError?: string; scoreError?: string; clockMs: number } = vm.runInContext(observeExpression("nothing.here", "nope()"), page);
        expect(broken.readError).toMatch(/nothing/);
        expect(broken.scoreError).toMatch(/nope/);
        expect(broken.clockMs).toBe(1234);
        expect(vm.runInContext(observeExpression(undefined, undefined), page)).toEqual({ clockMs: 1234 });
    });

    it("reads an expression that ends in a // comment, and still reads what comes after it", (): void => {
        const page: vm.Context = vm.createContext({ Date: { now: (): number => 1234 }, game: { frame: [1, 2], score: 7 } });
        expect(vm.runInContext(observeExpression("game.frame // what the page shows", "({ over: false, score: game.score }) // measured"), page)).toEqual({
            raw: [1, 2],
            score: { over: false, score: 7 },
            clockMs: 1234,
        });
    });

    it("tells a read or score that does not compile — each its own part's error — from one that throws as it runs", (): void => {
        const syntax: jest.AsymmetricMatcher = expect.stringMatching(/^SyntaxError: /);
        expect(syntaxErrors("game.frame // what the page shows", "({ over: false, score: game.score })")).toEqual({});
        // Throwing is the page's to report, as it runs.
        expect(syntaxErrors("nothing.here", "nope()")).toEqual({});
        expect(syntaxErrors(undefined, undefined)).toEqual({});
        // Statements, not an expression.
        expect(syntaxErrors("const f = game.frame; f", "({ over: false, score: 1 })")).toEqual({ readError: syntax });
        expect(syntaxErrors("game.frame", "return 1")).toEqual({ scoreError: syntax });
        // One that would close the part it is spliced into does not compile either.
        const both: PartErrors = syntaxErrors("1); } catch (e) {} { (1", "({ over: false");
        expect(both).toEqual({ readError: syntax, scoreError: syntax });
    });
});

describe("the Phaser adapter", (): void => {
    it("dumps what the engine holds: positions, sizes, rotation and tint where they are not the default", (): void => {
        const page: vm.Context = vm.createContext({});
        vm.runInContext("var window = this;", page);
        vm.runInContext(`(${installPhaserAdapter.toString()})()`, page);
        vm.runInContext(
            `Phaser = { VERSION: "2.4.4", GAMES: [{ world: { children: [
                { type: 0, key: "bar", x: 320, y: 480, width: 250, height: 10, angle: -90, tint: 0xff0000 },
                { type: 0, key: "ball", x: 400, y: 480, width: 30, height: 30, angle: 0, tint: 0xffffff },
            ] } }] };`,
            page
        );
        expect(vm.runInContext("JSON.stringify(window.__ibgamer.phaser.dump(false))", page)).toBe(
            JSON.stringify({
                version: "2.4.4",
                objects: [
                    { type: "0", tex: "bar", x: 320, y: 480, w: 250, h: 10, a: -90, tint: "#ff0000" },
                    { type: "0", tex: "ball", x: 400, y: 480, w: 30, h: 30 },
                ],
            })
        );
    });
});

describe("the PixiJS adapter", (): void => {
    /** A page with the adapter installed, then a PixiJS-like build assigned to window.PIXI as a browser build does. */
    function page(): vm.Context {
        const context: vm.Context = vm.createContext({});
        vm.runInContext("var window = this;", context);
        vm.runInContext(`(${installPixiAdapter.toString()})()`, context);
        vm.runInContext(
            `function Container() { this.children = []; this.visible = true; this.parent = null; }
             Container.prototype.addChild = function (c) { c.parent = this; this.children.push(c); return c; };
             function Sprite(tex, x, y) { Container.call(this); this.texture = { textureCacheIds: [tex] }; this.worldTransform = { tx: x, ty: y }; this.width = 20; this.height = 10; this.rotation = 0; }
             Sprite.prototype = Object.create(Container.prototype); Sprite.prototype.constructor = Sprite;
             function Graphics(x, y, w, h, color) { Container.call(this); this.graphicsData = [{ fillColor: color }]; this.worldTransform = { tx: x, ty: y }; this.getBounds = function () { return { x: x, y: y, width: w, height: h }; }; }
             Graphics.prototype = Object.create(Container.prototype); Graphics.prototype.constructor = Graphics;
             function Renderer() {}
             Renderer.prototype.render = function (root) { this.drawn = root; };
             window.PIXI = { VERSION: "7.4.2", Container: Container, Renderer: Renderer };
             var stage = new Container();
             var hero = stage.addChild(new Sprite("hero.png", 100, 50)); hero.rotation = Math.PI / 2;
             stage.addChild(new Graphics(10, 400, 80, 12, 0x00ff00));
             var hidden = stage.addChild(new Sprite("ghost.png", 0, 0)); hidden.visible = false;
             var renderer = new Renderer();`,
            context
        );
        return context;
    }

    it("reads the root its renderer draws: sprites with their textures, shapes with their bounds and colour", (): void => {
        const context: vm.Context = page();
        vm.runInContext("renderer.render(stage)", context);
        expect(JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.pixi.dump())", context))).toEqual({
            version: "7.4.2",
            objects: [
                { type: "Sprite", x: 100, y: 50, tex: "hero.png", w: 20, h: 10, a: 90 },
                { type: "Graphics", x: 10, y: 400, w: 80, h: 12, fill: "#00ff00" },
            ],
        });
    });

    it("before the first frame is rendered (a menu waiting for a key), reads the stage a page global holds", (): void => {
        const context: vm.Context = page();
        const dump: { objects: Array<{ tex?: string }> } = JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.pixi.dump())", context));
        expect(dump.objects.map((o: { tex?: string }): string | undefined => o.tex)).toEqual(["hero.png", undefined]);
    });
});

describe("the Three.js adapter", (): void => {
    /**
     * A page with the adapter installed, then what a Three.js build does: it announces a renderer and its scenes to
     * window.__THREE_DEVTOOLS__ (a module build sets no THREE global). The camera stands at the origin looking down -z,
     * 90° of view on an 800×600 canvas.
     */
    function page(): vm.Context {
        const context: vm.Context = vm.createContext({ EventTarget, CustomEvent, Promise });
        vm.runInContext("var window = this;", context);
        vm.runInContext(`(${installThreeAdapter.toString()})()`, context);
        vm.runInContext(
            `var hub = window.__THREE_DEVTOOLS__;
             hub.dispatchEvent(new CustomEvent("register", { detail: { revision: "168" } }));
             function at(x, y, z) { return { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] }; }
             function mesh(name, x, y, z, colour) {
                 return { isMesh: true, type: "Mesh", name: name, visible: true, children: [], matrixWorld: at(x, y, z),
                     geometry: { type: "BoxGeometry", boundingSphere: { radius: 1 } },
                     material: { color: { getHex: function () { return colour; } } } };
             }
             function scene(children) {
                 var s = { isScene: true, type: "Scene", visible: true, children: children };
                 children.forEach(function (c) { c.parent = s; });
                 hub.dispatchEvent(new CustomEvent("observe", { detail: s }));
                 return s;
             }
             var near = 0.1, far = 1000, aspect = 800 / 600;
             var camera = { isCamera: true, type: "PerspectiveCamera", fov: 90, matrixWorld: at(0, 0, 0), matrixWorldInverse: at(0, 0, 0),
                 projectionMatrix: { elements: [1 / aspect, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0] } };
             var car = { type: "Group", name: "player", visible: true, children: [], matrixWorld: at(5, 0, -5) };
             var body = mesh("", 5, 0, -5, 0xff0000); body.parent = car; car.children.push(body);
             var lights = mesh("lights", 5, 0, -5, 0xffff00); lights.geometry.boundingSphere.radius = 2; lights.parent = car; car.children.push(lights);
             var ahead = mesh("tower", 0, 0, -10, 0x00ff00);
             var behind = mesh("wall", 0, 0, 10, 0x0000ff);
             var hidden = mesh("ghost", 0, 0, -2, 0xffffff); hidden.visible = false;
             var world = scene([car, ahead, behind, hidden]);
             var quad = scene([mesh("screen", 0, 0, 0, 0)]);
             var renderer = { domElement: { getBoundingClientRect: function () { return { x: 0, y: 0, width: 800, height: 600 }; } },
                 target: null, getRenderTarget: function () { return this.target; }, render: function (s, c) { this.drawn = s; } };
             hub.dispatchEvent(new CustomEvent("observe", { detail: renderer }));`,
            context
        );
        return context;
    }
    const dump: (context: vm.Context) => any = (context: vm.Context): any => JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.three.dump())", context));

    it("reads the largest scene its renderer draws, through the camera it draws it to the screen with: nearest first, where each shows", (): void => {
        const context: vm.Context = page();
        // A post-processing pass: the world into a target, then a quad of it to the screen.
        vm.runInContext("renderer.target = {}; renderer.render(world, { type: 'OtherCamera' }); renderer.target = null; renderer.render(world, camera); renderer.render(quad, {});", context);
        expect(vm.runInContext("renderer.drawn === quad", context)).toBe(true);
        expect(dump(context)).toEqual({
            version: "168",
            camera: { type: "PerspectiveCamera", x: 0, y: 0, z: 0, yaw: 180, pitch: 0, fov: 90 },
            canvas: { w: 800, h: 600 },
            total: 4,
            objects: [
                { type: "Mesh", group: "player", geo: "BoxGeometry", x: 5, y: 0, z: -5, r: 2, yaw: 0, d: 7.07, sx: 700, sy: 300, col: "#ff0000", parts: 2 },
                { type: "Mesh", name: "tower", geo: "BoxGeometry", x: 0, y: 0, z: -10, r: 1, yaw: 0, d: 10, sx: 400, sy: 300, col: "#00ff00" },
                { type: "Mesh", name: "wall", geo: "BoxGeometry", x: 0, y: 0, z: 10, r: 1, yaw: 0, d: 10, off: true, col: "#0000ff" },
            ],
            hud: [],
        });
        expect(vm.runInContext("window.__ibgamer.three.scene() === world && window.__ibgamer.three.camera() === camera", context)).toBe(true);
    });

    it("before a frame is drawn (a menu, loading), reads the largest scene announced: world positions only", (): void => {
        const context: vm.Context = page();
        const before: any = dump(context);
        expect(before.camera).toBeNull();
        expect(before.objects.map((o: { name?: string; group?: string }): string | undefined => o.name ?? o.group)).toEqual(["player", "tower", "wall"]);
        expect(before.objects[0]).not.toHaveProperty("sx");
    });
});

describe("the Cocos adapter", (): void => {
    /** A page with the adapter installed and a Cocos-like engine in `cc`: the dump is asked for once the scene runs. */
    function page(engine: string): vm.Context {
        const context: vm.Context = vm.createContext({});
        vm.runInContext("var window = this;", context);
        vm.runInContext(`(${installCocosAdapter.toString()})()`, context);
        vm.runInContext(engine, context);
        return context;
    }

    function dump(context: vm.Context): unknown {
        return JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.cocos.dump())", context));
    }

    it("reads a Creator 3.x scene: sprites and labels from the top left, y down, rotation clockwise", (): void => {
        const context: vm.Context = page(
            `function UITransform() {}
             function Node(name, x, y, w, h) {
                 this.name = name; this.children = []; this.active = true; this.activeInHierarchy = true; this.components = [];
                 this.worldPosition = { x: x, y: y, z: 0 }; this.worldScale = { x: 1, y: 1, z: 1 }; this.angle = 0;
                 this.ut = w === undefined ? null : { contentSize: { width: w, height: h }, anchorPoint: { x: 0.5, y: 0.5 } };
             }
             Node.prototype.getComponent = function (k) { return k === UITransform ? this.ut : null; };
             Node.prototype.addChild = function (c) { this.children.push(c); return c; };
             var scene = new Node("Scene");
             window.cc = { ENGINE_VERSION: "3.8.3", UITransform: UITransform, js: { getClassName: function (c) { return c.cid || ""; } },
                 view: { getVisibleSize: function () { return { width: 960, height: 640 }; } }, director: { getScene: function () { return scene; } } };
             var canvas = scene.addChild(new Node("Canvas", 480, 320, 960, 640));
             var hero = canvas.addChild(new Node("hero", 100, 540, 40, 60)); hero.angle = 90;
             hero.components.push({ cid: "cc.Sprite", spriteFrame: { name: "hero_run_0" }, color: { r: 255, g: 255, b: 255 } });
             var score = canvas.addChild(new Node("score", 480, 600, 200, 40));
             score.components.push({ cid: "cc.Label", string: "Score: 12", color: { r: 255, g: 0, b: 0 } });
             var ghost = canvas.addChild(new Node("ghost", 0, 0, 10, 10)); ghost.active = false;
             ghost.components.push({ cid: "cc.Sprite", spriteFrame: { name: "ghost" } });`
        );
        expect(dump(context)).toEqual({
            version: "3.8.3",
            objects: [
                { type: "Sprite", name: "hero", tex: "hero_run_0", x: 80, y: 70, w: 40, h: 60, a: -90 },
                { type: "Label", name: "score", x: 380, y: 20, w: 200, h: 40, tint: "#ff0000", text: "Score: 12" },
            ],
        });
    });

    it("reads a Creator 2.x scene: world positions from the node, scales multiplied down, opacity as alpha", (): void => {
        const context: vm.Context = page(
            `function Node(name, world, w, h, scale) {
                 this.name = name; this.children = []; this._components = []; this.active = true; this.activeInHierarchy = true;
                 this.world = world; this.width = w; this.height = h; this.anchorX = 0.5; this.anchorY = 0.5;
                 this.scaleX = scale; this.scaleY = scale; this.opacity = 255; this.angle = 0;
             }
             Node.prototype.convertToWorldSpaceAR = function () { return this.world; };
             Node.prototype.addChild = function (c) { this.children.push(c); return c; };
             var scene = new Node("Scene", { x: 0, y: 0 }, 0, 0, 1);
             window.cc = { ENGINE_VERSION: "2.4.13", v2: function (x, y) { return { x: x, y: y }; }, js: { getClassName: function (c) { return c.cid || ""; } },
                 view: { getVisibleSize: function () { return { width: 960, height: 640 }; } }, director: { getScene: function () { return scene; } } };
             var root = scene.addChild(new Node("root", { x: 0, y: 0 }, 0, 0, 2));
             var coin = root.addChild(new Node("coin", { x: 100, y: 120 }, 10, 10, 1)); coin.opacity = 128;
             coin._components.push({ cid: "cc.Sprite", spriteFrame: { _texture: { nativeUrl: "res/raw-assets/coin.png?v=2" } } });`
        );
        expect(dump(context)).toEqual({ version: "2.4.13", objects: [{ type: "Sprite", name: "coin", tex: "coin.png", x: 90, y: 510, w: 20, h: 20, alpha: 0.5 }] });
    });

    it("gives nothing until the engine runs a scene", (): void => {
        expect(dump(page(""))).toBeNull();
    });
});

describe("a seeded page", (): void => {
    /** A page with the Phaser adapter and (maybe) the seed, where a Phaser game is made as v2 / v3 make theirs. */
    function page(seed: number | undefined): vm.Context {
        const context: vm.Context = vm.createContext({});
        vm.runInContext("var window = this;", context);
        vm.runInContext(`(${installPhaserAdapter.toString()})()`, context);
        if (seed !== undefined) {
            vm.runInContext(`(${seedRandom.toString()})(${seed})`, context);
        }
        return context;
    }
    const rnd: string = "({ sow(s) { this.seeds = s; } })";

    it("sows Phaser 2's game.rnd from the seeded Math.random, whatever Date.now() says", (): void => {
        const sown: (seed: number | undefined) => unknown = (seed: number | undefined): unknown => {
            const context: vm.Context = page(seed);
            // Phaser 2: the game registers in Phaser.GAMES, then boot makes its RNG from Date.now() * Math.random().
            vm.runInContext(
                `Phaser = { VERSION: "2.6.2", GAMES: [] }; var g = {}; Phaser.GAMES.push(g); g.rnd = null; var r = ${rnd}; r.sow([String(Date.now() * Math.random())]); g.rnd = r;`,
                context
            );
            return vm.runInContext("JSON.stringify([g.rnd.seeds, Phaser.GAMES.length])", context);
        };
        expect(sown(7)).toBe(sown(7));
        expect(sown(7)).not.toBe(sown(8));
        // No seed: the engine's own seeding is left alone.
        expect(JSON.parse(sown(undefined) as string)[0][0]).toMatch(/^\d/);
    });

    it("sows Phaser 3's Phaser.Math.RND after the game boots", (): void => {
        const context: vm.Context = page(7);
        vm.runInContext(
            `var G = function () {}; G.prototype.boot = function () {}; Phaser = { VERSION: "3.60.0", Math: { RND: ${rnd} }, Game: G }; new Phaser.Game().boot();`,
            context
        );
        expect(vm.runInContext("Phaser.Math.RND.seeds.length", context)).toBe(1);
    });
});

describe("the seed", (): void => {
    /**
     * A document as game_open makes one: the input counter (unless `counter` is false), then the seed when there is one, over
     * a crypto shaped as the browser's — its checks and errors, its calls' length and name (randomUUID only on a secure
     * origin) — drawing Node's random values.
     */
    function doc(seed: number | undefined, options: { counter?: boolean; secure?: boolean } = {}): vm.Context {
        const context: vm.Context = vm.createContext({ nodeCrypto: webcrypto, addEventListener: (): void => {} });
        vm.runInContext(
            `var window = this;
             function Crypto() {}
             Crypto.prototype.getRandomValues = function getRandomValues(array) {
                 if (!(this instanceof Crypto)) { throw new TypeError("Illegal invocation"); }
                 return nodeCrypto.getRandomValues(array);
             };
             ${
                 options.secure === false
                     ? ""
                     : `Crypto.prototype.randomUUID = function randomUUID() {
                            if (!(this instanceof Crypto)) { throw new TypeError("Illegal invocation"); }
                            return nodeCrypto.randomUUID();
                        };`
             }
             var crypto = new Crypto();`,
            context
        );
        if (options.counter !== false) {
            vm.runInContext(`(${installInputCounter.toString()})()`, context);
        }
        if (seed !== undefined) {
            vm.runInContext(`(${seedRandom.toString()})(${seed})`, context);
        }
        return context;
    }
    const run = (context: vm.Context, code: string): unknown => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
    const thrown = (context: vm.Context, code: string): string => {
        try {
            vm.runInContext(code, context);
            return "nothing";
        } catch (err: unknown) {
            return (err as Error).name;
        }
    };
    const draws: string =
        "({ math: [Math.random(), Math.random()], ints: Array.from(crypto.getRandomValues(new Uint32Array(3))), odd: Array.from(crypto.getRandomValues(new Uint8Array(5))), uuid: crypto.randomUUID() })";

    it("draws Math.random for a seed exactly as before crypto was seeded", (): void => {
        // The seed's scramble and mulberry32 as they were written before (the library's replays were measured on them).
        const before = (seed: number, n: number): number[] => {
            let z: number = ((Math.abs(Math.floor(seed)) >>> 0) + 0x9e3779b9) | 0;
            z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
            z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
            let a: number = (z ^ (z >>> 15)) | 0;
            const out: number[] = [];
            for (let i: number = 0; i < n; i++) {
                a = (a + 0x6d2b79f5) | 0;
                let t: number = Math.imul(a ^ (a >>> 15), a | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296);
            }
            return out;
        };
        for (const seed of [7, 101, 202, 303, 0, -5, 4294967297]) {
            expect(run(doc(seed), "[Math.random(), Math.random(), Math.random(), Math.random(), Math.random()]")).toEqual(before(seed, 5));
        }
        // What a browser page of seed 7 drew first (2026-09-30).
        expect(run(doc(7), "Math.random()")).toBe(0.6779302430804819);
    });

    it("draws crypto's random values from the seed too, on a stream of their own: the same for a seed in every document, Math.random's unmoved by them", (): void => {
        const seven: unknown = run(doc(7), draws);
        expect(run(doc(7), draws)).toEqual(seven);
        expect(run(doc(8), draws)).not.toEqual(seven);
        // Unseeded, crypto is the browser's.
        expect(run(doc(undefined), draws)).not.toEqual(run(doc(undefined), draws));
        // Math.random draws the same whether or not the page asks crypto in between.
        const mixed: vm.Context = doc(7);
        const first: unknown = run(mixed, "Math.random()");
        vm.runInContext("crypto.getRandomValues(new Uint32Array(8)); crypto.randomUUID();", mixed);
        expect([first, run(mixed, "Math.random()")]).toEqual(run(doc(7), "[Math.random(), Math.random()]"));
    });

    it("keeps crypto's contract: the browser's checks and errors, the array handed back, a version 4 UUID, the calls' length and name", (): void => {
        const context: vm.Context = doc(7);
        expect(vm.runInContext("(function () { var a = new Int16Array(3); return crypto.getRandomValues(a) === a; })()", context)).toBe(true);
        expect(vm.runInContext("crypto.getRandomValues(new BigUint64Array(2)).length", context)).toBe(2);
        expect(vm.runInContext("crypto.getRandomValues(new Uint8Array(65536)).length", context)).toBe(65536);
        expect(thrown(context, "crypto.getRandomValues(new Float32Array(2))")).toBe("TypeMismatchError");
        expect(thrown(context, "crypto.getRandomValues(new DataView(new ArrayBuffer(4)))")).toBe("TypeMismatchError");
        expect(thrown(context, "crypto.getRandomValues(new Uint8Array(65537))")).toBe("QuotaExceededError");
        expect(thrown(context, "var unbound = crypto.getRandomValues; unbound(new Uint8Array(2))")).toBe("TypeError");
        expect(thrown(context, "crypto.randomUUID.call({})")).toBe("TypeError");
        expect(run(context, "[crypto.getRandomValues.length, crypto.getRandomValues.name, crypto.randomUUID.length, crypto.randomUUID.name]")).toEqual([
            1,
            "getRandomValues",
            0,
            "randomUUID",
        ]);
        for (let i: number = 0; i < 20; i++) {
            expect(vm.runInContext("crypto.randomUUID()", context)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        }
        // Where the browser has no randomUUID (a page off a secure origin), there is none.
        expect(vm.runInContext("typeof crypto.randomUUID", doc(7, { secure: false }))).toBe("undefined");
    });

    it("leaves the input counter's document id the document's own: drawn from the browser's crypto before the seed takes it over", (): void => {
        const ids: unknown[] = [doc(7), doc(7)].map((context: vm.Context): unknown => vm.runInContext("window.__ibgamer.inputsDoc", context));
        expect(ids[0]).toMatch(/^\d+-\d+$/);
        expect(ids[1]).not.toBe(ids[0]);
        // Nor does the id take from the seed's stream: a document without the counter draws the same.
        expect(run(doc(7), draws)).toEqual(run(doc(7, { counter: false }), draws));
    });
});

describe("adapterReadExpression", (): void => {
    it("names each adapter's page reader", (): void => {
        expect(adapterReadExpression(Adapter.CANVAS2D)).toBe("window.__ibgamer.canvas2d.last");
        expect(adapterReadExpression(Adapter.PHASER, { maps: true })).toBe("window.__ibgamer.phaser.dump(true)");
    });
});

describe("daemonEnv", (): void => {
    it("loads the game tools as a plugin, once, beside the env's own", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: true, env: { LIVE_VIEW_MAX_FPS: "25" } }, { TOOL_PLUGINS: "/x/other.mjs", PATH: "/bin" }, {});
        const plugins: string[] = String(env.TOOL_PLUGINS).split(path.delimiter);
        expect(plugins).toEqual(["/x/other.mjs", gameToolsPluginPath()]);
        expect(env).toMatchObject({ PLATFORM: "browser", BROWSER_HEADLESS_ENABLE: "true", LIVE_VIEW_MAX_FPS: "25", PATH: "/bin" });
        expect(toolPluginsEnv("/ours/game-tools.mjs", `/a.mjs${path.delimiter}/b.mjs`, "/a.mjs")).toBe(["/a.mjs", "/b.mjs", "/ours/game-tools.mjs"].join(path.delimiter));
    });

    it("leaves out another install's game tools a shell names (DevTools exits on a tool registered twice), and keeps its other plugins", (): void => {
        const d: string = path.delimiter;
        expect(toolPluginsEnv("/ours/game-tools.mjs", `/theirs/dist/devtools-plugin/game-tools.mjs${d}/x/other.mjs${d}/ours/game-tools.mjs`, " /elsewhere/game-tools.mjs ")).toBe(
            ["/x/other.mjs", "/ours/game-tools.mjs"].join(d)
        );
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: true }, { TOOL_PLUGINS: `/theirs/game-tools.mjs${d}/x/other.mjs` }, {});
        expect(String(env.TOOL_PLUGINS).split(d)).toEqual(["/x/other.mjs", gameToolsPluginPath()]);
    });

    it("takes none of this process's DevTools settings that would hide the game tools or change their session; the caller's env still goes in", (): void => {
        const shell: NodeJS.ProcessEnv = {
            AVAILABLE_TOOL_DOMAINS: "navigation,interaction,content",
            BROWSER_PERSISTENT_ENABLE: "true",
            BROWSER_CDP_ENABLE: "true",
            BROWSER_CDP_ENDPOINT_URL: "http://127.0.0.1:9222",
            BROWSER_DIALOG_MODE: "hold",
            BROWSER_FOLLOW_NEW_TABS: "true",
            OTEL_ENABLE: "true",
            LIVE_VIEW_WS_URL: "ws://elsewhere/live",
            LIVE_VIEW_TOKEN: "theirs",
            // An agent's host allowlists: every game of another host was refused (net::ERR_BLOCKED_BY_CLIENT).
            BROWSER_ALLOWED_DOMAINS: "example.com",
            BROWSER_ALLOWED_NAVIGATION_DOMAINS: "example.com",
            PLATFORM: "node",
            BROWSER_LOCALE: "de-DE",
            PATH: "/bin",
        };
        const dropped: string[] = [
            "AVAILABLE_TOOL_DOMAINS",
            "BROWSER_PERSISTENT_ENABLE",
            "BROWSER_CDP_ENABLE",
            "BROWSER_CDP_ENDPOINT_URL",
            "BROWSER_DIALOG_MODE",
            "BROWSER_FOLLOW_NEW_TABS",
            "OTEL_ENABLE",
            "LIVE_VIEW_WS_URL",
            "LIVE_VIEW_TOKEN",
            "BROWSER_ALLOWED_DOMAINS",
            "BROWSER_ALLOWED_NAVIGATION_DOMAINS",
        ];
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: false }, shell, {});
        for (const name of dropped) {
            expect(env[name]).toBeUndefined();
        }
        // The rest of the shell's goes in; what must hold, holds.
        expect(env).toMatchObject({ PLATFORM: "browser", BROWSER_HEADLESS_ENABLE: "false", BROWSER_LOCALE: "de-DE", PATH: "/bin" });
        expect(String(env.TOOL_PLUGINS)).toMatch(/game-tools\.mjs$/);
        // The UI's own live view is the caller's: it goes in, as would an allowlist the caller gives.
        const ui: NodeJS.ProcessEnv = daemonEnv(
            { port: 1, headless: true, env: { LIVE_VIEW_WS_URL: "ws://127.0.0.1:1986/live/producer", LIVE_VIEW_TOKEN: "ours", BROWSER_ALLOWED_DOMAINS: "127.0.0.1" } },
            shell,
            {}
        );
        expect(ui).toMatchObject({ LIVE_VIEW_WS_URL: "ws://127.0.0.1:1986/live/producer", LIVE_VIEW_TOKEN: "ours", BROWSER_ALLOWED_DOMAINS: "127.0.0.1" });
        expect(ui.BROWSER_ALLOWED_NAVIGATION_DOMAINS).toBeUndefined();
        // This process's own environment is left as it was.
        expect(shell.AVAILABLE_TOOL_DOMAINS).toBe("navigation,interaction,content");
    });

    it("has a started daemon listen where it is asked for — a revived URL's host, an IPv6 one without its brackets, else 127.0.0.1 —, whatever a shell or the caller says", (): void => {
        const host = (url: string | undefined, callerEnv?: Record<string, string>): string | undefined =>
            daemonEnv({ ...(url !== undefined ? { url } : {}), port: 2020, headless: true, ...(callerEnv ? { env: callerEnv } : {}) }, { DAEMON_HOST: "0.0.0.0" }, {}).DAEMON_HOST;
        // A DevTools that reads DAEMON_HOST listens on 127.0.0.1 by default: revived for [::1] with its port only, its
        // health check there never answered.
        expect(host("http://[::1]:2020")).toBe("::1");
        expect(host("http://localhost:2020/")).toBe("localhost");
        expect(host("http://127.0.0.1:2020")).toBe("127.0.0.1");
        expect(host(undefined)).toBe("127.0.0.1");
        expect(host("http://[::1]:2020", { DAEMON_HOST: "0.0.0.0" })).toBe("::1");
        expect(daemonHost("not a url")).toBe("127.0.0.1");
    });
});

describe("ensureDaemon", (): void => {
    let dir: string;

    beforeAll((): void => {
        dir = mkdtempSync(path.join(tmpdir(), "ibgamer-daemon-"));
    });

    afterAll((): void => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("fails at once when the daemon dies as it starts, by its exit code or by a signal (which leaves no exit code)", async (): Promise<void> => {
        const exits: string = path.join(dir, "exits.js");
        writeFileSync(exits, "process.exit(3);");
        const killed: string = path.join(dir, "killed.js");
        writeFileSync(killed, "process.kill(process.pid, 'SIGKILL');");
        const started: number = Date.now();
        await expect(ensureDaemon({ port: await freePort(), headless: true, daemonScript: exits })).rejects.toThrow("The DevTools daemon exited (code 3) during start");
        await expect(ensureDaemon({ port: await freePort(), headless: true, daemonScript: killed })).rejects.toThrow("The DevTools daemon was killed by SIGKILL during start");
        // Not after the start timeout (30 s).
        expect(Date.now() - started).toBeLessThan(10_000);
    }, 20_000);

    /** The daemons' stderr files in the temp directory now. */
    const stderrLogs: () => string[] = (): string[] => readdirSync(tmpdir()).filter((name: string): boolean => name.startsWith("ibgamer-daemon-stderr-"));
    /** Those left since `before`: other daemons (other test files, a running UI) add and remove their own meanwhile. */
    const leftSince: (before: string[]) => string[] = (before: string[]): string[] => stderrLogs().filter((name: string): boolean => !before.includes(name));

    it("tells why a daemon that dies as it starts did: the end of its stderr, and no file left behind", async (): Promise<void> => {
        const refuses: string = path.join(dir, "refuses.js");
        writeFileSync(
            refuses,
            `console.log("on stdout");
             for (let i = 0; i < 200; i++) { console.error("noise " + i); }
             console.error('[IRONBEE-DEVTOOLS] ERROR - Failed to start daemon HTTP server Error: TOOL_PLUGINS: /x/game-tools.mjs: tool "game_open" is already registered');
             process.exit(1);`
        );
        const before: string[] = stderrLogs();
        const error: Error = await ensureDaemon({ port: await freePort(), headless: true, daemonScript: refuses }).then(
            (): Error => new Error("started"),
            (err: Error): Error => err
        );
        expect(error.message).toMatch(/^The DevTools daemon exited \(code 1\) during start; its stderr ended:\n/);
        expect(error.message).toMatch(/tool "game_open" is already registered$/);
        // Its end only, from a whole line, and nothing of its stdout.
        expect(error.message).not.toMatch(/noise 0\n|on stdout/);
        expect(error.message).toMatch(/\nnoise \d+\n/);
        expect(error.message.length).toBeLessThan(2_200);
        expect(leftSince(before)).toEqual([]);
    }, 20_000);

    it("keeps the end of a daemon's stderr from a whole line", (): void => {
        const file: string = path.join(dir, "stderr.log");
        writeFileSync(file, "first line\nsecond line\nthird line\n");
        expect(stderrTail(file)).toBe("first line\nsecond line\nthird line");
        expect(stderrTail(file, 15)).toBe("third line");
        expect(stderrTail(path.join(dir, "none.log"))).toBe("");
    });

    it("revives a shared URL once when two processes revive it at once: the one whose daemon lost the port uses the other's", async (): Promise<void> => {
        // A daemon that answers on --port, exits when the port is taken (as DevTools' does on EADDRINUSE), and exits
        // when idle (one that bound the port only after the test shut the other down is gone soon too).
        const daemon: string = path.join(dir, "daemon.js");
        writeFileSync(
            daemon,
            `let idle;
             const rest = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 3000); };
             const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
             const server = require("http").createServer((req, res) => { rest(); res.end("ok", () => { if (req.url === "/shutdown") { process.exit(0); } }); });
             server.on("error", () => process.exit(1));
             server.listen(port, "127.0.0.1");
             rest();`
        );
        const port: number = await freePort();
        const url: string = `http://127.0.0.1:${port}`;
        const before: string[] = stderrLogs();
        try {
            const both: DaemonHandle[] = await Promise.all([
                ensureDaemon({ url, port, headless: true, daemonScript: daemon }),
                ensureDaemon({ url, port, headless: true, daemonScript: daemon }),
            ]);
            expect(both.map((handle: DaemonHandle): boolean => handle.owned)).toEqual([false, false]);
            // The started one writes on to its stderr unseen: the file is gone from the temp directory.
            expect(leftSince(before)).toEqual([]);
        } finally {
            await fetch(`${url}/shutdown`).catch((): undefined => undefined);
        }
        // With nothing answering there, a daemon that dies as it starts still fails the call.
        const exits: string = path.join(dir, "exits-shared.js");
        writeFileSync(exits, "process.exit(3);");
        const alone: number = await freePort();
        await expect(ensureDaemon({ url: `http://127.0.0.1:${alone}`, port: alone, headless: true, daemonScript: exits })).rejects.toThrow(
            "The DevTools daemon exited (code 3) during start"
        );
    }, 20_000);
});

/** A session context whose page must not be touched: a tool that refuses its input refuses before it. */
function untouchedContext(): BrowserToolSessionContext {
    const page: object = new Proxy(
        {},
        {
            get: (_: object, key: string | symbol): never => {
                throw new Error(`the page was touched (${String(key)})`);
            },
        }
    );
    const pageMap: Map<string, unknown> = new Map();
    const sessionMap: Map<string, unknown> = new Map();
    return { page, pageState: (): Map<string, unknown> => pageMap, sessionState: (): Map<string, unknown> => sessionMap } as unknown as BrowserToolSessionContext;
}

describe("game_open", (): void => {
    it("opens http(s) pages only: file:, data:, javascript: and browser pages are refused, by its schema and by the tool", async (): Promise<void> => {
        const schema: z.ZodTypeAny = z.object(new OpenGame().inputSchema()).strict();
        expect(schema.safeParse({ url: "https://example.com/game/" }).success).toBe(true);
        expect(schema.safeParse({ url: "http://127.0.0.1:8080/game.html#level-2" }).success).toBe(true);
        for (const url of ["file:///etc/passwd", "data:text/html,<p>hi</p>", "javascript:alert(1)", "chrome://settings", "about:blank", "ftp://example.com/"]) {
            const parsed: { success: boolean; error?: z.ZodError } = schema.safeParse({ url });
            expect(parsed.success).toBe(false);
            expect(parsed.error?.issues.map((i: z.ZodIssue): string => i.message).join("; ")).toMatch(/http/);
            await expect(new OpenGame().handle(untouchedContext(), { url, adapters: [] })).rejects.toThrow(/game_open opens http: and https: pages only/);
        }
        await expect(new OpenGame().handle(untouchedContext(), { url: "file:///etc/passwd", adapters: [] })).rejects.toThrow(/not file:/);
    });

    it("notes every web origin a game goes through for the next open to clear — its documents', its navigations' (a redirect's hops) —, the first 64", (): void => {
        const page: EventEmitter = new EventEmitter();
        const session: GameSessionState = { clockInstalled: false, gameOrigins: new Set(), gamePages: new Set() };
        watchGameOrigins(page as unknown as Parameters<typeof watchGameOrigins>[0], session);
        const commit = (url: string): void => {
            page.emit("framenavigated", { url: (): string => url });
        };
        const ask = (url: string, navigation: boolean): void => {
            page.emit("request", { url: (): string => url, isNavigationRequest: (): boolean => navigation });
        };
        commit("http://127.0.0.1:8080/game.html");
        // A bounce through a consent page, then back to the game at another fragment.
        commit("https://consent.example/ask?back=game");
        commit("http://127.0.0.1:8080/game.html#level-2");
        // A redirect's hop: asked for, never committed. What a page loads is no navigation.
        ask("https://sso.example:8443/hop", true);
        ask("https://cdn.example/sprites.png", false);
        // No web origin of their own: on their creator's (noted with it), or on none.
        for (const url of ["about:blank", "about:srcdoc", "data:text/html,<p>ad</p>", "blob:http://127.0.0.1:8080/5c1f", "chrome-error://chromewebdata/"]) {
            commit(url);
        }
        expect([...session.gameOrigins]).toEqual(["http://127.0.0.1:8080", "https://consent.example", "https://sso.example:8443"]);
        // An ad frame rotating through hosts: the first ones are kept.
        for (let i: number = 0; i < 100; i++) {
            commit(`https://ad${i}.example/slot`);
        }
        expect(session.gameOrigins.size).toBe(64);
        expect(session.gameOrigins.has("https://ad60.example")).toBe(true);
        expect(session.gameOrigins.has("https://ad61.example")).toBe(false);
    });

    it("closes every window a game opened — and those they opened — at the next open, never the session's page, and says where each was", async (): Promise<void> => {
        type WindowPage = Parameters<typeof watchGamePages>[0];
        /** A window as Playwright hands it: where it is (its frames too), its popups, its closing. */
        class GameWindow extends EventEmitter {
            closedWith: unknown = undefined;
            closed: boolean = false;
            constructor(
                public at: string,
                readonly framed: string[] = []
            ) {
                super();
            }
            url(): string {
                return this.at;
            }
            frames(): Array<{ url: () => string }> {
                return [this.at, ...this.framed].map((u: string): { url: () => string } => ({ url: (): string => u }));
            }
            isClosed(): boolean {
                return this.closed;
            }
            async close(options?: unknown): Promise<void> {
                this.closed = true;
                this.closedWith = options;
                this.emit("close");
            }
            /** Goes on to another document, as the page's own navigations are reported. */
            go(url: string): void {
                this.at = url;
                this.emit("framenavigated", { url: (): string => url });
            }
        }
        const page: GameWindow = new GameWindow("http://127.0.0.1:8080/game.html");
        const session: GameSessionState = { clockInstalled: false, gameOrigins: new Set(), gamePages: new Set() };
        watchGamePages(page as unknown as WindowPage, session);
        // A sponsor's window with a tracker's frame, which opens a leaderboard of the game's origin in turn.
        const sponsor: GameWindow = new GameWindow("https://sponsor.example/ad", ["https://tracker.example/pixel"]);
        page.emit("popup", sponsor);
        const board: GameWindow = new GameWindow("http://127.0.0.1:8080/board.html");
        sponsor.emit("popup", board);
        // What a window goes through is noted as the page's is.
        board.go("https://scores.example/top");
        // A window is reported on its first document (its response has come), which it may leave at once: where it was
        // then is noted, not only where it is by the next open.
        const hop: GameWindow = new GameWindow("https://first.example/stop");
        page.emit("popup", hop);
        hop.go("http://127.0.0.1:8080/landed.html");
        // One that closed itself is off the list; where it was is noted all the same.
        const gone: GameWindow = new GameWindow("https://gone.example/");
        page.emit("popup", gone);
        await gone.close();
        expect(session.gamePages.size).toBe(3);
        // The session's own page, were it ever listed, stays open.
        session.gamePages.add(page as unknown as WindowPage);

        const urls: string[] = await closeGamePages(page as unknown as WindowPage, session);
        expect([sponsor.closed, board.closed, hop.closed, page.closed]).toEqual([true, true, true, false]);
        // Its beforeunload is not asked.
        expect(sponsor.closedWith).toEqual({ runBeforeUnload: false });
        expect(new Set(urls)).toEqual(
            new Set(["https://sponsor.example/ad", "https://tracker.example/pixel", "https://scores.example/top", "http://127.0.0.1:8080/landed.html"])
        );
        expect(session.gamePages.size).toBe(0);
        expect(new Set(session.gameOrigins)).toEqual(
            new Set(["https://sponsor.example", "https://tracker.example", "http://127.0.0.1:8080", "https://scores.example", "https://first.example", "https://gone.example"])
        );
        // Nothing is left for the open after.
        expect(await closeGamePages(page as unknown as WindowPage, session)).toEqual([]);
    });

    it("finds the windows the session's pages opened that Playwright has not reported yet: every page of the context down a chain of openers from the page, or from one no longer open", (): void => {
        const target: (targetId: string, openerId?: string, browserContextId?: string, type?: string) => ListedTarget = (
            targetId: string,
            openerId?: string,
            browserContextId: string = "own",
            type: string = "page"
        ): ListedTarget => ({
            targetId,
            type,
            url: targetId === "late" ? "" : `https://${targetId}.example/`,
            browserContextId,
            ...(openerId !== undefined ? { openerId } : {}),
        });
        const listed: ListedTarget[] = [
            // The session's page, which DevTools opened: no opener.
            target("page"),
            // A window it opened (reported), one that window opened, and one whose server has not answered yet (no URL).
            target("sponsor", "page"),
            target("board", "sponsor"),
            target("late", "page"),
            // A noopener window is still listed with its opener.
            target("noopener", "board"),
            // A window whose opener closed (a window that closed itself, a page the session replaced).
            target("orphan", "closed-window"),
            // Not windows of this session: another context's, a page DevTools opened (no opener) and the one it opened, a frame.
            target("elsewhere", "page", "other"),
            target("devtools"),
            target("its-window", "devtools"),
            target("frame", "page", "own", "iframe"),
        ];
        expect(openedTargets("page", "own", listed).map((t: ListedTarget): string => t.targetId)).toEqual(["sponsor", "board", "late", "noopener", "orphan"]);
        // Never the session's page, even one a window of the game opened (a followed tab).
        expect(openedTargets("board", "own", listed).map((t: ListedTarget): string => t.targetId)).toEqual(["noopener", "orphan"]);
        // The order the browser lists them in does not matter: a window listed before its opener is found too.
        expect(openedTargets("page", "own", [...listed].reverse()).map((t: ListedTarget): string => t.targetId)).toEqual(["orphan", "noopener", "late", "board", "sponsor"]);
    });
});

/** A page for game_step: the inputs it is sent reach its counter (the next `lose` of them do not), read as page/inputs.ts keeps it. */
class InputPage {
    doc: string = "doc-1";
    received: number = 0;
    lose: number = 0;
    readonly keyboard: Record<string, (key: string) => Promise<void>> = {
        down: async (): Promise<void> => this.deliver(1),
        up: async (): Promise<void> => this.deliver(1),
        press: async (): Promise<void> => this.deliver(2),
    };
    readonly clock: { runFor: (ms: number) => Promise<void> } = { runFor: async (): Promise<void> => {} };

    deliver(n: number): void {
        for (let i: number = 0; i < n; i++) {
            if (this.lose > 0) {
                this.lose--;
            } else {
                this.received++;
            }
        }
    }

    async evaluate(expression: unknown): Promise<unknown> {
        return String(expression).includes("inputsDoc") ? [this.doc, this.received] : { clockMs: 0 };
    }
}

/** A page whose clock throws what Playwright throws for an error the page's own code threw in a callback it ran (after running the slice). */
class ThrowingClockPage {
    ran: number[] = [];
    closed: boolean = false;
    answers: boolean = true;
    /** The slices (by their number) whose callbacks throw, and what. */
    throws: Map<number, string> = new Map();
    readonly clock: { runFor: (ms: number) => Promise<void> } = {
        runFor: async (ms: number): Promise<void> => {
            this.ran.push(ms);
            const thrown: string | undefined = this.throws.get(this.ran.length);
            if (thrown !== undefined) {
                throw new Error(thrown);
            }
        },
    };

    isClosed(): boolean {
        return this.closed;
    }

    async evaluate(): Promise<unknown> {
        if (!this.answers) {
            throw new Error("page.evaluate: Target crashed");
        }
        return { clockMs: 0 };
    }
}

describe("game time", (): void => {
    const pageOf = (p: ThrowingClockPage): Parameters<typeof runGameTime>[0] => p as unknown as Parameters<typeof runGameTime>[0];

    it("runs on past an error the page's own code threw, and reports its first line", async (): Promise<void> => {
        const page: ThrowingClockPage = new ThrowingClockPage();
        page.throws.set(1, "clock.runFor: TypeError: Cannot read properties of null (reading 'boom')\n    at frame (http://game/:7:22)");
        expect(await runGameTime(pageOf(page), 100, false)).toBe("TypeError: Cannot read properties of null (reading 'boom')");
        expect(await runGameTime(pageOf(page), 100, false)).toBeUndefined();
        // In frames (the animation clock): every frame still runs, and the first error is the one reported.
        const framed: ThrowingClockPage = new ThrowingClockPage();
        framed.throws.set(2, "clock.runFor: first");
        framed.throws.set(4, "clock.runFor: second");
        expect(await runGameTime(pageOf(framed), 80, true)).toBe("first");
        expect(framed.ran).toEqual([16, 16, 16, 16, 16]);
    });

    it("still throws when the page is closed or crashed", async (): Promise<void> => {
        const closed: ThrowingClockPage = new ThrowingClockPage();
        closed.throws.set(1, "clock.runFor: Target page, context or browser has been closed");
        closed.closed = true;
        await expect(runGameTime(pageOf(closed), 16, false)).rejects.toThrow(/has been closed/);
        const crashed: ThrowingClockPage = new ThrowingClockPage();
        crashed.throws.set(1, "clock.runFor: Target crashed ");
        crashed.answers = false;
        await expect(runGameTime(pageOf(crashed), 16, false)).rejects.toThrow(/Target crashed/);
    });

    it("tells a moment that had passed by Playwright's message, not by what the page's stack names", (): void => {
        expect(clockMomentPassed(new Error("clock.pauseAt: Error: Cannot fast-forward to the past\n    at ClockController._innerFastForwardTo (<anonymous>:199:13)"))).toBe(true);
        // A page error thrown as the pause ran the page's frames: a script named pasta.js, a function named past().
        expect(
            clockMomentPassed(
                new Error("clock.pauseAt: TypeError: Cannot read properties of null (reading 'boom')\n    at past (http://127.0.0.1:8080/pasta.js:5:27)\n    at ClockController._callFirstTimer (<anonymous>:285:20)")
            )
        ).toBe(false);
        expect(clockMomentPassed(new Error("clock.pauseAt: Target page, context or browser has been closed"))).toBe(false);
    });

    it("reports it on the step, which reads the page as usual", async (): Promise<void> => {
        const page: ThrowingClockPage = new ThrowingClockPage();
        page.throws.set(1, "clock.runFor: ReferenceError: undefinedFunction is not defined");
        const pageMap: Map<string, unknown> = new Map();
        const context: BrowserToolSessionContext = { page, pageState: (): Map<string, unknown> => pageMap, sessionState: (): Map<string, unknown> => new Map() } as unknown as BrowserToolSessionContext;
        expect(await new StepGame().handle(context, { advanceMs: 50 })).toEqual({ clockMs: 0, pageError: "ReferenceError: undefinedFunction is not defined" });
        expect(await new StepGame().handle(context, { advanceMs: 50 })).toEqual({ clockMs: 0 });
        page.throws.set(3, "clock.runFor: again");
        expect(await new StepGame().handle(context, { advanceMs: 50, observe: false })).toEqual({ pageError: "again" });
    });
});

/**
 * A page whose clock's runs a native dialog cuts short: Playwright's call comes back once the page's clock has run `cutAt`
 * ms of the slice (the dialog; undefined: no dialog), and the page's own run goes on alone, done `finishIn` ms of real time
 * later (undefined: never). Its clock is read as Playwright's in the page is (`__pwClock`); it notes where the clock was
 * each time its CSS animations were moved on.
 */
class DialogClockPage {
    ticks: number = 32;
    cutAt: number | undefined = undefined;
    finishIn: number | undefined = 0;
    advancedAt: number[] = [];
    readonly clock: { runFor: (ms: number) => Promise<void> } = {
        runFor: async (ms: number): Promise<void> => {
            const target: number = this.ticks + ms;
            if (this.cutAt === undefined || this.cutAt >= ms) {
                this.ticks = target;
                return;
            }
            this.ticks += this.cutAt;
            if (this.finishIn !== undefined) {
                setTimeout((): void => {
                    this.ticks = target;
                }, this.finishIn);
            }
        },
    };

    isClosed(): boolean {
        return false;
    }

    async evaluate(expression: unknown): Promise<unknown> {
        const code: string = String(expression);
        if (code.includes("__pwClock")) {
            return this.ticks;
        }
        if (code.includes("animations.advance")) {
            this.advancedAt.push(this.ticks);
            return undefined;
        }
        return { clockMs: this.ticks };
    }
}

describe("game time a native dialog cuts short", (): void => {
    const pageOf = (p: DialogClockPage): Parameters<typeof runGameTime>[0] => p as unknown as Parameters<typeof runGameTime>[0];

    beforeEach((): void => {
        jest.useFakeTimers();
    });

    afterEach((): void => {
        jest.useRealTimers();
    });

    /** Whether `run` is done without the clock (a poll's timer) moving: it did not wait. */
    async function doneAtOnce(run: Promise<unknown>): Promise<boolean> {
        let done: boolean = false;
        void run.then((): void => {
            done = true;
        });
        for (let i: number = 0; i < 20; i++) {
            await Promise.resolve();
        }
        return done;
    }

    it("waits until the page's own run has caught up: all the time asked has run before the step reads the page", async (): Promise<void> => {
        const page: DialogClockPage = new DialogClockPage();
        // The dialog in the 10th frame: Playwright's call came back at 176 for 532, and the page ran the rest alone.
        page.cutAt = 144;
        page.finishIn = 50;
        const run: Promise<string | undefined> = runGameTime(pageOf(page), 500, false);
        expect(await doneAtOnce(run)).toBe(false);
        expect(page.ticks).toBe(176);
        await jest.advanceTimersByTimeAsync(60);
        expect(await run).toBeUndefined();
        expect(page.ticks).toBe(532);
        // No dialog: nothing to wait for.
        page.cutAt = undefined;
        expect(await doneAtOnce(runGameTime(pageOf(page), 500, false))).toBe(true);
        expect(page.ticks).toBe(1032);
    });

    it("moves the CSS animations on only once the page's clock has run the whole frame", async (): Promise<void> => {
        const page: DialogClockPage = new DialogClockPage();
        page.cutAt = 5;
        page.finishIn = 10;
        const run: Promise<string | undefined> = runGameTime(pageOf(page), 48, true);
        await jest.advanceTimersByTimeAsync(100);
        expect(await run).toBeUndefined();
        expect(page.advancedAt).toEqual([48, 64, 80]);
    });

    it("waits 2 s at most, then says how far the page's clock got", async (): Promise<void> => {
        const page: DialogClockPage = new DialogClockPage();
        page.cutAt = 144;
        page.finishIn = undefined;
        const run: Promise<string | undefined> = runGameTime(pageOf(page), 500, false);
        await jest.advanceTimersByTimeAsync(1_900);
        expect(await doneAtOnce(run)).toBe(false);
        await jest.advanceTimersByTimeAsync(200);
        expect(await run).toBe("game time ran short: the page's clock ran 144 of 500 ms");
    });
});

describe("game_step", (): void => {
    it("runs whole milliseconds only", (): void => {
        const schema: z.ZodTypeAny = z.object(new StepGame().inputSchema()).strict();
        expect(schema.safeParse({ advanceMs: 16, waitMs: 250 }).success).toBe(true);
        expect(schema.safeParse({ advanceMs: 16.5 }).success).toBe(false);
        expect(schema.safeParse({ waitMs: 0.5 }).success).toBe(false);
    });

    /** A session context on `page` that reads with `read` and `score`, as game_open left them. */
    function readingContext(page: object, read: string, score: string): BrowserToolSessionContext {
        const pageMap: Map<string, unknown> = new Map();
        const context: BrowserToolSessionContext = { page, pageState: (): Map<string, unknown> => pageMap, sessionState: (): Map<string, unknown> => new Map() } as unknown as BrowserToolSessionContext;
        Object.assign(pageState(context), { read, score });
        return context;
    }

    it("leaves a read or score that does not compile out of what it asks the page, reported as that part's error: the rest is read", async (): Promise<void> => {
        // A page that compiles what it is asked as the browser does: an expression that does not compile fails whole.
        const scope: vm.Context = vm.createContext({ Date: { now: (): number => 1234 }, game: { frame: [1, 2], score: 7 } });
        const page: object = { evaluate: async (expression: string): Promise<unknown> => vm.runInContext(expression, scope) };
        const statements: string = "const s = game.score; ({ over: false, score: s })";
        expect(await new StepGame().handle(readingContext(page, "game.frame", statements), {})).toEqual({
            raw: [1, 2],
            clockMs: 1234,
            scoreError: expect.stringMatching(/^SyntaxError: /),
        });
        expect(await new StepGame().handle(readingContext(page, statements, "({ over: false, score: game.score })"), {})).toEqual({
            score: { over: false, score: 7 },
            clockMs: 1234,
            readError: expect.stringMatching(/^SyntaxError: /),
        });
        // What this process's engine refuses a page's newer one may compile (a regular expression's modifiers): the page
        // is asked first, and what it compiles is read.
        const asked: string[] = [];
        const newer: object = {
            evaluate: async (expression: string): Promise<unknown> => {
                asked.push(expression);
                return asked.length === 1 ? true : { raw: [1, 2], score: { over: false, score: 7 }, clockMs: 1 };
            },
        };
        expect(await new StepGame().handle(readingContext(newer, "game.frame", statements), {})).toEqual({ raw: [1, 2], score: { over: false, score: 7 }, clockMs: 1 });
        expect(asked).toHaveLength(2);
        expect(asked[1]).toContain(statements);
    });

    describe("waiting for its inputs", (): void => {
        beforeEach((): void => {
            jest.useFakeTimers();
        });

        afterEach((): void => {
            jest.useRealTimers();
        });

        /** Whether the step is done without the clock (a poll's timer) moving: it did not wait. */
        async function doneAtOnce(step: Promise<unknown>): Promise<boolean> {
            let done: boolean = false;
            void step.then((): void => {
                done = true;
            });
            for (let i: number = 0; i < 20; i++) {
                await Promise.resolve();
            }
            return done;
        }

        it("waits for what it sent; an input the page never gets is waited for once, and another document counts from its start", async (): Promise<void> => {
            const page: InputPage = new InputPage();
            const pageMap: Map<string, unknown> = new Map();
            const context: BrowserToolSessionContext = { page, pageState: (): Map<string, unknown> => pageMap, sessionState: (): Map<string, unknown> => new Map() } as unknown as BrowserToolSessionContext;
            const state: GamePageState = pageState(context);
            state.inputsDoc = "doc-1";
            const step: StepGame = new StepGame();

            expect(await doneAtOnce(step.handle(context, { press: ["a"] }))).toBe(true);
            expect(state.inputsSent).toBe(2);

            // A key the page swallows: waited for up to its limit, then counted as the page counts.
            page.lose = 1;
            const swallowed: Promise<unknown> = step.handle(context, { press: ["b"] });
            expect(await doneAtOnce(swallowed)).toBe(false);
            await jest.advanceTimersByTimeAsync(6_000);
            await swallowed;
            expect(state.inputsSent).toBe(3);
            // The next step waits for its own inputs only.
            expect(await doneAtOnce(step.handle(context, { hold: ["c"] }))).toBe(true);
            expect(state.inputsSent).toBe(4);

            // The page loads another document: it counts from zero, and this step's inputs are what it waits for.
            page.doc = "doc-2";
            page.received = 0;
            expect(await doneAtOnce(step.handle(context, { press: ["d"] }))).toBe(true);
            expect(state).toMatchObject({ inputsDoc: "doc-2", inputsSent: 2 });
        });
    });

    it("measures the click target once per document: a game gone on from its menu page to its play page is clicked where its target is now", async (): Promise<void> => {
        type Box = { x: number; y: number; width: number; height: number };
        /** A page whose click target is at `boxes[doc]`; its input counter (page/inputs.ts) gets every click. */
        class ClickPage {
            doc: string = "menu";
            received: number = 0;
            measured: number = 0;
            clicks: number[][] = [];
            readonly boxes: Record<string, Box> = { menu: { x: 0, y: 0, width: 200, height: 100 }, play: { x: 400, y: 200, width: 200, height: 100 } };
            readonly mouse: Record<string, (x?: number, y?: number) => Promise<void>> = {
                click: async (x?: number, y?: number): Promise<void> => {
                    this.clicks.push([x ?? NaN, y ?? NaN]);
                    this.received += 2;
                },
            };
            readonly clock: { runFor: (ms: number) => Promise<void> } = { runFor: async (): Promise<void> => {} };

            locator(): { first: () => { boundingBox: () => Promise<Box> } } {
                return {
                    first: (): { boundingBox: () => Promise<Box> } => ({
                        boundingBox: async (): Promise<Box> => {
                            this.measured++;
                            return this.boxes[this.doc];
                        },
                    }),
                };
            }

            async evaluate(expression: unknown): Promise<unknown> {
                return String(expression).includes("inputsDoc") ? [this.doc, this.received] : { clockMs: 0 };
            }
        }
        const page: ClickPage = new ClickPage();
        const pageMap: Map<string, unknown> = new Map();
        const context: BrowserToolSessionContext = { page, pageState: (): Map<string, unknown> => pageMap, sessionState: (): Map<string, unknown> => new Map() } as unknown as BrowserToolSessionContext;
        Object.assign(pageState(context), { clickTarget: "#c", inputsDoc: "menu" });
        const step: StepGame = new StepGame();
        await step.handle(context, { click: true, advanceMs: 16 });
        await step.handle(context, { click: { x: 0.25, y: 0.5 }, advanceMs: 16 });
        expect(page.measured).toBe(1);
        // The menu sends the tab on to the play page: another document, its target elsewhere.
        page.doc = "play";
        page.received = 0;
        await step.handle(context, { click: true, advanceMs: 16 });
        await step.handle(context, { click: true, advanceMs: 16 });
        expect(page.measured).toBe(2);
        expect(page.clicks).toEqual([
            [100, 50],
            [50, 50],
            [500, 250],
            [500, 250],
        ]);
    });
});

describe("the canvas2d recorder", (): void => {
    it("records where a draw landed, mirrored or turned: the box around its corners", async (): Promise<void> => {
        const context: vm.Context = vm.createContext({ queueMicrotask });
        vm.runInContext(
            `var window = this;
             function CanvasRenderingContext2D() {}
             CanvasRenderingContext2D.prototype.drawImage = function () {};
             CanvasRenderingContext2D.prototype.fillRect = function () {};
             CanvasRenderingContext2D.prototype.fillText = function () {};
             function ctx(t) { var c = new CanvasRenderingContext2D(); c.canvas = { isConnected: true, id: "game" }; c.fillStyle = "#000"; c.getTransform = function () { return t; }; return c; }`,
            context
        );
        vm.runInContext(`(${installCanvas2dRecorder.toString()})()`, context);
        vm.runInContext(
            `var sheet = { width: 40, height: 20 };
             // Mirrored about x = 100 (translate(200, 0), scale(-1, 1)): drawn at 100..120, it lands on 80..100.
             ctx({ a: -1, b: 0, c: 0, d: 1, e: 200, f: 0 }).drawImage(sheet, 0, 0, 20, 20, 100, 50, 20, 20);
             // Scaled by 2.
             ctx({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }).fillRect(10, 5, 30, 10);
             // Turned a quarter (rotate(90deg) after translate(100, 0)): 30 wide and 10 high stands 10 wide and 30 high.
             ctx({ a: 0, b: 1, c: -1, d: 0, e: 100, f: 0 }).fillRect(0, 0, 30, 10);
             ctx({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 }).fillText("12", 540, 12);`,
            context
        );
        await new Promise((resolve: (v: unknown) => void): unknown => setImmediate(resolve));
        expect(JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.canvas2d.last)", context))).toEqual([
            { k: "img", s: "i1:0,0,20,20", x: 80, y: 50, w: 20, h: 20, cv: "game" },
            { k: "rect", c: "#000", x: 20, y: 10, w: 60, h: 20, cv: "game" },
            { k: "rect", c: "#000", x: 90, y: 0, w: 10, h: 30, cv: "game" },
            { k: "text", t: "12", x: 545, y: 17, w: 0, h: 0, cv: "game" },
        ]);
    });

    it("gives an id only to a source drawn onto the picture, the same one while the source lives, and lets the source go", async (): Promise<void> => {
        const context: vm.Context = vm.createContext({ queueMicrotask });
        vm.runInContext(
            `var window = this;
             function CanvasRenderingContext2D() {}
             CanvasRenderingContext2D.prototype.drawImage = function () {};
             CanvasRenderingContext2D.prototype.fillRect = function () {};
             CanvasRenderingContext2D.prototype.fillText = function () {};
             function ctx(connected) { var c = new CanvasRenderingContext2D(); c.canvas = { isConnected: connected, id: connected ? "game" : "" }; c.getTransform = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }; return c; }
             var document = { createElement: function () { return { getContext: function () { return new CanvasRenderingContext2D(); }, toDataURL: function () { return "data:image/png;base64,AAAA"; } }; } };
             var screen = ctx(true), scratch = ctx(false), sheet = { width: 40, height: 20 };
             // A frame composed offscreen from a fresh buffer each time (the sheet drawn into it), then put on the picture.
             function frame() { var buffer = { width: 8, height: 8 }; scratch.drawImage(sheet, 0, 0); screen.drawImage(buffer, 0, 0); screen.drawImage(sheet, 0, 0, 20, 20, 5, 5, 20, 20); }`,
            context
        );
        vm.runInContext(`(${installCanvas2dRecorder.toString()})()`, context);
        const tick = (): Promise<unknown> => new Promise((resolve: (v: unknown) => void): unknown => setImmediate(resolve));
        const keys = (): string[] => JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.canvas2d.last.map(function (d) { return d.s; }))", context));
        vm.runInContext("frame()", context);
        await tick();
        expect(keys()).toEqual(["i1:0,0,8,8", "i2:0,0,20,20"]);
        vm.runInContext("frame()", context);
        await tick();
        // The sheet keeps its id; the new buffer gets one of its own; the scratch canvas's draws none.
        expect(keys()).toEqual(["i3:0,0,8,8", "i2:0,0,20,20"]);
        expect(vm.runInContext("window.__ibgamer.canvas2d.crop('i2:0,0,20,20')", context)).toMatch(/^data:image\/png/);
        // Held weakly: once nothing of the page's holds a buffer, it is collected, its crop is gone and so is its entry.
        const gc: (() => void) | undefined = ((): (() => void) | undefined => {
            try {
                v8.setFlagsFromString("--expose-gc");
                return vm.runInNewContext("gc") as () => void;
            } catch {
                return undefined;
            }
        })();
        if (gc) {
            await tick();
            gc();
            expect(vm.runInContext("window.__ibgamer.canvas2d.crop('i1:0,0,8,8')", context)).toBeUndefined();
            for (let i: number = 0; i < 10 && vm.runInContext("window.__ibgamer.canvas2d.sources.has('i1')", context); i++) {
                await tick();
            }
            expect(vm.runInContext("window.__ibgamer.canvas2d.sources.has('i1')", context)).toBe(false);
            expect(vm.runInContext("window.__ibgamer.canvas2d.crop('i2:0,0,20,20')", context)).toMatch(/^data:image\/png/);
        }
    });
});

describe("the input counter", (): void => {
    /** A document with the counter installed; `fire` dispatches an event as the browser (trusted) or the page does. */
    function doc(): { context: vm.Context; fire: (type: string, trusted: boolean) => void } {
        const listeners: Record<string, Array<(e: { isTrusted: boolean }) => void>> = {};
        const context: vm.Context = vm.createContext({
            crypto: webcrypto,
            addEventListener: (type: string, fn: (e: { isTrusted: boolean }) => void): void => {
                (listeners[type] ??= []).push(fn);
            },
        });
        vm.runInContext("var window = this;", context);
        vm.runInContext(`(${installInputCounter.toString()})()`, context);
        const fire: (type: string, trusted: boolean) => void = (type: string, trusted: boolean): void => {
            for (const fn of listeners[type] ?? []) {
                fn({ isTrusted: trusted });
            }
        };
        return { context, fire };
    }

    it("counts the browser's key and pointer events (not mouse events, nor what the page dispatches) under an id of the document's own", (): void => {
        const one: { context: vm.Context; fire: (type: string, trusted: boolean) => void } = doc();
        for (const type of ["keydown", "keyup", "pointerdown", "pointerup", "mousedown", "mouseup"]) {
            one.fire(type, true);
        }
        one.fire("keydown", false);
        one.fire("pointerdown", false);
        expect(vm.runInContext("window.__ibgamer.inputs", one.context)).toBe(4);
        const id: unknown = vm.runInContext("window.__ibgamer.inputsDoc", one.context);
        expect(id).toMatch(/^\d+-\d+$/);
        expect(vm.runInContext("window.__ibgamer.inputsDoc", doc().context)).not.toBe(id);
    });
});

describe("the decode counter", (): void => {
    /**
     * A page with decoding APIs shaped as the browser's (length, name; a promise, and decodeAudioData's callbacks) whose
     * jobs end when `finish(ok)` says so, and the counter installed.
     */
    function doc(): vm.Context {
        const context: vm.Context = vm.createContext({ crypto: webcrypto });
        vm.runInContext(
            `var window = this; var jobs = []; var log = [];
             function finish(ok) { jobs.shift()(ok); }
             function BaseAudioContext() {}
             BaseAudioContext.prototype.decodeAudioData = function decodeAudioData(data) {
                 var done = arguments[1], failed = arguments[2];
                 if (data === "throws") { throw new TypeError("not audio"); }
                 return new Promise(function (resolve, reject) {
                     jobs.push(function (ok) {
                         if (ok) { if (done) { done.call(undefined, "sound:" + data); } resolve("sound:" + data); }
                         else { if (failed) { failed.call(undefined, "bad"); } reject("bad"); }
                     });
                 });
             };
             function AudioContext() {}
             AudioContext.prototype = Object.create(BaseAudioContext.prototype);
             function createImageBitmap(image) {
                 if (image === "stand-in") { return undefined; }
                 return new Promise(function (resolve) { jobs.push(function () { resolve("bitmap:" + image); }); });
             }
             function HTMLImageElement() {}
             HTMLImageElement.prototype.decode = function decode() { return new Promise(function (resolve) { jobs.push(resolve); }); };`,
            context
        );
        vm.runInContext(`(${installDecodeCounter.toString()})()`, context);
        return context;
    }
    const open = (context: vm.Context): number => vm.runInContext("Object.keys(window.__ibgamer.decodes.open).length", context);
    const moves = (context: vm.Context): number => vm.runInContext("window.__ibgamer.decodes.moves", context);
    /** Lets the page's promise reactions run. */
    const settle = (): Promise<void> =>
        new Promise((resolve: () => void): void => {
            setImmediate(resolve);
        });

    it("lists each job from its call until its callback runs or its promise settles, once", async (): Promise<void> => {
        const page: vm.Context = doc();
        // As the browser's: a library that picks its way by decodeAudioData.length takes the same one.
        expect(vm.runInContext("[BaseAudioContext.prototype.decodeAudioData.length, BaseAudioContext.prototype.decodeAudioData.name, createImageBitmap.name]", page)).toEqual([
            1,
            "decodeAudioData",
            "createImageBitmap",
        ]);
        // Callbacks, as a WebAudio loader passes them: the page's own called with what the browser gave, and no `this`.
        vm.runInContext(`new AudioContext().decodeAudioData("a", function (b) { "use strict"; log.push([b, this === undefined]); })`, page);
        vm.runInContext(`window.p = new AudioContext().decodeAudioData("b"); window.p.then(function (b) { log.push([b]); });`, page);
        vm.runInContext(`createImageBitmap("c").then(function (b) { log.push([b]); }); new HTMLImageElement().decode();`, page);
        expect(open(page)).toBe(4);
        vm.runInContext("finish(true)", page);
        // The callback ends the job at once; its promise settling later does not end it twice.
        expect(open(page)).toBe(3);
        await settle();
        expect(open(page)).toBe(3);
        vm.runInContext("finish(true); finish(true); finish(true);", page);
        await settle();
        expect(open(page)).toBe(0);
        expect(moves(page)).toBe(8);
        expect(vm.runInContext("JSON.stringify(log)", page)).toBe(JSON.stringify([["sound:a", true], ["sound:b"], ["bitmap:c"]]));
        // The page gets the browser's own promise back.
        expect(vm.runInContext("window.p instanceof Promise", page)).toBe(true);
    });

    it("keeps no job open for a call that throws, fails, returns no promise, or a page that replaces then", async (): Promise<void> => {
        const page: vm.Context = doc();
        expect((): unknown => vm.runInContext(`new AudioContext().decodeAudioData("throws")`, page)).toThrow("not audio");
        // A stand-in the page put there before the counter, that returns no promise: nothing to wait on.
        expect(vm.runInContext(`createImageBitmap("stand-in")`, page)).toBeUndefined();
        expect(open(page)).toBe(0);
        // A failed decode ends its job as a finished one does.
        vm.runInContext(`new AudioContext().decodeAudioData("d", undefined, function () {}).catch(function () {})`, page);
        vm.runInContext("finish(false)", page);
        await settle();
        expect(open(page)).toBe(0);
        // A page that replaces Promise.prototype.then (one that never calls back) does not keep a job open.
        vm.runInContext(`Promise.prototype.then = function () { return this; }; createImageBitmap("e")`, page);
        expect(open(page)).toBe(1);
        vm.runInContext("finish(true)", page);
        await settle();
        expect(open(page)).toBe(0);
        // An API the page replaces with its own is its own: calls to it are not listed.
        vm.runInContext(`window.createImageBitmap = function () { return new Promise(function () {}); }; createImageBitmap("f")`, page);
        expect(open(page)).toBe(0);
    });

    it("lists a WebAssembly compile until its promise settles: the browser's own call, promise and module", async (): Promise<void> => {
        const page: vm.Context = doc();
        // The engine's own WebAssembly: an empty module (its header), and bytes that are none.
        vm.runInContext(
            `window.compiling = WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
             window.failing = WebAssembly.instantiate(new Uint8Array([1, 2, 3])).catch(function (e) { return e.name; });`,
            page
        );
        expect(open(page)).toBe(2);
        expect(vm.runInContext("[WebAssembly.compile.length, WebAssembly.compile.name, WebAssembly.instantiate.name]", page)).toEqual([1, "compile", "instantiate"]);
        const compiled: unknown = await vm.runInContext("window.compiling", page);
        expect(await vm.runInContext("window.failing", page)).toBe("CompileError");
        await settle();
        expect(open(page)).toBe(0);
        expect(vm.runInContext("window.compiling instanceof Promise", page)).toBe(true);
        expect(Object.prototype.toString.call(compiled)).toBe("[object WebAssembly.Module]");
    });

    /** A page with IndexedDB shaped as the browser's: its requests and transactions are event targets the test fires at. */
    function database(): vm.Context {
        const context: vm.Context = vm.createContext({ crypto: webcrypto, EventTarget, Event });
        vm.runInContext(
            `var window = this; var seen = [];
             class Target extends EventTarget {}
             function IDBFactory() {}
             IDBFactory.prototype.open = function open(name) { return new Target(); };
             IDBFactory.prototype.deleteDatabase = function deleteDatabase(name) { return new Target(); };
             function IDBDatabase() {}
             IDBDatabase.prototype.transaction = function transaction(stores) { return new Target(); };
             function IDBObjectStore() {}
             IDBObjectStore.prototype.put = function put(value) {
                 if (value === "inactive") { throw new Error("TransactionInactiveError"); }
                 return value === "stand-in" ? undefined : new Target();
             };
             function IDBIndex() {}
             IDBIndex.prototype.get = function get(key) { return new Target(); };
             var indexedDB = new IDBFactory();`,
            context
        );
        vm.runInContext(`(${installDecodeCounter.toString()})()`, context);
        return context;
    }

    it("lists an IndexedDB request until it succeeds or fails, a transaction until it completes or aborts, each ended before the page's own listeners run", (): void => {
        const page: vm.Context = database();
        vm.runInContext(
            `window.opening = indexedDB.open("save");
             window.opening.addEventListener("success", function () { seen.push(Object.keys(window.__ibgamer.decodes.open).length); });
             window.put = new IDBObjectStore().put("x");
             window.get = new IDBIndex().get("k");
             window.tx = new IDBDatabase().transaction("kv");`,
            page
        );
        expect(open(page)).toBe(4);
        vm.runInContext(`window.opening.dispatchEvent(new Event("success"))`, page);
        // Ended before the page's own listener ran (which may start the next): it saw the three others open.
        expect(vm.runInContext("seen", page)).toEqual([3]);
        vm.runInContext(`window.put.dispatchEvent(new Event("error")); window.get.dispatchEvent(new Event("success"));`, page);
        expect(open(page)).toBe(1);
        // An error a request raises reaches its transaction too, and the page may carry on after it: still open.
        vm.runInContext(`window.tx.dispatchEvent(new Event("error"))`, page);
        expect(open(page)).toBe(1);
        vm.runInContext(`window.tx.dispatchEvent(new Event("complete"))`, page);
        expect(open(page)).toBe(0);
        // Once: a cursor's request succeeds again, a transaction completes once — the job is gone already.
        vm.runInContext(`window.get.dispatchEvent(new Event("success")); window.tx.dispatchEvent(new Event("abort"));`, page);
        expect(moves(page)).toBe(8);
        // As the browser's: the same length and name.
        expect(vm.runInContext("[IDBFactory.prototype.open.length, IDBFactory.prototype.open.name, IDBDatabase.prototype.transaction.name]", page)).toEqual([
            1,
            "open",
            "transaction",
        ]);
    });

    it("keeps no IndexedDB job open for a call that throws or returns nothing to listen on", (): void => {
        const page: vm.Context = database();
        expect((): unknown => vm.runInContext(`new IDBObjectStore().put("inactive")`, page)).toThrow("TransactionInactiveError");
        expect(vm.runInContext(`new IDBObjectStore().put("stand-in")`, page)).toBeUndefined();
        expect(open(page)).toBe(0);
        expect(moves(page)).toBe(4);
    });
});

describe("the session storage clearing", (): void => {
    /** One origin's session storage in the tab: page/storage.ts runs in each of its documents as it starts, with its game's token. */
    class TabStorage {
        readonly items: Map<string, string> = new Map();
        private readonly storage: object = {
            getItem: (key: string): string | null => this.items.get(key) ?? null,
            setItem: (key: string, value: string): void => {
                this.items.set(key, String(value));
            },
            removeItem: (key: string): void => {
                this.items.delete(key);
            },
            clear: (): void => {
                this.items.clear();
            },
        };

        /** A document of this storage starts, in the game opened with `token`. */
        start(token: string): void {
            vm.runInContext(`(${clearSessionStorage.toString()})(${JSON.stringify(token)})`, vm.createContext({ sessionStorage: this.storage }));
        }
    }

    it("empties each storage once in a game, at the first document that uses it, whenever that starts; what the game stores since is kept", (): void => {
        const game: TabStorage = new TabStorage();
        const frame: TabStorage = new TabStorage();
        // What an earlier game left in the tab: in the game's origin's storage, and in a frame's of another origin.
        game.items.set("best", "from the game before");
        frame.items.set("seen", "from the game before");
        game.start("101");
        expect([...game.items]).toEqual([["__ibgamer_session", "101"]]);
        game.items.set("state", "stored as it loads");
        // Later documents of that storage in this game — a frame of its origin, the page a launcher sends the tab on to, a
        // frame of its origin under one of another, the page a bounce sends back, the game loading itself — find it as
        // the game left it.
        game.start("101");
        game.start("101");
        expect(game.items.get("state")).toBe("stored as it loads");
        // A frame of another origin that starts late (in the boot, a lazy one in play) finds its storage emptied.
        frame.start("101");
        expect([...frame.items]).toEqual([["__ibgamer_session", "101"]]);
        frame.items.set("seen", "this game");
        frame.start("101");
        expect(frame.items.get("seen")).toBe("this game");
        // The next game: each storage emptied again at its first document.
        game.start("202");
        frame.start("202");
        expect([...game.items]).toEqual([["__ibgamer_session", "202"]]);
        expect([...frame.items]).toEqual([["__ibgamer_session", "202"]]);
    });

    it("empties again a storage the game emptied itself (the marker went with it), and leaves a document with no storage to reach alone", (): void => {
        const game: TabStorage = new TabStorage();
        game.start("101");
        game.items.clear();
        game.items.set("after", "its own");
        game.start("101");
        expect([...game.items]).toEqual([["__ibgamer_session", "101"]]);
        // An opaque origin (a data: page, a sandboxed frame): its session storage cannot be reached.
        expect((): void => vm.runInContext(`(${clearSessionStorage.toString()})("101")`, vm.createContext({}))).not.toThrow();
    });
});

describe("the probe", (): void => {
    it("names the engines a page has, not the window.Phaser / window.PIXI the adapters watch for", (): void => {
        const context: vm.Context = vm.createContext({});
        vm.runInContext(
            `var window = this; var innerWidth = 800; var innerHeight = 600;
             function HTMLCanvasElement() {}
             HTMLCanvasElement.prototype.getContext = function () { return null; };
             function CanvasRenderingContext2D() {}
             ["fillRect", "strokeRect", "drawImage", "fillText", "fill", "stroke", "putImageData"].forEach(function (m) { CanvasRenderingContext2D.prototype[m] = function () {}; });
             var document = { querySelectorAll: function () { return []; }, scripts: [], title: "a game", body: null };
             var location = { href: "https://example.com/game/" };
             var performance = { getEntriesByType: function () { return []; } };`,
            context
        );
        // A seeded probe: the Phaser adapter comes with the seed.
        vm.runInContext(`(${installProbe.toString()})()`, context);
        vm.runInContext(`(${installPhaserAdapter.toString()})()`, context);
        vm.runInContext(`(${installPixiAdapter.toString()})()`, context);
        const read: () => { engines: string[]; suggested?: string } = (): { engines: string[]; suggested?: string } =>
            JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.probe.read())", context));
        expect(read().engines).toEqual([]);
        vm.runInContext(`window.PIXI = { VERSION: "7.4.2" };`, context);
        expect(read()).toMatchObject({ engines: ["PIXI"], suggested: "pixi" });
        // A module or bundled Three.js sets no THREE global, only its revision: the Three.js adapter's own hook is no engine.
        vm.runInContext(`(${installThreeAdapter.toString()})()`, vm.createContext({ window: context, EventTarget }));
        expect(read().engines).toEqual(["PIXI"]);
        vm.runInContext(`window.__THREE__ = "168";`, context);
        expect(read().engines).toEqual(["PIXI", "__THREE__"]);
    });

    it("names each canvas by a selector a click can aim at (its id, else its place under one), and where the body is", (): void => {
        const context: vm.Context = vm.createContext({});
        vm.runInContext(
            `var window = this; var innerWidth = 800; var innerHeight = 600;
             function HTMLCanvasElement() {}
             HTMLCanvasElement.prototype.getContext = function () { return null; };
             function CanvasRenderingContext2D() {}
             ["fillRect", "strokeRect", "drawImage", "fillText", "fill", "stroke", "putImageData"].forEach(function (m) { CanvasRenderingContext2D.prototype[m] = function () {}; });
             var CSS = { escape: function (s) { return s; } };
             function el(localName, id, box, parent) {
                 var e = { localName: localName, id: id, parentElement: parent || null, previousElementSibling: null, children: [], width: box[2], height: box[3],
                     getBoundingClientRect: function () { return { x: box[0], y: box[1], width: box[2], height: box[3] }; } };
                 if (parent) { e.previousElementSibling = parent.children[parent.children.length - 1] || null; parent.children.push(e); }
                 return e;
             }
             var html = el("html", "", [0, 0, 800, 600]);
             var body = el("body", "", [8, 8, 784, 400], html);
             body.innerText = "";
             var stage = el("div", "stage", [8, 8, 640, 360], body);
             var fps = el("canvas", "", [8, 8, 80, 48], stage);
             var game = el("canvas", "", [8, 8, 640, 360], stage);
             var panel = el("div", "", [0, 0, 0, 0], body);
             var chart = el("canvas", "chart", [700, 8, 100, 50], panel);
             var loose = el("canvas", "", [0, 0, 10, 10], panel);
             var document = {
                 documentElement: html, body: body, title: "a game", scripts: [],
                 querySelectorAll: function (q) { return q === "canvas" ? [fps, game, chart, loose] : [stage, chart].filter(function (e) { return "#" + e.id === q; }); },
             };
             var location = { href: "https://example.com/game/" };
             var performance = { getEntriesByType: function () { return []; } };`,
            context
        );
        vm.runInContext(`(${installProbe.toString()})()`, context);
        const probe: { canvases: Array<{ selector: string }>; body: unknown } = JSON.parse(vm.runInContext("JSON.stringify(window.__ibgamer.probe.read())", context));
        expect(probe.canvases.map((c: { selector: string }): string => c.selector)).toEqual([
            "#stage > canvas:nth-of-type(1)",
            "#stage > canvas:nth-of-type(2)",
            "#chart",
            "body > div:nth-of-type(2) > canvas:nth-of-type(2)",
        ]);
        expect(probe.body).toEqual({ x: 8, y: 8, width: 784, height: 400 });
    });
});

describe("DevtoolsClient", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    function answer(status: number, body: unknown): void {
        jest.spyOn(globalThis, "fetch").mockImplementation(
            async (): Promise<Response> => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
        );
    }

    it("says how to start the daemon with the game tools when it does not know one (a 404 'Tool Not Found')", async (): Promise<void> => {
        answer(404, { error: { code: 404, message: "Tool Not Found" } });
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: "http://127.0.0.1:1" });
        // Not loaded, or left out by a domain list: the hint names both.
        await expect(client.step({})).rejects.toThrow(
            /^game_step: Tool Not Found — the DevTools daemon at http:\/\/127\.0\.0\.1:1 does not serve the game tools; start it with TOOL_PLUGINS=.*game-tools\.mjs, and AVAILABLE_TOOL_DOMAINS unset \(or naming game and content\)$/
        );
        // Another tool the daemon does not know: told as it is.
        await expect(client.call("content_nothing", {})).rejects.toThrow(/^content_nothing: Tool Not Found$/);
    });

    it("tells a tool's own failure with its code, and a refused call by the daemon's message", async (): Promise<void> => {
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: "http://127.0.0.1:1" });
        answer(500, { toolError: { code: "E_GAME", message: "nothing to click" } });
        const failed: unknown = await client.step({ click: true }).catch((err: unknown): unknown => err);
        expect(failed).toBeInstanceOf(DevtoolsError);
        expect(failed).toMatchObject({ message: "game_step: nothing to click", code: "E_GAME" });
        jest.restoreAllMocks();
        answer(400, { error: { code: 400, message: "Invalid Tool Request: url: must be an http: or https: URL" } });
        await expect(client.open({ url: "file:///x", adapters: [] })).rejects.toThrow(/^game_open: Invalid Tool Request: url: must be an http: or https: URL$/);
    });
});
