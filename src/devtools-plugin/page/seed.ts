/**
 * Seeds the page's Math.random before any page script runs: the same seed gives the same course, so
 * two profiles are compared on identical games.
 *
 * The seed is scrambled first (splitmix32) and drives mulberry32: seeds next to each other (101, 202,
 * 303) start far apart. Park–Miller on the bare seed, used before, drew 0.0008, 0.0016 and 0.0024 first
 * for those three and kept their later draws in step — three "different" games were largely one.
 *
 * The page's crypto draws come from the seed too (`crypto.getRandomValues`, `crypto.randomUUID`: an RNG
 * library seeding itself, a game's ids — until 2026-09-30 they differed between two sessions of seed 7), on
 * a stream of their own (the seed's second splitmix32 output → mulberry32, both calls drawing from it): a
 * game's Math.random draws are the same whether or not anything on the page asks crypto. Each call is the
 * browser's own first — its checks and errors (an integer array, at most 65536 bytes, called on a Crypto),
 * the array it hands back —, then its bytes are the seed's, four to a draw; a UUID is version 4, from 16
 * bytes. `crypto.subtle` is the browser's. The input and decode counters (page/inputs.ts, page/decodes.ts)
 * take their document ids from crypto before this runs — `game_open` adds it after them, and a document
 * runs its init scripts in that order —: their ids stay the document's own, and this stream starts whole.
 *
 * Handed to Playwright as a function (with the seed as its argument): its source is sent to the page,
 * so it must not reference anything outside itself.
 */

export function seedRandom(seed: number): void {
    // Engine adapters sow their engine's own RNG from Math.random when they see this (page/phaser.ts).
    const W: any = window as any;
    (W.__ibgamer = W.__ibgamer || {}).seeded = true;
    /** The seed's n-th splitmix32 output: where the n-th stream starts (1: Math.random's, 2: crypto's). */
    const scrambled: (n: number) => number = (n: number): number => {
        let z: number = ((Math.abs(Math.floor(seed)) >>> 0) + Math.imul(0x9e3779b9, n)) | 0;
        z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
        z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
        return (z ^ (z >>> 15)) | 0;
    };
    /** mulberry32 from `state`: 32 random bits a call. */
    const stream: (state: number) => () => number = (state: number): (() => number) => {
        let a: number = state;
        return (): number => {
            a = (a + 0x6d2b79f5) | 0;
            let t: number = Math.imul(a ^ (a >>> 15), a | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return (t ^ (t >>> 14)) >>> 0;
        };
    };
    const draw: () => number = stream(scrambled(1));
    Math.random = function (): number {
        return draw() / 4294967296;
    };

    const bytes: () => number = stream(scrambled(2));
    // What the calls use, taken before the page's scripts run.
    const apply: typeof Reflect.apply = Reflect.apply;
    const Bytes: typeof Uint8Array = Uint8Array;
    const proto: any = typeof W.Crypto === "function" ? W.Crypto.prototype : undefined;
    /** Puts `make(original)` in place of the browser's call, with its length and name; a call the page lacks (randomUUID off a secure origin) stays lacking. */
    const wrap: (name: string, make: (original: any) => any) => void = (name: string, make: (original: any) => any): void => {
        try {
            const original: unknown = proto ? proto[name] : undefined;
            if (typeof original !== "function") {
                return;
            }
            const wrapper: any = make(original);
            Object.defineProperty(wrapper, "length", { value: original.length });
            Object.defineProperty(wrapper, "name", { value: original.name });
            proto[name] = wrapper;
        } catch {
            // a slot the page may not replace: its draws stay the browser's
        }
    };
    wrap(
        "getRandomValues",
        (original: any): any =>
            function (this: any, ...args: any[]): any {
                const array: any = apply(original, this, args);
                const out: Uint8Array = new Bytes(array.buffer, array.byteOffset, array.byteLength);
                for (let i: number = 0; i < out.length; i += 4) {
                    const r: number = bytes();
                    for (let k: number = 0; k < 4 && i + k < out.length; k++) {
                        out[i + k] = (r >>> (8 * k)) & 255;
                    }
                }
                return array;
            }
    );
    wrap(
        "randomUUID",
        (original: any): any =>
            function (this: any, ...args: any[]): string {
                apply(original, this, args);
                let uuid: string = "";
                for (let i: number = 0; i < 16; i += 4) {
                    const r: number = bytes();
                    for (let k: number = 0; k < 4; k++) {
                        const at: number = i + k;
                        let b: number = (r >>> (8 * k)) & 255;
                        if (at === 6) {
                            b = (b & 0x0f) | 0x40; // version 4
                        } else if (at === 8) {
                            b = (b & 0x3f) | 0x80; // the RFC 4122 variant
                        }
                        uuid += (b < 16 ? "0" : "") + b.toString(16) + (at === 3 || at === 5 || at === 7 || at === 9 ? "-" : "");
                    }
                }
                return uuid;
            }
    );
}
