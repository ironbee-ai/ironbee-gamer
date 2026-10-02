/**
 * The local web UI: the game library, a live view of the game being played
 * with every decision beside it, training with its log, and past runs with
 * their videos.
 *
 * One process serves the static UI, a small JSON API, the viewers' websocket
 * and the live-view hub, and owns a DevTools daemon started with the hub's
 * address — so every run's recording streams here. One run at a time.
 *
 * Bound to loopback by default. Mutating requests and websocket upgrades must
 * come from the UI's own origin; the producer endpoint needs the per-process
 * token the daemon was started with.
 */

import { GamerConfig } from "../config/config";
import { DevtoolsClient, GameBrowser } from "../devtools/client";
import { DaemonHandle, ensureDaemon, freePort, isDaemonHealthy } from "../devtools/daemon";
import { Adapter, ProbeResult } from "../devtools/protocol";
import { createEngine, DecisionEngine, EngineHealth, EngineKind } from "../engine";
import { describeConfig, LIVE_LATENCY, liveReadiness, LiveReadiness, offeredConfig, playConfigs } from "../game/configs";
import { GameDefinition, Perception, PlayConfig, Profile } from "../game/types";
import { InvalidDefinitionError, MAX_EPISODES } from "../game/validate";
import { defaultBuiltInDir, GameNotFoundError, GameSummary, Library, ProfileSummary } from "../library/store";
import { DecisionRecord, EpisodeResult, Pace, PlayResult, TickEvent } from "../play/player";
import { Distiller, DistillOptions, DistillResult, TeacherKind } from "../distill/distiller";
import { RulesTeacher } from "../distill/teacher";
import { CheckGame, CheckReport } from "../improve/check";
import { ImproveEngines, ImproveOutcome, ImproveResult, Improver, nothingToCheck } from "../improve/improve";
import { askClaude, trainerHealth } from "../train/claude";
import { checkLayaPython, LayaCheckpoint, layaPortHeldByOther, LayaPortHeldError, layaPortLockFile, refuseHeldLayaPort } from "../distill/laya-runtime";
import { checkpointFor, checkpointProfileVersion, currentCheckpoints, LayaServers, LayaSetup } from "../distill/laya-play";
import { PageReaderWriter, PROBE_BOOT_MS, ReaderProposal } from "../reader/page-reader";
import { DecisionLog } from "../run/decision-log";
import { playGame } from "../run/play";
import { ImproveTracker, LayaTrainingTracker, ProgressTracker } from "../run/progress";
import { CheckSummary, RunKind, RunRecord, RunStatus, RunStore, summarizeEpisode } from "../run/runs";
import { MAX_USER_NOTE_CHARS } from "../train/prompts";
import { layaToTeach, trainFor, TrainForResult } from "../train/train-for";
import { Decider, Trainer, TrainOptions, TrainResult } from "../train/trainer";
import { bindHost, hostAllowed, originAllowed, reachableHost, requestPath, serveFile, serveVideo } from "./http-guards";
import { LiveHub } from "./live-hub";

import { randomUUID } from "crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from "http";
import { basename, extname, join } from "path";
import { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";

const UI_DIR: string = join(__dirname, "ui");
const MAX_BODY_BYTES: number = 64 * 1024;
const KEPT_RUNS: number = 50;
const STATIC_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
};
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpeg": "image/jpeg", ".jpg": "image/jpeg" };
/** The live view's frame rate: a game moves every frame. */
const LIVE_VIEW_MAX_FPS: number = 25;
/** Why a run or a reader that would start something after close() began fails. */
const CLOSING: string = "the UI is closing";

export interface UiServerHandle {
    url: string;
    close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size: number = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
            throw new Error("request body too large");
        }
        chunks.push(chunk as Buffer);
    }
    const text: string = Buffer.concat(chunks).toString("utf-8");
    return text ? JSON.parse(text) : {};
}

