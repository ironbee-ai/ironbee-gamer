/**
 * Where a profile's scripts run: the extractor, `askWhen` and the regression
 * tests' `expect` are JavaScript an LLM wrote (or a person who shared a game),
 * run here many times a second.
 *
 * Each runs in its own V8 context with no Node globals, no `eval` or
 * `Function` from strings, and a time limit per call. Only JSON crosses the
 * boundary — the input is serialized in and parsed inside, the output
 * serialized inside and parsed out — so no object of this process is ever
 * reachable from the script. A context is not a process boundary: this keeps
 * a script from reaching the host by accident or through a host object, and
 * from hanging a game; a library game is still code, and is added knowingly.
 *
 * Nothing of a script runs in this process outside a call's time limit: its
 * promise jobs run within the call, what it throws is turned into text inside
 * its context, the inputs are data properties it cannot turn into setters, and
 * it has no FinalizationRegistry (whose callbacks would run later, unlimited).
 * `import` is refused before compile (its rejection is a host-realm error), and
 * the unhandled-rejection check walks a promise's prototype chain without ever
 * calling into the script.
 * Its clock and its random numbers are the game's: `Date` stands at a fixed
 * epoch advanced by the frame's game time, and `Math.random` is seeded — the
 * same game gives the same states, however long the engine took.
 */

import { types } from "util";
import vm from "vm";

/** An extractor runs every decision: it should take well under a millisecond. */
export const CALL_TIMEOUT_MS: number = 200;
const COMPILE_TIMEOUT_MS: number = 1_000;
/** Where a script's clock starts, as the page's frozen clock does (devtools-plugin/open.ts). */
const SCRIPT_EPOCH_MS: number = Date.UTC(2026, 0, 1);
/**
 * The globals this process writes: data properties no script can redefine (a setter would run here, with no time
 * limit); one it makes read-only fails its call (`setInput`).
 */
const HOST_GLOBALS: readonly string[] = ["__in", "__info", "__compiled"];

/**
 * Runs in every context before any script. No FinalizationRegistry: its callbacks run in this process
 * later, outside any call. `code` fixed on Error.prototype: Node sets it on the time limit's error, made
 * in the context — a setter there would run here, and one that throws aborts the process. `Date` at a
 * fixed epoch, moved by `__clock(ms)` to the frame's game time: on the paused clock, wall time is the
 * engine's latency. Its local time is UTC, as the page's is (the plugin's time zone override): a script
 * reads the same hours, day and date on every machine — a date's parts (Annex B's getYear and setYear
 * too), its offset, its strings (an Invalid Date's, a year of six digits or below zero, as a UTC machine
 * writes them) and Intl's default zone. Not yet text read as a date (`Date.parse`, `new Date(text)`): a
 * date and time written without a zone is still this machine's local time. Nor the default locale: a
 * toLocale*String or Intl format given none writes as this machine's locale does. Only this context's own
 * Date and Intl are changed.
 */
