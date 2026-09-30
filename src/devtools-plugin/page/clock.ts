/**
 * Reads the frozen clock as a document starts. A new document gets Playwright's clock as a log of what
 * was done to it (paused at, run for, set to), replayed at the page's first read of the time; until
 * then the clock runs in real time, and a timer of its own (100 ms after the start) moves it on by the
 * real time that passed — which the replay keeps. A page whose first read comes later (a script that
 * waits for the network) would start from a moment the network chose. Read at once, every document
 * starts where the log says. It runs after the clock's own scripts: `game_open` installs the clock
 * before it adds any page script, and a document runs its init scripts in the order they were added.
 *
 * The replay leaves the clock paused, but not that timer: 100 ms in, it would still run every timer then
 * due (a `setTimeout(start, 0)` set as the page loads) in real time — during the load or in the boot, as
 * the load's length decided. It is cancelled. It is Playwright's own (`_currentRealTimeTimer`), so every
 * access is guarded: a Playwright without it leaves the timer running, as before.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function replayClockLog(): void {
    try {
        performance.now();
        const clock: any = (globalThis as any).__pwClock?.controller;
        const timer: any = clock?._currentRealTimeTimer;
        if (clock && !clock._realTime && timer && !timer.promise && typeof timer.cancel === "function") {
            timer.cancel();
            clock._currentRealTimeTimer = undefined;
        }
    } catch {
        // no clock to read: nothing to replay
    }
}
