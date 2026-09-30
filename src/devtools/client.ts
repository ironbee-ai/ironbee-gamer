/**
 * A thin client of the IronBee DevTools daemon (`POST /call`). The daemon owns
 * the browser; this process only sends tool calls, one session id per game run.
 */

import { randomUUID } from "crypto";
import { gameToolsPluginPath } from "./daemon";
import { GameTool, OpenRequest, OpenResult, ProbeResult, SpriteCropsResult, StepRequest, StepResult } from "./protocol";

const CALL_TIMEOUT_MS: number = 90_000;

export class DevtoolsError extends Error {
    constructor(
        message: string,
        readonly toolName: string,
        readonly code?: string
    ) {
        super(message);
        this.name = "DevtoolsError";
    }
}

export interface RecordingStopped {
    /** Absolute path of the written video, when a recording was running. */
    filePath?: string;
    parts?: string[];
}

/** What a game run needs of the browser: the game tools, a screenshot and the recording. */
export interface GameBrowser {
    open(request: OpenRequest): Promise<OpenResult>;
    step(request: StepRequest): Promise<StepResult>;
    probe(): Promise<ProbeResult>;
    spriteCrops(keys: string[]): Promise<SpriteCropsResult>;
    /** Saves what the screen shows as a PNG in `dir`; returns its path. */
    screenshot(dir: string, name: string): Promise<string | undefined>;
    startRecording(outputDir?: string): Promise<void>;
    stopRecording(): Promise<RecordingStopped>;
    close(): Promise<void>;
}

export interface DevtoolsClientOptions {
    baseUrl: string;
    /** One browser context per session id. Defaults to a fresh random id. */
    sessionId?: string;
}

export class DevtoolsClient implements GameBrowser {
    readonly baseUrl: string;
    readonly sessionId: string;

    constructor(options: DevtoolsClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.sessionId = options.sessionId ?? `ibgamer-${randomUUID()}`;
    }

    async call<T>(toolName: string, toolInput: object): Promise<T> {
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/call`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "session-id": this.sessionId,
                },
                body: JSON.stringify({ toolName, toolInput }),
                signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            });
        } catch (err: unknown) {
            const why: string = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "is not reachable";
            throw new DevtoolsError(`${toolName}: the IronBee DevTools daemon at ${this.baseUrl} ${why}`, toolName);
        }
        const body: any = await response.json().catch((): unknown => ({}));
        if (body?.toolError || !response.ok) {
            // A tool that failed (`toolError`), or a call the daemon refused (`error`: an unknown tool is a 404 "Tool Not Found").
            const message: string = body?.toolError
                ? String(body.toolError.message ?? "failed")
                : String(body?.error?.message ?? body?.message ?? `HTTP ${response.status}`);
            const code: string | undefined = body?.toolError?.code;
            if (/Tool Not Found/i.test(message) && toolName.startsWith("game_")) {
                // Not loaded (no TOOL_PLUGINS), or loaded and left out by a domain list that does not name them.
                throw new DevtoolsError(
                    `${toolName}: ${message} — the DevTools daemon at ${this.baseUrl} does not serve the game tools; start it with ` +
                        `TOOL_PLUGINS=${gameToolsPluginPath()}, and AVAILABLE_TOOL_DOMAINS unset (or naming game and content)`,
                    toolName,
                    code
                );
            }
            throw new DevtoolsError(`${toolName}: ${message}`, toolName, code);
        }
        return body.toolOutput as T;
    }

    open(request: OpenRequest): Promise<OpenResult> {
        return this.call<OpenResult>(GameTool.OPEN, request);
    }

    step(request: StepRequest): Promise<StepResult> {
        return this.call<StepResult>(GameTool.STEP, request);
    }

    probe(): Promise<ProbeResult> {
        return this.call<ProbeResult>(GameTool.PROBE, {});
    }

    spriteCrops(keys: string[]): Promise<SpriteCropsResult> {
        return this.call<SpriteCropsResult>(GameTool.SPRITE_CROPS, { keys });
    }

    async screenshot(dir: string, name: string): Promise<string | undefined> {
        const out: { filePath?: string; screenshotFilePath?: string } = await this.call("content_take-screenshot", {
            outputPath: dir,
            name,
            type: "png",
            fullPage: false,
            annotate: false,
        });
        return out.filePath ?? out.screenshotFilePath;
    }

    /** Starts the screencast; while it runs, frames reach the live view. */
    async startRecording(outputDir?: string): Promise<void> {
        await this.call("content_start-recording", {
            name: "ibgamer",
            showActions: false,
            ...(outputDir ? { outputDir } : {}),
        });
    }

    stopRecording(): Promise<RecordingStopped> {
        return this.call<RecordingStopped>("content_stop-recording", {});
    }

    /** Closes this session's browser context. Never throws. */
    async close(): Promise<void> {
        try {
            await fetch(`${this.baseUrl}/session`, {
                method: "DELETE",
                headers: { "session-id": this.sessionId },
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // The daemon may already be gone.
        }
    }
}
