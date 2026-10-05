import { askClaude, claudeModelFor, cutOffAt, streamModel, TrainerError, TrainerModel, TrainerProvider, TrainerTimeoutError } from "../../../src/train/claude";
import { askCodex, CODEX_DEFAULT_MODEL, codexArgs, CodexModel, codexModels } from "../../../src/train/codex";
import {
    askClaudeAliases,
    askTrainer,
    claudeAliasesDue,
    defaultTrainerModel,
    modelDisplayName,
    noteTrainerModel,
    parseTrainerChoice,
    readTrainerChoice,
    readTrainerModelsSeen,
    timeLimitRule,
    resolveTrainer,
    settingsFile,
    trainerCommand,
    trainerHealth,
    TrainerModelInfo,
    trainerModels,
    writeTrainerChoice,
} from "../../../src/train/trainer-cli";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

describe("the trainer's CLI: which one, which model", (): void => {
    let root: string;

    beforeEach((): void => {
        root = mkdtempSync(path.join(tmpdir(), "ibgamer-trainer-cli-"));
    });

    afterEach((): void => {
        delete process.env.TYPESAFE_API_KEY;
        rmSync(root, { recursive: true, force: true });
    });

    /** A stand-in Codex CLI: logs how it was run, then acts as `body` says (`$LAST` is where its last message goes). */
    function fakeCodex(body: string): { command: string; log: string } {
        const command: string = path.join(root, "codex");
        const log: string = path.join(root, "codex.log");
        writeFileSync(
            command,
            `#!/bin/sh
echo "args: $@" >> "${log}"
echo "cwd: $(pwd)" >> "${log}"
echo "key: \${TYPESAFE_API_KEY:-none}" >> "${log}"
echo "stdin: $(cat)" >> "${log}"
LAST=""
while [ $# -gt 0 ]; do
    if [ "$1" = "-o" ]; then LAST="$2"; fi
    shift
done
${body}
`
        );
        chmodSync(command, 0o755);
        return { command, log };
    }

    function codex(command: string, model: string = "gpt-test"): TrainerModel {
        return { provider: TrainerProvider.CODEX, command, model, timeoutMs: 20_000 };
    }

    it("lists Codex's models from what the CLI fetched: the shown ones in its order, the newest Sol the default — its own default alone when it never ran", (): void => {
        const home: string = path.join(root, "codex-home");
        mkdirSync(home);
        // No cache yet.
        expect(codexModels(home)).toEqual([{ id: CODEX_DEFAULT_MODEL, name: "Codex's own default", default: true }]);
        writeFileSync(
            path.join(home, "models_cache.json"),
            JSON.stringify({
                models: [
                    { slug: "gpt-9-luna", display_name: "GPT-9-Luna", priority: 3 },
                    { slug: "gpt-9-sol", display_name: "GPT-9-Sol", priority: 2 },
                    { slug: "gpt-hidden", visibility: "hide", priority: 0 },
                    { slug: "gpt-10-astra", priority: 1 },
                    { display_name: "no slug" },
                ],
            })
        );
        expect(codexModels(home)).toEqual([
            { id: "gpt-10-astra", name: "gpt-10-astra" },
            { id: "gpt-9-sol", name: "GPT-9-Sol", default: true },
            { id: "gpt-9-luna", name: "GPT-9-Luna" },
        ]);
        // No Sol among them: the first listed.
        writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "a" }, { slug: "b" }] }));
        expect(codexModels(home).find((m: CodexModel): boolean => m.default === true)?.id).toBe("a");
        // A cache that is not one: as none.
        writeFileSync(path.join(home, "models_cache.json"), "not json");
        expect(codexModels(home)).toHaveLength(1);
        expect(defaultTrainerModel(TrainerProvider.CODEX, { CODEX_HOME: home })).toBe(CODEX_DEFAULT_MODEL);
        expect(defaultTrainerModel(TrainerProvider.CLAUDE_CODE)).toBe("opus");
        expect(trainerModels(TrainerProvider.CLAUDE_CODE).map((m: TrainerModelInfo): string => m.id)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    });

    it("asks Codex once in the work directory — read-only, nothing saved, none of the user's configuration, none of this process's keys — and returns its last message", async (): Promise<void> => {
        const work: string = path.join(root, "work");
        mkdirSync(work);
        writeFileSync(path.join(work, "sample.json"), "{}");
        const fake: { command: string; log: string } = fakeCodex('printf \'{"extractor": "..."}\' > "$LAST"');
        process.env.TYPESAFE_API_KEY = "secret-key";
        const answer: string = await askTrainer(codex(fake.command), "Read ./sample.json and write a profile.", work);
        expect(answer).toBe('{"extractor": "..."}');
        const logged: string = readFileSync(fake.log, "utf-8");
        const args: string = /^args: (.*)$/m.exec(logged)![1];
        expect(args).toMatch(/^exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --color never -o \S+last-message\.txt -m gpt-test -$/);
        expect(/^cwd: (.*)$/m.exec(logged)![1]).toBe(realpathSync(work));
        expect(logged).toContain("stdin: Read ./sample.json and write a profile.");
        // The run's keys stay in this process.
        expect(logged).toContain("key: none");
        // Its last message was written outside the work directory, and that file is gone.
        expect(readdirSync(work)).toEqual(["sample.json"]);
        const last: string = / -o (\S+)/.exec(args)![1];
        expect(last.startsWith(work)).toBe(false);
        expect(existsSync(last)).toBe(false);
        // Codex's own default model: no -m.
        expect(codexArgs(CODEX_DEFAULT_MODEL, "/tmp/last.txt")).not.toContain("-m");
    });

    it("fails with what Codex said when it exits with an error, when it writes no last message, and when it is not installed", async (): Promise<void> => {
        const work: string = path.join(root, "work");
        mkdirSync(work);
        const failing: { command: string } = fakeCodex('echo "error: not logged in" >&2\nexit 3');
        await expect(askCodex(codex(failing.command), "p", work)).rejects.toThrow(/^codex exited with 3: error: not logged in$/);
        const silent: { command: string } = fakeCodex("exit 0");
        await expect(askCodex(codex(silent.command), "p", work)).rejects.toThrow("codex returned no result");
        const missing: Promise<string> = askCodex(codex(path.join(root, "no-codex")), "p", work);
        await expect(missing).rejects.toBeInstanceOf(TrainerError);
        await expect(missing).rejects.toThrow(/Codex CLI .* is not installed/);
    });

    it("says whether the trainer's CLI is there, by its name and model", (): void => {
        const fake: { command: string } = fakeCodex("exit 0");
        expect(trainerHealth(codex(fake.command, "gpt-9-sol"))).toEqual({ ok: true, detail: "Codex CLI (gpt-9-sol)" });
        expect(trainerHealth({ command: fake.command, model: "opus" })).toEqual({ ok: true, detail: "Claude Code CLI (opus)" });
        const missing: string = path.join(root, "nothing");
        expect(trainerHealth(codex(missing))).toEqual({ ok: false, detail: `${missing} is not on PATH: training needs the Codex CLI` });
        expect(trainerCommand(TrainerProvider.CODEX, {})).toBe("codex");
        expect(trainerCommand(TrainerProvider.CODEX, { CODEX_CLI: "/opt/codex" })).toBe("/opt/codex");
        expect(trainerCommand(TrainerProvider.CLAUDE_CODE, { CLAUDE_CODE_CLI: "/opt/claude" })).toBe("/opt/claude");
    });

    it("takes the trainer from the environment when it names one, else the one kept in the settings file, else the Claude Code CLI with Opus", (): void => {
        const home: string = path.join(root, "home");
        const codexHome: string = path.join(root, "no-codex-home");
        expect(resolveTrainer(home, {})).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "opus", fromEnv: false });
        // Chosen in the UI: kept beside whatever else the file holds.
        mkdirSync(home);
        writeFileSync(settingsFile(home), JSON.stringify({ other: 1 }));
        writeTrainerChoice(home, { provider: TrainerProvider.CODEX, model: "gpt-9-sol" });
        expect(JSON.parse(readFileSync(settingsFile(home), "utf-8"))).toEqual({ other: 1, trainer: { provider: "codex", model: "gpt-9-sol" } });
        expect(readTrainerChoice(home)).toEqual({ provider: TrainerProvider.CODEX, model: "gpt-9-sol" });
        expect(resolveTrainer(home, {})).toEqual({ provider: TrainerProvider.CODEX, model: "gpt-9-sol", fromEnv: false });
        // The environment wins, and says so (the UI cannot change it then).
        expect(resolveTrainer(home, { IBGAMER_TRAINER_MODEL: "sonnet" })).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "sonnet", fromEnv: true });
        expect(resolveTrainer(home, { IBGAMER_TRAINER_PROVIDER: "codex", CODEX_HOME: codexHome })).toEqual({ provider: TrainerProvider.CODEX, model: CODEX_DEFAULT_MODEL, fromEnv: true });
        expect((): unknown => resolveTrainer(home, { IBGAMER_TRAINER_PROVIDER: "gemini" })).toThrow(/IBGAMER_TRAINER_PROVIDER must be one of claude-code, codex/);
        // A settings file that holds no trainer this reads: as none.
        writeFileSync(settingsFile(home), JSON.stringify({ trainer: { provider: "codex", model: "a b; rm -rf" } }));
        expect(readTrainerChoice(home)).toBeUndefined();
        expect(resolveTrainer(home, {}).provider).toBe(TrainerProvider.CLAUDE_CODE);
    });

    it("notes the model the Claude Code CLI ran a call with, for the alias it was asked with: kept in the home's settings, written only when it is news", async (): Promise<void> => {
        const home: string = path.join(root, "home");
        const work: string = path.join(root, "work");
        mkdirSync(work);
        // A stand-in Claude Code CLI: its stream starts by saying its model, as the real one does.
        const claude: string = path.join(root, "claude");
        const stream: string[] = [
            JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-9-1", tools: ["Read"] }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"ok": true}' }] } }),
            JSON.stringify({ type: "result", result: '{"ok": true}', is_error: false }),
        ];
        writeFileSync(claude, `#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n${stream.join("\n")}\nEOF\n`);
        chmodSync(claude, 0o755);
        expect(streamModel(stream.join("\n"))).toBe("claude-opus-9-1");
        expect(streamModel('{"type":"assistant","message":{"content":[{"type":"text","text":"\\"init\\" is a word"}]}}')).toBeUndefined();
        expect(streamModel("not a stream")).toBeUndefined();

        const told: string[] = [];
        expect(await askClaude({ command: claude, model: "opus" }, "p", work, undefined, (model: string): number => told.push(model))).toBe('{"ok": true}');
        expect(told).toEqual(["claude-opus-9-1"]);

        // Through the trainer with a home: noted beside the trainer chosen, whatever else the file holds kept.
        writeTrainerChoice(home, { provider: TrainerProvider.CLAUDE_CODE, model: "opus" });
        expect(readTrainerModelsSeen(home)).toEqual({});
        await askTrainer({ provider: TrainerProvider.CLAUDE_CODE, command: claude, model: "opus", home }, "p", work);
        expect(readTrainerModelsSeen(home)).toEqual({ "claude-code": { opus: "claude-opus-9-1" } });
        expect(JSON.parse(readFileSync(settingsFile(home), "utf-8"))).toEqual({ trainer: { provider: "claude-code", model: "opus" }, trainerModels: { "claude-code": { opus: "claude-opus-9-1" } } });
        // The same again: nothing written. Another alias, a newer model: added, replaced.
        const before: number = statSync(settingsFile(home)).mtimeMs;
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "opus", "claude-opus-9-1");
        expect(statSync(settingsFile(home)).mtimeMs).toBe(before);
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "sonnet", "claude-sonnet-9-1[1m]");
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "opus", "claude-opus-9-2");
        expect(readTrainerModelsSeen(home)).toEqual({ "claude-code": { opus: "claude-opus-9-2", sonnet: "claude-sonnet-9-1[1m]" } });
        // Not a model's name, or the alias itself: not noted. A trainer with no home notes nothing.
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "haiku", "a model; rm -rf");
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "fable", "fable");
        expect(Object.keys(readTrainerModelsSeen(home)["claude-code"]!).sort()).toEqual(["opus", "sonnet"]);
        await askTrainer({ command: claude, model: "haiku" }, "p", work);
        expect(readTrainerModelsSeen(home)["claude-code"]!.haiku).toBeUndefined();
    });

    it("asks the Claude Code CLI what its aliases stand for — a run begun and ended once it has said — and names a model as a person reads it", async (): Promise<void> => {
        const home: string = path.join(root, "home");
        // A stand-in CLI: says the model its alias stands for at its start, as the real one does, then would go on working.
        // It knows no Fable: it ends with nothing said.
        const claude: string = path.join(root, "claude");
        writeFileSync(
            claude,
            `#!/bin/sh
M=""
while [ $# -gt 0 ]; do if [ "$1" = "--model" ]; then M="$2"; fi; shift; done
cat > /dev/null
if [ "$M" = "fable" ]; then exit 1; fi
if [ "$M" = "haiku" ]; then V="4-5-20251001"; else V="9-1"; fi
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"model\\":\\"claude-$M-$V\\"}"
exec sleep 20
`
        );
        chmodSync(claude, 0o755);
        const started: number = Date.now();
        expect(await claudeModelFor(claude, "opus")).toBe("claude-opus-9-1");
        // Ended as soon as it said: not after the work it would have gone on with.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(await claudeModelFor(claude, "fable")).toBeUndefined();
        expect(await claudeModelFor(path.join(root, "no-claude"), "opus")).toBeUndefined();

        // All of them at once, noted with when: due again only for the one it did not answer for, or a week on.
        expect(claudeAliasesDue(home)).toBe(true);
        const now: number = Date.parse("2026-10-06T10:00:00Z");
        await askClaudeAliases(home, claude, now);
        expect(readTrainerModelsSeen(home)).toEqual({ "claude-code": { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-9-1", opus: "claude-opus-9-1" } });
        expect(JSON.parse(readFileSync(settingsFile(home), "utf-8")).trainerModelsAt).toBe("2026-10-06T10:00:00.000Z");
        expect(claudeAliasesDue(home, now + 60_000)).toBe(true);
        noteTrainerModel(home, TrainerProvider.CLAUDE_CODE, "fable", "claude-fable-9-1");
        expect(claudeAliasesDue(home, now + 60_000)).toBe(false);
        expect(claudeAliasesDue(home, now + 8 * 24 * 60 * 60 * 1000)).toBe(true);
        // A CLI that says nothing at all (not logged in): nothing noted, asked again next time.
        const silent: string = path.join(root, "home-2");
        await askClaudeAliases(silent, path.join(root, "no-claude"), now);
        expect(existsSync(settingsFile(silent))).toBe(false);

        // A model's id, as its provider names the model: its family and version, read off the id.
        expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
        expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
        expect(modelDisplayName("claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5 (1M context)");
        expect(modelDisplayName("claude-fable-6")).toBe("Fable 6");
        expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
        // Not an id of that shape: as it is.
        expect(modelDisplayName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
        expect(modelDisplayName("opus")).toBe("opus");
    }, 30_000);

    it("asks each CLI with the effort chosen, in its own way, and none when none is: its own default", async (): Promise<void> => {
        const work: string = path.join(root, "work");
        mkdirSync(work);
        // Codex: a configuration override, after its model.
        expect(codexArgs("gpt-test", "/tmp/last.txt", "high").slice(-5)).toEqual(["-m", "gpt-test", "-c", 'model_reasoning_effort="high"', "-"]);
        expect(codexArgs("gpt-test", "/tmp/last.txt").join(" ")).not.toContain("model_reasoning_effort");
        // Not a level's name: left out, never a configuration of its own.
        expect(codexArgs("gpt-test", "/tmp/last.txt", 'x" -c danger="1').join(" ")).not.toContain("model_reasoning_effort");
        const fake: { command: string; log: string } = fakeCodex('printf "ok" > "$LAST"');
        await askTrainer({ ...codex(fake.command), effort: "low" }, "p", work);
        expect(readFileSync(fake.log, "utf-8")).toMatch(/^args: .* -m gpt-test -c model_reasoning_effort="low" -$/m);

        // Claude Code: its --effort flag.
        const claude: string = path.join(root, "claude");
        const log: string = path.join(root, "claude.log");
        const answer: string = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
        writeFileSync(claude, `#!/bin/sh\necho "args: $@" >> "${log}"\necho "stdin: $(cat)" >> "${log}"\ncat <<'EOF'\n${answer}\nEOF\n`);
        chmodSync(claude, 0o755);
        await askTrainer({ command: claude, model: "opus", effort: "medium" }, "the prompt", work);
        await askTrainer({ command: claude, model: "opus" }, "the prompt", work);
        const calls: string[] = readFileSync(log, "utf-8").split("\n").filter((l: string): boolean => l.startsWith("args: "));
        expect(calls[0]).toContain("--model opus --effort medium --tools Read");
        expect(calls[1]).toContain("--model opus --tools Read");
        expect(calls[1]).not.toContain("--effort");

        // Each model with the efforts it takes: Claude Code's are its CLI's, Codex's the ones it lists (and its own default).
        expect(trainerModels(TrainerProvider.CLAUDE_CODE).every((m: TrainerModelInfo): boolean => m.efforts?.join(",") === "low,medium,high,xhigh,max" && m.defaultEffort === undefined)).toBe(true);
        const home: string = path.join(root, "codex-home");
        mkdirSync(home);
        writeFileSync(
            path.join(home, "models_cache.json"),
            JSON.stringify({ models: [{ slug: "gpt-9-sol", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "not a level!" }, "ultra"] }, { slug: "gpt-9-old" }] })
        );
        expect(codexModels(home)).toEqual([
            { id: "gpt-9-sol", name: "gpt-9-sol", efforts: ["low", "high", "ultra"], defaultEffort: "low", default: true },
            { id: "gpt-9-old", name: "gpt-9-old" },
        ]);
        expect(trainerHealth({ command: claude, model: "opus", effort: "medium" })).toEqual({ ok: true, detail: "Claude Code CLI (opus, medium effort)" });
    });

    it("tells the trainer its time limit at the end of every prompt, and says of a call cut off at it that it ran out of time, and how far it had got", async (): Promise<void> => {
        const work: string = path.join(root, "work");
        mkdirSync(work);
        expect(timeLimitRule(30 * 60_000)).toMatch(/^TIME LIMIT: this whole call .* is cut off after 30 minutes, and a reply not finished by then is lost whole/);
        // The last thing each CLI reads.
        const fake: { command: string; log: string } = fakeCodex('printf "ok" > "$LAST"');
        await askTrainer({ ...codex(fake.command), timeoutMs: 20 * 60_000 }, "Write the profile.", work);
        expect(readFileSync(fake.log, "utf-8")).toMatch(/stdin: Write the profile\.\n\nTIME LIMIT: this whole call .* is cut off after 20 minutes/);

        // A CLI that goes on past its limit: cut off, and a failure of its own kind (a training tells its next attempt).
        const slow: string = path.join(root, "slow-claude");
        const thinking: string = JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 41050 });
        writeFileSync(slow, `#!/bin/sh\ncat > /dev/null\necho '${thinking}'\nexec sleep 20\n`);
        chmodSync(slow, 0o755);
        const cut: Promise<string> = askClaude({ command: slow, model: "opus", timeoutMs: 1_500 }, "p", work);
        await expect(cut).rejects.toBeInstanceOf(TrainerTimeoutError);
        // Its limit in minutes (a whole one at least in words), and what it was doing — not its stream's last line.
        await expect(cut).rejects.toThrow(/^claude stopped \(SIGTERM\): over its 0-minute limit — it was still reading and thinking: none of its answer was written$/);
        const slowCodex: { command: string } = fakeCodex("exec sleep 20");
        const cutCodex: Promise<string> = askCodex({ ...codex(slowCodex.command), timeoutMs: 1_500 }, "p", work);
        await expect(cutCodex).rejects.toBeInstanceOf(TrainerTimeoutError);
        await expect(cutCodex).rejects.toMatchObject({ minutes: 0 });

        // How far a cut-off call had got, by its stream: nothing of its answer, or part of it (text after its last tool call).
        const read: string = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the runs." }, { type: "tool_use" }] } });
        const part: string = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"analysis": "the' }] } });
        expect(cutOffAt([thinking, read].join("\n"))).toBe("it was still reading and thinking: none of its answer was written");
        expect(cutOffAt([thinking, read, part].join("\n"))).toBe("its answer was cut off part way");
        expect(cutOffAt("")).toBe("it was still reading and thinking: none of its answer was written");

        // Stopped by whoever asked (a run's Stop) is no time limit run out.
        const stop: AbortController = new AbortController();
        const stopped: Promise<string> = askClaude({ command: slow, model: "opus", timeoutMs: 60_000 }, "p", work, stop.signal);
        setTimeout((): void => stop.abort(), 300);
        await expect(stopped).rejects.toThrow(/^claude was stopped$/);
        await expect(stopped).rejects.not.toBeInstanceOf(TrainerTimeoutError);
    }, 30_000);

    it("takes a choice only of a provider there is and a model id a CLI takes", (): void => {
        expect(parseTrainerChoice({ provider: "codex", model: "gpt-5.6-sol" })).toEqual({ provider: TrainerProvider.CODEX, model: "gpt-5.6-sol" });
        expect(parseTrainerChoice({ provider: "claude-code", model: "opus" })).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "opus" });
        expect(parseTrainerChoice({ provider: "other", model: "x" })).toMatch(/provider is one of/);
        for (const model of ["", "-m", "a b", "x;y", "../x", 5, null]) {
            expect(parseTrainerChoice({ provider: "codex", model })).toMatch(/model is a model id/);
        }
        expect(parseTrainerChoice(null)).toMatch(/provider is one of/);
        // … with an effort level, or none for its CLI's own default.
        expect(parseTrainerChoice({ provider: "codex", model: "gpt-5.6-sol", effort: "high" })).toEqual({ provider: TrainerProvider.CODEX, model: "gpt-5.6-sol", effort: "high" });
        for (const none of [undefined, null, ""]) {
            expect(parseTrainerChoice({ provider: "claude-code", model: "opus", effort: none })).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "opus" });
        }
        for (const effort of ["HIGH", "very high", 'x"', 3]) {
            expect(parseTrainerChoice({ provider: "claude-code", model: "opus", effort })).toMatch(/effort is one of the model's effort levels/);
        }
    });

    it("keeps the effort chosen with the trainer, and takes the environment's", (): void => {
        const home: string = path.join(root, "home");
        writeTrainerChoice(home, { provider: TrainerProvider.CLAUDE_CODE, model: "opus", effort: "medium" });
        expect(JSON.parse(readFileSync(settingsFile(home), "utf-8"))).toEqual({ trainer: { provider: "claude-code", model: "opus", effort: "medium" } });
        expect(resolveTrainer(home, {})).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "opus", effort: "medium", fromEnv: false });
        // None chosen: none kept (its CLI's own default).
        writeTrainerChoice(home, { provider: TrainerProvider.CLAUDE_CODE, model: "sonnet" });
        expect(resolveTrainer(home, {})).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "sonnet", fromEnv: false });
        // The environment names the trainer with its effort alone too.
        expect(resolveTrainer(home, { IBGAMER_TRAINER_EFFORT: "low" })).toEqual({ provider: TrainerProvider.CLAUDE_CODE, model: "opus", effort: "low", fromEnv: true });
        expect((): unknown => resolveTrainer(home, { IBGAMER_TRAINER_EFFORT: "Very High" })).toThrow(/IBGAMER_TRAINER_EFFORT/);
    });
});
