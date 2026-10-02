/**
 * The distillation loop without Python: fine-tuning is replaced by a fake that writes a checkpoint
 * directory, and the "student" server answers over HTTP with the teacher's rule — except, in the
 * first round, it keeps jumping (the mistake DAgger has to catch).
 */

import { GameBrowser } from "../../../src/devtools/client";
import { OpenRequest, OpenResult } from "../../../src/devtools/protocol";
import { Distiller, DistillOptions, DistillResult, TeacherKind } from "../../../src/distill/distiller";
import { layaPortLockFile, LayaServerHandle, recordedStudentMean } from "../../../src/distill/laya-runtime";
import { WanderingStudent } from "../../../src/distill/teacher";
import { DecisionEngine, EngineKind, Question } from "../../../src/engine";
import { DecisionEngineError, RequestTooLargeError, SystemOneResponse } from "../../../src/engine/systemone";
import { GameDefinition, Perception, Profile } from "../../../src/game/types";
import { Library } from "../../../src/library/store";
import { DecisionRecord, Pace, Player, PlayOptions, PlayResult } from "../../../src/play/player";
import { ScriptError } from "../../../src/play/sandbox";
import { DecisionLog, profileHash } from "../../../src/run/decision-log";
import { FakeEngine, jumpWhenClose } from "../../helpers/fake-engine";
import { FakeGame, fakeGameDefinition, fakeProfile, RealtimeFakeGame } from "../../helpers/fake-game";

import { spawnSync } from "child_process";
import fs, { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir, uptime } from "os";
import path from "path";

const RIGHT: string = "function teach(state) { return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";

/** The runner's state and the lag the extractor was told (what a lag-aware one computes its features for). */
const LAG_EXTRACTOR: string = `function extract(raw, memory, info) {
    var obstacle = raw.filter(function (d) { return d.s === "i1:0,0,20,20"; })[0];
    var player = raw.filter(function (d) { return d.s === "i1:40,0,20,20"; })[0];
    memory.frames = (memory.frames || 0) + 1;
    return { dx: obstacle ? obstacle.x : null, air: player ? player.y < 100 : false, seenFrames: memory.frames, lag: info.lagMs };
}`;

/** One game the player was asked to play: its seed, the lag simulated on it (none: paused), and what decided. */
interface Played {
    seed: number;
    lag?: { minMs: number; maxMs: number };
    engine: DecisionEngine;
    pace: Pace;
    minLagMs?: number;
    startedAt: number;
    endedAt?: number;
}

/** Records every game the player is asked to play (and plays it). */
function recordPlays(): Played[] {
    const played: Played[] = [];
    const play: Player["play"] = Player.prototype.play;
    jest.spyOn(Player.prototype, "play").mockImplementation(function (this: Player, options: PlayOptions): Promise<PlayResult> {
        const p: Played = {
            seed: options.seeds?.[0] as number,
            ...(options.simulatedLag ? { lag: options.simulatedLag } : {}),
            engine: (this as any).engine as DecisionEngine,
            pace: options.pace,
            ...(options.minLagMs !== undefined ? { minLagMs: options.minLagMs } : {}),
            startedAt: Date.now(),
        };
        played.push(p);
        return play.call(this, options).finally((): void => {
            p.endedAt = Date.now();
        });
    });
    return played;
}

interface Tuned {
    out: string;
    data: string[];
    trainOnly?: string[];
    base?: string;
    epochs?: number;
}

/** A labelled row as a rows file holds it. */
interface Row {
    state: unknown;
    choice: string;
    seed?: number;
    lag?: { minMs: number; maxMs: number };
    student?: string;
}

/** The rows of a rows file. */
function rowsIn(file: string): Row[] {
    return readFileSync(file, "utf-8")
        .trim()
        .split("\n")
        .map((l: string): Row => JSON.parse(l) as Row);
}

/** How many distinct states rows hold. */
function distinctStates(rows: Row[]): number {
    return new Set(rows.map((r: Row): string => JSON.stringify(r.state))).size;
}

/** The fake runner with a mark drawn on the page, its game's seed deciding which: a game whose mark was seen before shows no new state. */
class MarkedGame extends FakeGame {
    private mark: string = "";

    constructor(private readonly markOf: (seed: number | undefined) => string) {
        super();
    }

    override async open(request: OpenRequest): Promise<OpenResult> {
        this.mark = this.markOf(request.seed);
        return super.open(request);
    }

    override raw(): unknown {
        return [...(super.raw() as unknown[]), { k: "text", t: this.mark, x: 0, y: 0, w: 0, h: 0 }];
    }
}

/** The state of a MarkedGame: its mark, and the frame's place in a cycle of four — four states a mark. */
const MARK_EXTRACTOR: string = `function extract(raw, memory) {
    memory.frames = (memory.frames || 0) + 1;
    var mark = raw.filter(function (d) { return d.k === "text" && d.x === 0; })[0];
    return { mark: mark ? mark.t : "", phase: memory.frames % 4 };
}`;

