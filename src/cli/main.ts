#!/usr/bin/env node
/**
 * The `ibgamer` CLI: play a game from the library, train its profile, manage
 * the library, or open the web UI.
 *
 * Configuration comes from the environment (and a `.env` in the working
 * directory); flags override it per command.
 */

import { GamerConfig, layaVenvPython, loadConfig, loadDotEnv } from "../config/config";
import { DevtoolsClient, GameBrowser } from "../devtools/client";
import { DaemonHandle, ensureDaemon, freePort } from "../devtools/daemon";
import { Adapter, ProbeResult } from "../devtools/protocol";
import { createEngine, DecisionEngine, EngineHealth, EngineKind } from "../engine";
import { offeredConfig } from "../game/configs";
import { GameDefinition, PlanConfig, PlayConfig, Profile, ProfileResults } from "../game/types";
import { MAX_EPISODES } from "../game/validate";
import { defaultBuiltInDir, GameSummary, Library, ProfileSummary } from "../library/store";
import { DecisionRecord, EpisodeResult, Pace, PlayResult, TickEvent } from "../play/player";
import { Distiller, DistillResult, TeacherKind } from "../distill/distiller";
import { RulesTeacher } from "../distill/teacher";
import { askClaude, trainerHealth } from "../train/claude";
import { checkpointFor, checkpointProfileVersion, checkpointsToServe, currentCheckpoints, LayaServers, LayaSetup } from "../distill/laya-play";
import { checkLayaPython, LayaCheckpoint, layaCheckpoints, layaPortLockFile, layaScriptsDir, LayaServerHandle, refuseHeldLayaPort, startLayaServer } from "../distill/laya-runtime";
import { DecisionLog } from "../run/decision-log";
import { checkReplay, CheckResult } from "../run/check";
import { measureVersion } from "../run/measure";
import { customScriptOf, playGame } from "../run/play";
import { startUiServer, UiServerHandle } from "../server/ui-server";
import { Decider, Trainer, TrainResult } from "../train/trainer";

import { ChildProcess, spawn } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { Command, InvalidArgumentError } from "commander";

/** A whole number written as one (digits, a sign): not blank — Number("") is 0 —, no fraction, exponent or hex. */
function int(name: string, min: number, max: number): (value: string) => number {
    return (value: string): number => {
        const n: number = /^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN;
        if (!Number.isInteger(n) || n < min || n > max) {
            throw new InvalidArgumentError(`${name} must be a whole number in [${min}, ${max}]`);
        }
        return n;
    };
}

/** A number, a fraction too: above 0, or 0 and up when `zero` is allowed. */
function amount(name: string, zero: boolean = false): (value: string) => number {
    return (value: string): number => {
        const n: number = value.trim() === "" ? NaN : Number(value);
        if (!Number.isFinite(n) || n < 0 || (n === 0 && !zero)) {
            throw new InvalidArgumentError(`${name} must be a number ${zero ? "of 0 or more" : "above 0"}`);
        }
        return n;
    };
}

/** `35` (a fixed latency) or `250-600` (a range: each game somewhere in it, drifting). */
function latencyRange(value: string): { minMs: number; maxMs: number } {
    const m: RegExpExecArray | null = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
    const minMs: number = m ? Number(m[1]) : NaN;
    const maxMs: number = m && m[2] !== undefined ? Number(m[2]) : minMs;
    if (!m || minMs > maxMs || maxMs > 2_000) {
        throw new InvalidArgumentError("latency is ms (35) or a range of ms (250-600), at most 2000");
    }
    return { minMs, maxMs };
}

function planConfig(value: string): PlanConfig {
    const m: RegExpExecArray | null = /^(\d+)x(\d+)$/.exec(value.trim());
    const slots: number = m ? Number(m[1]) : NaN;
    const slotMs: number = m ? Number(m[2]) : NaN;
    if (!m || slots < 2 || slots > 16 || slotMs < 10 || slotMs > 1_000) {
        throw new InvalidArgumentError("plan is <moments>x<ms>, e.g. 8x50 (2–16 moments, 10–1000 ms apart)");
    }
    return { slots, slotMs };
}

function engineKind(value: string): EngineKind {
    if (!Object.values(EngineKind).includes(value as EngineKind)) {
        throw new InvalidArgumentError(`engine must be one of ${Object.values(EngineKind).join(", ")}`);
    }
    return value as EngineKind;
}

function library(config: GamerConfig): Library {
    return new Library(defaultBuiltInDir(), config.libraryDir);
}

/**
 * A daemon for this command: the configured one, else one of its own on a free port — two commands
 * running at once must not share one, or the first to finish stops it under the other.
 */
async function startDaemon(config: GamerConfig, headed: boolean | undefined): Promise<DaemonHandle> {
    return ensureDaemon({
        ...(config.daemon.url ? { url: config.daemon.url } : {}),
        // Training has long stretches without a browser session (a tuner call, a fine-tuning), and the daemon
        // looks for sessions only at its checks: it exits after two checks that found none, whatever ran between
        // them. At hourly checks a two-hour real-time training lost its daemon in its last tuner call. This
        // process stops the daemon it started when it ends; the checks only bound one it leaves behind.
        idleCheckSeconds: 21_600,
        port: config.daemon.url ? config.daemon.port : await freePort(),
        headless: headed === true ? false : config.daemon.headless,
        ...(config.daemon.script ? { daemonScript: config.daemon.script } : {}),
    });
}

