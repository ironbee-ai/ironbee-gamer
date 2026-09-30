/**
 * A game's timers at fractional intervals (setInterval(loop, 1000 / 60)) fire on the frozen clock at
 * sums of that fraction, and the steps run game time in whole milliseconds: every 400 ms of 1000/60 the
 * two meet exactly (the 30th tick at 500.000…), and in floating point the tick fell on one side of the
 * step's end or the other depending on where the clock's timeline started — one run a physics tick
 * ahead of the next. A fractional delay is nudged by a millionth of a millisecond, so a tick never lands
 * on a step's end: always just after it, in every run. Whole-number delays are left as they are.
 *
 * It wraps the frozen clock's timers, so it runs after the clock's own scripts (`game_open` installs the
 * clock before it adds any page script): a native setInterval wrapped before would be replaced by the
 * clock's, and no delay nudged.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installTimerNudge(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.timerNudge) {
        return;
    }
    ns.timerNudge = true;
    const NUDGE: number = 1e-6;
    const nudged: (delay: unknown) => unknown = (delay: unknown): unknown => (typeof delay === "number" && Number.isFinite(delay) && !Number.isInteger(delay) ? delay + NUDGE : delay);
    const setInterval0: any = W.setInterval;
    const setTimeout0: any = W.setTimeout;
    W.setInterval = function (this: any, handler: any, delay?: any, ...args: any[]): any {
        return setInterval0.call(this, handler, nudged(delay), ...args);
    };
    W.setTimeout = function (this: any, handler: any, delay?: any, ...args: any[]): any {
        return setTimeout0.call(this, handler, nudged(delay), ...args);
    };
}
