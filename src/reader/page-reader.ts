/**
 * The trainer writes a reader for a page's game: one page expression that returns the game's own
 * state — what a player sees (the player, the things around it, where they are), the score,
 * whether the game is over, which screen is shown. It opens games no generic adapter reads (drawn
 * with WebGL by an engine this app does not know), and it is a sharper input than a generic dump
 * for one it does.
 *
 * It is written from the page's code: the scripts the page loaded (downloaded into the work
 * directory; engine builds too big to read are left out and named), its inline scripts, the
 * globals its own code added, a screenshot. Then it is checked on the page itself as the added game
 * will be played — the clock frozen, the boot it is saved with (PROBE_BOOT_MS), the start the trainer
 * found (if any) sent as a start is (inputSteps), its clicks landing where the added game's will
 * (clickTargetFor) —: every reading must be a plain JSON object, without throwing, and stay small,
 * and every score reading a { over, score }. One repair round with what went wrong.
 *
 * The scripts are downloaded by this process, whatever the page lists: only from the page's own
 * origin or a public address — never this machine or its networks (the UI's own API, a cloud
 * metadata service) for a page elsewhere —, and never more of one than a script can be.
 */

import { GameBrowser } from "../devtools/client";
import { Adapter, OpenRequest, ProbeResult, StepResult, Viewport } from "../devtools/protocol";
import { InputStep, Perception } from "../game/types";
import { validateGame } from "../game/validate";
import { inputSteps } from "../play/rounds";
import { parseJsonObject, TrainerError } from "../train/claude";

import { lookup, LookupAddress, LookupOptions } from "dns";
import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { BlockList, isIP } from "net";
import path from "path";

import { Agent, fetch as undiciFetch } from "undici";

/** A script bigger than this is an engine or library build, not the game's own code: left out. */
const MAX_SCRIPT_CHARS: number = 600_000;
/** The most of a script that is read: MAX_SCRIPT_CHARS as UTF-8 (3 bytes a character at most); a download stops past it. */
const MAX_SCRIPT_BYTES: number = 3 * MAX_SCRIPT_CHARS;
const MAX_SCRIPTS: number = 25;
const MAX_REDIRECTS: number = 5;
const FETCH_TIMEOUT_MS: number = 15_000;
/** A reading bigger than this is a dump, not a state (and too long for a small model to read). */
const MAX_READING_CHARS: number = 20_000;
const CHECK_STEPS: number = 6;
const CHECK_STEP_MS: number = 500;
/**
 * The boot a page being added boots in: looked at (the UI's probe, the reader's look: the clock running, real time),
 * checked (the reader's check: game time) and played (the add-a-game wizard saves it as the game's `bootMs`, in
 * src/server/ui/app.js: keep the two alike) — so a start picked on the probe's picture, or checked here, is pressed
 * no sooner in play than it was seen.
 */
export const PROBE_BOOT_MS: number = 4_000;

export interface PageReaderDeps {
    openBrowser(): GameBrowser;
    ask(prompt: string, workDir: string, signal?: AbortSignal): Promise<string>;
    /** Downloads a script (default: fetch); tests replace it. */
    fetchText?(url: string): Promise<string>;
}

export interface PageReaderOptions {
    url: string;
    workDir: string;
    viewport?: Viewport;
    signal?: AbortSignal;
    onPhase?(text: string): void;
}

export interface ReaderProposal {
    /** The page expression that reads the game's state. */
    read: string;
    /** What it returns, in words (for whoever writes the player's rules). */
    format: string;
    /** A page expression for { over, score }, when the page keeps them. */
    score?: string;
    /** What a player does to begin, when the code says. */
    start?: InputStep[];
    /**
     * How the game is played, as its player would be told (the controls, the aim, what ends a game): proposed for the
     * game's goal — the wizard's How to play, which the person adding the game checks or rewrites.
     */
    goal?: string;
    /** The perception the reader goes with: Phaser pages keep the Phaser adapter (the game instance helper). */
    adapter: Perception;
    notes?: string;
    /** What the reader returned on the page over a few seconds of game time. */
    samples: unknown[];
    /** The score expression's readings over the same steps. */
    scores: unknown[];
}

interface Check {
    ok: boolean;
    problem?: string;
    samples: unknown[];
    scores: unknown[];
}

interface Reply {
    read: string;
    format: string;
    score?: string;
    start?: InputStep[];
    goal?: string;
    notes?: string;
}

