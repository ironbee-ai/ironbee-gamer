/**
 * Empties the tab's session storage for a game: each storage once per `game_open`, at the first document of the open
 * that uses it, remembered in the storage itself. The tab keeps one for each origin, and an earlier game of the session
 * left its own there; whether DevTools' origin clearing reaches it depends on the browser (Chrome's does, Playwright's
 * headless shell's does not), and `DOMStorage.clear` needs a document of that origin open.
 *
 * Each open hands its documents a token of its own. A document whose storage holds this open's token under the marker
 * key leaves it alone — an earlier document of the game emptied it, and what the game stored since is its own, as in a
 * player's tab: a frame of its parent's origin, a document a launcher sent the tab on to, a frame of the game's own
 * origin under a frame of another, the page a bounce through another origin sent back, the game loading itself again.
 * Any other storage is emptied and marked, whenever its first document starts: at the load, in the boot or in play (a
 * frame added late, a lazy frame). `game_open` adds it before the game's own init scripts (which may store as a
 * document starts) and keeps it for the whole game.
 *
 * The marker is one key the game can see (`sessionStorage.length`, `key(i)`), named so no game takes it for its own; its
 * value is the token, digits only (it parses as JSON). A game that empties its session storage itself takes the marker
 * with it: that storage is emptied again at its next document's start.
 *
 * Handed to Playwright as a function (with the token as its argument): its source is sent to the page, so it must not
 * reference anything outside itself.
 */

export function clearSessionStorage(token: string): void {
    const marker: string = "__ibgamer_session";
    try {
        if (sessionStorage.getItem(marker) === token) {
            return;
        }
        sessionStorage.clear();
        sessionStorage.setItem(marker, token);
    } catch {
        // no storage to reach: an opaque origin (a data: page, a sandboxed frame), storage turned off
    }
}
