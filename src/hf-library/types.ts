/**
 * The shared library on Hugging Face (docs/claude-md/library.md): one model repo, a folder a game — what plays it,
 * nothing more: its definition, its profile versions, windows and samples, and Laya's checkpoints of the versions its
 * configs play. A library pulls a game from it and plays it at once, trained.
 */

import { EngineKind } from "../engine/types";

/** The repo's layout: a reader refuses a newer one. */
export const HF_LIBRARY_FORMAT: number = 1;

/** The repo the library is shared in, unless IBGAMER_HF_REPO names another. */
export const DEFAULT_HF_REPO: string = "ironbee-ai/ironbee-gamer-library";

/** A file of the repo, as the index lists it: a pull checks every one it downloads against it. */
export interface HfFile {
    /** Its path in the repo (`games/<id>/…`). */
    path: string;
    size: number;
    sha256: string;
}

/** How a game is played, as its configs say: the version, the floor live, Laya's checkpoint, and how it scored. */
export interface HfPlay {
    engine: EngineKind;
    live: boolean;
    version?: number;
    lagMs?: number;
    /** Laya: the checkpoint that plays it (`v<N>-<hash>-r<k>`). */
    checkpoint?: string;
    /** Its mean on the version's seeds: Laya's student as distilled, else the version's results (live: in real time). */
    mean?: number;
}

/** A game of the repo. */
export interface HfGame {
    id: string;
    name: string;
    url: string;
    goal: string;
    scoreLabel: string;
    activeVersion?: number;
    versions: number[];
    plays: HfPlay[];
    files: HfFile[];
    /** Every file's bytes. */
    size: number;
    pushedAt: string;
}

/** The repo's `index.json`: every game in it. */
export interface HfIndex {
    format: number;
    updatedAt: string;
    games: HfGame[];
}

/** Where a pull found the repo: the commit its index came from, and every file of a game is read at that commit. */
export interface HfSource {
    /** https://huggingface.co, unless HF_ENDPOINT names another. */
    endpoint: string;
    repo: string;
    revision: string;
    /** HF_TOKEN, else the Hugging Face CLI's (`hf auth login`): a private repo is read with it. */
    token?: string;
}

/** What a pull writes into the game's folder (`hf.json`): where it came from and every file it wrote. */
export interface HfInstalled {
    repo: string;
    commit: string;
    pushedAt: string;
    files: HfFile[];
}