/** The goal the reader may propose: a few sentences, not an essay (what is over is cut at a sentence's end where there is one). */
const MAX_GOAL_CHARS: number = 600;

/**
 * IPv4 networks no script is fetched from for a page elsewhere: this machine and its networks — loopback,
 * private, shared (carrier NAT; Alibaba's metadata service), link-local (the cloud metadata services at
 * 169.254.169.254), unspecified — and what is no host anywhere (documentation, benchmarking, multicast,
 * reserved). Also matched IPv4-mapped (::ffff:a.b.c.d: BlockList checks it against these), and inside
 * NAT64 and 6to4 addresses, which carry an IPv4 address.
 */
const NOT_PUBLIC_V4: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
    // Azure's platform endpoint (its wire server) is a public-looking address only its machines reach.
    ["168.63.129.16", 32],
];

/** IPv6 networks likewise: unspecified, loopback and IPv4-compatible (::/96), unique-local (AWS's metadata service, fd00:ec2::254), link-local, … */
const NOT_PUBLIC_V6: Array<[string, number]> = [
    ["::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["3fff::", 20],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
];

const NOT_PUBLIC: BlockList = ((): BlockList => {
    const list: BlockList = new BlockList();
    for (const [network, bits] of NOT_PUBLIC_V4) {
        list.addSubnet(network, bits, "ipv4");
        const [a, b, c, d]: number[] = network.split(".").map(Number);
        const high: string = ((a << 8) | b).toString(16);
        const low: string = ((c << 8) | d).toString(16);
        list.addSubnet(`64:ff9b::${high}:${low}`, 96 + bits, "ipv6");
        list.addSubnet(`2002:${high}:${low}::`, 16 + bits, "ipv6");
    }
    for (const [network, bits] of NOT_PUBLIC_V6) {
        list.addSubnet(network, bits, "ipv6");
    }
    return list;
})();

/** Whether an IP address (v4 or v6; a zone is left out) is a public host's: in none of the networks above. */
export function isPublicAddress(address: string): boolean {
    const bare: string = address.replace(/%.*$/, "");
    const family: number = isIP(bare);
    if (family === 0) {
        return false;
    }
    try {
        return !NOT_PUBLIC.check(bare, family === 6 ? "ipv6" : "ipv4");
    } catch {
        return false;
    }
}

function sameOrigin(url: URL, pageUrl: string): boolean {
    try {
        return url.origin === new URL(pageUrl).origin;
    } catch {
        return false;
    }
}

/**
 * Why a script at `url` is not downloaded for the page at `pageUrl` (the address the game was added with);
 * undefined when it may be. The page's own origin may be anywhere (a game served on this machine reads its own
 * scripts); another host is refused when it is named `localhost` or by an address that is not public. A name is
 * resolved when it is connected to (publicOnlyLookup), so the address checked is the address connected to.
 */
export function scriptRefusal(url: string, pageUrl: string): string | undefined {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return "not an address";
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        return "not an http(s) address";
    }
    if (sameOrigin(target, pageUrl)) {
        return undefined;
    }
    const host: string = target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost")) {
        return "this machine, not the page's own address";
    }
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
        return `${host} is not a public address`;
    }
    return undefined;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type LookupAll = (hostname: string, options: LookupOptions & { all: true }, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/**
 * The name lookup of a connection to a script's host other than the page's: the connection is refused unless
 * every address the name resolves to is public. The answer checked is the one connected to — a name that
 * answers a check with a public address and the connection with a local one (DNS rebinding) gains nothing.
 */
export function publicOnlyLookup(resolve: LookupAll = lookup): (hostname: string, options: LookupOptions, callback: LookupCallback) => void {
    return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
        resolve(hostname, { ...options, all: true }, (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]): void => {
            if (err) {
                callback(err, []);
                return;
            }
            const local: LookupAddress | undefined = addresses.find((a: LookupAddress): boolean => !isPublicAddress(a.address));
            if (local || addresses.length === 0) {
                const refused: NodeJS.ErrnoException = new Error(`${hostname} is ${local ? local.address : "no address"}, not a public address`);
                refused.code = "ENOTPUBLIC";
                callback(refused, []);
                return;
            }
            if (options.all) {
                callback(null, addresses);
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        });
    };
}

/** A script too big to be a game's own code (its size, in words): its download stopped there. */
export class ScriptTooLargeError extends Error {
    constructor(size: string) {
        super(size);
        this.name = "ScriptTooLargeError";
    }
}

