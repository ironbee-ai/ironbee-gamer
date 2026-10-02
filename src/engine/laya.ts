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
/**
 * keepWarm: idle this long, Laya is asked again. Its device idles down within a second: on an M-series GPU the
 * answer after 0.2 s idle took ~40–65 ms, after 2–5 s ~70–130 ms, against ~28 ms back to back.
 */
const KEEP_WARM_AFTER_MS: number = 100;
/** keepWarm: how often it looks whether Laya is idle. */
const KEEP_WARM_POLL_MS: number = 20;
/**
 * What keepWarm asks: the smallest question, as the server warms itself up at its start — not the last decision's
 * (a game's state, hundreds of tokens): the server answers one at a time, and a decision asked while a warm question
 * is answered waits for it. A game deciding seldom (one decision in ~400 ms) met one in flight often enough to land its
 * inputs well after their floor.
 */
const WARM_STATE: unknown = { warm: true };
const WARM_QUESTIONS: Record<string, Question> = { q: { type: "choice", instructions: "warm up", criteria: { a: "a", b: "b" } } };

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
    /** Questions asked and not answered yet (keepWarm's too), and since when none is. */
    private inFlight: number = 0;
    private idleSince: number = Date.now();

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

    async ask(state: unknown, questions: Record<string, Question>): Promise<SystemOneResponse> {
        this.inFlight++;
        try {
            return await this.client.ask(state, questions);
        } finally {
            this.inFlight--;
            this.idleSince = Date.now();
        }
    }

    warmUp(): void {
        this.client.warmUp();
    }

    /**
     * Asks again whenever Laya has been idle KEEP_WARM_AFTER_MS — the smallest question (WARM_QUESTIONS), never beside
     * one in flight: the server answers one at a time, so a decision asked meanwhile waits for one warm answer, the
     * shortest there is, where a cold one would take 70–130 ms. Steady play asks more often than that and is never joined.
     */
    keepWarm(): () => void {
        const timer: NodeJS.Timeout = setInterval((): void => {
            if (this.inFlight > 0 || Date.now() - this.idleSince < KEEP_WARM_AFTER_MS) {
                return;
            }
            this.inFlight++;
            this.client
                .ask(WARM_STATE, WARM_QUESTIONS)
                .catch((): void => {
                    // Only to keep the device busy: a decision asks on its own.
                })
                .finally((): void => {
                    this.inFlight--;
                    this.idleSince = Date.now();
                });
        }, KEEP_WARM_POLL_MS);
        timer.unref();
        return (): void => clearInterval(timer);
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
