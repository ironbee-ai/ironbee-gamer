import type { Config } from "jest";

// The live suite (tests/integration/) starts a real DevTools daemon from the
// built plugin (npm run build first); it runs only when IBGAMER_E2E=1.

const config: Config = {
    preset: "ts-jest",
    testEnvironment: "node",
    setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
    testMatch: ["**/tests/**/*.test.ts"],
    collectCoverageFrom: ["src/**/*.ts"],
    testPathIgnorePatterns: ["/node_modules/", "/research/"],
};

export default config;
