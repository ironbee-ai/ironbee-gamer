/**
 * Regression tests, run offline: a new profile version must keep passing the
 * checks earlier failures pinned down. Each replays a saved window of raw
 * frames through the extractor from its first frame (fresh memory; the first
 * frames warm it up) and checks `expect` over the state — and over the
 * engine's decision when the test needs one, which costs a decision per
 * checked frame. Seconds, not a game. A frame the page could not be read on
 * in play (`unread`) is skipped as the player skipped it: no extract, no check.
 */

import { InvalidAnswerError } from "../engine";
import { RequestTooLargeError } from "../engine/systemone";
import { GameDefinition, GameAction, FailureWindow, Profile, RegressionTest } from "../game/types";
import { guardState } from "../play/guard";
import { Player } from "../play/player";
import { Extractor, Predicate, ScriptError } from "../play/sandbox";

/** Frames at the start of a window that only warm the extractor's memory up ("all" skips them). */
const WARM_UP_FRAMES: number = 3;

/**
 * Whether a decision that failed is the candidate failing its test: an answer that is no action, its teacher failing on the
 * state, or a state larger than the engine takes (its extractor made it). Any other — an engine that cannot be reached after
 * its client's retries (no connection, HTTP 401 or 5xx) — is no failure of the candidate's.
 */
function candidateFailed(err: unknown): boolean {
    return err instanceof InvalidAnswerError || err instanceof ScriptError || err instanceof RequestTooLargeError;
}

export interface TestResult {
    test: RegressionTest;
    pass: boolean;
    failedAt?: { frame: number; detail?: string; state?: unknown; choice?: string };
}

export async function runRegressionTests(
    game: GameDefinition,
    profile: Profile,
    tests: RegressionTest[],
    windows: (id: string) => FailureWindow | undefined,
    player: Player
): Promise<TestResult[]> {
    const ids: string[] = profile.actions.map((a: GameAction): string => a.id);
    const results: TestResult[] = [];
    for (const test of tests) {
        const window: FailureWindow | undefined = windows(test.window);
        if (!window) {
            results.push({ test, pass: false, failedAt: { frame: -1, detail: `no window ${test.window}` } });
            continue;
        }
        let expect: Predicate;
        let extractor: Extractor;
        try {
            expect = new Predicate(test.expect, ["state", "choice"]);
            extractor = new Extractor(profile.extractor);
        } catch (err: unknown) {
            results.push({ test, pass: false, failedAt: { frame: -1, detail: err instanceof Error ? err.message : String(err) } });
            continue;
        }
        const checked: Set<number> | undefined = test.ticks === "all" ? undefined : new Set(test.ticks);
        let failed: TestResult["failedAt"];
        for (let i: number = 0; i < window.rawFrames.length && !failed; i++) {
            // The player never gave the extractor a frame the page could not be read on: nor does the replay (its memory stays
            // as the player left it), and a test pinned to one checks nothing there — no state was made of it, nothing decided.
            if (window.frameInfo?.[i]?.unread) {
                continue;
            }
            let state: unknown;
            try {
                state = guardState(extractor.extract(window.rawFrames[i], window.frameInfo?.[i] ?? { lagMs: window.lagMs ?? 0 }), ids).state;
            } catch (err: unknown) {
                failed = { frame: i, detail: `the extractor threw: ${err instanceof Error ? err.message : String(err)}` };
                break;
            }
            if (checked ? !checked.has(i) : i < WARM_UP_FRAMES) {
                continue;
            }
            let choice: string | undefined;
            if (test.needsChoice) {
                try {
                    choice = (await player.decide(game, profile, state)).choice;
                } catch (err: unknown) {
                    // No failure of the candidate's is thrown: the iteration fails with it (the tuner was once sent a repair
                    // round for tests that failed only because an engine outage gave no decision).
                    if (!candidateFailed(err)) {
                        throw err;
                    }
                    failed = { frame: i, detail: `no decision: ${err instanceof Error ? err.message : String(err)}`, state };
                    break;
                }
            }
            let ok: boolean;
            try {
                ok = expect.test(state, choice);
            } catch (err: unknown) {
                ok = false;
                failed = { frame: i, detail: `expect threw: ${err instanceof Error ? err.message : String(err)}`, state };
                break;
            }
            if (!ok) {
                failed = { frame: i, state, ...(choice !== undefined ? { choice } : {}) };
            }
        }
        results.push({ test, pass: !failed, ...(failed ? { failedAt: failed } : {}) });
    }
    return results;
}