describe("Distiller", (): void => {
    let root: string;
    let library: Library;
    let student: Server;
    let studentUrl: string;
    /** The checkpoint the fake server "loaded": its round decides how well it plays. */
    let served: string = "";
    /** Rounds whose student also "jumps" in the air: a mistake only its own games show. */
    let mistaken: string[] = ["-r0"];

    function distiller(
        tuned: Tuned[],
        overrides: { library?: Library; ask?: (prompt: string) => Promise<string>; browsers?: FakeGame[]; engine?: DecisionEngine; game?: () => FakeGame } = {}
    ): Distiller {
        return new Distiller({
            library: overrides.library ?? library,
            python: "python-not-used",
            ask:
                overrides.ask ??
                (async (): Promise<string> => {
                    throw new Error("the profile has a teacher: the trainer is not asked");
                }),
            openBrowser: (): GameBrowser => {
                const b: FakeGame = overrides.game?.() ?? new FakeGame();
                overrides.browsers?.push(b);
                return b;
            },
            ...(overrides.engine ? { engine: overrides.engine } : {}),
            runtime: {
                finetune: async (o: Tuned): Promise<void> => {
                    tuned.push(o);
                    mkdirSync(o.out, { recursive: true });
                    // As finetune.py saves: the model first, training.json last.
                    writeFileSync(path.join(o.out, "model.safetensors"), "x");
                    writeFileSync(path.join(o.out, "training.json"), "{}");
                },
                serve: async (o: { checkpoints: Record<string, string> }): Promise<LayaServerHandle> => {
                    served = Object.values(o.checkpoints)[0];
                    return { url: studentUrl, models: Object.keys(o.checkpoints), stop: async (): Promise<void> => {} };
                },
            },
        });
    }

    /** A checkpoint left by an earlier distillation of the profile, with the student's recorded mean. */
    function earlierCheckpoint(round: number, mean: number): string {
        const profile: Profile = library.profile("fake-runner") as Profile;
        const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v${profile.version}-${profileHash(profile)}-r${round}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), "x");
        writeFileSync(path.join(dir, "training.json"), "{}");
        writeFileSync(path.join(dir, "distill.json"), JSON.stringify({ student: { mean, scores: [mean, mean], seeds: [1, 2] } }));
        return dir;
    }

    /** A Laya server's /health on a port of its own (what it says it serves); closed after the test. */
    const healthServers: Server[] = [];
    async function healthOn(body: Record<string, unknown>): Promise<number> {
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        });
        healthServers.push(server);
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", resolve);
        });
        return (server.address() as AddressInfo).port;
    }

    /** What a server that loaded this checkpoint as it is now says of it. */
    function serving(dir: string): Record<string, unknown> {
        return {
            status: "ok",
            loaded: ["fake-runner"],
            checkpoints: { "fake-runner": realpathSync(dir) },
            weights_mtime_ns: { "fake-runner": String(statSync(path.join(dir, "model.safetensors"), { bigint: true }).mtimeNs) },
        };
    }

    const OPTIONS: Omit<Parameters<Distiller["distill"]>[0], "workDir"> = {
        gameId: "fake-runner",
        teacher: TeacherKind.RULES,
        minRows: 400,
        gameSeconds: 3,
        parallel: 2,
        rounds: 1,
        studentGames: 2,
        epochs: 1,
        port: 1,
        base: "multilingual",
    };

    beforeEach(async (): Promise<void> => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-distiller-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition({ trainSeeds: [1, 2] }));
        library.saveProfile("fake-runner", {
            ...fakeProfile({ teacher: RIGHT }),
            results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        student = createServer((req: IncomingMessage, res: ServerResponse): void => {
            if (req.method !== "POST") {
                // The engine's connection warm-up.
                res.end();
                return;
            }
            let body: string = "";
            req.on("data", (c: Buffer): void => {
                body += c.toString();
            });
            req.on("end", (): void => {
                const { state } = JSON.parse(body) as { state: { game: { dx: number | null; air: boolean } } };
                const s: { dx: number | null; air: boolean } = state.game;
                const right: boolean = !s.air && s.dx !== null && s.dx >= 10 && s.dx <= 40;
                // Round 0 also "jumps" in the air: a mistake only its own games show.
                const choice: string = right || (mistaken.some((r: string): boolean => served.endsWith(r)) && s.air) ? "JUMP" : "NOOP";
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ answers: { action: { choice, probabilities: { NOOP: choice === "NOOP" ? 1 : 0, JUMP: choice === "JUMP" ? 1 : 0 }, confidence: 1 } } }));
            });
        });
        await new Promise<void>((resolve: () => void): void => {
            student.listen(0, "127.0.0.1", resolve);
        });
        studentUrl = `http://127.0.0.1:${(student.address() as AddressInfo).port}`;
    });

    afterEach(async (): Promise<void> => {
        jest.restoreAllMocks();
        mistaken = ["-r0"];
        student.close();
        await Promise.all(
            healthServers.splice(0).map(
                (server: Server): Promise<void> =>
                    new Promise<void>((resolve: () => void): void => {
                        server.close((): void => resolve());
                    })
            )
        );
        rmSync(root, { recursive: true, force: true });
    });

    it("teacher games → fine-tuning → DAgger relabels the student's mistakes → the student plays the seeds", async (): Promise<void> => {
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        // The teacher's labelled states, then two trainings: the second continues from the first, with the relabelled states.
        const teacherRows: string[] = readFileSync(tuned[0].data[0], "utf-8").trim().split("\n");
        expect(teacherRows.length).toBeGreaterThanOrEqual(400);
        expect(JSON.parse(teacherRows[0])).toMatchObject({ criteria: { NOOP: "Keep running", JUMP: "Jump" }, engine: "rules v1" });
        expect(tuned).toHaveLength(2);
        expect(tuned[0]).toMatchObject({ base: "multilingual", epochs: 1 });
        expect(tuned[1].base).toBe(tuned[0].out);
        expect(tuned[1].epochs).toBe(0.5);
        const dagger: Array<{ choice: string; student: string }> = readFileSync(tuned[1].trainOnly![0], "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { choice: string; student: string } => JSON.parse(l));
        // The round-0 student jumped in the air; the teacher said NOOP there.
        expect(dagger.some((d: { choice: string; student: string }): boolean => d.student === "JUMP" && d.choice === "NOOP")).toBe(true);
        expect(lines.some((l: string): boolean => /chose otherwise in [1-9]/.test(l))).toBe(true);
        // The final student (round 1) plays the profile's seeds like the profile.
        expect(result).toMatchObject({ profileVersion: 1, teacher: "rules v1", student: { seeds: [1, 2], scores: [30, 30] }, reference: { scores: [30, 30] } });
        // Random play on the same games is the floor the student is placed from.
        expect(result.random?.scores).toHaveLength(2);
        expect(existsSync(path.join(result.checkpoint, "distill.json"))).toBe(true);
        // No lag asked for: every game paused.
        expect(result.lag).toBeUndefined();
        expect(result.lagged).toBeUndefined();
        expect(lines.filter((l: string): boolean => /lagged|with the lag/.test(l))).toEqual([]);
    }, 30_000);

    it("lets every other Laya game of a round wander from its seed — off its own path, its random moves no mistakes of its —, and says so when its own games play the very same on every seed", async (): Promise<void> => {
        const played: Played[] = recordPlays();
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        await distiller(tuned).distill({ ...OPTIONS, studentGames: 4, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        const round: Played[] = played.filter((p: Played): boolean => p.seed >= 1_000_000 && p.seed < 1_000_100);
        expect(round.map((p: Played): boolean => p.engine instanceof WanderingStudent)).toEqual([false, true, false, true]);
        expect(lines.some((l: string): boolean => /Laya games: .*\(wandering\)/.test(l))).toBe(true);
        // The fake runner is one game whatever the seed: the student's own two games played the very same.
        expect(lines.some((l: string): boolean => /its games on 2 seeds played the very same/.test(l))).toBe(true);
        const rows: Row[] = rowsIn(tuned[1].trainOnly![0]);
        const own: Row[] = rows.filter((r: Row): boolean => r.seed === round[0].seed);
        const wandering: Row[] = rows.filter((r: Row): boolean => r.seed === round[1].seed);
        // Off its path: states its own game never showed.
        const seen: Set<string> = new Set(own.map((r: Row): string => JSON.stringify(r.state)));
        expect(wandering.some((r: Row): boolean => !seen.has(JSON.stringify(r.state)))).toBe(true);
        // On the ground away from the obstacle the student says NOOP: a random JUMP there is kept as its own NOOP.
        const calm: Row[] = wandering.filter((r: Row): boolean => {
            const s: { dx: number | null; air: boolean } = r.state as { dx: number | null; air: boolean };
            return !s.air && (s.dx === null || s.dx < 10 || s.dx > 40);
        });
        expect(calm.length).toBeGreaterThan(0);
        expect(calm.every((r: Row): boolean => r.student === "NOOP")).toBe(true);
    }, 30_000);

    it("with a lag, plays the teacher's games with it until half the labelled states are made with it, and half of each round's Laya games: their rows are the states made for it, each with its game's seed and lag", async (): Promise<void> => {
        const v2: Profile = library.saveProfile("fake-runner", {
            ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }),
            results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const played: Played[] = recordPlays();
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, lag, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        expect(result.profileVersion).toBe(v2.version);
        const laggedSeed = (seed: number): boolean => played.find((p: Played): boolean => p.seed === seed)?.lag !== undefined;
        for (const p of played.filter((g: Played): boolean => g.lag !== undefined)) {
            expect(p.lag).toEqual(lag);
        }

        // The teacher's games, in pairs: while both kinds of state are short, one game of each pair is lagged, the other one
        // in the next pair — the lag meets the random moves (the second game of a pair) and the teacher's own path; once the
        // paused states are enough, lagged games only, until half the distinct states wanted (200 of 400) are made with it.
        const teacherGames: Played[] = played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000);
        expect(teacherGames.map((p: Played): boolean => laggedSeed(p.seed))).toEqual([false, true, true, false, true, true]);
        const wanders = (p: Played): boolean => (p.engine as any).epsilon > 0;
        expect(teacherGames.map(wanders)).toEqual([false, true, false, true, false, true]);
        expect(lines).toContain("  no labelled state is there yet");
        expect(lines).toContainEqual(expect.stringMatching(/^teacher games 10000, 10001 \(lagged\): .* — \d+\/200 made with the lag, \d+ distinct labelled states$/));
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}the teacher played 6 games, 4 of them with the lag: \d+ of the \d+ distinct labelled states are made with it$/));
        // Every row keeps its game's seed, and a lagged game's its lag: its states were made for the lag its decisions landed at.
        const teacherRows: Array<{ seed: number; lag?: unknown; state: { lag: number } }> = readFileSync(tuned[0].data[0], "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { seed: number; lag?: unknown; state: { lag: number } } => JSON.parse(l));
        expect(new Set(teacherRows.map((r: { seed: number }): number => r.seed))).toEqual(new Set(teacherGames.map((p: Played): number => p.seed)));
        for (const r of teacherRows) {
            expect(laggedSeed(r.seed) ? r.state.lag >= 45 && r.state.lag <= 60 && r.lag !== undefined : r.state.lag === 0 && r.lag === undefined).toBe(true);
        }
        expect(teacherRows.filter((r: { lag?: unknown }): boolean => r.lag !== undefined).every((r: { lag?: unknown }): boolean => JSON.stringify(r.lag) === JSON.stringify(lag))).toBe(true);
        expect(new Set(teacherRows.filter((r: { lag?: unknown }): boolean => r.lag !== undefined).map((r: { state: unknown }): string => JSON.stringify(r.state))).size).toBeGreaterThanOrEqual(200);

        // The round's two Laya games: one lagged. The teacher labelled what the student visited in both, seeds and lag kept.
        const studentGames: Played[] = played.filter((p: Played): boolean => p.seed >= 1_000_000);
        expect(studentGames.map((p: Played): number => p.seed).sort()).toEqual([1_000_000, 1_000_001]);
        expect([1_000_000, 1_000_001].map(laggedSeed)).toEqual([false, true]);
        const daggerRows: Array<{ seed: number; lag?: unknown; state: { lag: number } }> = readFileSync(tuned[1].trainOnly![0], "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { seed: number; lag?: unknown; state: { lag: number } } => JSON.parse(l));
        expect(new Set(daggerRows.map((r: { seed: number }): number => r.seed))).toEqual(new Set([1_000_000, 1_000_001]));
        for (const r of daggerRows) {
            expect(laggedSeed(r.seed) ? r.state.lag >= 45 && r.state.lag <= 60 && r.lag !== undefined : r.state.lag === 0 && r.lag === undefined).toBe(true);
        }
        // Its second game wanders too.
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}Laya games: \d+\*?, \d+\*? \(lagged\) \(wandering\)$/));

        // The profile's seeds: the student paused, then once more with the lag; its rules and random play paused.
        const seedGames: Played[] = played.filter((p: Played): boolean => p.seed < 10_000);
        const byLaya: Played[] = seedGames.filter((p: Played): boolean => p.engine.kind === EngineKind.LAYA);
        expect(byLaya.map((p: Played): string => `${p.seed}${p.lag ? " lagged" : ""}`)).toEqual(["1", "2", "1 lagged", "2 lagged"]);
        expect(seedGames.filter((p: Played): boolean => p.engine.kind !== EngineKind.LAYA && p.lag !== undefined)).toEqual([]);
        expect(seedGames.filter((p: Played): boolean => p.engine.kind !== EngineKind.LAYA)).toHaveLength(4);
        expect(result).toMatchObject({ lag, lagged: { lag, scores: [expect.any(Number), expect.any(Number)] }, student: { seeds: [1, 2], scores: [30, 30] } });
        // What the rows hold, as they are: those made with the lag, of the teacher's and of the student's relabelled.
        expect(result.laggedRows).toEqual({
            teacher: teacherRows.filter((r: { lag?: unknown }): boolean => r.lag !== undefined).length,
            dagger: daggerRows.filter((r: { lag?: unknown }): boolean => r.lag !== undefined).length,
        });
        expect(result.laggedRows?.dagger).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(path.join(result.checkpoint, "distill.json"), "utf-8"))).toMatchObject({ lag, lagged: result.lagged, laggedRows: result.laggedRows });
    });

    it("live, plays every round's Laya games with the clock running, one at a time, each game's inputs held to its own floor (spread to the slowest): their rows keep the lag each decision was made at", async (): Promise<void> => {
        const played: Played[] = recordPlays();
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        await distiller(tuned, { game: (): FakeGame => new RealtimeFakeGame() }).distill({
            ...OPTIONS,
            // Live games take their time: a second each.
            gameSeconds: 1,
            live: { minLagMs: 30, maxLagMs: 90 },
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        const studentGames: Played[] = played.filter((p: Played): boolean => p.seed >= 1_000_000);
        expect(studentGames.map((p: Played): string => `${p.pace} ${p.minLagMs}`)).toEqual([`${Pace.REALTIME} 30`, `${Pace.REALTIME} 90`]);
        expect(studentGames[1].startedAt).toBeGreaterThanOrEqual(studentGames[0].endedAt as number);
        // The teacher's games and the profile's seeds as ever: paused.
        expect(played.filter((p: Played): boolean => p.seed < 1_000_000).every((p: Played): boolean => p.pace === Pace.TURN && p.minLagMs === undefined)).toBe(true);
        const daggerRows: Array<{ lag?: { minMs: number; maxMs: number } }> = readFileSync(tuned[1].trainOnly![0], "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { lag?: { minMs: number; maxMs: number } } => JSON.parse(l));
        expect(daggerRows.length).toBeGreaterThan(0);
        expect(daggerRows.every((r: { lag?: { minMs: number; maxMs: number } }): boolean => r.lag !== undefined && r.lag.minMs === r.lag.maxMs)).toBe(true);
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}Laya games \(live\): \d+\*?, \d+\*? \(wandering\)$/));
    }, 30_000);

    it("with a lag, on a version whose rows hold enough paused states (distilled before), plays lagged teacher's games until half the states wanted are made with it, and says what it reused", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        // Distilled paused first: its rows are enough for a first training (100 distinct states and more).
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, workDir: path.join(root, "work-1") });
        const played: Played[] = recordPlays();
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, minRows: 100, rounds: 0, lag, workDir: path.join(root, "work-2"), hooks: { onLog: (l: string): number => lines.push(l) } });
        // Not one game short of it: lagged games only, the paused rows there reused.
        const teacherGames: Played[] = played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000);
        expect(teacherGames.length).toBeGreaterThan(0);
        expect(teacherGames.every((p: Played): boolean => p.lag !== undefined)).toBe(true);
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}\d+ distinct labelled states are there already, reused: 0 made with the lag, \d+ paused$/));
        expect(lines).toContainEqual(
            expect.stringMatching(new RegExp(`^ {2}the teacher played ${teacherGames.length} games, ${teacherGames.length} of them with the lag: \\d+ of the \\d+ distinct labelled states are made with it$`))
        );
        // The first training has them: at least half the states wanted (50 of 100) made with the lag, beside the paused ones.
        const rows: Array<{ lag?: unknown; state: { lag: number } }> = readFileSync(tuned[0].data[0], "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { lag?: unknown; state: { lag: number } } => JSON.parse(l));
        const lagged: Array<{ lag?: unknown; state: { lag: number } }> = rows.filter((r: { lag?: unknown }): boolean => r.lag !== undefined);
        expect(new Set(lagged.map((r: { state: unknown }): string => JSON.stringify(r.state))).size).toBeGreaterThanOrEqual(50);
        expect(lagged.every((r: { state: { lag: number } }): boolean => r.state.lag >= 45 && r.state.lag <= 60)).toBe(true);
        expect(rows.length).toBeGreaterThan(lagged.length);
        expect(result.laggedRows?.teacher).toBe(lagged.length);

        // Distilled once more with the lag: the states there are enough, and it says so.
        const again: string[] = [];
        played.length = 0;
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, lag, workDir: path.join(root, "work-3"), hooks: { onLog: (l: string): number => again.push(l) } });
        expect(played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000)).toEqual([]);
        expect(again).toContainEqual(expect.stringMatching(/^ {2}the teacher plays no game: the \d+ distinct labelled states there are enough, \d+ of them made with the lag$/));

        // With another lag: the rows made with the first are neither its own nor paused — the paused ones are as many as
        // before, and its lagged games are played.
        const another: string[] = [];
        played.length = 0;
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, lag: { minMs: 100, maxMs: 100 }, workDir: path.join(root, "work-4"), hooks: { onLog: (l: string): number => another.push(l) } });
        const paused = (log: string[]): string | undefined => log.map((l: string): string | undefined => /reused: 0 made with the lag, (\d+) paused$/.exec(l)?.[1]).find(Boolean);
        expect(paused(another)).toBe(paused(lines));
        const laterGames: Played[] = played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000);
        expect(laterGames.length).toBeGreaterThan(0);
        expect(laterGames.every((p: Played): boolean => p.lag?.minMs === 100)).toBe(true);
    }, 30_000);

    it("chooses the teacher's wandering and lagged games by their place in the run, whatever the parallelism: a batch of one wanders too", async (): Promise<void> => {
        const wanders = (p: Played): boolean => (p.engine as any).epsilon > 0;
        const teacherGames = (played: Played[]): Played[] => played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000);
        // Paused, one game at a time: every second game wanders (it once never did — the game's place in its batch decided).
        const own = (run: string): Library => {
            const lib: Library = new Library(path.join(root, `built-in-${run}`), path.join(root, `user-${run}`));
            lib.saveGame(fakeGameDefinition({ trainSeeds: [1, 2] }));
            lib.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
            return lib;
        };
        let played: Played[] = recordPlays();
        await distiller([], { library: own("paused") }).distill({ ...OPTIONS, parallel: 1, rounds: 0, workDir: path.join(root, "work-paused") });
        const paused: Played[] = teacherGames(played);
        expect(paused.length).toBeGreaterThanOrEqual(4);
        expect(paused.map(wanders)).toEqual(paused.map((_: Played, g: number): boolean => g % 2 === 1));
        // With a lag, one and two at a time: the same games while both kinds of state are short, the four kinds (paused or
        // lagged, wandering or not) as often.
        const kinds: string[][] = [];
        for (const parallel of [1, 2]) {
            jest.restoreAllMocks();
            played = recordPlays();
            await distiller([], { library: own(`lagged-${parallel}`) }).distill({ ...OPTIONS, parallel, rounds: 0, lag: { minMs: 45, maxMs: 60 }, workDir: path.join(root, `work-${parallel}`) });
            kinds.push(teacherGames(played).map((p: Played): string => `${p.seed}${p.lag ? " lagged" : ""}${wanders(p) ? " wandering" : ""}`));
        }
        expect(kinds[0].slice(0, 4)).toEqual(["10000", "10001 lagged wandering", "10002 lagged", "10003 wandering"]);
        expect(kinds[1].slice(0, 4)).toEqual(kinds[0].slice(0, 4));
    }, 30_000);

    it("reports the student's games with the lag, which never decide the checkpoint kept: the paused ones do", async (): Promise<void> => {
        // Paused, the new student plays 30 and beats this one; 150 ms late, it jumps too late and dies at the first obstacle.
        const worse: string = earlierCheckpoint(3, 29);
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const lag: { minMs: number; maxMs: number } = { minMs: 150, maxMs: 150 };
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, rounds: 0, lag, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        expect(result.checkpoint).toBe(tuned[0].out);
        expect(result.student).toMatchObject({ mean: 30, scores: [30, 30] });
        expect(result.lagged).toEqual({ lag, mean: 10, scores: [10, 10] });
        expect(existsSync(worse)).toBe(false);
        expect(lines).toContain("Laya with the lag 150 ms on the same seeds: 10, 10 (mean 10.0; paused 30.0) — for information: which checkpoint stays is decided on the paused clock");
        // Recorded with the lag, beside the paused mean a later distillation compares with.
        expect(JSON.parse(readFileSync(path.join(result.checkpoint, "distill.json"), "utf-8"))).toMatchObject({ lag, lagged: { mean: 10 }, student: { mean: 30 } });
        expect(recordedStudentMean(result.checkpoint)).toBe(30);

        // An earlier checkpoint that played better paused stays, and the result is its own as recorded: not the dropped student's
        // lagged games, nor the teacher and the lag the dropped one was taught with — its record names neither.
        const better: string = earlierCheckpoint(7, 31);
        const kept: DistillResult = await distiller([]).distill({ ...OPTIONS, rounds: 0, lag, workDir: path.join(root, "work-2") });
        expect(kept.checkpoint).toBe(better);
        expect(kept.student?.mean).toBe(31);
        expect(kept.lagged).toBeUndefined();
        expect(kept.lag).toBeUndefined();
        expect(kept.teacher).toBe("");
    });

    it("returns an earlier checkpoint that stays as its distillation recorded it: who taught it and the rows it learnt, not the dropped run's", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 99);
        const lag: { minMs: number; maxMs: number } = { minMs: 250, maxMs: 600 };
        const recorded: Partial<DistillResult> = {
            teacher: "jev (jev-latest)",
            teacherRows: 5_000,
            daggerRows: 700,
            lag,
            laggedRows: { teacher: 2_400, dagger: 350 },
            lagged: { lag, mean: 80, scores: [80, 80] },
        };
        const file: string = path.join(earlier, "distill.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), ...recorded }));
        const tuned: Tuned[] = [];
        // Taught by the rules, with another lag: the CLI once said the checkpoint that stays was taught by them.
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, minRows: 100, rounds: 0, lag: { minMs: 45, maxMs: 60 }, workDir: path.join(root, "work") });
        expect(existsSync(tuned[0].out)).toBe(false);
        expect(result).toMatchObject({ checkpoint: earlier, profileVersion: 1, student: { mean: 99 }, ...recorded });
    }, 30_000);

    it("keeps only the last round's checkpoint", async (): Promise<void> => {
        const result: DistillResult = await distiller([]).distill({ ...OPTIONS, workDir: path.join(root, "work") });
        expect(readdirSync(path.dirname(result.checkpoint))).toEqual([path.basename(result.checkpoint)]);
        expect(result.checkpoint).toMatch(/-r1$/);
    });

    it("resumed: the latest checkpoint's student plays first, then more DAgger rounds; a better new one replaces it", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        mistaken = ["-r3"];
        const tuned: Tuned[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, resume: true, workDir: path.join(root, "work") });
        expect(tuned).toHaveLength(1);
        expect(tuned[0]).toMatchObject({ base: earlier, epochs: 0.5 });
        expect(tuned[0].out).toMatch(/-r4$/);
        expect(result.checkpoint).toBe(tuned[0].out);
        expect(result.student?.mean).toBe(30);
        expect(existsSync(earlier)).toBe(false);
    });

    it("resumed with no lag given, goes on with the lag its checkpoint was distilled with, and the checkpoint it keeps records it", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        writeFileSync(path.join(earlier, "distill.json"), JSON.stringify({ student: { mean: 10, scores: [10, 10], seeds: [1, 2] }, lag }));
        mistaken = ["-r3"];
        const lines: string[] = [];
        const result: DistillResult = await distiller([]).distill({ ...OPTIONS, resume: true, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        expect(lines).toContainEqual(expect.stringMatching(/^with the lag 45–60 ms/));
        expect(result.lag).toEqual(lag);
        expect(JSON.parse(readFileSync(path.join(result.checkpoint, "distill.json"), "utf-8")).lag).toEqual(lag);
    });

    it("a new distillation numbers its rounds after the checkpoints there, and an earlier one that plays better stays", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 99);
        const tuned: Tuned[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work") });
        expect(tuned).toHaveLength(1);
        expect(tuned[0]).toMatchObject({ base: "multilingual", epochs: 1 });
        expect(tuned[0].out).toMatch(/-r4$/);
        expect(result.checkpoint).toBe(earlier);
        expect(result.student?.mean).toBe(99);
        expect(existsSync(tuned[0].out)).toBe(false);
    });

    it("learns the version asked for, not the active one: its checkpoint is that version's", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, tickMs: 20 }) } as never);
        expect(library.activeVersion("fake-runner")).toBe(2);
        const result: DistillResult = await distiller([]).distill({ ...OPTIONS, profileVersion: 1, workDir: path.join(root, "work") });
        expect(result.profileVersion).toBe(1);
        expect(path.basename(result.checkpoint)).toMatch(/^v1-/);
        expect(library.activeVersion("fake-runner")).toBe(2);
    });

    it("resuming needs a checkpoint", async (): Promise<void> => {
        await expect(distiller([]).distill({ ...OPTIONS, resume: true, workDir: path.join(root, "work") })).rejects.toThrow(/no checkpoint to go on from/);
    });

    it("resumed on a version with no teacher while the rules teach, refuses before the trainer writes one: that new version would have no checkpoint", async (): Promise<void> => {
        const v2: Profile = library.saveProfile("fake-runner", { ...fakeProfile({ tickMs: 20 }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        // A checkpoint of v2, which an engine taught.
        const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v2-${profileHash(v2)}-r0`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), "x");
        writeFileSync(path.join(dir, "training.json"), "{}");
        const asked: string[] = [];
        const browsers: FakeGame[] = [];
        const tuned: Tuned[] = [];
        await expect(
            distiller(tuned, {
                browsers,
                ask: async (prompt: string): Promise<string> => {
                    asked.push(prompt);
                    return JSON.stringify({ teacher: RIGHT, notes: "n" });
                },
            }).distill({ ...OPTIONS, resume: true, workDir: path.join(root, "work") })
        ).rejects.toThrow(/Fake Runner v2 has no teacher \(its rules as code\) to go on with: resume with the engine teaching \(--teacher engine\), or distil it afresh/);
        // Nothing written, played or fine-tuned: no v3, and v2 stays active.
        expect(asked).toHaveLength(0);
        expect(browsers).toHaveLength(0);
        expect(tuned).toHaveLength(0);
        expect((): unknown => library.profile("fake-runner", 3)).toThrow(/no profile v3/);
        expect(library.activeVersion("fake-runner")).toBe(2);
    });

    it("stops when the teacher labels nothing after a few batches, and refuses to fine-tune on no labelled state", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { throw new Error('nope'); }" }), results: { mean: 0, scores: [0, 0], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const tuned: Tuned[] = [];
        const browsers: FakeGame[] = [];
        await expect(distiller(tuned, { browsers }).distill({ ...OPTIONS, minRows: 100, gameSeconds: 1, rounds: 0, workDir: path.join(root, "work") })).rejects.toThrow(
            /the teacher labelled no state in its 8 games \(it failed on them: nope\): nothing to fine-tune on/
        );
        // Four batches of two games, not sixty; no fine-tuning.
        expect(browsers).toHaveLength(8);
        expect(tuned).toHaveLength(0);
    });

    it("refuses a DAgger round's fine-tuning with no labelled state at all", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: "function teach() { throw new Error('nope'); }" }), results: { mean: 0, scores: [0, 0], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        earlierCheckpoint(3, 10);
        const tuned: Tuned[] = [];
        // Resumed: no first training; the student plays, the teacher labels none of what it visited.
        await expect(distiller(tuned).distill({ ...OPTIONS, resume: true, minRows: 10, gameSeconds: 1, workDir: path.join(root, "work") })).rejects.toThrow(
            /round 4: no labelled states to fine-tune on/
        );
        expect(tuned).toHaveLength(0);
    });

    it("holds its port for the whole run: another distillation or an evaluation on it is refused at once, and a lock whose process is gone is taken over", async (): Promise<void> => {
        let fineTuning!: () => void;
        const reached: Promise<void> = new Promise<void>((resolve: () => void): void => {
            fineTuning = resolve;
        });
        let finish!: () => void;
        const finished: Promise<void> = new Promise<void>((resolve: () => void): void => {
            finish = resolve;
        });
        // A first distillation, held in its fine-tuning (hours, for a real one).
        const first: Promise<DistillResult> = new Distiller({
            library,
            python: "python-not-used",
            ask: async (): Promise<string> => {
                throw new Error("the profile has a teacher: the trainer is not asked");
            },
            openBrowser: (): GameBrowser => new FakeGame(),
            runtime: {
                finetune: async (o: Tuned): Promise<void> => {
                    fineTuning();
                    await finished;
                    mkdirSync(o.out, { recursive: true });
                    writeFileSync(path.join(o.out, "model.safetensors"), "x");
                    writeFileSync(path.join(o.out, "training.json"), "{}");
                },
                serve: async (o: { checkpoints: Record<string, string> }): Promise<LayaServerHandle> => {
                    served = Object.values(o.checkpoints)[0];
                    return { url: studentUrl, models: Object.keys(o.checkpoints), stop: async (): Promise<void> => {} };
                },
            },
        }).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work-1") });
        await reached;
        const browsers: FakeGame[] = [];
        await expect(distiller([], { browsers }).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work-2") })).rejects.toThrow(
            /Laya port 1 is held by a distillation of fake-runner \(pid \d+, since .*\): wait for it to end, or use another LAYA port/
        );
        await expect(distiller([]).evaluate(library.game("fake-runner"), library.profile("fake-runner") as Profile, path.join(root, "none"), { ...OPTIONS, workDir: root })).rejects.toThrow(
            /Laya port 1 is held by a distillation of fake-runner/
        );
        expect(browsers).toHaveLength(0);
        finish();
        await first;
        // Released at its end.
        expect(existsSync(layaPortLockFile(library, 1))).toBe(false);
        // Left by a process that is gone (killed while it distilled): taken over, and released in turn.
        const gone: number = spawnSync(process.execPath, ["-e", ""]).pid as number;
        writeFileSync(layaPortLockFile(library, 1), JSON.stringify({ pid: gone, holder: "a distillation of fake-runner", since: "2026-09-30T00:00:00.000Z", token: "killed" }));
        await expect(distiller([]).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work-3") })).resolves.toMatchObject({ profileVersion: 1 });
        expect(existsSync(layaPortLockFile(library, 1))).toBe(false);
    }, 30_000);

    it("takes over a port's lock taken before this machine started, whatever process has its pid now; one that stands is refused, naming its file", async (): Promise<void> => {
        const file: string = layaPortLockFile(library, 1);
        const evaluation = (): Promise<DistillResult> =>
            distiller([]).evaluate(library.game("fake-runner"), library.profile("fake-runner") as Profile, path.join(root, "none"), { ...OPTIONS, workDir: root });
        // Left by a distillation a reboot ended: its pid is a running process's now (this one's, here).
        const booted: number = Date.now() - uptime() * 1000;
        writeFileSync(file, JSON.stringify({ pid: process.pid, holder: "a distillation of fake-runner", since: new Date(booted - 3_600_000).toISOString(), token: "rebooted" }));
        await expect(evaluation()).resolves.toMatchObject({ student: { seeds: [1, 2] } });
        expect(existsSync(file)).toBe(false);
        // Taken since, by a process that runs: it stands, and the refusal says where its lock is (one whose pid another process
        // took since is left only by removing it).
        const since: string = new Date().toISOString();
        writeFileSync(file, JSON.stringify({ pid: process.pid, holder: "a distillation of fake-runner", since, token: "standing" }));
        await expect(evaluation()).rejects.toThrow(
            `Laya port 1 is held by a distillation of fake-runner (pid ${process.pid}, since ${since}): wait for it to end, or use another LAYA port (its lock: ${file}; remove it if pid ${process.pid} is not that run)`
        );
        expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ token: "standing" });
    });

    it("holds the version it learns for the whole run, whatever the port: a second distillation of it is refused before it touches a round folder", async (): Promise<void> => {
        let fineTuning!: () => void;
        const reached: Promise<void> = new Promise<void>((resolve: () => void): void => {
            fineTuning = resolve;
        });
        let finish!: () => void;
        const finished: Promise<void> = new Promise<void>((resolve: () => void): void => {
            finish = resolve;
        });
        // A first distillation on port 1, held in its fine-tuning: its round folder is there, with no model yet (as
        // finetune.py leaves it while it trains: its resume state).
        let round: string = "";
        const first: Promise<DistillResult> = new Distiller({
            library,
            python: "python-not-used",
            ask: async (): Promise<string> => {
                throw new Error("the profile has a teacher: the trainer is not asked");
            },
            openBrowser: (): GameBrowser => new FakeGame(),
            runtime: {
                finetune: async (o: Tuned): Promise<void> => {
                    round = o.out;
                    mkdirSync(o.out, { recursive: true });
                    writeFileSync(path.join(o.out, "resume.pt"), "the first run's");
                    fineTuning();
                    await finished;
                    writeFileSync(path.join(o.out, "model.safetensors"), "x");
                    writeFileSync(path.join(o.out, "training.json"), "{}");
                },
                serve: async (o: { checkpoints: Record<string, string> }): Promise<LayaServerHandle> => {
                    served = Object.values(o.checkpoints)[0];
                    return { url: studentUrl, models: Object.keys(o.checkpoints), stop: async (): Promise<void> => {} };
                },
            },
        }).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work-1") });
        await reached;
        const lock: string = path.join(path.dirname(round), `.${path.basename(round).replace(/-r\d+$/, "")}.lock`);
        // The same version on port 2: refused, naming the first, before its teacher's games — the round in progress untouched
        // (it once removed it as a leftover, fine-tuned into the same folder, and each run dropped the other's at its end).
        const browsers: FakeGame[] = [];
        const tuned: Tuned[] = [];
        await expect(distiller(tuned, { browsers }).distill({ ...OPTIONS, rounds: 0, port: 2, workDir: path.join(root, "work-2") })).rejects.toThrow(
            `Fake Runner v1 is held by a distillation of fake-runner on port 1 (pid ${process.pid}, since ${JSON.parse(readFileSync(lock, "utf-8")).since}): wait for it to end — two distillations of one version would number, fine-tune and remove the same round folders (its lock: ${lock}; remove it if pid ${process.pid} is not that run)`
        );
        expect(browsers).toHaveLength(0);
        expect(tuned).toHaveLength(0);
        expect(readFileSync(path.join(round, "resume.pt"), "utf-8")).toBe("the first run's");
        // Its own port's lock is released with it.
        expect(existsSync(layaPortLockFile(library, 2))).toBe(false);
        finish();
        expect((await first).checkpoint).toBe(round);
        expect(existsSync(path.join(round, "model.safetensors"))).toBe(true);
        // Released at its end; one left by a process that is gone (killed while it distilled) is taken over, and released in turn.
        expect(existsSync(lock)).toBe(false);
        const gone: number = spawnSync(process.execPath, ["-e", ""]).pid as number;
        writeFileSync(lock, JSON.stringify({ pid: gone, holder: "a distillation of fake-runner on port 1", since: new Date().toISOString(), token: "killed" }));
        await expect(distiller([]).distill({ ...OPTIONS, rounds: 0, port: 2, workDir: path.join(root, "work-3") })).resolves.toMatchObject({ profileVersion: 1 });
        expect(existsSync(lock)).toBe(false);
    }, 30_000);

    it("refuses any Laya server on its port before anything else when it fine-tunes: before the trainer, the teacher's games or a fine-tuning", async (): Promise<void> => {
        // A version with no teacher yet: the trainer would write one first.
        library.saveProfile("fake-runner", { ...fakeProfile({ tickMs: 20 }) } as never);
        const port: number = await healthOn({ status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": path.join(root, "elsewhere", "v9-aaaa-r0") } });
        const tuned: Tuned[] = [];
        const browsers: FakeGame[] = [];
        const asked: string[] = [];
        await expect(
            distiller(tuned, {
                browsers,
                ask: async (prompt: string): Promise<string> => {
                    asked.push(prompt);
                    return JSON.stringify({ teacher: RIGHT, notes: "n" });
                },
            }).distill({ ...OPTIONS, profileVersion: 2, port, workDir: path.join(root, "work") })
        ).rejects.toThrow(/answers for fake-runner \(.*v9-aaaa-r0\): a distillation serves the checkpoints it fine-tunes on its port itself — stop it or use another LAYA port/);
        // Not hours later, when the student would first play: nothing asked, no game played, nothing fine-tuned.
        expect(asked).toHaveLength(0);
        expect(browsers).toHaveLength(0);
        expect(tuned).toHaveLength(0);
    });

    it("resumed with more rounds, refuses even a server holding the checkpoint it goes on from: the next round's would be refused after its fine-tuning", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        const port: number = await healthOn(serving(earlier));
        const tuned: Tuned[] = [];
        const browsers: FakeGame[] = [];
        await expect(distiller(tuned, { browsers }).distill({ ...OPTIONS, resume: true, port, workDir: path.join(root, "work") })).rejects.toThrow(
            /answers for fake-runner \(.*-r3\): a distillation serves the checkpoints it fine-tunes on its port itself/
        );
        expect(browsers).toHaveLength(0);
        expect(tuned).toHaveLength(0);
    });

    it("resumed with no more rounds, reuses a server holding the very checkpoint it resumes from, and refuses one holding another before the teacher's games", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        const other: number = await healthOn({ status: "ok", loaded: ["fake-runner"], checkpoints: { "fake-runner": path.join(root, "elsewhere", "v9-aaaa-r0") } });
        const browsers: FakeGame[] = [];
        await expect(distiller([], { browsers }).distill({ ...OPTIONS, resume: true, rounds: 0, port: other, workDir: path.join(root, "work") })).rejects.toThrow(
            /answers for fake-runner \(.*v9-aaaa-r0\), not fake-runner \(.*-r3\): stop it or use another LAYA port/
        );
        expect(browsers).toHaveLength(0);
        const tuned: Tuned[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, resume: true, rounds: 0, port: await healthOn(serving(earlier)), workDir: path.join(root, "work") });
        // Nothing fine-tuned: the checkpoint it resumed from played the seeds.
        expect(tuned).toHaveLength(0);
        expect(result.checkpoint).toBe(earlier);
        expect(result.student?.scores).toHaveLength(2);
    });

    it("stopped while the student plays the seeds, it records nothing and removes no checkpoint", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        const tuned: Tuned[] = [];
        const abort: AbortController = new AbortController();
        await expect(
            distiller(tuned).distill({
                ...OPTIONS,
                rounds: 0,
                workDir: path.join(root, "work"),
                signal: abort.signal,
                hooks: {
                    onPhase: (phase: string): void => {
                        if (/Laya plays the profile's seeds/.test(phase)) {
                            abort.abort();
                        }
                    },
                },
            })
        ).rejects.toThrow(/stopped/);
        expect(existsSync(earlier)).toBe(true);
        expect(existsSync(path.join(tuned[0].out, "model.safetensors"))).toBe(true);
        expect(existsSync(path.join(tuned[0].out, "distill.json"))).toBe(false);
    });

    it("a fine-tuning that never finished leaves a folder no new round starts in: it is removed first", async (): Promise<void> => {
        earlierCheckpoint(3, 10);
        const profile: Profile = library.profile("fake-runner") as Profile;
        const leftover = (round: number): string => {
            const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v${profile.version}-${profileHash(profile)}-r${round}`);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "resume.pt"), "a crashed run's state");
            return dir;
        };
        const next: string = leftover(4);
        const later: string = leftover(7);
        const tuned: Tuned[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work") });
        // Numbered after the last checkpoint, in a folder of its own: no resume state from before in it.
        expect(tuned[0].out).toBe(next);
        expect(existsSync(path.join(next, "resume.pt"))).toBe(false);
        expect(existsSync(later)).toBe(false);
        expect(readdirSync(path.dirname(result.checkpoint))).toEqual([path.basename(next)]);
    });

    it("takes a round cut off while it saved its model for a leftover: removed, and a resume goes on from the last complete round", async (): Promise<void> => {
        const earlier: string = earlierCheckpoint(3, 10);
        const profile: Profile = library.profile("fake-runner") as Profile;
        // Killed while saving: the model (maybe cut short) and its config, but not training.json, which finetune.py writes last.
        const cut: string = path.join(library.userDirFor("fake-runner"), "laya", `v${profile.version}-${profileHash(profile)}-r4`);
        mkdirSync(cut, { recursive: true });
        writeFileSync(path.join(cut, "model.safetensors"), "half a model");
        writeFileSync(path.join(cut, "rl_agent_config.json"), "{}");
        // Round 3's student still makes a mistake: the next round is fine-tuned.
        mistaken = ["-r3"];
        const tuned: Tuned[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, resume: true, workDir: path.join(root, "work") });
        expect(tuned).toHaveLength(1);
        expect(tuned[0].base).toBe(earlier);
        // Round 4 again, in a folder of its own: nothing of the one cut off is left in it.
        expect(tuned[0].out).toBe(cut);
        expect(result.checkpoint).toBe(cut);
        expect(readFileSync(path.join(cut, "model.safetensors"), "utf-8")).toBe("x");
        expect(existsSync(path.join(cut, "rl_agent_config.json"))).toBe(false);
    });

    it("writes the teacher of a version that is not active without making it active", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ tickMs: 20 }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        library.setActive("fake-runner", 1);
        const asked: string[] = [];
        const result: DistillResult = await distiller([], {
            ask: async (prompt: string): Promise<string> => {
                asked.push(prompt);
                return JSON.stringify({ teacher: RIGHT, notes: "the rules as code" });
            },
        }).distill({ ...OPTIONS, profileVersion: 2, rounds: 0, workDir: path.join(root, "work") });
        expect(asked).toHaveLength(1);
        expect(result.profileVersion).toBe(3);
        expect(library.profile("fake-runner", 3)).toMatchObject({ origin: "teacher", parent: 2 });
        expect(library.activeVersion("fake-runner")).toBe(1);
    });

    it("opens every game with the game's own perception script", async (): Promise<void> => {
        library.saveGame(fakeGameDefinition({ trainSeeds: [1, 2], perception: { adapter: Perception.CUSTOM, script: "perceive.js", read: "window.perceived" } }));
        library.writeFile("fake-runner", "perceive.js", "window.perceived = [];");
        const browsers: FakeGame[] = [];
        await distiller([], { browsers }).distill({ ...OPTIONS, workDir: path.join(root, "work") });
        const opened: OpenRequest[] = browsers.flatMap((b: FakeGame): OpenRequest[] => b.opened);
        // The teacher's games, the student's in a DAgger round, and the seeds played by the student, the rules and random play.
        expect(opened.length).toBeGreaterThanOrEqual(10);
        expect(opened.every((r: OpenRequest): boolean => r.initScripts?.[0] === "window.perceived = [];")).toBe(true);
    }, 30_000);

    it("explores from the game's seed: the teacher's games replay, random moves and all", async (): Promise<void> => {
        const rows: string[][] = [];
        for (let run: number = 0; run < 2; run++) {
            const own: Library = new Library(path.join(root, `built-in-${run}`), path.join(root, `user-${run}`));
            own.saveGame(fakeGameDefinition({ trainSeeds: [1, 2] }));
            const profile: Profile = own.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
            const result: DistillResult = await distiller([], { library: own }).distill({ ...OPTIONS, minRows: 100, rounds: 0, workDir: path.join(root, `work-${run}`) });
            expect(result.teacherRows).toBeGreaterThanOrEqual(100);
            const file: string = path.join(own.userDirFor("fake-runner"), "decisions", `v1-${profileHash(profile)}.rules.jsonl`);
            rows.push(
                readFileSync(file, "utf-8")
                    .trim()
                    .split("\n")
                    .map((l: string): string => {
                        const r: { state: unknown; choice: string } = JSON.parse(l);
                        return JSON.stringify([r.state, r.choice]);
                    })
                    .sort()
            );
        }
        expect(rows[1]).toEqual(rows[0]);
    });

    it("counts a student's choice the teacher leaves open as no mistake", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const record = (choice: string, state: unknown): DecisionRecord => ({
            state,
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice,
            probabilities: {},
            confidence: 1,
            ms: 1,
        });
        writeFileSync(visited, [record("JUMP", { tie: true }), record("NOOP", { tie: false })].map((d: DecisionRecord): string => JSON.stringify(d)).join("\n"));
        const label = async (d: DecisionRecord): Promise<Record<string, number>> => ((d.state as { tie: boolean }).tie ? { NOOP: 0.5, JUMP: 0.5 } : { NOOP: 0.2, JUMP: 0.8 });
        const relabelled: { added: number; disagreed: number } = await (distiller([]) as any).relabel(visited, out, label, { ...OPTIONS, workDir: root } as DistillOptions);
        expect(relabelled).toEqual({ added: 2, disagreed: 1, failed: 0, lagged: [] });
        const rows: Array<{ state: { tie: boolean }; choice: string; student: string }> = readFileSync(out, "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { state: { tie: boolean }; choice: string; student: string } => JSON.parse(l));
        // The tie keeps the student's choice (not a hard row); the mistake is marked with the teacher's.
        expect(rows.find((r: { state: { tie: boolean } }): boolean => r.state.tie)).toMatchObject({ choice: "JUMP", student: "JUMP" });
        expect(rows.find((r: { state: { tie: boolean } }): boolean => !r.state.tie)).toMatchObject({ choice: "JUMP", student: "NOOP" });
    });

    it("counts the states the teacher fails on when it relabels — the rules throwing, or no probabilities — per lagged game, with the first error", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const record = (seed: number, n: number, lagged: boolean): Record<string, unknown> => ({
            state: { n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: {},
            confidence: 1,
            ms: 1,
            seed,
            ...(lagged ? { lag } : {}),
        });
        // Game 1 paused; game 2 lagged, three of whose four states the teacher cannot label.
        writeFileSync(
            visited,
            [record(1, 0, false), record(1, 1, false), record(2, 10, true), record(2, 11, true), record(2, 12, true), record(2, 13, true)]
                .map((r: Record<string, unknown>): string => JSON.stringify(r))
                .join("\n")
        );
        const label = async (d: DecisionRecord): Promise<Record<string, number> | undefined> => {
            const n: number = (d.state as { n: number }).n;
            if (n === 11 || n === 12) {
                // As the rules fail on a state: from the sandbox.
                throw new ScriptError(`no rule for ${n}`);
            }
            return n === 13 ? undefined : { NOOP: 1, JUMP: 0 };
        };
        const relabelled: Record<string, unknown> = await (distiller([]) as any).relabel(visited, out, label, { ...OPTIONS, workDir: root } as DistillOptions);
        expect(relabelled).toEqual({
            added: 3,
            disagreed: 0,
            failed: 3,
            firstFailure: expect.stringMatching(/^no rule for 1[12]$/),
            lagged: [{ seed: 2, states: 4, failed: 3, firstFailure: expect.stringMatching(/^no rule for 1[12]$/) }],
        });
        // The rows written keep their game's seed, and a lagged game's its lag.
        const rows: Array<{ seed: number; lag?: unknown }> = readFileSync(out, "utf-8")
            .trim()
            .split("\n")
            .map((l: string): { seed: number; lag?: unknown } => JSON.parse(l));
        expect(rows.map((r: { seed: number; lag?: unknown }): string => `${r.seed} ${JSON.stringify(r.lag ?? null)}`).sort()).toEqual(["1 null", "1 null", `2 ${JSON.stringify(lag)}`]);
    });

    it("refuses a lagged game of its own whose states the teacher mostly failed on, before any fine-tuning, and says what it failed on in every batch", async (): Promise<void> => {
        // Right on paused states; it throws on every lagged one — its check played paused games only.
        const teacher: string =
            "function teach(state) { if (state.lag > 0) { throw new Error('no rule for a lagged state'); } return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        await expect(
            distiller(tuned).distill({ ...OPTIONS, lag: { minMs: 45, maxMs: 60 }, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } })
        ).rejects.toThrow(
            /^the teacher \(rules v2\) failed on (\d+) of the \1 states of its lagged game 10001, played with the lag 45–60 ms \(the first: no rule for a lagged state\): with more than half of a lagged game unlabelled, the student would learn next to nothing of real time/
        );
        expect(tuned).toHaveLength(0);
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}the teacher failed on \d+ of the \d+ states of these games: left unlabelled \(the first: no rule for a lagged state\)$/));
    });

    it("says what the teacher failed on in its games, and goes on while it labels most of each lagged game", async (): Promise<void> => {
        // Every tenth frame of a game, paused or lagged, it throws.
        const teacher: string =
            "function teach(state) { if (state.seenFrames % 10 === 0) { throw new Error('a tenth frame'); } return !state.air && state.dx !== null && state.dx >= 10 && state.dx <= 40 ? 'JUMP' : 'NOOP'; }";
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const lines: string[] = [];
        const result: DistillResult = await distiller([]).distill({
            ...OPTIONS,
            rounds: 0,
            lag: { minMs: 45, maxMs: 60 },
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        expect(result.laggedRows?.teacher).toBeGreaterThan(0);
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}the teacher failed on \d+ of the \d+ states of these games: left unlabelled \(the first: a tenth frame\)$/));
    });

    it("refuses a lagged game of the student's whose states the teacher mostly failed on, and says what it failed on", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        // An engine teaching: it answers every state of its own games, then no action for the lagged ones the student visits.
        let studentPlays: boolean = false;
        const right: FakeEngine = new FakeEngine(jumpWhenClose);
        const engine: DecisionEngine = {
            kind: right.kind,
            label: "fake",
            ask: async (state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> => {
                if (studentPlays && (state as { game: { lag: number } }).game.lag > 0) {
                    return { answers: { action: { choice: "DUCK", probabilities: { DUCK: 1 }, confidence: 1 } } };
                }
                return right.ask(state, questions);
            },
            health: right.health.bind(right),
        };
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        await expect(
            distiller(tuned, { engine }).distill({
                ...OPTIONS,
                teacher: TeacherKind.ENGINE,
                lag: { minMs: 45, maxMs: 60 },
                workDir: path.join(root, "work"),
                hooks: {
                    onLog: (l: string): number => lines.push(l),
                    onPhase: (phase: string): void => {
                        studentPlays ||= /Laya plays, the teacher labels/.test(phase);
                    },
                },
            })
        ).rejects.toThrow(
            /^the teacher \(fake\) failed on (\d+) of the \1 states of the student's lagged game 1000001, played with the lag 45–60 ms \(the first: Invalid choice answer; no action executed\)/
        );
        // After the first training, before a round's.
        expect(tuned).toHaveLength(1);
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}the teacher failed on \d+ more: left out \(the first: Invalid choice answer; no action executed\)$/));
    });

    it("with an engine teaching, fails the run with the engine's own error when it cannot be reached while it relabels: an outage is no teacher failing on the states", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        // It answers every state of its own games, then is down (after its client's retries) once the student plays.
        let studentPlays: boolean = false;
        const right: FakeEngine = new FakeEngine(jumpWhenClose);
        const engine: DecisionEngine = {
            kind: right.kind,
            label: "fake",
            ask: async (state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> => {
                if (studentPlays) {
                    throw new DecisionEngineError("fake: connection to http://127.0.0.1:9/v1/systemone failed; no action executed");
                }
                return right.ask(state, questions);
            },
            health: right.health.bind(right),
        };
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        await expect(
            distiller(tuned, { engine }).distill({
                ...OPTIONS,
                teacher: TeacherKind.ENGINE,
                lag: { minMs: 45, maxMs: 60 },
                workDir: path.join(root, "work"),
                hooks: {
                    onLog: (l: string): number => lines.push(l),
                    onPhase: (phase: string): void => {
                        studentPlays ||= /Laya plays, the teacher labels/.test(phase);
                    },
                },
            })
        ).rejects.toThrow(/^fake: connection to http:\/\/127\.0\.0\.1:9\/v1\/systemone failed; no action executed$/);
        // It once went on as the teacher failing on every state the student visited, and with the lag refused the run blaming
        // the teacher: no round is fine-tuned after the first training, and the teacher is blamed for nothing.
        expect(tuned).toHaveLength(1);
        expect(lines.filter((l: string): boolean => /the teacher .*failed on|the teacher labelled/.test(l))).toEqual([]);
    }, 30_000);

    it("relabelling with an engine that cannot be reached, asks about no more states and throws its error once the states asked about meanwhile are answered", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const record = (n: number): Record<string, unknown> => ({
            state: { n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: {},
            confidence: 1,
            ms: 1,
            seed: 1_000_001,
            lag: { minMs: 45, maxMs: 60 },
        });
        writeFileSync(visited, Array.from({ length: 40 }, (_: unknown, n: number): string => JSON.stringify(record(n))).join("\n"));
        // Down for the first state (after its client's retries); the ones asked about at the same time are answered later.
        const down: string = "jev: connection to https://api.typesafe.ai/v1/systemone failed; no action executed";
        let asked: number = 0;
        let answering: number = 0;
        const engine: DecisionEngine = {
            kind: EngineKind.JEV,
            label: "jev",
            ask: async (state: unknown): Promise<SystemOneResponse> => {
                asked++;
                if ((state as { game: { n: number } }).game.n === 0) {
                    throw new DecisionEngineError(down);
                }
                answering++;
                await new Promise<void>((resolve: () => void): void => {
                    setTimeout(resolve, 50);
                });
                answering--;
                return { answers: { action: { choice: "NOOP", probabilities: { NOOP: 1, JUMP: 0 }, confidence: 1 } } };
            },
            health: async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "jev" }),
        };
        const taught: Distiller = distiller([], { engine });
        const error: unknown = await (taught as any)
            .relabel(visited, out, (taught as any).labeller(undefined), { ...OPTIONS, workDir: root } as DistillOptions)
            .catch((err: unknown): unknown => err);
        // Its own error, not "the teacher failed on 40 states": it once asked about every one, each through the client's retries.
        expect(error).toBeInstanceOf(DecisionEngineError);
        expect((error as Error).message).toBe(down);
        // Only the eight asked about at once, and thrown after the seven answered were written.
        expect(asked).toBe(8);
        expect(answering).toBe(0);
        expect(rowsIn(out)).toHaveLength(7);
    });

    it("relabelling with an engine, asks again an answer that is no action as the player does — twice, then the state is left out —, and leaves out at once a state too large for it", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const record = (n: number): Record<string, unknown> => ({
            state: { n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: {},
            confidence: 1,
            ms: 1,
            seed: 1,
        });
        writeFileSync(visited, [0, 1, 2].map((n: number): string => JSON.stringify(record(n))).join("\n"));
        const asked: Record<number, number> = {};
        const engine: DecisionEngine = {
            kind: EngineKind.JEV,
            label: "fake",
            ask: async (state: unknown): Promise<SystemOneResponse> => {
                const n: number = (state as { game: { n: number } }).game.n;
                asked[n] = (asked[n] ?? 0) + 1;
                if (n === 2) {
                    throw new RequestTooLargeError('fake: HTTP 400 {"detail": {"error_type": "max_tokens_exceeded"}}; no action executed');
                }
                // State 0: no action at first, then an answer; state 1: never an action.
                return n === 0 && asked[n] > 1
                    ? { answers: { action: { choice: "JUMP", probabilities: { NOOP: 0.2, JUMP: 0.8 }, confidence: 0.8 } } }
                    : { answers: { action: { choice: "DUCK", probabilities: { DUCK: 1 }, confidence: 1 } } };
            },
            health: async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "fake" }),
        };
        const taught: Distiller = distiller([], { engine });
        const relabelled: Record<string, unknown> = await (taught as any).relabel(visited, out, (taught as any).labeller(undefined), { ...OPTIONS, workDir: root } as DistillOptions);
        expect(asked).toEqual({ 0: 2, 1: 3, 2: 1 });
        expect(relabelled).toEqual({ added: 1, disagreed: 1, failed: 2, firstFailure: expect.stringMatching(/max_tokens_exceeded|^Invalid choice answer/), lagged: [] });
        expect(rowsIn(out)).toEqual([expect.objectContaining({ state: { n: 0 }, choice: "JUMP", student: "NOOP" })]);
    });

    it("taught by an engine, it says the rules it is measured against are not its teacher", async (): Promise<void> => {
        const lines: string[] = [];
        const result: DistillResult = await distiller([], { engine: new FakeEngine(jumpWhenClose) }).distill({
            ...OPTIONS,
            teacher: TeacherKind.ENGINE,
            rounds: 0,
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        expect(result.teacher).toBe("fake");
        expect(lines.find((l: string): boolean => l.startsWith("Laya on the profile's seeds:"))).toContain("the profile's rules (rules v1; not its teacher, an engine taught it)");
    });

    it("resumed, fine-tunes on the teacher's games of the run although its student agrees everywhere, and records the rows the checkpoint learnt, not the files' rows", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        // No student makes a mistake the teacher would correct. Distilled paused first.
        mistaken = [];
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, workDir: path.join(root, "work-1") });
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        // Resumed with the lag: the teacher plays lagged games (the rows there are paused ones), and the student agrees.
        const result: DistillResult = await distiller(tuned).distill({
            ...OPTIONS,
            minRows: 100,
            rounds: 2,
            resume: true,
            lag,
            workDir: path.join(root, "work-2"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        // It once stopped at that agreement: nothing fine-tuned, while the checkpoint's record claimed the lagged rows.
        expect(lines).toContainEqual(expect.stringMatching(/^ {2}the student agrees with the teacher everywhere it went, but never learnt the teacher's [1-9]\d* games of this run: the next round does$/));
        expect(tuned).toHaveLength(1);
        expect(result.checkpoint).toBe(tuned[0].out);
        // The next round's student agreed too, and the run stopped there: the rows it relabelled are learnt by no checkpoint.
        expect(lines).toContain("  the student agrees with the teacher everywhere it went: no more DAgger rounds");
        const trainedOn: RegExpExecArray = /^round \d+: fine-tuning on (\d+) teacher states \+ (\d+) the student visited$/.exec(
            lines.find((l: string): boolean => l.startsWith("round ")) as string
        ) as RegExpExecArray;
        const [teacherRows, daggerRows]: number[] = [Number(trainedOn[1]), Number(trainedOn[2])];
        const dagger: Row[] = rowsIn(tuned[0].trainOnly![0]);
        expect(dagger.length).toBeGreaterThan(daggerRows);
        // Recorded: the rows of its fine-tuning — the first ones of the files, which only grow — and of them those made with the lag.
        const laggedOf = (rows: Row[]): number => rows.filter((r: Row): boolean => r.lag !== undefined).length;
        const recorded: Partial<DistillResult> = {
            teacherRows,
            daggerRows,
            laggedRows: { teacher: laggedOf(rowsIn(tuned[0].data[0]).slice(0, teacherRows)), dagger: laggedOf(dagger.slice(0, daggerRows)) },
        };
        expect(result).toMatchObject(recorded);
        expect(result.laggedRows?.teacher).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(path.join(result.checkpoint, "distill.json"), "utf-8"))).toMatchObject(recorded);
    }, 30_000);

    it("resumed with no more rounds, plays no teacher game — nothing is fine-tuned — and records the rows its checkpoint learnt", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const first: DistillResult = await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, workDir: path.join(root, "work-1") });
        const played: Played[] = recordPlays();
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const result: DistillResult = await distiller(tuned).distill({
            ...OPTIONS,
            minRows: 100,
            rounds: 0,
            resume: true,
            lag,
            workDir: path.join(root, "work-2"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        // The lagged rows short, the teacher once played lagged games here: rows no checkpoint would learn.
        expect(played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000)).toEqual([]);
        expect(tuned).toHaveLength(0);
        expect(lines).toContain("  resumed with no more rounds, nothing is fine-tuned: the teacher plays no game");
        expect(result.checkpoint).toBe(first.checkpoint);
        // What its checkpoint learnt, as the distillation that made it recorded — paused: no lag, no rows made with one. This
        // run's lag is only the one its lagged games were played with (it once was recorded as the lag the checkpoint learnt).
        expect(first.teacherRows).toBeGreaterThan(0);
        const recorded: Partial<DistillResult> = {
            teacher: "rules v2",
            teacherRows: first.teacherRows,
            daggerRows: first.daggerRows,
            lagged: { lag, mean: expect.any(Number), scores: [expect.any(Number), expect.any(Number)] },
        };
        const record: DistillResult = JSON.parse(readFileSync(path.join(result.checkpoint, "distill.json"), "utf-8"));
        for (const r of [result, record]) {
            expect(r).toMatchObject(recorded);
            expect(r.lag).toBeUndefined();
            expect(r.laggedRows).toBeUndefined();
        }
    }, 30_000);

    it("fine-tuning nothing, keeps what the checkpoint's record says of how it was taught — its teacher, rows, lag and lagged rows — and refreshes what it measures", async (): Promise<void> => {
        library.saveProfile("fake-runner", { ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        mistaken = [];
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const first: DistillResult = await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, lag, workDir: path.join(root, "work-1") });
        const taught: Partial<DistillResult> = { teacher: "rules v2", teacherRows: first.teacherRows, daggerRows: first.daggerRows, lag, laggedRows: first.laggedRows };
        expect(first).toMatchObject(taught);
        expect(first.laggedRows?.teacher).toBeGreaterThan(0);
        const file: string = path.join(first.checkpoint, "distill.json");
        // Scores from before: a measurement refreshes them.
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), student: { mean: 7, scores: [7, 7], seeds: [1, 2] }, random: { mean: 0, scores: [0, 0] } }));

        // Resumed with no more rounds, with no lag and the engine teaching: it once erased the record's lag and lagged rows, and
        // said the engine taught the checkpoint the rules did (which `laya eval` then reported).
        const lines: string[] = [];
        const again: DistillResult = await distiller([], { engine: new FakeEngine(jumpWhenClose) }).distill({
            ...OPTIONS,
            minRows: 100,
            rounds: 0,
            resume: true,
            teacher: TeacherKind.ENGINE,
            workDir: path.join(root, "work-2"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        expect(again.checkpoint).toBe(first.checkpoint);
        const refreshed: Partial<DistillResult> = { ...taught, student: { mean: 30, scores: [30, 30], seeds: [1, 2] }, random: first.random, lagged: first.lagged };
        expect(first.random?.mean).toBeGreaterThan(0);
        expect(again).toMatchObject(refreshed);
        expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject(refreshed);
        // Measured as its record's teacher taught it: the rules.
        expect(lines.find((l: string): boolean => l.startsWith("Laya on the profile's seeds:"))).toContain("its teacher (rules v2) on the same games");

        // Resumed once more with another lag: its lagged games are this run's, the lag the checkpoint learnt stays.
        const other: { minMs: number; maxMs: number } = { minMs: 150, maxMs: 150 };
        const third: DistillResult = await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, resume: true, lag: other, workDir: path.join(root, "work-3") });
        expect(third).toMatchObject({ ...taught, lagged: { lag: other } });
        expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ ...taught, lagged: { lag: other } });
    }, 30_000);

    it("fine-tuning nothing on a checkpoint whose distillation recorded nothing, records no teacher rather than this run's", async (): Promise<void> => {
        // Fine-tuned, then stopped before its student was measured: no record.
        const profile: Profile = library.profile("fake-runner") as Profile;
        const dir: string = path.join(library.userDirFor("fake-runner"), "laya", `v${profile.version}-${profileHash(profile)}-r0`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "model.safetensors"), "x");
        writeFileSync(path.join(dir, "training.json"), "{}");
        const result: DistillResult = await distiller([], { engine: new FakeEngine(jumpWhenClose) }).distill({
            ...OPTIONS,
            rounds: 0,
            resume: true,
            teacher: TeacherKind.ENGINE,
            workDir: path.join(root, "work"),
        });
        expect(result).toMatchObject({ checkpoint: dir, teacher: "", student: { seeds: [1, 2] } });
        const record: Record<string, unknown> = JSON.parse(readFileSync(path.join(dir, "distill.json"), "utf-8"));
        expect(record.student).toEqual(result.student);
        expect(record).not.toHaveProperty("teacher");
        expect(record).not.toHaveProperty("teacherRows");
    });

    it("resumed after a run that stopped on agreement, its student plays games the DAgger rows do not hold: the same checkpoint once replayed them, the same rows twice", async (): Promise<void> => {
        mistaken = [];
        const played: Played[] = recordPlays();
        const studentSeeds = (): number[] => played.filter((p: Played): boolean => p.seed >= 1_000_000).map((p: Played): number => p.seed);
        const lines: string[] = [];
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 2, workDir: path.join(root, "work-1"), hooks: { onLog: (l: string): number => lines.push(l) } });
        expect(lines).toContain("  the student agrees with the teacher everywhere it went: no more DAgger rounds");
        const first: number[] = studentSeeds();
        expect(first.sort()).toEqual([1_000_000, 1_000_001]);
        played.length = 0;
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 2, resume: true, workDir: path.join(root, "work-2") });
        const second: number[] = studentSeeds();
        expect(second.length).toBeGreaterThan(0);
        expect(second.filter((s: number): boolean => first.includes(s))).toEqual([]);
        // The DAgger rows: each game's once.
        const profile: Profile = library.profile("fake-runner") as Profile;
        const dagger: Row[] = rowsIn(path.join(library.userDirFor("fake-runner"), "decisions", `v${profile.version}-${profileHash(profile)}.rules.dagger.jsonl`));
        expect([...new Set(dagger.map((r: Row): number => r.seed as number))].sort()).toEqual([...first, ...second].sort());
    }, 30_000);

    it("with a lag, judges what a batch of the teacher's adds by the kind it plays for: the paused states reused from before set no bar for its lagged games", async (): Promise<void> => {
        const v2: Profile = library.saveProfile("fake-runner", {
            ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }),
            results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        // Distilled paused before, with many more paused states than lagged ones are wanted.
        const reused: string = new DecisionLog(library, "fake-runner", v2, "rules v2", "rules").file;
        const row = (n: number): Record<string, unknown> => ({
            state: { reused: n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: { NOOP: 1, JUMP: 0 },
            confidence: 1,
            ms: 0,
            seed: 1,
        });
        writeFileSync(reused, `${Array.from({ length: 20_000 }, (_: unknown, n: number): string => JSON.stringify(row(n))).join("\n")}\n`);
        const lines: string[] = [];
        const result: DistillResult = await distiller([]).distill({
            ...OPTIONS,
            minRows: 1_200,
            rounds: 0,
            lag: { minMs: 45, maxMs: 60 },
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        // A lagged batch adds ~100 states: under 1 % of the 20,000 there, all of what its games labelled. It once stopped
        // after four batches, far short of the 600 lagged states wanted.
        expect(lines.filter((l: string): boolean => /almost no new states/.test(l))).toEqual([]);
        const made: RegExpExecArray = /^ {2}the teacher played (\d+) games, \1 of them with the lag: (\d+) of the \d+ distinct labelled states are made with it$/.exec(
            lines.find((l: string): boolean => l.startsWith("  the teacher played")) as string
        ) as RegExpExecArray;
        expect(Number(made[1])).toBeGreaterThan(8);
        expect(Number(made[2])).toBeGreaterThanOrEqual(600);
        expect(result.laggedRows?.teacher).toBeGreaterThanOrEqual(600);
    }, 60_000);

    it("stops the teacher's games once two batches in a row add almost nothing new of what they labelled, not at the first", async (): Promise<void> => {
        library.saveProfile("fake-runner", {
            ...fakeProfile({ teacher: "function teach() { return 'NOOP'; }", extractor: MARK_EXTRACTOR }),
            results: { mean: 10, scores: [10, 10], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        // Games 1–3 new marks, 4 one seen (nothing new), 5 new, 6 and 7 seen: two batches in a row with nothing new.
        const marks: Record<number, string> = { 10_000: "a", 10_001: "b", 10_002: "c", 10_003: "c", 10_004: "d", 10_005: "d", 10_006: "d", 10_007: "e" };
        const played: Played[] = recordPlays();
        const lines: string[] = [];
        await distiller([], { game: (): FakeGame => new MarkedGame((seed: number | undefined): string => marks[seed as number] ?? "z") }).distill({
            ...OPTIONS,
            minRows: 1_000,
            parallel: 1,
            rounds: 0,
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        // It once stopped after the fourth game, whose mark was seen: a single batch with nothing new.
        expect(played.filter((p: Played): boolean => p.seed >= 10_000 && p.seed < 1_000_000).map((p: Played): number => p.seed)).toEqual([10_000, 10_001, 10_002, 10_003, 10_004, 10_005, 10_006]);
        expect(lines).toContainEqual(
            expect.stringMatching(/^ {2}the teacher's games add almost no new states \(0 of the [1-9]\d* they labelled, and as few the batch before\): training goes ahead with 16$/)
        );
    }, 30_000);

    it("reads the rows files as streams, row by row — none whole: the counts are the same across chunk boundaries and characters of several bytes", async (): Promise<void> => {
        const v2: Profile = library.saveProfile("fake-runner", {
            ...fakeProfile({ teacher: RIGHT, extractor: LAG_EXTRACTOR }),
            results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" },
        } as never);
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        // Rows of every kind — paused, made with the lag, with another lag, a state repeated — whose states hold characters of
        // two to four bytes: somewhere a chunk of the stream ends inside one, and inside a row.
        const rows: Row[] = Array.from({ length: 40_000 }, (_: unknown, i: number): Row => ({
            state: { n: i % 25_000, text: "ü€😀".repeat(1 + (i % 5)) },
            choice: "NOOP",
            seed: 10_000 + Math.floor(i / 100),
            ...(i % 7 === 0 ? { lag } : i % 11 === 0 ? { lag: { minMs: 100, maxMs: 100 } } : {}),
        }));
        const data: string = new DecisionLog(library, "fake-runner", v2, "rules v2", "rules").file;
        writeFileSync(data, `${rows.map((r: Row): string => JSON.stringify({ ...r, criteria: { NOOP: "Keep running", JUMP: "Jump" }, probabilities: { NOOP: 1, JUMP: 0 } })).join("\n")}\n`);
        // What they hold, counted here: distinct states in all, of them those with a row made with the lag, and a paused one.
        const kinds: Map<string, { lagged: boolean; paused: boolean }> = new Map();
        for (const r of rows) {
            const k: { lagged: boolean; paused: boolean } = kinds.get(JSON.stringify(r.state)) ?? { lagged: false, paused: false };
            k.lagged ||= r.lag?.minMs === 45;
            k.paused ||= r.lag === undefined;
            kinds.set(JSON.stringify(r.state), k);
        }
        const count = (kind: "lagged" | "paused"): number => [...kinds.values()].filter((k: { lagged: boolean; paused: boolean }): boolean => k[kind]).length;
        const readWhole: jest.SpyInstance = jest.spyOn(fs, "readFileSync");
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const result: DistillResult = await distiller(tuned).distill({ ...OPTIONS, minRows: 1_000, rounds: 0, lag, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } });
        // Enough of both kinds: no teacher game, and the rows are counted as they are.
        expect(lines).toContain(`  ${kinds.size} distinct labelled states are there already, reused: ${count("lagged")} made with the lag, ${count("paused")} paused`);
        expect(lines).toContain("round 0: fine-tuning on 40000 teacher states");
        expect(tuned).toHaveLength(1);
        expect(result).toMatchObject({ teacherRows: 40_000, daggerRows: 0, laggedRows: { teacher: rows.filter((r: Row): boolean => r.lag?.minMs === 45).length, dagger: 0 } });
        // A student's visited states, relabelled: every one of them.
        const visited: string = path.join(root, "visited.jsonl");
        writeFileSync(visited, `${rows.slice(0, 20_000).map((r: Row): string => JSON.stringify({ ...r, criteria: { NOOP: "Keep running", JUMP: "Jump" } })).join("\n")}\n`);
        const relabelled: { added: number } = await (distiller([]) as any).relabel(visited, path.join(root, "dagger.jsonl"), async (): Promise<Record<string, number>> => ({ NOOP: 1, JUMP: 0 }), {
            ...OPTIONS,
            workDir: root,
        } as DistillOptions);
        expect(relabelled.added).toBe(20_000);
        // Never read into one string: past ~512 MiB (a real version's files reached 276.5 MB) that fails.
        expect(readWhole.mock.calls.filter((call: unknown[]): boolean => call[0] === data || call[0] === visited)).toEqual([]);
    }, 60_000);

    it("relabelling with an engine, takes its answer as the player takes one: naming an action not offered, or of no weight, it labels nothing and fails", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        const record = (n: number, lagged: boolean): Record<string, unknown> => ({
            state: { n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: {},
            confidence: 1,
            ms: 1,
            seed: lagged ? 2 : 1,
            ...(lagged ? { lag } : {}),
        });
        writeFileSync(visited, [record(0, false), record(1, true), record(2, true), record(3, true)].map((r: Record<string, unknown>): string => JSON.stringify(r)).join("\n"));
        const answers: Record<number, unknown> = {
            0: { choice: "JUMP", probabilities: { NOOP: 0.2, JUMP: 0.8 }, confidence: 0.8 },
            // An action not offered: it was written as the teacher's choice, a hard row.
            1: { choice: "DUCK", probabilities: { NOOP: 0, JUMP: 0, DUCK: 1 }, confidence: 1 },
            // No weight at all, and a key not offered: counted as labelled, and finetune.py dropped them.
            2: { choice: "NOOP", probabilities: { NOOP: 0, JUMP: 0 }, confidence: 0 },
            3: { choice: "NOOP", probabilities: { NOOP: 0.5, FOO: 0.5 }, confidence: 0.5 },
        };
        const engine: DecisionEngine = {
            kind: EngineKind.JEV,
            label: "fake",
            ask: async (state: unknown): Promise<SystemOneResponse> => ({ answers: { action: answers[(state as { game: { n: number } }).game.n] } }),
            health: async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "fake" }),
        };
        const taught: Distiller = distiller([], { engine });
        const relabelled: Record<string, unknown> = await (taught as any).relabel(visited, out, (taught as any).labeller(undefined), { ...OPTIONS, workDir: root } as DistillOptions);
        // The lagged game's three states failed: more than half of it, which refuses the run.
        expect(relabelled).toEqual({
            added: 1,
            disagreed: 1,
            failed: 3,
            firstFailure: "Invalid choice answer; no action executed",
            lagged: [{ seed: 2, states: 3, failed: 3, firstFailure: "Invalid choice answer; no action executed" }],
        });
        expect(rowsIn(out)).toEqual([expect.objectContaining({ state: { n: 0 }, choice: "JUMP", student: "NOOP" })]);
    });

    it("with an engine teaching and a lag, counts none of the engine's rows made with a lag as paused: a real-time play's are neither, a play's with the lag are made with it", async (): Promise<void> => {
        const v2: Profile = library.saveProfile("fake-runner", { ...fakeProfile({ extractor: LAG_EXTRACTOR }), results: { mean: 30, scores: [30, 30], seeds: [1, 2], gameSeconds: 3, measuredAt: "x" } } as never);
        const lag: { minMs: number; maxMs: number } = { minMs: 45, maxMs: 60 };
        // The engine's decisions as `ibgamer play` and the UI log them: a game in real time, then one with the lag simulated.
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v2, "fake");
        const engine: FakeEngine = new FakeEngine(jumpWhenClose);
        const game: GameDefinition = library.game("fake-runner");
        const hooks: { onDecision: (d: DecisionRecord) => void } = { onDecision: (d: DecisionRecord): void => log.append(d) };
        await new Player(new RealtimeFakeGame(), engine).play({ game, profile: v2, episodes: 1, gameSeconds: 1, seeds: [7], pace: Pace.REALTIME, hooks });
        const realtime: number = rowsIn(log.file).length;
        await new Player(new FakeGame(), engine).play({ game, profile: v2, episodes: 1, gameSeconds: 1, seeds: [8], pace: Pace.TURN, simulatedLag: lag, hooks });
        const logged: Row[] = rowsIn(log.file);
        expect(realtime).toBeGreaterThan(0);
        expect(logged.length).toBeGreaterThan(realtime);
        const lines: string[] = [];
        await distiller([], { engine }).distill({
            ...OPTIONS,
            teacher: TeacherKind.ENGINE,
            minRows: 20,
            rounds: 0,
            lag,
            workDir: path.join(root, "work"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        // Unmarked, every one of them once counted as paused.
        expect(lines).toContain(`  ${distinctStates(logged)} distinct labelled states are there already, reused: ${distinctStates(logged.slice(realtime))} made with the lag, 0 paused`);
    }, 30_000);

    /** From the `after`-th call on, appendFileSync writes `bytes` of its text and fails, as on a full disk. */
    function diskFullAfter(after: number, bytes: number): void {
        const append: typeof fs.appendFileSync = fs.appendFileSync;
        let calls: number = 0;
        jest.spyOn(fs, "appendFileSync").mockImplementation((target: fs.PathOrFileDescriptor, text: string | Uint8Array, options?: fs.WriteFileOptions): void => {
            if (++calls <= after) {
                append(target, text, options);
                return;
            }
            fs.writeSync(target as number, String(text).slice(0, bytes));
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        });
    }

    (process.getuid?.() === 0 ? it.skip : it)("fails the run with the error of a teacher's rows file that cannot be written: not as the teacher labelling nothing", async (): Promise<void> => {
        const file: string = new DecisionLog(library, "fake-runner", library.profile("fake-runner") as Profile, "rules v1", "rules").file;
        writeFileSync(file, "");
        chmodSync(file, 0o444);
        const tuned: Tuned[] = [];
        const lines: string[] = [];
        const error: unknown = await distiller(tuned)
            .distill({ ...OPTIONS, rounds: 0, workDir: path.join(root, "work"), hooks: { onLog: (l: string): number => lines.push(l) } })
            .catch((err: unknown): unknown => err);
        chmodSync(file, 0o644);
        // Swallowed, its games once labelled "0 distinct labelled states" four batches long, and the run was refused blaming the teacher.
        expect((error as Error).message).toBe(`a row could not be written to ${file}: EACCES: permission denied, open '${file}'`);
        expect(lines.filter((l: string): boolean => l.startsWith("teacher games"))).toEqual([]);
        expect(tuned).toHaveLength(0);
    });

    it("fails the run when a teacher's row cannot be written whole (a full disk), and leaves the rows written whole", async (): Promise<void> => {
        diskFullAfter(30, 40);
        const tuned: Tuned[] = [];
        const error: unknown = await distiller(tuned)
            .distill({ ...OPTIONS, parallel: 1, rounds: 0, workDir: path.join(root, "work") })
            .catch((err: unknown): unknown => err);
        jest.restoreAllMocks();
        const file: string = new DecisionLog(library, "fake-runner", library.profile("fake-runner") as Profile, "rules v1", "rules").file;
        expect((error as Error).message).toBe(`a row could not be written to ${file}: ENOSPC: no space left on device, write`);
        expect(tuned).toHaveLength(0);
        // No row cut short, which every later read of the version once failed on: the thirty written, each whole.
        expect(rowsIn(file)).toHaveLength(30);
        expect(readFileSync(file, "utf-8").endsWith("}\n")).toBe(true);
    });

    it("relabelling, stops at a row it cannot write whole — no state the teacher failed on — and leaves the rows written whole", async (): Promise<void> => {
        const visited: string = path.join(root, "visited.jsonl");
        const out: string = path.join(root, "dagger.jsonl");
        const record = (n: number): Record<string, unknown> => ({
            state: { n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: {},
            confidence: 1,
            ms: 1,
            seed: 1_000_000,
        });
        writeFileSync(visited, Array.from({ length: 40 }, (_: unknown, n: number): string => JSON.stringify(record(n))).join("\n"));
        diskFullAfter(5, 20);
        const error: unknown = await (distiller([]) as any)
            .relabel(visited, out, async (): Promise<Record<string, number>> => ({ NOOP: 1, JUMP: 0 }), { ...OPTIONS, workDir: root } as DistillOptions)
            .catch((err: unknown): unknown => err);
        jest.restoreAllMocks();
        expect((error as Error).message).toBe(`a row could not be written to ${out}: ENOSPC: no space left on device, write`);
        expect(rowsIn(out)).toHaveLength(5);
    });

    it("skips a row cut short in its rows files — the last line, or one the next row went on after —, saying so once a run, naming the file: a later distillation goes on", async (): Promise<void> => {
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 0, workDir: path.join(root, "work-1") });
        const profile: Profile = library.profile("fake-runner") as Profile;
        const file: string = path.join(library.userDirFor("fake-runner"), "decisions", `v${profile.version}-${profileHash(profile)}.rules.jsonl`);
        const whole: number = rowsIn(file).length;
        // A row cut short (a write that failed part of the way, before a failed append was cut back), the file's last line.
        appendFileSync(file, '{"state":{"dx":12,"air":fal');
        const said = (log: string[]): string[] => log.filter((l: string): boolean => l.includes(" no row "));
        // Resumed: it once failed at the start with a bare SyntaxError, naming no file — as did every later distillation.
        const lines: string[] = [];
        const tuned: Tuned[] = [];
        const resumed: DistillResult = await distiller(tuned).distill({
            ...OPTIONS,
            minRows: 100,
            resume: true,
            workDir: path.join(root, "work-2"),
            hooks: { onLog: (l: string): number => lines.push(l) },
        });
        expect(tuned).toHaveLength(1);
        expect(resumed.teacherRows).toBe(whole);
        expect(said(lines)).toEqual([`  skipped 1 line of ${file} that is no row (the first: Unexpected end of JSON input) — a row cut short by a write that failed`]);
        // Afresh, wanting more: the teacher's first row went on after that row's bytes, on its line — one in the middle now.
        const again: string[] = [];
        const fresh: Tuned[] = [];
        const result: DistillResult = await distiller(fresh).distill({
            ...OPTIONS,
            minRows: 300,
            rounds: 0,
            workDir: path.join(root, "work-3"),
            hooks: { onLog: (l: string): number => again.push(l) },
        });
        const lastLines: string[] = readFileSync(file, "utf-8").split("\n");
        const torn: number = lastLines.findIndex((l: string): boolean => l.startsWith('{"state":{"dx":12,"air":fal{'));
        expect(torn).toBeGreaterThan(0);
        expect(torn).toBeLessThan(lastLines.length - 2);
        expect(result.teacherRows).toBe(lastLines.length - 2);
        expect(said(again)).toEqual([expect.stringMatching(new RegExp(`^ {2}skipped 1 line of ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} that is no row \\(the first: .+\\) — a row cut short by a write that failed$`))]);
    }, 30_000);

    it("takes the teacher's seeds and the students' from ranges that never meet, past the rows from before: no student's game plays a teacher game's layout", async (): Promise<void> => {
        const data: string = new DecisionLog(library, "fake-runner", library.profile("fake-runner") as Profile, "rules v1", "rules").file;
        const row = (seed: number, n: number, student?: string): Record<string, unknown> => ({
            state: { before: n },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "NOOP",
            probabilities: { NOOP: 1, JUMP: 0 },
            confidence: 1,
            ms: 0,
            seed,
            ...(student ? { student } : {}),
        });
        // Rows from before the ranges were apart: the teacher's 10,000 (seeds 10,000–10,099, a hundred rows a game), and a
        // DAgger round's two student games then (20,000, 20,001). The teacher's next games took 10,000 + the rows there were.
        writeFileSync(data, `${Array.from({ length: 10_000 }, (_: unknown, i: number): string => JSON.stringify(row(10_000 + Math.floor(i / 100), i % 50))).join("\n")}\n`);
        const dagger: string = data.replace(/\.jsonl$/, ".dagger.jsonl");
        writeFileSync(dagger, `${[20_000, 20_001].map((s: number, i: number): string => JSON.stringify(row(s, 100 + i, "JUMP"))).join("\n")}\n`);
        const played: Played[] = recordPlays();
        await distiller([]).distill({ ...OPTIONS, minRows: 100, rounds: 1, workDir: path.join(root, "work") });
        // Games of the profile's own seeds (1, 2) are neither.
        const teacherSeeds: number[] = played
            .filter((p: Played): boolean => p.engine.kind === EngineKind.RULES && p.engine.label !== "random" && p.seed > 2)
            .map((p: Played): number => p.seed);
        const studentSeeds: number[] = played.filter((p: Played): boolean => p.engine.kind === EngineKind.LAYA && p.seed > 2).map((p: Played): number => p.seed);
        // The teacher's: the lowest seeds of its range no row holds — they once were 20,000 and 20,001, the students' games of before.
        expect(teacherSeeds.slice(0, 2)).toEqual([10_100, 10_101]);
        expect(teacherSeeds.every((s: number): boolean => s >= 10_000 && s < 1_000_000)).toBe(true);
        expect(studentSeeds.sort()).toEqual([1_000_000, 1_000_001]);
        // No game's seed is both a teacher's and a student's: finetune.py holds out whole games of the teacher's to validate on.
        const teacher: Set<number> = new Set(rowsIn(data).map((r: Row): number => r.seed as number));
        expect(rowsIn(dagger).filter((r: Row): boolean => teacher.has(r.seed as number))).toEqual([]);
    }, 30_000);

    it("with an engine teaching, takes the students' seeds after the plays its log holds too, whatever their seeds", async (): Promise<void> => {
        const v1: Profile = library.profile("fake-runner") as Profile;
        const engine: FakeEngine = new FakeEngine(jumpWhenClose);
        // A play the engine logged, on a seed of the students' range.
        const log: DecisionLog = new DecisionLog(library, "fake-runner", v1, engine.label);
        await new Player(new FakeGame(), engine).play({
            game: library.game("fake-runner"),
            profile: v1,
            episodes: 1,
            gameSeconds: 1,
            seeds: [1_000_005],
            pace: Pace.TURN,
            hooks: { onDecision: (d: DecisionRecord): void => log.append(d) },
        });
        const played: Played[] = recordPlays();
        // More states wanted than the play holds: the teacher plays too.
        await distiller([], { engine }).distill({ ...OPTIONS, teacher: TeacherKind.ENGINE, minRows: 200, rounds: 1, workDir: path.join(root, "work") });
        const teacherSeeds: number[] = played.filter((p: Played): boolean => p.engine === engine && p.seed > 2).map((p: Played): number => p.seed);
        expect(teacherSeeds.length).toBeGreaterThan(0);
        expect(teacherSeeds.every((s: number): boolean => s >= 10_000 && s < 1_000_000)).toBe(true);
        expect(played.filter((p: Played): boolean => p.engine.kind === EngineKind.LAYA && p.seed > 2).map((p: Played): number => p.seed).sort()).toEqual([1_000_006, 1_000_007]);
    }, 30_000);
});
