/**
 * The page reader without a browser or a trainer: a fake page that "evaluates" a read expression by
 * what it says (BROKEN throws, NULL returns nothing, anything else returns a changing state) — and a
 * score expression (BARE returns the score alone) —, and a fake trainer that answers from a script.
 */

import { GameBrowser, RecordingStopped } from "../../../src/devtools/client";
import { OpenRequest, OpenResult, ProbeResult, SpriteCropsResult, StepRequest, StepResult } from "../../../src/devtools/protocol";
import { Perception } from "../../../src/game/types";
import {
    clickTargetFor,
    isPublicAddress,
    PageReaderWriter,
    PROBE_BOOT_MS,
    publicOnlyLookup,
    readScriptBody,
    ReaderProposal,
    scriptRefusal,
    ScriptTooLargeError,
} from "../../../src/reader/page-reader";

import { LookupAddress, LookupOptions } from "dns";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";

const BIG_ENGINE: string = "x".repeat(700_000);

class FakePage implements GameBrowser {
    readonly opened: OpenRequest[] = [];
    readonly steps: StepRequest[] = [];
    private read?: string;
    private score?: string;
    private t: number = 0;

    async open(request: OpenRequest): Promise<OpenResult> {
        this.opened.push(request);
        this.read = request.read;
        this.score = request.score;
        this.t = 0;
        return { url: request.url, title: "Fake Runner" };
    }

    async step(request: StepRequest): Promise<StepResult> {
        this.steps.push(request);
        this.t += request.advanceMs ?? 0;
        if (this.read?.includes("BROKEN")) {
            return { readError: "game.hero is undefined", clockMs: this.t };
        }
        if (this.read?.includes("NULL")) {
            return { raw: null, clockMs: this.t };
        }
        if (this.read?.includes("FADES")) {
            // An object on the menu, nothing once the game runs.
            return this.t < 1_500 ? { raw: { playing: false, screen: "menu" }, clockMs: this.t } : { clockMs: this.t };
        }
        const score: StepResult["score"] = this.score?.includes("BARE") ? (this.t as unknown as StepResult["score"]) : { over: false, score: this.t };
        return { raw: { playing: true, hero: { x: this.t / 10 } }, score, clockMs: this.t };
    }

    async probe(): Promise<ProbeResult> {
        return {
            title: "Fake Runner",
            url: "https://game.test/",
            canvases: [{ width: 800, height: 450, context: "webgl", box: { x: 0, y: 0, width: 800, height: 450 } }],
            calls: {},
            engines: ["PIXI"],
            bodyText: "",
            scripts: ["https://game.test/pixi.min.js", "https://game.test/game.js"],
            inlineScripts: ["var game = new Game();"],
            globals: ["game: object", "PIXI: object"],
        };
    }

    async spriteCrops(): Promise<SpriteCropsResult> {
        return { crops: {} };
    }

    async screenshot(): Promise<string | undefined> {
        return undefined;
    }

    async startRecording(): Promise<void> {}

    async stopRecording(): Promise<RecordingStopped> {
        return {};
    }

    async close(): Promise<void> {}
}

