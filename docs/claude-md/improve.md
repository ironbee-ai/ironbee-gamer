# Train: check, fix, check again (src/improve/)

The one thing a person asks for: make a game play better with an engine on a clock — the UI's **✦ Train**, with the
Engine and Clock chosen above it, or `ibgamer train <game> --engine laya --realtime`. The app finds what to fix and
fixes it; nobody diagnoses by hand, and it is pressed whether the game plays badly or well. Optional notes for the
trainer are the person's own idea. Everything here is generic: scores, the engine's decisions beside its rules', the
clock — nothing knows a game (the module keeps its name, `improve`: it makes the game play better).

## Nothing to check yet, or something (`nothingToCheck`)

Train checks only where there is something to check: a version the clock plays, the engine able to play it. Where
there is not, `nothingToCheck` says why, and a training starts there instead (src/train/train-for.ts, the same steps
without the check before and after; the run's log says why):

- no version trained yet — the first training;
- the game not played with that engine on that clock (`playConfigs`) — the running clock: a first training for real
  time (the rules LIVE_LATENCY late, simulated on the paused clock), as the setup checklist's **Train for real time**;
- Laya with no model of the version it is to play (`layaToTeach`: its config's pinned version for that clock, else the
  active one) — Laya taught that version alone;
- the rules, in a version without them as code — the trainer writes them.

A version asked for that the game does not have is refused (the server: a 400 before the run begins).

## The check (check.ts, `checkPlay`)

- The engine plays the version its config for that clock plays (Laya: the version its checkpoint learnt) on the
  version's seeds: with the clock running `LIVE_GAMES_PER_SEED` (5) games a seed — one bad game in five is found,
  three often miss it — paused once (a paused game replays the same). The version's rules play the same seeds on
  the same clock beside it: the reference. Games one at a time (live games side by side slow each other); the
  live floor is the config's `lagMs`, else the version's (`liveFloorMs`).
- After each game every state the engine decided on is asked of the rules (`teach`, after the game: in its time it
  would slow a live decision). A decision the rules would have made otherwise is a disagreement; a tie agrees.
- Findings, a seed below its reference by more than `WORSE_SHARE` (live 10 %, paused 2 %):
  - `rulesWorse`: the rules below their record on this clock (the running one: as measured in real time, else
    paused) — the version is what to fix there;
  - `engineWorse`: the engine below the rules on the same clock (a version without rules, one trained for Jev:
    below its record).
- Verdict: `RULES` first (the engine learns from the rules), then `ENGINE`, else `NOTHING`. For each game played
  below its reference, the decisions in its last 3 s where the engine chose otherwise than the rules
  (`divergences`) — where it went wrong (information only: the fix does not read them).
- Live, the games the engine lost with its inputs landing more than `LATE_MS` (10 ms) past their floor are said so,
  with its time a decision (`engineMs`, every game's): it answered slower than the version is played at — the
  engine's speed, not its lessons. Paused, `sameGames`: every seed played the very same game (the same score in as
  many decisions) — the seeds do not change this game, and the check saw one.
- `ibgamer train <game> --check-only` prints the games, the verdict and the divergences.

## The fix (improve.ts, `Improver`)

- Notes from the person: always a training with them — the rules deciding, Jev deciding for Jev — and for Laya a
  distillation of the version kept. A version is still kept only on its scores.
- `RULES`, `NOTHING` (the version trained for a higher score) and anything Jev: the version trained from the one
  played (`fromVersion`), the request's iterations (Train iterations; else `TRAIN_ITERATIONS`):
  - paused: the rules deciding, 3 iterations;
  - the running clock: **live training** (`TrainOptions.live`: every seed 5 times for real, the rules at once, the
    inputs held to the live floor; the paused bar, the random floor and the unseen seeds paused, once a seed —
    simulated real time never shows a loss only live games have), 4 iterations;
  - Jev: Jev deciding, 2 iterations, `activate: false` — the version kept is Jev's, and Jev's config plays it;
  - Laya: then distilled for the version kept (with the lag for a lag-aware one; live DAgger rounds for the
    running clock). Training kept nothing while Laya plays below its rules where they hold: Laya taught more.
- `ENGINE` with Laya: Laya taught more — DAgger from its checkpoint (`resume`, 2 rounds); the running clock:
  `DistillOptions.live`, its student games played live, one at a time, each row with the lag it was decided at
  (`laya distill --live`). A lesson that plays no better (its distillation kept the checkpoint before it, or the check
  after it found nothing better: undone) is followed by the next (`LAYA_LESSONS`): the version learnt again from the
  base model on every state gathered (the teacher's and every round's; not resumed), then its rounds — kept on the
  same terms, undone when it plays no better. Every round's student games wander half the time (docs/claude-md/engines.md).
- Checked again, then `playsBetter`. The same version (Laya taught more), held to the same rules: fewer seeds below
  their reference with the mean no lower, or as few and the mean higher by more than 1 %. A new version is held to its
  own fresh record (its rules can no longer be below it): its engine must play better outright, the mean higher by more
  than 1 %. A training that kept no version, and a distillation that kept the checkpoint before it (the new one played
  no better paused), end there: nothing new to check.
  - Better: the version kept is what that engine and clock play from then on — the game's configs (its own, else
    the ones its versions earn) pinned in the user library's game.json; Laya and the rules together.
  - Not better, stopped or failed part way (the check after it too): undone — every round folder of the version but
    the one before goes (a stopped lesson's too, which a resume would go on from), the one before (cloned aside first:
    APFS copies on write; moved back across volumes too) back where it was, the active version the one before; a
    version trained stays in the library. A stop is looked at after every step: nothing more starts.
