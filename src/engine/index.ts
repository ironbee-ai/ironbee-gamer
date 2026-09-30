import { JevEngine } from "./jev";
import { LayaEngine } from "./laya";
import { DecisionEngine, EngineKind } from "./types";

export interface EngineConfig {
    kind: EngineKind;
    jev: { apiKey: string; model?: string; url?: string };
    laya: { url: string; apiKey?: string; model?: string };
}

export function createEngine(config: EngineConfig, fetchImpl?: typeof fetch): DecisionEngine {
    switch (config.kind) {
        case EngineKind.JEV:
            return new JevEngine({ ...config.jev, fetchImpl });
        case EngineKind.LAYA:
            return new LayaEngine({ ...config.laya, fetchImpl });
        case EngineKind.RULES:
            // The rules are a profile's: the player makes them from the profile it plays (RulesTeacher).
            throw new Error("the rules engine plays a profile's own rules: make it from the profile (RulesTeacher)");
    }
}

export * from "./types";
export { validateChoice, ChoiceAnswer, DecisionEngineError, InvalidAnswerError, Question } from "./systemone";
