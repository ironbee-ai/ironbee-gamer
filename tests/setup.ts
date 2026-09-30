/**
 * Global jest setup (setupFilesAfterEnv). Keeps the suite hermetic: no test
 * may pick up a developer's engine keys, library or runs from the environment.
 */

const HERMETIC_VARS: string[] = [
    "TYPESAFE_API_KEY",
    "JEV_API_KEY",
    "TYPESAFE_URL",
    "JEV_MODEL",
    "LAYA_URL",
    "LAYA_MODEL",
    "LAYA_API_KEY",
    "IBGAMER_ENGINE",
    "IBGAMER_DAEMON_URL",
    "IBGAMER_UI_PORT",
    "IBGAMER_LIBRARY_DIR",
    "IBGAMER_RUNS_DIR",
    "CLAUDE_CODE_CLI",
];

for (const name of HERMETIC_VARS) {
    delete process.env[name];
}

process.env.IBGAMER_HOME = "/nonexistent/ironbee-gamer-tests";