const SETUP: string = `(function () {
    delete globalThis.FinalizationRegistry;
    Object.defineProperty(Error.prototype, "code", { value: undefined, writable: true, enumerable: false, configurable: false });
    var RealDate = Date, epoch = ${SCRIPT_EPOCH_MS}, now = epoch;
    var P = RealDate.prototype, own = function (name, value) {
        Object.defineProperty(P, name, { value: value, writable: true, enumerable: false, configurable: true });
    };
    var getTime = P.getTime, getUTCFullYear = P.getUTCFullYear, setUTCFullYear = P.setUTCFullYear, utcString = P.toUTCString, trunc = Math.trunc;
    ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"].forEach(function (unit) {
        own("get" + unit, P["getUTC" + unit]);
        if (unit !== "Day") { own("set" + unit, P["setUTC" + unit]); }
    });
    // Annex B's years: getYear is the year less 1900; setYear takes 0 to 99 as 1900 to 1999 (and makes an Invalid Date valid).
    own("getYear", function () { return getUTCFullYear.call(this) - 1900; });
    own("setYear", function (year) { var y = +year, whole = trunc(y); return setUTCFullYear.call(this, whole >= 0 && whole <= 99 ? 1900 + whole : y); });
    own("getTimezoneOffset", function () { var t = getTime.call(this); return t === t ? 0 : NaN; });
    // A date as a UTC machine writes it, "Thu Jan 01 2026" and "00:00:00 GMT+0000 (Coordinated Universal Time)", from toUTCString's
    // "Thu, 01 Jan 2026 00:00:00 GMT" (no part of it holds a space, whatever the year: -0001, 275760); an Invalid Date's is "Invalid Date".
    var utcText = function (date, withDay, withTime) {
        var t = getTime.call(date);
        if (t !== t) { return "Invalid Date"; }
        var p = utcString.call(date).split(" ");
        var day = p[0].slice(0, 3) + " " + p[2] + " " + p[1] + " " + p[3], time = p[4] + " GMT+0000 (Coordinated Universal Time)";
        return withDay ? (withTime ? day + " " + time : day) : time;
    };
    own("toString", function () { return utcText(this, true, true); });
    own("toDateString", function () { return utcText(this, true, false); });
    own("toTimeString", function () { return utcText(this, false, true); });
    // Intl's default zone: a DateTimeFormat asked for none (made with new or without, or a subclass's) formats in UTC, and so do
    // toLocaleString and its kin, as on a UTC machine. Its prototype, instanceof and supportedLocalesOf are the real one's.
    var RealFormat = Intl.DateTimeFormat;
    var inUtc = function (options) {
        if (options === undefined) { var none = Object.create(null); none.timeZone = "UTC"; return none; }
        // null is the real one's to refuse, as natively; a zone asked for stays.
        if (options === null || Object(options).timeZone !== undefined) { return options; }
        return Object.create(Object(options), { timeZone: { value: "UTC", enumerable: true } });
    };
    var Format = function DateTimeFormat() {
        "use strict"; // no own arguments or caller, as the real one has none
        var locales = arguments[0], options = inUtc(arguments[1]);
        return new.target === undefined ? RealFormat.call(this, locales, options) : Reflect.construct(RealFormat, [locales, options], new.target);
    };
    Object.defineProperty(Format, "prototype", { value: RealFormat.prototype, writable: false });
    Object.defineProperty(Format, "supportedLocalesOf", { value: RealFormat.supportedLocalesOf, writable: true, enumerable: false, configurable: true });
    RealFormat.prototype.constructor = Format;
    Intl.DateTimeFormat = Format;
    ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function (name) {
        var local = P[name];
        own(name, function (locales, options) { return local.call(this, locales, inUtc(options)); });
    });
    var FixedDate = function Date(year, month, day, hours, minutes, seconds, ms) {
        if (new.target === undefined) { return new RealDate(now).toString(); }
        // Components are UTC too: new Date(2026, 0, 1) is the same moment on every machine.
        var args = Array.prototype.slice.call(arguments);
        var at = args.length === 0 ? [now] : args.length === 1 ? args : [RealDate.UTC.apply(null, args)];
        return Reflect.construct(RealDate, at, new.target);
    };
    FixedDate.prototype = RealDate.prototype;
    FixedDate.now = function () { return now; };
    FixedDate.parse = RealDate.parse;
    FixedDate.UTC = RealDate.UTC;
    RealDate.prototype.constructor = FixedDate;
    globalThis.Date = FixedDate;
    globalThis.__clock = function (ms) { if (typeof ms === "number" && isFinite(ms)) { now = epoch + ms; } };
})()`;

export class ScriptError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScriptError";
    }
}

/** How far the prototype-chain walk goes before giving up: this realm's chain reaches Promise in two hops. */
const PROTO_WALK_MAX: number = 100;

/**
 * True only for a promise of THIS realm, deciding it WITHOUT running any script code — `promise instanceof
 * Promise` would. A script can splice a Proxy into a promise's prototype chain
 * (`Object.setPrototypeOf(p, new Proxy(...))`) whose `getPrototypeOf` trap then runs here, in this
 * process, after the call returned, with no time limit. So walk the chain by hand: at each step stop
 * (treat as another realm's promise) when the object is a Proxy (`util.types.isProxy`, whose own check
 * runs no trap), else take `Object.getPrototypeOf` (which runs nothing on a non-proxy) and compare with
 * this realm's `Promise.prototype`. A subclass's instance still reaches it through the chain.
 */
export function isThisRealmPromise(value: unknown): boolean {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return false;
    }
    let obj: object = value;
    for (let depth: number = 0; depth < PROTO_WALK_MAX; depth++) {
        if (types.isProxy(obj)) {
            return false;
        }
        const proto: object | null = Object.getPrototypeOf(obj);
        if (proto === null) {
            return false;
        }
        if (proto === Promise.prototype) {
            return true;
        }
        obj = proto;
    }
    return false;
}