/** A response's body as text, read no further than `maxBytes`: more is a ScriptTooLargeError, and the rest is never read. */
export async function readScriptBody(response: Response, maxBytes: number = MAX_SCRIPT_BYTES): Promise<string> {
    const declared: number = Number(response.headers.get("content-length") ?? "");
    if (declared > maxBytes) {
        await response.body?.cancel().catch((): undefined => undefined);
        throw new ScriptTooLargeError(`${Math.round(declared / 1000)} KB`);
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (!reader) {
        return "";
    }
    const chunks: Uint8Array[] = [];
    let size: number = 0;
    for (;;) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) {
            break;
        }
        size += chunk.value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch((): undefined => undefined);
            throw new ScriptTooLargeError(`over ${Math.round(maxBytes / 1000)} KB`);
        }
        chunks.push(chunk.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Downloads a script for the page at `pageUrl`: from the page's own origin as is, from any other host over
 * publicOnlyLookup; a redirect is followed by hand, each hop checked as the first (scriptRefusal); the body is
 * read no further than a script can be.
 */
async function fetchScript(url: string, pageUrl: string): Promise<string> {
    const publicOnly: Agent = new Agent({ connect: { lookup: publicOnlyLookup() } });
    const signal: AbortSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
        let at: string = url;
        for (let hop: number = 0; ; hop++) {
            const refusal: string | undefined = scriptRefusal(at, pageUrl);
            if (refusal) {
                throw new Error(hop ? `redirected to ${at}: ${refusal}` : refusal);
            }
            const own: boolean = sameOrigin(new URL(at), pageUrl);
            const response: Response = (await undiciFetch(at, { redirect: "manual", signal, ...(own ? {} : { dispatcher: publicOnly }) })) as unknown as Response;
            const location: string | null = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel().catch((): undefined => undefined);
                if (hop >= MAX_REDIRECTS) {
                    throw new Error("too many redirects");
                }
                at = new URL(location, at).href;
                continue;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await readScriptBody(response);
        }
    } catch (err: unknown) {
        // fetch's own error says "fetch failed"; its cause says why (a refused address, no such host).
        throw err instanceof TypeError && err.cause instanceof Error ? err.cause : err;
    } finally {
        await publicOnly.destroy().catch((): undefined => undefined);
    }
}

/** A score reading the player can measure by: a plain object, `score` a finite number, `over` a boolean when it is there. */
function isScoreReading(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const reading: { over?: unknown; score?: unknown } = value as { over?: unknown; score?: unknown };
    return typeof reading.score === "number" && Number.isFinite(reading.score) && (reading.over === undefined || typeof reading.over === "boolean");
}

type ProbedCanvas = ProbeResult["canvases"][number];

/**
 * What a game's clicks land on, by the rule the add-a-game wizard saves a game's `clickTarget` with (`clickTargetOf`
 * in src/server/ui/app.js: keep the two alike): the largest canvas — named by the probe's selector unless it is the
 * first one, game_step's default —, else the page body when it has a size. Undefined: the default.
 */
export function clickTargetFor(probe: ProbeResult): string | undefined {
    const area: (c: ProbedCanvas) => number = (c: ProbedCanvas): number => (c.box ? c.box.width * c.box.height : 0);
    const largest: ProbedCanvas | undefined = [...probe.canvases]
        .filter((c: ProbedCanvas): boolean => c.box !== undefined && c.box.width > 0)
        .sort((a: ProbedCanvas, b: ProbedCanvas): number => area(b) - area(a))[0];
    if (largest) {
        return largest === probe.canvases[0] ? undefined : largest.selector;
    }
    const body: ProbeResult["body"] = probe.body;
    return body && body.width > 0 && body.height > 0 ? "body" : undefined;
}

/** A file name for a downloaded script: its order and its own name, nothing a path could escape with. */
function scriptFile(index: number, url: string): string {
    let base: string = "script.js";
    try {
        base = path.basename(new URL(url).pathname) || base;
    } catch {
        // not a URL: the default name
    }
    base = base.replace(/[^\w.-]+/g, "_").slice(0, 60);
    return `${String(index).padStart(2, "0")}-${base.endsWith(".js") || base.endsWith(".mjs") ? base : `${base}.js`}`;
}

