<p align="center">
  <img src="https://ironbee.ai/ironbee-logo.svg" alt="IronBee" width="120" height="120">
</p>

<h1 align="center">IronBee Gamer</h1>

<p align="center">
  <strong>Plays browser games live with a fast decision engine. An LLM trains each game's profile from the games it plays.</strong>
</p>

---

IronBee Gamer opens a browser game, reads what the page draws into a small JSON state, and asks a
decision engine to pick every move. It works without any help from the game: it needs no API and
no hooks the game exposes.

You can watch the game being played in a local web UI. Each decision is shown beside it: the
state the engine saw, the action it chose and the probabilities.

```
page (canvas / engine)
  └─ perception adapter ── generic, per rendering tech (2D canvas draw recorder, Phaser / PixiJS / Cocos dump,
                           any canvas as a small colour grid), or a reader of the game's own state the
                           trainer wrote from the page's code
  └─ extract(raw, memory) ── per game, written by the trainer (an LLM), < 1 ms
  └─ state JSON (features, never the answer)
  └─ decision engine ── Jev (hosted) or Laya (local, fine-tuned per game)
  └─ keys held / the pointer held / a click
  └─ the game's clock runs one tick ← the game moves only between decisions
```

**The division of labor.** Each part has one job:

- **The trainer (Claude, through the Claude Code CLI)** writes the logic: what the state
  computes, such as distances, times to impact and what is open. It also writes the rules that
  map those features to an action.
- **The decision engine** makes every live decision by applying those rules to the state.

A state that carries the answer (`advice: "JUMP"`) would make the engine a rubber stamp. Such
fields are stripped before the engine sees the state, and the trainer is told how many were
removed.

## Quick start

```bash
npm install
npm run build
export TYPESAFE_API_KEY=…            # Jev — or put it in a .env in the working directory
node dist/cli/main.js ui             # http://127.0.0.1:1986
```

Pick a game from the library and press **Play**. The browser is headless by default, and the
live view shows it. Use `--headed` to see the real window. Until the game's first frame (a Laya
server to start, the browser, the page to load: several seconds) the screen says which step it is on
and for how long, and why, if the game does not start.

```bash
ibgamer library list                 # the games and their active profiles
ibgamer play dino --seconds 30       # plays in the terminal; --watch paces it to the game's own speed
ibgamer train flappy-bird --iterations 3  # the trainer rewrites the profile; kept only when it scores higher
ibgamer check pacman-ghosts          # plays a seed twice: the same frame for frame, or where it first differs
ibgamer play pop-the-lock --lag 45   # real time simulated on the paused clock: each decision lands 45 ms late, every run the same
```

## The library

The library lists every game the app knows how to reach, start and measure, together with the
profiles that play it.