/**
 * A promise a script rejects and never handles reaches this process's `unhandledRejection`, and with no
 * listener Node ends the process over it. One listener, added with the first context: a promise of a
 * script's realm (not this realm's Promise) is the script's failure, already visible in what it
 * returned; any other rejection is thrown on, as Node would without the listener. The check never calls
 * into a script (see `isThisRealmPromise`); Node's own rejection bookkeeping may still touch such a
 * promise, which is inherent.
 */
let scriptRejectionsHeard: boolean = false;

function hearScriptRejections(): void {
    if (scriptRejectionsHeard) {
        return;
    }
    scriptRejectionsHeard = true;
    process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>): void => {
        if (!isThisRealmPromise(promise)) {
            return;
        }
        throw reason;
    });
}

function newContext(name: string): vm.Context {
    hearScriptRejections();
    const sandbox: Record<string, unknown> = Object.create(null);
    for (const key of HOST_GLOBALS) {
        Object.defineProperty(sandbox, key, { value: undefined, writable: true, enumerable: false, configurable: false });
    }
    const context: vm.Context = vm.createContext(sandbox, {
        name,
        codeGeneration: { strings: false, wasm: false },
        // Promise jobs run at the end of each call, within its time limit — not later, in this process.
        microtaskMode: "afterEvaluate",
    });
    run(context, SETUP, COMPILE_TIMEOUT_MS);
    return context;
}

/**
 * The context's Math.random, seeded as the page's is (the seed scrambled by splitmix32, then
 * mulberry32; page/seed.ts): a script that draws random numbers (a tie broken at random, a sampled
 * route) gives the same state for the same game every time.
 */
function seedMath(context: vm.Context, seed: number): void {
    const s: number = Math.abs(Math.floor(seed)) >>> 0;
    run(
        context,
        `(function () { var z = (${s} + 0x9e3779b9) | 0; z = Math.imul(z ^ (z >>> 16), 0x21f0aaad); z = Math.imul(z ^ (z >>> 15), 0x735a2d97); var a = (z ^ (z >>> 15)) | 0;
        Math.random = function () { a = (a + 0x6d2b79f5) | 0; var t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })()`,
        COMPILE_TIMEOUT_MS
    );
}

/** FNV-1a (32 bits) over a text's UTF-16 code units: cheap, and the same number for the same text. */
function textHash(text: string): number {
    let hash: number = 0x811c9dc5;
    for (let i: number = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    }
    return hash >>> 0;
}

/**
 * The engine's own error — the time limit, a source that does not compile — made in the context's realm:
 * its own `message`, read without running anything the script may have put on its prototypes.
 */
function message(err: unknown): string {
    const own: PropertyDescriptor | undefined =
        err !== null && typeof err === "object" && !types.isProxy(err) ? Object.getOwnPropertyDescriptor(err, "message") : undefined;
    return typeof own?.value === "string" ? own.value.slice(0, 300) : "the script failed";
}

/**
 * `expression` (this module's code, calling into the script) as the context runs it: its value when a
 * string, as `=` and the string; what it threw as `!` and a message, made there under the same time
 * limit — no getter, `toString` or proxy trap of a thrown value ever runs in this process.
 */
function guarded(expression: string): string {
    return (
        `(function () { try { var v = (${expression}); return typeof v === "string" ? "=" + v : ""; } catch (e) { ` +
        `try { return "!" + String(e !== null && typeof e === "object" && "message" in e ? e.message : e).slice(0, 300); } ` +
        `catch (_) { return "!the script threw"; } } })()`
    );
}

/** Runs `expression` in the context (see `guarded`): its string value, or undefined; what it threw, as a ScriptError. */
function run(context: vm.Context, expression: string, timeout: number): string | undefined {
    let out: unknown;
    try {
        out = vm.runInContext(guarded(expression), context, { timeout, displayErrors: false });
    } catch (err: unknown) {
        // Only the engine's own errors get here: the time limit.
        throw new ScriptError(message(err));
    }
    if (typeof out !== "string" || out === "") {
        return undefined;
    }
    if (out.startsWith("!")) {
        throw new ScriptError(out.slice(1));
    }
    return out.slice(1);
}

/**
 * `import` as a word, not a property name (`x.import` is fine; `...import(…)`, a spread, is the keyword). A
 * comment may sit between the keyword and its `(`, so match the word itself, never "import followed by (".
 */
const IMPORT_KEYWORD: RegExp = /(?<!(?<!\.)\.)\bimport\b/;

