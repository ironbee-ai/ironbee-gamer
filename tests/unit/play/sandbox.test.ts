import { checkExtractor, Extractor, isThisRealmPromise, Predicate, ScriptError, Teacher } from "../../../src/play/sandbox";

import vm from "vm";

/** Where every script's clock starts (the page's frozen clock starts there too). */
const EPOCH_MS: number = Date.UTC(2026, 0, 1);

/**
 * Runs `body` with this process in the time zone `zone` — one whose local time is not UTC, or a test of the scripts' UTC
 * passes on a UTC machine (typical CI) whatever they read —, and puts the process's own zone back after, even when `body`
 * fails. Jest hands a test a copy of process.env, where a TZ changes nothing; Node applies one set on the process's own
 * at once, in every context.
 */
function inTimeZone(zone: string, body: () => void): void {
    const env: NodeJS.ProcessEnv = (vm.runInThisContext("process") as NodeJS.Process).env;
    const own: string | undefined = env.TZ;
    env.TZ = zone;
    try {
        body();
    } finally {
        if (own === undefined) {
            delete env.TZ;
        } else {
            env.TZ = own;
        }
    }
}

describe("the sandbox's time limit covers everything a script runs", (): void => {
    // Each of these hung the process before: a script's code ran here, after its call, with no time limit.
    it("runs the promise jobs a script queues within the call", async (): Promise<void> => {
        const e: Extractor = new Extractor("function extract() { Promise.resolve().then(function () { for (;;) {} }); return 1; }");
        expect((): unknown => e.extract(null)).toThrow(/timed out/i);
        // Nothing of it is left to run in this process.
        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, 20));
    });

    it("turns what a script throws into text inside its context: no getter, toString or trap of it runs here", (): void => {
        expect((): unknown => new Extractor("function extract() { throw { get message() { for (;;) {} } }; }").extract(null)).toThrow(/timed out/i);
        expect((): unknown => new Extractor("function extract() { throw { toString: function () { for (;;) {} } }; }").extract(null)).toThrow(/timed out/i);
        expect((): unknown => new Extractor("function extract() { throw new Proxy({}, { has: function () { for (;;) {} } }); }").extract(null)).toThrow(/timed out/i);
        expect((): unknown => new Extractor("function extract() { throw { get message() { throw 1; } }; }").extract(null)).toThrow("the script threw");
        expect((): unknown => new Extractor("function extract() { throw new RangeError('out of range'); }").extract(null)).toThrow(new ScriptError("out of range"));
        expect((): boolean => new Predicate("(function () { throw { get message() { for (;;) {} } }; })()", ["state"]).test({})).toThrow(/timed out/i);
        expect((): unknown => new Teacher("function teach() { throw { get message() { for (;;) {} } }; }", ["A"]).label({})).toThrow(/timed out/i);
    });

    it("keeps its inputs out of the script's reach: a setter it defines for them never runs here", (): void => {
        const e: Extractor = new Extractor(`function extract(raw, memory, info) {
            if (!memory.tried) {
                memory.tried = true;
                ["__in", "__info"].forEach(function (key) {
                    try { Object.defineProperty(globalThis, key, { set: function () { for (;;) {} }, configurable: true }); } catch (e) {}
                });
            }
            return { raw: raw, lagMs: info.lagMs };
        }`);
        expect(e.extract({ n: 1 })).toEqual({ raw: { n: 1 }, lagMs: 0 });
        expect(e.extract({ n: 2 }, { lagMs: 40 })).toEqual({ raw: { n: 2 }, lagMs: 40 });
    });

    it("gives a script no FinalizationRegistry: its callbacks would run here, later", (): void => {
        expect(new Extractor("function extract() { return typeof FinalizationRegistry; }").extract(null)).toBe("undefined");
    });

    it("keeps a script from booby-trapping the time limit's own error", (): void => {
        const e: Extractor = new Extractor(`function extract() {
            try { Object.defineProperty(Error.prototype, "code", { set: function () { for (;;) {} }, configurable: true }); } catch (e) {}
            for (;;) {}
        }`);
        expect((): unknown => e.extract(null)).toThrow(/timed out/i);
    });

    it("compiles a source as its own function: nothing reaches past its body, and what it runs is under the limit", (): void => {
        // Spliced into the code around it, these would close it and throw from outside its try.
        expect((): void => checkExtractor("0)); } catch (x) {} throw { get message() { for (;;) {} } }; try { ((0")).toThrow(/unexpected token/i);
        expect((): unknown => new Predicate("0); } catch (x) {} throw { get message() { for (;;) {} } }; try { (0", ["state"])).toThrow(/unexpected token/i);
        // A source that runs code as it is defined: under the time limit, what it throws turned into text there.
        expect((): void => checkExtractor("0), (function () { throw { get message() { for (;;) {} } }; })(), (0")).toThrow(/timed out/i);
    });
});

