import { EpisodeResult } from "../../../src/play/player";
import { RunStore, summarizeEpisode } from "../../../src/run/runs";

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function episode(endScreenshot?: string): EpisodeResult {
    return {
        episode: 1,
        score: 3,
        over: true,
        gameSeconds: 2,
        wallSeconds: 1,
        steps: 4,
        decisions: 4,
        actionCounts: { JUMP: 4 },
        lastTicks: [],
        samples: [],
        extractErrors: 0,
        adviceFieldsDropped: 0,
        invalidAnswers: 0,
        ...(endScreenshot ? { endScreenshot } : {}),
    };
}

describe("a run's files", (): void => {
    let root: string;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-runs-"));
    });

    afterEach((): void => {
        rmSync(root, { recursive: true, force: true });
    });

    it("keeps an end screen's path in the run's directory: a training's are under work/shots-<version>/", (): void => {
        const dir: string = path.join(root, "run-1");
        expect(summarizeEpisode(episode(path.join(dir, "episode-1-end.png")), undefined, dir).endScreenshot).toBe("episode-1-end.png");
        expect(summarizeEpisode(episode(path.join(dir, "work", "shots-v2", "episode-1-end.png")), 2, dir)).toMatchObject({ endScreenshot: "work/shots-v2/episode-1-end.png", version: 2 });
        // Not in the run's directory (or none given): its name, as before.
        expect(summarizeEpisode(episode(path.join(root, "elsewhere", "end.png")), undefined, dir).endScreenshot).toBe("end.png");
        expect(summarizeEpisode(episode(path.join(dir, "work", "end.png"))).endScreenshot).toBe("end.png");
        expect(summarizeEpisode(episode()).endScreenshot).toBeUndefined();
    });

    it("says of a game that it was stopped: neither over nor out of its time, which the screen tells apart", (): void => {
        expect(summarizeEpisode({ ...episode(), stopped: true }).stopped).toBe(true);
        expect("stopped" in summarizeEpisode(episode())).toBe(false);
    });

    it("serves a file by its path in the run's directory, and nothing out of it", (): void => {
        const store: RunStore = new RunStore(root);
        const dir: string = store.runDir("run-000001");
        mkdirSync(path.join(dir, "work", "shots-v1"), { recursive: true });
        writeFileSync(path.join(dir, "work", "shots-v1", "episode-1-end.png"), "png");
        writeFileSync(path.join(dir, "video.webm"), "webm");
        writeFileSync(path.join(root, "secret.png"), "not the run's");
        symlinkSync(path.join(root, "secret.png"), path.join(dir, "work", "link.png"));

        expect(store.file("run-000001", "work/shots-v1/episode-1-end.png")).toBe(path.join(dir, "work", "shots-v1", "episode-1-end.png"));
        expect(store.file("run-000001", "video.webm")).toBe(path.join(dir, "video.webm"));
        for (const refused of ["../secret.png", "work/../../secret.png", "/etc/passwd", ".hidden", "work/.x/y.png", "work", "work/link.png", "missing.png"]) {
            expect(store.file("run-000001", refused)).toBeUndefined();
        }
        expect(store.file("../run-000001", "video.webm")).toBeUndefined();
    });
});
