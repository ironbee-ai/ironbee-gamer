/**
 * The decisions an engine made while playing, kept as distillation data: every
 * row is a state, the question as asked and the engine's probabilities over the
 * actions — the soft target a small local model (Laya) is fine-tuned on, so the
 * hosted engine teaches and the local one plays.
 *
 * One file per profile version and content (`decisions/v<N>-<hash>.jsonl` in the
 * user library): a state's shape is its extractor's, so rows of two extractors
 * never mix.
 */

import { Profile } from "../game/types";
import { Library } from "../library/store";
import { DecisionRecord } from "../play/player";
import { appendRow } from "../util/rows";

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import path from "path";

export interface DecisionRow extends DecisionRecord {
    engine: string;
    profileVersion: number;
    at: number;
}

export function profileHash(profile: Profile): string {
    return createHash("sha256")
        .update(JSON.stringify([profile.extractor, profile.instructions, profile.actions]))
        .digest("hex")
        .slice(0, 8);
}

export class DecisionLog {
    readonly file: string;
    private readonly strict: boolean;

    /**
     * `kind`: another teacher's rows beside the engine's (`rules` → `v<N>-<hash>.rules.jsonl`). `strict`: a row that cannot
     * be written throws — a distillation's data, where a rows file that cannot be written stops the run —; a play's log
     * never stops its game.
     */
    constructor(
        library: Library,
        gameId: string,
        private readonly profile: Profile,
        private readonly engine: string,
        kind?: string,
        options: { strict?: boolean } = {}
    ) {
        const dir: string = path.join(library.userDirFor(gameId), "decisions");
        mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, `v${profile.version}-${profileHash(profile)}${kind ? `.${kind}` : ""}.jsonl`);
        this.strict = options.strict === true;
    }

    /** Appends a decision as a row, whole or not at all (appendRow). */
    append(record: DecisionRecord): void {
        const row: DecisionRow = { ...record, engine: this.engine, profileVersion: this.profile.version, at: Date.now() };
        try {
            appendRow(this.file, row);
        } catch (err: unknown) {
            // A play's log never stops its game. A distillation's rows do: swallowed, they once went missing unsaid — a
            // read-only rules file labelled nothing and the run blamed the teacher; a full disk shrinks the data.
            if (this.strict) {
                throw err;
            }
        }
    }
}

/** The decision files a game has, with their sizes. */
export function decisionFiles(library: Library, gameId: string): Array<{ file: string; bytes: number }> {
    const dir: string = path.join(library.userDir, gameId, "decisions");
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir)
        .filter((f: string): boolean => f.endsWith(".jsonl"))
        .map((f: string): { file: string; bytes: number } => ({ file: path.join(dir, f), bytes: statSync(path.join(dir, f)).size }));
}
