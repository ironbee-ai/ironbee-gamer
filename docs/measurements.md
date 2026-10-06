# Measurements

The scores behind the README, kept out of it: what each game's versions and Laya played, and what was measured about
real time and about teaching Laya. Every number is dated and belongs to the version named with it; what a version
plays today is in its profile (`results`) and in Laya's record beside its checkpoint (`distill.json`), and
`ibgamer measure <game>` measures a version again. The reasoning behind the measurements is in
[claude-md/playing.md](claude-md/playing.md), [claude-md/training.md](claude-md/training.md) and
[claude-md/engines.md](claude-md/engines.md); the research before the app, in
[../research/KNOW-HOW.md](../research/KNOW-HOW.md).

## The games

| Game | Perception | Its rules as code, the training seeds | Seeds it was never trained on | Random play | Laya, distilled |
|---|---|---|---|---|---|
| Chrome Dino ([wayou/t-rex-runner](https://wayou.github.io/t-rex-runner/)) | 2D canvas | 1485 ×3 in 90 s games (v11, trained for real time too; night mode reached in all three) | 1485 ×3 | 51 | 1485 ×3, the same as its rules |
| Flappy Bird ([floppybird](https://nebez.github.io/floppybird/) by nebez, Apache-2.0) | the game's own state (HTML; its CSS animations run on game time) | 38 ×3 pipes in 60 s (v6, trained for real time too) | 38 ×3 | 3 | 38 ×3, the same as its rules |
| Pac-Man ([Pacman Canvas](https://pacman.platzh1rsch.ch/) by platzh1rsch, CC0) | pixels (a 90-wide colour grid) | 8410 ×3 in 180 s games, never died (v4, trained for real time too) | 8410 ×3 | 940 | 7680 ×3 |
| Doodle Climb ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/doodle-jump/)) | Phaser | 84 %, 100 % of the tower in 60 s | 100 %, 78 %, 100 % | 16 % | 100 %, 100 % |
| Pop the Lock ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/pop-the-lock/)) | Phaser (rotation) | 63, 59, 54 pops in 60 s | 19, 64, 60 | 6 | 63, 59, 54, the same as its rules |
| Super Coin Box ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/super-coin-box/)) | Phaser (tilemap) | 109, 113, 94 coins in 60 s (v4, trained for real time too; v5, kept for real time only, plays it live) | 70, 128, 100 | 4 | 152, 115, 115 |
| Tetris ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/jtetris/)) | Phaser (the game's own state) | 31192, 50126 points in 120 s (v4; the game's own score: four rows cleared at once 1200, one row 40, times the level + 1), never topped out | 46674, 31368, 50685 | 218 | 31192, 50126, the same as its rules |
| Crazy Snake ([Phaser examples](https://noowxela.github.io/phaser-examples/games/ready/crazy-snake/)) | Phaser (the game's own state) | 36, 35 coins in 90 s (v2, trained for real time too) | 34, 41, 34 | 0 | 39, 35 |
| Racer ([Javascript Racer](https://jakesgordon.com/games/racer/) by Jake Gordon, MIT) | the game's own state (a page reader) | 3383, 3263, 3192 road segments in 60 s (v4, trained for real time too) | 3436, 3432, 3401 | 61 | 3383, 3263, 3192, the same as its rules |
| Infinite Mario ([mariohtml5](https://kenspiretech.github.io/mariohtml5/main.html) by Robert Kleffner, Unlicense) | the game's own state (a page reader) | 1267, 1264, 1268: each level won (tiles run, +1000 for winning the level; v6, trained for real time too; Jev plays v7) | 1270, 1272, 1262, each won | 22 | 1267, 1264, 1268, the same as its rules |
| Breakout ([Javascript Breakout](https://jakesgordon.com/games/breakout) by Jake Gordon, MIT) | the game's own state (a page reader) | 3550, 3265, 3455 points in 60 s, each played to the end of its time (v1) | 3740, 4130, 3375 | 360 | 3550, 3265, 3455, the same as its rules |

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
measured on 2026-10-01. Tetris is measured in the game's own points since 2026-10-01 (rows cleared in 120 s
rewarded keeping a column empty so that pieces fall less far, and never clearing four rows at once). That
day Tetris's v4 was trained in points (the trainer told, in its notes, about the column kept empty), Chrome
Dino's v11, Flappy Bird's v6, Super Coin Box's v5 and Infinite Mario's v5 and v6 for real time with each seed
played at 45, 53 and 60 ms, and Infinite Mario's v7 with Jev deciding.

Doodle Climb, Pop the Lock, Super Coin Box, Tetris, Crazy Snake, Pac-Man, Flappy Bird,
Racer and Infinite Mario were added and trained by this app itself: the trainer set them up from a sample of what the page shows, then tuned them.
Their game definitions are the only hand-written part. Breakout was added on 2026-10-06 wholly through the UI — **+ Add
game**, the trainer reading the game's code for its state, its score and its start — and trained once: its first
version was kept (a candidate that scored 4203 on the training seeds played the unseen ones worse, 3595 against
3748, and was turned away), and Laya learnt it — 2550, 3195, 2900 at first; **Train**, pressed once more for Laya, found
it below its rules on all three seeds and taught it more (two rounds of its own games, the rules correcting 331 and
234 of 10,000 decisions): 3550, 3265, 3455, the same as its rules.

## Real time

Real time simulated on the paused clock (2026-09-29, `play --lag`, every run the same): the rules
deciding on the training seeds, each decision landing 5 ms after its frame (the rules, which answer
at once) or 40 ms after it (about Laya's time), the next frame read once it has landed plus a step's
own time, as in real time. A pointer, not a verdict — a game is offered live (`configs`) only once it
has been played live for real and kept about 85 % of its paused score without dying early:

| Game | Paused | Rules at 5 ms | Rules at 40 ms | Played live for real | Offered live |
|---|---|---|---|---|---|
| Pop the Lock (v5, trained for 45 ms) | 63, 59, 54 | 5, 3, 25 | 3, 1, 2 (at 45 ms: 53, 59, 54) | inputs ≥ 45 ms: rules 64, 60, 54; Laya 64, 59, 54 (without the floor the rules died at 9 s) | rules, Laya (≥ 45 ms) |
| Crazy Snake (v2, trained for 45–60 ms; before it v1) | 36, 35 (v1: 34, 35) | 36, 35 (v1: 34, 35) | 36, 35 (v1: 34, 35; v2 at 45, 53 and 60 ms: 36, 35 at each) | v1: Laya 32; v2 ≥ 50 ms: rules 39, 35, Laya 31 (dead at 74 s), 35 | rules, Laya (v2, ≥ 50 ms) |
| Pac-Man (v4, trained for 45–60 ms; before it v2) | 8410 ×3 (v2: 5870 ×3) | 7250, 7270, 7460 (v2: 5920, 5100, 5230) | 6630, 7820, 6140 (v2: 5110, 3130, 5160; v4 at 45, 53 and 60 ms on six seeds: 7527, 6535, 6898 on average, every game to the end) | v2: Laya 5110; v4 ≥ 50 ms: rules 7130, 5460, 5150, Laya 7400, 6350, 6540 | rules, Laya (v4, ≥ 50 ms) |
| Tetris (points; v4, not trained for real time; before it v3) | 31192, 50126 (v3: 13419, 14587) | 30172, 50076 (v3: 12799, 13972) | 30158, 41650 (at 45 ms 6844, 29721; at 53 ms 412, 1754 and at 60 ms 1311, 414, topped out within 112 s; v3: 12797, 13975) | v4, inputs as soon as decided: rules 46787, 52301, Laya 59936, 33710 (at 30–36 ms); v3: Laya 51, 63 rows (before the switch to points) | rules, Laya |
| Doodle Climb | 84 %, 100 % | 51 %, 100 % | 100 %, 34 % (at 45, 53 and 60 ms: 84 %, 100 %, 100 % and 100 %, 100 %, 95 %) | Laya 84 %, 100 %; rules 84 %, 40 % | rules, Laya (the rules lose some) |
| Super Coin Box (v2; v4 trained for 45–60 ms; v5 at 45, 53 and 60 ms, kept for real time only) | 87, 80, 126 (v4: 109, 113, 94; v5: 76, 105, 118) | 105, 111, 84 | 116, 52, 70 (v4 at 53 ms: 106, 30, 117; v5 at 45, 53 and 60 ms: 133, 106, 114 on average, every game to the end) | v2: Laya 55, 40, 65 (dead at 28–45 s); v4 ≥ 50 ms: rules 113, 112, 52, Laya 136, 125, 100; v5 ≥ 50 ms: rules 128, 86 (dead at 54 s), 107, Laya 131, 102, 118 | rules, Laya (v5, ≥ 50 ms) |
| Chrome Dino (v11, trained at 45, 53 and 60 ms; before it v10 for 45–60 ms, v4, and v7 for 45 ms) | 1485 ×3 (v4: 1485, 1485, 825) | 1485 ×3 (v4: 855, 869, 995) | 1486, 1485, 824 (v10; v4: 428, 444, 308; at 45, 53 and 60 ms v10 lost seed 303 at 824 at each and 202 at 60 ms, v11 none of the nine) | v4: rules 561, 377; v7 ≥ 45 ms: rules 1494, 1494, 1227, 1494, 947, Laya 1287 on average over 8; v10 ≥ 50 ms: rules 1493, 1493, 1494, Laya 1492–1494 in 8 of 8, every game to the end (distilled with the lag; before it 1143 on average); v11 ≥ 50 ms: rules 1493 ×3, Laya 1494, 1493, 1493 | rules, Laya (v11, ≥ 50 ms) |
| Flappy Bird (v3; v5 trained for 45–60 ms, v6 at 45, 53 and 60 ms) | 38, 38, 21 (v6: 38 ×3) | 4, 38, 38 | 5, 4, 1 (v5 at 45–60 ms: 38, 38, 21; at 45, 53 and 60 ms v5 lost seed 303 at 45 and 60 ms, v6 scored 38 in all nine) | v3: Laya 38, 6, 8; v5 ≥ 50 ms: rules 38, 38, 22, Laya 38, 38, 38; v6 ≥ 50 ms: rules 38 ×3, Laya 38 ×3 | rules, Laya (v6, ≥ 50 ms) |
| Racer (v4, trained for 45–60 ms) | 3383, 3263, 3192 | 3444, 3287, 3271 | 3441, 3259, 3242 | ≥ 50 ms: rules 3433, 3291, 3263, Laya 3449, 3339, 3283 | rules, Laya (v4, ≥ 50 ms) |
| Infinite Mario (v6, trained at 45, 53 and 60 ms; before it v4 for 45–60 ms) | 1267, 1264, 1268 (each level won) | the same | the same (at 45, 53 and 60 ms v4 lost seed 202 at 45 ms and 303 at 60 ms, v6 none of the nine) | v4 ≥ 50 ms: rules 1267, 1264, 1268; Laya 2 to 4 levels won of 6 (10 of 18 over three distillations with the lag; 2 of 6 before it); v6 ≥ 50 ms: rules 1267, 1264, 1268; Laya 1267, 14 (dead at 1.3 s: its first decisions were slow, the inputs landing at 87 ms), 1268, and seed 202 three more times, 1264 each | rules, Laya (v6, ≥ 50 ms) |

The live runs are one to eight games each (2026-09-28 to 10-01; Pac-Man, Crazy Snake, Doodle Climb,
Tetris, Infinite Mario, Chrome Dino, Flappy Bird and Super Coin Box on 2026-10-01 with the machine quiet).
Tetris's real-time trainings (in rows, before its measure became the game's own points) found versions
playing it twice as well live (61.5 against 30.5) but worse with the clock paused (49 against 69.5); such
a version is now kept for real time only. Tetris's versions are not lag-aware, so live their inputs land
as soon as the engine answers: v4, trained in points with the clock paused, keeps its score to 40 ms
simulated and tops out from 45 ms on, and live it played rules 46787, 52301 and Laya (30–36 ms) 59936,
33710, against 31192, 50126 paused. A version trained for real time plays at the lag it was trained at and not below it:
Pop the Lock's v5 dies at once at 40 ms and plays as paused at 45 — so its live configs, like
Dino's, hold the inputs to that lag (`lagMs`), however fast the engine answers. Dino played live on
v7 with its own Laya (`laya distill dino --profile-version 7`; at Laya's own 23 ms it lost a game at
24 s) and paused on v4, until v10 (below) played both. Flappy Bird's v5 was trained for real time
on the simulated clock (`train --no-check --realtime --simulated --latency 45-60`) and played both clocks:
paused 38, 38, 21 (unseen seeds 38 ×3), live with its inputs ≥ 50 ms rules 38, 38, 22 and Laya
38, 38, 38. So did Super Coin Box's v4 (trained the same way): paused 109, 113, 94 (unseen 70, 128,
100) where v2 played 87, 80, 126 (74, 70, 111), its Laya 152, 115, 115 paused and 136, 125, 100 live
with its inputs ≥ 50 ms, every game to the end — where v2's Laya, not trained for real time, played
55, 40, 65 live and died early in each. Chrome Dino's v10 (trained the same way from v4) and Racer's
and Infinite Mario's v4 too: Dino paused 1485 ×3 (unseen 1485 ×3), live with its inputs ≥ 50 ms
rules 1493, 1493, 1494 and Laya 1492–1494 in 8 games of 8, every one to the end — one Laya for both
clocks. That Laya was distilled with the lag (`laya distill --lag 45-60`: half the teacher's and the
student's games simulate real time on the paused clock); distilled on the paused clock only, it
averaged 1143 live over 8 games (v7's Laya: 1287), losing games to states it had never seen. Racer:
paused 3383, 3263, 3192, live ≥ 50 ms rules 3433, 3291, 3263 and Laya 3449, 3339, 3283. Infinite
Mario's v4: every level won paused and live with the rules (1267, 1264, 1268); its Laya, distilled
with the lag too, won every level paused and with the lag simulated, but live only 2 to 4 of 6 — the
rules themselves lost levels at some fixed lags (seed 202 at 45 ms, 303 at 60), and Laya had learnt
them.

On 2026-10-01 the versions that had lost a seed at some lag were trained again with each seed played
at 45, 53 and 60 ms. Chrome Dino's v11 (v10 lost seed 303 at all three) plays as v10 did — paused and
unseen 1485 ×3, live ≥ 50 ms rules 1493 ×3 and Laya 1494, 1493, 1493 — once its Laya had two more
DAgger rounds (`laya distill --resume`; after the first two it lost seed 303 at 815). Flappy Bird's
v6 (v5 lost seed 303 at two of them) scores 38 everywhere: paused, unseen and live ≥ 50 ms with both
engines. Infinite Mario's v6 wins all nine there, paused and on unseen seeds; live ≥ 50 ms the rules
win every level and its Laya 5 games of 6 (1267, 1268 and seed 202 three times, 1264 each) — the one
it lost ended at 1.3 s, its first decisions slow (the inputs at 87 ms). Each plays both clocks with
one Laya. Super Coin Box's v5 plays better in real time (117.6 against v4's 106.7 over the nine
games; unseen 120.7) but worse paused on the training seeds (99.7 against 105.3; on the unseen ones
112, 152, 138 against v4's 70, 128, 100), so it was kept for real time only: the
live configs play v5 — rules 128, 86 (dead at 54 s), 107 and Laya 131, 102, 118 live ≥ 50 ms — and
the paused ones v4, each clock with a Laya of its own. Infinite Mario's v7 was trained with Jev
deciding (a new extractor and instructions, no rules as code): Jev wins every level with it (1267,
1264, 1268; unseen 1270, 1272, 1262), where with v6 it lost two (234, 43, 1268) — so Jev plays v7,
and the rules and Laya v6.

Real time does not replay: frame timing and the engine's time differ from run to run, so a single
game is indicative only (the Phaser Flappy: 34 once, 15 the next time; `play --lag` now simulates real time on the paused clock, the same every run). What loses is being late where the game
allows no lateness — Dino jumps only on a fresh press right after landing, Pop the Lock's click must
land while the needle is on the dot — and what fixes it is a profile trained for real time (`train
--no-check --realtime`): its extractor describes the world the action meets (`info.lagMs`) and the player
holds each input to land at that lag, so a decision time of 40–70 ms plays like a fixed one. Pop the
Lock went from dead on the first dot to 59, never missed. Dino, trained for real time with the rules
answering 35 ms late: v6 and v7 played live well and paused worse (v7, 2026-09-29: 628, 840, 815),
so v4 stayed for the paused clock; v10, trained on the simulated clock at 45–60 ms, played both, and
so does v11, trained with each seed at 45, 53 and 60 ms.

### Plans, for an engine slower than the game

(`train --no-check --realtime --latency 250-600 --plan 8x50`,
then `play --engine jev --realtime --profile-version <n>`): Jev (~300–600 ms a request) is asked for
the next 8 moments, 50 ms apart, in one request — the extractor predicts each moment — and the
player lands each input at its moment while the next request is already out. It decides *when* to
act; it cannot react to something new sooner than the engine answers. Pop the Lock, where the next
dot appears at random: Jev went from dead on the first dot to 1, 0 and 2 pops (the rules, as late:
1, 0, 6), a ceiling of a few pops at this latency. Dino, where the cacti are seen coming: Jev from
~56 to 312, 154, 208 (the rules, as late: 541, 91, 882; paused: ~1300) — playable, not good, so no
game offers Jev live yet (docs/design/realtime-plans.md).

## Teaching Laya

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
