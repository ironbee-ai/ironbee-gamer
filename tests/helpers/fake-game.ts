/**
 * A tiny runner game behind the GameBrowser interface, so the player, the
 * trainer and the UI can be tested without a browser: an obstacle comes at the
 * player every so often; holding Space on the ground jumps for 400 ms; a
 * collision on the ground ends the game. The score is the game time in tenths
 * of a second. What it draws is canvas2d-shaped raw input.
 */

import { GameBrowser, RecordingStopped } from "../../src/devtools/client";
import { OpenRequest, OpenResult, ProbeResult, SpriteCropsResult, StepRequest, StepResult } from "../../src/devtools/protocol";
import { GameDefinition, Perception, Profile, DecideOn } from "../../src/game/types";

export const OBSTACLE_START_X: number = 300;
export const OBSTACLE_SPEED: number = 0.3; // px per ms
export const JUMP_MS: number = 400;

export class FakeGame implements GameBrowser {
    readonly opened: OpenRequest[] = [];
    readonly steps: StepRequest[] = [];
    held: Set<string> = new Set();
    t: number = 0;
    obstacleX: number = OBSTACLE_START_X;
    airUntil: number = -1;
    over: boolean = false;
    recording: boolean = false;
    closed: boolean = false;
    /** A sprite first drawn after this much game time (novelty). */
    lateSpriteAtMs: number = Infinity;
    /** When set, the raw input carries this field too (to test the guard). */
    extraRaw: Record<string, unknown> = {};

    async open(request: OpenRequest): Promise<OpenResult> {
        this.opened.push(request);
        this.held.clear();
        this.t = 0;
        this.obstacleX = OBSTACLE_START_X;
        this.airUntil = -1;
        this.over = false;
        return { url: request.url, title: "fake" };
    }

    private advance(ms: number): void {
        for (let i: number = 0; i < ms && !this.over; i++) {
            this.t++;
            this.obstacleX -= OBSTACLE_SPEED;
            const air: boolean = this.t < this.airUntil;
            if (this.obstacleX <= 0 && this.obstacleX > -10 && !air) {
                this.over = true;
            }
            if (this.obstacleX < -20) {
                this.obstacleX = OBSTACLE_START_X;
            }
        }
    }

    raw(): unknown {
        const air: boolean = this.t < this.airUntil;
        const frame: Array<Record<string, unknown>> = [
            { k: "img", s: "i1:0,0,20,20", x: Math.round(this.obstacleX), y: 100, w: 20, h: 20 },
            { k: "img", s: "i1:40,0,20,20", x: 0, y: air ? 60 : 100, w: 20, h: 20 },
            { k: "text", t: String(Math.floor(this.t / 100)), x: 500, y: 10, w: 0, h: 0 },
        ];
        if (this.t > this.lateSpriteAtMs) {
            frame.push({ k: "img", s: "i1:90,0,9,9", x: 200, y: 20, w: 9, h: 9 });
        }
        return frame;
    }

    async step(request: StepRequest): Promise<StepResult> {
        this.steps.push(request);
        if (request.hold) {
            const wanted: Set<string> = new Set(request.hold);
            if (wanted.has("Space") && !this.held.has("Space") && this.t >= this.airUntil) {
                this.airUntil = this.t + JUMP_MS;
            }
            this.held = wanted;
        }
        for (const key of request.press ?? []) {
            if (key === "Space" && this.t >= this.airUntil) {
                this.airUntil = this.t + JUMP_MS;
            }
        }
        this.advance(request.advanceMs ?? 0);
        if (request.observe === false) {
            return {};
        }
        return { raw: this.raw(), score: { over: this.over, score: Math.floor(this.t / 100) }, clockMs: this.t };
    }

    async probe(): Promise<ProbeResult> {
        return { title: "fake", url: "https://fake.test/", canvases: [{ width: 600, height: 150, context: "2d" }], calls: { drawImage: 10 }, engines: [], suggested: "canvas2d" as ProbeResult["suggested"], bodyText: "" };
    }

