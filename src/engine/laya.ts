/**
 * Laya: an open decision model (ModernBERT encoders, `pip install "laya[serve]"`) whose server,
 * `laya-serve`, speaks the same `/v1/systemone` protocol as Jev — so the same client asks it.
 * It runs on this machine: a decision costs its inference (tens of milliseconds), not a round trip
 * to another continent. Its base checkpoints are close to chance on unfamiliar decisions until
 * fine-tuned; a game's decisions, logged from Jev's play, are that fine-tuning's data.
 *
 *   LAYA_HOST=127.0.0.1 laya-serve        # 127.0.0.1:8000
 */

import { Question, SystemOneClient, SystemOneResponse } from "./systemone";
import { DecisionEngine, EngineHealth, EngineKind } from "./types";

export const DEFAULT_LAYA_URL: string = "http://127.0.0.1:8000";
const HEALTH_TIMEOUT_MS: number = 2_000;

export interface LayaEngineOptions {
    /** Base URL of the server. */
    url?: string;
    /** The server's LAYA_API_KEY, when it requires one. */
    apiKey?: string;
    /** The checkpoint to ask (e.g. english, typed-decisions, or a fine-tuned one the server loads); unset: the server's pick. */
    model?: string;
    fetchImpl?: typeof fetch;
}

export class LayaEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.LAYA;
    readonly label: string;
    private readonly client: SystemOneClient;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: LayaEngineOptions = {}) {
        this.baseUrl = (options.url ?? DEFAULT_LAYA_URL).replace(/\/$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.label = `laya (${options.model ?? "server default"})`;
        this.client = new SystemOneClient({
            url: `${this.baseUrl}/v1/systemone`,
            apiKey: options.apiKey,
            model: options.model,
            label: "Laya",
            timeoutMs: 10_000,
            fetchImpl: options.fetchImpl,
        });
    }

    ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        return this.client.ask(state, questions);
    }

    warmUp(): void {
        this.client.warmUp();
    }

    async health(): Promise<EngineHealth> {
        try {
            const response: Response = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            return response.ok ? { ok: true, detail: `server at ${this.baseUrl}` } : { ok: false, detail: `HTTP ${response.status} from ${this.baseUrl}` };
        } catch {
            return { ok: false, detail: `no Laya server at ${this.baseUrl} (start one: laya-serve)` };
        }
    }
}
