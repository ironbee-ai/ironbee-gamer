/**
 * Counts the key and pointer events the page has received (keydown, keyup, pointerdown, pointerup — seen
 * first, on the window, capturing; the browser's own, not events the page dispatches itself): a step
 * waits until every input it sent has reached the page before it runs game time. The browser delivers
 * input on its own thread; on a loaded machine a key could arrive after the clock had run on, and the
 * same game started a frame later (a sprite three pixels lower after the start).
 *
 * Pointer events, not mouse events: a page that cancels pointerdown gets no mousedown or mouseup. Each
 * document counts under its own id (`inputsDoc`): a page that loads another document counts from zero.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installInputCounter(): void {
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (typeof ns.inputs === "number") {
        return;
    }
    ns.inputs = 0;
    // The document's id, not drawn from Math.random (a seeded page's own draws are left alone), and from crypto before
    // the seed (page/seed.ts) takes it over: `game_open` adds this script first, so the id is the document's own.
    try {
        ns.inputsDoc = Array.from(crypto.getRandomValues(new Uint32Array(2))).join("-");
    } catch {
        ns.inputsDoc = `${performance.timeOrigin}-${document.URL}`;
    }
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup"]) {
        window.addEventListener(
            type,
            (e: Event): void => {
                if (e.isTrusted) {
                    ns.inputs++;
                }
            },
            true
        );
    }
}
