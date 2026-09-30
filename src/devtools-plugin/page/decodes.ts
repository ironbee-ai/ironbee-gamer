/**
 * Lists the work a page has running off its thread, for the frozen boot: a boot frame runs only once it is done, as
 * it waits for the network, so the page's callbacks run in the same frame every time. That work takes real time, and a
 * boot frame takes what the machine gives it: a Phaser 3 page's last sound came in frame 127 in one run and 140 in
 * another. Listed:
 * - decoding: `decodeAudioData` (a WebAudio loader waits for its sounds before the game starts), `createImageBitmap`,
 *   `HTMLImageElement.decode`;
 * - compiling WebAssembly (an engine's physics, a game built to it): `WebAssembly.compile`, `instantiate`,
 *   `compileStreaming`, `instantiateStreaming`;
 * - IndexedDB (a saved game read as it loads): a request (`indexedDB.open` / `deleteDatabase`, an object store's or an
 *   index's operations) until it succeeds or fails, a transaction until it completes or aborts — not at an error: one a
 *   request of its raises reaches it too, and the page may carry on after one (a cursor's later results come within
 *   its transaction); `indexedDB.databases()` as a promise.
 *
 * A job is listed (`decodes.open`, under an id of this document's) from its call until its promise settles, a callback
 * of its runs or an event that ends it fires, whichever is first; `decodes.moves` counts starts and ends. The calls are
 * the browser's own as they were: the same arguments (the page's callbacks wrapped, and called as they would be), the
 * browser's promise or request back, the same `length` and `name` (a library that picks its way by
 * `decodeAudioData.length` takes the same one). A promise gets a reaction of its own, so a rejection the page leaves
 * unhandled is no longer reported as unhandled; a request or transaction gets listeners of its own, added before the
 * page can add any, so a job ends before the page's own handlers run (which may start the next).
 *
 * A page that replaces one of these APIs keeps its own: a call that does not reach the browser's is not
 * listed. One that comes back the wrong way (throws, or returns no promise or nothing to listen on: a stand-in put
 * there before this) ends its job at once; what the counting calls (`then`, `addEventListener`, `Reflect.apply`) is
 * taken before the page's scripts run, so a page that replaces those cannot keep a job open; and a job that never
 * ends is let go of by the boot after a while, as a request is.
 *
 * Handed to Playwright as a function: its source is sent to the page, so it must not reference
 * anything outside itself.
 */

