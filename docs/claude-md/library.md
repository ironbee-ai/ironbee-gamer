# Library & profiles (src/library/store.ts)

Two roots, one view: `builtInDir` (the package's `library/`, never written) and `userDir`
(`~/.ibgamer/library`). The user root wins where both have a file.

- `game(id)`: the user's `game.json` if any (an edited built-in game), else the built-in one. Validated.
- Versions: `profiles/v<N>.json` of both roots; a user version number shadows the built-in one.
  `saveProfile` numbers after every existing version and makes it active; `state.json` (user root)
  holds the active version (default: the version game.json names, `activeVersion`, when the library holds it —
  a game whose newest version is another engine's, Infinite Mario's v7 being Jev's; else the newest not kept for
  real time only — a live-only version saved without activation never becomes active by being the newest, as
  in a fresh library). `activeVersion` alone is read from game.json there, not the whole game validated: it is
  asked on every listing. A profile's `results` are validated too (the UI shows
  them, measuring and distilling replay them): `mean` and `gameSeconds` numbers, `scores` a list of
  numbers, `seeds?` non-negative whole numbers, `measuredAt` text, and the optional `realtime` / `test` /
  `random` the same way (`test.seeds` required; `realtime.lagMs` a number, `realtime.lagPoints` whole ms —
  the lags a seed was played at, its score there the mean of those games); other fields are kept as they are.
  The summary `profiles(id)` gives says `hasTeacher`, `lagAware` and `liveOnly` (a version training kept for
  real time only: never made active): a game with no `configs` of its own is offered live on the newest version
  trained for real time that kept its score there — a live-only one measured against the active version's
  paused score (src/game/configs.ts).
- `windows/<id>.json`: `{ id, seed?, profileVersion, rawFrames, lagMs?, frameInfo? }` — replayed by regression tests;
  `frameInfo[i]` is what the extractor was told with frame i (lag, game time, a plan's moments), `unread: true` on a
  frame the page could not be read on (the extractor never saw it; a replay skips it).
- `samples/`: `raw-sample.json`, `sprites/*.png`, `setup.json`, `screenshot.png` — what setup saw; the tuner reads them.
- `decisions/v<N>-<hash>.jsonl`: `DecisionLog` rows (state, criteria, instructions, choice, probabilities,
  confidence, ms, engine, profileVersion, and the game's `seed`; `lag` when the decision acted late, real time
  or simulated) — per profile content, so rows of two extractors never mix.
- `laya/<name>/`: fine-tuned Laya checkpoints.
- `thumbnail.png`: the UI card (the first end screen of a UI run when none exists).
- Paths are checked (`SAFE_NAME`, `SAFE_REL_PATH`): no separators beyond a few plain levels, no `..`;
  `file()` never returns a file a symbolic link takes out of the game's folder.
- `importGame(dir)` validates `game.json` and every profile, copies only safe names and no symbolic
  links, into a folder beside the game's that is renamed into place once copied (a failed copy leaves
  the library as it was). The game's own user folder — or a folder holding it or inside it — is
  refused: replacing it would delete the source. `exportGame(id, dir)` writes the merged view
  (built-in first, user on top, without `state.json`).
- `hasUserPart(id)`: the user root has a folder for the id. A new game (the UI's **+ Add game**) is
  refused while one is left from a removed game — it would take over its profiles and checkpoints.

Dino's first versions (v1–v3) were converted from the research runs (`research/game-lab/tune/runs*`):
every accepted tuning version with its analysis and results, and the continual-training version with its
five regression tests and their three windows. The later versions, and the other games, were trained by
this app (`ibgamer train`) and moved into `library/` with their windows and samples.