    async spriteCrops(keys: string[]): Promise<SpriteCropsResult> {
        const png: string = "data:image/png;base64,iVBORw0KGgo=";
        return { crops: Object.fromEntries(keys.map((k: string): [string, string] => [k, png])) };
    }

    async screenshot(): Promise<string | undefined> {
        return undefined;
    }

    async startRecording(): Promise<void> {
        this.recording = true;
    }

    async stopRecording(): Promise<RecordingStopped> {
        this.recording = false;
        return { filePath: "/tmp/fake-video.webm" };
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

/** The fake game, but on a page whose clock is not frozen (real time): its time runs with the wall clock. */
export class RealtimeFakeGame extends FakeGame {
    realtime: boolean = false;
    private wall: number = Date.now();

    override async open(request: OpenRequest): Promise<OpenResult> {
        this.realtime = request.freezeClock === false;
        this.wall = Date.now();
        return super.open(request);
    }

    override async step(request: StepRequest): Promise<StepResult> {
        if (!this.realtime) {
            return super.step(request);
        }
        if (request.waitMs) {
            await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, request.waitMs));
        }
        const now: number = Date.now();
        const elapsed: number = now - this.wall;
        this.wall = now;
        return super.step({ ...request, advanceMs: elapsed + (request.advanceMs ?? 0) });
    }
}

/** The fake game in rounds: after every `roundMs` of game time it waits for a click, as a level's end screen does. */
export class RoundsFakeGame extends FakeGame {
    round: number = 1;
    waiting: boolean = false;

    constructor(private readonly roundMs: number) {
        super();
    }

    override async open(request: OpenRequest): Promise<OpenResult> {
        this.round = 1;
        this.waiting = false;
        return super.open(request);
    }

    override async step(request: StepRequest): Promise<StepResult> {
        if (!this.waiting) {
            const result: StepResult = await super.step(request);
            this.waiting = this.t >= this.round * this.roundMs;
            return result.score ? { ...result, score: { ...result.score, waiting: this.waiting } } : result;
        }
        // Waiting: the clock runs, nothing moves, and only a click takes the game on.
        this.steps.push(request);
        this.t += request.advanceMs ?? 0;
        if (request.click) {
            this.round++;
            this.waiting = false;
        }
        return request.observe === false ? {} : { raw: this.raw(), score: { over: false, score: Math.floor(this.t / 100), waiting: this.waiting }, clockMs: this.t };
    }
}

export function fakeGameDefinition(overrides: Partial<GameDefinition> = {}): GameDefinition {
    return {
        id: "fake-runner",
        name: "Fake Runner",
        url: "https://fake.test/",
        goal: "Press Space to jump over the obstacles. Survive.",
        perception: { adapter: Perception.CANVAS2D },
        score: { expression: "window.fake.score", label: "tenths" },
        budgets: { gameSeconds: 5, episodes: 1 },
        ...overrides,
    };
}

/** The obstacle's distance and whether the player is in the air. */
export const RUNNER_EXTRACTOR: string = `function extract(raw, memory) {
    var obstacle = raw.filter(function (d) { return d.s === "i1:0,0,20,20"; })[0];
    var player = raw.filter(function (d) { return d.s === "i1:40,0,20,20"; })[0];
    memory.frames = (memory.frames || 0) + 1;
    return { dx: obstacle ? obstacle.x : null, air: player ? player.y < 100 : false, seenFrames: memory.frames };
}`;

export function fakeProfile(overrides: Partial<Profile> = {}): Profile {
    return {
        version: 1,
        createdAt: "2026-09-27T00:00:00.000Z",
        origin: "manual",
        extractor: RUNNER_EXTRACTOR,
        instructions: "If air is false and dx is between 10 and 40, choose JUMP. Otherwise choose NOOP.",
        actions: [
            { id: "NOOP", description: "Keep running", keys: [] },
            { id: "JUMP", description: "Jump", keys: ["Space"] },
        ],
        decideOn: DecideOn.TICK,
        tickMs: 20,
        tests: [],
        ...overrides,
    };
}
