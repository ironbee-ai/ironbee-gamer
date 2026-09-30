/**
 * The game tools' wire shapes: what this process sends the DevTools plugin
 * (src/devtools-plugin/) and what comes back. One module for both sides — the
 * plugin bundle inlines it, so the two never drift.
 */

/** A generic perception adapter: page code installed before the game runs, knowing nothing of any game. */
export enum Adapter {
    /** Records what each frame draws on the page's 2D canvases (sprites, rects, text). */
    CANVAS2D = "canvas2d",
    /** Dumps a Phaser (v2 / CE / v3) game's scene objects and tilemaps. */
    PHASER = "phaser",
    /** Dumps a PixiJS (v4 to v8) game's display tree, from the root each frame renders. */
    PIXI = "pixi",
    /** Dumps a Cocos (Creator 2.x / 3.x, cocos2d-js) game's running scene. */
    COCOS = "cocos",
    /** The largest canvas as a small colour grid: any game a canvas shows, WebGL included. */
    PIXELS = "pixels",
    /** Notes which rendering tech and engine a page uses (adding a game). */
    PROBE = "probe",
}

/** The colour grid pixel perception reads: `width` cells across, `height` (default: the canvas's aspect) down. */
export interface PixelGrid {
    width: number;
    height?: number;
}

export const DEFAULT_PIXEL_GRID_WIDTH: number = 64;

export enum GameTool {
    OPEN = "game_open",
    STEP = "game_step",
    PROBE = "game_probe",
    SPRITE_CROPS = "game_sprite-crops",
}

/** The page-side namespace every adapter lives under. */
export const PAGE_NAMESPACE: string = "__ibgamer";

/** The page expression each built-in adapter's raw input is read with. */
export function adapterReadExpression(adapter: Adapter, options: { maps?: boolean; grid?: PixelGrid } = {}): string {
    switch (adapter) {
        case Adapter.CANVAS2D:
            return `window.${PAGE_NAMESPACE}.canvas2d.last`;
        case Adapter.PHASER:
            return `window.${PAGE_NAMESPACE}.phaser.dump(${options.maps === true})`;
        case Adapter.PIXI:
            return `window.${PAGE_NAMESPACE}.pixi.dump()`;
        case Adapter.COCOS:
            return `window.${PAGE_NAMESPACE}.cocos.dump()`;
        case Adapter.PIXELS: {
            const grid: PixelGrid = options.grid ?? { width: DEFAULT_PIXEL_GRID_WIDTH };
            return `window.${PAGE_NAMESPACE}.pixels.grab(${Math.round(grid.width)}${grid.height !== undefined ? `, ${Math.round(grid.height)}` : ""})`;
        }
        case Adapter.PROBE:
            return `window.${PAGE_NAMESPACE}.probe.read()`;
    }
}

export interface Viewport {
    width: number;
    height: number;
}

export interface OpenRequest {
    /** The game page: http: or https: only. */
    url: string;
    /** Generic adapters installed before the page's own scripts. */
    adapters: Adapter[];
    /** A library game's own page scripts, installed before the page's. */
    initScripts?: string[];
    /** Seeds the page's Math.random and its crypto random values: the same seed plays the same course. */
    seed?: number;
    viewport?: Viewport;
    /** Game time the page boots in, frame by frame, before the first step (ms); real time when the clock is not frozen. */
    bootMs?: number;
    /** False: the page keeps its own clock (a probe). Default true: frozen after boot, run only by steps. */
    freezeClock?: boolean;
    /** Page expression that reads the raw input. */
    read?: string;
    /** Page expression read for measuring only: `{ over, score, … }`. Never shown to the decision engine. */
    score?: string;
    /** CSS selector a click action clicks the centre of (default: the first canvas). */
    clickTarget?: string;
    /** The page's CSS animations and transitions run on game time too (a game that moves things with CSS). */
    animationClock?: boolean;
    /** CSS added to the page once it has loaded: what is not the game hidden, so the live view shows the game. */
    style?: string;
}

export interface OpenResult {
    url: string;
    title: string;
    status?: number;
    /**
     * The first error the page's own code threw in a timer or frame as it booted: reported, not thrown (the boot ran on, as the
     * page's own clock would). Or that the page's clock fell short of the game time asked ("game time ran short: …": a native
     * dialog cut the clock's run, and the page's own did not catch up in 2 s).
     */
    pageError?: string;
}

/** A point on the click target, as fractions of its width and height (0,0 = top left). */
export interface ClickPoint {
    x: number;
    y: number;
}

export interface StepRequest {
    /** Keys held from now on; held keys not listed are released. Omitted: unchanged. */
    hold?: string[];
    /** Keys pressed and released now. */
    press?: string[];
    /**
     * A page expression naming the keys held from now on, as `hold` does (with `hold` too, both): a key
     * name, a list of them, or nothing (null) to hold none — for a menu or a map whose way on depends on
     * what the page shows. Held, not pressed: a game that looks at its keys on its own tick sees them.
     */
    holdFrom?: string;
    /** Clicks the click target once: its centre, or a point given as fractions of its width and height. */
    click?: boolean | ClickPoint;
    /** The pointer (mouse button) held down from now on, at the centre or a point; false lets it go. Omitted: unchanged. */
    pointer?: boolean | ClickPoint;
    /** Game time to run after the input (whole ms). */
    advanceMs?: number;
    /** Real time to wait after the input, before `advanceMs`, the clock still frozen (whole ms): what runs in real time (a CSS animation) ends at the same game time. */
    waitMs?: number;
    /** Reads the raw input and the score after (default true). */
    observe?: boolean;
}

/** What the game's own state says, for measuring: `over` and `score`, and whatever else it reports. */
export interface ScoreReading {
    over?: boolean;
    score?: number;
    /** The game waits for the player between rounds (the game's `resume` takes it on). */
    waiting?: boolean;
    [key: string]: unknown;
}

export interface StepResult {
    raw?: unknown;
    score?: ScoreReading;
    /** The page's clock after the step (ms since its epoch; frozen time runs only by steps). */
    clockMs?: number;
    readError?: string;
    scoreError?: string;
    /**
     * The first error the page's own code threw in a timer or frame while the step's game time ran: reported, not thrown (the
     * clock ran on, as the page's own would). Or that the page's clock fell short of the time asked ("game time ran short: …":
     * a native dialog cut the clock's run, and the page's own did not catch up in 2 s).
     */
    pageError?: string;
}

export interface ProbeResult {
    title: string;
    url: string;
    /** The page's viewport (CSS pixels). */
    viewport?: { width: number; height: number };
    /** Canvases on the page: size, the context kind asked for, where each sits on the page, and a selector that finds it again. */
    canvases: Array<{ width: number; height: number; context?: string; box?: { x: number; y: number; width: number; height: number }; selector?: string }>;
    /** Where the page's body sits (CSS pixels): what a click is measured on when there is no canvas. */
    body?: { x: number; y: number; width: number; height: number };
    /** 2D drawing calls counted since the page loaded, by method. */
    calls: Record<string, number>;
    /** Engines found as page globals. */
    engines: string[];
    /** The adapter that fits, when one does. */
    suggested?: Adapter;
    bodyText: string;
    /** The page's scripts (their URLs), its inline scripts (text), and the globals its scripts added (`name: kind`). */
    scripts?: string[];
    inlineScripts?: string[];
    globals?: string[];
}

export interface SpriteCropsResult {
    /** A PNG data URL per sprite key, for the keys the recorder knows. */
    crops: Record<string, string>;
}