describe("a script that makes its input read-only fails as a script", (): void => {
    // Not configurable, the inputs can still be made read-only; assigning one here then threw a TypeError, which no
    // caller took for the script's failure (a teacher doing it ended the whole play).
    const readOnly = (name: string): string => `Object.defineProperty(globalThis, "${name}", { writable: false })`;

    it("fails the extractor's call with a ScriptError, and every call after it", (): void => {
        const e: Extractor = new Extractor(`function extract(raw) { if (raw === 2) { ${readOnly("__in")}; } return raw; }`);
        expect(e.extract(1)).toBe(1);
        expect((): unknown => e.extract(2)).toThrow(ScriptError);
        expect((): unknown => e.extract(3)).toThrow(new ScriptError("the script made its input (__in) read-only"));
        // The frame's info too.
        const f: Extractor = new Extractor(`function extract(raw) { ${readOnly("__info")}; return raw; }`);
        expect((): unknown => f.extract(1)).toThrow(new ScriptError("the script made its input (__info) read-only"));
    });

    it("fails askWhen's and the teacher's call with a ScriptError alike", (): void => {
        const p: Predicate = new Predicate(`(${readOnly("__in")}, state > 1)`, ["state"]);
        expect((): boolean => p.test(2)).toThrow(ScriptError);
        expect((): boolean => p.test(3)).toThrow(ScriptError);
        const t: Teacher = new Teacher(`function teach(state) { if (state.n === 2) { ${readOnly("__in")}; } return "A"; }`, ["A", "B"]);
        expect(t.label({ n: 1 })).toEqual({ A: 1, B: 0 });
        expect((): unknown => t.label({ n: 2 })).toThrow(ScriptError);
        expect((): unknown => t.label({ n: 3 })).toThrow(ScriptError);
    });

    it("reports what the call itself threw, not the input it could not take back after", (): void => {
        const throwing: string = `${readOnly("__in")}; throw new Error("its own");`;
        expect((): unknown => new Extractor(`function extract() { ${throwing} }`).extract(1)).toThrow(new ScriptError("its own"));
        expect((): boolean => new Predicate(`(function () { ${throwing} })()`, ["state"]).test(1)).toThrow(new ScriptError("its own"));
        expect((): unknown => new Teacher(`function teach() { ${throwing} }`, ["A"]).label({})).toThrow(new ScriptError("its own"));
    });
});

