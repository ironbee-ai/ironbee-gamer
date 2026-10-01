# IronBee Gamer — Project Guide

## What This Is
Plays browser games live with a fast decision engine. A per-game **profile** turns the page into a
small JSON state (`extract(raw, memory)` over a generic perception adapter's raw input), the
**decision engine** (Jev hosted, or Laya local and fine-tuned per game) picks every move, and the
**trainer** (Claude, through the Claude Code CLI) writes and keeps improving the profile from the
games it plays. The browser belongs to an IronBee DevTools daemon; the game tools run inside it as a
tool plugin. A CLI (`ibgamer`) and a local web UI with a live view (`ibgamer ui`, port 1986).

Core principle: **the state carries features, never the answer.** The trainer shapes the logic (what
the state computes) and the rules (the instructions); the engine makes every live decision. A field
that names or recommends an action is stripped before the engine sees a state (`play/guard.ts`) and
counted for the trainer. Laya learns a game by distillation: the trainer also writes the rules as
`teach(state)` (the profile's `teacher`, checked against logged decisions and by playing), the
teacher labels states, and a copy of Laya is fine-tuned on them with DAgger rounds — the teacher's
answer goes into the training TARGET, never into the state. Training a profile plays with Jev
(`--decider engine`: it tunes the rules an engine reads) or with the rules as code (`--decider rules`); Laya
then learns them by distillation.

## Reference Sections
- **Project Structure** — @docs/claude-md/project-structure.md
- **Playing** (the loop, the frozen clock, input, askWhen, pace incl. real time, the sandbox) — @docs/claude-md/playing.md
- **Library & profiles** (roots, versions, windows, decisions, import/export) — @docs/claude-md/library.md
- **Training** (setup, tuning, regression tests, novelty) — @docs/claude-md/training.md
- **Engines** (Jev, Laya, distillation) — @docs/claude-md/engines.md
- **Train: check, fix, check again** (the one button: an engine on a clock checked beside its rules, what loses fixed or a higher score trained, checked again — nobody diagnoses by hand) — @docs/claude-md/improve.md
- **The game tools** (the DevTools plugin, page-side adapters) — @docs/claude-md/devtools-plugin.md
- **Adding a game** (the wizard, the page reader, the PixiJS adapter, run progress) — @docs/claude-md/adding-games.md
- **Real-time plans for a slow engine** (the design, built 2026-09-29; read when working on them) — docs/design/realtime-plans.md

## Tech Stack
- TypeScript → CommonJS (`dist/`), Node.js ≥22; `commander` (CLI), `ws` (live view), `undici` (engine HTTP/2 pool)
- `@ironbee-ai/devtools` — the daemon that owns the browser (the installed package unless `IRONBEE_DEVTOOLS_DAEMON_SCRIPT` or `IBGAMER_DAEMON_URL` says otherwise)
- `jest` + `ts-jest`, `eslint` v9 + `@typescript-eslint`
- Python (optional, for Laya): `laya/finetune.py`, `laya/serve.py` over `pip install "laya[serve]"`

## Scripts
```
npm run build       esbuild per-file src→dist + tsc --emitDeclarationOnly + the plugin bundle (dist/devtools-plugin/game-tools.mjs) + the UI's static files
npm run lint        eslint .
npm test            jest (unit); IBGAMER_E2E=1 npx jest tests/integration also runs the plugin in a real daemon (build first)
```

---

## Rules for Claude

### Code Style
- **Always** add explicit type annotations on every constant, variable, function parameter, and return type (arrow functions assigned to a `const` included).
- **Always** use curly braces for `if/else/for/while`. 4-space indentation, double quotes, semicolons. Private members without an underscore prefix.
- Prefer `enum` over string-literal unions for closed sets (`Perception`, `DecideOn`, `EngineKind`, `Pace`, …).
- Page-side scripts (`src/devtools-plugin/page/`) are handed to Playwright as functions: self-contained, no imports, no module-level references.
- ESLint covers `src/`; run `npm run lint` before considering a task done.

### Invariants (tests pin them)
- The division of labor: no advice field reaches the engine (`guardState`); the score expression is read for measuring only and never becomes a state field.
- Profile scripts (extractor, askWhen, test expects) run only in `play/sandbox.ts`: their own V8 context, no Node globals, no code from strings, a time limit, JSON across the boundary.
- The built-in library is never written to; training writes new versions to the user library, numbered after every existing one. A version is saved only when it beat the best on the same seeds and passed every regression test.
- The trainer's CLI runs with `childEnv()` (none of this process's keys) and Read allowed for its work directory only.
- A teacher never enters a state. It labels training data, and plays a watched game only when chosen as the engine ("Rules (code)", `EngineKind.RULES`: the chosen version's own `teach`). A Laya checkpoint plays the profile version whose states it learnt (`laya/v<N>-<hash>-r<k>`).
- Every episode is a fresh page load; the session's first frozen game installs the clock paused at the game epoch, each later frozen game pauses it again before its load, and only an unfrozen game resumes it.

### Workflow
- After editing TypeScript, run `npm run lint && npm test && npm run build`.
- After changing the plugin or the player, run the live suite: `npm run build && IBGAMER_E2E=1 npx jest tests/integration`.
- `library/` is data: validate a changed game or profile with `ibgamer library show <game>`.

### Git
- **NEVER commit.** Stop after making and verifying the edits and suggest a conventional-commit message.

### Testing
- Layout mirrors `src/`: `tests/unit/<area>/`, `tests/integration/`, shared fakes in `tests/helpers/` (`FakeGame` — a runner game behind the browser interface —, `FakeEngine`).

### CLAUDE.md maintenance
- Keep this file short; detail lives in `docs/claude-md/*.md`. Update the relevant fragment in the same change.
