# Training (src/train/)

`Trainer.train({ gameId, decider?, iterations, gameSeconds?, seeds?, parallel?, workDir, recordDir?, signal?, hooks })`.

**What decides while training** (`Decider`):
- `engine` (default): Jev plays the games and reads the instructions — the rules in words. A kept version
  keeps its parent's `teacher` only while its extractor, actions and instructions are the parent's: the
  teacher never played it, and one written for another state would be distilled unchecked (the teacher
  writer writes a new one where one is needed). The tuner is not shown the teacher then, and one in its
  reply is ignored: copied back over a new extractor, it would have passed for rewritten. One in the
  setup's reply is ignored too: never checked, the distiller would teach with it as it is.
- `rules`: the profile's `teacher`, `teach(state)` — the rules as code — plays; instant, so an evaluation
  takes seconds instead of minutes. The setup and tune prompts then ask for the teacher too (it has no
  memory: what a rule needs from earlier frames must be a state field; categorical fields preferred,
  since a small model learns the state) and give it its time: the sandbox's limit a call
  (`CALL_TIMEOUT_MS`, 200 ms; a call past it fails as a throw does) and a tenth of it to aim for
  (`TEACHER_TIME`, the teacher writer's prompt too). A best version without a teacher gets one first
  (`TeacherWriter`, checked against the engine's logged decisions for that version when there are some,
  as the distiller's; made active as the versions training keeps are). A candidate whose teacher fails on
  a state of its games — it throws, or answers no action: the last decision stood there, and distilled,
  that state would never be labelled — is not kept (logged as `playing it failed`; the tuner reads why,
  and each episode's `invalidAnswers` with the first error). A frame with no state (the page read or the
  extractor failed) is not the teacher's: the player never asks about one, so it is an extractor error
  (`extractErrors`, the first in `firstExtractError`, both in the log and the evidence), not a failure —
  one read error per game once turned away a candidate playing 30 against 10; the prompts say so. This is the path to Laya: train
  with `rules`, then distil.
  The UI trains with `rules` when Laya is the chosen engine, with `engine` when Jev is.

**For real-time play** (`realtime`, `latency`; CLI `--realtime --latency <ms | min-max>`): every game
is played with the clock never paused, the rules decider answering late as the engine that will play
does. A range (`250-600` for a hosted engine) gives each game its own latency — from its seed — which
drifts across the range during the game (`latencyAt`: a ~20 s swing), because an engine's time differs
from game to game and changes as it speeds up or slows down; the prompts say so and tell the tuner that
a decision acts `info.lagMs` (the current lag, measured) after its frame, so the extractor computes
time-critical features as of then, for any lag (with lagMs 0 the state is what the frame shows). A candidate that beats the best in real time is played with the clock paused too
and kept only if it is no worse there than the version training began from: one profile serves both
clocks. The bar stays where training began — a kept version that happened to play better paused does
not raise it (it once turned away a candidate playing Flappy exactly as the starting version did, 32.3
against a kept 32.7). Its `results` are the paused scores, with `results.realtime` beside them — the
unseen seeds' among them (`results.realtime.test`: training plays those in real time too), so
`results.test`, theirs with the clock paused, is left to `ibgamer measure` (which keeps the real-time
ones). A
version kept is made active unless training started `--from` another than the active one; a lag-aware
version that plays paused worse than the one before it belongs in a live config (`version`, `lagMs`),
with the active version left for the paused clock.

**Real time simulated** (`simulated`; CLI `--realtime --simulated`): the same training, every game on the
paused clock — each decision lands `latency` after its frame in GAME time (`simulatedLag`, the player
running the game on meanwhile; the rules answer at once), the lag drifting from the seed as the real one
does. Real real time does not replay (Flappy's Laya: 34 one run, 15 the next), so candidates were kept or
not on noise; simulated, every run gives the same score, and faster (no waiting). Not with `--plan`
(plans run on the wall clock). The tuner is told the lag the games are played at (`latency`, whatever
decides) and that a decision comes every max(tickMs, lag): decideOn "change" and maxHoldMs count only
with the clock paused.

**In plans** (`plan`; CLI `--plan <n>x<ms>`, with `--realtime`): the versions play in plan mode
(docs/claude-md/playing.md) and keep `plan`; the rules answer each moment from its predicted state
(`RulesTeacher`: `slotK` → `game.slots[K-1]`), late as set by `--latency` (e.g. 250-600 for Jev); the
prompts tell the tuner to predict each moment from `info.slots` / `info.pending` / `info.nowMs` and how a
plan is played. The paused floor applies as for `--realtime`.

**Seeds it never sees** (`testSeeds` in game.json or the options; default 1001, 2002, 3003): the best
version is measured on them at the start and a candidate that beats it on the training seeds is played
on them too — kept only if it plays them no more than 1 % worse (`UNSEEN_TOLERANCE`, of the best's mean:
a point on one seed is noise — a candidate playing 1266 against 494 was turned away for 859.0 against
859.3 there, 35 against 36 on one seed; a best of 0 allows nothing worse). Nothing of those games reaches
the tuner (no windows, no screens: `scoreOn`); a rejected candidate's history note says why ("… it played
X against Y (more than 1 % worse) — rules fitted to these games rather than to the game"). The floor: random play (`RandomPlayer`, a seeded random action a decision) on
the training seeds, measured for the starting version and again for each version kept, with its own
actions and timing. Both are recorded (`results.test` — in real-time training `results.realtime.test` —
and `results.random`); the distiller places Laya between random play (0 %) and its teacher (100 %). A
stop during any measurement records nothing of it: partial scores are never a version's results, and a
candidate they would decide is not kept. A candidate's game that fails (a DevTools timeout, an engine
outage) — on the training seeds, paused, on the unseen seeds or for its floor — fails the iteration
(`playing it failed`), not the training.

**From another version** (`fromVersion`; CLI `--from <n>`): training starts from that version instead
of the active one, and the versions it keeps are saved without being made active.

**A top score** (`game.score.max`, e.g. Doodle Climb's 100 % of the tower): a game that ends there was won (no
failure window), and training stops once the best version's mean reaches it.

1. **Setup** (no profile yet): open the game, run its start (as the player sends it, `inputSteps`: the keys
   a `holdFrom` step names are let go before the watch — held, the samples would be of a game play never
   shows), WATCH it (8 raw inputs 100 ms apart, no
   input: what moves by itself, before a blind poke can end the game — Pop the Lock dies on its first
   stray click), screenshot, then sample 24 raw inputs 250 ms apart with blind pokes (click, Space,
   arrows) and a second screenshot (`screenshot-play.png`). A sample summary (`watching` + `blindPlay`;
   canvas2d: a sprite catalog + crops; Phaser: object kinds + dumps) goes into the work dir and the
   library's `samples/`, and the setup prompt asks for `{ extractor, actions, notes, tickMs }`. v1 =
   generic instructions + the notes (`origin: setup`), its tickMs rounded and clamped to 16–500. The
   extractor must run on at least one sample. With the rules deciding (`teacher` asked for too), the teacher
   is checked before it plays, as the teacher writer checks one: it must compile and answer every state the
   extractor made of those samples (guarded, as a decider gets them) — one repair round
   (`TeacherWriter.checkedOnSamples`: the teacher prompt with the errors and the states), else no v1.
2. **Measure** the best version on the seeds (one game per seed, in parallel DevTools sessions; the
   first is recorded → live view; every game opens with the game's custom perception script when it has
   one). Episodes that ended in game over give failure windows, saved in the library (`v<N>-seed<S>`),
   each once: a best version tuned on again saves none anew. End screens go to `shots-<label>/`
   (`v<N>`, `it<i>`, `…-paused`; no spaces, as the UI serves a run's files by a path pattern), each named
   for its game's seed (`episode-1-seed<S>-end-…`): the screenshot tool names a file only to the second,
   and games played at once ending in the same second overwrote one another's.
3. **Tune**: the tune prompt carries the best version and its evidence (last 25 decisions per episode,
   ~6 samples, extractor errors and invalid answers each with the first error, end-screen paths, novel sprites with crops), the
   latest rejected candidate and why it was not kept, the history, the windows and the existing tests.
   The reply (`analysis, instructions,
   extractor, actions, decideOn, tickMs, maxHoldMs, askWhen, newTests`) must validate and compile (its
   tickMs rounded and clamped as the setup's: a 16.7 is no reason to fail an iteration); every
   regression test (old + new) must pass offline — one repair round with the failures and the failed
   attempt (the existing tests cannot change, its own new ones can), else the iteration fails. A test
   whose decision is an answer that is no action, its teacher failing on the state or a state too large for
   the engine fails; an engine that cannot be reached (no connection, HTTP 401 or 5xx after the client's
   retries) fails the iteration with that error and no repair round — the tuner was once sent one for tests
   that failed only because no decision came.
4. **Accept** only if the candidate's mean beats the best's on the same seeds (a candidate is drafted —
   and its games reported — under the number it would be saved as, after every version there is): saved
   with `tests = best.tests + newTests`, `results`, `parent`, `note = analysis`. Two failed or rejected
   iterations in a row stop training.

The trainer is the Claude Code CLI (`claude -p --output-format stream-json --verbose --model <m>
--tools Read --allowedTools Read(//<workDir>/**) --strict-mcp-config --no-session-persistence`),
prompt on stdin, cwd = the work dir, environment = `childEnv()`. Its answer is the text of every
assistant message after its last tool call, joined (`finalReply`): a long answer (an extractor and a
teacher that searches) is cut at the model's output limit and goes on in the next message, and the
CLI's final `result` held only that tail. The JSON in it (`parseJsonObject`) is the largest top-level
balanced object that parses, braces counted as JSON reads them (not inside strings, escapes skipped): prose
before or after it with braces of its own ("the state now has {dx, air}") is dropped, and an answer that does
not parse fails with its own error (one that never closes, cut off, as "no complete JSON object"), never
passing off an object nested in it. A brace that never closes and opens as an object does (`{"key":`, a
key and its colon) is the answer cut off: nothing inside it is taken — the scan for the next brace goes on
in its strings, where an extractor's `memory.seen || {}` once parsed and passed for the answer (the setup
wrote `{}` as its answer) — nor anything before it (an example in the prose is not the answer); a brace of
the prose that never closes is skipped, as before — a quoted one too (`I escaped the "{" character.`: a
quote alone once passed for an answer cut off, and the complete one after it failed). The setup keeps its
answer (`setup.json`, the library's `samples/setup.json`) only once it made a profile: after it is saved
(it was kept before a refusal — no teacher while the rules decide, an extractor throwing on every sample,
a teacher still failing on them). Each reply is kept beside its
prompt in the work dir (`tuner-reply-*.txt`, `setup-reply.txt`). `TrainDeps.ask` replaces it in tests.