export function readerPrompt(input: { url: string; probe: ProbeResult; files: Array<{ path: string; what: string }>; phaser: boolean }): string {
    const { probe } = input;
    return `You are writing the perception for an automated player of a browser game: ONE JavaScript expression, evaluated in the game's page before every decision, that returns the game's current state as plain JSON.

PAGE: ${input.url} — "${probe.title}"
Canvases: ${JSON.stringify(probe.canvases.map((c: ProbeResult["canvases"][number]): Record<string, unknown> => ({ size: `${c.width}x${c.height}`, context: c.context })))}; engines found as page globals: ${JSON.stringify(probe.engines)}.

Files for you to Read (in the current directory):
${input.files.map((f: { path: string; what: string }): string => `  - ${f.path}: ${f.what}`).join("\n")}

Find where the game keeps its state — a global game object, the current scene or level, an engine's scene graph reachable from a global — and write:
- "read": ONE expression (an arrow function called at once, (() => { ... })(), is fine) evaluated in the page with no arguments. It returns a small plain JSON object (no functions, no cycles, no DOM nodes; well under 5000 characters): what a player sees and needs in order to play — what the player controls, the things that matter around it (kind, position, size, velocity where the code knows it), the score, whether the game is over, and which screen is shown (menu, playing, game over). Use the game's own units and say which way the axes run. It must never throw: before the game is running (still loading, on a menu) return { playing: false, screen: "<which>" }. It only reads: it must not change the game.
- "format": the shape of what it returns, in one or two sentences, for the one who writes the player's rules from it.
- "score": ONE expression returning { over: <boolean>, score: <number> } for the game in play — that object at every reading, never null or a bare number —, when the page keeps a score and a game-over state; null if you cannot tell.
- "start": what a player does to begin a game, if the code says (a key the menu waits for, a button to click), as input steps: [{"press": ["Space"], "advanceMs": 500}] or [{"click": {"x": 0.5, "y": 0.6}, "advanceMs": 500}] (x, y: fractions of the page's largest canvas, where the clicks land — of the page body when it has none) — [] when it starts by itself, null when you cannot tell.
- "goal": how the game is played, as its player would be told, in two or three plain sentences: the controls (which keys or clicks do what), the aim, and what ends a game. Use the page's own words where it has them (page.json's "text", its menus and messages in the code), and what the code does where it has none. It names no strategy — only the game's rules. null if you cannot tell.
- "notes": what you found, two or three sentences.
${input.phaser ? "\nThis page is a Phaser game, and this app installs a helper before the page runs: window.__ibgamer.phaser.game() returns the Phaser game instance (Phaser 2 or 3), even when the page keeps it in a closure. Start from it when the game is not a global.\n" : ""}
Reply with ONLY a JSON object, no prose, no code fence:
{"read": "...", "format": "...", "score": "..." | null, "start": [...] | null, "goal": "..." | null, "notes": "..."}`;
}

function repairPrompt(previous: string, reply: Reply, check: Check): string {
    return `${previous}

YOUR PREVIOUS READER FAILED ITS CHECK ON THE PAGE. It was:
${JSON.stringify({ read: reply.read, score: reply.score ?? null, start: reply.start ?? null })}
What went wrong: ${check.problem}
What it returned over ${CHECK_STEPS} steps of ${CHECK_STEP_MS} ms of game time: ${JSON.stringify(check.samples).slice(0, 4_000)}
Fix it (read the files again where you need to) and reply in the same JSON form.`;
}

function replyOf(text: string): Reply {
    const raw: Record<string, unknown> = parseJsonObject(text);
    if (typeof raw.read !== "string" || !raw.read.trim()) {
        throw new TrainerError("the reply has no read expression");
    }
    const out: Reply = {
        read: raw.read.trim(),
        format: typeof raw.format === "string" && raw.format.trim() ? raw.format.trim() : "the game's state, as the page's code keeps it.",
    };
    if (typeof raw.score === "string" && raw.score.trim()) {
        out.score = raw.score.trim();
    }
    if (typeof raw.notes === "string") {
        out.notes = raw.notes.trim();
    }
    if (typeof raw.goal === "string" && raw.goal.trim()) {
        const goal: string = raw.goal.trim().replace(/\s+/g, " ");
        const cut: string = goal.slice(0, MAX_GOAL_CHARS);
        // Too long: up to the last sentence that fits, else as far as it goes.
        out.goal = goal.length <= MAX_GOAL_CHARS ? goal : cut.slice(0, Math.max(cut.lastIndexOf(". ") + 1, 0)) || cut;
    }
    if (Array.isArray(raw.start)) {
        // Checked the way a game definition's start is: a step it cannot use is dropped, not guessed at.
        try {
            out.start = validateGame({
                id: "reader-check",
                name: "reader check",
                url: "https://reader.check/",
                goal: "check",
                perception: { adapter: "custom", read: "null" },
                score: { fromState: true, label: "points" },
                budgets: { gameSeconds: 10, episodes: 1 },
                start: raw.start,
            }).start;
        } catch {
            // an unusable start: none
        }
    }
    return out;
}

