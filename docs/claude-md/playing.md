# Playing a game

`Player.play(options)` (src/play/player.ts) plays `episodes` games of `gameSeconds` game time.

- **One episode = one fresh page load** (`game_open`) on a clean origin (its cookies and storage cleared
  first, once the page before is gone — in real time too —, with those of the origins that page was on:
  a high score or "tutorial seen" from the game before would change the next), seeded when the game
  allows (`seeds` cycled; the seed is scrambled — splitmix32 → mulberry32 — so neighbouring seeds differ).
  A seed replays the same game frame for frame (the page's Math.random, a Phaser game's RNG, the
  extractor's, `askWhen`'s and the teacher's Math.random are seeded, and the scripts' `Date` is game
  time; the boot runs in game time), save what still runs in real time (a worker's answer, the network
  after the boot, a sound's end: devtools-plugin.md, "What nothing waits for"), as a session's first game
  (a later episode of one session — `ibgamer play --episodes N`, the UI's count — loads at a later
  `performance.now()`: devtools-plugin.md) — so two
  versions, or a student and its teacher, are compared on identical games, and a death can be
  replayed tick by tick. `onTick` events are thinned in wall time on unasked ticks: compare by `t`.
  The DevTools recording (live view + video) starts after the first load and runs across episodes.
- **The game's start**: its `start` input steps (`{press, hold, holdFrom, click, waitMs, advanceMs}`), as a player
  would. `holdFrom` is a page expression naming the keys held for the step (released by the next, with its
  input when it names no keys to hold; after a last step, before play; `inputSteps`) — for a
  menu or a world map drawn from the seed, whose way on the page must say (a key, a list, or nothing once
  there). Held rather than pressed: a game that polls its keys on its own tick never sees a key pressed
  and released within one step of the frozen clock. `waitMs` is real time with the clock frozen, before `advanceMs`: what the page runs in real
  time (a CSS animation — Dino starts on its intro's `animationend`) then ends at the same game time
  in every run. Without it Dino's start drifted with the machine's load.
- **Between rounds**: when the score expression reports `waiting: true` (a level's end screen that
  asks for a click), the held keys and pointer are let go, the game's `resume` steps run (same shape
  as `start`) and the next round is decided afresh. A game still waiting after 3 resumes in a row is
  played on as it is (a `resume` that does not take it on cannot loop); without `resume` nothing changes.
  `play/rounds.ts`, shared with `ibgamer check`.
- **The loop**: observe (raw → `Extractor.extract` → `guardState`) → over? budget? abort? waiting? → fruitless
  check (same state signature twice after the same action marks that action's criterion "ignored") →
  `askWhen` (a Predicate over the state; false keeps the last decision without asking) → `decide()`
  → input (the action's keys held, its pointer held — sent only while a pointer action is or was just in force — a click only when just decided) → game time:
  - `decideOn: tick`: one `game_step` of `tickMs`.
  - `decideOn: change`: sub-steps of `max(16, tickMs/3)` until the state signature changes, at most `maxHoldMs`.

  The state signature (`play/guard.ts`) is the state without its counters: a field whose key has `tick`, `count`,
  `counter`, `time`, `timer`, `timestamp`, `age` or `frame` (or a plural) as a whole word — camelCase, snake_case or
  kebab-case: `frameCount`, `time_left`, `ageMs`. Until 2026-09-30 any key holding those letters was left out, so a
  change in `bossDamage`, `stage` or `message` was no change: a FIRE hitting the boss at every shot was marked ignored.
- **The question** (unchanged since the research): `state = { game: <state> }`, one `action` choice question
  whose criteria are the actions' descriptions and whose instructions are `{ goal: game.goal, instructions: profile.instructions }`.
  An invalid answer is asked again twice, then the last decision stands (held, not clicked again; before
  the first decision, no input); so does rules as code that fails on the state (`invalidAnswers`).
  A frame with no state — the page read or the extractor failed: `{ extractorError }` — is not asked about
  at all (a plan mode request neither; the page is read again a look later): the last decision stands, and it
  counts as an extractor error (`extractErrors`, the first one's error in `firstExtractError`), never an invalid answer.
- **Score**: the game's score expression's reading (`{ over, score, … }`, read in the same page
  evaluate as the raw input); `score.fromState` uses the state's own `over` / `score`. A score
  expression that fails on the page reads as 0, not over, and is counted (`scoreErrors`).
- **Pace**: `turn` never waits; `watch` never runs ahead of the game's own speed (a slow decision is a
  pause, not made up for later); `realtime` opens the page with the clock running (`freezeClock:
  false`) and never pauses it: a step sends the input, sleeps what is left of the tick after the last
  observation (none when the decision took longer), then observes — a slow engine decides on a
  state the game has already left. Game time is the page's own clock. The extractor is told the lag
  (`info.lagMs`: the median of the last 15 decisions plus 5 ms for the step). A profile whose extractor
  makes up for it (`lagAware`, set by `train --realtime`) is told the 90th percentile instead, and a
  faster decision waits for it — a jitter buffer: every input lands that long after its frame, so an engine
  whose time varies (Laya beside a WebGL page on one GPU: 40–70 ms) plays like one with a fixed lag,
  which a lag-aware extractor makes up for (Pop the Lock v5 with Laya: 59, never missed, from dead on
  the first dot). `train --realtime` has the rules answer that late and the tuner write that extractor;
  a version is kept only if it plays as well with the clock paused. Holding the inputs of a profile that
  does not make up for the lag only delays them (Flappy: 34 → 27), so only `lagAware` ones are held on their own —
  but a floor asked for (`minLagMs` > 0) holds any version's, as late as a slower engine or a busy machine lands its
  inputs: Train's check at the slow end, live training's and live DAgger's games spread to 90 ms.
  A live config can set a floor (`lagMs` → `minLagMs`): a lag-aware version's inputs then land no sooner
  than that, however fast the engine answers — the lag it was trained at, where its extractor's timing
  holds. With no floor given, a lag-aware version has its own (`liveFloorMs`, src/game/configs.ts): the lag
  training measured it at (`results.realtime.lagMs`), else 50 ms. Dino v7, trained with the rules answering 40 ms late: Laya at 23 ms a decision played 1493, 290,
  1116 live; held to 45 ms, 1494, 1091, 1493 (the rules 40 ms late: 1494, 1038, 1493). Below its lag a
  lag-aware version can fail outright: Pop the Lock v5 (trained for 45 ms) dies within seconds at 40 ms
  simulated and at the rules' own 6 ms live, and plays as with the clock paused held to 45 ms (rules 64,
  60, 54; Laya 64, 59, 54).
  Real time does not replay (Flappy's Laya: 34 one run, 15 the next): single games are indicative. Measured live
  (2026-09-28/29): Snake, Tetris and Pac-Man play with Laya about as with the clock
  paused; Doodle loses some score; Super Coin Box's Laya (v2, not lag-aware) loses about half on its
  training seeds and dies early; Flappy (v3) is lost with either engine; Dino and Pop the Lock play only
  with a lag-aware version held to its lag. A fine-tuning sharing the GPU stretches a decision past 100 ms.
- **Real time simulated on the paused clock** (`simulatedLag`, CLI `play --lag <ms | min-max>`; TURN or
  WATCH): each decision lands its lag after its frame in game time (`latencyAt`: from the seed, drifting),
  the game running on meanwhile — real time, reproduced exactly (at 250–600 ms Pop the Lock scores 0:
  the first dot comes at 255 ms). The extractor is told the lag (`info.lagMs`). As in the real loop, the
  next frame is read only once the input has landed — a decision is not asked before the last one acted
  (nothing asked: the input lands at once) — and a tick has passed, plus a step's own time
  (`stepTimeAt`: 2–6 ms from the seed, the browser round trip measured live — Flappy's frames 19 ms apart
  at a 16 ms tick, Dino's 35 at 30, Super Coin Box's 106 at 100): frames come max(tick, lag) + 2–6 ms
  apart. Every decision steps one tick (a `decideOn: change` profile too). Until 2026-09-29 the simulated
  player read a frame every tick with decisions still on their way and no step time, which was too kind
  where a fresh reaction matters (Dino v4's rules: 1485 simulated at 5 ms, 561 and 377 live; now 855–995)
  and wrong for an extractor that takes the time between frames from the lag (Dino v7: 320 at 45 ms;
  now 646–1486, live 947–1494). It is still an approximation (Super Coin Box's Laya: 101, 70, 94 simulated
  at 33 ms, 55, 40, 65 live): offer a live config only after playing it live for real.
- **Does it replay?** `ibgamer check <game> [--seed] [--seconds] [--parallel]` (`run/check.ts`) plays the
  seed twice, the profile's rules deciding (keys and pointer held as the player holds them, a round's end
  taken on with `resume` as the player takes it on), and compares every frame's raw input and reading: the same
  all along, or the first frame that differs and where — up to five differences (`raw.top: 155.4 ≠ 158.3;
  raw.velocity: 2.65 ≠ 2.9`: a physics tick apart; a long string: the first differing position). `--parallel` plays both at once, as training's evaluations do.
- **Plan mode** (`profile.plan: {slots, slotMs}`, real time only; `play/plan.ts`): for an engine slower
  than the game (Jev, ~300–600 ms). One request asks one question per moment (`slot1…slotN`, the
  profile's rules plus a PLAN paragraph), the extractor having predicted each moment: `info.slots` (ms
  after the frame: the p90 of the recent requests, then `slotMs` apart) and `info.pending` (inputs earlier
  plans scheduled that have not landed yet, `{inMs, action}` — `inMs` 0 for one that fell due while the
  page was read, played right after); it returns `slots: [state…]`, each with the
  present state's fields. A request is always in flight (`--plan-every <ms>`: several, a newer frame's
  plan winning, but dropped when a plan merged since its frame changed an input before its first moment —
  it counted on the pending inputs it was told of; merged anyway, it lost a jump another plan had moved
  past it); each answer replaces the schedule from its first moment on; inputs are played at their
  moments (wall clock), moments already gone are dropped; the page is read every 100 ms between answers.
  The moments are predicted without the plan's own inputs, so a plan plays one change — its first moment
  that changes something — and, if that pressed keys, their release back to where it began
  (`planInputs`). An extractor without `slots` gets one question, played as a one-moment plan. After a
  round's `resume` the answers still in flight are dropped: the new round is planned afresh. Paused,
  a plan profile plays tick by tick. Ticks: `plan` on a request's frame (its state and game time), `planned` on an input a plan
  played. Every extractor is also told the frame's game time (`info.nowMs`): frames with the clock
  running are not evenly spaced. What each frame's extractor was told is kept with a failure window
  (`frameInfo`) and told again on a replay.
- **Evidence** (training): `collect.windowFrames` keeps the last raw frames (a failure window, on game
  over), each with what its extractor was told (`frameInfo`). A frame the page could not be read on is kept
  empty and marked `unread`: the extractor never saw it, and a regression test's replay skips it as the player
  did — not extracted (its memory stays as the player left it), nothing checked on it (no state was made of
  it, nothing decided: a test pinned to it alone passes). Until 2026-09-30 the replay gave the extractor that
  frame as null, and a kept test failed every later candidate whose extractor does not take a null (a window
  saved before then has no marks: every frame is replayed). `collect.noveltyAfterMs` lists sprites / object
  kinds first perceived after the trained horizon.
- **Hooks**: `onPhase`, `onEpisodeStart`, `onTick` (asked ticks always, others at most every 100 ms),
  `onDecision` (every decision the engine answered — the distillation rows, each with the game's `seed` and,
  when the decision acted late, its `lag` (`{minMs, maxMs}`: the simulated range, or the real-time lag the
  state was made for); a plan's answers are not logged), `onEpisodeEnd`, `onRecording`.

## The sandbox (src/play/sandbox.ts)

The extractor, `askWhen`, the teacher and regression-test `expect` are JavaScript from the trainer or a shared
game. Each runs in its own `vm` context: a null-prototype global, `codeGeneration: { strings: false,
wasm: false }` (no eval / Function), 200 ms per call. Only JSON crosses: the input is serialized in
and parsed inside, the output serialized inside and parsed out, so no host object is reachable. The word
`import` is refused before compile: a dynamic `import()` rejects with a host-realm error whose `Function`
generates code in this realm.
Nothing of a script runs in this process outside a call's limit (each of these hung it before): its
promise jobs run within the call (`microtaskMode: "afterEvaluate"`); what it throws is turned into text
inside the context; the inputs are data properties it cannot redefine as setters (made read-only, they
fail the call as the script's error, not a TypeError here that ended the play); a source is compiled
as its own function body (`vm.compileFunction`), so it cannot reach past it; it has no
`FinalizationRegistry` (callbacks later, unlimited); `Error.prototype.code` is fixed (Node sets it on the
time limit's error). Every context's `Math.random` is seeded (the teacher's again for each state, from the
state: one teacher labels game after game alike), and its `Date` stands at 2026-01-01 (where
the page's frozen clock starts too) plus the frame's game time (`info.nowMs`; the teacher's and
`askWhen`'s stay at the epoch): on the paused clock, wall time is the engine's latency. Its local time is UTC,
as the page's is: a date's parts (Annex B's `getYear` / `setYear` too), its offset, its strings (an Invalid
Date's, a year of six digits or below zero, as a UTC machine writes them) and `Intl.DateTimeFormat`'s default
zone, `toLocaleString` and its kin with it — not yet a date and time read from text without a zone
(`Date.parse`, `new Date(text)`), which stays this machine's, nor the default locale (a `toLocale*String` or
`Intl` format given none writes as this machine's locale does: `1/1/2026`, `1.1.2026`). Only the context's own
`Date` and `Intl` are changed. A test of it sets a zone that is not UTC on the process itself (Jest hands a test a copy of
`process.env`, where a `TZ` changes nothing), or it passes on a UTC machine whatever the sandbox does. Super Coin Box's
extractor reads `Date.now()` as a per-call work budget; with a clock that does not move within a call,
its cap of cells per call decides (the same timings, and the same grid from the same seed).
A promise a script rejects and never handles still reaches Node's `unhandledRejection` (without a
handler the process exits); the handler decides a promise's realm by walking its prototype chain (stopping
at a Proxy), never calling into the script. A context is not a process boundary; library games are added knowingly.