export function installDecodeCounter(): void {
    // Strict, as the source is sent alone: a callback the browser calls without a `this` gets none (not the window).
    "use strict";
    const W: any = window as any;
    const ns: any = (W.__ibgamer = W.__ibgamer || {});
    if (ns.decodes) {
        return;
    }
    const decodes: { open: Record<string, boolean>; moves: number } = { open: {}, moves: 0 };
    ns.decodes = decodes;
    const apply: typeof Reflect.apply = Reflect.apply;
    const then: (...args: any[]) => unknown = Promise.prototype.then;
    const listen: any = typeof W.EventTarget === "function" ? W.EventTarget.prototype.addEventListener : undefined;
    // The document's id, not drawn from Math.random (a seeded page's own draws are left alone), and from crypto before
    // the seed (page/seed.ts) takes it over — `game_open` adds this script first —: a job of one document is not taken
    // for another's.
    let doc: string;
    try {
        doc = Array.from(crypto.getRandomValues(new Uint32Array(2))).join("-");
    } catch {
        doc = String(document.URL);
    }
    let jobs: number = 0;
    /** Lists a job; returns its end, which counts once. */
    const start: () => () => void = (): (() => void) => {
        const id: string = `${doc}:${++jobs}`;
        decodes.open[id] = true;
        decodes.moves++;
        return (): void => {
            if (decodes.open[id]) {
                delete decodes.open[id];
                decodes.moves++;
            }
        };
    };
    /** The browser's call, as it was; the job ends when the promise it returns settles (at once when it throws or returns none). */
    const track: (end: () => void, original: any, self: any, args: any[]) => unknown = (end: () => void, original: any, self: any, args: any[]): unknown => {
        let result: unknown;
        try {
            result = apply(original, self, args);
        } catch (err: unknown) {
            end();
            throw err;
        }
        try {
            apply(then, result, [end, end]);
        } catch {
            // no promise came back: nothing to wait on
            end();
        }
        return result;
    };
    /** Puts `make(original)` in place of `owner[name]`, with its length and name; a slot that holds no function is left as it is. */
    const wrap: (owner: any, name: string, make: (original: any) => any) => void = (owner: any, name: string, make: (original: any) => any): void => {
        try {
            const original: unknown = owner ? owner[name] : undefined;
            if (typeof original !== "function") {
                return;
            }
            const wrapper: any = make(original);
            Object.defineProperty(wrapper, "length", { value: original.length });
            Object.defineProperty(wrapper, "name", { value: original.name });
            owner[name] = wrapper;
        } catch {
            // a slot the page may not replace: its work is not listed
        }
    };
    /** A call whose job is its promise. */
    const promised: (original: any) => any = (original: any): any =>
        function (this: any, ...args: any[]): any {
            return track(start(), original, this, args);
        };
    /** A call whose job is what it returns (a request, a transaction), until the first of `events` fires at it; at once when it throws or returns nothing to listen on. */
    const untilEvent: (events: string[]) => (original: any) => any = (events: string[]): ((original: any) => any) => (original: any): any =>
        function (this: any, ...args: any[]): any {
            const end: () => void = start();
            let result: unknown;
            try {
                result = apply(original, this, args);
            } catch (err: unknown) {
                end();
                throw err;
            }
            try {
                for (let i: number = 0; i < events.length; i++) {
                    apply(listen, result, [events[i], end]);
                }
            } catch {
                // nothing to listen on: nothing to wait for
                end();
            }
            return result;
        };
    /** The page's callback, ending the job first: a callback runs as the job ends, before the promise's reactions. */
    const ending: (end: () => void, callback: any) => any = (end: () => void, callback: any): any =>
        function (this: any, ...results: any[]): any {
            end();
            return apply(callback, this, results);
        };
    /** A constructor's prototype, when the page has the constructor. */
    const proto: (name: string) => any = (name: string): any => (typeof W[name] === "function" ? W[name].prototype : undefined);
    // Where each audio context kind has its own decodeAudioData (Chromium: BaseAudioContext, for both kinds).
    for (const kind of ["BaseAudioContext", "AudioContext", "OfflineAudioContext", "webkitAudioContext", "webkitOfflineAudioContext"]) {
        const owner: any = proto(kind);
        if (owner && Object.prototype.hasOwnProperty.call(owner, "decodeAudioData")) {
            wrap(owner, "decodeAudioData", (original: any): any =>
                function (this: any, ...args: any[]): any {
                    const end: () => void = start();
                    const passed: any[] = [];
                    for (let i: number = 0; i < args.length; i++) {
                        passed[i] = i > 0 && typeof args[i] === "function" ? ending(end, args[i]) : args[i];
                    }
                    return track(end, original, this, passed);
                }
            );
        }
    }
    wrap(W, "createImageBitmap", promised);
    wrap(proto("HTMLImageElement"), "decode", promised);
    for (const name of ["compile", "instantiate", "compileStreaming", "instantiateStreaming"]) {
        wrap(W.WebAssembly, name, promised);
    }
    const request: (original: any) => any = untilEvent(["success", "error"]);
    wrap(proto("IDBFactory"), "open", request);
    wrap(proto("IDBFactory"), "deleteDatabase", request);
    wrap(proto("IDBFactory"), "databases", promised);
    for (const kind of ["IDBObjectStore", "IDBIndex"]) {
        const owner: any = proto(kind);
        for (const name of ["add", "put", "delete", "clear", "get", "getKey", "getAll", "getAllKeys", "getAllRecords", "count", "openCursor", "openKeyCursor"]) {
            if (owner && Object.prototype.hasOwnProperty.call(owner, name)) {
                wrap(owner, name, request);
            }
        }
    }
    wrap(proto("IDBDatabase"), "transaction", untilEvent(["complete", "abort"]));
}