describe("PageReaderWriter", (): void => {
    let workDir: string;

    beforeEach((): void => {
        workDir = mkdtempSync(path.join(tmpdir(), "ibgamer-reader-"));
    });

    afterEach((): void => {
        rmSync(workDir, { recursive: true, force: true });
    });

    function writer(replies: string[], prompts: string[], page: FakePage = new FakePage()): PageReaderWriter {
        return new PageReaderWriter({
            openBrowser: (): GameBrowser => page,
            ask: async (prompt: string): Promise<string> => {
                prompts.push(prompt);
                const reply: string | undefined = replies.shift();
                if (!reply) {
                    throw new Error("the trainer was asked once too often");
                }
                return reply;
            },
            fetchText: async (url: string): Promise<string> => (url.endsWith("pixi.min.js") ? BIG_ENGINE : "class Game { constructor() { this.hero = { x: 0 }; } }"),
        });
    }

    it("proposes how the game is played, in a few sentences, for the one adding it to check: a long one cut at a sentence, none when the trainer cannot tell", async (): Promise<void> => {
        const reply = (goal: unknown): string => JSON.stringify({ read: "(() => ({ playing: true, hero: game.hero }))()", format: "{ playing, hero: { x } }", goal });
        const prompts: string[] = [];
        const told: ReaderProposal = await writer([reply("Press  Space to jump.\n Avoid the cacti: touching one ends the game. ")], prompts).write({ url: "https://game.test/", workDir });
        expect(told.goal).toBe("Press Space to jump. Avoid the cacti: touching one ends the game.");
        // Asked for from the page's own words, and no strategy.
        expect(prompts[0]).toContain('"goal": how the game is played');
        expect(prompts[0]).toContain('"goal": "..." | null');
        const long: ReaderProposal = await writer([reply(`${"Jump over what comes. ".repeat(40)}`)], []).write({ url: "https://game.test/", workDir });
        expect(long.goal!.length).toBeLessThanOrEqual(600);
        expect(long.goal!.endsWith("Jump over what comes.")).toBe(true);
        for (const none of [null, "", "   ", 7]) {
            expect("goal" in (await writer([reply(none)], []).write({ url: "https://game.test/", workDir }))).toBe(false);
        }
    });

    it("collects the page's own code, leaves engine builds out, and returns a reader that works on the page", async (): Promise<void> => {
        const prompts: string[] = [];
        const page: FakePage = new FakePage();
        const proposal: ReaderProposal = await writer(
            [JSON.stringify({ read: "(() => ({ playing: true, hero: game.hero }))()", format: "{ playing, hero: { x } }", score: "({ over: false, score: game.t })", start: [{ press: ["Space"], advanceMs: 500 }], notes: "game is a global" })],
            prompts,
            page
        ).write({ url: "https://game.test/", workDir });

        expect(proposal).toMatchObject({ adapter: Perception.CUSTOM, format: "{ playing, hero: { x } }", start: [{ press: ["Space"], advanceMs: 500 }] });
        expect(proposal.samples).toHaveLength(6);
        expect(proposal.scores).toHaveLength(6);
        // The game's script and the inline one are there to read; the engine build is named, not copied.
        expect(readdirSync(path.join(workDir, "scripts")).sort()).toEqual(["01-game.js", "inline-1.js"]);
        const pageInfo: { skipped: string[]; globals: string[] } = JSON.parse(readFileSync(path.join(workDir, "page.json"), "utf-8"));
        expect(pageInfo.skipped[0]).toMatch(/pixi\.min\.js \(700 KB/);
        expect(pageInfo.globals).toContain("game: object");
        expect(prompts[0]).toContain("./scripts/01-game.js");
        // Checked the way it will be played: the clock frozen (the default), the start the trainer found run first.
        const check: OpenRequest = page.opened[1];
        expect(check).toMatchObject({ read: "(() => ({ playing: true, hero: game.hero }))()", adapters: [] });
        expect(check.freezeClock).toBeUndefined();
        expect(page.steps[0]).toMatchObject({ press: ["Space"], observe: false });
        expect(existsSync(path.join(workDir, "reader.json"))).toBe(true);
    });

    it("sends a reader that throws back once, with what went wrong", async (): Promise<void> => {
        const prompts: string[] = [];
        const proposal: ReaderProposal = await writer(
            [JSON.stringify({ read: "BROKEN", format: "x" }), JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }" })],
            prompts
        ).write({ url: "https://game.test/", workDir });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("FAILED ITS CHECK");
        expect(prompts[1]).toContain("game.hero is undefined");
        expect(proposal.read).toBe("(() => ({ playing: true }))()");
    });

    it("gives up after the repair round, saying why", async (): Promise<void> => {
        await expect(writer([JSON.stringify({ read: "NULL" }), JSON.stringify({ read: "NULL again" })], []).write({ url: "https://game.test/", workDir })).rejects.toThrow(
            /does not read this game: it returns no object/
        );
    });

    it("fails a reader unless every reading is an object, saying at which step", async (): Promise<void> => {
        const prompts: string[] = [];
        await expect(writer([JSON.stringify({ read: "FADES" }), JSON.stringify({ read: "FADES again" })], prompts).write({ url: "https://game.test/", workDir })).rejects.toThrow(
            /does not read this game: it returns no object at step 3 of 6 \(it returned undefined\)/
        );
        expect(prompts[1]).toContain("What went wrong: it returns no object at step 3 of 6");
    });

    it("sends a score expression back unless every reading is { over, score }: the player would read 0, never over", async (): Promise<void> => {
        const prompts: string[] = [];
        const read: string = "(() => ({ playing: true }))()";
        const proposal: ReaderProposal = await writer(
            [JSON.stringify({ read, format: "{ playing }", score: "BARE game.score" }), JSON.stringify({ read, format: "{ playing }", score: "({ over: game.over, score: game.score })" })],
            prompts
        ).write({ url: "https://game.test/", workDir });
        expect(prompts[1]).toContain("What went wrong: the score expression returns no { over: <boolean>, score: <number> } at step 1 of 6 (it returned 500)");
        expect(proposal.score).toBe("({ over: game.over, score: game.score })");
        expect(proposal.scores[0]).toEqual({ over: false, score: 500 });
        await expect(
            writer([JSON.stringify({ read, score: "BARE" }), JSON.stringify({ read, score: "BARE again" })], []).write({ url: "https://game.test/", workDir })
        ).rejects.toThrow(/does not read this game: the score expression returns no \{ over: <boolean>, score: <number> \}/);
    });

    it("checks a start's clicks where the added game's land: the largest canvas when it is not the first, the default otherwise", async (): Promise<void> => {
        const reply: string = JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }", start: [{ click: { x: 0.5, y: 0.6 }, advanceMs: 500 }] });
        // A small 2D frame-rate panel first, the game's WebGL canvas after it.
        const page: FakePage = new FakePage();
        page.probe = async (): Promise<ProbeResult> => ({
            ...(await FakePage.prototype.probe.call(page)),
            canvases: [
                { width: 80, height: 48, context: "2d", box: { x: 0, y: 0, width: 80, height: 48 }, selector: "#stats > canvas:nth-of-type(1)" },
                { width: 800, height: 450, context: "webgl", box: { x: 0, y: 60, width: 800, height: 450 }, selector: "#game" },
            ],
        });
        await writer([reply], [], page).write({ url: "https://game.test/", workDir });
        expect(page.opened[1].clickTarget).toBe("#game");
        expect(page.steps[0]).toMatchObject({ click: { x: 0.5, y: 0.6 } });
        // One canvas: game_step's default (the first) is the game's.
        const plain: FakePage = new FakePage();
        await writer([reply], [], plain).write({ url: "https://game.test/", workDir });
        expect(plain.opened[1]).not.toHaveProperty("clickTarget");
    });

    it("checks a start as the added game will play it: after the boot it is saved with, a holdFrom step's keys let go after it", async (): Promise<void> => {
        const page: FakePage = new FakePage();
        const start: unknown[] = [{ holdFrom: "window.game.keys()", advanceMs: 300 }];
        await writer([JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }", start })], [], page).write({ url: "https://game.test/", workDir });
        // Looked at and checked with the boot the wizard saves (src/server/ui/app.js writes the same number).
        expect(page.opened.map((o: OpenRequest): number | undefined => o.bootMs)).toEqual([PROBE_BOOT_MS, PROBE_BOOT_MS]);
        expect(readFileSync(path.join(__dirname, "../../../src/server/ui/app.js"), "utf-8")).toContain(`bootMs: ${PROBE_BOOT_MS},`);
        // As the player sends a start (inputSteps): the keys held from the step are let go before play.
        expect(page.steps.slice(0, 2)).toEqual([
            { holdFrom: "window.game.keys()", advanceMs: 300, observe: false },
            { hold: [], advanceMs: 0, observe: false },
        ]);
        expect(page.steps.slice(2)).toEqual(Array(6).fill({ advanceMs: 500 }));
    });

    it("keeps the Phaser adapter on a Phaser page: its game-instance helper is what the reader starts from", async (): Promise<void> => {
        const page: FakePage = new FakePage();
        page.probe = async (): Promise<ProbeResult> => ({ ...(await FakePage.prototype.probe.call(page)), engines: ["Phaser"], suggested: "phaser" as ProbeResult["suggested"] });
        const prompts: string[] = [];
        const proposal: ReaderProposal = await writer([JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }" })], prompts, page).write({ url: "https://game.test/", workDir });
        expect(proposal.adapter).toBe(Perception.PHASER);
        expect(prompts[0]).toContain("window.__ibgamer.phaser.game()");
        expect(page.opened[1].adapters).toEqual(["phaser"]);
    });

    it("downloads no script the page lists on this machine or its networks, naming each one left out", async (): Promise<void> => {
        const page: FakePage = new FakePage();
        const local: string[] = ["http://127.0.0.1:1986/api/status", "http://localhost:1986/app.js", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:10.0.0.1]/x.js"];
        page.probe = async (): Promise<ProbeResult> => ({ ...(await FakePage.prototype.probe.call(page)), scripts: [...local, "https://game.test/game.js"] });
        const fetched: string[] = [];
        await new PageReaderWriter({
            openBrowser: (): GameBrowser => page,
            ask: async (): Promise<string> => JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }" }),
            fetchText: async (url: string): Promise<string> => {
                fetched.push(url);
                return "var game = {};";
            },
        }).write({ url: "https://game.test/", workDir });
        expect(fetched).toEqual(["https://game.test/game.js"]);
        const pageInfo: { skipped: string[] } = JSON.parse(readFileSync(path.join(workDir, "page.json"), "utf-8"));
        expect(pageInfo.skipped).toHaveLength(local.length);
        local.forEach((url: string, i: number): void => {
            expect(pageInfo.skipped[i]).toContain(`${url} (not downloaded: `);
        });
    });
});

describe("what a start's clicks land on", (): void => {
    const probe: (extra: Partial<ProbeResult>) => ProbeResult = (extra: Partial<ProbeResult>): ProbeResult => ({
        title: "t",
        url: "https://game.test/",
        canvases: [],
        calls: {},
        engines: [],
        bodyText: "",
        ...extra,
    });
    const canvas: (width: number, height: number, selector?: string) => ProbeResult["canvases"][number] = (width: number, height: number, selector?: string): ProbeResult["canvases"][number] => ({
        width,
        height,
        box: { x: 0, y: 0, width, height },
        ...(selector ? { selector } : {}),
    });

    it("is the wizard's clickTarget: the largest canvas named unless it is the first, else the body when it has a size", (): void => {
        expect(clickTargetFor(probe({ canvases: [canvas(80, 48, "#fps"), canvas(800, 450, "#game")] }))).toBe("#game");
        expect(clickTargetFor(probe({ canvases: [canvas(800, 450, "#game"), canvas(80, 48, "#fps")] }))).toBeUndefined();
        // A canvas with no box on the page is none to click; one named by no selector stays the default.
        expect(clickTargetFor(probe({ canvases: [canvas(0, 0, "#hidden"), canvas(800, 450, "#game")] }))).toBe("#game");
        expect(clickTargetFor(probe({ canvases: [canvas(80, 48), canvas(800, 450)] }))).toBeUndefined();
        // No canvas: the page body, when what it shows is in its flow.
        expect(clickTargetFor(probe({ body: { x: 0, y: 0, width: 1280, height: 720 } }))).toBe("body");
        expect(clickTargetFor(probe({ body: { x: 0, y: 0, width: 1280, height: 0 } }))).toBeUndefined();
        expect(clickTargetFor(probe({}))).toBeUndefined();
    });
});

describe("where the page reader downloads scripts from", (): void => {
    it("tells a public address from this machine's and its networks', IPv4 and IPv6", (): void => {
        const local: string[] = [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.100.100.200",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fe80::1%en0",
            "fd00:ec2::254",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
            "2002:c0a8:101::",
            "not an address",
        ];
        expect(local.filter(isPublicAddress)).toEqual([]);
        const open: string[] = ["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5", "::ffff:8.8.8.8", "64:ff9b::808:808"];
        expect(open.filter(isPublicAddress)).toEqual(open);
    });

    it("takes the page's own origin wherever it is, and another host only when it is not this machine or its networks", (): void => {
        const page: string = "http://127.0.0.1:8080/game.html";
        expect(scriptRefusal("http://127.0.0.1:8080/js/game.js", page)).toBeUndefined();
        expect(scriptRefusal("https://cdn.example.com/phaser.js", page)).toBeUndefined();
        expect(scriptRefusal("http://127.0.0.1:1986/api/status", page)).toMatch(/127\.0\.0\.1 is not a public address/);
        expect(scriptRefusal("http://localhost:8080/js/game.js", page)).toMatch(/this machine/);
        expect(scriptRefusal("http://LOCALHOST./x.js", "https://game.test/")).toMatch(/this machine/);
        expect(scriptRefusal("http://api.localhost/x.js", "https://game.test/")).toMatch(/this machine/);
        expect(scriptRefusal("http://2130706433/x.js", "https://game.test/")).toMatch(/127\.0\.0\.1 is not a public address/);
        expect(scriptRefusal("http://[::ffff:169.254.169.254]/latest/meta-data/", "https://game.test/")).toMatch(/not a public address/);
        expect(scriptRefusal("http://169.254.169.254/latest/meta-data/", "https://game.test/")).toMatch(/not a public address/);
        expect(scriptRefusal("file:///etc/passwd", "https://game.test/")).toMatch(/not an http/);
        expect(scriptRefusal("https://game.test/x.js", "https://game.test/")).toBeUndefined();
    });

    it("connects to another host only when every address its name resolves to is public", async (): Promise<void> => {
        const answers: Record<string, LookupAddress[]> = {
            "cdn.example.com": [
                { address: "93.184.216.34", family: 4 },
                { address: "2606:2800:220:1::1", family: 6 },
            ],
            "rebind.example.com": [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ],
            "metadata.example.com": [{ address: "fd00:ec2::254", family: 6 }],
        };
        const lookup: ReturnType<typeof publicOnlyLookup> = publicOnlyLookup(
            (hostname: string, _options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void): void => {
                callback(null, answers[hostname] ?? []);
            }
        );
        type Answer = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };
        const ask: (hostname: string, all: boolean) => Promise<Answer> = (hostname: string, all: boolean): Promise<Answer> =>
            new Promise<Answer>((resolve: (answer: Answer) => void): void => {
                lookup(hostname, { all }, (err: NodeJS.ErrnoException | null, address: unknown, family?: number): void => resolve({ err, address, family }));
            });
        expect(await ask("cdn.example.com", true)).toEqual({ err: null, address: answers["cdn.example.com"] });
        expect(await ask("cdn.example.com", false)).toEqual({ err: null, address: "93.184.216.34", family: 4 });
        expect((await ask("rebind.example.com", true)).err?.message).toMatch(/127\.0\.0\.1, not a public address/);
        expect((await ask("metadata.example.com", false)).err?.code).toBe("ENOTPUBLIC");
        expect((await ask("nowhere.example.com", true)).err?.message).toMatch(/no address/);
    });

    it("reads no more of a script than one can be: an endless one is stopped, one declared bigger is not read", async (): Promise<void> => {
        let pulls: number = 0;
        const endless: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
            pull: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
                pulls++;
                controller.enqueue(new Uint8Array(256).fill(120));
            },
        });
        await expect(readScriptBody(new Response(endless), 1_000)).rejects.toThrow(ScriptTooLargeError);
        expect(pulls).toBeLessThan(10);
        await expect(readScriptBody(new Response("tiny", { headers: { "content-length": "5000" } }), 1_000)).rejects.toThrow(/^5 KB$/);
        expect(await readScriptBody(new Response("var jeu = 'élan';"), 1_000)).toBe("var jeu = 'élan';");
    });

    it("downloads a local page's own scripts, stops an endless one, and follows no redirect off the page's origin", async (): Promise<void> => {
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            if (req.url === "/game.js") {
                res.end("var game = { hero: { x: 0 } };");
            } else if (req.url === "/endless.js") {
                res.writeHead(200, { "content-type": "text/javascript" });
                const chunk: Buffer = Buffer.alloc(64 * 1024, "x");
                const pump: () => void = (): void => {
                    while (!res.destroyed && res.write(chunk)) {
                        // until the socket's buffer is full: "drain" goes on
                    }
                };
                res.on("drain", pump);
                pump();
            } else if (req.url === "/hop.js") {
                res.writeHead(302, { location: "http://127.0.0.2:1986/api/status" });
                res.end();
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", (): void => resolve());
        });
        const origin: string = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const dir: string = mkdtempSync(path.join(tmpdir(), "ibgamer-reader-local-"));
        try {
            const page: FakePage = new FakePage();
            page.probe = async (): Promise<ProbeResult> => ({
                ...(await FakePage.prototype.probe.call(page)),
                scripts: [`${origin}/game.js`, `${origin}/endless.js`, `${origin}/hop.js`, `${origin.replace("127.0.0.1", "localhost")}/game.js`],
            });
            await new PageReaderWriter({
                openBrowser: (): GameBrowser => page,
                ask: async (): Promise<string> => JSON.stringify({ read: "(() => ({ playing: true }))()", format: "{ playing }" }),
            }).write({ url: `${origin}/`, workDir: dir });
            expect(readdirSync(path.join(dir, "scripts")).sort()).toEqual(["01-game.js", "inline-1.js"]);
            expect(readFileSync(path.join(dir, "scripts", "01-game.js"), "utf-8")).toBe("var game = { hero: { x: 0 } };");
            const pageInfo: { skipped: string[] } = JSON.parse(readFileSync(path.join(dir, "page.json"), "utf-8"));
            expect(pageInfo.skipped).toEqual([
                expect.stringMatching(/endless\.js \(over 1800 KB: an engine or library build\)$/),
                expect.stringMatching(/hop\.js \(could not be downloaded: redirected to http:\/\/127\.0\.0\.2:1986\/api\/status: 127\.0\.0\.2 is not a public address\)$/),
                expect.stringMatching(/\/\/localhost:\d+\/game\.js \(not downloaded: this machine/),
            ]);
        } finally {
            server.closeAllConnections();
            server.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
