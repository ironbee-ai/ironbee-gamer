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

## The Hugging Face library (src/hf-library/)

One model repo (`IBGAMER_HF_REPO`, default `ironbee-ai/ironbee-gamer-library`), a folder a game:
`index.json` (`HfIndex`: `format` — a reader refuses a newer one —, `updatedAt`, each game's id, name, `plays`, versions,
`files` with size and sha256), `README.md` (the model card, generated) and `games/<id>/`.

- `exportGameForHf` (export.ts): `game.json` (the merged definition with `activeVersion`: this library's state.json
  stays), `profiles/v<N>.json`, `windows/`, `samples/`, `thumbnail.png` — built-in first, the user's on top — and Laya's
  checkpoints its configs play (`checkpointFor(currentCheckpoints(…), config.version, active)` for each Laya config:
  not every round of every version, ~650 MB each). Not `decisions/`, not `state.json`. A JSON file naming a path of
  this machine is rewritten with `scrubLocalPaths` (a string that is one becomes its last part — a checkpoint's
  `base` is found by name beside it —, the home folder inside a longer one `~`); one naming none keeps its bytes (a
  tokenizer). A text file that still names the home folder stops the export. `plays`: each config with the version it
  plays, its floor live, Laya's checkpoint and its mean (Laya's student as distilled, else the version's results).
- `pushGames` (push.ts): a game at a time — exported into a temporary folder, `hf upload <repo> <folder> games/<id>
  --delete *` (what the folder no longer holds goes in the same commit: a checkpoint replaced), the folder removed —,
  then the remote index read, these games put in it (`mergeIndex`, the others kept) and uploaded with the README, last.
  `--private` unless asked (only a repo that is not there yet takes it). The CLI is `IBGAMER_HF_CLI` (`hf`).
- `fetchIndex` / `downloadFile` (client.ts): HTTPS, `<HF_ENDPOINT>/<repo>/resolve/<rev>/<path>`, a private repo with
  `HF_TOKEN` else the token file `hf auth login` writes. The index's commit (`x-repo-commit`) is what every file of a
  pull is read at. A file is written to `<dest>.part`, hashed as it comes, and renamed into place only with the index's
  size and sha256; one already there that is is not downloaded again (a pull stopped part way goes on).
- `pullGame` (pull.ts): downloads into `<userDir>/.<id>.hf-pull/` (kept when a pull stops), writes `hf.json`
  (`HfInstalled`: repo, commit, files), then `Library.importGame(staging, { replace: true })`. The game's `decisions/`
  are moved aside and back (never copied: gigabytes). `localState`: `missing`, `built-in` (no versions or checkpoints
  of the user's own), `installed` / `update` (pulled; the shared files as pulled or not), `local` (trained here:
  profiles or checkpoints not pulled) — a pull over `local` is refused (`PullConflictError`) unless `replace`.
- UI: **⇩ Hugging Face** in the library's head — a dialog of the shared games (`GET /api/hf`: the index read again a
  minute on, `?refresh=1` at once; each game with its `state` and `pull` progress), **Download** / **Update** /
  **Replace with the shared one** (a second click in the row, no browser dialog) → `POST /api/hf/pull { gameId,
  replace }` (409: being pulled, a run plays the game, or `needsReplace`), polled while one goes on; a finished pull
  broadcasts `library`. Pictures through `GET /api/hf/<id>/thumbnail` (a private repo's token stays in the server).
- CLI: `library push [games…] [--repo] [--public]`, `library pull <games…> [--repo] [--revision] [--replace]`,
  `library hf` (the shared games and each one's local state).