function intIn(value: unknown, name: string, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const n: number = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${name} must be a whole number in [${min}, ${max}]`);
    }
    return n;
}

export interface PlayRequest {
    gameId: string;
    version?: number;
    episodes: number;
    gameSeconds: number;
    seed?: number;
    pace: Pace;
    engine: EngineKind;
    /** The config's lag floor (live, a lag-aware version): its inputs land no sooner. */
    minLagMs?: number;
}

/** The trainer writing a reader for a page being added. */
interface ReaderJob {
    id: string;
    url: string;
    status: RunStatus;
    phase: string;
    result?: ReaderProposal;
    error?: string;
}

/** A distillation: of the version asked for (one the live clock plays, kept for real time only), else of the active one. */
export interface DistillRequest {
    gameId: string;
    rounds: number;
    minRows: number;
    version?: number;
}

/**
 * Train: the engine and clock chosen made to play better. With something to check (a version that clock plays, the engine
 * able to play it): checked, fixed — or trained for a higher score when nothing loses —, checked again (src/improve/).
 * With nothing to check yet: a training starts there (src/train/train-for.ts).
 */
export interface TrainRequest {
    gameId: string;
    iterations: number;
    gameSeconds?: number;
    engine: EngineKind;
    /** The clock running (real time): checked and trained live; with nothing to check yet, a first training for real time. */
    live: boolean;
    /** Notes for the trainer: what the person saw the game played do, or wants it to do (told in its every prompt). */
    note?: string;
    /** The version checked when no config pins one for that engine and clock: the one the person plays (the Profile select's). */
    version?: number;
}

/** A training's notes for the trainer, as a request gives them: text, trimmed, at most MAX_USER_NOTE_CHARS; none when empty. */
function noteOf(value: unknown): { note?: string } {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value !== "string") {
        throw new Error("note must be text");
    }
    const note: string = value.trim();
    if (note.length > MAX_USER_NOTE_CHARS) {
        throw new Error(`note must be at most ${MAX_USER_NOTE_CHARS} characters (it goes into every prompt of the training)`);
    }
    return note ? { note } : {};
}

/** The profile version a request names (a whole number), if it names one. */
function versionOf(value: unknown): number | undefined {
    return value !== undefined && value !== null && value !== "" ? intIn(value, "version", 1, 1_000_000, 1) : undefined;
}

/**
 * Who decides a training's moves: trained for Jev, Jev (it reads the instructions); trained for Laya or the rules
 * engine, the profile's rules as code (instant) — and Laya can learn them afterwards by distillation.
 */
function trainDecider(engine: EngineKind): Decider {
    return engine === EngineKind.LAYA || engine === EngineKind.RULES ? Decider.RULES : Decider.ENGINE;
}

/**
 * A game's library card picture: the first end screen a run of it saved, until one exists. Best-effort, as a run's
 * record is: a copy that fails (a full disk) is logged, and the run ends as it would.
 */
export function keepThumbnail(library: Library, gameId: string, episodes: EpisodeResult[]): void {
    try {
        const shot: string | undefined = episodes.find((e: EpisodeResult): boolean => Boolean(e.endScreenshot))?.endScreenshot;
        if (shot && existsSync(shot) && !library.file(gameId, "thumbnail.png")) {
            // Never over what is there: a link out of the game's folder is no thumbnail to file(), and is not written through.
            copyFileSync(shot, join(library.userDirFor(gameId), "thumbnail.png"), constants.COPYFILE_EXCL);
        }
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            console.error(`ibgamer ui: the thumbnail of ${gameId} was not kept: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

export function parsePlayRequest(body: Record<string, unknown>, library: Library, defaultEngine: EngineKind): PlayRequest {
    const gameId: string = String(body.gameId ?? "");
    const game: GameDefinition = library.game(gameId);
    const pace: unknown = body.pace ?? Pace.WATCH;
    if (!Object.values(Pace).includes(pace as Pace)) {
        throw new Error(`pace must be one of ${Object.values(Pace).join(", ")}`);
    }
    const engine: unknown = body.engine ?? defaultEngine;
    // None chosen: the UI had none to offer (each not ready, or not offered for the game) — that, not the kinds there are.
    if (engine === "") {
        throw new Error(`no engine is ready to play ${game.name}: none was chosen`);
    }
    if (!Object.values(EngineKind).includes(engine as EngineKind)) {
        throw new Error(`engine must be one of ${Object.values(EngineKind).join(", ")}`);
    }
    // A game is played only in one of its configs: those it lists, else those its versions earn (playConfigs).
    const configs: PlayConfig[] = playConfigs(game, library.profiles(gameId));
    const config: PlayConfig | undefined = offeredConfig(configs, engine as EngineKind, pace === Pace.REALTIME);
    if (!config) {
        const live: LiveReadiness = pace === Pace.REALTIME && !game.configs ? liveReadiness(library.profiles(gameId)) : {};
        throw new Error(`${game.name} is not played that way${live.why ? ` (${live.why})` : ""}; it is played: ${configs.map(describeConfig).join("; ")}`);
    }
    const version: number | undefined = versionOf(body.version) ?? config.version;
    return {
        gameId,
        ...(version !== undefined ? { version } : {}),
        episodes: intIn(body.episodes, "episodes", 1, MAX_EPISODES, game.budgets.episodes),
        gameSeconds: intIn(body.gameSeconds, "gameSeconds", 1, 3_600, game.budgets.gameSeconds),
        ...(body.seed !== undefined && body.seed !== null && body.seed !== "" ? { seed: intIn(body.seed, "seed", 0, 2_147_483_646, 0) } : {}),
        pace: pace as Pace,
        engine: engine as EngineKind,
        ...(config.lagMs !== undefined ? { minLagMs: config.lagMs } : {}),
    };
}

export async function startUiServer(config: GamerConfig): Promise<UiServerHandle> {
    const hub: LiveHub = new LiveHub();
    const token: string = randomUUID();
    const port: number = config.ui.port;
    const host: string = bindHost(config.ui.host);
    const ownAddress: string = `${reachableHost(host)}:${port}`;
    const ownHost: (header: string | undefined) => boolean = (header: string | undefined): boolean => hostAllowed(header, host, port);
    const ownOrigin: (origin: string | undefined, hostHeader: string | undefined) => boolean = (origin: string | undefined, hostHeader: string | undefined): boolean =>
        originAllowed(origin, hostHeader, host, port);
    const library: Library = new Library(defaultBuiltInDir(), config.libraryDir);
    const runStore: RunStore = new RunStore(config.runsDir);
    const runs: RunRecord[] = runStore.list(KEPT_RUNS);

    /**
     * Set when close() begins: nothing is started after it (a daemon, a Laya server), since nothing would stop it.
     * A run or a reader that gets there fails, saying so.
     */
    let closing: boolean = false;

    // A daemon is started per run when none is healthy: an idle DevTools daemon exits on its own.
    let daemon: DaemonHandle | undefined;
    /**
     * The daemon looks for browser sessions only at its checks, and exits after two that found none —
     * whatever ran between them. A training's tuner call or a distillation's fine-tuning has no browser open
     * for half an hour or more, so hourly checks lost the daemon mid-run. The UI stops the daemons it starts;
     * the checks only bound one it leaves behind (as the CLI's do).
     */
    const DAEMON_IDLE_CHECK_SECONDS: number = 21_600;
    const startRunDaemon: () => Promise<DaemonHandle> = async (): Promise<DaemonHandle> => {
        if (config.daemon.url) {
            // A local one it revives on that port gets the same checks as one of its own.
            return ensureDaemon({
                url: config.daemon.url,
                port: 0,
                headless: config.daemon.headless,
                daemonScript: config.daemon.script,
                idleCheckSeconds: DAEMON_IDLE_CHECK_SECONDS,
            });
        }
        if (daemon && (await isDaemonHealthy(daemon.baseUrl))) {
            return daemon;
        }
        // One that missed a check (busy, or gone) is stopped before its replacement starts: close() stops only the last.
        await daemon?.stop().catch((): void => undefined);
        daemon = undefined;
        daemon = await ensureDaemon({
            idleCheckSeconds: DAEMON_IDLE_CHECK_SECONDS,
            port: await freePort(),
            headless: config.daemon.headless,
            daemonScript: config.daemon.script,
            env: {
                LIVE_VIEW_WS_URL: `ws://${ownAddress}/live/producer`,
                LIVE_VIEW_TOKEN: token,
                LIVE_VIEW_EVENTS_ENABLE: "false",
                LIVE_VIEW_MAX_FPS: String(LIVE_VIEW_MAX_FPS),
            },
        });
        return daemon;
    };
    /** One start at a time: a probe and a run starting together would each start a daemon, and close() stops only the last. */
    let daemonStart: Promise<DaemonHandle> | undefined;
    const ensureRunDaemon: () => Promise<DaemonHandle> = (): Promise<DaemonHandle> => {
        if (closing) {
            return Promise.reject(new Error(CLOSING));
        }
        daemonStart ??= startRunDaemon().finally((): void => {
            daemonStart = undefined;
        });
        return daemonStart;
    };

    const engineFor: (kind: EngineKind) => DecisionEngine = (kind: EngineKind): DecisionEngine => createEngine({ ...config.engine, kind });
    /**
     * Local Laya: one server for the games played with it, started on demand by the Python there is then —
     * `ibgamer laya setup` may make one while the UI runs. Another Python gets its own, once the old one's
     * server stopped (they share the port); one at a time.
     */
    let laya: { python: string; servers: LayaServers } | undefined;
    let layaQueue: Promise<unknown> = Promise.resolve();
    const layaServers: () => Promise<LayaServers> = (): Promise<LayaServers> => {
        // None once closing: close() stops the one there is, once a start asked for before it is done.
        if (closing) {
            return Promise.reject(new Error(CLOSING));
        }
        const next: Promise<LayaServers> = layaQueue.then(async (): Promise<LayaServers> => {
            const python: string = config.layaRuntime.python;
            if (!laya || laya.python !== python) {
                await laya?.servers.stop();
                laya = { python, servers: new LayaServers(library, python, config.layaRuntime.port) };
            }
            return laya.servers;
        });
        layaQueue = next.catch((): undefined => undefined);
        return next;
    };
    const stopLaya: () => Promise<void> = async (): Promise<void> => {
        await layaQueue;
        await laya?.servers.stop();
    };
    /** Whether the Python has Laya: a success is kept for that Python; a failure (a timeout too) is checked again next time. */
    let layaCheck: { python: string; result: Promise<{ ok: boolean; detail: string }> } | undefined;
    const checkLaya: () => Promise<{ ok: boolean; detail: string }> = (): Promise<{ ok: boolean; detail: string }> => {
        const python: string = config.layaRuntime.python;
        if (layaCheck?.python === python) {
            return layaCheck.result;
        }
        const check: { python: string; result: Promise<{ ok: boolean; detail: string }> } = { python, result: checkLayaPython(python) };
        layaCheck = check;
        void check.result.then((result: { ok: boolean; detail: string }): void => {
            if (!result.ok && layaCheck === check) {
                layaCheck = undefined;
            }
        });
        return check.result;
    };

    let current: { record: RunRecord; abort: AbortController } | undefined;
    /** Readers the trainer is writing for pages being added (a few minutes each), by job id. */
    const readers: Map<string, ReaderJob> = new Map();
    /** The readers still at work: close() aborts each and stops its daemon (one still starting, once it is up). */
    const readerWork: Set<{ abort: AbortController; daemon: Promise<DaemonHandle | undefined> }> = new Set();

    /** A reader's browser: a daemon of its own, so a game played meanwhile keeps the live one. None once closing. */
    const startReaderDaemon: () => Promise<DaemonHandle> = async (): Promise<DaemonHandle> => {
        const port: number = await freePort();
        // Checked after the last wait before the start: close() stops only a daemon whose start began before it.
        if (closing) {
            throw new Error(CLOSING);
        }
        return ensureDaemon({ port, headless: config.daemon.headless, daemonScript: config.daemon.script, idleCheckSeconds: DAEMON_IDLE_CHECK_SECONDS });
    };

    const startReader: (url: string, viewport?: { width: number; height: number }) => ReaderJob = (url: string, viewport?: { width: number; height: number }): ReaderJob => {
        const job: ReaderJob = { id: randomUUID(), url, status: RunStatus.RUNNING, phase: "starting" };
        readers.set(job.id, job);
        const daemonStarted: Promise<DaemonHandle> = startReaderDaemon();
        const work: { abort: AbortController; daemon: Promise<DaemonHandle | undefined> } = {
            abort: new AbortController(),
            daemon: daemonStarted.catch((): undefined => undefined),
        };
        readerWork.add(work);
        void (async (): Promise<void> => {
            const handle: DaemonHandle = await daemonStarted;
            try {
                job.result = await new PageReaderWriter({
                    openBrowser: (): GameBrowser => new DevtoolsClient({ baseUrl: handle.baseUrl }),
                    ask: (prompt: string, dir: string, signal?: AbortSignal): Promise<string> => askClaude(config.claude, prompt, dir, signal),
                }).write({
                    url,
                    workDir: join(config.runsDir, "readers", job.id),
                    ...(viewport ? { viewport } : {}),
                    signal: work.abort.signal,
                    onPhase: (text: string): void => {
                        job.phase = text;
                    },
                });
                job.status = RunStatus.DONE;
                job.phase = "done";
            } catch (err: unknown) {
                job.status = RunStatus.FAILED;
                job.error = err instanceof Error ? err.message : String(err);
            } finally {
                await handle.stop().catch((): void => undefined);
            }
        })()
            .catch((err: unknown): void => {
                job.status = RunStatus.FAILED;
                job.error = err instanceof Error ? err.message : String(err);
            })
            .finally((): void => {
                readerWork.delete(work);
            });
        return job;
    };

    /** A run's record on disk, best-effort: a save that fails (a full disk) is logged, and the run goes on as it would. */
    const saveRecord: (record: RunRecord) => void = (record: RunRecord): void => {
        try {
            runStore.save(record);
        } catch (err: unknown) {
            console.error(`ibgamer ui: the record of run ${record.id} was not saved: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const publish: (record: RunRecord) => void = (record: RunRecord): void => {
        saveRecord(record);
        hub.broadcast({ type: "run", run: record });
    };

    /** A run starts: its folder is made first, and it is the run in progress last — a start that fails leaves none behind. */
    const begin: (record: RunRecord) => { abort: AbortController; dir: string } = (record: RunRecord): { abort: AbortController; dir: string } => {
        const dir: string = runStore.runDir(record.id);
        const abort: AbortController = new AbortController();
        runs.unshift(record);
        runs.splice(KEPT_RUNS);
        hub.resetFrame();
        publish(record);
        current = { record, abort };
        return { abort, dir };
    };

    const finish: (record: RunRecord, err?: unknown) => void = (record: RunRecord, err?: unknown): void => {
        if (err !== undefined) {
            record.status = RunStatus.FAILED;
            record.error = err instanceof Error ? err.message : String(err);
            record.phase = "failed";
        }
        record.endedAt = Date.now();
        if (current?.record === record) {
            current = undefined;
        }
        publish(record);
    };

    /** What escapes a run's own handling (nothing should) is logged, and ends the run if it is still in progress. */
    const escaped: (record: RunRecord) => (err: unknown) => void = (record: RunRecord): ((err: unknown) => void) => (err: unknown): void => {
        console.error(`ibgamer ui: run ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
        if (current?.record === record) {
            finish(record, err);
        }
    };

    const onTick: (record: RunRecord) => (event: TickEvent) => void = (record: RunRecord): ((event: TickEvent) => void) => (event: TickEvent): void => {
        hub.broadcast({ type: "tick", id: record.id, tick: event });
    };

    /**
     * Runs' starts in flight: what a run does before it has its daemon (a Laya server, a Python check). close() waits
     * for them: a start still going when it began gets no daemon, and its run ends saying why before close() returns.
     */
    const runStarts: Set<Promise<void>> = new Set();
    const starting: (start: Promise<DaemonHandle>) => Promise<DaemonHandle> = (start: Promise<DaemonHandle>): Promise<DaemonHandle> => {
        const settled: Promise<void> = start.then(
            (): void => undefined,
            (): void => undefined
        );
        runStarts.add(settled);
        void settled.then((): void => {
            runStarts.delete(settled);
        });
        return start;
    };

    const startPlay: (request: PlayRequest) => RunRecord = (request: PlayRequest): RunRecord => {
        const game: GameDefinition = library.game(request.gameId);
        const laya: boolean = request.engine === EngineKind.LAYA;
        // The checkpoint the Laya server will take (LayaServers): of those that learnt their version as it is now, the
        // version asked for's, else the active version's. None is refused here, before a run begins.
        const checkpoints: LayaCheckpoint[] = laya ? currentCheckpoints(library, game.id) : [];
        const checkpoint: LayaCheckpoint | undefined = laya ? checkpointFor(checkpoints, request.version, library.activeVersion(game.id)) : undefined;
        if (laya && !checkpoint) {
            throw new Error(
                request.version !== undefined && checkpoints.length
                    ? `${game.name} v${request.version} has no Laya checkpoint: Train with Laya teaches it that version`
                    : `${game.name} has no Laya checkpoint yet: Train with Laya teaches it`
            );
        }
        // A distillation in another process (the CLI) holds the port for hours: refused here, a 409 naming it, before a
        // run begins (LayaServers refuses it too, should one take the port meanwhile).
        if (laya) {
            refuseHeldLayaPort(layaPortLockFile(library, config.layaRuntime.port), config.layaRuntime.port);
        }
        // A checkpoint learned one profile version's states: that version plays unless one is chosen.
        const learned: number | undefined = checkpoint ? checkpointProfileVersion(checkpoint) : undefined;
        let profile: Profile | undefined = library.profile(request.gameId, request.version ?? learned);
        if (!profile) {
            throw new Error(`${game.name} has no profile yet: train it first`);
        }
        if (request.engine === EngineKind.RULES && !profile.teacher) {
            throw new Error(`${game.name} v${profile.version} has no rules as code: train it with Laya as its engine (the rules then decide and are written as code)`);
        }
        // The rules engine plays the chosen version's own rules, instant, on this machine.
        let engine: DecisionEngine = request.engine === EngineKind.RULES ? new RulesTeacher(profile) : engineFor(request.engine);
        const record: RunRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: RunKind.PLAY,
            gameId: game.id,
            gameName: game.name,
            version: profile.version,
            engine: checkpoint ? `laya (${game.id} ${checkpoint.name})` : engine.label,
            status: RunStatus.RUNNING,
            phase: "starting",
            startedAt: Date.now(),
            settings: {
                episodes: request.episodes,
                gameSeconds: request.gameSeconds,
                ...(request.seed !== undefined ? { seeds: [request.seed] } : {}),
                pace: request.pace,
            },
            episodes: [],
        };
        const { abort, dir }: { abort: AbortController; dir: string } = begin(record);
        void (async (): Promise<void> => {
            let browser: DevtoolsClient | undefined;
            try {
                const handle: DaemonHandle = await starting(
                    (async (): Promise<DaemonHandle> => {
                        if (laya) {
                            record.phase = "starting the local Laya server";
                            hub.broadcast({ type: "phase", id: record.id, phase: record.phase });
                            // The checkpoint of the version asked for (a config pins one), else the active version's.
                            const setup: LayaSetup = await (await layaServers()).engineFor(game.id, request.version);
                            engine = setup.engine;
                            profile = library.profile(game.id, setup.profileVersion) ?? profile;
                            // What plays is the checkpoint the server took (a distillation may have made another since it was named).
                            record.engine = `laya (${game.id} ${setup.checkpoint.name})`;
                            record.version = setup.profileVersion;
                            publish(record);
                        }
                        // The first run of a session starts the DevTools daemon and its browser: a few seconds the screen shows.
                        record.phase = "starting the browser";
                        hub.broadcast({ type: "phase", id: record.id, phase: record.phase });
                        return ensureRunDaemon();
                    })()
                );
                browser = new DevtoolsClient({ baseUrl: handle.baseUrl });
                // Every decision of a hosted engine is a distillation row for a local one.
                const log: DecisionLog | undefined = request.engine === EngineKind.JEV ? new DecisionLog(library, game.id, profile as Profile, engine.label) : undefined;
                const result: PlayResult = await playGame(browser, engine, library, {
                    game,
                    profile: profile as Profile,
                    episodes: request.episodes,
                    gameSeconds: request.gameSeconds,
                    ...(request.seed !== undefined ? { seeds: [request.seed] } : {}),
                    pace: request.pace,
                    ...(request.minLagMs !== undefined ? { minLagMs: request.minLagMs } : {}),
                    recordDir: dir,
                    screenshotDir: dir,
                    signal: abort.signal,
                    hooks: {
                        onPhase: (detail: string): void => {
                            record.phase = detail;
                            hub.broadcast({ type: "phase", id: record.id, phase: detail });
                        },
                        onEpisodeStart: (episode: number, seed: number | undefined): void => {
                            record.phase = `playing episode ${episode}/${request.episodes}${seed !== undefined ? ` (seed ${seed})` : ""}`;
                            hub.broadcast({ type: "phase", id: record.id, phase: record.phase, episode });
                        },
                        onTick: onTick(record),
                        ...(log ? { onDecision: (d: DecisionRecord): void => log.append(d) } : {}),
                        onEpisodeEnd: (result: EpisodeResult): void => {
                            record.episodes.push(summarizeEpisode(result, undefined, dir));
                            publish(record);
                        },
                    },
                });
                record.mean = result.mean;
                if (result.videoPath && existsSync(result.videoPath)) {
                    record.video = result.videoPath.split("/").pop();
                }
                record.status = result.stopped ? RunStatus.STOPPED : RunStatus.DONE;
                record.phase = result.stopped ? "stopped" : "done";
                keepThumbnail(library, game.id, result.episodes);
                finish(record);
            } catch (err: unknown) {
                finish(record, err);
            } finally {
                await browser?.close();
            }
        })().catch(escaped(record));
        return record;
    };

    /**
     * Train with nothing to check yet (`nothingYet`, why): a training for the engine asked (src/train/train-for.ts) — Jev:
     * its rules in words, Jev deciding; Rules (code): the rules as code; Laya: the rules as code, then Laya taught the
     * version kept (or, Laya with no model of the version it plays, Laya taught that version alone); the clock running: a
     * first training for real time. One Jev would decide is started only when Jev is ready (runStarter checks it first).
     */
    const startTraining: (request: TrainRequest, nothingYet: string) => RunRecord = (request: TrainRequest, nothingYet: string): RunRecord => {
        const game: GameDefinition = library.game(request.gameId);
        const decider: Decider = trainDecider(request.engine);
        const engine: DecisionEngine = engineFor(EngineKind.JEV);
        const start: Profile | undefined = library.profile(game.id);
        const gameSeconds: number = request.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
        const forLaya: boolean = request.engine === EngineKind.LAYA;
        const alone: number | undefined = forLaya ? layaToTeach(library, game, request.live) : undefined;
        const record: RunRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: RunKind.TRAIN,
            gameId: game.id,
            gameName: game.name,
            ...(alone !== undefined ? { version: alone } : start ? { version: start.version } : {}),
            engine:
                alone !== undefined
                    ? `laya: learns v${alone}`
                    : decider === Decider.RULES
                        ? `the profile's rules${forLaya ? ", then Laya" : ""}${request.live ? ", for real time" : ""}`
                        : engine.label,
            status: RunStatus.RUNNING,
            phase: "starting",
            startedAt: Date.now(),
            settings: {
                episodes: (game.trainSeeds ?? [101, 202, 303]).length,
                gameSeconds,
                iterations: request.iterations,
                ...(request.live ? { realtime: true } : {}),
                ...(request.note ? { note: request.note } : {}),
            },
            episodes: [],
            log: [],
            savedVersions: [],
        };
        const { abort, dir }: { abort: AbortController; dir: string } = begin(record);
        void (async (): Promise<void> => {
            const browsers: DevtoolsClient[] = [];
            const setup: boolean = !library.profile(game.id);
            // A training for Laya follows two parts — the rules' training, Laya's lesson —, the others a training's stages.
            const laya: LayaTrainingTracker | undefined = forLaya ? new LayaTrainingTracker({ iterations: request.iterations, setup, alone: alone !== undefined }) : undefined;
            const plain: ProgressTracker | undefined = forLaya ? undefined : new ProgressTracker(RunKind.TRAIN, { iterations: request.iterations, setup });
            const progressed: () => void = (): void => {
                record.progress = (laya ?? (plain as ProgressTracker)).progress;
                hub.broadcast({ type: "progress", id: record.id, progress: record.progress });
            };
            progressed();
            const log: (line: string) => void = (line: string): void => {
                record.log?.push(line);
                hub.broadcast({ type: "log", id: record.id, line });
                saveRecord(record);
            };
            const phase: (detail: string) => void = (detail: string): void => {
                record.phase = detail;
                hub.broadcast({ type: "phase", id: record.id, phase: detail });
            };
            log(`— nothing to check yet (${nothingYet}): a training`);
            try {
                const handle: DaemonHandle = await starting(ensureRunDaemon());
                const openBrowser: () => GameBrowser = (): GameBrowser => {
                    const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: handle.baseUrl });
                    browsers.push(browser);
                    return browser;
                };
                const result: TrainForResult = await trainFor(
                    {
                        library,
                        train: (o: TrainOptions): Promise<TrainResult> => new Trainer({ library, engine, openBrowser, trainer: config.claude }).train(o),
                        distill: (o: DistillOptions): Promise<DistillResult> =>
                            new Distiller({
                                library,
                                ask: (prompt: string, work: string, signal?: AbortSignal): Promise<string> => askClaude(config.claude, prompt, work, signal),
                                openBrowser,
                                python: config.layaRuntime.python,
                            }).distill(o),
                        distillDefaults: { teacher: TeacherKind.RULES, minRows: 12_000, gameSeconds, parallel: 2, rounds: 1, studentGames: 2, epochs: 1, port: config.layaRuntime.port },
                        beforeDistill: async (): Promise<void> => {
                            // The Python there is now (`ibgamer laya setup` may have made one since the UI started); the UI's own
                            // Laya server holds the port the distiller serves its student on.
                            const python: { ok: boolean; detail: string } = await checkLayaPython(config.layaRuntime.python);
                            if (!python.ok) {
                                throw new Error(`${python.detail} (or set IBGAMER_LAYA_PYTHON)`);
                            }
                            await stopLaya();
                        },
                    },
                    {
                        gameId: game.id,
                        engine: request.engine,
                        iterations: request.iterations,
                        gameSeconds,
                        ...(request.live ? { realtime: true } : {}),
                        ...(request.note ? { note: request.note } : {}),
                        workDir: join(dir, "work"),
                        recordDir: dir,
                        signal: abort.signal,
                        hooks: {
                            train: {
                                onLog: (line: string): void => {
                                    if (laya) {
                                        laya.onTrainLog(line);
                                    } else {
                                        plain?.onLog(line);
                                    }
                                    progressed();
                                    log(line);
                                },
                                onPhase: (detail: string): void => {
                                    if (laya) {
                                        laya.onTrainPhase(detail);
                                    } else {
                                        plain?.onPhase(detail);
                                    }
                                    progressed();
                                    phase(detail);
                                },
                                play: { onTick: onTick(record) },
                                onEpisodeEnd: (episode: EpisodeResult, version: number | undefined): void => {
                                    record.episodes.push(summarizeEpisode(episode, version, dir));
                                    publish(record);
                                },
                                onSaved: (profile: Profile): void => {
                                    record.savedVersions?.push(profile.version);
                                    hub.broadcast({ type: "library" });
                                },
                            },
                            distill: {
                                onLog: (line: string): void => {
                                    laya?.onDistillLog(line);
                                    progressed();
                                    log(line);
                                },
                                onPhase: (detail: string): void => {
                                    laya?.onDistillPhase(detail);
                                    progressed();
                                    phase(detail);
                                },
                                play: { onTick: onTick(record) },
                            },
                            onTeach: (version: number, learnsAlone: boolean): void => {
                                laya?.onTeach(1);
                                progressed();
                                log(learnsAlone ? `— Laya has no model of v${version} yet: it learns that version` : `— Laya learns v${version}, the version kept`);
                            },
                        },
                    }
                );
                const trained: TrainResult | undefined = result.trained;
                const stopped: boolean = trained?.stopped === true || abort.signal.aborted;
                record.mean = trained?.bestMean ?? result.taught?.result.student?.mean;
                record.status = stopped ? RunStatus.STOPPED : RunStatus.DONE;
                if (!stopped) {
                    if (laya) {
                        laya.finish(result.untaught);
                    } else {
                        plain?.finish();
                    }
                    progressed();
                }
                // A best kept for real time only is not the one the paused clock plays: said so.
                const bestLiveOnly: boolean = trained?.bestVersion !== undefined && library.profile(game.id, trained.bestVersion)?.liveOnly === true;
                const what: string[] = [
                    ...(trained
                        ? [
                            trained.savedVersions.length
                                ? `saved ${trained.savedVersions.map((v: number): string => `v${v}`).join(", ")}; the best is v${trained.bestVersion}${bestLiveOnly ? " (for real time only)" : ""}`
                                : `no version beat v${trained.bestVersion}`,
                        ]
                        : []),
                    ...(result.taught
                        ? [`Laya learnt v${result.taught.version}: ${result.taught.result.checkpoint.split("/").pop()}${result.taught.result.student ? ` — Laya ${result.taught.result.student.scores.join(", ")}` : ""}`]
                        : []),
                ];
                record.phase = `done: ${what.join("; ")}`;
                finish(record);
            } catch (err: unknown) {
                if (abort.signal.aborted) {
                    // A stopped distillation throws: stopped, as a stopped training shows, not failed.
                    record.status = RunStatus.STOPPED;
                    record.phase = "stopped";
                    finish(record);
                } else {
                    finish(record, err);
                }
            } finally {
                await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
                hub.broadcast({ type: "library" });
            }
        })().catch(escaped(record));
        return record;
    };

    const startDistill: (request: DistillRequest) => RunRecord = (request: DistillRequest): RunRecord => {
        const game: GameDefinition = library.game(request.gameId);
        const profile: Profile | undefined = library.profile(game.id, request.version);
        if (!profile) {
            throw new Error(`${game.name} has no profile yet: train it first`);
        }
        const gameSeconds: number = game.budgets.trainSeconds ?? game.budgets.gameSeconds;
        const record: RunRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: RunKind.DISTILL,
            gameId: game.id,
            gameName: game.name,
            version: profile.version,
            engine: "the trainer's rules → laya",
            status: RunStatus.RUNNING,
            phase: "starting",
            startedAt: Date.now(),
            settings: { episodes: 0, gameSeconds, rounds: request.rounds, minRows: request.minRows },
            episodes: [],
            log: [],
        };
        const { abort, dir }: { abort: AbortController; dir: string } = begin(record);
        void (async (): Promise<void> => {
            const browsers: DevtoolsClient[] = [];
            /** Whether the distiller runs: a stop ends it with an error, and from then on a stop is what ended the run. */
            let distilling: boolean = false;
            try {
                // The Python there is now: `ibgamer laya setup` may have made one since the UI started.
                const pythonPath: string = config.layaRuntime.python;
                const handle: DaemonHandle = await starting(
                    (async (): Promise<DaemonHandle> => {
                        const python: { ok: boolean; detail: string } = await checkLayaPython(pythonPath);
                        if (!python.ok) {
                            throw new Error(`${python.detail} (or set IBGAMER_LAYA_PYTHON)`);
                        }
                        // The UI's own Laya server holds the port the distiller serves its student on.
                        await stopLaya();
                        return ensureRunDaemon();
                    })()
                );
                const tracker: ProgressTracker = new ProgressTracker(RunKind.DISTILL, { rounds: request.rounds });
                const progressed: () => void = (): void => {
                    record.progress = tracker.progress;
                    hub.broadcast({ type: "progress", id: record.id, progress: record.progress });
                };
                progressed();
                const say: (line: string) => void = (line: string): void => {
                    record.log?.push(line);
                    hub.broadcast({ type: "log", id: record.id, line });
                    tracker.onLog(line);
                    progressed();
                    saveRecord(record);
                };
                distilling = true;
                const result: DistillResult = await new Distiller({
                    library,
                    ask: (prompt: string, work: string, signal?: AbortSignal): Promise<string> =>
                        askClaude(config.claude, prompt, work, signal),
                    openBrowser: (): GameBrowser => {
                        const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: handle.baseUrl });
                        browsers.push(browser);
                        return browser;
                    },
                    python: pythonPath,
                }).distill({
                    gameId: game.id,
                    profileVersion: profile.version,
                    teacher: TeacherKind.RULES,
                    minRows: request.minRows,
                    gameSeconds,
                    parallel: 2,
                    rounds: request.rounds,
                    studentGames: 2,
                    epochs: 1,
                    // A version trained for real time learns its live states too: half its games with the lag it was trained for.
                    ...(profile.lagAware ? { lag: LIVE_LATENCY } : {}),
                    port: config.layaRuntime.port,
                    workDir: join(dir, "work"),
                    signal: abort.signal,
                    hooks: {
                        onLog: say,
                        onPhase: (detail: string): void => {
                            record.phase = detail;
                            hub.broadcast({ type: "phase", id: record.id, phase: detail });
                            tracker.onPhase(detail);
                            progressed();
                        },
                        play: { onTick: onTick(record) },
                    },
                });
                record.mean = result.student?.mean;
                record.status = RunStatus.DONE;
                record.version = result.profileVersion;
                tracker.finish();
                progressed();
                record.phase = `done: ${result.checkpoint.split("/").pop()}${result.student ? ` — Laya ${result.student.scores.join(", ")}` : ""}`;
                finish(record);
            } catch (err: unknown) {
                if (distilling && abort.signal.aborted) {
                    // The distiller ends a stop (Stop, the UI closing) by throwing: stopped, as a stopped play or training
                    // shows, not failed. A start that failed (no Python; the UI closing before its daemon) failed.
                    record.status = RunStatus.STOPPED;
                    record.phase = "stopped";
                    finish(record);
                } else {
                    finish(record, err);
                }
            } finally {
                await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
                hub.broadcast({ type: "library" });
            }
        })().catch(escaped(record));
        return record;
    };

    /**
     * Train with something to check (src/improve/): the engine on the clock checked; what loses fixed — Laya taught more,
     * Jev's instructions or the rules trained —, else the version trained for a higher score; checked again, and kept only
     * if it plays better.
     */
    const startCheckedTraining: (request: TrainRequest) => RunRecord = (request: TrainRequest): RunRecord => {
        const game: GameDefinition = library.game(request.gameId);
        const gameSeconds: number = request.gameSeconds ?? game.budgets.trainSeconds ?? game.budgets.gameSeconds;
        const record: RunRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            kind: RunKind.TRAIN,
            gameId: game.id,
            gameName: game.name,
            engine: `${request.engine}, the clock ${request.live ? "running" : "paused"}: checked`,
            status: RunStatus.RUNNING,
            phase: "starting",
            startedAt: Date.now(),
            settings: {
                episodes: 0,
                gameSeconds,
                iterations: request.iterations,
                ...(request.live ? { realtime: true } : {}),
                ...(request.note ? { note: request.note } : {}),
            },
            episodes: [],
            log: [],
            savedVersions: [],
            improve: { engine: request.engine, live: request.live },
        };
        const { abort, dir }: { abort: AbortController; dir: string } = begin(record);
        void (async (): Promise<void> => {
            const browsers: DevtoolsClient[] = [];
            // What the run is doing, how much of it is done and how long the stage may take: its checks' games, the fix's stages.
            const tracker: ImproveTracker = new ImproveTracker();
            const progressed: () => void = (): void => {
                record.progress = tracker.progress;
                hub.broadcast({ type: "progress", id: record.id, progress: record.progress });
            };
            progressed();
            const say: (line: string) => void = (line: string): void => {
                record.log?.push(line);
                hub.broadcast({ type: "log", id: record.id, line });
                saveRecord(record);
            };
            /** A line of the fix's training or distillation: logged, and read by its stage tracker. */
            const fixLine: (feed: (line: string) => void) => (line: string) => void =
                (feed: (line: string) => void): ((line: string) => void) =>
                    (line: string): void => {
                        feed(line);
                        progressed();
                        say(line);
                    };
            const summary: (report: CheckReport) => CheckSummary = (report: CheckReport): CheckSummary => ({
                verdict: report.verdict,
                why: report.why,
                version: report.version,
                played: report.played.means,
                ...(report.rules ? { rules: report.rules.means } : {}),
                ...(report.slow ? { slow: report.slow.means } : {}),
                worseSeeds: report.worseSeeds,
            });
            try {
                const handle: DaemonHandle = await starting(ensureRunDaemon());
                const openBrowser: () => GameBrowser = (): GameBrowser => {
                    const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: handle.baseUrl });
                    browsers.push(browser);
                    return browser;
                };
                const engines: ImproveEngines = {
                    engineFor: async (kind: EngineKind, version: number | undefined): Promise<{ engine: DecisionEngine; profileVersion: number }> => {
                        if (kind === EngineKind.LAYA) {
                            const setup: LayaSetup = await (await layaServers()).engineFor(game.id, version);
                            return { engine: setup.engine, profileVersion: setup.profileVersion };
                        }
                        const profile: Profile | undefined = library.profile(game.id, version);
                        if (!profile) {
                            throw new Error(`${game.name} has no profile yet: train it first`);
                        }
                        return { engine: kind === EngineKind.RULES ? new RulesTeacher(profile) : engineFor(EngineKind.JEV), profileVersion: profile.version };
                    },
                    // The UI's own Laya server holds the port a distillation serves its student on.
                    release: stopLaya,
                };
                const result: ImproveResult = await new Improver({
                    library,
                    openBrowser,
                    engines,
                    train: (o: TrainOptions): Promise<TrainResult> => new Trainer({ library, engine: engineFor(EngineKind.JEV), openBrowser, trainer: config.claude }).train(o),
                    distill: (o: DistillOptions): Promise<DistillResult> =>
                        new Distiller({
                            library,
                            ask: (prompt: string, work: string, signal?: AbortSignal): Promise<string> => askClaude(config.claude, prompt, work, signal),
                            openBrowser,
                            python: config.layaRuntime.python,
                        }).distill(o),
                    distillDefaults: { teacher: TeacherKind.RULES, minRows: 12_000, gameSeconds, parallel: 2, epochs: 1, port: config.layaRuntime.port },
                }).improve({
                    gameId: game.id,
                    engine: request.engine,
                    live: request.live,
                    iterations: request.iterations,
                    ...(request.note ? { note: request.note } : {}),
                    ...(request.version !== undefined ? { version: request.version } : {}),
                    workDir: join(dir, "work"),
                    signal: abort.signal,
                    hooks: {
                        onLog: say,
                        onPhase: (detail: string): void => {
                            record.phase = detail;
                            hub.broadcast({ type: "phase", id: record.id, phase: detail });
                            tracker.onPhase(detail);
                            progressed();
                            saveRecord(record);
                        },
                        onCheckStart: (when: "before" | "after", games: number): void => {
                            tracker.onCheckStart(when, games);
                            progressed();
                        },
                        onGame: (side: string, g: CheckGame): void => {
                            tracker.onGame();
                            progressed();
                            say(
                                `  ${side}, seed ${g.seed}: ${g.score} in ${g.seconds} s${g.lagMs !== undefined ? `, inputs at ${g.lagMs} ms` : ""}${g.engineMs !== undefined ? ` (${g.engineMs} ms a decision)` : ""}` +
                                    `${g.disagreements ? ` (${g.disagreements} decisions otherwise than the rules)` : ""}`
                            );
                        },
                        onTick: onTick(record),
                        onCheck: (when: "before" | "after", report: CheckReport): void => {
                            record.improve = { engine: request.engine, live: request.live, ...record.improve, [when]: summary(report) };
                            tracker.onCheck(when, report.verdict, report.why);
                            progressed();
                            publish(record);
                        },
                        train: {
                            onLog: fixLine((line: string): void => tracker.onTrainLog(line)),
                            onPhase: (detail: string): void => {
                                tracker.onTrainPhase(detail);
                                progressed();
                            },
                            play: { onTick: onTick(record) },
                            onSaved: (profile: Profile): void => {
                                record.savedVersions?.push(profile.version);
                                hub.broadcast({ type: "library" });
                            },
                        },
                        distill: {
                            onLog: fixLine((line: string): void => tracker.onDistillLog(line)),
                            onPhase: (detail: string): void => {
                                tracker.onDistillPhase(detail);
                                progressed();
                                say(`— ${detail}`);
                            },
                            play: { onTick: onTick(record) },
                        },
                    },
                });
                record.improve = { engine: request.engine, live: request.live, ...record.improve, outcome: result.outcome, done: result.done };
                tracker.finish(result.outcome);
                progressed();
                record.version = result.version;
                // As it plays now: the check after the fix when it was kept, else the one before it.
                const now: number[] = Object.values((result.outcome === ImproveOutcome.IMPROVED && result.after ? result.after : result.before).played.means);
                if (now.length) {
                    record.mean = Number((now.reduce((a: number, b: number): number => a + b, 0) / now.length).toFixed(1));
                }
                record.status = result.outcome === ImproveOutcome.STOPPED ? RunStatus.STOPPED : RunStatus.DONE;
                record.phase = `${result.outcome}${result.done.length ? `: ${result.done.join("; ")}` : ""}`;
                finish(record);
            } catch (err: unknown) {
                if (abort.signal.aborted) {
                    // A stop part way (a distillation throws on one) is a stop: what the fix did is undone.
                    record.status = RunStatus.STOPPED;
                    record.phase = "stopped";
                    finish(record);
                } else {
                    finish(record, err);
                }
            } finally {
                await Promise.all(browsers.map((b: DevtoolsClient): Promise<void> => b.close()));
                hub.broadcast({ type: "library" });
            }
        })().catch(escaped(record));
        return record;
    };

    /** Train: checked and fixed when there is something to check, else a training starts there (why: in its log). */
    const startTrain: (request: TrainRequest) => RunRecord = (request: TrainRequest): RunRecord => {
        const nothingYet: string | undefined = nothingToCheck(library, library.game(request.gameId), request.engine, request.live, request.version);
        return nothingYet !== undefined ? startTraining(request, nothingYet) : startCheckedTraining(request);
    };

    /**
     * The run a POST /api/runs asks for, read and checked but not begun: its every wait (Jev's health, for a training
     * Jev decides; Laya's Python, for a distillation) is here, so the run begins right after the one-run-at-a-time check,
     * with nothing awaited between.
     */
    const runStarter: (body: Record<string, unknown>) => Promise<() => RunRecord> = async (body: Record<string, unknown>): Promise<() => RunRecord> => {
        if (body.kind === RunKind.DISTILL) {
            const version: number | undefined = versionOf(body.version);
            const request: DistillRequest = {
                gameId: String(body.gameId ?? ""),
                rounds: intIn(body.rounds, "rounds", 0, 10, 1),
                minRows: intIn(body.minRows, "minRows", 100, 1_000_000, 12_000),
                ...(version !== undefined ? { version } : {}),
            };
            // A game that is not there is a 404, one without a profile a 400 saying so, before anything is checked.
            const game: GameDefinition = library.game(request.gameId);
            const profile: Profile | undefined = library.profile(game.id, request.version);
            if (!profile) {
                throw new Error(`${game.name} has no profile yet: train it first`);
            }
            // Laya learns on this machine: without its Python the run would begin, and fail at its start.
            const python: { ok: boolean; detail: string } = await checkLaya();
            if (!python.ok) {
                throw new Error(`${python.detail} (or set IBGAMER_LAYA_PYTHON)`);
            }
            // The version it learns (the one asked for — a version the live clock plays —, else the active one) without its rules as code: the trainer writes them first — without its
            // CLI the run would stop there, after its daemon started.
            if (!profile.teacher) {
                const trainer: EngineHealth = trainerHealth(config.claude);
                if (!trainer.ok) {
                    throw new Error(`The trainer is not ready: ${trainer.detail} (${game.name} v${profile.version} has no rules as code, and the trainer writes them first)`);
                }
            }
            // A distillation in another process (the CLI) holds the port the distiller serves its students on: a 409 naming
            // it, as a play's, before a run begins (the distiller refuses it too, should one take the port meanwhile).
            refuseHeldLayaPort(layaPortLockFile(library, config.layaRuntime.port), config.layaRuntime.port);
            return (): RunRecord => startDistill(request);
        }
        if (body.kind === RunKind.TRAIN) {
            const engine: unknown = body.engine ?? config.engine.kind;
            if (!Object.values(EngineKind).includes(engine as EngineKind)) {
                throw new Error(`engine must be one of ${Object.values(EngineKind).join(", ")}`);
            }
            const version: number | undefined = versionOf(body.version);
            const request: TrainRequest = {
                gameId: String(body.gameId ?? ""),
                iterations: intIn(body.iterations, "iterations", 1, 20, 3),
                ...(body.gameSeconds !== undefined && body.gameSeconds !== "" ? { gameSeconds: intIn(body.gameSeconds, "gameSeconds", 1, 3_600, 45) } : {}),
                engine: engine as EngineKind,
                // The clock chosen: running (`live`; `realtime`, a training for real time, says the same).
                live: body.live === true || body.realtime === true,
                ...(version !== undefined ? { version } : {}),
                ...noteOf(body.note),
            };
            // A game that is not there is a 404 before any engine is looked at.
            const game: GameDefinition = library.game(request.gameId);
            // Real time is for an engine that answers in tens of ms: Jev's hundreds would train a profile for play no one offers.
            if (request.live && trainDecider(request.engine) === Decider.ENGINE) {
                throw new Error("Jev answers in hundreds of ms, and no game is played live with it: train for real time with Laya or Rules (code)");
            }
            // A version asked for that the game does not have: refused here (a 400), not after the run began.
            nothingToCheck(library, game, request.engine, request.live, request.version);
            // For Laya, Laya learns on this machine (its Python, the port its student is served on); with no model of the
            // version it plays yet, it learns that version alone — the trainer only for rules it has to write first. Anything
            // to check needs the trainer: a fix may train.
            const alone: number | undefined = request.engine === EngineKind.LAYA ? layaToTeach(library, game, request.live) : undefined;
            if (request.engine === EngineKind.LAYA) {
                const python: { ok: boolean; detail: string } = await checkLaya();
                if (!python.ok) {
                    throw new Error(`${python.detail} (or set IBGAMER_LAYA_PYTHON)`);
                }
                refuseHeldLayaPort(layaPortLockFile(library, config.layaRuntime.port), config.layaRuntime.port);
            }
            // Without it a training would play every measuring game, then fail each tuning and end "done".
            if (alone === undefined || !library.profile(game.id, alone)?.teacher) {
                const trainer: EngineHealth = trainerHealth(config.claude);
                if (!trainer.ok) {
                    throw new Error(`The trainer is not ready: ${trainer.detail}`);
                }
            }
            // Jev deciding, a training without it would run its setup (minutes, tokens) and then fail every decision.
            if (trainDecider(request.engine) === Decider.ENGINE) {
                const jev: DecisionEngine = engineFor(EngineKind.JEV);
                const health: EngineHealth = await jev.health();
                if (!health.ok) {
                    throw new Error(`${jev.label} is not ready: ${health.detail}`);
                }
            }
            return (): RunRecord => startTrain(request);
        }
        const request: PlayRequest = parsePlayRequest(body, library, config.engine.kind);
        return (): RunRecord => startPlay(request);
    };

    const status: () => Promise<Record<string, unknown>> = async (): Promise<Record<string, unknown>> => {
        const engines: Record<string, EngineHealth & { python?: EngineHealth }> = {};
        engines[EngineKind.JEV] = await engineFor(EngineKind.JEV).health();
        const python: { ok: boolean; detail: string } = await checkLaya();
        // A game whose checkpoints all learnt an earlier state of their version has none a play can take.
        const trained: string[] = library.ids().filter((id: string): boolean => currentCheckpoints(library, id).length > 0);
        engines[EngineKind.LAYA] = {
            ...(!python.ok
                ? python
                : trained.length
                    ? { ok: true, detail: `local, fine-tuned for ${trained.join(", ")}` }
                    : { ok: false, detail: "no game has a fine-tuned checkpoint yet (ibgamer laya distill <game>)" }),
            // Apart: choosing Laya for a new game needs only its Python (the checkpoint comes with the distillation).
            python,
        };
        engines[EngineKind.RULES] = { ok: true, detail: "the profile's rules as code (teach), written by the trainer: instant, on this machine" };
        return {
            defaultEngine: config.engine.kind,
            engines,
            trainer: trainerHealth(config.claude),
            running: current ? current.record.id : null,
        };
    };

    const gameDetail: (id: string) => Record<string, unknown> = (id: string): Record<string, unknown> => {
        const game: GameDefinition = library.game(id);
        const profile: Profile | undefined = library.profile(id);
        const profiles: ProfileSummary[] = library.profiles(id);
        return {
            game,
            source: library.sourceOf(id),
            profiles,
            active: profile ?? null,
            // The ways it is played (its own configs, else those its versions earn), and how ready it is to be played live.
            configs: playConfigs(game, profiles),
            live: liveReadiness(profiles),
            hasThumbnail: library.file(id, "thumbnail.png") !== undefined,
            // The checkpoints a play can take (the UI offers Laya, and locks the version, by these).
            laya: currentCheckpoints(library, id).map((c: { name: string; training?: Record<string, unknown> }): Record<string, unknown> => ({ name: c.name, training: c.training ?? null })),
        };
    };

    const server: Server = createHttpServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const parsed: string | undefined = requestPath(req.url);
        if (parsed === undefined) {
            sendJson(res, 400, { error: "bad request target" });
            return;
        }
        const path: string = parsed;
        try {
            if (!ownHost(req.headers.host)) {
                sendJson(res, 403, { error: "unknown host" });
                return;
            }
            if (req.method !== "GET" && req.method !== "HEAD" && !ownOrigin(req.headers.origin, req.headers.host)) {
                sendJson(res, 403, { error: "cross-origin request refused" });
                return;
            }
            if (req.method === "GET" && !path.startsWith("/api/")) {
                const name: string = path === "/" ? "index.html" : path.slice(1);
                const file: string = join(UI_DIR, name);
                if (/^[\w.-]+$/.test(name) && STATIC_TYPES[extname(name)] && existsSync(file)) {
                    res.writeHead(200, { "content-type": STATIC_TYPES[extname(name)], "cache-control": "no-store" });
                    res.end(readFileSync(file));
                    return;
                }
                sendJson(res, 404, { error: "not found" });
                return;
            }
            let m: RegExpExecArray | null;
            if (req.method === "GET" && path === "/api/status") {
                sendJson(res, 200, await status());
            } else if (req.method === "GET" && path === "/api/games") {
                // A card's Laya mark by the checkpoints a play can take: the library counts any checkpoint on disk.
                const games: GameSummary[] = library.list().map((g: GameSummary): GameSummary => ({ ...g, hasLaya: currentCheckpoints(library, g.id).length > 0 }));
                sendJson(res, 200, { games });
            } else if (req.method === "GET" && (m = /^\/api\/games\/([a-z0-9-]+)$/.exec(path))) {
                sendJson(res, 200, gameDetail(m[1]));
            } else if (req.method === "GET" && (m = /^\/api\/games\/([a-z0-9-]+)\/thumbnail$/.exec(path))) {
                const file: string | undefined = library.file(m[1], "thumbnail.png") ?? library.file(m[1], "samples/screenshot.png");
                if (!file) {
                    sendJson(res, 404, { error: "no picture" });
                    return;
                }
                serveFile(res, file, "image/png");
            } else if (req.method === "GET" && (m = /^\/api\/games\/([a-z0-9-]+)\/profiles\/(\d+)$/.exec(path))) {
                sendJson(res, 200, { profile: library.profile(m[1], Number(m[2])) ?? null });
            } else if (req.method === "POST" && (m = /^\/api\/games\/([a-z0-9-]+)\/active$/.exec(path))) {
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                library.setActive(m[1], intIn(body.version, "version", 1, 1_000_000, 1));
                hub.broadcast({ type: "library" });
                sendJson(res, 200, gameDetail(m[1]));
            } else if (req.method === "POST" && path === "/api/games") {
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                const id: string = String(body.id ?? "");
                if (library.has(id)) {
                    sendJson(res, 409, { error: `the library already has a game ${id}` });
                    return;
                }
                // What a removed game left under the id (its profiles, checkpoints) would become the new game's.
                if (library.hasUserPart(id)) {
                    sendJson(res, 409, {
                        error: `your library still has files of an earlier game ${id} (${join(library.userDir, id)}): remove them first (ibgamer library remove ${id}) or choose another id`,
                    });
                    return;
                }
                let game: GameDefinition;
                try {
                    game = library.saveGame(body as unknown as GameDefinition);
                } catch (err: unknown) {
                    // A definition the library refuses is the request's fault: the error names the field.
                    if (err instanceof InvalidDefinitionError) {
                        sendJson(res, 400, { error: err.message });
                        return;
                    }
                    throw err;
                }
                hub.broadcast({ type: "library" });
                sendJson(res, 201, gameDetail(game.id));
            } else if (req.method === "POST" && path === "/api/probe") {
                if (current) {
                    sendJson(res, 409, { error: "a run is in progress" });
                    return;
                }
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                const target: string = String(body.url ?? "");
                if (!/^https?:\/\//.test(target)) {
                    sendJson(res, 400, { error: "url must be an http(s) URL" });
                    return;
                }
                const handle: DaemonHandle = await ensureRunDaemon();
                const browser: DevtoolsClient = new DevtoolsClient({ baseUrl: handle.baseUrl });
                try {
                    // The boot the added game is saved with (the wizard's `bootMs`): its start is picked on this picture.
                    await browser.open({ url: target, adapters: [Adapter.PROBE], freezeClock: false, bootMs: PROBE_BOOT_MS });
                    const probe: ProbeResult = await browser.probe();
                    // What the page looks like, for the person adding it: where it starts, what it is.
                    const dir: string = join(config.runsDir, "probes");
                    mkdirSync(dir, { recursive: true });
                    const shot: string | undefined = await browser.screenshot(dir, "probe").catch((): undefined => undefined);
                    sendJson(res, 200, { probe, ...(shot ? { screenshot: `/api/probes/${basename(shot)}` } : {}) });
                } finally {
                    await browser.close();
                }
            } else if (req.method === "POST" && path === "/api/reader") {
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                const target: string = String(body.url ?? "");
                if (!/^https?:\/\//.test(target)) {
                    sendJson(res, 400, { error: "url must be an http(s) URL" });
                    return;
                }
                const vp: { width?: unknown; height?: unknown } | undefined = body.viewport as { width?: unknown; height?: unknown } | undefined;
                const viewport: { width: number; height: number } | undefined =
                    vp && typeof vp.width === "number" && typeof vp.height === "number" ? { width: intIn(vp.width, "width", 100, 4000, 1280), height: intIn(vp.height, "height", 100, 4000, 720) } : undefined;
                sendJson(res, 202, { reader: startReader(target, viewport) });
            } else if (req.method === "GET" && (m = /^\/api\/reader\/([\w-]+)$/.exec(path))) {
                const job: ReaderJob | undefined = readers.get(m[1]);
                if (!job) {
                    sendJson(res, 404, { error: "no such reader" });
                    return;
                }
                sendJson(res, 200, { reader: job });
            } else if (req.method === "GET" && (m = /^\/api\/probes\/([\w.-]+\.png)$/.exec(path))) {
                const file: string = join(config.runsDir, "probes", m[1]);
                if (!existsSync(file)) {
                    sendJson(res, 404, { error: "no such screenshot" });
                    return;
                }
                serveFile(res, file, "image/png");
            } else if (req.method === "POST" && path === "/api/laya/warm") {
                // Laya was chosen for a game: its server starts now, so Play does not wait for it — with the checkpoint
                // Play will take, the version sent as Play sends it (a config's; none: the active one's checkpoint).
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                const gameId: string = String(body.gameId ?? "");
                let version: number | undefined;
                try {
                    version = versionOf(body.version);
                } catch (err: unknown) {
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                    return;
                }
                // What the play would find: a checkpoint that learnt the version as it is now (LayaServers).
                if (!library.has(gameId) || !checkpointFor(currentCheckpoints(library, gameId), version, library.activeVersion(gameId))) {
                    sendJson(res, 404, { error: `${gameId}${version !== undefined ? ` v${version}` : ""} has no Laya checkpoint` });
                    return;
                }
                // Not while a run is in progress, nor on a port a distillation in another process holds (Play says so):
                // skipped quietly, and the page asks again at its next change.
                const warming: boolean = !current && layaPortHeldByOther(layaPortLockFile(library, config.layaRuntime.port)) === undefined;
                if (warming) {
                    void layaServers()
                        .then((servers: LayaServers): Promise<LayaSetup> => servers.engineFor(gameId, version))
                        .catch((): undefined => undefined);
                }
                sendJson(res, 202, { warming });
            } else if (req.method === "GET" && path === "/api/runs") {
                sendJson(res, 200, { runs, current: current?.record.id ?? null });
            } else if (req.method === "POST" && path === "/api/runs") {
                if (current) {
                    sendJson(res, 409, { error: "a run is in progress" });
                    return;
                }
                const body: Record<string, unknown> = (await readJson(req)) as Record<string, unknown>;
                let record: RunRecord;
                try {
                    const start: () => RunRecord = await runStarter(body);
                    // Again: another request's run may have begun while this one's body arrived or its engine was
                    // checked. From here to the run's begin() nothing is awaited.
                    if (current) {
                        sendJson(res, 409, { error: "a run is in progress" });
                        return;
                    }
                    record = start();
                } catch (err: unknown) {
                    // The Laya port another process holds is busy, as a run in progress is: a 409.
                    const code: number = err instanceof GameNotFoundError ? 404 : err instanceof LayaPortHeldError ? 409 : 400;
                    sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
                    return;
                }
                sendJson(res, 202, { run: record });
            } else if (req.method === "POST" && path === "/api/runs/stop") {
                current?.abort.abort();
                sendJson(res, 200, { stopping: Boolean(current) });
            } else if (req.method === "GET" && (m = /^\/api\/runs\/([\w-]+)\/video$/.exec(path))) {
                const record: RunRecord | undefined = runs.find((r: RunRecord): boolean => r.id === m![1]);
                const file: string | undefined = record?.video ? runStore.file(record.id, record.video) : undefined;
                if (!file) {
                    sendJson(res, 404, { error: "no video" });
                    return;
                }
                serveVideo(res, file, req.headers.range);
            } else if (req.method === "GET" && (m = /^\/api\/runs\/([\w-]+)\/files\/([\w][\w.-]*(?:\/[\w][\w.-]*)*)$/.exec(path))) {
                // A path in the run's folder: a training's end screens are under work/shots-<version>/.
                const file: string | undefined = runStore.file(m[1], m[2]);
                const type: string | undefined = IMAGE_TYPES[extname(m[2])];
                if (!file || !type) {
                    sendJson(res, 404, { error: "no such file" });
                    return;
                }
                serveFile(res, file, type);
            } else {
                sendJson(res, 404, { error: "not found" });
            }
        } catch (err: unknown) {
            if (!res.headersSent) {
                sendJson(res, err instanceof GameNotFoundError ? 404 : 500, { error: err instanceof Error ? err.message : String(err) });
            } else {
                res.destroy();
            }
        }
    });

    const viewers: WebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const producers: WebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const path: string | undefined = requestPath(req.url);
        if (path === "/live/producer" && req.headers.authorization === `Bearer ${token}`) {
            producers.handleUpgrade(req, socket, head, (ws: WebSocket): void => hub.addProducer(ws));
        } else if (path === "/ws" && ownHost(req.headers.host) && ownOrigin(req.headers.origin, req.headers.host)) {
            viewers.handleUpgrade(req, socket, head, (ws: WebSocket): void => {
                hub.addViewer(ws);
                ws.send(JSON.stringify({ type: "hello", run: current?.record ?? runs[0] ?? null }));
            });
        } else {
            socket.destroy();
        }
    });

    await new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
        server.once("error", reject);
        server.listen(port, host, (): void => resolve());
    });

    return {
        url: `http://${ownAddress}`,
        close: async (): Promise<void> => {
            closing = true;
            current?.abort.abort();
            for (const work of readerWork) {
                work.abort.abort();
            }
            hub.closeAll();
            await new Promise<void>((resolve: () => void): void => {
                server.close((): void => resolve());
            });
            await Promise.all([
                // The readers' daemons, one still starting once it is up: an aborted reader ends on its stopped browser.
                ...[...readerWork].map(async (work: { daemon: Promise<DaemonHandle | undefined> }): Promise<void> => {
                    await (await work.daemon)?.stop().catch((): void => undefined);
                }),
                // A run still starting (its Laya server, its Python check) gets no daemon now, and ends saying so.
                ...runStarts,
            ]);
            // A daemon still starting is stopped too, once it is up.
            await daemonStart?.catch((): undefined => undefined);
            await daemon?.stop();
            await stopLaya();
        },
    };
}

/** Which perception adapter a probe suggests, as the library names it. */
export function perceptionFor(suggested: string | undefined): Perception | undefined {
    return suggested === "canvas2d"
        ? Perception.CANVAS2D
        : suggested === "phaser"
            ? Perception.PHASER
            : suggested === "pixi"
                ? Perception.PIXI
                : suggested === "cocos"
                    ? Perception.COCOS
                    : suggested === "pixels"
                        ? Perception.PIXELS
                        : undefined;
}
