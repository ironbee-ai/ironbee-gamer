/**
 * How late a slower engine answers, as a schedule: a start from the game's seed, then a slow swing
 * across the range — an engine's time differs from game to game and drifts within one. Used where an
 * engine's lateness is played on purpose: the rules answering late while training for real time, and
 * real time simulated on the paused clock (each decision landing that long after its frame).
 */

export interface LatencyRange {
    minMs: number;
    maxMs: number;
    /** The game's seed: the same game, the same latency schedule. */
    seed?: number;
}

/** The drift's period: slow next to a decision, fast next to a game. */
const LATENCY_DRIFT_MS: number = 20_000;

/** The latency `elapsedMs` into a game: a start from the seed, then a slow swing across the range. */
export function latencyAt(range: LatencyRange, elapsedMs: number): number {
    const span: number = Math.max(0, range.maxMs - range.minMs);
    const u: number = (((range.seed ?? 0) * 2654435761) >>> 0) / 2 ** 32;
    const base: number = range.minMs + span * u;
    const swing: number = (span / 3) * Math.sin((2 * Math.PI * elapsedMs) / LATENCY_DRIFT_MS + u * 2 * Math.PI);
    return Math.min(range.maxMs, Math.max(range.minMs, base + swing));
}

/**
 * A real-time step's own time on top of the tick — reading the page, sending the input: a browser round
 * trip. Measured live on 2026-09-29 with the rules answering at once, on three games: frames 19 ms apart
 * at a 16 ms tick, 35 at 30, 106 at 100 (a few ms either way).
 */
export const STEP_TIME: LatencyRange = { minMs: 2, maxMs: 6 };

/** The step's own time for the `index`-th step of a game: from the seed, varying from step to step. */
export function stepTimeAt(seed: number | undefined, index: number): number {
    let h: number = (((seed ?? 0) ^ 0x9e3779b9) + Math.imul(index + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    const u: number = ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
    return Math.round(STEP_TIME.minMs + (STEP_TIME.maxMs - STEP_TIME.minMs) * u);
}
