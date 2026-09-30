# Real-time play with a slow engine: plans of several slots

Status: designed 2026-09-28, built 2026-09-29 (`src/play/plan.ts`, the player's plan loop, `train
--plan`, `play --plan-every`; how it plays: docs/claude-md/playing.md). E3 (live) results at the end.

## The problem, in numbers

With the clock never paused (`Pace.REALTIME`), a decision acts `lagMs` after the frame it was made
on. The extractor already gets `info.lagMs` and describes the world the action meets — enough for
Laya (~25–45 ms): trained that way, Pop the Lock's rules went from 1.3 to 58.7 in real time with a
40 ms lag, the same as with the clock paused.

Jev answers in ~300 ms (measured 2026-09-28: one question 319–474 ms, six questions in one request
285–414 ms — the cost is the round trip, not the number of questions). One decision per 300 ms is
too coarse for games that need an action every 50–100 ms, and a single decision cannot say *when*
inside those 300 ms to act.

## The idea

Ask once for a **plan**: one decision for each of the next N slots of `slotMs` (e.g. 8 × 50 ms),
the slots starting where the answer will land. Ask again as soon as an answer arrives, so one
request is always in flight and the plans follow each other without a gap.

Prior art, same shape:
- **Action chunking** (robot policies, e.g. ACT): a policy outputs the next k actions at once and
  they are executed open-loop until the next chunk.
- **Real-Time Chunking** (Black et al., 2025, arXiv:2506.07339): the next chunk is computed while
  the current one executes; the actions that will run during the inference delay are *frozen* and
  the new chunk is made consistent with them. No loss up to >300 ms of delay in their benchmarks.
- **Client-side prediction** in networked games: the client applies its own pending inputs to the
  last authoritative state to predict where it is now.
- **Model predictive control**: plan over a horizon, execute the start, re-plan.

## Division of labour (unchanged)

- **The extractor predicts** (code, written by the trainer): per slot, the features as they will be
  at that slot's time — given the actions already scheduled — because an engine that reads rules is
  weak at arithmetic and physics.
- **The engine chooses** by the rules, one choice per slot; it sees all slots in one request and
  keeps its own plan consistent (in the measurement it jumped once and did not jump again the next
  slot, although the rule alone said so).
- **The state carries features, never the answer**: per-slot predictions are features.
- **Nothing is game-specific in code**: the player, the protocol, the prompts and the trainer are
  generic; what a game's future looks like lives in its profile's extractor.

## Design

### Profile
`plan?: { slots: number; slotMs: number }` — off by default (every current profile plays as today).

### What the extractor is told
`extract(raw, memory, info)` gains, in plan mode:
- `info.slots: number[]` — for each slot, how many ms from this frame its action would take effect
  (`lag + k × slotMs`);
- `info.pending: Array<{ inMs: number; action: string }>` — actions already scheduled by the plan
  being executed that have not taken effect yet (the frozen prefix). The extractor applies them
  before predicting the slots: "I will have jumped by then".

It returns the state with `slots: [{ …features at slot k… }]` beside the current features. With no
plan (`info.slots` absent) nothing changes.

### What the engine is asked
N questions in one request, `slot1 … slotN`, the same actions as criteria; each question's
instructions are the profile's rules plus "decide for slot k from `game.slots[k-1]`; your answers
for earlier slots are yours — keep them consistent". One round trip. The rules teacher answers the
same questions (`teach(state, slot, earlier)`), so a plan-mode profile can still be trained with
the rules deciding, distilled, and compared.

### The player (REALTIME only)
1. Observe at `t0`; extract with `info.slots` (starting after the expected lag: the recent p75 of the
   engine's latency) and `info.pending`; send the request; do not wait for it.
2. When the answer arrives, turn slot k into an action at `t0 + lag + k·slotMs` (times from the
   observation, not from the arrival); drop slots already past; apply each on time (a step with no
   game time, as REALTIME steps are).
3. Right after an answer arrives, observe again and send the next request with the not-yet-applied
   actions as `info.pending` and the slots starting where the current plan ends.
4. A late answer (a latency spike): the plan's last action holds, or the profile's first action
   (the idle one). In REALTIME the engine gets one attempt with a timeout, not the usual retries —
   a retry arrives too late to matter.

### Training
`ibgamer train <game> --realtime --plan 8x50 [--latency 300 with --decider rules]`: the tuner sees
real-time failures and the plans that led to them, and writes the per-slot predictions. As for
`--realtime` today, a version is kept only if it also plays as well with the clock paused.

## Experiments (after the current runs finish)

- **E1 — can the future be predicted?** Offline, no engine: replay recorded real-time frames, compare
  each slot's predicted features with what the frame at that time actually showed; error by horizon
  (100…600 ms) for a scrolling game (Dino), a rotating one (Pop the Lock), a physics one (Flappy).
- **E2 — does Jev plan well?** Offline: send recorded states with slot predictions to Jev; compare
  its slot choices with the rules applied to the true future states; consistency across slots.
- **E3 — live:** Jev plans in real time, one game at a time, the slowest dynamics first (Pop the
  Lock), against the same seeds with the clock paused.

## First results (2026-09-28, pre-versions of E1 and E2)

Recorded: the rules playing Dino (40 s, 30 ms steps), Pop the Lock and Flappy (30 s, 48 ms steps)
with the clock paused.

**E1, a generic extrapolation** (every numeric field carried forward at its current velocity;
categorical fields left as they were):

| Game | numeric fields within 5 % of their range at 100 / 300 / 600 ms | objects appear or vanish (300 ms) | the rules on the predicted future decide the action |
|---|---|---|---|
| Pop the Lock | 86 / 72 / 60 % | 0 % | tap 0–2 of 32 |
| Dino | 69 / 53 / 41 % | 43 % | JUMP 0 of 28 |
| Flappy | 84 / 49 / 32 % | 1 % | flap 0–9 of 56 |

The numbers are partly predictable, the decisions not at all: what decides is derived and
categorical ("timing ok", "in the window") and must be recomputed from the game's own motion,
our own pending actions included. The prediction is the extractor's job, written per game by the
trainer — no generic extrapolator can do it.

**E2, Jev with the true future** in the slots (8 slots of 50 ms from 300 ms ahead, one request):

| Game | plans | agrees with the rules on the true future (balanced) | Jev, 8 questions |
|---|---|---|---|
| Flappy | 12 | 100 % (wait 89/89, flap 7/7) | 289 ms median, 328 max |
| Pop the Lock | 12 | 99 % (wait 92/93, tap 3/3) | 352 ms median, 647 max |
| Dino | 16 | 88 % (NOOP 110/114, JUMP 6/9, DUCK 5/5) | 294 ms median, 388 max |

Given the future, Jev plans well and consistently; Dino's misses look like the same jump one slot
early or late, where 50 ms matters. Eight questions cost what one does. A 647 ms spike was seen:
plans must cover ~700 ms, or fall back safely when an answer is late.

## Why one decision per round trip is not enough (measured 2026-09-28)

Pop the Lock v5 (trained for real time at Laya's ~45 ms lag) played with Jev in real time: dead at
the first dot on both seeds (lag 367–405 ms). Trained for Jev's range (`--realtime --latency
250-600`, the rules answering 430–465 ms late), two tuner iterations still scored 0, 0, 0, and the
tuner said why: at ~460 ms the bar turns ~82° per decision, so a tap can land only near 10° (decided
on the first frame) or at 92° and beyond (decided on the next) — the dots sat at 48° and 63°, and "no
profile could have popped those dots". A perfect prediction does not help when the moments an action
can land are that far apart. A plan does: one request chooses the slot (50 ms apart) the tap lands in.

## Risks, open questions

- **Horizon 300–600 ms:** fine where the future is visible and follows known motion; weak where
  things appear near the player within the horizon, or opponents react.
- **Our own actions change the numbers** (a tap reverses a needle, a flap bends a trajectory): the
  extractor must apply `info.pending` and, for the slots after a planned action inside the same
  plan, either predict with it (the engine's choices for earlier slots are not known yet — hence
  "one action per plan" as the simple first version) or leave the rest of the plan to the next one.
- **Latency spikes:** Jev's tail (475 ms seen on a cold call) — the lag estimate takes a high
  percentile, and plans carry a margin of spare slots.
- **Request size:** N slot objects in the state; keep each slot to a few fields.
- **Jev's consistency across slots:** measured once (jumped at one slot only); E2 measures it.

## Implementation plan (~3 h, then ~1 h of training per game)

1. Types + validation: `plan` on the profile; `ExtractInfo.slots` / `pending`.
2. Player: the plan scheduler (pipelined requests, timed actions, fallbacks) behind `plan` + REALTIME.
3. Engines: N questions per request; the rules teacher answers per slot.
4. Trainer: `--plan`; prompts describe `info.slots` / `info.pending` and the per-slot state.
5. Tests: scheduler timing with a fake slow engine and the real-time fake game; pending actions
   reach the extractor; a late answer falls back; teacher per-slot answers.

## Built (2026-09-29): what changed from the design

- **One change per plan.** A plan's moments are predicted without its own inputs, so a plan plays its
  first moment that changes something and, if that pressed keys, their release back to where it began
  (`planInputs`); the next plan, told of them as pending, decides the rest. The rules (per-moment
  `teach`) would otherwise tap twice on a prediction that no longer holds.
- **The frame's game time** (`info.nowMs`) for every extractor: with the clock running, frames are not
  evenly spaced, and a speed measured per frame was 5× off at 460 ms between frames (the tuner saw it).
- **Looks between answers**: the page is read every 100 ms (the game's end, the budget, the extractor's
  speeds), not only on request frames.
- **Several requests in flight** (`play --plan-every <ms>`), a plan from a newer frame replacing an
  older one's: what appears is reacted to sooner, for more requests.
- **Replays**: a failure window keeps what each frame's extractor was told (`frameInfo`).

## E3 — live (2026-09-29)

**Pop the Lock** (v6, trained with the rules answering 250–600 ms late; seeds 101, 202, 303):

| | 101 | 202 | 303 |
|---|---|---|---|
| before plans (v5, one decision per answer), Jev | 0 | 0 | 0 |
| plans, the rules 250–600 ms late (training) | 1 | 0 | 6 |
| plans, Jev (357–492 ms a request) | 1 | 0 | 2 |
| plans, Jev, a request every 120 ms (381–552 ms) | 1 | 0 | 2 |

Plans work — no game ended on a bad tap, every dot that could be reached was popped (the tuner's
reading of the training games) — but Pop the Lock has a ceiling at this latency that no planning lifts:
after a pop the next dot is placed at random, at least 40° from the last, and the bar turns 180°/s. The
dot is known only to a request made after it appears: that request goes out when the one in flight
comes back (0 to ~450 ms) and its plan starts ~450 ms after its frame, so a dot closer than ~120–160°
(on average) is passed before any tap can land — about a quarter to two fifths of them. Seed 202's first
dot is reached 255 ms after the start. Expected: a few pops a game with a ~450 ms engine, against 59
with Laya at ~45 ms. More requests in flight shorten the wait for the next request but slowed Jev down
here (552 ms median). Plans solve *when* to act; they cannot react to something new faster than the
engine answers.

**Chrome Dino** (v8, trained from v7 with the rules answering 250–600 ms late; seeds 101, 202, 303):

| | 101 | 202 | 303 | mean |
|---|---|---|---|---|
| before plans (v7, the rules ~440 ms late) | 58 | 55 | 56 | 56 |
| plans, the rules 250–600 ms late (training) | 541 | 91 | 882 | 505 |
| plans, Jev (322–352 ms a request) | 312 | 154 | 208 | 225 |
| plans, Jev, a request every 120 ms | 264 | 125 | 218 | 202 |
| the clock paused (v8) | 866 | 1485 | 1485 | 1279 |

Plans make Dino playable live at a hosted engine's latency — 4× Jev's score before them, dying at
10–25 s instead of on the first cactus — but far from the paused game. Here the future is visible
(cacti come from the right edge, 0.7–1.5 s away), so no reaction ceiling caps it as in Pop the Lock;
what costs is precision: the rules at the same latency score twice what Jev does, Jev's moments being
off by a slot now and then (E2: 6 of 9 jumps in the right slot), and 50 ms matters for a jump. A
second training round did not beat v8 (499). More requests in flight did not help either.

**Decision (2026-09-29):** plans are kept as a mechanism; no other game is trained for them, and no
game offers Jev live (`configs`) until one plays well. Fast games play live with Laya or the rules.