/**
 * Compiles a script as the body `return (<source>);` of a function of `params`, into `__compiled`:
 * no source reaches past its own body into the code around it. Nothing of it runs yet.
 */
function compile(context: vm.Context, source: string, params: string[] = []): void {
    // Refuse dynamic `import()`: without --experimental-vm-modules Node rejects it with a HOST-realm error
    // whose `constructor.constructor` is the host `Function` (codeGeneration only bars the context's realm),
    // and an importModuleDynamically callback does not change that. So the keyword never reaches compile.
    if (IMPORT_KEYWORD.test(source)) {
        throw new ScriptError("the script uses `import`, which is not allowed");
    }
    let compiled: unknown;
    try {
        compiled = vm.compileFunction(`return (${source}\n);`, params, { parsingContext: context });
    } catch (err: unknown) {
        throw new ScriptError(message(err));
    }
    context.__compiled = compiled;
}

function parseOut(out: string | undefined): unknown {
    if (out === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(out);
    } catch {
        throw new ScriptError("the script's value is not JSON");
    }
}

/**
 * Sets host globals (the script's input, or undefined to take it back): every one, then a ScriptError when the
 * script made one read-only — the one change their non-configurable property allows, after which the assignment
 * throws a TypeError here, which no caller takes for the script's failure.
 */
function setInput(context: vm.Context, values: Record<string, string | undefined>): void {
    let readOnly: string | undefined;
    for (const [key, value] of Object.entries(values)) {
        try {
            context[key] = value;
        } catch {
            readOnly ??= key;
        }
    }
    if (readOnly !== undefined) {
        throw new ScriptError(`the script made its input (${readOnly}) read-only`);
    }
}

/** Runs `call` with the script's input set, and takes it back after: when the call failed, its own error is the one thrown. */
function withInput<T>(context: vm.Context, input: Record<string, string>, call: () => T): T {
    const cleared: Record<string, undefined> = Object.fromEntries(Object.keys(input).map((key: string): [string, undefined] => [key, undefined]));
    let result: T;
    try {
        setInput(context, input);
        result = call();
    } catch (err: unknown) {
        try {
            setInput(context, cleared);
        } catch {
            // What the call threw is the failure to tell.
        }
        throw err;
    }
    setInput(context, cleared);
    return result;
}

/** An input a plan already scheduled that has not taken effect yet: `inMs` after this frame. */
export interface PendingInput {
    inMs: number;
    action: string;
}

/** What the player tells an extractor besides the raw input: `extract(raw, memory, info)`. */
export interface ExtractInfo {
    /**
     * How long after this frame the decision made on it takes effect, in ms: 0 while the game waits
     * for every decision; with the clock running (real time), about the engine's recent decision time.
     * Time-critical features computed as of now + lagMs describe the world the action meets.
     */
    lagMs: number;
    /** The game's time at this frame, ms since the episode began: frames with the clock running are not evenly spaced. */
    nowMs?: number;
    /** Plan mode: for each moment of the plan, how many ms after this frame its action takes effect. */
    slots?: number[];
    /** Plan mode: the inputs earlier plans scheduled that have not taken effect yet. */
    pending?: PendingInput[];
}

const NO_LAG: ExtractInfo = { lagMs: 0 };

/** The info as the script receives it: whole milliseconds, no field it would not be given. */
function infoJson(info: ExtractInfo): string {
    const ms: (v: number) => number = (v: number): number => Math.max(0, Math.round(v));
    return JSON.stringify({
        lagMs: ms(info.lagMs),
        ...(info.nowMs !== undefined ? { nowMs: ms(info.nowMs) } : {}),
        ...(info.slots ? { slots: info.slots.map(ms) } : {}),
        ...(info.pending ? { pending: info.pending.map((p: PendingInput): PendingInput => ({ inMs: ms(p.inMs), action: p.action })) } : {}),
    });
}

/** A profile's `extract(raw, memory, info)`, with its memory: one per game (a new game starts with empty memory). */
export class Extractor {
    private readonly context: vm.Context;

    /** `seed`: the game's (its Math.random is seeded with it; default 1, so an unseeded game is reproducible too). */
    constructor(
        source: string,
        private readonly seed: number = 1
    ) {
        this.context = newContext("ibgamer-extractor");
        compile(this.context, source);
        // Seed before the factory runs: a draw at factory scope (a precomputed tie-break, a sampled
        // table) is the game's, not V8's unseeded RNG, or two extractors of one seed diverge. `reset`
        // seeds again, so the first `extract` starts from the same state whether or not the factory drew.
        seedMath(this.context, this.seed);
        if (run(this.context, "(globalThis.__extract = __compiled(), typeof __extract)", COMPILE_TIMEOUT_MS) !== "function") {
            throw new ScriptError("the extractor is not a function");
        }
        this.reset();
    }

