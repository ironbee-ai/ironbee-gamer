# The game tools (src/devtools-plugin/)

An IronBee DevTools tool plugin (plugin API v1): `index.ts` returns browser tools; DevTools hands it
zod (`api.ts`), and the session context (page, `pageState()`, `sessionState()`). Built into ONE ESM
file, not minified (the page-side functions are sent as source).

| Tool | What it does |
|---|---|
| `game_open` | http(s) URLs only (below); release held keys and the pointer; the page's time zone UTC (see "The time zone"); frozen, the session's first open installs the clock first (a `pauseAt` at the game epoch on an empty page, no `install()`: see "Replaying under load") — a document runs its init scripts in the order they were added, and the timer nudge and the log replay act on the clock; add the adapters' init scripts once per page; remove the game before's own (Playwright's init-script Disposables: none of them runs in a document of this game); set the viewport. Frozen (default): `pauseAt(now + 200)` after the page scripts, then load an empty `data:` page with the clock stopped and leave the clock exactly on one of its animation frames (`_onFrame`: a rAF records `performance.now()`, `runFor` to the next frame, measured again because a clock that ran in real time sits between milliseconds); close the windows the game before opened (see "Windows a game opens") and clear the origins (the game's, those the page is on, and every one the game before and its windows went through) and, in the session's own context, every cookie (see "Clean origins"); `setSystemTime(2026-01-01)`; add the game's own init scripts, in this order: its session storage clearing (`page/storage.ts`, with this open's token: see "Session storage"), its `initScripts`, its seed — after the clock's log up to the load, so a script that reads the clock as a document starts reads the moment the page loads at, in every game of a session (see "Replaying under load") — and kept for the whole game (the load, the boot, play); `pauseAt(2026-01-01)`, which moves nothing: the piece of the log a later document replays after them starts with a pause; `goto` — every game, first of a session or not, loads from that same footing; boot `bootMs` of GAME time frame by frame (`runFor(16)`), waiting between frames (real time, at most 2 s, a request or job open > 5 s ignored — but one still receiving data within 5 s is waited for however long it has been open, 60 s at most a boot: a big file over a slow host came after the boot, and the start was pressed on the loading screen) until the page's requests and its work off its thread (`page/decodes.ts`: decoding, WebAssembly compiles, IndexedDB) are done and a turn of its event loop finds them as it left them (a load callback that asks for the next file is waited for too; a turn that moved it with nothing open gets 20 ms for what it started to show); `_onFrame` again; `phaser.settle()` drops the engine's frame carry-over (v2 `_deltaTime`, v3 `loop.resetDelta()`). So a seed replays frame for frame, whatever the network did. A seeded open installs the Phaser adapter whatever the perception (it acts only where Phaser runs): read by its pixels, a Phaser game otherwise sowed its RNG from the time and drew other walls on every load. An error the page's own code throws as it boots is reported (`pageError`), not thrown (below). `freezeClock: false`: resume, the empty page, close the windows and clear (as frozen), the game's own scripts (as frozen), `goto`, boot in real time (the page before is gone before the clearing, as frozen, and the same URL with a `#fragment` is loaded again, not scrolled to): the boot's `bootMs` counts once the page's requests and its work off its thread are done, and that wait again after it (real time, 60 s at most in all; a request or job open > 15 s with no data coming is let go — a long poll, a stream held open —, one still receiving data within 5 s, `Network.dataReceived` on a CDP session of its own, is waited for however long: a cold load brought a 1.8 MB sound over 11–25 s) — until 2026-10-03 it was `bootMs` of wall time, and a page still loading after its load event (nothing cached: a session's first game) had its start pressed on its loading screen and played its whole game on its menu |
| `game_step` | `hold` (held set; others released), `press`, `holdFrom` (a page expression naming keys held from now on, as `hold`, beside `hold`'s — a key, a list, or nothing; one that throws names none; at most 8; held, not pressed, so a game that polls its keys on its own tick sees them), `click` (the click target's centre or a point as fractions, its box measured once per document — told by the input counter's id: a game gone on from its menu page is measured again on its play page; until 2026-09-30 once per open, and 3 clicks on the play page's canvas missed it), `pointer` (the mouse button held down there until `pointer: false`; `game_open` lets go of it with the keys), `waitMs` (real time, the clock frozen — before `advanceMs`), `advanceMs` (`clock.runFor`, run whole: a native dialog in it is waited out, see "Native dialogs"; with the animation clock in 16 ms frames, the CSS animations moved on after each); both whole milliseconds (the clock runs a fraction on to the next one, a later document's replay of its log does not); then one `page.evaluate` of `observeExpression(read, score)` (each expression on a line of its own: it may end in a `//` comment) → `{ raw, score, clockMs, readError?, scoreError?, pageError? }`. A `read` or `score` that does not compile (statements, not an expression) is its part's error (`SyntaxError: …`), not the step's: checked in the daemon before it is spliced (`syntaxErrors`: the part as spliced, compiled in a function body, never run) and left out, the rest read (2026-09-30: the page refused the whole expression, and the step failed with the raw input). What the daemon's engine refuses the page's may take (Chrome's is newer: Node 22's knows no `(?i:…)` regex modifiers): that part is compiled in the page first (inside a function it never calls) and read when it compiles there |
| `game_probe` | after `game_open` with the probe adapter: canvases (context kind, box on the page, a selector that finds it again: its id, else its place under the nearest ancestor with one), the body's box, 2D call counts, engine globals (set, not only there: the adapters' own `window.Phaser` / `window.PIXI` accessors are no engine), the viewport, the page's scripts (tags + loaded resources) and inline scripts, the globals its own code added (`name: kind`, against the window at install time), and the adapter that fits — decided by the largest canvas |
| `game_sprite-crops` | PNG data URLs of recorded sprites by key (setup labels, novelty) |

The daemon binds every interface with no auth (DevTools' `serve()` takes no hostname), so anyone who can
reach its port can call these tools: `game_open` opens `http:` and `https:` pages only (its schema and
the tool refuse `file:`, `data:`, `javascript:`, `chrome:` … pages).

A daemon `ensureDaemon` starts (`src/devtools/daemon.ts`) runs with this process's environment, less the DevTools
settings that would take the game tools away or change their session (`daemonEnv`, 2026-09-30: a shell with
`AVAILABLE_TOOL_DOMAINS=navigation,interaction,content` got "Tool Not Found" for `game_open`): the tool domain
list, a persistent or CDP-attached browser context (every session in one context, with one clock), the dialog
mode, tab following, OpenTelemetry in the page, another live-view hub, the host allowlists (`BROWSER_ALLOWED_DOMAINS`,
`BROWSER_ALLOWED_NAVIGATION_DOMAINS`: until 2026-09-30 a shell's refused every game of another host,
`net::ERR_BLOCKED_BY_CLIENT`; a caller's `env` may still set one). Its `DAEMON_HOST` is where it is asked for
(`daemonHost`: a revived URL's host, `[::1]` as `::1`, else 127.0.0.1), whatever a shell says: a DevTools that reads it
listens on 127.0.0.1 unless told otherwise, so one revived for a URL at [::1] with only its port listened on 127.0.0.1
and its health check at [::1] never answered (an older DevTools ignores it: it listens on every interface). Its
`TOOL_PLUGINS` are the env's (the shell's,
the caller's) less another install's game tools — a `game-tools.mjs` elsewhere, as a shell set up for a daemon started
by hand names it: DevTools refuses a tool registered twice and exits —, then this build's (`toolPluginsEnv`). Its stderr
goes to a temp file, removed once it answers, whose last lines (2 KB) an error about its start carries (until
2026-09-30 "exited (code 1) during start", the reason lost). Not a pipe: one this process stopped reading would block
the daemon once full, and one it left by exiting (a daemon revived for a URL outlives it) breaks — Node then dies at
its next line to stderr (measured: `write EPIPE`, from `console.error` too). A daemon started by hand that answers
"Tool Not Found" is told to load `TOOL_PLUGINS` and leave `AVAILABLE_TOOL_DOMAINS` unset (or name `game` and
`content`).

Page side (`page/`, all under `window.__ibgamer`): `canvas2d` wraps `drawImage` / `fillRect` /
`fillText` on connected canvases (a frame closes at the next microtask; where a draw landed is the box
around its transformed corners, mirrored or turned draws included; sprite
key = source image id + source rect — an id only for a source drawn onto the picture, the same while the source lives,
which is held weakly: until 2026-09-30 every source drawn anywhere, offscreen too, was kept for good, and a game drawing a
fresh 800×600 buffer every frame took the renderer from 688 to 3656 MB in 30 s (now 87 to 92, 86 to 90 without the
recorder); `crop(key)`, nothing once the source is gone), `phaser` finds v2 (`Phaser.GAMES`) or v3 (boot
hook) games and dumps objects (with rotation `a` and `tint` when not the default) + tilemaps, and
on a seeded page sows the game's RNG from the seeded `Math.random` when it is made (v2 `game.rnd`
through a `Phaser.GAMES.push` hook, v3 `Phaser.Math.RND` after boot: Phaser seeds it from
`Date.now()`, the real time at load), `decodes` (the work a page has running off its thread — decoding, WebAssembly compiles, IndexedDB requests and transactions —, for the boot, frozen or not), `probe`, `seedRandom(seed)` (splitmix32-scrambled seed → mulberry32 — seeds next to each other start far apart; Park–Miller before this drew almost the same first numbers for 101/202/303; crypto's
`getRandomValues` / `randomUUID` from the seed too, on a stream of their own — the seed's second splitmix32 output →
mulberry32 —, so Math.random draws what it always did whatever else asks crypto; each call the browser's first, its
checks and errors (an integer array, at most 65536 bytes) and its array kept, then the seed's bytes, a UUID version 4;
until 2026-09-30 they differed between two sessions of seed 7. The input and decode counters take their document ids
from crypto before it: `game_open` adds it after them, so the ids stay each document's own and its stream starts whole.
Sets `__ibgamer.seeded`), `pixi` (v4–v8: catches `window.PIXI` on assignment, wraps the renderers'
`render` to keep the root it is handed, dumps drawn objects with bounds, fill and tint — see
adding-games.md), `cocos` (Creator 2.x / 3.x, cocos2d-js: walks the scene `cc.director` runs when a
dump is asked for, nothing installed before the page's scripts), `pixels` (`grab(w, h?)`: the largest
canvas scaled into a colour grid, 3 hex digits a cell; WebGL contexts made with
`preserveDrawingBuffer: true` so a frozen page still reads back — see adding-games.md).

`src/devtools/protocol.ts` is the one definition of the wire shapes for both sides.

**The animation clock** (`animationClock` on `game_open`, from game.json; `page/animations.ts`,
`time.ts`): the frozen clock stops a page's timers and frames, not the browser's own clock for CSS
animations and transitions — a game that moves things with CSS (floppybird's pipes) would have them
slide on in real time while it waits for a decision. With it, every animation the page starts is
paused at its start (`currentTime = 0` when first seen) and moved on only by game time: `runGameTime`
runs the clock in 16 ms frames and calls `advance(dt)` after each (the boot and `_onFrame` too). An
animation the page itself holds (`animation-play-state: paused` in its computed style) is left where it
is. Off by default: a game whose start waits for a CSS animation in real time (Dino's intro, `waitMs`)
would never start with it on.

**Replaying under load** (2026-09-29, found with `ibgamer check --parallel`, several at once): a seed
must give the same game however busy the machine is. Six things made it not:

- **Fractional timers.** `setInterval(loop, 1000 / 60)` fires at sums of 16.666… on the frozen clock,
  and every 400 ms such a tick meets a step's whole-millisecond end exactly; in floating point it fell
  on one side or the other depending on where the clock's timeline started — a physics tick more or
  less (floppybird's bird a gravity step off; Dino's seed 303 1485 in one run, 825 in another).
  `page/timers.ts` nudges a fractional delay by 1e-6 ms (wrapping the frozen clock's timers), so a tick
  always lands just after the step's end. Whole-number delays are untouched. (Until 2026-09-30 it was added
  before the clock and wrapped the native timers the clock then replaced: nothing was nudged, and a
  session's later games, starting at other ticks, drifted from its first — Super Coin Box too.)
- **Input arriving late.** The browser delivers key and mouse events on its own thread; a key could
  reach the page after the clock had run on. The page counts what it received (`page/inputs.ts`, a
  capturing listener on the window: the browser's keydown / keyup / pointerdown / pointerup — pointer,
  not mouse, events: a page that cancels pointerdown gets no mousedown or mouseup), each document under
  an id of its own, and a step waits (up to 5 s, polled) until every input it sent has arrived before
  it runs game time. The page's count is then where the next step counts from: an input that never
  arrives is waited for once, not by every later step, and a page that loads another document is
  waited on there for that step's inputs only (2026-09-30: either made every later step wait 5 s).
- **CSS transitions started inside a slice of game time** ran in real time until the animation clock
  took them over. With the animation clock the page's animation timeline is held still (DevTools
  `Animation.setPlaybackRate(0)`, the session kept open): nothing moves until game time moves it.
- **A loader's next file** (2026-09-30). A boot frame waited for the requests it saw, gave the page one
  turn and ran: a file a load callback asked for then slipped through, and arrived a frame later in some
  runs (8 chained images: 4 runs of 54). The wait now looks again after every turn that moved the network.
- **Decoding off the page's thread** (2026-09-30). A WebAudio loader (Phaser 3's) waits for `decodeAudioData`
  before the game starts, and decoding takes real time: the frame the last sound came in was 127, 133, 134 or
  140 for one seed. `page/decodes.ts` lists each `decodeAudioData` / `createImageBitmap` / `img.decode()` from its
  call until its promise settles or a callback runs (the calls otherwise the browser's own: same arguments,
  promise, `length` and `name`); a boot frame waits for them as for requests, under the same bounds.
- **WebAssembly and IndexedDB** (2026-09-30). Compiling a module and a database's answers take real time too:
  5 instantiations of a 3.6 MB module, one after another from frame 2, came in frames [2,3,3,4,4] in one run and
  [2,2,3,3,4] in another; a save read from IndexedDB (opened, then 6 writes) in frames 3–5 in one run, 1–2 in the
  others. `page/decodes.ts` lists `WebAssembly.compile` / `instantiate` / `compileStreaming` /
  `instantiateStreaming` as it lists a decoding, an IndexedDB request (`indexedDB.open` / `deleteDatabase`, an
  object store's or an index's operations) until it succeeds or fails, and a transaction until it completes or
  aborts (not at an error: its requests' errors reach it, and a page may carry on after one), each ended before
  the page's own handlers run. Now every one comes in the frame it began in.

The frozen clock also starts every game at the same moment: `setSystemTime` (2026-01-01) just before
the game's load, so a page reading `Date.now()` reads the same in every run, and every fresh session's
game loads at the same `performance.now()` too. The session's first pause is at that moment as well: a
document's clock takes the first moment its log sets as its origin, so `performance.timeOrigin` is
2026-01-01 in every session (until 2026-09-30 the real time the session started; a freshly injected clock
starts at 0, so the moment is never past — should it be, the pause falls back to one after the page's
time). Playwright hands each new document the clock as a log of what was done to it (paused at, run for,
set to), replayed at the page's first read of the time. So
the clock is installed by the session's first `pauseAt`, not by an `install()` before it, whose entry
put the real milliseconds up to the pause (the empty page's load among them) into every later
document; the frame alignment is done on the empty page, whose clock is the log's (the page before ran
its own on by the pause); and a page init script (`page/clock.ts`), after the clock's own, reads the
clock as each document starts and cancels the clock's real-time timer, which the replay leaves running:
100 ms in, it moved the clock on by the real time passed (a page whose first script waited 400 ms on the
network read `performance.now()` 323 where the others read 16) and ran the timers then due — a
`setTimeout(start, 0)` set as the page loads ran during the load or in the boot, as the load's length
decided. The log is replayed in pieces — up to that read, then the rest at the next — each from running,
so `game_open` pauses again after the page scripts it adds: a piece that did not start with a pause ran
the clock on in real time. Until 2026-09-30 a game loaded at `Date.now()` 55–86 ms past the epoch and
`performance.now()` 80–128, differing per session. The game's own scripts go in after `setSystemTime`, just
before its load, followed by a pause at that moment that moves nothing (so every piece still starts with one):
added with the adapters, before the clock's entries for its load, a game script that read the clock (a custom
perception's) read it where the game before had left it from a session's second game on — measured 2026-09-30,
a script's first `performance.now()` −16 ms from the page's load in a session's first game, −45 / −43 / −47 in
later ones, its 20 ms timers falling elsewhere against the page's frames (and after a game in real time the page's
own frames too: 11 ms after its load for 16); now 0 in every game. An animation's end event is still
dispatched on the browser's real frame, so a game whose start waits for a CSS animation keeps doing it
in real time with the clock frozen (`waitMs`: Dino's intro) — moving it onto the animation clock made
the start depend on when that frame came.

**A session's later games** (measured 2026-09-30) do not load at the `performance.now()` its first did:
`performance.now()` is the clock's running count, which only goes forward, so each game loads at the one the game before
left — 16, 1184 and 2352 for three games of seed 7 in one session, each a 100 ms boot and 1 s of play —, and the frame
timestamps rAF hands the page move with it; `Date` and `performance.timeOrigin` are the epoch every time. Measuring,
training, `check` and distilling open one game per session; `ibgamer play --episodes N` and the UI's episode count play
the later episodes in the same session, and those need not replay exactly as a session's first game of their seed.

**The time zone** (2026-09-30). A page reads its local time in UTC (`Emulation.setTimezoneOverride`), frozen or not:
the epoch is 2026-01-01 00:00 whatever the machine's zone — until then the same seed and epoch read 31 Dec 16:00 under
America/Los_Angeles and 1 Jan 09:00 under Asia/Tokyo (a day's level, a night theme). Set at a page's first open, before
anything loads, on a DevTools session kept for the page (closing it would lift the zone), which holds across its loads;
a replaced page gets its own at its next open. DevTools sets no zone, and one already in force is left as it is. A frame
of another site that runs in a process of its own keeps the machine's: under Asia/Tokyo a localhost frame in a
127.0.0.1 game read 09:00 in Chrome (site isolation), 00:00 in the headless shell.

**Page errors.** Playwright's clock runs a whole slice, then rethrows the first error a timer or frame
callback threw (`runFor`, the fast-forward of `pauseAt`) — which a page on its own clock would only have
logged, and which failed `game_step` / `game_open` and so the run. `time.ts` asks the page: one that still
answers threw it, and it is reported as `pageError` (the first line of the first) on the result; a closed
or crashed page still throws. A pause whose moment had passed is told by Playwright's message on the error's
first line only (`clockMomentPassed`): the rest is the page's stack, and a frame throwing from `pasta.js` was
taken for one, retried and thrown.

**Native dialogs** (2026-09-30). An `alert` / `confirm` / `prompt` a timer or frame callback opens (an alert at game
over) cuts Playwright's `runFor` short: it drops its evaluations at a dialog, and says nothing; the page's own run goes
on alone in real time once the dialog is answered (dismissed: DevTools' default, and `daemonEnv` keeps it). A step of
1000 ms came back in 12 ms with `performance.now()` at 176, not 1032, and the page ran on to 1032 with no game time
asked (six steps of 500 ms ran 145, 480, 785, … ms). `runGameTime` reads the page's clock before a slice (the clock's
own count, `__pwClock.controller.performanceNow()`: a page may replace its `performance`) and after Playwright's call
waits (polled, real time, at most 2 s) until it has run the whole slice — per frame with the animation clock, before
the animations move on; the boot and the frame alignment run through it too. A clock still short then is reported as
`pageError` ("game time ran short: …"); a new document (the page navigated) replays the whole log, so is there at once.
The main frame's clock only: a game in a frame of its own is not waited for. Nothing waits on `page.on("dialog")`: a
listener turns Playwright's own dismissing off.

**Clean origins** (2026-09-30). `game_open` clears (`Storage.clearDataForOrigin`, all types: cookies, local
storage, IndexedDB, Cache Storage…) on the empty page, before the load: the game's origin, those the page is on,
and every web origin the game before went through — each one a document of the page committed on (`framenavigated`,
every frame: a consent or sign-in page its load bounced through, a frame it removed or sent elsewhere, a page it went
to in play) and each one a navigation asked for (`request.isNavigationRequest()`: a redirect's hops, which commit
nothing and may set cookies). `watchGameOrigins` notes them from the page's first open (its listeners registered once
per page) into the session state — the storage is the context's, so what a replaced page's game went through is
cleared too —, and each open takes them and notes afresh. A game's first 64 are kept (an ad frame rotating through
more hosts has the rest go unnoted; clearing 64 took 75–150 ms); an about:, data: or blob: document is on its
creator's origin or on none. A host only a request that is no navigation reached (a tracker's image, a fetch) is not
noted. Until 2026-09-30 only the game's origin and the page's were cleared: over three games, a bounce origin's local
storage and cookie counted 1, 2, 3, as did a removed frame's local storage and a redirect hop's cookie (the headless
shell and Chrome). In the session's own context every cookie goes too (`clearCookies`): an origin's clearing leaves
the partitioned (CHIPS) cookies a frame of it set under the game's site, and the cookies of a host the game only
fetched from (its API: no document there, so no origin noted) — both counted 1, 2, 3 over three games until
2026-09-30, in the headless shell and Chrome. A cookie DevTools seeded into the jar (`BROWSER_HTTP_HEADERS_SEED`, a run
secret) goes with them. The context is the session's own when DevTools made it for the session (`newContext`, what
every daemon `ensureDaemon` starts does): asked once per session, the page's context against those the browser made
with `Target.createBrowserContext`. The browser's default context — a persistent profile's, an attached Chrome's (a
daemon started by hand) — holds every session and, attached, a person's own tabs: there only the noted origins are
cleared.

**Windows a game opens** (2026-09-30). Popup blocking is off and DevTools does not follow a tab a page opens (tab
following is off: `daemonEnv`), so a window a game opened (a sponsor's, a leaderboard's) outlived it: it ran on in the
next games — on the context's clock, which every step runs in all its pages —, without the page scripts, the origins
it went through never noted, and wrote into the next game's freshly cleared origin. A window of the game's origin
counting its ticks in local storage read 20, 30, 32, 44 two seconds of game time into four games of a session (20 in a
fresh one); the context held 2, 3, 4, 5 pages. `watchGamePages` keeps every window the page opens — Playwright reports
it as the page's popup whether the page, a frame of another site or a `noopener` call opened it — and the windows those
open, into the session state (a replaced page's are closed too), noting what each goes through as the page's; the next
open closes them on the empty page, their `beforeunload` not asked, and clears the origins they were on with the rest.
Never the session's page, and only windows the games opened: a shared context's other tabs stay.

Playwright reports a window only once its first document's response has come, so its listeners come late for that
document: where the window is at the report is noted at once (until 2026-09-30 a window that went on from its first
document before the next open — a first stop on another host sending it on — left that origin uncleared: 1, 2, 3, 4
over four games, the headless shell and Chrome). The first navigation's redirect hops are past by then too, and set
cookies only: the session's own context loses every cookie at each open, a browser's default context keeps them. A
window whose server has not answered yet is in no list — neither the session's nor the context's pages —, so one a
game opened as it ended (a leaderboard at game over) ran into the next game and wrote into its freshly cleared origin
(measured with a 300 ms server: `"1"` from the second game on, two pages open; none with a 0 ms one). The browser lists
it already, its opener with it, a `noopener` one too (`Target.getTargets`): in the session's own context the next open
closes (`Target.closeTarget`) every page of the context whose chain of openers leads to the session's page or to a page
no longer open (`openedTargets`: in a context of its own, a page with an opener was opened by one of the session's
pages), listed before the reported windows are closed, since a chain runs through them. A browser's default context
(a persistent profile, an attached Chrome) holds other sessions' pages and a person's tabs: there a window not yet
reported stays.

**Session storage** (2026-09-30). The tab keeps one for each origin (Playwright launches Chromium with third-party
storage partitioning off: a frame of B shares it with every other B document of the tab). DevTools' origin clearing
empties an origin's in Chrome, not in Playwright's headless shell (measured: `Storage.clearDataForOrigin` left it as
it was). `page/storage.ts` empties
each storage once in each game, at the first document of the game that uses it, remembered in the storage itself:
every open hands its documents a token of its own (digits: the value parses as JSON), and a document whose storage
holds that token under `__ibgamer_session` leaves it alone; any other storage is emptied and marked. The script
goes in before the game's own init scripts (what they store as a document starts is kept), stays for the whole game
— the load, the boot, play — and is removed at the next open's start (a closed page takes it with it). So a frame
added in the boot or a lazy one scrolled to in play finds its storage empty, and what the game stored is kept in a
frame of its origin (about:blank, srcdoc), in the page a launcher or a bounce through another origin sends the tab
on to, in a frame of its origin under a frame of another, and when it loads itself again. The marker is one key the
game can see (`sessionStorage.length`, `key(i)`); a game that empties its session storage itself takes the marker
with it, and its next document empties it again. Until 2026-09-30 the script inferred each storage's first document
of the load from the frame tree and the Navigation API and was removed once the load was done: a frame that started
later kept the game before's storage (1, 2, 3, 4 over four games in the headless shell), and a frame of the game's
origin under one of another, or the page a bounce sent back, emptied what the game had stored (`null` where a plain
tab keeps it). Before that, every document of the load emptied it, after the game's init scripts.

**What nothing waits for** (measured 2026-09-30):

- **A worker's answer.** A page that decodes in a worker (PixiJS v7/v8 by default: `fetch` and
  `createImageBitmap` in a worker, the bitmap posted back) is waited for only as far as its requests: which
  message answers which is the page's own. A 2048² bitmap decoded in a worker from frame 1 came in frame 25, 16,
  15 or 14 with sessions one at a time, in frame 10–12 with three at once.
- **A worker's timers.** The frozen clock is the page's documents'; a worker keeps the browser's own, and its
  `setInterval` / `setTimeout` run in real time while the page stands still: a worker's 10 ms interval counted 3,
  then 103 one real second later with no game time run (the headless shell and Chrome). A game whose simulation
  ticks in a worker runs on between steps. (A worker's Math.random and crypto are not seeded either: init scripts
  run in documents only.)
- **Other work a page runs asynchronously.** A boot frame waits for the page's requests and what `page/decodes.ts`
  lists, nothing else: reading a Blob back (`blob.arrayBuffer()`), a `DecompressionStream`, a job the page chunks
  over MessageChannel messages (a `setImmediate` polyfill, as zip and inflate libraries use) land in whatever frame
  they finish in. Five jobs one after another from frame 1, a 400 ms boot: 24 MB Blob reads came in frames
  [1,1,2,2,3], [2,2,3,4,4], [1,2,2,3,3], [2,2,3,3,4] with sessions one at a time, [6,10,15,20,26] and [6,11,15,20,25]
  with three at once; 12 MB gunzipped through `DecompressionStream`, [1,2,2,3,4], [1,2,2,3,3], [1,2,3,3,4] alone,
  [1,2,3,4,4] and [1,2,3,4,5] with three at once; four jobs of 60 chunks of 0.5 ms over a MessageChannel, [3,4,4,4],
  [1,2,3,4], [1,2,3,3], [1,1,2,3] alone, [1,1,1,2] with three at once (a boot frame then took longer in real time).
- **A media element's readiness.** An `<audio>` / `<video>`'s `canplaythrough` (Phaser 2's HTML5 audio, simple
  loaders) is waited for only as far as its request: waiting for it would hold, and so change, the boot of every
  library game whose page plays music. Five sounds readied one after another from frame 1 were all in frame 1
  in 6 runs of 7, none within the 300 ms boot in the other.
- **The network after the boot.** A step runs its game time straight through the page's requests and its work
  off its thread: a file a game loads mid-play lands where the network puts it. 3 files asked for one after
  another from frame 30 (each answered in 30 ms), stepped 50 ms at a time: the first came in frame 114–133 over
  5 runs with no time between steps, in frame 45 with 5 ms. The library's games load only pictures and sound
  mid-play.
- **A sound's end.** Media plays on the browser's real clock, game time frozen or not: once a sound plays,
  `AudioContext.currentTime` moves with real time (512 ms in 500 ms with no game time), and a Web Audio source's
  `onended` or a media element's `ended` (measured with `<audio>`) comes in whatever frame the game stands at then:
  a game that goes on when a sound ends does so at a frame decided by how fast the steps ran. A 150 ms sound started
  in frame 5, stepped 16 ms at a time with 0 / 0 / 3 / 10 / 20 ms between steps: its `onended` came in frame 41 /
  never in 40 steps / 19 / 14 / 10 in the headless shell, 9 / 33 / 19 / 9 / 10 in Chrome. (A context the page makes
  as it loads stays suspended until a frame of the game starts a sound: the frozen clock runs the page's callbacks in
  Playwright's evaluate, which carries the user activation autoplay asks for.) No library game waits on a sound's
  end in play; media is not moved onto game time.

Still open: with several games measured at once (up to 27 browsers, load average ~70) two of about
150 games came out different once (Super Coin Box 157 for 87, Flappy Bird 17 for 38) and never again
in parallel replays under load. The first suspects are the real-time bounds: a step's wait for its inputs
(5 s) and a boot frame's wait for the page's requests and its work off its thread (2 s) run out, and the game
goes on without them.