| Game | Perception | Its rules as code, the training seeds | Seeds it was never trained on | Random play | Laya, distilled |
|---|---|---|---|---|---|
| Chrome Dino ([wayou/t-rex-runner](https://wayou.github.io/t-rex-runner/)) | 2D canvas | 1485 ×3 in 90 s games (v10, trained for real time too; night mode reached in all three) | 1485 ×3 | 51 | 1485 ×3, the same as its rules |
| Flappy Bird ([floppybird](https://nebez.github.io/floppybird/) by nebez, Apache-2.0) | the game's own state (HTML; its CSS animations run on game time) | 38, 38, 21 pipes in 60 s (v5, trained for real time too) | 38 ×3 | 3 | 38, 38, 21, the same as its rules |
| Pac-Man with ghosts ([Pacman Canvas](https://pacman.platzh1rsch.ch/) by platzh1rsch, CC0) | pixels (a 90-wide colour grid) | 8410 ×3 in 180 s games, never died (v4, trained for real time too) | 8410 ×3 | 940 | 7680 ×3 |
| Doodle Climb ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/doodle-jump/)) | Phaser | 84 %, 100 % of the tower in 60 s | 100 %, 78 %, 100 % | 16 % | 100 %, 100 % |
| Pop the Lock ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/pop-the-lock/)) | Phaser (rotation) | 63, 59, 54 pops in 60 s | 19, 64, 60 | 6 | 63, 59, 54, the same as its rules |
| Super Coin Box ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/super-coin-box/)) | Phaser (tilemap) | 109, 113, 94 coins in 60 s (v4, trained for real time too) | 70, 128, 100 | 4 | 152, 115, 115 |
| Tetris ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/jtetris/)) | Phaser (the game's own state) | 69, 70 rows in 120 s, never topped out | 69 ×3 | 0 | 69, 70, the same as its rules |
| Crazy Snake ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/crazy-snake/)) | Phaser (the game's own state) | 36, 35 coins in 90 s (v2, trained for real time too) | 34, 41, 34 | 0 | 39, 35 |
| Racer ([Javascript Racer](https://jakesgordon.com/games/racer/) by Jake Gordon, MIT) | the game's own state (a page reader) | 3383, 3263, 3192 road segments in 60 s (v4, trained for real time too) | 3436, 3432, 3401 | 61 | 3383, 3263, 3192, the same as its rules |
| Infinite Mario ([mariohtml5](https://kenspiretech.github.io/mariohtml5/main.html) by Robert Kleffner, Unlicense) | the game's own state (a page reader) | 1267, 1264, 1268: each level won (tiles run, +1000 for winning the level; v4, trained for real time too) | 1270, 1272, 1262, each won | 22 | 1267, 1264, 1268, the same as its rules |

Measured on 2026-09-29, the clock paused (`ibgamer measure`, `ibgamer laya eval`): the training seeds
are the ones versions are compared on, the others (1001, 2002, 3003) are never shown to the tuner,
and random play (a seeded random action a decision) is the floor. The seed generator changed that day
(splitmix32 → mulberry32; before it, 101, 202 and 303 began as nearly the same game), so these differ
from earlier records. Laya plays as well as its rules nearly everywhere and better in three games (Super Coin
Box 122 % of the way from random play to them, Doodle Climb 110 %, Crazy Snake 104 %); Pac-Man's v4 Laya is
90 % of the way to rules that now score 8410 (its v2 Laya was 107 % of v2's 5870). The Phaser Flappy
Bird and its pixel copy were retired for floppybird on the same day. Every number was measured twice under
heavy load (several games at once, up to 27 browsers): all the same but two seeds, one in Super Coin
Box (157 for 87) and one in Flappy Bird (17 for 38); replayed again, in parallel under load, those
give the numbers above every time. On 2026-09-30 every game was measured again, after changes to how a
page's clock starts (the clock installed before the page's own scripts; a loader's chained files, and
the sound and images a page decodes, settled before the first frame; session storage emptied for each
game): the same numbers, rules and Laya. Chrome Dino's v10, Racer
and Infinite Mario were trained that night and are measured with those changes; Pac-Man's v4 and Crazy
Snake's v2 were trained for real time on 2026-09-30 (Crazy Snake's with the UI's **For real time**) and
measured on 2026-10-01.

Doodle Climb, Pop the Lock, Super Coin Box, Tetris, Crazy Snake, Pac-Man with ghosts, Flappy Bird,
Racer and Infinite Mario were added and trained by this app itself: the trainer set them up from a sample of what the page shows, then tuned them.
Their game definitions are the only hand-written part.

The library has two roots that act as one:

- **Built-in** (`library/`, shipped with the package): the researched games, with their whole
  training history (every version, the tuner's analysis, the regression tests and the windows the
  tests replay).
- **Yours** (`~/.ibgamer/library`, or `IBGAMER_LIBRARY_DIR`): games you add, and every version
  training makes. A trained built-in game gets its new versions here, beside the shipped ones.
  You can always make an older version active again.

```
<game>/game.json            how to reach, start and measure it — never how to play it
<game>/profiles/v<N>.json   how to play it: extractor, rules, actions, timing, regression tests, results
<game>/windows/<id>.json    raw frames before a failure, replayed offline by the regression tests
<game>/samples/…            what training looked at (a raw sample, sprite crops, a screenshot)
<game>/decisions/*.jsonl    the engine's decisions while playing: distillation data for Laya
<game>/laya/<name>/         a Laya checkpoint fine-tuned on this game (v<profile>-<hash>-r<round>, ~650 MB)
```

To share a game, use `ibgamer library export <game> <dir>`, which writes every version into one
directory. Use `ibgamer library import <dir>` to add one. A game's extractor is JavaScript. It
runs in its own V8 context with no Node globals, no `eval`, a time limit, and only JSON crossing
the boundary. Still, add only games you trust.

### Adding a game

In the UI, press **+ Add game**. A guided dialog takes a URL to a playable game in four steps:

1. **Page.** The page is opened and looked at. The verdict says what draws the game and how it
   will be read: a 2D canvas, Phaser, PixiJS or Cocos by a generic adapter. Any other canvas
   (WebGL from another engine, a bundled one) can be read by its pixels — a small colour grid
   each step, which works for anything but is less exact. Better, **let the trainer read the
   game's code**: it reads the page's scripts and writes one expression that returns the game's
   own state, which is checked on the page before it is offered. It takes a few minutes, and it
   works for any game whose state JavaScript can reach.
2. **Start.** It starts by itself, on a key, or on a click you place on the page's screenshot.
3. **Game.** Its name, how to play it in the game's own words, and the score: read by the
   trainer from what it perceives, or a page expression you know.
4. **Engine.** Laya (local, fast; the trainer writes the rules as code and Laya learns them) or
   Jev (hosted; reads the rules as text). Training can start right away.

The game's page then shows a checklist (added → rules trained → Laya taught → playable) with the
next step's button. A running training or distillation shows its stages, a progress bar, the time
left and the results so far. The first training run samples the page, asks the trainer for an
extractor and actions, saves that first profile as v1 and then tunes it.

A game definition (`game.json`) holds only data:

```json
{
  "id": "dino",
  "name": "Chrome Dino",
  "url": "https://wayou.github.io/t-rex-runner/",
  "goal": "Chrome Dino (T-Rex runner). Press Space or ArrowUp to jump, ArrowDown to duck. …",
  "perception": { "adapter": "canvas2d" },
  "viewport": { "width": 800, "height": 400 },
  "start": [{ "press": ["Space"], "advanceMs": 700 }, { "waitMs": 1000 }, { "advanceMs": 800 }],
  "score": { "expression": "(() => { const r = Runner.instance_; return { over: r.crashed, score: … }; })()", "label": "distance" },
  "budgets": { "gameSeconds": 90, "episodes": 1, "trainSeconds": 90 },
  "trainSeeds": [101, 202, 303]
}
```

The `start` steps are what a player does to begin: keys, clicks, game time (`advanceMs`), and
real time with the clock frozen (`waitMs`); `holdFrom`, a page expression naming the key to hold,
walks a menu or a map whose way depends on the seed. Dino begins only when a CSS animation ends, and CSS
animations run in real time; waiting for it with the game's clock stopped makes every game start
at the same game time.

A game that stops between levels and waits for the player ("click to continue") reports
`waiting: true` from its score expression, and its `resume` steps (the same shape as `start`)
take it on to the next level.

How a game is played well is data too: `configs` lists the engine and clock pairs it is offered
with (`{"engine": "laya", "live": true}`, a `version` when one is needed) and `preferredConfig` the
one it opens with. The UI offers only those — an engine or a clock not listed is greyed out — and
refuses a play request for another. A game that lists none (one you add) is offered what its versions
earn: every engine with the clock paused, and live Laya and the rules on the newest version trained
for real time that keeps at least 80 % of its paused score there — that version, its inputs held to the
lag it was trained at; never Jev live. Nothing to write by hand. A live config can also set `lagMs`: a version trained for real time has its inputs land no
sooner than that after their frame, however fast the engine answers (the lag it was trained at,
where its timing holds). Pop the Lock, Flappy Bird, Racer, Pac-Man with ghosts and Crazy Snake open with
Laya in real time, Chrome Dino, Super Coin Box and Infinite Mario with Laya and the clock paused; each plays
both clocks on one version trained for real time (Dino: `{"engine": "laya", "live": true, "version": 10, "lagMs": 50}`).

The score expression reads the game's own state and is used **for measuring only**. Neither the
engine nor the trainer ever sees it as a state field. A game without one can use
`"score": { "fromState": true }`, where the profile's own `state.score` / `state.over` is the
measure. That measure is self-reported, so a tuner could inflate it.

## How a game is played

- **A frozen clock.** Playwright's clock is installed before the page loads. After boot, time
  stops, and each step runs exactly `tickMs` of game time. The engine's latency costs no game
  time, so a real-time game becomes turn-based.
- **One step per decision.** Each step is one round trip to the browser: the input, then the
  game time, then the raw input and the score. `decideOn: "change"` holds an action until the
  state changes (a maze game's turn window). `askWhen` skips the engine while nothing is happening,
  and the last decision stays in force.
- **Input.** A key chosen again stays held; releasing and re-pressing it would cut a jump short.
  A click action clicks the game's centre (or a point) once. A pointer action holds the mouse
  button down while it is in force, for games that charge while pressed and act on release.
- **Seeds.** Every episode is a fresh page load with `Math.random` seeded (and a Phaser game's
  own RNG, which it seeds from the time, sown from it), and the clock is frozen on an animation
  frame boundary. So the same seed plays the same game, frame for frame, and two profile versions
  (or a Laya student and its teacher) are compared on identical games.
- **Game clock** (the UI's setting, `--watch` / `--realtime` in the CLI):
  - *Pauses for each decision, plays at real speed* (the UI's default): a step is never faster
    than the game's own speed, and a slow decision is a pause.
  - *Pauses for each decision, as fast as possible*: training and measuring play this way.
  - *Never pauses*: the clock runs in real time as for a person, and the game does not wait for a
    decision; the engine decides on a state the game has already left. A fine-tuning on the same
    GPU stretches Laya's decision from ~20–40 ms to 100 ms and more, and games are lost.

  Real time simulated on the paused clock (2026-09-29, `play --lag`, every run the same): the rules
  deciding on the training seeds, each decision landing 5 ms after its frame (the rules, which answer
  at once) or 40 ms after it (about Laya's time), the next frame read once it has landed plus a step's
  own time, as in real time. A pointer, not a verdict — a game is offered live (`configs`) only once it
  has been played live for real and kept about 85 % of its paused score without dying early:

  | Game | Paused | Rules at 5 ms | Rules at 40 ms | Played live for real | Offered live |
  |---|---|---|---|---|---|
  | Pop the Lock (v5, trained for 45 ms) | 63, 59, 54 | 5, 3, 25 | 3, 1, 2 (at 45 ms: 53, 59, 54) | inputs ≥ 45 ms: rules 64, 60, 54; Laya 64, 59, 54 (without the floor the rules died at 9 s) | rules, Laya (≥ 45 ms) |
  | Crazy Snake (v2, trained for 45–60 ms; before it v1) | 36, 35 (v1: 34, 35) | 36, 35 (v1: 34, 35) | 36, 35 (v1: 34, 35; v2 at 45, 53 and 60 ms: 36, 35 at each) | v1: Laya 32; v2 ≥ 50 ms: rules 39, 35, Laya 31 (dead at 74 s), 35 | rules, Laya (v2, ≥ 50 ms) |
  | Pac-Man with ghosts (v4, trained for 45–60 ms; before it v2) | 8410 ×3 (v2: 5870 ×3) | 7250, 7270, 7460 (v2: 5920, 5100, 5230) | 6630, 7820, 6140 (v2: 5110, 3130, 5160; v4 at 45, 53 and 60 ms on six seeds: 7527, 6535, 6898 on average, every game to the end) | v2: Laya 5110; v4 ≥ 50 ms: rules 7130, 5460, 5150, Laya 7400, 6350, 6540 | rules, Laya (v4, ≥ 50 ms) |
  | Tetris (not yet trained for real time) | 69, 70 | 67, 68 | 67, 68 (at 45, 53 and 60 ms: 60, 44, 11 and 69, 17, 17) | Laya 51, 63 | rules, Laya |
  | Doodle Climb | 84 %, 100 % | 51 %, 100 % | 100 %, 34 % (at 45, 53 and 60 ms: 84 %, 100 %, 100 % and 100 %, 100 %, 95 %) | Laya 84 %, 100 %; rules 84 %, 40 % | rules, Laya (the rules lose some) |
  | Super Coin Box (v2; v4 trained for 45–60 ms) | 87, 80, 126 | 105, 111, 84 | 116, 52, 70 (v4 at 53 ms: 106, 30, 117) | v2: Laya 55, 40, 65 (dead at 28–45 s); v4 ≥ 50 ms: rules 113, 112, 52, Laya 136, 125, 100 | rules, Laya (v4, ≥ 50 ms) |
  | Chrome Dino (v10, trained for 45–60 ms; before it v4, and v7 for 45 ms) | 1485 ×3 (v4: 1485, 1485, 825) | 1485 ×3 (v4: 855, 869, 995) | 1486, 1485, 824 (v4: 428, 444, 308) | v4: rules 561, 377; v7 ≥ 45 ms: rules 1494, 1494, 1227, 1494, 947, Laya 1287 on average over 8; v10 ≥ 50 ms: rules 1493, 1493, 1494, Laya 1492–1494 in 8 of 8, every game to the end (distilled with the lag; before it 1143 on average) | rules, Laya (v10, ≥ 50 ms) |
  | Flappy Bird (v3; v5 trained for 45–60 ms) | 38, 38, 21 | 4, 38, 38 | 5, 4, 1 (v5 at 45–60 ms: 38, 38, 21) | v3: Laya 38, 6, 8; v5 ≥ 50 ms: rules 38, 38, 22, Laya 38, 38, 38 | rules, Laya (v5, ≥ 50 ms) |
  | Racer (v4, trained for 45–60 ms) | 3383, 3263, 3192 | 3444, 3287, 3271 | 3441, 3259, 3242 | ≥ 50 ms: rules 3433, 3291, 3263, Laya 3449, 3339, 3283 | rules, Laya (v4, ≥ 50 ms) |
  | Infinite Mario (v4, trained for 45–60 ms) | 1267, 1264, 1268 (each level won) | the same | the same | ≥ 50 ms: rules 1267, 1264, 1268; Laya 2 to 4 levels won of 6 (10 of 18 over three distillations with the lag; 2 of 6 before it) | rules, Laya (v4, ≥ 50 ms) |

  The live runs are one to eight games each (2026-09-28 to 10-01; Pac-Man, Crazy Snake and Doodle Climb on
  2026-10-01 with the machine quiet). Tetris's real-time trainings found versions playing it twice as well
  live (61.5 against 30.5) but worse with the clock paused (49 against 69.5): not kept, since one version
  serves both clocks. A version trained for real time plays at the lag it was trained at and not below it:
  Pop the Lock's v5 dies at once at 40 ms and plays as paused at 45 — so its live configs, like
  Dino's, hold the inputs to that lag (`lagMs`), however fast the engine answers. Dino played live on
  v7 with its own Laya (`laya distill dino --profile-version 7`; at Laya's own 23 ms it lost a game at
  24 s) and paused on v4, until v10 (below) played both. Flappy Bird's v5 was trained for real time
  on the simulated clock (`train --realtime --simulated --latency 45-60`) and plays both clocks:
  paused 38, 38, 21 (unseen seeds 38 ×3), live with its inputs ≥ 50 ms rules 38, 38, 22 and Laya
  38, 38, 38 — so it is the active version and one Laya serves both. So is Super Coin Box's v4 (trained
  the same way): paused 109, 113, 94 (unseen 70, 128, 100) where v2 played 87, 80, 126 (74, 70, 111),
  its Laya 152, 115, 115 paused and 136, 125, 100 live with its inputs ≥ 50 ms, every game to the end —
  where v2's Laya, not trained for real time, played 55, 40, 65 live and died early in each. Chrome
  Dino's v10 (trained the same way from v4) and Racer's and Infinite Mario's v4 too: Dino
  paused 1485 ×3 (unseen 1485 ×3), live with its inputs ≥ 50 ms rules 1493, 1493, 1494 and Laya
  1492–1494 in 8 games of 8, every one to the end — one Laya for both clocks. That Laya was distilled
  with the lag (`laya distill --lag 45-60`: half the teacher's and the student's games simulate real
  time on the paused clock); distilled on the paused clock only, it averaged 1143 live over 8 games
  (v7's Laya: 1287), losing games to states it had never seen. Racer: paused 3383, 3263, 3192,
  live ≥ 50 ms rules 3433, 3291, 3263 and Laya 3449, 3339, 3283. Infinite Mario: every level won paused
  and live with the rules (1267, 1264, 1268); its Laya, distilled with the lag too, wins every level paused
  and with the lag simulated, but live only 2 to 4 of 6 (174, 14, 1268, 1270, 243, 66 for the checkpoint
  kept), where the rules win them all — offered live all the same, as asked; the rules are the steadier
  engine there.

  Real time does not replay: frame timing and the engine's time differ from run to run, so a single
  game is indicative only (the Phaser Flappy: 34 once, 15 the next time; `play --lag` now simulates real time on the paused clock, the same every run). What loses is being late where the game
  allows no lateness — Dino jumps only on a fresh press right after landing, Pop the Lock's click must
  land while the needle is on the dot — and what fixes it is a profile trained for real time (`train
  --realtime`): its extractor describes the world the action meets (`info.lagMs`) and the player
  holds each input to land at that lag, so a decision time of 40–70 ms plays like a fixed one. Pop the
  Lock went from dead on the first dot to 59, never missed. Dino, trained for real time with the rules
  answering 35 ms late: v6 and v7 played live well and paused worse (v7, 2026-09-29: 628, 840, 815),
  so v4 stayed for the paused clock; v10, trained on the simulated clock at 45–60 ms, plays both.
- **Plans, for an engine slower than the game** (`train --realtime --latency 250-600 --plan 8x50`,
  then `play --engine jev --realtime --profile-version <n>`): Jev (~300–600 ms a request) is asked for
  the next 8 moments, 50 ms apart, in one request — the extractor predicts each moment — and the
  player lands each input at its moment while the next request is already out. It decides *when* to
  act; it cannot react to something new sooner than the engine answers. Pop the Lock, where the next
  dot appears at random: Jev went from dead on the first dot to 1, 0 and 2 pops (the rules, as late:
  1, 0, 6), a ceiling of a few pops at this latency. Dino, where the cacti are seen coming: Jev from
  ~56 to 312, 154, 208 (the rules, as late: 541, 91, 882; paused: ~1300) — playable, not good, so no
  game offers Jev live yet (docs/design/realtime-plans.md).

## Training

```
play the best version on fixed seeds (several games at once)
  → evidence: scores, the last decisions before each end, end screens,
    the raw frames before each failure (saved as windows), things perceived for the first time
  → the trainer writes a new version + regression tests that pin its fix down
  → it must pass every regression test offline (one repair round)
  → it plays the same seeds → kept only if its mean is higher
```

What plays while a profile is trained is a choice:
- **Jev** (`--decider engine`): Jev reads the instructions.
- **The rules as code** (`--decider rules`): the profile's `teach(state)`. It is instant, so an evaluation
  takes seconds instead of minutes, and it is the path to a fast local Laya afterwards.

In the UI, Train uses the engine that is chosen.

**For real time** (the box beside Train, and in the add-a-game wizard; `train --decider rules --realtime
--simulated` in the CLI) trains a game that does not wait for the player, for Laya or Rules (code): the rules decide 45–60 ms
late, as Laya plays live, on the paused clock so every run gives the same result, and every seed is played
at 45, 53 and 60 ms — a version must play at every lag in that range. It is kept only if it also plays no
worse with the clock paused, so one version serves both clocks. Distill then teaches Laya its live states
too (`laya distill` does it for such a version by itself), and the game is offered live once a version plays
there nearly as well as paused. No lag or version to pick.

Training stops after two versions in a row that do not beat the best one, or once a version reaches
the game's top score (`score.max`). "Trained once, done" is
wrong: a profile covers only the phases of a game it has seen. In the research, the Dino profile
broke when night mode began, and one retraining round on longer games fixed it. The research,
with every number and pitfall, is in [research/KNOW-HOW.md](research/KNOW-HOW.md).

## Decision engines: Jev, Laya and the rules as code

| | Jev (TypeSafe, hosted) | Laya (open, local) | Rules (code) |
|---|---|---|---|
| Latency | ~275 ms from Türkiye (~50 ms of it is the model; the rest is the round trip) | ~25–30 ms on an Apple M-series GPU | < 1 ms |
| Rules | reads them in the instructions every decision | learns them: fine-tuned per game and profile version | are the profile's `teach(state)`, written by the trainer |
| Setup | `TYPESAFE_API_KEY` | `ibgamer laya setup`, then `ibgamer laya distill <game>` | none: a version trained with the rules deciding carries them |

The rules as code play as well as they are written, instantly, from the moment training writes
them — a baseline for the engines, and a way to play a game (in real time too) before Laya has
learnt it. They know only what they were written for; an engine that reads the rules as text can
reason about what the code did not foresee.

Jev follows written rules well, but at 275 ms a 90 s Dino game at 30 ms ticks takes ~14 minutes of
wall time. Laya decides locally in ~25 ms, close to the game's own speed. A small encoder cannot read
long rules: its question head holds ~256 tokens (Dino's rules are cut there), and zero-shot it is
near chance. The base checkpoints never chose a correct JUMP on Dino. So Laya is **distilled**.
The rules are learnt into its weights from labelled states:

1. **The teacher.** The trainer writes the profile's rules twice: as the instructions (for Jev and
   people) and as `teach(state)` (the same rules as code). The teacher is checked before it teaches.
   It must agree with the engine's logged decisions per action (Dino: 100 % of 6,000). It must also
   score like the profile when it plays by itself (Dino 1485 ×3, Flappy Bird 38, 38, 21, Pac-Man 8410 ×3).
2. **Labelled states.** The teacher plays many games in a few minutes, a random move now and then so
   the data leaves its own path. The state is still features only; the teacher's answer is the
   training *target*.
3. **Fine-tuning.** `laya/finetune.py` fine-tunes a copy of Laya on those rows:
   - the sequence is built by Laya's own inference path;
   - the loss is soft cross-entropy against the teacher's probabilities;
   - rare actions and the rows the student got wrong are weighted up;
   - games are split for validation, and a temperature is fitted.
4. **DAgger.** Laya plays, the teacher labels the states Laya visited, and training continues from
   the last checkpoint. One round fixed Dino: before it, Laya kept holding JUMP in the air (520 of
   7,065 states), a state the teacher's own games never reach.
5. **Serving.** `laya/serve.py` serves each game's checkpoint over the same `/v1/systemone`
   protocol. The UI starts it when Laya is chosen for a game.

Measured on Dino (2026-09-28, the profile's seeds 101, 202, 303, M4 Max). Before the last round Laya
agreed with its teacher on 99.9 % of the states it visited and still lost two games, both where the
dino is landing (still in the air, 0–1 px up) with a cactus close: the rules wait that one tick,
Laya pressed JUMP, the press was lost in the air, and the jump after landing never came. Three such
states in 10,058. A round that draws the mistakes its starting checkpoint still makes as a tenth of
every batch, and stops only once each is right, taught them:

| Engine | Score, 90 s games | Decision | Game speed |
|---|---|---|---|
| Jev | 1485, 1485, 1485 | ~285 ms | ×0.1 |
| Laya, zero-shot | never jumps right | ~20 ms | – |
| Laya, distilled from the rules + 5 DAgger rounds (the last one on its remaining mistakes) | 1485, 1485, 1485 | ~30 ms | ×0.85–1.0 |

```bash
ibgamer laya setup                       # a Python environment with Laya (~/.ibgamer/laya-venv)
ibgamer laya distill dino                # teacher → data → fine-tune → DAgger → Laya plays the seeds
ibgamer laya distill dino --resume --rounds 2  # more DAgger rounds from the checkpoint there
ibgamer play dino --engine laya --watch  # or in the UI: Engine "Laya (local)"
```

A checkpoint belongs to the profile version whose states it learnt. A new extractor means
distilling again. A new teacher means relabelling, which is instant, and fine-tuning again.
One checkpoint is kept per profile version: a new one replaces it only if it plays the profile's
seeds better. A game can keep checkpoints of several versions — one for the paused clock, another
from a version trained for real time (`laya distill <game> --profile-version <n>`; a config pins
the version) — and Laya plays the version's own, the active version's when none is named.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` / `JEV_API_KEY` | – | Jev's key |
| `IBGAMER_ENGINE` | `jev` | `jev` or `laya` |
| `IBGAMER_LAYA_PYTHON` / `IBGAMER_LAYA_PORT` | `~/.ibgamer/laya-venv` (else `python3`) / `8601` | the Python with Laya, and the port of the server the app starts |
| `LAYA_URL` / `LAYA_MODEL` | `http://127.0.0.1:8000` / – | a Laya server you run yourself, and the checkpoint name to ask |
| `IBGAMER_UI_PORT` / `IBGAMER_UI_HOST` | `1986` / `127.0.0.1` | the web UI |
| `IBGAMER_HEADLESS` | `true` | `false` shows the browser window |
| `IBGAMER_HOME` | `~/.ibgamer` | the user library (`library/`) and runs (`runs/`) |
| `IBGAMER_DAEMON_URL` | – | an IronBee DevTools daemon to use, started with this package's `TOOL_PLUGINS` |
| `IRONBEE_DEVTOOLS_DAEMON_SCRIPT` | the installed package | the DevTools daemon to start |
| `CLAUDE_CODE_CLI` / `IBGAMER_TRAINER_MODEL` | `claude` / `opus` | the trainer |

## Under the hood

The browser belongs to an [IronBee DevTools](https://www.npmjs.com/package/@ironbee-ai/devtools)
daemon, the same one IronBee Express uses. The game tools run inside it as a **tool plugin**
(`dist/devtools-plugin/game-tools.mjs`, loaded with `TOOL_PLUGINS`):

- `game_open` installs the perception adapter, the seed and the clock, then loads and boots the
  page.
- `game_step` applies the input, runs game time, and reads the raw input and the score.
- `game_probe` reports which rendering tech a page uses.
- `game_sprite-crops` returns what a recorded sprite looks like.

DevTools' screencast feeds the live view and the videos.

## License

[Elastic License 2.0](LICENSE)
