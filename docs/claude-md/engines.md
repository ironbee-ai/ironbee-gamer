# Decision engines (src/engine/)

`DecisionEngine { kind, label, ask(state, questions), warmUp?(), health() }` over the System One
protocol (`SystemOneClient`: HTTP/2 pool, 5 attempts with backoff on 429/5xx, on a connection dropped
or timed out before the answer or while its body arrives, and on a 200 whose body is not a JSON answer —
the clock is frozen while it waits; a body that stays no answer is an `InvalidAnswerError`, as an answer
naming no offered action is: the player keeps the decision in force). `validateChoice` accepts only an
offered option with sane probabilities.

| Engine | Where | Latency (measured 2026-09-27) |
|---|---|---|
| `jev` | api.typesafe.ai | ~250–290 ms from Türkiye; `x-envoy-upstream-service-time` says ~40–80 ms of it is the model |
| `laya` | a local server (`LAYA_URL`, default 127.0.0.1:8000), `LAYA_MODEL` names the checkpoint | ~20–30 ms per decision (MPS, HTTP included) |
| `rules` | the played version's own `teach(state)` (`RulesTeacher`), in the sandbox; made from the profile, not by `createEngine` | < 1 ms |

## Laya and distillation (src/distill/, laya/)

Laya's base checkpoints do not read long rules: its sequence is `[CLS] choice question: <instructions>
[SEP] [MASK] opt0 [MASK] opt1 … [SEP] state [SEP]`, the head (instructions + options) is cut to 192
(English) / 256 (multilingual) tokens, and zero-shot it is near chance on a game's decisions (Dino:
multilingual 16 % agreement with Jev, no JUMP right). A game's Laya is **distilled**: the rules go
into its weights through labelled states.

- **The teacher** (`TeacherKind.RULES`, default): the profile's `teacher` — `teach(state)`, the
  instructions as code, written by the trainer (`train/teacher-writer.ts`; one that does not compile
  goes back with the sandbox's error) and checked before it
  teaches: it must answer every sample state it was shown (one that throws goes back with the errors and
  the states), answer every state the engine logged and agree with ≥ 95 % of its decisions, balanced
  (when there are some; a choice the teacher gives the highest probability agrees, so a tie it leaves open
  agrees either way; a state it throws on is a failure, counted apart and none allowed — as a mere
  disagreement ~5 % of an action's rows could throw and pass, and a state it cannot label is never learnt;
  one repair round with the errors and the disagreements) and, playing by itself, it must fail on none of its games' states
  (a throw or no action: the last decision stood there, and distilled, that state would never be
  labelled — checked whether or not the profile has a score; the repair gets the errors and the states)
  and reach ≥ 90 % of the profile's score (one repair round with the ends of its lost games). A repair is
  shown a dozen of the states it failed on at most, spread over its errors, in 30,000 characters at most,
  as the ends of its lost games are (one state of each error once put them all in the prompt — up to 6,000,
  a few KB each — when the error text named the state). A frame with
  no state (`{ extractorError }`: the page read or the extractor failed) is never held against it — the
  player does not ask about one, and logged rows of one (an engine was asked, before) are left out. Its
  prompt gives its time: `CALL_TIMEOUT_MS` a call (a call past it fails, as a throw does), a tenth of it to
  aim for. Saved as a new profile version (`origin: teacher`),
  made active only when the version it teaches was. `RulesTeacher` stands where an engine stands: it
  plays the data games (a share of random moves in every second game of the run, whatever the
  parallelism — the game's place in its batch once decided it, and one game at a time never wandered;
  drawn from the game's seed so the games replay; labels still the teacher's, recorded through
  `onLabel`) and relabels instantly.
  `TeacherKind.ENGINE` uses Jev instead (its decision log; relabelling asks it, and takes its answer as
  the player takes one, `validateChoice`: one naming no offered action, or of no weight, is asked again
  twice, then labels nothing and counts as the teacher failing, as a state too large for it does
  (`RequestTooLargeError`: asking again cannot help) — one was once written as a choice and learnt as a
  hard row, or counted as labelled while finetune.py dropped it). An engine that cannot be reached (a `DecisionEngineError` after the client's
  retries: no connection, HTTP 401 or 5xx) is no teacher failing: the relabelling asks about no more states
  and the run fails with that error once the states being asked about are answered, as a game it plays
  fails (it was once counted as the teacher failing on every state: through an outage a round's
  relabelling would take 40 min to hours of retries to add nothing, and with a lag refuse the run blaming
  the teacher).
- **`Distiller.distill`**: labelled states (`decisions/v<N>-<hash>.rules.jsonl`) until `minRows` →
  `laya/finetune.py` from the base → DAgger rounds (the student plays `studentGames`, the teacher
  labels what it visited into `.dagger.jsonl`, fine-tuning CONTINUES from the previous round's
  checkpoint for `roundEpochs`; a student choice the teacher gives the highest probability is no
  mistake, so a tie is not a hard row) → the student plays the profile's seeds one at a time (the
  decision time is a single game's), beside the profile's rules (its teacher, unless the engine taught
  it) and random play on the same games → `distill.json` beside the checkpoint `laya/v<N>-<hash>-r<k>`,
  with the rows the checkpoint was last fine-tuned on (`teacherRows`, `daggerRows`: the files' first
  rows, as they only grow — not their rows at the end, which a round that ended on agreement had grown).
  A stop there records nothing and removes no checkpoint: a partial mean must not decide which stays.
  One checkpoint per profile version is kept: the new one, unless an earlier one's recorded student
  mean is higher (then the new one is dropped, and the result is the earlier one's as recorded — its
  student, its teacher, its rows: the CLI once said it was taught by the dropped run's teacher). A run that
  fine-tunes nothing (below) keeps what the checkpoint's record says of how it was taught — its `teacher`,
  rows, `lag` and `laggedRows`, as `laya eval` keeps them; one it names no teacher in is left with none,
  not given this run's — and refreshes what it measures (the student, the reference, random play; the
  lagged games only when it played them): a `--rounds 0` resume once erased the record's lag, and one with
  `--teacher engine` relabelled a checkpoint the rules taught. A new distillation numbers its rounds after the
  checkpoints already there, so none is overwritten; a round folder without `training.json` — which
  finetune.py writes last, after the model — is a fine-tuning that never finished or was cut off while it
  saved (maybe with its resume state): removed first, so no round starts in it and `resume` never goes on
  from it. `resume` goes on from the latest checkpoint: its student plays first, then `rounds` more DAgger
  rounds, no first training — refused before anything is done when the version has no checkpoint, or no
  teacher while the rules teach (one written then would be a new version, with no checkpoint to go on
  from: it once was written, saved and made active, and only then the resume failed). A resume whose
  teacher played games (its rows short, or a lag's) fine-tunes at least once: its student agreeing
  everywhere in the first round is no stop then (it once stopped there, and the checkpoint's record
  claimed rows it never learnt); with no more rounds nothing is fine-tuned, so the teacher plays no game,
  and the record keeps what the checkpoint's own says (above) — as it does when a resume's student agrees
  everywhere in its first round with no teacher's game to learn. Seeds come from two ranges that never
  meet: the teacher's games take the lowest seeds from 10,000 up (below 1,000,000) that no row of the
  version holds, a student's come from 1,000,000 up (+100 a round), after every seed the version's rows
  hold. finetune.py validates on whole games, and a student's game on a teacher game's seed plays its
  layout: its DAgger rows (training only) would be learnt while that game validates. The teacher's once
  took 10,000 + the rows there were, and the students' began at 20,000 — reached once the rules held
  10,000 rows (`--min-rows` is 12,000); rows from before keep their seeds, which the teacher's games pass
  over. A student never plays a seed the rows hold: a resume after a run that stopped on agreement once
  replayed its games with the same checkpoint, the same rows twice. A teacher that
  labels nothing (it fails on every state) stops the teacher's games after four batches, not sixty, and
  the run is refused with its first error — no fine-tuning on no rows (nor any round's: refused when the
  rows and the DAgger rows are both empty; finetune.py itself exits at once on an empty data file).
  The teacher stops short of `minRows` once its games show almost nothing new: two batches in a row
  whose new distinct states — of the kind they played for: with a lag, the lagged ones of its lagged
  games and the paused ones of its paused games — are at most 1 % of the states they labelled
  (`NOVELTY_SHARE`). The states reused from before set no bar (12,051 paused ones once made the 107 new
  lagged states of two short games "almost nothing": the lagged half stopped at 1,794 of 6,000), and one
  short batch is no sign. The rows files are read as streams, row by row: a real version's reached
  276.5 MB, growing 20–30 thousand rows (~2.8 KB each) a round, and one string holds ~512 MiB at most.
  A line that is no row — a row cut short by a write that failed part of the way, the next row's bytes
  after it on its line — is skipped and counted, and said once for each file of a run, naming it
  (`forEachJsonRow`, `util/rows.ts`; the teacher writer and finetune.py skip it too): one once broke every
  later read of the version with a bare "Unexpected end of JSON input". A row is appended whole or not at
  all (`appendRow`: a failed append cuts the file back to its size before it), and one that cannot be
  written fails the run with its error, naming the file — the teacher's rows too (their `DecisionLog` is
  strict; a play's log never stops its game): swallowed, a read-only rules file once labelled "0 distinct
  labelled states" four batches long and the run blamed the teacher, and a full disk shrinks the data.
  What the teacher fails on (the rules throwing, no action, no probabilities: the state goes unlabelled) is logged
  for each batch of its games and each relabelling, with the first error — it once was dropped unsaid.
  The whole run holds its port: a lock file `<user library>/.laya-port-<port>.lock` (made only when there is
  none, naming the process and the run; removed at the end; one whose process is gone, or taken before the
  machine started — after a reboot its pid may be any process's —, is taken over; a refusal names the file,
  to remove when its pid is no such run), so a
  second distillation on the port — or a `laya eval` — is refused at its start, not hours later when its
  student's server is refused or cannot bind (the port check below sees only a server up at the start).
  Its server is up only while its students play; a play (`LayaServers`: the UI's, `ibgamer play --engine
  laya`) and `laya serve` never take the lock (short-lived, interactive), but refuse a port another
  process's run holds (`layaPortHeldByOther`; this process's own hold is one of its runs, one at a time),
  naming it — a server started meanwhile would stand where the next student is served. The UI's warm
  skips such a port quietly; its play and distill requests are a 409. The run holds the version it learns too, once
  known (a teacher written first makes a new one): `<game>/laya/.v<N>-<hash>.lock`, the same kind of lock,
  so a second distillation of the version on another port is refused, naming the first — it removed the
  first's round in progress as a leftover, fine-tuned into the same round folder, and each run's end
  dropped the other's checkpoint.
- **A saved version is immutable.** The rows its teacher labelled (`decisions/v<N>-<hash>.rules.jsonl`,
  `.rules.dagger.jsonl`) and its checkpoints (`laya/v<N>-<hash>-r<k>`) are keyed by `profileHash` — the
  extractor, the instructions and the actions —, not by the teacher: a new teacher is a new version, as
  the trainer and `TeacherWriter` save one. A teacher changed in place (by hand, or a built-in profile
  replaced under the same number) keeps the hash, and what the old one taught passes for current: its
  labelled and DAgger rows are reused (with enough of them the new teacher plays no game, and a fine-tuning
  learns both teachers' labels), its checkpoints are what a Laya play of the version takes
  (`currentCheckpoints`) and their recorded student means still decide which one stays, and `distill.json`
  names the teacher by its version (`rules v<N>`), not its code. Hashing the teacher in would make every
  checkpoint there is stale: to change a teacher, save a new version (or remove the version's rows files and
  checkpoints).
- **Distilling with a lag** (`lag`; CLI `laya distill --lag <ms | min-max>`, parsed as `play --lag`): for a
  lag-aware version, whose extractor computes time-critical features as of `info.lagMs` after the frame and
  whose inputs land live at the config's `lagMs` floor. A Laya distilled from paused games only (lagMs 0)
  meets states there it never saw (2026-09-30: Infinite Mario v4's won every level paused, as its rules, but
  2 of 6 live with inputs ≥ 50 ms, its rules 3 of 3; Dino v10's averaged 1143 live, its rules 1493). The
  teacher plays data games with real time simulated on the paused clock at that lag (`simulatedLag`) until
  half the distinct labelled states wanted (`minRows` / 2) are made with it, and half of each DAgger round's
  student games are played so (every other game, the other half in the next round — a round of one
  alternates). A row is marked with its game's lag (`lag`, beside its `seed`: finetune.py's split by game
  holds, and it reads no other field) — as is a row an engine logs while playing with a lag (the player
  marks `DecisionRecord.lag`: `play --lag`'s range; in real time `{ minMs: x, maxMs: x }`, x the lag its
  state was made for), since `--teacher engine` reuses that log: a real-time play's rows are then neither
  paused nor made with the lag asked (they once all counted as paused; rows logged before are unmarked) —,
  and the rows there count: a version distilled paused before plays
  lagged games only, its paused rows reused — it once played none (its rows were already enough) and the
  first training learnt paused rows only, while the log said half its games were lagged. While both kinds
  are short, the teacher's games go in pairs whatever the parallelism, one of a pair lagged and the other
  one in the next pair, the second of a pair wandering: the four kinds come as often. What was reused and
  what was played is logged. The rows of a lagged game are the states a lag-aware extractor makes in real
  time, labelled by the teacher — checked on paused games only: a lagged game, the teacher's or the
  student's, whose states it mostly failed on (more than half went unlabelled) refuses the run with the
  first error (one throwing on every lagged state once labelled none of them, unsaid). The other half stay
  paused: the paused clock is still learnt. Nothing else is lagged: the profile's seeds are
  played paused and decide as before (one checkpoint per version, replaced only by one that plays them
  better); the student then plays them once more with the lag, for information (logged,
  `DistillResult.lagged`; `distill.json` records the `lag` and, of the rows the checkpoint learnt, those
  made with it, `laggedRows`).
- **`laya/finetune.py`**: the sequence from Laya's own inference path (`Agent._encode_state` of
  `{"game": state}`), soft cross-entropy against the teacher's probabilities, rows merged by
  (state, question), rare actions drawn with weight `count^-0.7`, rows the student got wrong (DAgger
  rows whose `student` ≠ `choice`) ×4 — and those the checkpoint a round starts from still gets
  wrong drawn as a tenth of every batch (`--mistakes-share`), the early stop waiting for each of them,
  validation = whole games holding 15 % of the rows (rows carry their game's `seed`; where there are
  fewer than 3 games, or a row has none — logged before rows did, from a game that cannot be seeded, from
  a live play that was not seeded: one such row is enough — one contiguous block of the rows, which are
  logged game by game, so only the games at its two edges are split), token embeddings
  frozen, AdamW (encoder 3e-5, head 2e-4, warmup + linear decay), bf16 autocast on MPS, `--resume`
  after an MPS crash (the runtime retries twice, and a run that still fails says why: its error carries
  the last lines of its stderr; a run started without `--resume` first removes a resume state left in
  its directory, a crashed run's), the temperature fitted on validation. No labelled rows (an empty data
  file): it exits at once with a message, not at a `max()` over no rows after loading the model. A row of
  a frame with no state (`{ extractorError }`: an engine's decision log holds some from before the player
  stopped asking about one) is left out, as the teacher writer leaves it out. A line that is no row (cut
  short, maybe inside a character: the files are read as UTF-8, a bad byte replaced) is skipped, and one
  line for its file says how many (`skipped …`, which the distillation's log shows).
  Memory is bounded: a batch runs in pieces of at most `TOKEN_BUDGET` (2048) padded tokens with
  their gradients summed, padded to multiples of 64, the MPS cache emptied every step, and the MPS
  allocator capped (`PYTORCH_MPS_HIGH_WATERMARK_RATIO` 0.6, low 0.35 — the low mark must not be
  above the high one, or MPS fails to start and the script silently trains on the CPU). Without it,
  16 states of ~950 tokens (Spring Ninja, Dino) took 30–55 GB of a 48 GB Mac, filled the swap and
  froze the machine; with it a run holds ~6–9 GB at the same speed. `laya/serve.py` caps the allocator
  too, but higher (high 1.0 — the recommended working set itself —, low 0.8: it runs no backward pass,
  one state at a time), and empties its cache every 500 answers. Bounded, two or three fine-tunings fit a
  48 GB Mac side by side, but they share the GPU: ~0.2 steps/s each with three running, ~0.4 alone —
  and a Laya server answering meanwhile takes 43–60 ms instead of 20–30.
- **`laya/serve.py`**: serves checkpoints by name (`--checkpoint dino=<dir>`) over `/v1/systemone`
  (a model it does not serve is refused, never answered by another; `/health` names each model's
  checkpoint directory and the mtime of the weights file it loaded (`weights_mtime_ns`, taken before the
  load), and a server found on the port is reused only when it serves the very checkpoints wanted, as they
  are now — one holding another version's, one loaded before its checkpoint was made again under the same
  name (a round folder removed and its name used again), or one that does not say which weights it loaded
  (from before serve.py did: a restart settles it) is refused with an error; a distillation that fine-tunes
  refuses any server on its port before anything else — its students are checkpoints no server holds yet,
  and one found there would be refused hours later, when the first of them plays — while a resume with no
  more rounds reuses one holding the checkpoint it resumes from),
  one forward pass at a time, warmed up at start, a fine-tuned checkpoint under the autocast it was
  trained under (`amp` in its `ibgamer` config; bf16 before that was recorded). A model that only
  ever ran under bf16 answered otherwise in fp32: Tetris's "drop" to nearly every state it had
  learnt (0 rows in its own games; 100 % of the teacher's choices under bf16), Dino's JUMP held in
  the air (a quarter of its NOOPs lost). Flappy's answered the same either way — which is why it
  went unnoticed. `LayaServers` (UI, CLI) keeps ONE server, for the
  checkpoint last played with (a checkpoint is ~650 MB, more on the GPU): another game, another
  version, another checkpoint or a server that stopped answering restarts it. A game can have a
  checkpoint per profile version — one for the paused clock, another for real time from a version
  trained for it — and a Laya play takes the version's own (`checkpointFor`), of the checkpoints named
  with the version's current profile hash only (`currentCheckpoints` — `LayaServers`, `laya serve`, `laya
  eval`, and all the UI lists and offers Laya by — a game's checkpoints, the Laya status, a card's mark, a
  play's check before it starts —, `library games`' `hasLaya`; `laya list` marks the others stale; one of
  the version before it was edited in place learnt another extractor's states, and could
  win on its recorded mean): the version asked for
  (a config's `version`, the CLI's `--profile-version`) and none when it has none (another version's
  model reads another extractor's states); nothing asked for, the active version's, else the version of
  the game's newest checkpoint. Of a version's checkpoints it takes the one whose student played best
  when it was distilled (`distill.json`'s mean; the newest at a tie), the newest only when none was
  measured: a distillation that stops or fails removes no checkpoint (one per version is kept only once
  its student was measured), and the round it leaves behind never was. The UI locks its profile select
  to that version while Laya is the engine. `laya distill` and `laya eval` take `--profile-version` too
  (default: the active one); `laya serve` serves each game's checkpoint a play takes with nothing asked
  for (`checkpointsToServe`), so the players reuse it (its hint: `IBGAMER_ENGINE=laya
  IBGAMER_LAYA_PORT=<port> ibgamer play <game>`).
- **Python**: `ibgamer laya setup` makes `<home>/laya-venv` (`pip install -r laya/requirements.txt`);
  `IBGAMER_LAYA_PYTHON` overrides. It is looked up when it is used, so a venv made while the UI runs is
  picked up; the UI's check that it imports Laya keeps only a success. The status reports it apart
  (`engines.laya.python`): all a new game chosen for Laya needs.
- **Training a profile** plays with Jev (`--decider engine`: it tunes the rules an engine reads) or with
  the rules as code (`--decider rules`, docs/claude-md/training.md); Laya follows by distillation.

Measured on Dino (2026-09-28, M4 Max): Jev-labelled data, 1 epoch + 1 DAgger round (0.6 epoch,
7,065 relabelled student states, 520 disagreements — the student held JUMP in the air) → 1485 ×3 on
seeds it never trained on, 25–33 ms a decision, ×0.9–1.0 of the game's speed (before seeds replayed
frame for frame). Taught by the rules v4 (12,894 teacher states, 4 DAgger rounds, 40,901 student
states), served under bf16: 1093, 1485, 870 on the profile's seeds against the teacher's 1485 ×3
(448, 1333, 870 when served in fp32). The student agrees on 99.9 % of its states; both losses are
one tick: landing (`air: true`, `alt` 0–1) with a cactus close, the teacher waits, the student
presses JUMP (p = 1.0) — lost in the air, the key held, no fresh press after landing. Three such
rows in 10,058 were not learnt in a round that early-stopped on a sample of the hard rows; the next
round, drawing the rows its starting checkpoint still got wrong as a tenth of every batch and
stopping only once each was right (`finetune.py --mistakes-share`), played 1485 ×3 (r5, 30 ms).
