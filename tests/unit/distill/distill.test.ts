import { checkpointFor, checkpointProfileVersion, checkpointsToServe, currentCheckpoints } from "../../../src/distill/laya-play";
import { LayaCheckpoint, layaCheckpoints } from "../../../src/distill/laya-runtime";
import { Profile } from "../../../src/game/types";
import { Library } from "../../../src/library/store";
import { DecisionRecord, Pace, Player } from "../../../src/play/player";
import { DecisionLog, decisionFiles, profileHash } from "../../../src/run/decision-log";
import { FakeEngine, jumpWhenClose } from "../../helpers/fake-engine";
import { fakeGameDefinition, FakeGame, fakeProfile } from "../../helpers/fake-game";

import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("distillation data and checkpoints", (): void => {
    let root: string;
    let library: Library;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-distill-"));
        library = new Library(path.join(root, "built-in"), path.join(root, "user"));
        library.saveGame(fakeGameDefinition());
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("logs every answered question as a row: the state, the question as asked, the teacher's probabilities", async (): Promise<void> => {
        const profile = fakeProfile();
        const log: DecisionLog = new DecisionLog(library, "fake-runner", profile, "jev (test)");
        expect(path.basename(log.file)).toBe(`v1-${profileHash(profile)}.jsonl`);
        await new Player(new FakeGame(), new FakeEngine(jumpWhenClose)).play({
            game: fakeGameDefinition(),
            profile,
            episodes: 1,
            gameSeconds: 1,
            pace: Pace.TURN,
            hooks: { onDecision: (d): void => log.append(d) },
        });
        const rows: Array<Record<string, any>> = readFileSync(log.file, "utf-8").trim().split("\n").map((l: string): Record<string, any> => JSON.parse(l));
        expect(rows.length).toBeGreaterThan(10);
        expect(rows[0]).toMatchObject({
            state: { dx: expect.any(Number), air: false },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: fakeGameDefinition().goal, instructions: profile.instructions },
            choice: "NOOP",
            probabilities: { NOOP: 1, JUMP: 0 },
            engine: "jev (test)",
            profileVersion: 1,
        });
        expect(decisionFiles(library, "fake-runner")).toEqual([{ file: log.file, bytes: expect.any(Number) }]);
    });

    it("a row that cannot be written never stops a play's log, and throws in a distillation's (strict), naming the file — neither keeps a row cut short", (): void => {
        const profile = fakeProfile();
        const play: DecisionLog = new DecisionLog(library, "fake-runner", profile, "jev (test)");
        const data: DecisionLog = new DecisionLog(library, "fake-runner", profile, "rules v1", "rules", { strict: true });
        const record: DecisionRecord = {
            state: { dx: 20, air: false },
            criteria: { NOOP: "Keep running", JUMP: "Jump" },
            instructions: { goal: "g", instructions: "i" },
            choice: "JUMP",
            probabilities: { NOOP: 0, JUMP: 1 },
            confidence: 1,
            ms: 1,
        };
        play.append(record);
        data.append(record);
        // A full disk: part of a row goes in, then the write fails.
        jest.spyOn(fs, "appendFileSync").mockImplementation((target: fs.PathOrFileDescriptor, text: string | NodeJS.ArrayBufferView): void => {
            fs.writeSync(target as number, String(text).slice(0, 25));
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        });
        try {
            expect((): void => play.append(record)).not.toThrow();
            expect((): void => data.append(record)).toThrow(`a row could not be written to ${data.file}: ENOSPC: no space left on device, write`);
        } finally {
            jest.restoreAllMocks();
        }
        // One row format, whole rows only: every line one of them.
        for (const log of [play, data]) {
            const lines: string[] = readFileSync(log.file, "utf-8").split("\n");
            expect(lines.pop()).toBe("");
            expect(lines.map((l: string): unknown => JSON.parse(l))).toEqual([{ ...record, engine: log === play ? "jev (test)" : "rules v1", profileVersion: 1, at: expect.any(Number) }]);
        }
    });

    it("keeps the rows of two extractors apart", (): void => {
        const a: DecisionLog = new DecisionLog(library, "fake-runner", fakeProfile(), "jev");
        const b: DecisionLog = new DecisionLog(library, "fake-runner", fakeProfile({ extractor: "function extract() { return {}; }" }), "jev");
        expect(a.file).not.toBe(b.file);
    });

    it("lists a game's checkpoints, newest first, and reads the profile version from the name", (): void => {
        const make = (name: string, t: number): void => {
            const dir: string = path.join(root, "user", "fake-runner", "laya", name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
            writeFileSync(path.join(dir, "model.safetensors"), "x");
            writeFileSync(path.join(dir, "training.json"), JSON.stringify({ rows: t }));
            const when: Date = new Date(Date.now() - (10 - t) * 60_000);
            require("fs").utimesSync(path.join(dir, "model.safetensors"), when, when);
        };
        make("v1-aaaa-r0", 1);
        make("v2-bbbb-r1", 2);
        writeFileSync(path.join(root, "user", "fake-runner", "laya", "v1-aaaa-r0", "distill.json"), JSON.stringify({ student: { mean: 12.5, scores: [12, 13] } }));
        mkdirSync(path.join(root, "user", "fake-runner", "laya", "not-a-checkpoint"), { recursive: true });
        const list = layaCheckpoints(library, "fake-runner");
        expect(list.map((c: { name: string }): string => c.name)).toEqual(["v2-bbbb-r1", "v1-aaaa-r0"]);
        expect(list[0].training).toEqual({ rows: 2 });
        // The student's mean recorded when it was distilled; none for one never measured.
        expect(list[1].studentMean).toBe(12.5);
        expect(list[0].studentMean).toBeUndefined();
        expect(checkpointProfileVersion(list[0])).toBe(2);
        expect(layaCheckpoints(library, "nothing-here")).toEqual([]);
    });

    it("plays the checkpoint of the version asked for, else the active version's, else the newest", (): void => {
        const checkpoint = (name: string): LayaCheckpoint => ({ gameId: "g", name, dir: `/laya/${name}`, createdAt: 0 });
        // newest first: v7 was distilled after v4, and v4 twice
        const list: LayaCheckpoint[] = [checkpoint("v7-cccc-r0"), checkpoint("v4-bbbb-r5"), checkpoint("v4-aaaa-r0")];
        const name = (c: LayaCheckpoint | undefined): string | undefined => c?.name;
        expect(name(checkpointFor(list, 7, 4))).toBe("v7-cccc-r0");
        expect(name(checkpointFor(list, 4, 7))).toBe("v4-bbbb-r5");
        // a version with no checkpoint gets none: another version's model reads another extractor's states
        expect(checkpointFor(list, 5, 4)).toBeUndefined();
        // nothing asked for: the active version's, though a newer version has one
        expect(name(checkpointFor(list, undefined, 4))).toBe("v4-bbbb-r5");
        // the active version has none: the newest
        expect(name(checkpointFor(list, undefined, 8))).toBe("v7-cccc-r0");
        expect(name(checkpointFor(list, undefined, undefined))).toBe("v7-cccc-r0");
        expect(checkpointFor([], undefined, 4)).toBeUndefined();
    });

    it("plays a version's checkpoint whose student played best when it was distilled, not a newer round never measured", (): void => {
        const checkpoint = (name: string, studentMean?: number): LayaCheckpoint => ({ gameId: "g", name, dir: `/laya/${name}`, createdAt: 0, ...(studentMean !== undefined ? { studentMean } : {}) });
        const name = (c: LayaCheckpoint | undefined): string | undefined => c?.name;
        // Newest first: r5 fine-tuned by a resumed run that was stopped before its student played the seeds.
        const stopped: LayaCheckpoint[] = [checkpoint("v4-aaaa-r5"), checkpoint("v4-aaaa-r4", 30), checkpoint("v3-cccc-r0", 12)];
        expect(name(checkpointFor(stopped, 4, 4))).toBe("v4-aaaa-r4");
        expect(name(checkpointFor(stopped, undefined, 4))).toBe("v4-aaaa-r4");
        // No active version's: the newest checkpoint's version, and of its checkpoints the measured one.
        expect(name(checkpointFor(stopped, undefined, 9))).toBe("v4-aaaa-r4");
        // The best measured, the newer at a tie.
        expect(name(checkpointFor([checkpoint("v4-aaaa-r6", 20), checkpoint("v4-aaaa-r5", 31), checkpoint("v4-aaaa-r4", 31)], 4, undefined))).toBe("v4-aaaa-r5");
        // None measured: the newest, as before.
        expect(name(checkpointFor([checkpoint("v4-aaaa-r5"), checkpoint("v4-aaaa-r4")], 4, undefined))).toBe("v4-aaaa-r5");
    });

    /** A checkpoint directory of the fake runner, its weights written `minutesAgo`, with the student's recorded mean when given. */
    const make = (name: string, minutesAgo: number, studentMean?: number): string => {
        const dir: string = path.join(root, "user", "fake-runner", "laya", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "rl_agent_config.json"), "{}");
        writeFileSync(path.join(dir, "model.safetensors"), "x");
        if (studentMean !== undefined) {
            writeFileSync(path.join(dir, "distill.json"), JSON.stringify({ student: { mean: studentMean, scores: [studentMean] } }));
        }
        const when: Date = new Date(Date.now() - minutesAgo * 60_000);
        utimesSync(path.join(dir, "model.safetensors"), when, when);
        return dir;
    };

    it("serves each game's checkpoint a play takes (the active version's), not the newest of another version", (): void => {
        library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const v2: Profile = library.saveProfile("fake-runner", { ...fakeProfile({ tickMs: 32 }) } as never);
        // Named as the distiller names them: the version, and the hash of what its states are made of (the same for both).
        const hash: string = profileHash(v2);
        const first: string = make(`v1-${hash}-r0`, 10);
        // Distilled later, for the version that is not active.
        const second: string = make(`v2-${hash}-r0`, 1);
        library.setActive("fake-runner", 1);
        expect(checkpointsToServe(library, ["fake-runner", "nothing-here"])).toEqual({ "fake-runner": first });
        library.setActive("fake-runner", 2);
        expect(checkpointsToServe(library, ["fake-runner"])).toEqual({ "fake-runner": second });
        // A later round of v2 that a stopped run never measured: the measured one is still served.
        writeFileSync(path.join(second, "distill.json"), JSON.stringify({ student: { mean: 20, scores: [20, 20] } }));
        make(`v2-${hash}-r1`, 0);
        expect(checkpointsToServe(library, ["fake-runner"])).toEqual({ "fake-runner": second });
    });

    it("plays only checkpoints that learnt their version as it is now: not one of the version before it was edited, however well it played", (): void => {
        const v1: Profile = library.saveProfile("fake-runner", { ...fakeProfile() } as never);
        const current: string = make(`v1-${profileHash(v1)}-r0`, 10, 20);
        // Distilled later, from v1 as it was before its extractor was edited in place: another extractor's states.
        make("v1-0123abcd-r1", 1, 99);
        expect(currentCheckpoints(library, "fake-runner").map((c: LayaCheckpoint): string => c.dir)).toEqual([current]);
        expect(checkpointsToServe(library, ["fake-runner"])).toEqual({ "fake-runner": current });
        // None of the version as it is now: none served (the stale one is not taken instead).
        rmSync(current, { recursive: true, force: true });
        expect(checkpointsToServe(library, ["fake-runner"])).toEqual({});
        // Nor one of a version the library no longer has.
        make("v7-0123abcd-r0", 0);
        expect(currentCheckpoints(library, "fake-runner")).toEqual([]);
    });
});