- Laya: a server another process holds on the port a lesson serves its student on is refused before the check, not
  after it (`refuseLayaServer`).
- `TrainOptions.activate: false` keeps a version kept from becoming active — with no version set (a fresh library),
  the active one is written down, or the newest would be taken for it.
- The engines come from the caller (`ImproveEngines`): the UI's Laya servers and Jev, the CLI's own. `release()`
  stops a Laya server before a distillation, which serves its student on the same port.

## In the UI and the CLI

- **✦ Train** acts on the engine wanted (picked in the Engine list, else the game's own — never a fallback the list
  shows while that one cannot play) and the Clock chosen; the version the Profile select plays, when the engine shown
  is the one wanted; Train iterations; the notes for the trainer. Greyed out, saying why, without the trainer, Laya's
  Python (Laya) or Jev (Jev), and for Jev on the running clock; the server refuses the same
  (`POST /api/runs` `{ kind: "train", engine, live, iterations, version?, note? }` — `realtime: true` says `live` too).
  There is no Improve button and no For real time box beside Train: the Clock says it, and a game not played live yet
  gets the setup checklist's **Train for real time**.
- A checked run (`RunKind.TRAIN` with `record.improve`) shows its progress as a training's does (`ImproveTracker`,
  src/run/progress.ts): the check's games (played of planned, the time left at the pace of those played), the fix's
  own stages (a training's iterations, a distillation's rounds, followed by their own trackers), the check after it
  (skipped, "nothing new to check", when the fix kept nothing); a second Laya lesson its own stages ("Laya, again")
  and check — the bar weighed (the check before a fifth, each go at the fix the rest, its check after it a quarter of
  that), planning for a second lesson as soon as Laya is taught more, so it never runs back. Its phases and log are in the Training tab, its check and training games in the
  live view; `record.improve` keeps each check (the means per seed, the rules' beside them, the seeds below their
  reference), the outcome and what was done, summarized above the log. A run with nothing to check is a training's
  (`ProgressTracker`, `LayaTrainingTracker`).
- `ibgamer train`: the same (`--engine`, `--realtime`, `--iterations`, `--games`, `--note`, `--work`); `--check-only`
  the check alone; `--no-check` a training without the checks, with the trainer's own options (`--seconds`, `--seeds`,
  `--sequential`, `--decider`, `--from`, `--latency`, `--simulated`, `--plan` — refused without it). A checked run's
  files go beside the runs (`config.runsDir`: Laya's checkpoint is cloned aside there, on the same volume).