export class PageReaderWriter {
    constructor(private readonly deps: PageReaderDeps) {}

    async write(options: PageReaderOptions): Promise<ReaderProposal> {
        mkdirSync(path.join(options.workDir, "scripts"), { recursive: true });
        options.onPhase?.("opening the page and collecting its code");
        const probe: ProbeResult = await this.look(options);
        const phaser: boolean = probe.suggested === Adapter.PHASER || probe.engines.includes("Phaser");
        const files: Array<{ path: string; what: string }> = await this.collect(probe, options.url, options.workDir);
        const prompt: string = readerPrompt({ url: options.url, probe, files, phaser });
        writeFileSync(path.join(options.workDir, "reader-prompt.md"), prompt);

        // A start's clicks land where the game's will once it is added (the wizard saves this target).
        const clickTarget: string | undefined = clickTargetFor(probe);

        options.onPhase?.("the trainer reads the page's code and writes a reader (a few minutes)");
        let reply: Reply = replyOf(await this.deps.ask(prompt, options.workDir, options.signal));
        options.onPhase?.("checking the reader on the page");
        let check: Check = await this.check(reply, phaser, clickTarget, options);
        if (!check.ok) {
            options.onPhase?.("the reader failed its check: the trainer repairs it");
            reply = replyOf(await this.deps.ask(repairPrompt(prompt, reply, check), options.workDir, options.signal));
            check = await this.check(reply, phaser, clickTarget, options);
            if (!check.ok) {
                throw new TrainerError(`the reader the trainer wrote does not read this game: ${check.problem}`);
            }
        }
        writeFileSync(path.join(options.workDir, "reader.json"), JSON.stringify({ ...reply, samples: check.samples }, null, 1));
        return {
            read: reply.read,
            format: reply.format,
            ...(reply.score ? { score: reply.score } : {}),
            ...(reply.start ? { start: reply.start } : {}),
            ...(reply.goal ? { goal: reply.goal } : {}),
            adapter: phaser ? Perception.PHASER : Perception.CUSTOM,
            ...(reply.notes ? { notes: reply.notes } : {}),
            samples: check.samples,
            scores: check.scores,
        };
    }

    /** The page as it loads: what draws it, its code, a screenshot. */
    private async look(options: PageReaderOptions): Promise<ProbeResult> {
        const browser: GameBrowser = this.deps.openBrowser();
        try {
            await browser.open({ url: options.url, adapters: [Adapter.PROBE], freezeClock: false, bootMs: PROBE_BOOT_MS, ...(options.viewport ? { viewport: options.viewport } : {}) });
            const probe: ProbeResult = await browser.probe();
            const shot: string | undefined = await browser.screenshot(options.workDir, "page").catch((): undefined => undefined);
            if (shot) {
                copyFileSync(shot, path.join(options.workDir, "screenshot.png"));
            }
            return probe;
        } finally {
            await browser.close();
        }
    }

