import { createEngine, EngineKind, InvalidAnswerError } from "../../../src/engine";
import { JevEngine } from "../../../src/engine/jev";
import { LayaEngine } from "../../../src/engine/laya";
import { Question, SystemOneClient, SystemOneResponse } from "../../../src/engine/systemone";

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";

describe("engines", (): void => {
    const config = { kind: EngineKind.JEV, jev: { apiKey: "k" }, laya: { url: "http://laya:8000/" } };

    it("builds the configured engine behind the same interface", (): void => {
        expect(createEngine(config)).toBeInstanceOf(JevEngine);
        expect(createEngine({ ...config, kind: EngineKind.LAYA })).toBeInstanceOf(LayaEngine);
        // The rules are a profile's: they are made from the profile played, not from the configuration.
        expect((): unknown => createEngine({ ...config, kind: EngineKind.RULES })).toThrow(/from the profile/);
    });

    it("asks Laya over the same protocol at its own address, naming the checkpoint", async (): Promise<void> => {
        const calls: Array<{ url: string; body: any }> = [];
        const fetchImpl: typeof fetch = (async (url: string, init: RequestInit): Promise<Response> => {
            calls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ answers: {} }), { status: 200 });
        }) as unknown as typeof fetch;
        await new LayaEngine({ url: "http://laya:8000/", model: "dino", fetchImpl }).ask({ game: 1 }, {});
        expect(calls[0]).toEqual({ url: "http://laya:8000/v1/systemone", body: { model: "dino", state: { game: 1 }, questions: {} } });
    });

    it("keeps Laya warm while it idles: the smallest question (as the server warms itself up), never beside one in flight, until stopped", async (): Promise<void> => {
        jest.useFakeTimers();
        try {
            const asked: Array<{ state: unknown; questions: Record<string, Question> }> = [];
            const held: Array<() => void> = [];
            let holding: boolean = false;
            const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
                const body: { state: unknown; questions: Record<string, Question> } = JSON.parse(String(init.body));
                asked.push({ state: body.state, questions: body.questions });
                if (holding) {
                    await new Promise<void>((resolve: () => void): number => held.push(resolve));
                }
                return new Response(JSON.stringify({ answers: {} }), { status: 200 });
            }) as unknown as typeof fetch;
            const laya: LayaEngine = new LayaEngine({ fetchImpl });
            const question: Record<string, Question> = { action: { type: "choice", criteria: { go: "go" }, instructions: "the rules" } };
            const warm: { state: unknown; questions: Record<string, Question> } = {
                state: { warm: true },
                questions: { q: { type: "choice", instructions: "warm up", criteria: { a: "a", b: "b" } } },
            };
            const stop: () => void = laya.keepWarm();
            await jest.advanceTimersByTimeAsync(80);
            expect(asked).toEqual([]);
            await jest.advanceTimersByTimeAsync(40);
            expect(asked).toEqual([warm]);

            // After a decision, the smallest question again — never the decision's own state (hundreds of tokens).
            await laya.ask({ game: 1 }, question);
            asked.length = 0;
            await jest.advanceTimersByTimeAsync(80);
            expect(asked).toEqual([]);
            await jest.advanceTimersByTimeAsync(40);
            expect(asked).toEqual([warm]);

            holding = true;
            asked.length = 0;
            const slow: Promise<SystemOneResponse> = laya.ask({ game: 2 }, question);
            await jest.advanceTimersByTimeAsync(1000);
            expect(asked).toEqual([{ state: { game: 2 }, questions: question }]);
            holding = false;
            held.forEach((release: () => void): void => release());
            await slow;

            stop();
            asked.length = 0;
            await jest.advanceTimersByTimeAsync(1000);
            expect(asked).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("reports health: Jev by its key, Laya by its server", async (): Promise<void> => {
        expect((await new JevEngine({ apiKey: "" }).health()).ok).toBe(false);
        expect((await new JevEngine({ apiKey: "k" }).health()).ok).toBe(true);
        const down: typeof fetch = (async (): Promise<Response> => {
            throw new Error("refused");
        }) as unknown as typeof fetch;
        const up: typeof fetch = (async (): Promise<Response> => new Response("{}", { status: 200 })) as unknown as typeof fetch;
        expect((await new LayaEngine({ fetchImpl: down }).health()).detail).toMatch(/laya-serve/);
        expect((await new LayaEngine({ fetchImpl: up }).health()).ok).toBe(true);
    });
});

