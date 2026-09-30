/**
 * The animation clock, for a game that moves things with CSS (animations, transitions): the frozen
 * clock stops the page's timers and frames, but the browser runs CSS animations on its own clock,
 * in real time — a pipe would slide on while the game waits for a decision. Every animation the
 * page starts is paused where it begins and moved on only by game time: `advance(dt)` after each
 * slice of game time the clock runs. One the page itself holds (`animation-play-state: paused`) is
 * left where it is.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installAnimationClock(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.animations) {
        return;
    }
    const taken: WeakSet<Animation> = new WeakSet();
    const heldByPage: (a: any) => boolean = (a: any): boolean => {
        const target: any = a.effect && a.effect.target;
        if (!target || typeof a.animationName !== "string") {
            return false; // a transition, or a script's own animation: it runs with game time
        }
        try {
            const names: string[] = getComputedStyle(target).animationName.split(",").map((s: string): string => s.trim());
            const states: string[] = getComputedStyle(target).animationPlayState.split(",").map((s: string): string => s.trim());
            const i: number = names.indexOf(a.animationName);
            return (states[i >= 0 ? i % states.length : 0] || "running") === "paused";
        } catch {
            return false;
        }
    };
    ns.animations = {
        /** Moves every animation on by `dt` ms of game time; one started since the last call is taken over from its start. */
        advance(dt: number): number {
            let moved: number = 0;
            for (const a of document.getAnimations()) {
                if (!taken.has(a)) {
                    taken.add(a);
                    a.pause();
                    a.currentTime = 0;
                    continue;
                }
                if (dt > 0 && !heldByPage(a)) {
                    a.currentTime = (Number(a.currentTime) || 0) + dt;
                    moved++;
                }
            }
            return moved;
        },
    };
}