    /** The page's code into the work directory, and the list of files the trainer is told about. */
    private async collect(probe: ProbeResult, pageUrl: string, workDir: string): Promise<Array<{ path: string; what: string }>> {
        const fetchText: (url: string) => Promise<string> = this.deps.fetchText ?? ((url: string): Promise<string> => fetchScript(url, pageUrl));
        const files: Array<{ path: string; what: string }> = [];
        const skipped: string[] = [];
        let index: number = 0;
        let downloads: number = 0;
        for (const url of (probe.scripts ?? []).filter((u: string): boolean => /^https?:/.test(u))) {
            const refusal: string | undefined = scriptRefusal(url, pageUrl);
            if (refusal) {
                skipped.push(`${url} (not downloaded: ${refusal})`);
                continue;
            }
            if (++downloads > MAX_SCRIPTS) {
                break;
            }
            let text: string;
            try {
                text = await fetchText(url);
            } catch (err: unknown) {
                skipped.push(
                    err instanceof ScriptTooLargeError
                        ? `${url} (${err.message}: an engine or library build)`
                        : `${url} (could not be downloaded: ${err instanceof Error ? err.message : String(err)})`
                );
                continue;
            }
            if (text.length > MAX_SCRIPT_CHARS) {
                skipped.push(`${url} (${Math.round(text.length / 1000)} KB: an engine or library build)`);
                continue;
            }
            const name: string = scriptFile(++index, url);
            writeFileSync(path.join(workDir, "scripts", name), text);
            files.push({ path: `./scripts/${name}`, what: `the page's script ${url}` });
        }
        for (const [i, text] of (probe.inlineScripts ?? []).entries()) {
            const name: string = `inline-${i + 1}.js`;
            writeFileSync(path.join(workDir, "scripts", name), text);
            files.push({ path: `./scripts/${name}`, what: "a script written into the page itself" });
        }
        writeFileSync(
            path.join(workDir, "page.json"),
            JSON.stringify({ url: probe.url, title: probe.title, canvases: probe.canvases, engines: probe.engines, globals: probe.globals ?? [], skipped, text: probe.bodyText }, null, 1)
        );
        files.unshift({ path: "./page.json", what: "the page: its canvases, the engines found, the globals the page's own scripts added (name: kind), the scripts left out, and the first lines of the text it shows (\"text\": its own instructions, when it has them)" });
        files.unshift({ path: "./screenshot.png", what: "the page after it loaded" });
        return files;
    }

    /**
     * The reader on the page as the added game will be played: the clock frozen, its boot, its start (clicking
     * `clickTarget`), then a few steps of game time.
     */
    private async check(reply: Reply, phaser: boolean, clickTarget: string | undefined, options: PageReaderOptions): Promise<Check> {
        const browser: GameBrowser = this.deps.openBrowser();
        const samples: unknown[] = [];
        const scores: unknown[] = [];
        const errors: string[] = [];
        try {
            const request: OpenRequest = {
                url: options.url,
                adapters: phaser ? [Adapter.PHASER] : [],
                read: reply.read,
                ...(reply.score ? { score: reply.score } : {}),
                bootMs: PROBE_BOOT_MS,
                ...(options.viewport ? { viewport: options.viewport } : {}),
                ...(clickTarget ? { clickTarget } : {}),
            };
            await browser.open(request);
            // As the player sends a start: a holdFrom step's keys are let go by the next step, or after the last.
            for (const s of inputSteps(reply.start)) {
                await browser.step(s);
            }
            for (let i: number = 0; i < CHECK_STEPS; i++) {
                const r: StepResult = await browser.step({ advanceMs: CHECK_STEP_MS });
                if (r.readError) {
                    errors.push(r.readError);
                } else {
                    samples.push(r.raw);
                }
                if (reply.score) {
                    if (r.scoreError) {
                        errors.push(`score: ${r.scoreError}`);
                    } else {
                        scores.push(r.score);
                    }
                }
            }
        } catch (err: unknown) {
            return { ok: false, problem: `the page could not be read: ${err instanceof Error ? err.message : String(err)}`, samples, scores };
        } finally {
            await browser.close();
        }
        if (errors.length) {
            return { ok: false, problem: `it throws: ${errors[errors.length - 1]}`, samples, scores };
        }
        // Every reading, the first steps' included: the player reads it from the first frame.
        const bad: number = samples.findIndex((s: unknown): boolean => s === null || typeof s !== "object" || Array.isArray(s));
        if (bad >= 0) {
            return {
                ok: false,
                problem: `it returns no object at step ${bad + 1} of ${samples.length} (it returned ${JSON.stringify(samples[bad]) ?? "undefined"})`,
                samples,
                scores,
            };
        }
        const biggest: number = Math.max(...samples.map((s: unknown): number => JSON.stringify(s).length));
        if (biggest > MAX_READING_CHARS) {
            return { ok: false, problem: `a reading is ${biggest} characters: keep it to what a player sees (under 5000)`, samples: samples.map((s: unknown): string => JSON.stringify(s).slice(0, 600)), scores };
        }
        // The player measures by every score reading: one that is no { over, score } reads 0 and never over.
        const badScore: number = scores.findIndex((s: unknown): boolean => !isScoreReading(s));
        if (badScore >= 0) {
            return {
                ok: false,
                problem: `the score expression returns no { over: <boolean>, score: <number> } at step ${badScore + 1} of ${scores.length} (it returned ${JSON.stringify(scores[badScore]) ?? "undefined"})`,
                samples,
                scores,
            };
        }
        return { ok: true, samples, scores };
    }
}
