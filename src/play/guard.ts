/**
 * The division of labor, enforced: the state carries FEATURES, the engine
 * makes every decision. An extractor that puts the answer into the state
 * (`advice: "JUMP"`, `recommended: …`) turns the engine into a rubber stamp,
 * and the score then measures the extractor's bot, not the engine — the first
 * tuning run in the research did exactly that. So before the engine sees a
 * state, a field that names or recommends an action is removed and counted,
 * and the tuner is told how many.
 *
 * Names are matched at their start or whole (`todo` must not match
 * `onShortestPathToDot`). A string equal to an action id is advice too,
 * unless its key names a fact (the way the player is heading); a state that
 * is itself one is replaced by null.
 */

const ADVICE_KEY: RegExp = /recommend|advice|advise|suggest|best.?action|next.?action|^should|^(decision|choice|action|todo|answer)$/i;
const FACT_KEY: RegExp = /heading|direction|dir$|facing|last|previous|prev|current|moving|state|status/i;

export interface GuardResult {
    state: unknown;
    /** Fields removed from this state. */
    dropped: number;
}

/**
 * A state nests no deeper than this: features are a few levels deep, and serializing a deeper one (its signature,
 * the engine's request) can overflow this process's stack after the sandbox's own serializer let it through.
 */
const MAX_STATE_DEPTH: number = 64;

/**
 * Removes the advice fields from `state` (in place) and counts them; the state to use is the one returned. Throws
 * on a state nested deeper than MAX_STATE_DEPTH (the extractor's failure, where the callers count one).
 */
export function guardState(state: unknown, actionIds: readonly string[]): GuardResult {
    const ids: Set<string> = new Set(actionIds.map((id: string): string => id.toLowerCase()));
    if (typeof state === "string" && ids.has(state.toLowerCase())) {
        // The whole state is an answer: nothing of it is left.
        return { state: null, dropped: 1 };
    }
    let dropped: number = 0;
    const walk: (o: unknown, key: string, depth: number) => void = (o: unknown, key: string, depth: number): void => {
        if (!o || typeof o !== "object") {
            return;
        }
        if (depth > MAX_STATE_DEPTH) {
            throw new Error(`the state nests deeper than ${MAX_STATE_DEPTH} levels`);
        }
        if (Array.isArray(o)) {
            // A list of action ids (a planned route) is advice too, unless its key names a fact. Compacted in place:
            // spread into one call, a long list (a flattened grid) would pass V8's argument limit.
            let kept: number = 0;
            for (const item of o) {
                if (!(typeof item === "string" && ids.has(item.toLowerCase()) && !FACT_KEY.test(key))) {
                    o[kept++] = item;
                }
            }
            dropped += o.length - kept;
            o.length = kept;
            for (const item of o) {
                walk(item, key, depth + 1);
            }
            return;
        }
        const record: Record<string, unknown> = o as Record<string, unknown>;
        for (const name of Object.keys(record)) {
            const value: unknown = record[name];
            if (ADVICE_KEY.test(name) || (typeof value === "string" && ids.has(value.toLowerCase()) && !FACT_KEY.test(name))) {
                delete record[name];
                dropped++;
                continue;
            }
            walk(value, name, depth + 1);
        }
    };
    walk(state, "", 1);
    return { state, dropped };
}

/**
 * A counter's words, as a whole word of a key (camelCase, snake_case or kebab-case, read in lower case): a field named
 * so changes every frame by design (`tick`, `frameCount`, `time_left`, `ageMs`), and a state that differs only in such
 * fields has not changed. A word that only contains one names no counter: `damage`, `stage`, `message`, `account`, `joystick`.
 */
const COUNTER_WORD: RegExp = /(?:^|[^a-z])(?:ticks?|counts?|counters?|times?|timers?|timestamps?|ages?|frames?)(?![a-z])/;
/** The letters a counter's word needs: a key without them (a list's index, most names) is not split into words. */
const COUNTER_LETTERS: RegExp = /tick|count|time|age|frame/i;

/** A key naming a counter: its words split at the humps of camelCase (`lastFrameAt`, `HPTimer`), then read in lower case. */
function isCounterKey(key: string): boolean {
    return COUNTER_LETTERS.test(key) && COUNTER_WORD.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase());
}

/** What a state says, without its counters: two equal signatures mean the game did not react. */
export function stateSignature(state: unknown): string {
    return JSON.stringify(state, (key: string, value: unknown): unknown => (key && isCounterKey(key) ? undefined : value)) ?? "";
}