describe("the script's clock and random numbers are the game's", (): void => {
    it("tells the extractor the time of its frame: the epoch plus the frame's game time, whatever the wall clock", async (): Promise<void> => {
        const e: Extractor = new Extractor(
            "function extract(raw) { var t0 = Date.now(); for (var i = 0; i < 1e5; i++) {} return { now: Date.now(), same: Date.now() === t0, date: new Date().getTime(), text: Date() === new Date(Date.now()).toString(), isDate: new Date() instanceof Date, fixed: new Date(0).getTime() }; }"
        );
        const first: unknown = e.extract(null, { lagMs: 0, nowMs: 1_500 });
        expect(first).toEqual({ now: EPOCH_MS + 1_500, same: true, date: EPOCH_MS + 1_500, text: true, isDate: true, fixed: 0 });
        await new Promise((resolve: (v: unknown) => void): unknown => setTimeout(resolve, 15));
        expect(e.extract(null, { lagMs: 0, nowMs: 1_500 })).toEqual(first);
        // No game time given: the clock stays where it was; a new game starts it over.
        expect(e.extract(null)).toMatchObject({ now: EPOCH_MS + 1_500 });
        e.reset();
        expect(e.extract(null)).toMatchObject({ now: EPOCH_MS });
    });

    // In Los Angeles the epoch is 31 Dec 2025, 16:00: every local reading of it differs from UTC's, the year's too.
    it("gives a script local time in UTC, as the page has, whatever this machine's zone — and leaves this process's own Date and Intl alone", (): void => {
        inTimeZone("America/Los_Angeles", (): void => {
            const read: unknown = new Extractor(`function extract() {
                var d = new Date(), c = new Date(2026, 0, 1, 5, 6, 7);
                return { hours: d.getHours(), date: d.getDate(), year: d.getFullYear(), offset: d.getTimezoneOffset(),
                    text: d.toString(), day: d.toDateString(), time: d.toTimeString(), parts: c.getTime() };
            }`).extract(null, { lagMs: 0, nowMs: 3_723_000 });
            expect(read).toEqual({
                hours: 1,
                date: 1,
                year: 2026,
                offset: 0,
                text: "Thu Jan 01 2026 01:02:03 GMT+0000 (Coordinated Universal Time)",
                day: "Thu Jan 01 2026",
                time: "01:02:03 GMT+0000 (Coordinated Universal Time)",
                parts: Date.UTC(2026, 0, 1, 5, 6, 7),
            });
            const epoch: Date = new Date(EPOCH_MS);
            expect([epoch.getHours(), epoch.getDate(), epoch.getFullYear(), epoch.getTimezoneOffset()]).toEqual([16, 31, 2025, 480]);
            expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/Los_Angeles");
        });
    });

    it("reads and sets Annex B's short year in UTC too: 0 to 99 as 1900 to 1999, an Invalid Date made valid", (): void => {
        inTimeZone("America/Los_Angeles", (): void => {
            const read: unknown = new Extractor(`function extract() {
                var set = function (from, year) { var d = new Date(from), r = d.setYear(year); return [r, d.getTime()]; };
                return { year: new Date().getYear(), invalid: isNaN(new Date(NaN).getYear()), short: set(0, 99), full: set(0, 2026),
                    fromInvalid: set(NaN, 5), none: isNaN(set(0, NaN)[1]) };
            }`).extract(null);
            expect(read).toEqual({
                year: 126,
                invalid: true,
                short: [Date.UTC(1999, 0, 1), Date.UTC(1999, 0, 1)],
                full: [EPOCH_MS, EPOCH_MS],
                fromInvalid: [Date.UTC(1905, 0, 1), Date.UTC(1905, 0, 1)],
                none: true,
            });
        });
    });

    it("gives Intl's DateTimeFormat the UTC zone when asked for none, and keeps it what it is", (): void => {
        inTimeZone("America/Los_Angeles", (): void => {
            const read: unknown = new Extractor(`function extract() {
                var d = new Date(), hour = { hour: "numeric", hourCycle: "h23" };
                class Sub extends Intl.DateTimeFormat {}
                return {
                    zones: [new Intl.DateTimeFormat().resolvedOptions().timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone,
                        new Sub().resolvedOptions().timeZone, new Intl.DateTimeFormat("en-US", { timeZone: undefined }).resolvedOptions().timeZone],
                    hour: new Intl.DateTimeFormat("en-US", hour).format(d),
                    day: new Intl.DateTimeFormat("en-US", { day: "numeric" }).formatToParts(d)[0].value,
                    asked: new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "Asia/Tokyo" }, hour)).format(d),
                    local: [d.toLocaleString("en-US"), d.toLocaleDateString("en-US"), d.toLocaleTimeString("en-US", hour), d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })],
                    is: [new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat, Intl.DateTimeFormat() instanceof Intl.DateTimeFormat, new Sub() instanceof Sub,
                        Object.getPrototypeOf(new Intl.DateTimeFormat()) === Intl.DateTimeFormat.prototype, Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat],
                    supported: Intl.DateTimeFormat.supportedLocalesOf(["en-US"]),
                };
            }`).extract(null);
            expect(read).toEqual({
                zones: ["UTC", "UTC", "UTC", "UTC"],
                hour: "00",
                day: "1",
                asked: "09",
                local: ["1/1/2026, 12:00:00 AM", "1/1/2026", "00", "1/1/2026, 9:00:00 AM"],
                is: [true, true, true, true, true],
                supported: ["en-US"],
            });
        });
    });

    it("writes an Invalid Date, a year of six digits and one below zero as a UTC machine does", (): void => {
        inTimeZone("America/Los_Angeles", (): void => {
            const read: unknown = new Extractor(`function extract() {
                var write = function (d) { return [String(d), d.toDateString(), d.toTimeString()]; };
                return { invalid: write(new Date(NaN)), invalidOffset: isNaN(new Date(NaN).getTimezoneOffset()), far: write(new Date(8.64e15)),
                    below: write(new Date(Date.UTC(-1, 0, 1))) };
            }`).extract(null);
            const midnight: string = "00:00:00 GMT+0000 (Coordinated Universal Time)";
            expect(read).toEqual({
                invalid: ["Invalid Date", "Invalid Date", "Invalid Date"],
                invalidOffset: true,
                far: [`Sat Sep 13 275760 ${midnight}`, "Sat Sep 13 275760", midnight],
                below: [`Fri Jan 01 -0001 ${midnight}`, "Fri Jan 01 -0001", midnight],
            });
        });
    });

    it("seeds askWhen's and the regression tests' Math.random as the extractor's, and stops their clock at the epoch", (): void => {
        const r: number = new Extractor("function extract() { return Math.random(); }", 7).extract(null) as number;
        expect(new Predicate(`Math.random() === ${r}`, ["state"], 7).test({})).toBe(true);
        expect(new Predicate(`Math.random() === ${r}`, ["state"], 8).test({})).toBe(false);
        expect(new Predicate(`Date.now() === ${EPOCH_MS}`, ["state"]).test({})).toBe(true);
        expect(new Teacher(`function teach() { return Date.now() === ${EPOCH_MS} ? "A" : "B"; }`, ["A", "B"]).label({})).toEqual({ A: 1, B: 0 });
    });

    it("starts the teacher's Math.random over from each state: the same state, the same label, whatever was asked before", (): void => {
        const source: string = "function teach(state) { return { A: Math.random(), B: Math.random() }; }";
        const teacher: Teacher = new Teacher(source, ["A", "B"]);
        const first: Record<string, number> = teacher.label({ x: 1 });
        // Other states in between (the games before), then the same state again.
        teacher.label({ x: 2 });
        teacher.label({ x: 3 });
        expect(teacher.label({ x: 1 })).toEqual(first);
        expect(new Teacher(source, ["A", "B"]).label({ x: 1 })).toEqual(first);
        expect(teacher.label({ x: 2 })).not.toEqual(first);
    });
});

