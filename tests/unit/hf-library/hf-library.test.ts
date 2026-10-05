import { EngineKind } from "../../../src/engine/types";
import { fetchIndex, HfError, hfSource } from "../../../src/hf-library/client";
import { exportGameForHf, mergeIndex, scrubLocalPaths } from "../../../src/hf-library/export";
import { LocalState, localState, PullConflictError, pullGame } from "../../../src/hf-library/pull";
import { pushGames } from "../../../src/hf-library/push";
import { HF_LIBRARY_FORMAT, HfGame, HfIndex, HfSource } from "../../../src/hf-library/types";
import { Library } from "../../../src/library/store";
import { profileHash } from "../../../src/run/decision-log";
import { fakeGameDefinition, fakeProfile } from "../../helpers/fake-game";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import path from "path";

/** The home folder the source library's files name (its paths are taken out of what is shared). */
const HOME: string = "/Users/tester";
const REPO: string = "test-org/test-library";

describe("the Hugging Face library", (): void => {
    let root: string;
    /** The library the game was trained in: built-in v1, its own v2 with Laya's checkpoint, decision logs. */
    let trained: Library;
    let hubDir: string;
    let server: Server;
    let source: HfSource;
    /** v2's checkpoint name, as the library finds it current. */
    let checkpoint: string;

    function library(name: string): Library {
        const dir: string = path.join(root, name);
        mkdirSync(path.join(dir, "built-in"), { recursive: true });
        mkdirSync(path.join(dir, "user"), { recursive: true });
        return new Library(path.join(dir, "built-in"), path.join(dir, "user"));
    }

    function write(file: string, data: string): void {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, data);
    }

    /** The trained game's export as the repo holds it, its index beside it. */
    async function publish(): Promise<HfGame> {
        const game: HfGame = await exportGameForHf(trained, "fake-runner", path.join(hubDir, "games", "fake-runner"), new Date("2026-10-05T12:00:00Z"), HOME);
        write(path.join(hubDir, "index.json"), JSON.stringify(mergeIndex(undefined, [game], HF_LIBRARY_FORMAT)));
        return game;
    }

    beforeEach(async (): Promise<void> => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-hf-"));
        trained = library("trained");
        const builtIn: string = path.join(trained.builtInDir, "fake-runner");
        write(path.join(builtIn, "game.json"), JSON.stringify(fakeGameDefinition()));
        write(path.join(builtIn, "profiles", "v1.json"), JSON.stringify(fakeProfile({ teacher: "function teach(s) { return 'NOOP'; }" })));
        write(path.join(builtIn, "samples", "setup.json"), JSON.stringify({ seen: "the start screen" }));
        const v2 = fakeProfile({ version: 2, teacher: "function teach(s) { return 'JUMP'; }", note: `Tuned in ${HOME}/work/run-7: jumps earlier.` });
        trained.saveProfile("fake-runner", v2 as never);
        const user: string = path.join(trained.userDir, "fake-runner");
        checkpoint = `v2-${profileHash(trained.profile("fake-runner", 2)!)}-r1`;
        const laya: string = path.join(user, "laya", checkpoint);
        write(path.join(laya, "model.safetensors"), "weights of v2");
        write(path.join(laya, "rl_agent_config.json"), JSON.stringify({ encoder: "base", ibgamer: { base: `${HOME}/.ibgamer/library/fake-runner/laya/v2-old-r0` } }));
        write(path.join(laya, "training.json"), JSON.stringify({ base: `${HOME}/.ibgamer/library/fake-runner/laya/v2-old-r0`, rows: 10 }));
        write(path.join(laya, "distill.json"), JSON.stringify({ checkpoint: `${HOME}/.ibgamer/library/fake-runner/laya/${checkpoint}`, student: { mean: 50, scores: [50], seeds: [1] } }));
        write(path.join(laya, "tokenizer", "tokenizer.json"), JSON.stringify({ model: { vocab: { a: 1 } } }));
        // An older checkpoint of a version no longer as it was: not played, not shared.
        write(path.join(user, "laya", "v1-0123456789ab-r1", "model.safetensors"), "weights of an old v1");
        write(path.join(user, "laya", "v1-0123456789ab-r1", "rl_agent_config.json"), "{}");
        write(path.join(user, "decisions", "v2-abc.jsonl"), '{"choice":"JUMP"}\n');
        hubDir = path.join(root, "hub");
        mkdirSync(hubDir, { recursive: true });
        // Hugging Face, as far as a pull reads it: /<repo>/resolve/<revision>/<path>, the commit in a header.
        server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            const m: RegExpExecArray | null = new RegExp(`^/${REPO}/resolve/([^/]+)/(.+)$`).exec(decodeURIComponent(req.url ?? ""));
            const file: string | undefined = m ? path.join(hubDir, m[2]) : undefined;
            if (!file || !existsSync(file)) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, { "x-repo-commit": "c0ffee1234" });
            res.end(readFileSync(file));
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", resolve);
        });
        source = hfSource({ HF_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, IBGAMER_HF_REPO: REPO, HF_TOKEN_PATH: path.join(root, "no-token") });
    });

    afterEach((): void => {
        server.close();
        rmSync(root, { recursive: true, force: true });
    });

    it("shares what plays the game — its definition, versions, samples and the checkpoint its configs play — and nothing naming this machine", async (): Promise<void> => {
        const game: HfGame = await publish();
        const rel: string[] = game.files.map((f: { path: string }): string => f.path.replace("games/fake-runner/", ""));
        expect(rel).toEqual(
            expect.arrayContaining(["game.json", "profiles/v1.json", "profiles/v2.json", "samples/setup.json", `laya/${checkpoint}/model.safetensors`, `laya/${checkpoint}/tokenizer/tokenizer.json`])
        );
        // Not the old checkpoint, the decision logs or this library's state.
        expect(rel.some((r: string): boolean => r.startsWith("laya/v1-") || r.startsWith("decisions/") || r === "state.json")).toBe(false);
        expect(game.plays).toContainEqual({ engine: EngineKind.LAYA, live: false, version: 2, checkpoint, mean: 50 });
        expect(game.activeVersion).toBe(2);
        const shared: string = path.join(hubDir, "games", "fake-runner");
        expect(JSON.parse(readFileSync(path.join(shared, "laya", checkpoint, "training.json"), "utf-8")).base).toBe("v2-old-r0");
        expect(JSON.parse(readFileSync(path.join(shared, "profiles", "v2.json"), "utf-8")).note).toBe("Tuned in ~/work/run-7: jumps earlier.");
        expect(JSON.parse(readFileSync(path.join(shared, "game.json"), "utf-8")).activeVersion).toBe(2);
        // A JSON file naming no path keeps its bytes.
        expect(readFileSync(path.join(shared, "laya", checkpoint, "tokenizer", "tokenizer.json"), "utf-8")).toBe(JSON.stringify({ model: { vocab: { a: 1 } } }));
        expect(scrubLocalPaths(["/private/var/folders/x/run", "a /Users/tester/x b", "/^re$/"], HOME)).toEqual(["run", "a ~/x b", "/^re$/"]);
    });

    it("pulls a game into another library, trained: every file checked, where it came from noted, and up to date after", async (): Promise<void> => {
        const game: HfGame = await publish();
        const fresh: Library = library("fresh");
        const read: { index: HfIndex; commit: string } | undefined = await fetchIndex(source);
        expect(read?.commit).toBe("c0ffee1234");
        expect(localState(fresh, game)).toBe(LocalState.MISSING);
        const phases: string[] = [];
        await pullGame(fresh, source, read!, "fake-runner", { onProgress: (p: { phase: string }): number => phases.push(p.phase) });
        expect(fresh.has("fake-runner")).toBe(true);
        expect(fresh.profile("fake-runner", 2)?.teacher).toContain("JUMP");
        expect(existsSync(path.join(fresh.userDir, "fake-runner", "laya", checkpoint, "model.safetensors"))).toBe(true);
        expect(JSON.parse(readFileSync(path.join(fresh.userDir, "fake-runner", "hf.json"), "utf-8"))).toMatchObject({ repo: REPO, commit: "c0ffee1234" });
        expect(localState(fresh, game)).toBe(LocalState.INSTALLED);
        expect(phases[phases.length - 1]).toBe("done");
        expect(existsSync(path.join(fresh.userDir, ".fake-runner.hf-pull"))).toBe(false);
    });

    it("replaces a game's own training only when asked, keeping its decision logs", async (): Promise<void> => {
        const game: HfGame = await publish();
        const read: { index: HfIndex; commit: string } | undefined = await fetchIndex(source);
        // The library it was trained in: its own training, not pulled.
        expect(localState(trained, game)).toBe(LocalState.LOCAL);
        await expect(pullGame(trained, source, read!, "fake-runner")).rejects.toBeInstanceOf(PullConflictError);
        await pullGame(trained, source, read!, "fake-runner", { replace: true });
        expect(readFileSync(path.join(trained.userDir, "fake-runner", "decisions", "v2-abc.jsonl"), "utf-8")).toContain("JUMP");
        expect(existsSync(path.join(trained.userDir, "fake-runner", "laya", "v1-0123456789ab-r1"))).toBe(false);
        expect(localState(trained, game)).toBe(LocalState.INSTALLED);
    });

    it("keeps nothing of a file that is not the one the index lists", async (): Promise<void> => {
        await publish();
        writeFileSync(path.join(hubDir, "games", "fake-runner", "profiles", "v2.json"), "{}");
        const fresh: Library = library("fresh");
        const read: { index: HfIndex; commit: string } | undefined = await fetchIndex(source);
        await expect(pullGame(fresh, source, read!, "fake-runner")).rejects.toThrow(HfError);
        expect(fresh.has("fake-runner")).toBe(false);
    });

    it("pushes a game's folder in a commit that removes what it no longer holds, then the index with the games already there", async (): Promise<void> => {
        // Already in the repo: another game, kept in the index.
        const other: HfGame = { ...(await publish()), id: "other-game", name: "Other" };
        write(path.join(hubDir, "index.json"), JSON.stringify(mergeIndex(undefined, [other], HF_LIBRARY_FORMAT)));
        const calls: string = path.join(root, "calls.txt");
        const cli: string = path.join(root, "hf");
        write(cli, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
        chmodSync(cli, 0o755);
        const lines: string[] = [];
        const index: HfIndex = await pushGames(trained, ["fake-runner"], { source, cli, log: (line: string): number => lines.push(line) });
        expect(index.games.map((g: HfGame): string => g.id)).toEqual(["fake-runner", "other-game"]);
        const made: string[] = readFileSync(calls, "utf-8").trim().split("\n");
        expect(made[0]).toMatch(new RegExp(`^upload ${REPO} \\S+/games/fake-runner games/fake-runner --repo-type model --private --delete \\* --commit-message fake-runner: \\d+ files$`));
        expect(made[1]).toMatch(new RegExp(`^upload ${REPO} \\S+ \\. --repo-type model --private --include index.json --include README.md --include LICENSE --commit-message index: fake-runner$`));
        expect(lines.join("\n")).toMatch(/fake-runner: \d+ files/);
    });
});
