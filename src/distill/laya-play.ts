/**
 * Playing with Laya: a game's fine-tuned checkpoint for the profile version played (its states are
 * that extractor's), and a local server answering for it. A game can have one per version — the
 * paused clock played with one version, real time with another (a config pins it) — and each version
 * plays its own: the one whose student played best when it was distilled, of those that learnt the
 * version as it is now (`currentCheckpoints`).
 */

import { LayaEngine } from "../engine/laya";
import { Profile } from "../game/types";
import { Library } from "../library/store";
import { profileHash } from "../run/decision-log";
import { LayaCheckpoint, layaCheckpoints, layaPortLockFile, LayaServerHandle, layaServerServes, refuseHeldLayaPort, startLayaServer } from "./laya-runtime";

export interface LayaSetup {
    engine: LayaEngine;
    checkpoint: LayaCheckpoint;
    /** The profile version the checkpoint learned from. */
    profileVersion: number;
}

/** The profile version a checkpoint was trained for, from its name (`v<N>-<hash>-r<k>`). */
export function checkpointProfileVersion(checkpoint: LayaCheckpoint): number | undefined {
    const m: RegExpExecArray | null = /^v(\d+)-/.exec(checkpoint.name);
    return m ? Number(m[1]) : undefined;
}

/**
 * A game's checkpoints (newest first) that learnt their version as it is now: named with its current profile hash
 * (`v<N>-<hash>-r<k>`, the hash of its extractor, rules and actions). A version edited in place keeps its checkpoints,
 * but they learnt another extractor's states: they are not played (a version no longer there has none).
 */
export function currentCheckpoints(library: Library, gameId: string): LayaCheckpoint[] {
    const hashes: Map<number, string | undefined> = new Map();
    const hashOf: (version: number) => string | undefined = (version: number): string | undefined => {
        if (!hashes.has(version)) {
            let profile: Profile | undefined;
            try {
                profile = library.profile(gameId, version);
            } catch {
                profile = undefined;
            }
            hashes.set(version, profile ? profileHash(profile) : undefined);
        }
        return hashes.get(version);
    };
    return layaCheckpoints(library, gameId).filter((c: LayaCheckpoint): boolean => {
        const m: RegExpExecArray | null = /^v(\d+)-([0-9a-f]+)-/.exec(c.name);
        return m !== null && m[2] === hashOf(Number(m[1]));
    });
}

/**
 * The checkpoint Laya plays with (checkpoints newest first): the version asked for's, none when that version
 * has none; no version asked for, the active version's, else the one of the newest checkpoint's version. Of a
 * version's checkpoints, the one whose student played best when it was distilled (its recorded mean; the newest
 * at a tie), the newest only when none was measured: a round a stopped or failed distillation left behind was
 * never measured, and must not take the place of one that was.
 */
export function checkpointFor(checkpoints: LayaCheckpoint[], version: number | undefined, activeVersion: number | undefined): LayaCheckpoint | undefined {
    const of: (v: number) => LayaCheckpoint | undefined = (v: number): LayaCheckpoint | undefined => {
        const own: LayaCheckpoint[] = checkpoints.filter((c: LayaCheckpoint): boolean => checkpointProfileVersion(c) === v);
        const measured: LayaCheckpoint | undefined = own.reduce(
            (best: LayaCheckpoint | undefined, c: LayaCheckpoint): LayaCheckpoint | undefined =>
                c.studentMean !== undefined && (best?.studentMean === undefined || c.studentMean > best.studentMean) ? c : best,
            undefined
        );
        return measured ?? own[0];
    };
    if (version !== undefined) {
        return of(version);
    }
    const active: LayaCheckpoint | undefined = activeVersion !== undefined ? of(activeVersion) : undefined;
    const newest: number | undefined = checkpoints.length ? checkpointProfileVersion(checkpoints[0]) : undefined;
    return active ?? (newest !== undefined ? of(newest) : checkpoints[0]);
}

/**
 * What `laya serve` serves (model name → directory): each game's checkpoint a Laya play takes with no version
 * asked for (checkpointFor) — a server holding another version's would be refused by the players.
 */
export function checkpointsToServe(library: Library, gameIds: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of gameIds) {
        const checkpoint: LayaCheckpoint | undefined = checkpointFor(currentCheckpoints(library, id), undefined, library.activeVersion(id));
        if (checkpoint) {
            out[id] = checkpoint.dir;
        }
    }
    return out;
}

/**
 * Keeps one local Laya server, for the checkpoint last asked for only: a checkpoint is ~650 MB and more
 * on the GPU, and one kept for every game played held 8 GB — and failed to start once one of them had
 * been removed from the library. Another game, another version, or another checkpoint (one that played
 * better, one made again) restarts it (a few seconds). The UI and the CLI share this. A port another
 * process holds (a distillation's lock) is refused: plays never take it.
 */
export class LayaServers {
    private server?: LayaServerHandle;
    /** One start at a time: two requests at once must not start two servers on one port. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly library: Library,
        private readonly python: string,
        private readonly port: number
    ) {}

    /** Laya for a game: for `version` (a config pins one, a player chose one), else for the active version (see checkpointFor). */
    engineFor(gameId: string, version?: number): Promise<LayaSetup> {
        const next: Promise<LayaSetup> = this.queue.then((): Promise<LayaSetup> => this.setUp(gameId, version));
        this.queue = next.catch((): undefined => undefined);
        return next;
    }

    private async setUp(gameId: string, version: number | undefined): Promise<LayaSetup> {
        const checkpoints: LayaCheckpoint[] = currentCheckpoints(this.library, gameId);
        const checkpoint: LayaCheckpoint | undefined = checkpointFor(checkpoints, version, this.library.activeVersion(gameId));
        if (!checkpoint) {
            throw new Error(
                version !== undefined && checkpoints.length
                    ? `${gameId} v${version} has no Laya checkpoint: distill one (ibgamer laya distill ${gameId} --profile-version ${version})`
                    : `${gameId} has no Laya checkpoint yet: distill one (ibgamer laya distill ${gameId})`
            );
        }
        const profileVersion: number | undefined = checkpointProfileVersion(checkpoint);
        if (profileVersion === undefined) {
            throw new Error(`${checkpoint.dir}: not a checkpoint name this app wrote (v<N>-<hash>-r<k>)`);
        }
        const wanted: Record<string, string> = { [gameId]: checkpoint.dir };
        // A distillation or an evaluation in another process holds the port for hours: a server started or kept here
        // would stand where its next student is served. Refused, naming it.
        refuseHeldLayaPort(layaPortLockFile(this.library, this.port), this.port);
        // Another checkpoint, or a server that stopped answering (it ran out of memory, it was killed): started
        // again. What the server reports it loaded decides: one found on the port was reused, not started here,
        // and holding another checkpoint it is refused (startLayaServer), never played.
        if (!this.server || !(await layaServerServes(this.server.url, wanted))) {
            await this.server?.stop();
            this.server = undefined;
            this.server = await startLayaServer({ python: this.python, port: this.port, checkpoints: wanted });
        }
        return { engine: new LayaEngine({ url: this.server.url, model: gameId }), checkpoint, profileVersion };
    }

    stop(): Promise<void> {
        const next: Promise<void> = this.queue.then(async (): Promise<void> => {
            await this.server?.stop();
            this.server = undefined;
        });
        this.queue = next.catch((): undefined => undefined);
        return next;
    }
}