describe("Extractor", (): void => {
    it("draws the same random numbers for the same game: Math.random is seeded, and starts over on reset", (): void => {
        const source: string = "function extract(raw, memory) { return { r: Math.random() }; }";
        const a: Extractor = new Extractor(source, 7);
        const first: unknown = a.extract({});
        expect(new Extractor(source, 7).extract({})).toEqual(first);
        expect(new Extractor(source, 8).extract({})).not.toEqual(first);
        a.reset();
        expect(a.extract({})).toEqual(first);
    });

    it("seeds Math.random before the factory runs: a draw in factory scope is the same for one seed", (): void => {
        // The factory (the source's outer function) draws once into a closure; extract returns it. Before
        // the fix this used V8's unseeded RNG, so two extractors of one seed disagreed here.
        const source: string = "(function () { var r = Math.random(); return function extract() { return r; }; })()";
        const first: unknown = new Extractor(source, 101).extract(null);
        expect(new Extractor(source, 101).extract(null)).toEqual(first);
        expect(new Extractor(source, 202).extract(null)).not.toEqual(first);
    });

    it("turns raw input into a state, with memory kept across calls and forgotten on reset", (): void => {
        const e: Extractor = new Extractor("function extract(raw, memory) { memory.n = (memory.n || 0) + 1; return { x: raw.x * 2, n: memory.n }; }");
        expect(e.extract({ x: 1 })).toEqual({ x: 2, n: 1 });
        expect(e.extract({ x: 5 })).toEqual({ x: 10, n: 2 });
        e.reset();
        expect(e.extract({ x: 0 })).toEqual({ x: 0, n: 1 });
    });

    it("tells the extractor how late the decision acts: 0 unless the player says otherwise", (): void => {
        const e: Extractor = new Extractor("function extract(raw, memory, info) { return { dx: raw.dx - raw.speed * info.lagMs }; }");
        expect(e.extract({ dx: 100, speed: 0.5 })).toEqual({ dx: 100 });
        expect(e.extract({ dx: 100, speed: 0.5 }, { lagMs: 40 })).toEqual({ dx: 80 });
    });

    it("tells the extractor the frame's game time and, for a plan, its moments and the inputs still to come (whole ms)", (): void => {
        const e: Extractor = new Extractor("function extract(raw, memory, info) { return info; }");
        expect(e.extract({}, { lagMs: 312.6, nowMs: 1_000.4, slots: [312.6, 362.6], pending: [{ inMs: 40.2, action: "JUMP" }] })).toEqual({
            lagMs: 313,
            nowMs: 1_000,
            slots: [313, 363],
            pending: [{ inMs: 40, action: "JUMP" }],
        });
        expect(e.extract({}, { lagMs: 0 })).toEqual({ lagMs: 0 });
    });

    it("takes a one-argument extractor, and an undefined return as null", (): void => {
        expect(new Extractor("function extract(frame) { return frame.length; }").extract([1, 2, 3])).toBe(3);
        expect(new Extractor("function extract() {}").extract({})).toBeNull();
    });

    it("gives the script no Node globals and no code from strings", (): void => {
        const probe: Extractor = new Extractor(
            "function extract() { return { process: typeof process, require: typeof require, globalThis: Object.keys(globalThis).length }; }"
        );
        expect(probe.extract(null)).toEqual({ process: "undefined", require: "undefined", globalThis: expect.any(Number) });
        expect((): unknown => new Extractor("function extract() { return eval('1 + 1'); }").extract(null)).toThrow(ScriptError);
        expect((): unknown => new Extractor("function extract() { return new Function('return 1')(); }").extract(null)).toThrow(ScriptError);
        // What it is handed is its own realm's: no way back to this process through the input.
        expect(new Extractor("function extract(raw) { return raw.constructor.constructor === Function; }").extract({})).toBe(true);
        expect(
            (): unknown => new Extractor("function extract(raw) { return raw.constructor.constructor('return process')(); }").extract({})
        ).toThrow(ScriptError);
    });

    it("hears a promise a script rejects and never handles, and lets every other rejection end the process as before", (): void => {
        const before: number = process.listeners("unhandledRejection").length;
        // A context made adds it (a real unhandled rejection here would be jest's: its own listener fails the file).
        new Extractor("function extract() { return {}; }").extract([]);
        const listeners: NodeJS.UnhandledRejectionListener[] = process.listeners("unhandledRejection");
        // One listener for every script, added with the first context (an earlier test may have added it).
        expect(listeners.length).toBeLessThanOrEqual(before + 1);
        const heard: NodeJS.UnhandledRejectionListener | undefined = listeners.find((l: NodeJS.UnhandledRejectionListener): boolean => /scriptRejections|isThisRealmPromise/.test(l.toString()));
        expect(heard).toBeDefined();
        const theirs: Promise<unknown> = vm.runInNewContext("Promise.resolve()") as Promise<unknown>;
        expect((): void => heard!(new Error("the script's"), theirs)).not.toThrow();
        const ours: Promise<unknown> = Promise.resolve();
        expect((): void => heard!(new Error("this process's"), ours)).toThrow("this process's");
    });

    it("stops a script that hangs", (): void => {
        const e: Extractor = new Extractor("function extract() { while (true) {} }");
        expect((): unknown => e.extract(null)).toThrow(/timed out/i);
    });

    it("refuses a source that is not a function", (): void => {
        expect((): void => checkExtractor("42")).toThrow(/not a function/);
        expect((): void => checkExtractor("function extract( {")).toThrow(ScriptError);
    });
});