describe("SystemOneClient retries", (): void => {
    it("asks again after a transient server or CDN error, and gives up on a client error", async (): Promise<void> => {
        const { SystemOneClient } = await import("../../../src/engine/systemone");
        const statuses: number[] = [520, 503, 200];
        const seen: number[] = [];
        const fetchImpl: typeof fetch = (async (): Promise<Response> => {
            const status: number = statuses.shift() ?? 200;
            seen.push(status);
            return new Response(status === 200 ? JSON.stringify({ answers: { a: 1 } }) : "busy", { status });
        }) as unknown as typeof fetch;
        const client = new SystemOneClient({ url: "http://x/v1/systemone", label: "T", fetchImpl });
        await expect(client.ask({}, {})).resolves.toEqual({ answers: { a: 1 } });
        expect(seen).toEqual([520, 503, 200]);
        const bad: typeof fetch = (async (): Promise<Response> => new Response("no", { status: 400 })) as unknown as typeof fetch;
        await expect(new SystemOneClient({ url: "http://x", label: "T", fetchImpl: bad }).ask({}, {})).rejects.toThrow(/HTTP 400/);
    }, 20_000);
});

describe("SystemOneClient over a connection that fails during the answer", (): void => {
    const ANSWER: SystemOneResponse = { answers: { action: { choice: "a", probabilities: { a: 1 }, confidence: 1 } } };
    let server: Server;
    let url: string;
    let requests: number;
    /** How the server answers the request numbered `n` (1 is the first). */
    let respond: (res: ServerResponse, n: number) => void;

    const answered: (res: ServerResponse) => void = (res: ServerResponse): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ANSWER));
    };

    beforeEach(async (): Promise<void> => {
        requests = 0;
        server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            const n: number = ++requests;
            req.resume();
            req.on("end", (): void => respond(res, n));
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", (): void => resolve());
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
    });

    afterEach(async (): Promise<void> => {
        server.closeAllConnections();
        await new Promise<void>((resolve: () => void): void => {
            server.close((): void => resolve());
        });
    });

    it("asks again when the connection drops after the headers, the answer cut short", async (): Promise<void> => {
        respond = (res: ServerResponse, n: number): void => {
            if (n > 1) {
                answered(res);
                return;
            }
            res.writeHead(200, { "content-type": "application/json", "content-length": "200" });
            res.write('{"answers": {"act');
            setTimeout((): void => {
                res.socket?.destroy();
            }, 20);
        };
        await expect(new SystemOneClient({ url, label: "Jev" }).ask({}, {})).resolves.toEqual(ANSWER);
        expect(requests).toBe(2);
    }, 10_000);

    it("asks again when the time runs out while the body arrives", async (): Promise<void> => {
        respond = (res: ServerResponse, n: number): void => {
            if (n > 1) {
                answered(res);
                return;
            }
            // The headers, the first bytes, then nothing.
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"answers": ');
        };
        await expect(new SystemOneClient({ url, label: "Jev", timeoutMs: 300 }).ask({}, {})).resolves.toEqual(ANSWER);
        expect(requests).toBe(2);
    }, 10_000);

    it("asks again after a 200 whose body is not JSON (a proxy's page)", async (): Promise<void> => {
        respond = (res: ServerResponse, n: number): void => {
            if (n > 1) {
                answered(res);
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<html>gateway</html>");
        };
        await expect(new SystemOneClient({ url, label: "Jev" }).ask({}, {})).resolves.toEqual(ANSWER);
        expect(requests).toBe(2);
    }, 10_000);

    it("reports a 200 that stays no answer as an answer that cannot be acted on: the player keeps its decision, the run goes on", async (): Promise<void> => {
        // Only the pauses between the attempts run on a fake clock.
        jest.useFakeTimers({ doNotFake: ["Date", "hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate", "setInterval", "clearInterval"] });
        try {
            let calls: number = 0;
            const fetchImpl: typeof fetch = (async (): Promise<Response> => {
                calls++;
                return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
            }) as unknown as typeof fetch;
            const failure: Promise<unknown> = new SystemOneClient({ url: "http://x/v1/systemone", label: "Jev", fetchImpl })
                .ask({}, {})
                .then((): unknown => undefined, (err: unknown): unknown => err);
            await jest.advanceTimersByTimeAsync(10_000);
            const err: unknown = await failure;
            expect(err).toBeInstanceOf(InvalidAnswerError);
            expect((err as Error).message).toMatch(/^Jev: HTTP 200, but the body is not a JSON answer \("<html>gateway<\/html>"\); no action executed$/);
            expect(calls).toBe(5);
        } finally {
            jest.useRealTimers();
        }
    });
});
