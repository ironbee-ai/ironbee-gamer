import { Question, SystemOneClient, SystemOneResponse } from "./systemone";
import { DecisionEngine, EngineHealth, EngineKind } from "./types";

export const JEV_URL: string = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL: string = "jev-latest";

export interface JevEngineOptions {
    apiKey: string;
    model?: string;
    url?: string;
    fetchImpl?: typeof fetch;
}

export class JevEngine implements DecisionEngine {
    readonly kind: EngineKind = EngineKind.JEV;
    readonly label: string;
    private readonly client: SystemOneClient;
    private readonly hasKey: boolean;

    constructor(options: JevEngineOptions) {
        const model: string = options.model ?? DEFAULT_JEV_MODEL;
        this.label = `jev (${model})`;
        this.hasKey = Boolean(options.apiKey);
        this.client = new SystemOneClient({
            url: options.url ?? JEV_URL,
            apiKey: options.apiKey,
            model,
            label: "Jev",
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
        // A probe would cost tokens; configuration is what can be checked for free.
        return this.hasKey
            ? { ok: true, detail: "API key configured" }
            : { ok: false, detail: "TYPESAFE_API_KEY / JEV_API_KEY is not set" };
    }
}