describe("Predicate", (): void => {
    it("evaluates an expression over named JSON arguments", (): void => {
        const p: Predicate = new Predicate("state.threat !== null && choice === 'JUMP'", ["state", "choice"]);
        expect(p.test({ threat: { dx: 3 } }, "JUMP")).toBe(true);
        expect(p.test({ threat: null }, "JUMP")).toBe(false);
        expect(new Predicate("state.x > 1", ["state"]).test({ x: 2 })).toBe(true);
    });
});

describe("the sandbox refuses `import`", (): void => {
    // Dynamic import rejects with a host-realm error in a plain vm context (no --experimental-vm-modules),
    // so the keyword is refused before compile, in every kind of script.
    it("refuses a source that uses import, even with a comment between the keyword and its parenthesis", (): void => {
        expect((): void => checkExtractor("function extract() { return import('node:fs'); }")).toThrow(ScriptError);
        expect((): void => checkExtractor("function extract() { return import('node:fs'); }")).toThrow(/import/);
        expect((): void => checkExtractor("function extract() { return import/**/('node:fs'); }")).toThrow(/import/);
        expect((): unknown => new Predicate("import('node:fs')", ["state"])).toThrow(ScriptError);
        expect((): unknown => new Teacher("function teach() { return import('x'); }", ["A"])).toThrow(ScriptError);
    });

    it("refuses import after a spread, which is the keyword and not a property", (): void => {
        expect((): void => checkExtractor("function extract() { return [...import('node:fs').catch(function (e) { return e; })]; }")).toThrow(/import/);
        expect((): void => checkExtractor("function extract() { return [... import('node:fs')]; }")).toThrow(/import/);
    });

    it("allows a property named import (x.import, x?.import)", (): void => {
        expect(new Extractor("function extract(raw) { return raw.import; }").extract({ import: 3 })).toBe(3);
        expect(new Extractor("function extract(raw) { return raw?.import; }").extract({ import: 4 })).toBe(4);
    });
});

describe("hearing a script's rejection never calls into the script", (): void => {
    it("decides a promise's realm without invoking a Proxy trap spliced into its prototype chain", (): void => {
        // A script can set a Proxy as a promise's prototype; getPrototypeOf on it would run the trap here.
        let trapCalls: number = 0;
        const trap: ProxyHandler<object> = {
            getPrototypeOf(): object {
                trapCalls++;
                return Promise.prototype;
            },
        };
        const p: Promise<unknown> = Promise.resolve();
        Object.setPrototypeOf(p, new Proxy({}, trap));
        expect(isThisRealmPromise(p)).toBe(false);
        expect(trapCalls).toBe(0);
        // This realm's own promises and subclass instances still count; another realm's and non-promises do not.
        expect(isThisRealmPromise(Promise.resolve())).toBe(true);
        class SubPromise<T> extends Promise<T> {}
        expect(isThisRealmPromise(SubPromise.resolve(1))).toBe(true);
        expect(isThisRealmPromise(vm.runInNewContext("Promise.resolve()"))).toBe(false);
        expect(isThisRealmPromise({})).toBe(false);
        expect(isThisRealmPromise(null)).toBe(false);
    });
});
