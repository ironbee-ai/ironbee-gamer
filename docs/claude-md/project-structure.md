# Project structure

```
src/
  cli/main.ts               ibgamer: ui | play | train (--check-only, --no-check) | probe | measure | check | library (list/show/activate/import/export/remove/games) | laya (setup/distill/eval/list/serve)
  config/config.ts          env → GamerConfig (engine, daemon, UI 1986, ~/.ibgamer, the trainer: env, else <home>/settings.json); loadDotEnv
  engine/                   DecisionEngine interface; systemone.ts (the /v1/systemone client, retries), jev.ts, laya.ts
  net/http.ts               undici HTTP/2 keep-alive pool for the engine
  devtools/
    protocol.ts             the game tools' wire shapes, shared with the plugin (Adapter, OpenRequest, StepRequest, …)
    client.ts               DevtoolsClient (POST /call, one session per run) — the GameBrowser the player uses
    daemon.ts               ensureDaemon: reuse or start a DevTools daemon with TOOL_PLUGINS=game-tools.mjs
  devtools-plugin/          the game tools, bundled into dist/devtools-plugin/game-tools.mjs (see devtools-plugin.md)
    page/                   page-side adapters: canvas2d recorder, Phaser dump, PixiJS dump, Cocos dump, pixel grid, probe, seed, animation clock, input counter, timer nudge, clock log replay, boot work counter (decodes, WebAssembly, IndexedDB), session-storage clear
    time.ts                 runGameTime: the frozen clock's game time, the CSS animations following it (animation clock)
  game/
    types.ts                GameDefinition (reach/start/measure), Profile (extractor, rules, actions, timing, tests), FailureWindow
    validate.ts             validateGame / validateProfile / validateRegressionTest: field-named errors
    open.ts                 a game → game_open request; rawFormat (for prompts); perceivedKinds (novelty keys)
    configs.ts              playConfigs (a game's configs, else those its versions earn) / offeredConfig / describeConfig; LIVE_LATENCY, liveFloorMs, liveReadiness
  library/store.ts          Library: built-in + user roots, versions, active, windows, files, import/export
  hf-library/               the Hugging Face library: export (what plays a game, paths scrubbed), push (hf upload), client (HTTPS + sha256), pull (into the library)
  reader/page-reader.ts     PageReaderWriter: the trainer writes a page expression for the game's own state, checked on the page
  play/
    player.ts               Player: episodes, the step loop, fruitless marking, askWhen, pace, evidence, decide(); plan mode's loop
    plan.ts                 plan mode: slot questions, the PLAN instructions, planInputs (one change per plan)
    rounds.ts               a game waiting between rounds taken on (keys let go, its resume, 3 in a row at most); inputSteps (a start or resume sequence, a holdFrom step's keys let go by the next) — shared with run/check.ts
    guard.ts                guardState (advice stripping), stateSignature
    sandbox.ts              Extractor / Predicate / Teacher in isolated V8 contexts
  train/
    trainer.ts              Trainer: setup (new game) + tuning iterations + windows + acceptance
    train-for.ts            trainFor: a training for the engine chosen — Jev, the rules, or for Laya the rules then a distillation (layaToTeach: Laya alone when it has no model of its version)
    prompts.ts              setup and tune prompts
    regression.ts           offline regression tests over saved windows
    teacher-writer.ts       TeacherWriter: the trainer writes teach(state); checked (agreement, own play); saved as a version
    claude.ts               the trainer as the Claude Code CLI (childEnv, Read rule, JSON reply parsing)
    codex.ts                the trainer as the Codex CLI (codex exec, read-only sandbox; the models it lists)
    trainer-cli.ts          which CLI the trainer is and its model: askTrainer, trainerHealth, the settings file, the environment
  distill/
    distiller.ts            Distiller: teacher games → finetune → DAgger rounds → the student on the seeds
    teacher.ts              RulesTeacher: teach(state) standing where an engine stands (exploration, onLabel)
    laya-runtime.ts         the Python with Laya, checkpoints per game, serve.py / finetune.py processes
    laya-play.ts            LayaServers: one local server for the games played with Laya (UI, CLI)
  improve/                  Train with something to check (docs/claude-md/improve.md)
    check.ts                checkPlay: an engine on a clock beside its rules — the seeds each plays below its reference, the verdict, the divergences
    improve.ts              Improver: check → the fix (Laya taught more, Jev's instructions or the rules trained; nothing losing: trained for a higher score) → check again → configs pinned, or undone; nothingToCheck: why a training starts there instead
  run/
    play.ts                 playGame (the custom perception script from the library)
    check.ts                checkReplay / firstDifference: a seed played twice, the first frame that differs (ibgamer check)
    measure.ts              measureVersion: a version measured again as training records it (ibgamer measure)
    runs.ts                 RunRecord / RunStore (~/.ibgamer/runs/<id>/run.json + video + screenshots)
    progress.ts             ProgressTracker: a train / distill run's stages, bar, time left and results, from its phases and log lines
    decision-log.ts         DecisionLog: the engine's decisions as distillation rows (strict for a distillation's own rows)
  util/
    rows.ts                 forEachJsonRow (a rows file streamed, torn lines skipped and reported), appendRow (a failed append truncated back)
    time.ts                 sleep
  server/
    ui-server.ts            the web UI's API, runs, the live-view hub, the daemon it owns
    live-hub.ts             relays DevTools' screencast frames to viewers (never their input)
    http-guards.ts          Host/Origin guards, files served (serveFile: 404 when unreadable), video ranges
    ui/                     index.html, app.js, style.css (no framework): the library, play + live view, the add-a-game wizard, the setup checklist, run progress
laya/
  finetune.py               distil a game's decisions into a Laya checkpoint (MPS/CUDA/CPU)
  serve.py                  serve checkpoints by name over /v1/systemone
library/                    the built-in games (dino — with its research history —, flappy-bird (floppybird), pacman-ghosts, doodle-jump, pop-the-lock, super-coin-box, tetris, snake, racer, mario, breakout — added through the UI's wizard)
research/                   the research prototype and KNOW-HOW.md, kept as they were
tests/                      unit/<area>, integration/ (live daemon, IBGAMER_E2E=1), helpers/, fixtures/runner.html
```