async function requireEngine(engine: DecisionEngine): Promise<void> {
    const health: EngineHealth = await engine.health();
    if (!health.ok) {
        throw new Error(`${engine.label}: ${health.detail}`);
    }
}

function printEpisode(e: EpisodeResult): void {
    console.log(
        `  episode ${e.episode}${e.seed !== undefined ? ` (seed ${e.seed})` : ""}: score ${e.score} in ${e.gameSeconds} s of game time — ${e.over ? "game over" : "budget reached"}; ` +
            `${e.decisions} decisions (median ${e.engineMedianMs ?? "?"} ms)${e.extractErrors ? `, ${e.extractErrors} extractor errors` : ""}`
    );
}

const program: Command = new Command();
program.name("ibgamer").description("Plays browser games live with a fast decision engine; an LLM trains each game's profile.");

program
    .command("ui")
    .description("Open the web UI: the library, live play, training")
    .option("--port <port>", "port", int("port", 1, 65_535))
    .option("--host <host>", "address to bind (default 127.0.0.1)")
    .option("--headed", "show the browser window")
    .action(async (opts: { port?: number; host?: string; headed?: boolean }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const handle: UiServerHandle = await startUiServer({
            ...config,
            ui: { host: opts.host ?? config.ui.host, port: opts.port ?? config.ui.port },
            daemon: { ...config.daemon, headless: opts.headed ? false : config.daemon.headless },
        });
        console.log(`IronBee Gamer UI: ${handle.url}`);
        const stop: () => void = (): void => {
            void handle.close().finally((): never => process.exit(0));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });

program
    .command("play")
    .description("Play a game from the library with its active profile, or the version its config for that engine and clock names (or --profile-version)")
    .argument("<game>", "game id (see: ibgamer library list)")
    .option("--profile-version <n>", "the profile version to play", int("version", 1, 1_000_000))
    .option("--episodes <n>", "games to play", int("episodes", 1, MAX_EPISODES))
    .option("--seconds <n>", "game time per episode", int("seconds", 1, 3_600))
    .option("--seed <n>", "seed the game's randomness", int("seed", 0, 2_147_483_646))
    .option("--watch", "never faster than the game's own speed (for watching)")
    .option("--realtime", "the game's clock is not frozen: it does not wait for decisions")
    .option("--engine <kind>", `decision engine: ${Object.values(EngineKind).join(" | ")}`, engineKind)
    .option("--record <dir>", "record a video into this directory")
    .option("--headed", "show the browser window")
    .option("--verbose", "print every decision")
    .option("--no-log-decisions", "do not keep the engine's decisions as distillation data")
    .option("--plan-every <ms>", "real time, a profile that plans: a new request at least this often, several in flight (reacts sooner, asks more)", int("ms", 20, 5_000))
    .option("--lag <ms>", "real time simulated on the paused clock: each decision lands this late (ms, or a range 30-45) in game time — the same result every run", latencyRange)
    .action(
        async (
            gameId: string,
            opts: {
                profileVersion?: number;
                episodes?: number;
                seconds?: number;
                seed?: number;
                watch?: boolean;
                realtime?: boolean;
                engine?: EngineKind;
                record?: string;
                headed?: boolean;
                verbose?: boolean;
                logDecisions: boolean;
                planEvery?: number;
                lag?: { minMs: number; maxMs: number };
            }
        ): Promise<void> => {
            const config: GamerConfig = loadConfig();
            const lib: Library = library(config);
            const game: GameDefinition = lib.game(gameId);
            const kind: EngineKind = opts.engine ?? config.engine.kind;
            // As the game's config for this engine and clock plays it (the CLI is not held to the configs): its
            // version unless one is named, and in real time its lag floor.
            const played: PlayConfig | undefined = game.configs ? offeredConfig(game, kind, opts.realtime === true) : undefined;
            const version: number | undefined = opts.profileVersion ?? played?.version;
            const minLagMs: number | undefined = opts.realtime ? played?.lagMs : undefined;
            // Laya plays with the game's fine-tuned checkpoint for the version (the active one's when none is
            // named), served here, and the profile it learned.
            const layaServers: LayaServers | undefined =
                kind === EngineKind.LAYA && !process.env.LAYA_MODEL ? new LayaServers(lib, config.layaRuntime.python, config.layaRuntime.port) : undefined;
            // What starts from here (the Laya server, the daemon, the browser) is stopped however the play ends: a
            // refusal before the first game (no profile, an engine not ready) too — a Laya server left on its port
            // would refuse the next play of another checkpoint.
            let daemon: DaemonHandle | undefined;
            let browser: DevtoolsClient | undefined;
            try {
                const laya: LayaSetup | undefined = layaServers ? await layaServers.engineFor(gameId, version) : undefined;
                const profile: Profile | undefined = lib.profile(gameId, version ?? laya?.profileVersion);
                if (!profile) {
                    throw new Error(`${game.name} has no profile yet: ibgamer train ${gameId}`);
                }
                if (kind === EngineKind.RULES && !profile.teacher) {
                    throw new Error(`${game.name} v${profile.version} has no rules as code: ibgamer train ${gameId} --decider rules`);
                }
                // The rules engine plays the chosen version's own rules, instant.
                const engine: DecisionEngine = laya?.engine ?? (kind === EngineKind.RULES ? new RulesTeacher(profile) : createEngine({ ...config.engine, kind }));
                await requireEngine(engine);
                daemon = await startDaemon(config, opts.headed);
                browser = new DevtoolsClient({ baseUrl: daemon.baseUrl });
                const abort: AbortController = new AbortController();
                process.once("SIGINT", (): void => abort.abort());
                const log: DecisionLog | undefined = opts.logDecisions && engine.kind === EngineKind.JEV ? new DecisionLog(lib, gameId, profile, engine.label) : undefined;
                // Plan mode (a profile with `plan`, in real time) asks for plans: none of its answers is a decision row.
                const plans: boolean = opts.realtime === true && profile.plan !== undefined;
                console.log(`${game.name}: profile v${profile.version}, ${engine.label}${log ? (plans ? " — plans are not kept as decisions" : ` — decisions kept in ${log.file}`) : ""}`);
                const result: PlayResult = await playGame(browser, engine, lib, {
                    game,
                    profile,
                    episodes: opts.episodes ?? game.budgets.episodes,
                    gameSeconds: opts.seconds ?? game.budgets.gameSeconds,
                    ...(opts.seed !== undefined ? { seeds: [opts.seed] } : {}),
                    pace: opts.realtime ? Pace.REALTIME : opts.watch ? Pace.WATCH : Pace.TURN,
                    ...(minLagMs !== undefined ? { minLagMs } : {}),
                    ...(opts.planEvery !== undefined ? { planEveryMs: opts.planEvery } : {}),
                    ...(opts.lag && !opts.realtime ? { simulatedLag: opts.lag } : {}),
                    ...(opts.record ? { recordDir: path.resolve(opts.record) } : {}),
                    signal: abort.signal,
                    hooks: {
                        onEpisodeEnd: printEpisode,
                        ...(log ? { onDecision: (d: DecisionRecord): void => log.append(d) } : {}),
                        ...(opts.verbose
                            ? {
                                onTick: (e: TickEvent): void => {
                                    console.log(`    t=${e.t} ${(e.gameMs / 1000).toFixed(2)}s ${e.asked ? e.choice : `(${e.choice})`} score ${e.score} ${JSON.stringify(e.state).slice(0, 160)}`);
                                },
                            }
                            : {}),
                    },
                });
                console.log(`mean score ${result.mean.toFixed(1)} over ${result.episodes.length} episode(s)${result.videoPath ? ` — video: ${result.videoPath}` : ""}`);
            } finally {
                await browser?.close();
                await daemon?.stop();
                await layaServers?.stop();
            }
        }
    );

program
    .command("train")
    .description("Train a game's profile: play, let the trainer (Claude Code) rewrite it, keep a version only when it scores higher")
    .argument("<game>", "game id")
    .option("--iterations <n>", "tuning iterations", int("iterations", 1, 50), 3)
    .option("--seconds <n>", "game time per training game", int("seconds", 1, 3_600))
    .option("--seeds <list>", "comma-separated seeds every version is compared on")
    .option("--sequential", "play an evaluation's games one after another (default: at once)")
    .option("--decider <kind>", "what decides while training: engine (Jev reads the instructions) | rules (the profile's teach(state), instant; distil Laya afterwards)", "engine")
    .option("--engine <kind>", `decision engine: ${Object.values(EngineKind).join(" | ")}`, engineKind)
    .option("--work <dir>", "where the trainer's files go (default: a temporary directory)")
    .option("--from <version>", "the version to start from (default: the active one; the versions kept are then not made active)", int("version", 1, 1_000_000))
    .option("--realtime", "play every training game with the clock never paused, for real-time play (with --decider rules: the rules answer --latency late)")
    .option(
        "--latency <ms>",
        "real time with --decider rules: how late the rules answer, as the engine that will play does — ms (35) or a range (250-600: each game somewhere in it, drifting) (default 30)",
        latencyRange
    )
    .option("--simulated", "with --realtime: simulate it on the paused clock — each decision lands --latency after its frame in game time — so every run gives the same result")
    .option("--plan <n>x<ms>", "with --realtime, for a slow engine: one request decides the next n moments, ms apart (e.g. 8x50)", planConfig)
    .option("--headed", "show the browser windows")
    .action(
        async (
            gameId: string,
            opts: {
                iterations: number;
                seconds?: number;
                seeds?: string;
                sequential?: boolean;
                decider: string;
                engine?: EngineKind;
                work?: string;
                headed?: boolean;
                realtime?: boolean;
                latency?: { minMs: number; maxMs: number };
                plan?: PlanConfig;
                simulated?: boolean;
                from?: number;
            }
        ): Promise<void> => {
            const config: GamerConfig = loadConfig();
            const lib: Library = library(config);
            lib.game(gameId);
            if (!Object.values(Decider).includes(opts.decider as Decider)) {
                throw new Error(`--decider is ${Object.values(Decider).join(" or ")}`);
            }
            const decider: Decider = opts.decider as Decider;
            if ((opts.engine ?? EngineKind.JEV) !== EngineKind.JEV) {
                throw new Error("Training tunes the rules an engine reads (Jev), or the rules as code (--decider rules). Laya learns them with: ibgamer laya distill");
            }
            // Read before the daemon starts: a bad --seeds must not leave one behind (with its 6-hour checks).
            const seeds: number[] | undefined = opts.seeds
                ?.split(",")
                .map((s: string): number => int("seed", 0, 2_147_483_646)(s.trim()));
            // Without its CLI a training would play every measuring game (each move Jev's, unless the rules decide), then
            // fail each tuning: refused before anything starts, as the UI refuses it.
            const trainer: { ok: boolean; detail: string } = trainerHealth(config.claude);
            if (!trainer.ok) {
                throw new Error(`The trainer is not ready: ${trainer.detail}`);
            }
            const engine: DecisionEngine = createEngine({ ...config.engine, kind: EngineKind.JEV });
            if (decider === Decider.ENGINE) {
                await requireEngine(engine);
            }
            const workDir: string = opts.work ? path.resolve(opts.work) : mkdtempSync(path.join(tmpdir(), `ibgamer-train-${gameId}-`));
            const daemon: DaemonHandle = await startDaemon(config, opts.headed);
            const browsers: DevtoolsClient[] = [];
            const abort: AbortController = new AbortController();
            process.once("SIGINT", (): void => abort.abort());
            console.log(
                `training ${gameId}: ${decider === Decider.RULES ? "the profile's rules (teach) play" : `${engine.label} plays`}${opts.realtime ? ", in real time" : ""}${opts.plan ? `, in plans of ${opts.plan.slots} × ${opts.plan.slotMs} ms` : ""}; trainer files in ${workDir}`
            );
            try {
                const result: TrainResult = await new Trainer({
                    library: lib,
                    engine,
                    openBrowser: (): GameBrowser => {
                        const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
                        browsers.push(browser);
                        return browser;
                    },
                    trainer: config.claude,
                }).train({
                    gameId,
                    decider,
                    iterations: opts.iterations,
                    ...(opts.seconds !== undefined ? { gameSeconds: opts.seconds } : {}),
                    ...(seeds ? { seeds } : {}),
                    parallel: !opts.sequential,
                    ...(opts.realtime ? { realtime: true } : {}),
                    ...(opts.latency !== undefined ? { latency: opts.latency } : {}),
                    ...(opts.plan ? { plan: opts.plan } : {}),
                    ...(opts.simulated ? { simulated: true } : {}),
                    ...(opts.from !== undefined ? { fromVersion: opts.from } : {}),
                    workDir,
                    signal: abort.signal,
                    hooks: {
                        onLog: (line: string): void => console.log(line),
                    },
                });
                console.log(
                    result.savedVersions.length
                        ? `saved ${result.savedVersions.map((v: number): string => `v${v}`).join(", ")}; best: v${result.bestVersion} (mean ${result.bestMean?.toFixed(1)}); active: v${lib.activeVersion(gameId)}`
                        : `no new version beat v${result.bestVersion}`
                );
            } finally {
                await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
                await daemon.stop();
            }
        }
    );

program
    .command("probe")
    .description("Which rendering tech and engine a game page uses, and the perception adapter that fits")
    .argument("<url>", "the game page")
    .option("--headed", "show the browser window")
    .action(async (url: string, opts: { headed?: boolean }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const daemon: DaemonHandle = await startDaemon(config, opts.headed);
        const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
        try {
            await browser.open({ url, adapters: [Adapter.PROBE], freezeClock: false, bootMs: 4_000 });
            const probe: ProbeResult = await browser.probe();
            console.log(JSON.stringify(probe, null, 2));
        } finally {
            await browser.close();
            await daemon.stop();
        }
    });

program
    .command("measure")
    .description("Measure a version again, as training records it: its rules on the training seeds, on the unseen ones, random play, real time simulated at its lag — and save it")
    .argument("<game>", "game id")
    .option("--profile-version <n>", "the version (default: the active one)", int("version", 1, 1_000_000))
    .option("--headed", "show the browser windows")
    .action(async (gameId: string, opts: { profileVersion?: number; headed?: boolean }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const lib: Library = library(config);
        const game: GameDefinition = lib.game(gameId);
        const profile: Profile | undefined = lib.profile(gameId, opts.profileVersion);
        if (!profile) {
            throw new Error(`${game.name} has no profile yet: ibgamer train ${gameId}`);
        }
        const daemon: DaemonHandle = await startDaemon(config, opts.headed);
        try {
            const customScript: string | undefined = customScriptOf(lib, { game });
            const before: ProfileResults | undefined = profile.results;
            const results: ProfileResults = await measureVersion((): GameBrowser => new DevtoolsClient({ baseUrl: daemon.baseUrl }), game, profile, customScript ? { customScript } : {});
            lib.saveResults(gameId, profile.version, results);
            const part: (label: string, m: { mean: number; scores: number[] } | undefined) => string = (label: string, m: { mean: number; scores: number[] } | undefined): string =>
                m ? `, ${label} ${m.mean} [${m.scores.join(", ")}]` : "";
            const line: (r: ProfileResults | undefined) => string = (r: ProfileResults | undefined): string =>
                r
                    ? `${r.mean} [${r.scores.join(", ")}]${part("real time", r.realtime)}${r.realtime ? ` at ${r.realtime.lagMs ?? "?"} ms` : ""}` +
                      `${part("real time on unseen seeds", r.realtime?.test)}${part("unseen seeds", r.test)}${part("random", r.random)}`
                    : "not measured";
            console.log(`${game.name} v${profile.version}\n  before: ${line(before)}\n  now:    ${line(results)}`);
        } finally {
            await daemon.stop();
        }
    });

program
    .command("check")
    .description("Does a game replay? The same seed played twice, the profile's rules deciding: the first frame that differs, and where")
    .argument("<game>", "game id")
    .option("--seed <n>", "the seed", int("seed", 0, 2_147_483_646), 101)
    .option("--seconds <n>", "game time of each play", int("seconds", 1, 600), 20)
    .option("--profile-version <n>", "the profile whose rules decide (default: the active one)", int("version", 1, 1_000_000))
    .option("--parallel", "both plays at the same time, as training's evaluations play (default: one after the other)")
    .option("--headed", "show the browser windows")
    .action(async (gameId: string, opts: { seed: number; seconds: number; profileVersion?: number; parallel?: boolean; headed?: boolean }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const lib: Library = library(config);
        const game: GameDefinition = lib.game(gameId);
        const profile: Profile | undefined = lib.profile(gameId, opts.profileVersion);
        const daemon: DaemonHandle = await startDaemon(config, opts.headed);
        try {
            const customScript: string | undefined = customScriptOf(lib, { game });
            const result: CheckResult = await checkReplay((): GameBrowser => new DevtoolsClient({ baseUrl: daemon.baseUrl }), game, profile, {
                seed: opts.seed,
                gameSeconds: opts.seconds,
                ...(opts.parallel ? { parallel: true } : {}),
                ...(customScript ? { customScript } : {}),
            });
            const how: string = `${game.name}${profile ? ` v${profile.version}${profile.teacher ? ", its rules deciding" : ", the idle action"}` : ", no input"}, seed ${opts.seed}, ${opts.parallel ? "both at once" : "one after the other"}`;
            if (result.diverged) {
                const d: NonNullable<CheckResult["diverged"]> = result.diverged;
                console.log(`${how}: DIFFERENT from frame ${d.frame} (${(d.gameMs / 1000).toFixed(2)} s): ${d.where}${d.choices?.[0] !== undefined ? ` — after ${d.choices[0]} / ${d.choices[1]}` : ""}`);
                process.exitCode = 1;
            } else {
                console.log(`${how}: the same for all ${result.frames} frames`);
            }
            console.log(`  ends: ${result.ends[0]} | ${result.ends[1]}`);
        } finally {
            await daemon.stop();
        }
    });

const layaCommand: Command = program.command("laya").description("Local Laya: distil a game's decisions into a checkpoint that plays it in tens of milliseconds");

layaCommand
    .command("distill")
    .description("The trainer's rules teach Laya: the teacher plays (labelled states) → fine-tune → DAgger rounds → Laya plays the profile's seeds")
    .argument("<game>", "game id")
    .option("--teacher <kind>", "rules: the profile's teach(state), written by the trainer when missing | engine: Jev reads the instructions", "rules")
    .option("--profile-version <n>", "the version Laya learns (default: the active one)", int("version", 1, 1_000_000))
    .option("--min-rows <n>", "teacher decisions wanted before training", int("rows", 100, 1_000_000), 12_000)
    .option("--seconds <n>", "game time of a teacher / student game", int("seconds", 5, 3_600))
    .option("--parallel <n>", "games at once", int("parallel", 1, 8), 2)
    .option("--rounds <n>", "DAgger rounds", int("rounds", 0, 10), 1)
    .option("--resume", "go on from the profile's latest checkpoint: --rounds more DAgger rounds, kept only if it plays better")
    .option("--student-games <n>", "Laya games per DAgger round", int("games", 1, 32), 4)
    .option("--epochs <n>", "fine-tuning epochs of the first training", amount("epochs"), 1)
    .option("--round-epochs <n>", "epochs of a DAgger round (it continues from the round before)", amount("round epochs"))
    .option("--base <checkpoint>", "Laya checkpoint to start from (english | multilingual | a directory)", "multilingual")
    .option("--device <device>", "mps | cuda | cpu (default: the best there is)")
    .option("--pause <seconds>", "rest after each fine-tuning step: 0 is fastest, more keeps the machine usable", amount("pause", true), 0.25)
    .option(
        "--lag <ms>",
        "for a lag-aware version: half the teacher's labelled states and half the student's games come from games simulating real time on the paused clock, each decision landing this late (ms, or a range 45-60) in game time; the profile's seeds are played paused, then once more with the lag",
        latencyRange
    )
    .option("--work <dir>", "where the student's visited states go (default: a temporary directory)")
    .action(
        async (
            gameId: string,
            opts: {
                teacher: string;
                profileVersion?: number;
                minRows: number;
                seconds?: number;
                parallel: number;
                rounds: number;
                resume?: boolean;
                studentGames: number;
                epochs: number;
                roundEpochs?: number;
                base: string;
                device?: string;
                pause: number;
                lag?: { minMs: number; maxMs: number };
                work?: string;
            }
        ): Promise<void> => {
            const config: GamerConfig = loadConfig();
            const lib: Library = library(config);
            const game: GameDefinition = lib.game(gameId);
            const python: { ok: boolean; detail: string } = await checkLayaPython(config.layaRuntime.python);
            if (!python.ok) {
                throw new Error(`${python.detail} (or point IBGAMER_LAYA_PYTHON at a Python that has it)`);
            }
            if (!Object.values(TeacherKind).includes(opts.teacher as TeacherKind)) {
                throw new Error(`--teacher is ${Object.values(TeacherKind).join(" or ")}`);
            }
            const teacherKind: TeacherKind = opts.teacher as TeacherKind;
            // A version without its rules as code has the trainer write them first (a resume of one is refused instead):
            // without its CLI the run would stop there, after the daemon started — refused before it, as the UI refuses it.
            const learnt: Profile | undefined = lib.profile(gameId, opts.profileVersion);
            if (teacherKind === TeacherKind.RULES && !opts.resume && learnt && !learnt.teacher) {
                const trainer: { ok: boolean; detail: string } = trainerHealth(config.claude);
                if (!trainer.ok) {
                    throw new Error(`The trainer is not ready: ${trainer.detail} (${game.name} v${learnt.version} has no rules as code, and the trainer writes them first)`);
                }
            }
            const engine: DecisionEngine | undefined = teacherKind === TeacherKind.ENGINE ? createEngine({ ...config.engine, kind: EngineKind.JEV }) : undefined;
            if (engine) {
                await requireEngine(engine);
            }
            const daemon: DaemonHandle = await startDaemon(config, false);
            const browsers: DevtoolsClient[] = [];
            const abort: AbortController = new AbortController();
            process.once("SIGINT", (): void => abort.abort());
            try {
                const result: DistillResult = await new Distiller({
                    library: lib,
                    ...(engine ? { engine } : {}),
                    ask: (prompt: string, dir: string, signal?: AbortSignal): Promise<string> =>
                        askClaude(config.claude, prompt, dir, signal),
                    openBrowser: (): GameBrowser => {
                        const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
                        browsers.push(browser);
                        return browser;
                    },
                    python: config.layaRuntime.python,
                }).distill({
                    gameId,
                    ...(opts.profileVersion !== undefined ? { profileVersion: opts.profileVersion } : {}),
                    teacher: teacherKind,
                    minRows: opts.minRows,
                    gameSeconds: opts.seconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds,
                    parallel: opts.parallel,
                    rounds: opts.rounds,
                    ...(opts.resume ? { resume: true } : {}),
                    studentGames: opts.studentGames,
                    epochs: opts.epochs,
                    ...(opts.roundEpochs !== undefined ? { roundEpochs: opts.roundEpochs } : {}),
                    port: config.layaRuntime.port,
                    base: opts.base,
                    ...(opts.device ? { device: opts.device } : {}),
                    pause: opts.pause,
                    ...(opts.lag ? { lag: opts.lag } : {}),
                    workDir: opts.work ? path.resolve(opts.work) : mkdtempSync(path.join(tmpdir(), `ibgamer-distill-${gameId}-`)),
                    signal: abort.signal,
                    hooks: { onLog: (line: string): void => console.log(line), onPhase: (p: string): void => console.log(`— ${p}`) },
                });
                // A resumed checkpoint whose record names no teacher gives none: the clause is left out, not left empty.
                console.log(`checkpoint ${result.checkpoint} (profile v${result.profileVersion}${result.teacher ? `, taught by ${result.teacher}` : ""})`);
            } finally {
                await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
                await daemon.stop();
            }
        }
    );

layaCommand
    .command("setup")
    .description("Make a Python environment with Laya for ibgamer (<home>/laya-venv): pip install laya[serve]")
    .option("--python <python>", "the Python to make it with (3.10+)", "python3")
    .action(async (opts: { python: string }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const venv: string = path.join(config.home, "laya-venv");
        const run: (command: string, args: string[]) => Promise<void> = (command: string, args: string[]): Promise<void> =>
            new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
                const child: ChildProcess = spawn(command, args, { stdio: "inherit" });
                child.on("error", reject);
                child.on("exit", (code: number | null): void => (code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} … exited with ${code}`))));
            });
        console.log(`making ${venv} with ${opts.python}`);
        await run(opts.python, ["-m", "venv", venv]);
        await run(layaVenvPython(config.home), ["-m", "pip", "install", "--upgrade", "pip"]);
        await run(layaVenvPython(config.home), ["-m", "pip", "install", "-r", path.join(layaScriptsDir(), "requirements.txt")]);
        const check: { ok: boolean; detail: string } = await checkLayaPython(layaVenvPython(config.home));
        console.log(check.ok ? `ready: ${check.detail}` : check.detail);
    });

layaCommand
    .command("eval")
    .description(
        "The checkpoint a Laya play takes plays the profile's seeds (a single game at a time): of the version's checkpoints (the active one's, or --profile-version's), the one whose student played best when it was distilled — the newest when none was measured"
    )
    .argument("<game>", "game id")
    .option("--profile-version <n>", "the version whose checkpoint plays (default: the active one's, else the newest checkpoint's version)", int("version", 1, 1_000_000))
    .option("--seconds <n>", "game time per game (default: the profile's)", int("seconds", 5, 3_600))
    .action(async (gameId: string, opts: { profileVersion?: number; seconds?: number }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const lib: Library = library(config);
        const game: GameDefinition = lib.game(gameId);
        const checkpoint: LayaCheckpoint | undefined = checkpointFor(currentCheckpoints(lib, gameId), opts.profileVersion, lib.activeVersion(gameId));
        if (!checkpoint) {
            throw new Error(`${gameId}${opts.profileVersion !== undefined ? ` v${opts.profileVersion}` : ""} has no checkpoint: ibgamer laya distill ${gameId}${opts.profileVersion !== undefined ? ` --profile-version ${opts.profileVersion}` : ""}`);
        }
        const profile: Profile | undefined = lib.profile(gameId, checkpointProfileVersion(checkpoint));
        if (!profile) {
            throw new Error(`${checkpoint.name}: its profile version is not in the library`);
        }
        // What the distillation recorded: the teacher it had (the reference is labelled by it), its rows.
        const file: string = path.join(checkpoint.dir, "distill.json");
        let recorded: Record<string, unknown> | undefined;
        try {
            recorded = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
        } catch {
            recorded = undefined;
        }
        // No record (a stopped distillation leaves none) or an empty teacher: unknown, not an engine.
        const teacher: string | undefined = typeof recorded?.teacher === "string" && recorded.teacher !== "" ? recorded.teacher : undefined;
        const taughtBy: TeacherKind = teacher !== undefined && !teacher.startsWith("rules") ? TeacherKind.ENGINE : TeacherKind.RULES;
        const abort: AbortController = new AbortController();
        process.once("SIGINT", (): void => abort.abort());
        const daemon: DaemonHandle = await startDaemon(config, false);
        const browsers: DevtoolsClient[] = [];
        try {
            const result: DistillResult = await new Distiller({
                library: lib,
                python: config.layaRuntime.python,
                ask: (): Promise<string> => Promise.reject(new Error("evaluation asks no trainer")),
                openBrowser: (): GameBrowser => {
                    const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl });
                    browsers.push(browser);
                    return browser;
                },
            }).evaluate(game, opts.seconds ? { ...profile, results: profile.results ? { ...profile.results, gameSeconds: opts.seconds } : undefined } : profile, checkpoint.dir, {
                gameId,
                teacher: taughtBy,
                minRows: 0,
                gameSeconds: opts.seconds ?? game.budgets.gameSeconds,
                parallel: 1,
                rounds: 0,
                studentGames: 0,
                epochs: 0,
                port: config.layaRuntime.port,
                workDir: tmpdir(),
                signal: abort.signal,
                hooks: { onLog: (line: string): void => console.log(line) },
            });
            // The student's scores are refreshed; what the distillation recorded (the teacher, its rows) stays.
            // A stopped evaluation throws before this: its partial scores are never recorded.
            if (!opts.seconds) {
                writeFileSync(
                    file,
                    JSON.stringify(
                        {
                            ...(recorded ?? { ...result, at: new Date().toISOString() }),
                            // Who taught it as recorded; unknown, left out — evaluate()'s is empty, which a later eval took for an engine.
                            teacher,
                            student: result.student,
                            ...(result.reference ? { reference: result.reference } : {}),
                            evaluatedAt: new Date().toISOString(),
                        },
                        null,
                        2
                    )
                );
            }
        } finally {
            await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
            await daemon.stop();
        }
    });

layaCommand
    .command("list")
    .description("The fine-tuned checkpoints of every game; one that learnt its version before it was edited (or of a version gone) is marked stale: no play takes it")
    .action((): void => {
        const lib: Library = library(loadConfig());
        for (const id of lib.ids()) {
            const current: Set<string> = new Set(currentCheckpoints(lib, id).map((c: LayaCheckpoint): string => c.name));
            for (const c of layaCheckpoints(lib, id)) {
                const t: Record<string, unknown> = c.training ?? {};
                const after: { balanced?: number; per_action?: unknown } = (t.val_after ?? {}) as { balanced?: number; per_action?: unknown };
                console.log(
                    `${id.padEnd(12)} ${c.name.padEnd(22)} rows ${String(t.rows ?? "?")} | validation balanced accuracy ${after.balanced?.toFixed(3) ?? "?"} ${JSON.stringify(after.per_action ?? {})}` +
                        `${current.has(c.name) ? "" : " (stale: its version changed since, or is gone)"}`
                );
            }
        }
    });

layaCommand
    .command("serve")
    .description(
        "Serve over /v1/systemone, for these games (default: every game that has one), the checkpoint a Laya play takes: of the active version's checkpoints (else the newest checkpoint's version's), the one whose student played best when it was distilled — the newest when none was measured"
    )
    .argument("[games...]", "game ids")
    .option("--port <port>", "port", int("port", 1, 65_535))
    .action(async (games: string[], opts: { port?: number }): Promise<void> => {
        const config: GamerConfig = loadConfig();
        const lib: Library = library(config);
        const checkpoints: Record<string, string> = checkpointsToServe(lib, games.length ? games : lib.ids());
        if (Object.keys(checkpoints).length === 0) {
            throw new Error("no game has a checkpoint: ibgamer laya distill <game>");
        }
        const port: number = opts.port ?? config.layaRuntime.port;
        // A distillation or an evaluation holds the port for hours, its server up only while its students play: a server
        // started here would stand where the next one is served. Refused (the lock is not taken: this is no such run).
        refuseHeldLayaPort(layaPortLockFile(lib, port), port);
        const handle: LayaServerHandle = await startLayaServer({ python: config.layaRuntime.python, port, checkpoints, onLine: (l: string): void => console.log(l) });
        // A Laya play looks for its server on IBGAMER_LAYA_PORT and takes this one when it holds the checkpoint it would load.
        console.log(`Laya serves ${handle.models.join(", ")} on ${handle.url} — to play with it: IBGAMER_ENGINE=laya IBGAMER_LAYA_PORT=${port} ibgamer play <game>`);
        const stop: () => void = (): void => {
            void handle.stop().finally((): never => process.exit(0));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });

const lib: Command = program.command("library").description("The game library");

lib.command("list")
    .description("Every game, built-in and yours, with its active profile")
    .action((): void => {
        for (const g of library(loadConfig()).list()) {
            const results: string = g.results ? ` — mean ${g.results.mean} ${g.scoreLabel} (${g.results.gameSeconds} s games)` : "";
            console.log(`${g.id.padEnd(16)} ${g.name} [${g.source}, ${g.perception}] profile ${g.activeVersion ? `v${g.activeVersion}` : "none"} of ${g.versions}${results}`);
        }
    });

lib.command("show")
    .description("A game and its profile versions")
    .argument("<game>", "game id")
    .action((gameId: string): void => {
        const l: Library = library(loadConfig());
        const game: GameDefinition = l.game(gameId);
        console.log(JSON.stringify(game, null, 2));
        for (const p of l.profiles(gameId)) {
            const s: ProfileSummary = p;
            console.log(
                `${s.active ? "*" : " "} v${s.version} ${s.origin} ${s.createdAt.slice(0, 16)} [${s.source}]${s.results ? ` mean ${s.results.mean} (${s.results.gameSeconds} s)` : ""}${s.tests ? `, ${s.tests} tests` : ""}${s.note ? `\n      ${s.note.slice(0, 240)}` : ""}`
            );
        }
    });

lib.command("activate")
    .description("Make a profile version the one that plays")
    .argument("<game>", "game id")
    .argument("<version>", "version number", int("version", 1, 1_000_000))
    .action((gameId: string, version: number): void => {
        library(loadConfig()).setActive(gameId, version);
        console.log(`${gameId}: v${version} is active`);
    });

lib.command("import")
    .description("Add a game directory (game.json, profiles/, …) to your library")
    .argument("<dir>", "the game's directory")
    .option("--replace", "replace a game of yours with the same id")
    .action((dir: string, opts: { replace?: boolean }): void => {
        const game: GameDefinition = library(loadConfig()).importGame(path.resolve(dir), { replace: opts.replace });
        console.log(`imported ${game.id} (${game.name})`);
    });

lib.command("export")
    .description("Write a game with every profile version into one directory, to share it")
    .argument("<game>", "game id")
    .argument("<dir>", "target directory")
    .action((gameId: string, dir: string): void => {
        library(loadConfig()).exportGame(gameId, path.resolve(dir));
        console.log(`exported ${gameId} to ${path.resolve(dir)}`);
    });

lib.command("remove")
    .description("Remove your part of a game: a game you added entirely, a built-in one's trained versions")
    .argument("<game>", "game id")
    .action((gameId: string): void => {
        library(loadConfig()).removeUserPart(gameId);
        console.log(`removed your part of ${gameId}`);
    });

lib.command("games")
    .description("The games as JSON")
    .action((): void => {
        const l: Library = library(loadConfig());
        // Laya's mark by the checkpoints a play can take, as the UI's card: the library counts any checkpoint on disk.
        console.log(JSON.stringify(l.list().map((g: GameSummary): GameSummary => ({ ...g, hasLaya: currentCheckpoints(l, g.id).length > 0 })), null, 2));
    });

loadDotEnv();
program.parseAsync(process.argv).catch((err: unknown): void => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