    /** Forgets what earlier frames left in memory, and starts Math.random and the clock over. */
    reset(): void {
        run(this.context, "(globalThis.__memory = {}, __clock(0))", COMPILE_TIMEOUT_MS);
        seedMath(this.context, this.seed);
    }

    /** `info.nowMs`, when given, is also the script's clock: `Date` stands at the epoch plus the frame's game time. */
    extract(raw: unknown, info: ExtractInfo = NO_LAG): unknown {
        return withInput(
            this.context,
            { __in: JSON.stringify(raw ?? null), __info: infoJson(info) },
            (): unknown =>
                parseOut(
                    run(
                        this.context,
                        "(function () { var info = JSON.parse(__info); __clock(info.nowMs); var s = __extract(JSON.parse(__in), __memory, info); return JSON.stringify(s === undefined ? null : s); })()",
                        CALL_TIMEOUT_MS
                    )
                )
        );
    }
}

/** A JavaScript expression over named JSON arguments (`state`, `choice`), true or false. */
export class Predicate {
    private readonly context: vm.Context;
    private readonly params: string[];

    /** `seed`: the game's (its Math.random is seeded with it; default 1, as the extractor's). */
    constructor(expression: string, params: string[], seed: number = 1) {
        this.params = params;
        this.context = newContext("ibgamer-predicate");
        seedMath(this.context, seed);
        compile(this.context, expression, params);
    }

    test(...args: unknown[]): boolean {
        const input: string = JSON.stringify(this.params.map((_: string, i: number): unknown => args[i] ?? null));
        return withInput(
            this.context,
            { __in: input },
            (): boolean => run(this.context, "__compiled.apply(null, JSON.parse(__in)) ? 'true' : 'false'", CALL_TIMEOUT_MS) === "true"
        );
    }
}

/** Throws a ScriptError when the source does not compile to a function (a tuner's output, an import). */
export function checkExtractor(source: string): void {
    new Extractor(source);
}

export function checkExpression(expression: string, params: string[]): void {
    new Predicate(expression, params);
}

/**
 * A profile's teacher, `teach(state)`: the rules as code, labelling states for distillation. Its
 * answer is an action id (all the probability on it) or probabilities by action id (normalised;
 * unknown ids dropped). Stateless: each call sees one state, and its Math.random starts over from it.
 */
export class Teacher {
    private readonly context: vm.Context;

    constructor(
        source: string,
        private readonly actionIds: readonly string[]
    ) {
        this.context = newContext("ibgamer-teacher");
        seedMath(this.context, 1);
        compile(this.context, source);
        if (run(this.context, "(globalThis.__teach = __compiled(), typeof __teach)", COMPILE_TIMEOUT_MS) !== "function") {
            throw new ScriptError("the teacher is not a function");
        }
    }

    label(state: unknown): Record<string, number> {
        const json: string = JSON.stringify(state ?? null);
        // Seeded from the state itself: a label depends on nothing asked before, so one teacher playing game
        // after game (a watched game's rules, the distiller's) plays a seed the same every time.
        seedMath(this.context, textHash(json));
        const out: unknown = withInput(this.context, { __in: json }, (): unknown =>
            parseOut(run(this.context, "JSON.stringify(__teach(JSON.parse(__in)) ?? null)", CALL_TIMEOUT_MS))
        );
        const probabilities: Record<string, number> = {};
        if (typeof out === "string") {
            if (!this.actionIds.includes(out)) {
                throw new ScriptError(`the teacher answered ${JSON.stringify(out).slice(0, 40)}, not an action`);
            }
            for (const id of this.actionIds) {
                probabilities[id] = id === out ? 1 : 0;
            }
            return probabilities;
        }
        if (out && typeof out === "object" && !Array.isArray(out)) {
            let total: number = 0;
            for (const id of this.actionIds) {
                const p: unknown = (out as Record<string, unknown>)[id];
                probabilities[id] = typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0;
                total += probabilities[id];
            }
            if (total > 0) {
                for (const id of this.actionIds) {
                    probabilities[id] /= total;
                }
                return probabilities;
            }
        }
        throw new ScriptError("the teacher answered neither an action nor probabilities");
    }
}
