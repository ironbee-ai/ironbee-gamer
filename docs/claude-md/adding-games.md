# Adding a game, and following its training (the UI)

## The guided flow (src/server/ui/, src/server/ui-server.ts)

**+ Add game** opens a four-step dialog; nothing is saved before the last step.

1. **Page**: the URL is opened and looked at (`POST /api/probe`: `game_open` with the probe adapter
   and the clock running, `game_probe`, a screenshot kept in `<runs>/probes/` and served at
   `/api/probes/<file>.png`). The verdict names what draws the game and how it will be read, from
   the probe's `suggested` adapter — decided by the LARGEST canvas (a small 2D frame-rate panel
   beside a WebGL game is not a 2D game):
   - a 2D canvas → `canvas2d` (the draw recorder);
   - Phaser → the Phaser dump; PixiJS (the `PIXI` global) → the PixiJS dump; Cocos (`cc.director`) → the Cocos dump;
   - any other canvas (WebGL from an engine without an adapter, a bundled engine) → `pixels`
     (below), with the page reader (below) offered as the sharper way — it is offered for every game.
2. **Start**: it starts by itself, a key, or a click — picked on the screenshot, stored as
   fractions of the box the game's clicks land on: the largest canvas (saved as `clickTarget`, the
   probe's selector for it, when it is not the first canvas — `game_step` clicks the first by
   default), else the page body. A page with neither (no canvas, a body without a size: what it
   shows is placed out of its flow) takes no start click — no element's box is the picture's. The
   loading time (0–20 s) becomes a `waitMs` before it (validate.ts takes 20 s at most: `game_step`
   waits 30 s, and a real-time play adds the step's advance). The game is saved with the boot the page
   was looked at with (`bootMs: 4000`, `PROBE_BOOT_MS` in page-reader.ts: the probe's picture, and the
   reader's check below), so its start is pressed in play no sooner than the moment it was picked or
   checked at — with the default boot (2.5 s) it was pressed about a second before. A start the page
   reader found is saved as it found it, every step, unless another is chosen here. The key list sits in
   its choice's label, whose control is the radio, and the radios are what is saved: picking a key, or
   opening the list (a click, Space, the arrows, Alt+Down), checks "Press a key" — tabbing past it does
   not, nor Enter on it: Enter there is Next, as in any field, on every platform (the list takes the key
   itself: Chromium submits the form on Enter on a closed list on macOS only, and opens the list elsewhere).
3. **Game**: name, id, how to play (the game's own words; the trainer starts from them), the score:
   from what the trainer perceives (`fromState`) or a page expression (writing one in its field chooses
   it; chosen, it must be written: an empty one is refused, not saved as `fromState`; written while the
   trainer's reading is chosen, it is refused too — it would be left out); its label; seconds per game
   (whole, 5–600).
4. **Engine**: Laya (the rules as code, then distillation), Jev, or Rules (code) — the rules as code
   play themselves, nothing to distill —, saved as `preferredEngine`. Laya is shown ready, and chosen
   first, by its Python (the status's `engines.laya.python`: a new game needs no checkpoint yet). The
   first training can start at once (with the rules deciding when Laya or Rules is chosen; with Jev, only
   while the status says Jev is ready — Jev decides its every move; any training only while the trainer's
   CLI is there. The Train buttons follow the same rules, and the server refuses such a training with a
   400 naming what Jev or the trainer lacks, before anything runs; `ibgamer train` refuses one without the
   trainer's CLI too, by the same check (`trainerHealth`), before Jev is asked or its daemon starts).
   **…for real time** (the wizard's box, and **For real time** beside Train): a game that does not wait for
   the player is trained as Laya plays live (docs/claude-md/training.md: the rules 45–60 ms late, simulated,
   every seed at 45, 53 and 60 ms) — no lag to pick; not for Jev (hundreds of ms: the server refuses it).

Each step checks what it holds before Next (Add, on the last): a number out of its field's range says
which field and why, and Next waits. The form is not validated by the browser (`novalidate`): a value it
refuses in a step already left stops "Add the game" with nothing said but a line in the console.

What was found is for the address it was looked at with: a new look, another address or the dialog
opened again drops the probe, the reader (a reader still being written is no longer waited for) and
the start picked on the old picture; Next waits for the new look. The reader may answer while a later
step is open: its start and score expression go only where nothing was chosen in this dialog — a start
or a score chosen here, before it answered too, is kept — and a note says what it filled in or left.
Enter in a field is Next until the last step.

Saving (`POST /api/games`) refuses (409) an id the library has, and one whose user folder a removed
game left behind (profiles, checkpoints, decisions — the new game would take them over): remove it
first (`ibgamer library remove <id>`) or choose another id. A definition the library refuses is a 400
naming the field.

**A game that moves things with CSS** (`animationClock: true` in game.json): its CSS animations and
transitions are held and run on game time with the clock (docs/claude-md/devtools-plugin.md) — without
it they run in real time while the game waits for a decision. Flappy Bird (floppybird's pipes) needs it.

**How it is played** (`configs`, `preferredConfig` in game.json; `src/game/configs.ts`): the engine and
clock pairs the game is offered with (`live: true` = the clock never pauses; `version` when a pair needs a
particular profile, e.g. a plan-mode one for Jev in real time, or a version trained for real time — Laya
then plays that version's own checkpoint; `lagMs` on a live pair: a lag-aware version's inputs land no
sooner than that, the lag it was trained at) and the one the UI opens it with. Written from
measurements — a live pair from games played live for real, not from `play --lag` alone — by hand or by
whoever measured (the built-in games). **A game that lists none** — one added here — is offered what its
versions earn (`playConfigs`; the game detail's `configs` and `live`): every engine with the clock paused,
and live Laya and the rules on the newest version trained for real time whose real-time score (as training
measured it) is at least 80 % of its paused one (`LIVE_SHARE`), that version pinned and its inputs held to
the lag it was measured at; never Jev live. Until one is, the live clock is greyed out saying why, and the
setup checklist offers **Train for real time**. The UI greys out every other engine and clock, and `parsePlayRequest` refuses them
(the CLI does not: it is for trying, though it plays a listed pair's `version` unless `--profile-version`
names another, and its `lagMs`). An engine is judged per clock, as the server takes a play: Laya with its
Python ready and a checkpoint a play can take of the version that clock plays (the pair's `version`, else
the one its checkpoint learnt), the rules with that version's rules as code — Laya not by the status's
`engines.laya.ok`, which is any game's. A clock the engine chosen cannot play with is greyed out too, its
title saying why (no checkpoint, or no rules as code, in the version it pins), and the clock chosen moves
to one it can; an engine is offered while some clock can play, else greyed out with the reasons beside it.
The Engine select keeps the engine WANTED apart from the one it shows: a game opens wanting its own
(`preferredConfig`, else `preferredEngine`, else the engine last wanted there — picked, or wanted by a game
played or trained: Play and Train keep the one wanted, never a fallback shown), a pick in the select
replaces it, and whenever the select is drawn again — a game opened, a run ended, the library changed, the
status read — it shows the wanted engine as soon as that one can play the game (a training wrote the rules
as code, a distillation made its checkpoint). Until then, for Play only, Laya or the rules wanted gives way
to the rules (code) when they can — what the checklist says it plays with — before hosted Jev; any other
to the first engine that can. The option shown picked again sends no change, and macOS's list sends nothing
once it is open: the list used — pressed with the pointer, or a key other than Tab, Escape, Enter (Play on
macOS), a modifier or a Ctrl/Cmd shortcut — picks the engine it shows, even when it is closed again
unchanged (the two are not told apart), as the wizard's key list does. The status is read again when a run
ends, not only every 30 s; Laya's server is started ahead of Play (`POST /api/laya/warm`) only for a clock
it can play. With every engine greyed out, Play is disabled, its title saying why; a play request with an
empty engine (the UI's, when it had none to offer) is refused (400) as none being ready, one naming an
unknown engine with the kinds there are, and one without `engine` plays the server's default
(`IBGAMER_ENGINE`). `preferredEngine` stays what the game is trained for (the setup checklist and both
Train buttons); a game without one is trained for the engine wanted — its `preferredConfig`'s, or the one
picked —, never for a fallback the select shows, else for the server's default; while the select shows
another, Train's title and the checklist name it. Enter in a field of the play form is Play, but in Train
iterations — Train's field — it is Train (nothing while Train is disabled, as a disabled Play takes no
Enter).

A game's page shows its **setup checklist**: added (how it is read) → rules trained (version,
score) → Laya taught (when Laya is the engine it is trained for, or it has a checkpoint) → playable —
each open step with its button, a running step with its stage, bar and time left. Playable with Jev or
Laya, and with its rules (code), by the Engine select's own test: some clock offered with it can play (Jev's
key; Laya's Python and a checkpoint of the version that clock plays; that version's rules as code); else
with its rules (code) now, if they can, and why the engine is not beside it. Distill — its button and the
checklist's — is offered only while Laya's Python is ready and, for an active version without its rules
as code (the trainer writes them first), the trainer's CLI is there; else why, beside it. The server
refuses such a distillation before a run begins — a 400 naming what is missing, a 409 while a
distillation in another process holds Laya's port —, and `ibgamer laya distill` before its daemon starts
(Laya's Python first, then the trainer). A distillation stopped is recorded as stopped, as a play or a
training is, not as failed.

## The page reader (src/reader/page-reader.ts)

For a game no adapter reads, and often sharper than a dump for one that is: the trainer writes
ONE page expression returning the game's own state. `PageReaderWriter.write({ url, workDir,
viewport? })` — in the UI "Let the trainer read the game's code" (`POST /api/reader`, polled at
`GET /api/reader/:id`, on a daemon of its own):

- **look**: probe + screenshot, the clock running;
- **collect**: the page's scripts (tags and loaded resources, at most 25) into
  `scripts/NN-name.js` — a build over 600,000 characters is an engine: named in `page.json`, not
  copied, and its download stops at 1.8 MB (600,000 characters of UTF-8 at most) —, inline scripts
  into `inline-N.js`, and the globals the page's own code added. The scripts are downloaded by this
  process, whatever the page lists: from the page's own origin (the address the game was added with:
  a game served on this machine reads its own scripts), else only from a public address — `localhost`
  names and loopback, private, shared, link-local (the cloud metadata services), unique-local and
  unspecified addresses are refused, IPv4 and IPv6, IPv4-mapped and inside NAT64 / 6to4 too
  (`scriptRefusal`, `isPublicAddress`). A name is checked when it is connected to (`publicOnlyLookup`:
  the address checked is the one connected to), and a redirect is followed by hand, each hop checked;
  what was left out is named in `page.json`;
- **the trainer** (Read in its work dir only) replies `{ read, format, score?, start?, notes? }`;
- **check**, as the added game will be played: the clock frozen (on a Phaser page with the Phaser
  adapter, whose `window.__ibgamer.phaser.game()` hands over the running game), the boot it is saved
  with (`PROBE_BOOT_MS`; in play the wizard's loading step follows it, so the start comes no sooner
  there), the proposed start sent as the player sends a start (`inputSteps`: a
  `holdFrom` step's keys let go by the next step, or after the last) — its clicks on what the added
  game's will land on, by the wizard's rule (`clickTargetFor`, the twin of app.js's `clickTargetOf`:
  the largest canvas, else the body) —, then 6 steps
  of 500 ms — each reading a plain JSON object, no throw, under 20,000 characters, and each score
  reading `{ over: <boolean>, score: <number> }` (a bare number or null reads 0, never over); one
  repair round with what failed.

The proposal becomes `perception: { adapter, read, format }` — `phaser` on a Phaser page (its
game-instance helper stays installed), else `custom` — and, when given, the score expression and the
start.

## WebGL without a reader: the PixiJS adapter (src/devtools-plugin/page/pixi.ts)

v4–v8, installed before the page's scripts: an accessor catches `window.PIXI` when the build
assigns it, `render` is wrapped on the renderer classes to keep the root each frame draws, and the
dump lists what is drawn: `{ type, tex?, x, y, w?, h?, a?, fill?, tint?, alpha?, text?, name? }`
(graphics by their bounds and fill colour — what tells a brick from the paddle). Before a first
render (a menu waiting for a key) the root is the biggest parentless Container a page global holds.
It needs the `PIXI` global: a bundled PixiJS is read by the page reader.

## Anything a canvas shows: pixel perception (src/devtools-plugin/page/pixels.ts)

`perception: { adapter: "pixels", grid?: { width, height? } }` (8–160 cells across, default 64; down
by the canvas's aspect unless given): each read copies the page's largest canvas at its own size and
averages it down on the CPU (each cell the whole-number mean of the pixels it covers; the browser's
smoothed scaling, used before, depends on the GPU) into `{ w, h, box, px }` — `px` row-major, 3 hex digits a cell (4 bits a channel,
`"f80"`), `box` the canvas on the page; null without a canvas or when the page may not read it back
(a cross-origin image drawn without CORS). WebGL contexts are made with `preserveDrawingBuffer:
true` (merged into the page's attributes), or a read between two steps — the clock frozen — would
find the buffer already cleared. It knows no objects: the trainer's extractor finds them by colour,
from the screenshots and the setup summary (grid size and the most frequent colours). Less exact
than a dump or a reader. Checked live on a Cocos 3D (WebGL) demo: a 48×32 grid of 79 colours, the lit
island where the screenshot has it, not a cleared buffer. Trained on Flappy Bird read by its pixels
only (a user-library copy, `flappy-pixels`, retired on 2026-09-29 with the Phaser Flappy): the trainer wrote the extractor from the colour grid,
v1 → v3 went 7 → 27.7 walls, and Laya learnt v3 exactly (34, 34, 8 on the profile's seeds, the same
as its rules; 26 ms) — against 34 ×3 for the same game read through Phaser. Measured with `ibgamer
check` (2026-09-29): one play after the other, every frame is the same; two WebGL pages playing at
once differ from the first frame by a quantisation step in a cell or so (`raw.px[5050]: …767654… ≠
…767554…`), the CPU averaging kept — the pages render a frame a hair apart, and the plays still end
the same (14 and 14); a 2D-canvas game (Pac-Man) is the same both ways. Earlier the trainer's parallel
evaluation gave v3 15, 34, 34 and the distiller's sequential one 34, 34, 8, which such a step can
explain when a colour threshold sits on it.

## The Cocos adapter (src/devtools-plugin/page/cocos.ts)

Cocos Creator 2.x / 3.x and cocos2d-js: when a dump is asked for, the scene `cc.director` runs is
walked (inactive, invisible and fully transparent nodes skipped) and every node that draws — a
Sprite, Label or Graphics component; in cocos2d-js the node itself — is listed: `{ type, name?,
tex?, x, y, w?, h?, a?, tint?, alpha?, text? }`. Cocos puts the origin at the bottom left with y up;
the dump turns it to the top left, y down, in the game's design pixels (`cc.view`'s visible size),
and `a` to degrees clockwise, so it reads like the other dumps. Positions come from the engine
(3.x `worldPosition` / `worldScale` and the UITransform's size; 2.x and cocos2d-js
`convertToWorldSpaceAR`, scales multiplied down the tree). A 3D scene's nodes are world units, not
screen pixels, and 3D meshes are not listed at all (pixel perception reads a 3D scene). Checked
live on Creator 1.9, 2.0 and 3.4 builds: a background, a tinted dialog box and its label's text; on
3.4 (a 1920×1280 design shown at 960×640) a title, two buttons and three sprites exactly where the
screenshot has them at that scale.

## Run progress (src/run/progress.ts)

`ProgressTracker(kind, { iterations?, rounds?, setup? })` reads a run's phases and log lines —
the trainer and the distiller know nothing of it — into `RunProgress { stages: [{ label, state:
done | current | todo | skipped, detail? }], fraction?, overall, eta?, results }`, kept on the
`RunRecord` and broadcast as `{ type: "progress", id, progress }`.

- distill: the teacher plays → Laya learns → per DAgger round: Laya plays, the teacher corrects →
  Laya learns from it → Laya plays the test games. The time left is `finetune.py`'s own `ETA`.
- train: [setup] → measuring → iteration i/N; the time left from the finished iterations' average.

A log line reworded in the distiller or `finetune.py` loses its stage detail: the tests pin them.
