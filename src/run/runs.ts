/**
 * A run's record: what was played or trained, how it went, where its video
 * and screenshots are. Kept as `<runsDir>/<id>/run.json` beside them, so the
 * UI lists past runs after a restart.
 */

import type { RunProgress } from "./progress";
import { EpisodeResult } from "../play/player";

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import path from "path";

export enum RunKind {
    PLAY = "play",
    TRAIN = "train",
    /** Jev teaches, Laya learns: a local checkpoint for the game. */
    DISTILL = "distill",
}

export enum RunStatus {
    RUNNING = "running",
    DONE = "done",
    STOPPED = "stopped",
    FAILED = "failed",
}

/** One episode as a run record keeps it: the numbers, not the ticks. */
export interface EpisodeSummary {
    episode: number;
    seed?: number;
    score: number;
    over: boolean;
    gameSeconds: number;
    wallSeconds?: number;
    decisions: number;
    steps: number;
    engineMedianMs?: number;
    extractErrors: number;
    adviceFieldsDropped: number;
    actionCounts: Record<string, number>;
    /** The end screen's path in the run's directory (a training's are under work/shots-<version>/). */
    endScreenshot?: string;
    /** The profile version this episode played (training plays several). */
    version?: number;
}

export interface RunRecord {
    id: string;
    kind: RunKind;
    gameId: string;
    gameName: string;
    /** The profile version played (a training run: the one it started from). */
    version?: number;
    engine: string;
    status: RunStatus;
    phase: string;
    startedAt: number;
    endedAt?: number;
    settings: { episodes: number; gameSeconds: number; seeds?: number[]; pace?: string; iterations?: number; realtime?: boolean; note?: string; rounds?: number; minRows?: number };
    episodes: EpisodeSummary[];
    mean?: number;
    /** File name of the video in the run's directory. */
    video?: string;
    error?: string;
    /** Training: what each iteration did, as log lines. */
    log?: string[];
    /** Training: the versions it saved. */
    savedVersions?: number[];
    /** Training and distillation: how far it has got (its stages, the current one's share, the time left). */
    progress?: RunProgress;
}

/** A file's path in a run's directory, `/`-separated as the files route takes it; its name when the directory does not hold it. */
function pathInRun(file: string, runDir: string | undefined): string {
    const rel: string | undefined = runDir !== undefined ? path.relative(runDir, file) : undefined;
    return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : path.basename(file);
}

/** `runDir`: the run's directory, which the end screen's path is kept relative to. */
export function summarizeEpisode(result: EpisodeResult, version?: number, runDir?: string): EpisodeSummary {
    return {
        episode: result.episode,
        ...(result.seed !== undefined ? { seed: result.seed } : {}),
        score: result.score,
        over: result.over,
        gameSeconds: result.gameSeconds,
        wallSeconds: result.wallSeconds,
        decisions: result.decisions,
        steps: result.steps,
        ...(result.engineMedianMs !== undefined ? { engineMedianMs: result.engineMedianMs } : {}),
        extractErrors: result.extractErrors,
        adviceFieldsDropped: result.adviceFieldsDropped,
        actionCounts: result.actionCounts,
        ...(result.endScreenshot ? { endScreenshot: pathInRun(result.endScreenshot, runDir) } : {}),
        ...(version !== undefined ? { version } : {}),
    };
}

const RUN_ID: RegExp = /^[\w-]{6,80}$/;
/** A path in a run's directory: a few folders down at most, no part starting with a dot (no `..`). */
const RUN_FILE: RegExp = /^([\w][\w.-]{0,160}\/){0,3}[\w][\w.-]{0,160}$/;

export class RunStore {
    constructor(readonly dir: string) {}

    runDir(id: string): string {
        if (!RUN_ID.test(id)) {
            throw new Error(`Not a run id: ${id}`);
        }
        const dir: string = path.join(this.dir, id);
        mkdirSync(dir, { recursive: true });
        return dir;
    }

    save(record: RunRecord): void {
        const file: string = path.join(this.runDir(record.id), "run.json");
        const tmp: string = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(record, null, 2));
        renameSync(tmp, file);
    }

    /** A file of a run's (its video, a screenshot), by its path in the run's directory; never one a link takes out of it. */
    file(id: string, relPath: string): string | undefined {
        if (!RUN_ID.test(id) || !RUN_FILE.test(relPath)) {
            return undefined;
        }
        const dir: string = path.join(this.dir, id);
        const file: string = path.join(dir, relPath);
        if (!existsSync(file) || !statSync(file).isFile()) {
            return undefined;
        }
        const rel: string = path.relative(realpathSync(dir), realpathSync(file));
        return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? file : undefined;
    }

    /** The newest runs first. A run still marked running when read was cut short by an exit. */
    list(limit: number = 50): RunRecord[] {
        if (!existsSync(this.dir)) {
            return [];
        }
        const out: RunRecord[] = [];
        for (const entry of readdirSync(this.dir)) {
            const file: string = path.join(this.dir, entry, "run.json");
            if (!RUN_ID.test(entry) || !existsSync(file)) {
                continue;
            }
            try {
                const record: RunRecord = JSON.parse(readFileSync(file, "utf-8")) as RunRecord;
                if (record.status === RunStatus.RUNNING) {
                    record.status = RunStatus.STOPPED;
                    record.phase = "ended when the app stopped";
                }
                out.push(record);
            } catch {
                // an unreadable record is skipped
            }
        }
        return out.sort((a: RunRecord, b: RunRecord): number => b.startedAt - a.startedAt).slice(0, limit);
    }
}
