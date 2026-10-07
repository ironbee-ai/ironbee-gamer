"use strict";

const $ = (id) => document.getElementById(id);
const state = {
    /** The Hugging Face library as last read (/api/hf), and the game whose replacing waits for a second click. */
    hf: null,
    hfConfirm: null,
    games: [],
    selected: null,
    detail: null,
    status: null,
    run: null,
    runs: [],
    ws: null,
    tick: null,
    tickPending: false,
    viewing: null,
    /** The game and version whose instructions the Rules panel shows ("<game>/v<N>", "<game>/none"). */
    rulesKey: undefined,
    /** The profile version picked in the Profile select for this game ("<N>"); null: the active one. */
    versionChosen: null,
    /**
     * The engine wanted for the game shown: its own when it is opened (its config's, else the one it was added for, else
     * the one last wanted here: picked, or wanted by a game played or trained), or the one picked in the Engine select —
     * the list opened picks the one it shows (pickShown). The select shows it whenever it can play the game, else a
     * fallback (renderEngines) — never kept as wanted, nor remembered.
     */
    engineWanted: null,
    /** The game and version whose Laya checkpoint the server was last asked to hold ("<game>/<version>"); null: none. */
    warmed: null,
};

function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(method, path, body) {
    const response = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
}

function remember(key, value) {
    try {
        localStorage.setItem(`ibgamer.${key}`, value);
    } catch {
        // storage off: nothing remembered
    }
}

function recall(key) {
    try {
        return localStorage.getItem(`ibgamer.${key}`);
    } catch {
        return null;
    }
}

// ---------- status ----------

/**
 * What the setup checklist reads from the status: each engine's readiness — Laya's Python for Laya (a game's Laya is
 * that and a checkpoint of the version a clock plays: unplayableOn) — and the trainer's.
 */
function readiness(status) {
    return status ? JSON.stringify([Object.entries(status.engines).map(([kind, health]) => [kind, kind === "laya" ? health.python?.ok : health.ok]), status.trainer?.ok]) : "";
}

/** An engine as the Engine list names it. */
function engineLabel(kind) {
    return kind === "jev" ? "Jev (hosted)" : kind === "laya" ? "Laya (local)" : kind === "rules" ? "Rules (code)" : String(kind);
}

/**
 * The engines the Engine list offers: Laya and Jev. The rules (code) are what Laya learns and what a check holds an engine
 * against, not one to pick here (the CLI still plays them: `--engine rules`).
 */
const PICKABLE_ENGINES = ["laya", "jev"];

/** The engine wanted for the game shown (state.engineWanted): its rules (code), wanted before the list dropped them, are Laya's to play. */
function wantedHere() {
    return state.engineWanted === "rules" ? "laya" : state.engineWanted;
}

/** The engine wanted for the game shown when the Engine list offers it, else the server's default when it does, else Laya. */
function wantedEngine() {
    const pickable = (kind) => PICKABLE_ENGINES.includes(kind) && Object.hasOwn(state.status?.engines || {}, kind);
    return [wantedHere(), state.status?.defaultEngine, "laya"].find(pickable);
}

/** The engine wanted, remembered for a game opened later that names none: a pick, or a game's own — never a fallback shown. */
function rememberWanted() {
    if (state.engineWanted) {
        remember("engine", state.engineWanted);
    }
}

/** The profile versions of the game shown with a Laya checkpoint a play can take (its detail's `laya`: v<N>-…, newest first). */
function distilledVersions() {
    return (state.detail?.laya || [])
        .map((c) => /^v(\d+)-/.exec(c.name || ""))
        .filter(Boolean)
        .map((m) => Number(m[1]));
}

/** The version a config pins for an engine and clock, when the game has it: the Profile select is locked to it (syncVersion). */
function pinnedVersion(engine, live) {
    const pinned = offered(engine, live)?.version;
    return pinned !== undefined && (state.detail?.profiles || []).some((p) => p.version === pinned) ? pinned : undefined;
}

const NOT_OFFERED = "not offered for this game";

/**
 * Why an engine cannot play the game shown with a clock (live: the clock never pauses), in words; empty: it can. As the
 * server takes a play: offered that way, the engine ready — Laya by its Python, not the status's `engines.laya.ok` (any
 * game's) —, and for Laya the version that clock plays (a config's pin, else the one its checkpoint learnt: syncVersion)
 * distilled (a checkpoint a play can take). A status not read yet takes the engine as ready, as a training's refusal does.
 */
function unplayableOn(kind, live) {
    if (!offered(kind, live)) {
        // A game with no configs of its own is played live once a version is trained for it: why none is yet.
        const why = live && kind !== "jev" && !state.detail?.game?.configs ? state.detail?.live?.why : undefined;
        return why ? `${why} (Train for real time)` : NOT_OFFERED;
    }
    const health = kind === "laya" ? state.status?.engines?.laya?.python : state.status?.engines?.[kind];
    if (health?.ok === false) {
        return "not ready";
    }
    const pinned = pinnedVersion(kind, live);
    const played = `the version played ${live ? "in real time" : "with the clock paused"}`;
    if (kind === "laya") {
        const distilled = distilledVersions();
        if (!distilled.length) {
            return "not distilled for this game";
        }
        // Not pinned: the version its checkpoint learnt plays (layaVersion).
        if (pinned !== undefined && !distilled.includes(pinned)) {
            return `no Laya checkpoint of v${pinned}, ${played}`;
        }
    }
    return "";
}

/** Why an engine cannot play the game shown with any clock, in words (each offered clock's reason); empty: one can. */
function unplayable(kind) {
    const reasons = [unplayableOn(kind, false), unplayableOn(kind, true)];
    if (reasons.includes("")) {
        return "";
    }
    const offeredWhy = reasons.filter((r) => r !== NOT_OFFERED);
    return [...new Set(offeredWhy.length ? offeredWhy : reasons)].join("; ");
}

async function loadStatus() {
    const before = readiness(state.status);
    try {
        state.status = await api("GET", "/api/status");
    } catch {
        return;
    }
    const s = state.status;
    const pills = [];
    // The engines the Engine list offers: the rules (code) are not one to play, whatever the status lists.
    for (const [kind, health] of Object.entries(s.engines).filter(([kind]) => PICKABLE_ENGINES.includes(kind))) {
        pills.push(`<span class="pill ${health.ok ? "ok" : "down"}" title="${esc(health.detail)}">${kind === "jev" ? "Jev" : kind === "laya" ? "Laya" : esc(kind)}</span>`);
    }
    // The trainer's pill names its model — the one its alias last answered as, once a call has said (`opus` is whichever
    // Opus is the latest) — and opens where it is chosen (one choice for all games).
    const trainerModel = s.trainer.answeredByName || s.trainer.model;
    // … and its effort, when one is chosen (none: its CLI's own).
    const trainerEffort = s.trainer.effort ? ` · ${esc(s.trainer.effort)}` : "";
    pills.push(
        `<button type="button" class="pill ${s.trainer.ok ? "ok" : "down"}" data-trainer title="${esc(s.trainer.detail)} — click to choose the trainer">Trainer${trainerModel ? ` · ${esc(trainerModel)}` : ""}${trainerEffort}</button>`
    );
    $("status").innerHTML = pills.join("");
    renderEngines();
    // Whether a training is offered follows the trainer's readiness, and Jev's for one it decides.
    renderButtons();
    // Rebuilt only when something it reads changed: every 30 s it would replace a button under the pointer.
    if (readiness(s) !== before) {
        renderSetup();
    }
}

/**
 * The game's config for an engine and clock (live: the clock never pauses): of its own configs, else of those its
 * versions earn — the server's `configs` (every engine paused; live, Laya and the rules on a version trained for real time).
 */
function offered(engine, live) {
    const configs = state.detail?.configs ?? state.detail?.game?.configs;
    if (!configs) {
        return { engine, live };
    }
    return configs.find((c) => c.engine === engine && Boolean(c.live) === live);
}

/**
 * The engines the list offers (PICKABLE_ENGINES): each while some clock it is offered with can play the game (unplayable)
 * — Laya with its Python and a checkpoint of the version that clock plays, Jev with its key.
 */
function renderEngines() {
    const s = state.status;
    if (!s) {
        return;
    }
    const engine = $("engine");
    // Whenever it is drawn (a game opened, a run ended, the status read again): the engine wanted, once it can play.
    const chosen = wantedEngine();
    engine.innerHTML = Object.keys(s.engines)
        .filter((kind) => PICKABLE_ENGINES.includes(kind))
        .map((kind) => {
            // A clock it cannot play with is greyed out beside it (syncPace).
            const why = unplayable(kind);
            return `<option value="${esc(kind)}"${kind === chosen && !why ? " selected" : ""}${why ? " disabled" : ""}>${esc(engineLabel(kind))}${why ? ` — ${esc(why)}` : ""}</option>`;
        })
        .join("");
    // The engine wanted cannot play it now: the first that can is shown, for Play only (the wanted one is shown again once
    // it can).
    if (engine.value !== chosen) {
        const fallback = [...engine.options].find((o) => !o.disabled);
        if (fallback) {
            engine.value = fallback.value;
        }
    }
    syncPace();
    syncVersion();
    renderRules();
}

/**
 * The clocks the chosen engine can play the game with: another is disabled — not offered, or for Laya the version it
 * plays there not distilled (unplayableOn) — and a disabled choice moves to one that is not.
 */
function syncPace() {
    const pace = $("pace");
    const engine = $("engine").value;
    for (const option of pace.options) {
        const why = unplayableOn(engine, option.value === "realtime");
        option.disabled = Boolean(why);
        option.title = why === NOT_OFFERED ? "Not offered for this game with this engine" : why ? `${why.charAt(0).toUpperCase()}${why.slice(1)}` : "";
    }
    if (pace.selectedOptions[0]?.disabled) {
        const first = [...pace.options].find((o) => !o.disabled);
        if (first) {
            pace.value = first.value;
        }
    }
}

/**
 * The profile version Laya plays when no config pins one (checkpoint names are v<N>-…, newest first):
 * the active version when it has a checkpoint, else the newest checkpoint's — as the server picks it.
 */
function layaVersion() {
    const versions = distilledVersions();
    const active = state.detail?.active?.version;
    return versions.includes(active) ? active : versions[0];
}

/** The version the Profile select plays when nothing locks it: the one picked there, else the active one. */
function chosenVersion() {
    return state.versionChosen ?? String(state.detail?.active?.version ?? "");
}

/**
 * Laya plays a profile version whose states it learnt: the select shows that one and is locked while
 * Laya is the engine.
 */
function syncVersion() {
    const select = $("version");
    // A config that names a version plays that one.
    const pinned = pinnedVersion($("engine").value, $("pace").value === "realtime");
    if (pinned !== undefined) {
        select.value = String(pinned);
        select.disabled = true;
        select.title = "This game plays this way with this version";
        return;
    }
    const learnt = $("engine").value === "laya" ? layaVersion() : undefined;
    if (learnt !== undefined && [...select.options].some((o) => o.value === String(learnt))) {
        select.value = String(learnt);
        select.disabled = true;
        select.title = "Laya plays the profile version its model learnt";
        return;
    }
    // Not locked: the one picked, else the active one.
    if (state.detail?.active) {
        select.value = chosenVersion();
    }
    select.disabled = false;
    select.title = "";
}

/** The version whose rules the Decision panel shows: the play running (its game's), else the one the Profile select plays. */
function rulesShown() {
    const run = state.run;
    if (run && run.status === "running" && run.kind === "play" && run.version) {
        return { gameId: run.gameId, version: Number(run.version) };
    }
    const version = Number($("version").value) || state.detail?.active?.version;
    return state.detail && version ? { gameId: state.detail.game.id, version } : null;
}

/** The Rules panel: that version's instructions (the active one's are here already, another's are fetched). */
async function renderRules() {
    const shown = rulesShown();
    const key = shown ? `${shown.gameId}/v${shown.version}` : state.detail ? `${state.detail.game.id}/none` : "";
    if (key === state.rulesKey) {
        return;
    }
    state.rulesKey = key;
    if (!shown) {
        $("rules").textContent = state.detail ? "No profile yet: Train writes one." : "";
        return;
    }
    const active = state.detail?.active;
    if (active && state.detail.game.id === shown.gameId && active.version === shown.version) {
        $("rules").textContent = active.instructions;
        return;
    }
    try {
        const { profile } = await api("GET", `/api/games/${encodeURIComponent(shown.gameId)}/profiles/${encodeURIComponent(shown.version)}`);
        if (state.rulesKey === key) {
            $("rules").textContent = profile ? profile.instructions : "";
        }
    } catch {
        // Fetched again at the next change.
        if (state.rulesKey === key) {
            state.rulesKey = undefined;
        }
    }
}

// ---------- library ----------

async function loadGames() {
    const { games } = await api("GET", "/api/games");
    state.games = games;
    renderGames();
    const wanted = state.selected || recall("game") || games[0]?.id;
    if (wanted && games.some((g) => g.id === wanted)) {
        await selectGame(wanted);
    }
}

function renderGames() {
    $("games").innerHTML = state.games
        .map((g) => {
            const results = g.results ? `${esc(g.results.mean)} ${esc(g.scoreLabel)} · ${esc(g.results.gameSeconds)} s` : "not measured";
            const thumb = g.hasThumbnail ? `style="background-image:url('/api/games/${esc(g.id)}/thumbnail')"` : "";
            return `<div class="game-card${g.id === state.selected ? " selected" : ""}" data-id="${esc(g.id)}">
                <div class="thumb" ${thumb}>${g.hasThumbnail ? "" : "🎮"}</div>
                <div><div class="name">${esc(g.name)}</div>
                <div class="meta">${g.activeVersion ? `v${esc(g.activeVersion)}` : "no profile"} · ${results}</div>
                <div class="meta">${g.hasLaya ? `<span class="tag laya" title="A local Laya model plays it in tens of milliseconds">⚡ Laya</span>` : ""}${g.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${g.source !== "built-in" ? `<span class="tag user">${esc(g.source === "user" ? "yours" : "trained")}</span>` : ""}</div></div>
            </div>`;
        })
        .join("");
}

$("games").addEventListener("click", (event) => {
    const card = event.target.closest(".game-card");
    if (card) {
        selectGame(card.dataset.id).catch(showError);
    }
});

async function selectGame(id) {
    // Another game opens as it is played: its engine and clock, its budgets, its active version. The same one,
    // refreshed (a run ended, the library changed), keeps what the form holds. The game shown decides, not
    // state.selected: a game just added is named there before it is loaded.
    const switching = state.detail?.game?.id !== id;
    if (switching && !running() && $("screen-loading").classList.contains("failed")) {
        hideLoading();
        $("screen-empty").hidden = false;
    }
    state.selected = id;
    remember("game", id);
    renderGames();
    const detail = await api("GET", `/api/games/${encodeURIComponent(id)}`);
    // Another game was picked meanwhile: its own answer is the one shown.
    if (state.selected !== id) {
        return;
    }
    state.detail = detail;
    const { game, profiles } = detail;
    $("game-name").textContent = game.name;
    $("game-url").textContent = game.url;
    $("game-url").href = game.url;
    $("game-goal").textContent = game.goal;
    if (switching) {
        $("episodes").value = game.budgets.episodes;
        $("seconds").value = game.budgets.gameSeconds;
        $("seed").value = "";
        state.versionChosen = null;
        // Its config's clock, else paused (types.ts: none, its engine with the clock paused).
        $("pace").value = game.preferredConfig?.live ? "realtime" : "watch";
        // Its own engine, wanted until another is picked: its config's, else the one it was added for, else the one last wanted.
        state.engineWanted = game.preferredConfig?.engine || game.preferredEngine || recall("engine");
        // The notes last written for its trainer, on this browser.
        $("train-note").value = recall(`trainNote.${game.id}`) || "";
    }
    // A version picked here stays while it exists.
    if (!profiles.some((p) => String(p.version) === state.versionChosen)) {
        state.versionChosen = null;
    }
    const selected = (p) => (state.versionChosen !== null ? String(p.version) === state.versionChosen : p.active);
    $("version").innerHTML = profiles.length
        ? profiles
            .map((p) => `<option value="${esc(p.version)}"${selected(p) ? " selected" : ""}>v${esc(p.version)}${p.active ? " (active)" : ""}${p.results ? ` — ${esc(p.results.mean)}` : ""}</option>`)
            .join("")
        : `<option value="">none — train first</option>`;
    renderEngines();
    // The version the select now plays (renderEngines locks one in for Laya or a config).
    renderRules();
    renderProfiles();
    renderButtons();
    renderSetup();
    warmLaya();
}

// ---------- profile tab ----------

function renderProfiles() {
    const detail = state.detail;
    if (!detail) {
        return;
    }
    const profiles = detail.profiles;
    const max = Math.max(1, ...profiles.map((p) => p.results?.mean ?? 0));
    $("versions").innerHTML = profiles.length
        ? profiles
            .map(
                (p) => `<div class="version${p.active ? " active" : ""}">
                <div><div class="v">v${esc(p.version)}</div><div class="muted">${esc(p.origin)}</div></div>
                <div>
                    <div>${p.results ? `<b>${esc(p.results.mean)}</b> ${esc(detail.game.score.label)} — ${esc(p.results.scores.join(", "))} · ${esc(p.results.gameSeconds)} s games${p.results.seeds ? ` · seeds ${esc(p.results.seeds.join(", "))}` : ""}` : "not measured"}${p.tests ? ` · ${esc(p.tests)} tests` : ""}</div>
                    ${p.results ? `<div class="bar" style="width:${Math.max(1, (100 * p.results.mean) / max)}%"></div>` : ""}
                    ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}
                    <div class="note">${esc(p.createdAt.slice(0, 16).replace("T", " "))} · ${esc(p.source)}</div>
                </div>
                <div>${p.active ? `<span class="tag">active</span>` : `<button type="button" class="ghost" data-activate="${esc(p.version)}">Make active</button>`}
                <button type="button" class="ghost" data-view="${esc(p.version)}">View</button></div>
            </div>`
            )
            .join("")
        : `<p class="muted">No profile yet. Train writes the first one: it samples the game, the trainer writes an extractor and actions, then tunes them from the games it plays.</p>`;
    if (detail.laya?.length) {
        $("versions").insertAdjacentHTML(
            "beforeend",
            `<h3>Laya checkpoints <small class="muted">fine-tuned on the teacher's decisions; only those that learnt their version as it is now are listed. Of the checkpoints of the version Laya plays (the one the Profile select shows with Laya chosen), a play takes the one whose student played best when it was distilled — the newest when none was measured</small></h3>` +
                detail.laya
                    .map((c) => {
                        const t = c.training || {};
                        const after = t.val_after || {};
                        return `<div class="version"><div><div class="v">${esc(c.name.split("-")[0])}</div><div class="muted">${esc(c.name.split("-").slice(2).join("-"))}</div></div>
                        <div><div>${esc(t.rows ?? "?")} rows · ${esc(t.minutes ?? "?")} min · validation: balanced accuracy <b>${after.balanced !== undefined ? Number(after.balanced).toFixed(3) : "?"}</b></div>
                        <div class="note">${esc(JSON.stringify(after.per_action || {}))}</div></div><div></div></div>`;
                    })
                    .join("")
        );
    }
    if (detail.active) {
        renderProfileDetail(detail.active);
    } else {
        $("profile-detail").innerHTML = "";
    }
}

/** The shortest tick a version is played at with the clock paused (src/game/configs.ts, MIN_PAUSED_TICK_MS). */
const MIN_PAUSED_TICK_MS = 32;

function renderProfileDetail(p) {
    // A version with a shorter tick is played at the paused clock's shortest: its own counts in real time only.
    const paused = p.tickMs < MIN_PAUSED_TICK_MS ? ` (paused: ${MIN_PAUSED_TICK_MS} ms)` : "";
    $("profile-detail").innerHTML = `
        <h3>v${esc(p.version)} <small class="muted">${esc(p.decideOn)} · ${esc(p.tickMs)} ms${paused}${p.maxHoldMs ? ` · hold ≤ ${esc(p.maxHoldMs)} ms` : ""}${p.askWhen ? " · askWhen" : ""}</small></h3>
        <table class="table"><thead><tr><th>Action</th><th>Input</th><th>Description</th></tr></thead><tbody>
        ${p.actions.map((a) => `<tr><td><b>${esc(a.id)}</b></td><td>${a.click ? "click" : esc((a.keys || []).join(" + ") || "—")}</td><td>${esc(a.description)}</td></tr>`).join("")}
        </tbody></table>
        <h3>Instructions</h3><pre class="code">${esc(p.instructions)}</pre>
        ${p.askWhen ? `<h3>askWhen</h3><pre class="code">${esc(p.askWhen)}</pre>` : ""}
        <details><summary>Extractor (${p.extractor.length} chars)</summary><pre class="code">${esc(p.extractor)}</pre></details>
        ${p.tests.length ? `<details><summary>Regression tests (${p.tests.length})</summary><pre class="code">${esc(p.tests.map((t) => `${t.why || ""}\n  [${t.window} @ ${Array.isArray(t.ticks) ? t.ticks.join(",") : t.ticks}] ${t.expect}`).join("\n\n"))}</pre></details>` : ""}`;
}

$("versions").addEventListener("click", async (event) => {
    const activate = event.target.closest("[data-activate]");
    const view = event.target.closest("[data-view]");
    try {
        if (activate) {
            await api("POST", `/api/games/${encodeURIComponent(state.selected)}/active`, { version: Number(activate.dataset.activate) });
            await loadGames();
        } else if (view) {
            const { profile } = await api("GET", `/api/games/${encodeURIComponent(state.selected)}/profiles/${view.dataset.view}`);
            renderProfileDetail(profile);
        }
    } catch (err) {
        showError(err);
    }
});

// ---------- runs ----------

function running() {
    return state.run && state.run.status === "running";
}

/**
 * The engine a training of the game shown is for, as Play's: the one wanted for it — picked here, else the game's own (its
 * config's, the one it was added for) —, not a fallback the Engine select shows while that one cannot play; else the
 * server's default.
 */
function trainEngine() {
    return wantedEngine();
}

/** Whether the clock chosen is the running one: Train checks and trains for it. */
function liveChosen() {
    return $("pace").value === "realtime";
}

/**
 * The engine a training is for, named while the Engine list shows another — a fallback, the one wanted not able to play —
 * (empty otherwise): picking the one shown (pickShown) trains for that one instead.
 */
function trainNote() {
    const shown = $("engine").value;
    const engine = trainEngine();
    if (!shown || !engine || engine === shown) {
        return "";
    }
    const whose = engine === wantedHere() ? "the engine wanted here" : engine === state.status?.defaultEngine ? "the server's default engine" : "the engine the list offers first";
    return `A training is for ${engineLabel(engine)}, ${whose}, not ${engineLabel(shown)}, which the Engine list shows while ${engineLabel(engine)} cannot play: pick ${engineLabel(shown)} there to train for it.`;
}

/**
 * Why a training for `engine` (`live`: with the clock running) cannot start, in words (empty: it can), from the status:
 * the trainer rewrites the profile (without its CLI every measuring game would be played, then each tuning fail);
 * trained for Jev, Jev decides every move — without it the training would run its setup, minutes of it, then fail every
 * decision —, and never live: no game is played live with it.
 */
function trainRefusal(engine, live = false) {
    if (engine === "jev" && live) {
        return "Jev is not played with the clock running: a decision takes it ~275 ms. Pick Laya to train for real time.";
    }
    const python = state.status?.engines?.laya?.python;
    if (engine === "laya" && python && !python.ok) {
        return `Laya's Python is not ready (${python.detail}): a training for Laya teaches Laya on this machine.`;
    }
    const trainer = state.status?.trainer;
    if (trainer && !trainer.ok) {
        return `The trainer is not ready (${trainer.detail}): a training has it rewrite the profile.`;
    }
    const jev = state.status?.engines?.jev;
    return engine === "jev" && jev && !jev.ok ? `Jev is not ready (${jev.detail}): a training for Jev has it decide every move.` : "";
}

/**
 * Why a distillation of the game shown cannot start, in words (empty: it can), from the status, as the server refuses
 * one: Laya learns on this machine, with its Python; the version it learns (the active one) has its rules as code, or
 * the trainer writes them first.
 */
function distillRefusal() {
    const python = state.status?.engines?.laya?.python;
    if (python && !python.ok) {
        return `Laya's Python is not ready (${python.detail}): Laya learns on this machine.`;
    }
    const trainer = state.status?.trainer;
    const active = state.detail?.active;
    return active && !active.teacher && trainer && !trainer.ok
        ? `The trainer is not ready (${trainer.detail}): v${active.version} has no rules as code yet, and the trainer writes them first.`
        : "";
}

/**
 * Why Play cannot start a game (empty: it can) for want of an engine: every one in the Engine list is disabled — not
 * ready, not offered for this game, or unable to play the version a clock plays — and the list says why beside each.
 */
function playRefusal() {
    const engine = $("engine");
    if (engine.value) {
        return "";
    }
    const why = [...engine.options].map((o) => o.textContent).join("; ");
    return `No engine can play it now${why ? `: ${why}` : ""}.`;
}

const TRAIN_TITLE = $("train").title;
function renderButtons() {
    const busy = running();
    const hasProfile = Boolean(state.detail?.active);
    // Train acts on the engine wanted and the clock chosen (Jev only paused).
    const refusal = trainRefusal(trainEngine(), liveChosen());
    // Play asks for the engine chosen in the list: asked for none, the server would refuse the play.
    const noEngine = playRefusal();
    $("play").disabled = busy || !hasProfile || Boolean(noEngine);
    $("play").title = hasProfile ? noEngine : "";
    $("train").disabled = busy || !state.selected || Boolean(refusal);
    // Why not, else what a training does; and the engine it is for while the Engine list shows another.
    const note = trainNote();
    $("train").title = refusal ? [refusal, note].filter(Boolean).join(" ") : [note, TRAIN_TITLE].filter(Boolean).join(" ");
    $("stop").hidden = !busy;
}

function setPhase(text, kind) {
    $("phase").textContent = text;
    $("phase-dot").className = `dot ${kind || ""}`;
}

/** How a game of a play ended, in words: it was stopped, it was over, or its time ran out — the play's Game seconds, not a game that hangs. */
function endOf(e) {
    const played = `${e.gameSeconds} s of game time`;
    if (e.stopped) {
        return { kind: "stopped", title: "Stopped", detail: `after ${played} — score ${e.score}`, phase: `stopped after ${played}, score ${e.score}` };
    }
    if (e.over) {
        return { kind: "over", title: "Game over", detail: `after ${played} — score ${e.score}`, phase: `game over after ${played}, score ${e.score}` };
    }
    return { kind: "time", title: "Time's up", detail: `${played} played, as set in Game seconds — score ${e.score}`, phase: `time's up after ${played}, score ${e.score}` };
}

/** The play whose games this page shows on the screen, and how many of them it has said the end of. */
const ending = { runId: undefined, episodes: 0 };

function hideEnd() {
    $("screen-end").hidden = true;
}

/**
 * A game of the play on the screen ended: said over its last frame, which otherwise just stands still — most of all when
 * its time ran out, where the game itself shows no end. It stays until the play's next game runs (its first tick), or
 * another run is shown.
 */
function renderEnd(run) {
    if (!run || run.kind !== "play" || run.id !== ending.runId) {
        hideEnd();
        return;
    }
    const games = run.episodes || [];
    const last = games[games.length - 1];
    const running = run.status === "running";
    // Nothing new ended (the run said something else of itself), or no game was shown yet (its loading screen says why).
    if (!last || (running && games.length <= ending.episodes) || !$("screen-loading").hidden) {
        return;
    }
    ending.episodes = games.length;
    const end = endOf(last);
    const total = run.settings?.episodes ?? games.length;
    $("screen-end").className = `screen-end ${end.kind}`;
    $("screen-end-title").textContent = end.title;
    $("screen-end-detail").textContent = end.detail;
    $("screen-end-next").textContent = running
        ? games.length < total
            ? `Game ${games.length} of ${total} — the next one is loading`
            : ""
        : games.length > 1 && run.mean !== undefined
          ? `${games.length} games played — mean score ${Number(run.mean).toFixed(1)}`
          : "";
    $("screen-end").hidden = false;
}

function renderRun(run) {
    state.run = run;
    renderButtons();
    renderSetup();
    renderProgress();
    renderRules();
    renderEnd(run);
    if (!run) {
        return;
    }
    const failure = run.status === "failed" && run.error ? `failed: ${run.error}` : "";
    // A play that is done says how its last game ended, not "done" alone: a game out of its time shows no end of its own.
    const lastGame = run.kind === "play" && run.status !== "running" && !failure ? (run.episodes || []).slice(-1)[0] : undefined;
    setPhase(`${run.gameName} — ${failure || (lastGame ? endOf(lastGame).phase : run.phase)}`, run.status === "running" ? "running" : run.status === "failed" ? "failed" : "");
    renderEpisodes(run);
    if (run.kind === "train" || run.kind === "distill") {
        $("train-log").textContent = trainLogText(run);
    }
    // Loading, the numbers of a game not shown yet stay out of the way; the first tick brings them.
    $("hud").hidden = run.status !== "running" || !$("screen-loading").hidden;
}

function renderEpisodes(run) {
    const rows = (run.episodes || []).map((e, i) => {
        const actions = Object.entries(e.actionCounts || {})
            .sort((a, b) => b[1] - a[1])
            .map(([id, n]) => `${esc(id)} ${esc(n)}`)
            .join(", ");
        const shot = e.endScreenshot ? `<a href="/api/runs/${esc(run.id)}/files/${esc(e.endScreenshot)}" target="_blank">end screen</a>` : "";
        return `<tr><td>${i + 1}</td><td>${e.version ? `v${esc(e.version)}` : run.version ? `v${esc(run.version)}` : ""}</td><td>${esc(e.seed ?? "–")}</td><td><b>${esc(e.score)}</b></td>
            <td class="${e.over ? "bad" : e.stopped ? "muted" : "ok"}">${e.over ? "game over" : e.stopped ? "stopped" : "survived (time's up)"}</td><td>${esc(e.gameSeconds)}</td>
            <td>${e.wallSeconds ? `×${(e.gameSeconds / e.wallSeconds).toFixed(2)}` : "–"}</td><td>${esc(e.decisions)}</td>
            <td>${esc(e.engineMedianMs ?? "–")}</td><td class="muted">${actions}</td><td>${shot}</td></tr>`;
    });
    $("episodes-table").querySelector("tbody").innerHTML = rows.join("") || `<tr><td colspan="11" class="muted">No episode finished yet.</td></tr>`;
    const parts = [`${esc(run.gameName)} · ${esc(run.kind)} · ${esc(run.engine)}`];
    if (run.mean !== undefined) {
        parts.push(`mean <b>${Number(run.mean).toFixed(1)}</b>`);
    }
    if (run.error) {
        parts.push(`<span class="bad">${esc(run.error)}</span>`);
    }
    if (run.savedVersions?.length) {
        parts.push(`saved ${run.savedVersions.map((v) => `v${esc(v)}`).join(", ")}`);
    }
    $("run-summary").innerHTML = parts.join(" · ");
    const video = $("run-video");
    if (run.video && run.status !== "running") {
        const src = `/api/runs/${encodeURIComponent(run.id)}/video`;
        if (!video.src.endsWith(src)) {
            video.src = src;
        }
        video.hidden = false;
    } else {
        video.hidden = true;
        video.removeAttribute("src");
    }
}

async function loadRuns() {
    const { runs } = await api("GET", "/api/runs");
    state.runs = runs;
    $("runs-table").querySelector("tbody").innerHTML =
        runs
            .map((r) => {
                const when = new Date(r.startedAt).toLocaleString();
                const result = r.mean !== undefined ? Number(r.mean).toFixed(1) : "–";
                const cls = r.status === "failed" ? "bad" : r.status === "done" ? "ok" : "warn";
                return `<tr class="clickable" data-run="${esc(r.id)}"><td>${esc(when)}</td><td>${esc(r.gameName)}</td><td>${esc(r.kind)}</td>
                    <td>${r.version ? `v${esc(r.version)}` : "–"}${r.savedVersions?.length ? ` → ${r.savedVersions.map((v) => `v${esc(v)}`).join(", ")}` : ""}</td>
                    <td>${esc(r.engine)}</td><td>${esc(result)}</td><td class="${cls}">${esc(r.status)}</td></tr>`;
            })
            .join("") || `<tr><td colspan="7" class="muted">No runs yet.</td></tr>`;
}

$("runs-table").addEventListener("click", (event) => {
    const row = event.target.closest("[data-run]");
    const run = row && state.runs.find((r) => r.id === row.dataset.run);
    if (run && !running()) {
        renderRun(run);
        showTab(run.kind === "train" || run.kind === "distill" ? "training" : "episodes");
    }
});

// ---------- the live decision ----------

function onTick(tick) {
    state.tick = tick;
    if (!state.tickPending) {
        state.tickPending = true;
        requestAnimationFrame(renderTick);
    }
}

function renderTick() {
    state.tickPending = false;
    const t = state.tick;
    if (!t) {
        return;
    }
    $("hud").hidden = false;
    $("hud-score").textContent = t.score ?? 0;
    $("hud-time").textContent = `${(t.gameMs / 1000).toFixed(1)} s`;
    $("hud-episode").textContent = t.episode;
    $("hud-decisions").textContent = t.decisions;
    if (t.engineMs !== undefined) {
        $("hud-ms").textContent = `${t.engineMs} ms`;
    }
    if (t.speed !== undefined) {
        $("hud-speed").textContent = `×${Number(t.speed).toFixed(2)}`;
    }
    $("choice").textContent = t.choice;
    $("choice-meta").textContent = t.asked
        ? `decided at ${(t.gameMs / 1000).toFixed(2)} s of game time${t.engineMs !== undefined ? ` in ${t.engineMs} ms` : ""}${t.fruitless ? " — marked: the game ignored it" : ""}`
        : "kept in force: nothing worth deciding (askWhen)";
    if (t.probabilities) {
        const entries = Object.entries(t.probabilities).sort((a, b) => b[1] - a[1]);
        $("probabilities").innerHTML = entries
            .map(([id, p]) => `<div class="prob${id === t.choice ? " chosen" : ""}"><span>${esc(id)}</span><span class="track"><span class="fill" style="width:${(p * 100).toFixed(1)}%"></span></span><span>${(p * 100).toFixed(0)}%</span></div>`)
            .join("");
    }
    $("state").textContent = JSON.stringify(t.state, null, 1);
}

// ---------- loading ----------

/**
 * From Play until the game's first frame (a Laya server to start, the browser, the page to load and boot:
 * several seconds): what the run is doing now, and for how long. The first frame or tick takes it away.
 */
const loading = { runId: undefined, step: "", since: 0, timer: undefined };

function showLoading(title, step) {
    const box = $("screen-loading");
    box.classList.remove("failed");
    $("screen-loading-title").textContent = title;
    $("screen-empty").hidden = true;
    $("hud").hidden = true;
    box.hidden = false;
    if (!loading.timer) {
        loading.since = Date.now();
        loading.timer = setInterval(renderLoadingStep, 1000);
    }
    setLoadingStep(step);
}

function setLoadingStep(step) {
    loading.step = step || "";
    renderLoadingStep();
}

function renderLoadingStep() {
    const seconds = Math.floor((Date.now() - loading.since) / 1000);
    const step = loading.step ? loading.step.charAt(0).toUpperCase() + loading.step.slice(1) : "Starting";
    $("screen-loading-step").textContent = seconds >= 1 ? `${step} · ${seconds} s` : step;
}

function hideLoading() {
    clearInterval(loading.timer);
    loading.timer = undefined;
    loading.runId = undefined;
    $("screen-loading").hidden = true;
    $("screen-loading").classList.remove("failed");
}

/** The run ended before its first frame: why, where the game would have been. */
function failLoading(message) {
    clearInterval(loading.timer);
    loading.timer = undefined;
    loading.runId = undefined;
    $("screen-loading").classList.add("failed");
    $("screen-loading-title").textContent = "The game did not start";
    $("screen-loading-step").textContent = message;
    $("screen-loading").hidden = false;
    $("screen-empty").hidden = true;
}

// ---------- live view ----------

const canvas = $("screen");
const ctx = canvas.getContext("2d");

async function drawFrame(buffer) {
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 0x01) {
        return;
    }
    const headerLength = view.getUint32(1);
    const jpeg = new Blob([new Uint8Array(buffer, 5 + headerLength)], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(jpeg);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    $("screen-empty").hidden = true;
    if (!$("screen-loading").hidden) {
        hideLoading();
    }
}

function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
            drawFrame(event.data).catch(() => {});
            return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "hello" || message.type === "run") {
            const hello = message.type === "hello";
            // What the Laya server holds: a Laya play loads its checkpoint, a distillation or a training (Laya taught, or its
            // check played) stops the server; after a reconnect (the server may have restarted) it is asked again.
            const r = message.run;
            if (r?.status === "running" && (r.kind === "distill" || r.kind === "train")) {
                state.warmed = null;
            } else if (r?.status === "running" && r.kind === "play" && /^laya\b/.test(r.engine || "")) {
                state.warmed = `${r.gameId}/${r.version ?? ""}`;
            } else if (hello) {
                state.warmed = null;
            }
            // A play joined in progress (the page opened, or connected again, while it runs): its games are the ones on the
            // screen, and the end of those still to end is said there.
            if (hello && r?.status === "running" && r.kind === "play" && ending.runId !== r.id) {
                ending.runId = r.id;
                ending.episodes = (r.episodes || []).length;
            }
            // A run that starts now clears the screen; joining one in progress keeps the frame it sent first.
            const fresh = message.type === "run" && message.run && message.run.id !== state.run?.id && message.run.status === "running";
            if (fresh) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                $("screen-empty").hidden = false;
                // Its games are the ones on the screen from now on: the end of each is said there.
                ending.runId = message.run.kind === "play" ? message.run.id : undefined;
                ending.episodes = 0;
                hideEnd();
                if (message.run.kind === "play") {
                    loading.runId = message.run.id;
                    showLoading(`Loading ${message.run.gameName}…`, message.run.phase);
                } else {
                    // Not a play: a loading screen left from one before (its failure) goes.
                    hideLoading();
                }
                state.tick = null;
                $("probabilities").innerHTML = "";
                $("choice").textContent = "–";
                if (message.run.kind === "train" || message.run.kind === "distill") {
                    showTab("training");
                } else {
                    showTab("episodes");
                }
            }
            // A hello (on every reconnect: the server may have restarted) is the run as the server has it now. It
            // replaces the one shown when that is the same run, one this page has as running, or none; a run in
            // progress shows too. Only a past run picked from the list stays.
            const wasRunning = running();
            const shown = message.run && (!hello || !state.run || message.run.id === state.run.id || wasRunning || message.run.status === "running");
            if (shown) {
                renderRun(message.run);
            }
            // A run ended: the lists and the status catch up (a distillation made Laya ready: not in 30 s), and a
            // loading screen for it goes (after a reconnect too).
            if (message.run && message.run.status !== "running" && (!hello || (shown && wasRunning))) {
                if (loading.runId === message.run.id) {
                    if (message.run.status === "failed") {
                        failLoading(message.run.error || message.run.phase);
                    } else {
                        hideLoading();
                        $("screen-empty").hidden = false;
                    }
                }
                loadRuns().catch(() => {});
                loadGames().catch(() => {});
                loadStatus().catch(() => {});
            }
            if (hello) {
                warmLaya();
            }
        } else if (message.type === "phase" && state.run?.id === message.id) {
            state.run.phase = message.phase;
            setPhase(`${state.run.gameName} — ${message.phase}`, "running");
            if (loading.runId === message.id) {
                setLoadingStep(message.phase);
            }
            renderSetup();
        } else if (message.type === "progress" && state.run?.id === message.id) {
            state.run.progress = message.progress;
            renderProgress();
            renderSetup();
        } else if (message.type === "tick" && state.run?.id === message.id) {
            // The game runs: its loading screen goes with the first tick too (a daemon without the live view sends no frame).
            if (loading.runId === message.id) {
                hideLoading();
            }
            // The play's next game runs: the end of the one before goes.
            if (state.run.status === "running") {
                hideEnd();
            }
            onTick(message.tick);
        } else if (message.type === "log" && state.run?.id === message.id) {
            state.run.log = [...(state.run.log || []), message.line];
            $("train-log").textContent = trainLogText(state.run);
            $("train-log").scrollTop = $("train-log").scrollHeight;
        } else if (message.type === "library") {
            loadGames().catch(() => {});
        }
    };
    ws.onclose = () => {
        setTimeout(connect, 1500);
    };
}

// ---------- controls ----------

function showError(err) {
    setPhase(err instanceof Error ? err.message : String(err), "failed");
}

/**
 * Laya chosen for a game it can play with the clock chosen: its local server starts now, not when Play is pressed, with
 * the checkpoint Play will take — for the version Play sends (the one the engine and clock chosen pin, else the one
 * Laya learnt). Not for a clock it cannot play with (unplayableOn: that version has no checkpoint): the server would
 * refuse the play. Once per game and version: the server keeps it, so a refresh after a run asks nothing again.
 */
function warmLaya() {
    const gameId = state.detail?.game?.id;
    if ($("engine").value !== "laya" || !gameId || gameId !== state.selected || unplayableOn("laya", $("pace").value === "realtime") || running()) {
        return;
    }
    const version = $("version").value || undefined;
    const key = `${gameId}/${version ?? ""}`;
    if (state.warmed === key) {
        return;
    }
    state.warmed = key;
    // Not started after all (a run began meanwhile, the server refused): asked again at the next change.
    const unwarmed = () => {
        if (state.warmed === key) {
            state.warmed = null;
        }
    };
    api("POST", "/api/laya/warm", { gameId, version })
        .then((answer) => {
            if (!answer.warming) {
                unwarmed();
            }
        })
        .catch(unwarmed);
}

$("engine").addEventListener("change", () => {
    // Picked here: the engine wanted for this game (a refresh keeps it), and for one opened later that names none.
    state.engineWanted = $("engine").value;
    remember("engine", $("engine").value);
    syncPace();
    syncVersion();
    renderRules();
    // A training is for the engine chosen here when the game names none: the Train button's, and the checklist's.
    renderButtons();
    renderSetup();
    warmLaya();
});

/**
 * Keys that pass a list by: Tab through the form, a modifier alone, Escape. Using the list is any other — Space, the
 * arrows or Alt+Down open it, a letter picks by name — but Enter, its form's: Play (on macOS), the wizard's Next.
 */
const PASSING_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "Escape"]);

/**
 * Picking the engine the list already shows — a fallback, the one wanted not able to play — sends no change: the list
 * used, pressed with the pointer or a key that does not pass it by (nor Enter), takes the engine it shows as picked, as
 * the wizard's key list takes its key. The same one picked is not told apart from the list closed again (macOS's list
 * sends nothing once it is open); another picked follows with a change.
 */
function pickShown() {
    const shown = $("engine").value;
    if (!shown || shown === wantedEngine()) {
        return;
    }
    state.engineWanted = shown;
    remember("engine", shown);
    // The engine shown is unchanged (its clocks, version, rules and checkpoint with it): what follows the one wanted.
    renderButtons();
    renderSetup();
}

$("engine").addEventListener("pointerdown", (event) => {
    if (event.button === 0) {
        pickShown();
    }
});
$("engine").addEventListener("keydown", (event) => {
    // A shortcut held with Ctrl or Cmd is not the list's (Alt+Down opens it).
    if (event.key !== "Enter" && !PASSING_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey) {
        pickShown();
    }
});

$("pace").addEventListener("change", () => {
    syncVersion();
    renderRules();
    // Train acts on the clock chosen (Jev only paused).
    renderButtons();
    // Another clock may pin another version, and so another checkpoint.
    warmLaya();
});

$("version").addEventListener("change", () => {
    // Picked: kept. One the engine cannot play (the rules one without them as code) is no pick, and moves to one it can.
    const picked = $("version").selectedOptions[0];
    if (picked && !picked.disabled) {
        state.versionChosen = picked.value || null;
    }
    syncVersion();
    renderRules();
});

$("play-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    // The engine wanted, not a fallback the list shows while that one cannot play (it plays, and is not kept).
    rememberWanted();
    // At once, before the server answers: the click did something.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    loading.runId = "starting";
    showLoading(`Loading ${state.detail?.game?.name ?? "the game"}…`, "starting");
    try {
        const { run } = await api("POST", "/api/runs", {
            gameId: state.selected,
            version: $("version").value || undefined,
            episodes: $("episodes").value,
            gameSeconds: $("seconds").value,
            seed: $("seed").value,
            pace: $("pace").value,
            engine: $("engine").value,
        });
        if (loading.runId === "starting") {
            loading.runId = run.id;
        }
        renderStarted(run);
        showTab("episodes");
    } catch (err) {
        failLoading(err instanceof Error ? err.message : String(err));
        showError(err);
    }
});

/**
 * A run the server has just started, from its answer to the request: the websocket usually brings it
 * first, and newer (its phase moved on, it may even have ended) — that copy stays.
 */
function renderStarted(run) {
    if (run.kind !== "play" && !$("screen-loading").hidden) {
        // Not a play: a loading screen left from one before (its failure) goes, the websocket's copy or not.
        hideLoading();
        $("screen-empty").hidden = false;
    }
    if (state.run?.id !== run.id) {
        renderRun(run);
    }
}

$("train").addEventListener("click", async () => {
    // As Play: the engine wanted, never a fallback shown.
    rememberWanted();
    await trainChosen();
});

/**
 * Train with what is chosen above: the engine wanted, the clock, the version the Profile select plays (the engine shown
 * being the one wanted: a fallback's is not its), Train iterations and the notes for the trainer.
 */
async function trainChosen() {
    const engine = trainEngine();
    const version = engine === $("engine").value ? Number($("version").value) || undefined : undefined;
    await startTrain(engine, Number($("iterations").value) || 3, liveChosen(), trainerNotes(), version);
}

/** The notes for the trainer written beside Train: kept per game on this browser as they are typed. */
function trainerNotes() {
    return $("train-note").value.trim();
}

$("train-note").addEventListener("input", () => {
    if (state.selected) {
        remember(`trainNote.${state.selected}`, $("train-note").value);
    }
});

// Enter in a field of the play form is Play (its submit button), but Train iterations is Train's field: Enter there
// presses Train — nothing while Train is disabled, as a disabled Play takes no Enter — and never Play. Once per press:
// a key held down repeats.
$("iterations").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat) {
            $("train").click();
        }
    }
});

/**
 * The Training tab's text for a run: a checked training's summary first (what it found and did), then the log — and a
 * run that ended before its first line says why here too, not in the Episodes tab only.
 */
function trainLogText(run) {
    const summary = run.improve ? [...checkSummary(run.improve), ""] : [];
    const lines = [...summary, ...(run.log || []), ...(run.status !== "running" && run.error ? [`✗ ${run.error}`] : [])];
    return lines.join("\n") || (run.status === "running" ? "Starting…" : run.phase);
}

/** A checked training in a few lines: each check (the engine's mean per seed, its rules' beside it), the outcome, what was done. */
function checkSummary(improve) {
    const seeds = (check) =>
        Object.keys(check.played)
            .map(
                (s) =>
                    `${s}: ${check.played[s]}${check.slow?.[s] !== undefined ? ` (at the slow end ${check.slow[s]})` : ""}${check.rules?.[s] !== undefined ? ` · rules ${check.rules[s]}` : ""}`
            )
            .join(", ");
    const lines = [`Checked: ${improve.engine}, the clock ${improve.live ? "running" : "paused"}`];
    if (improve.before) {
        lines.push(
            `  before (v${improve.before.version}): ${seeds(improve.before)} — ${improve.before.verdict === "nothing" ? "nothing played worse: trained for a higher score" : `to fix: ${improve.before.verdict === "rules" ? "the rules" : improve.engine}`}`
        );
    }
    if (improve.after) {
        lines.push(`  after (v${improve.after.version}): ${seeds(improve.after)}`);
    }
    if (improve.outcome) {
        lines.push(`  ${improve.outcome}${improve.done?.length ? ` — ${improve.done.join("; ")}` : ""}`);
    }
    return lines;
}

/** A distillation of the game shown: of `version` (one the live clock plays), else of the active version. */
async function startDistill(version) {
    try {
        const { run } = await api("POST", "/api/runs", { kind: "distill", gameId: state.selected, rounds: 1, ...(version !== undefined ? { version } : {}) });
        renderStarted(run);
        showTab("training");
    } catch (err) {
        showError(err);
    }
}

$("stop").addEventListener("click", () => {
    api("POST", "/api/runs/stop").catch(showError);
});

function showTab(name) {
    for (const button of document.querySelectorAll(".tabs button")) {
        button.classList.toggle("active", button.dataset.tab === name);
    }
    for (const tab of document.querySelectorAll(".tab")) {
        tab.hidden = tab.id !== `tab-${name}`;
    }
    if (name === "runs") {
        loadRuns().catch(() => {});
    }
}

document.querySelector(".tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) {
        showTab(button.dataset.tab);
    }
});

// ---------- the trainer: which coding-agent CLI, which of its models (one choice for all games) ----------

const trainer = { settings: null, asking: false, keep: false };

/** The provider the dialog shows. */
function trainerProvider() {
    return (trainer.settings?.providers || []).find((p) => p.provider === $("trainer-provider").value);
}

/** The models of the provider shown: the one in use when it is the provider in use, else its default. */
function renderTrainerModels() {
    const s = trainer.settings;
    const p = trainerProvider();
    const models = p?.models || [];
    const wanted = p?.provider === s.provider && models.some((m) => m.id === s.model) ? s.model : (models.find((m) => m.default) || models[0])?.id;
    // An alias by the model it stands for, named as a person reads it: "Opus 5.5" (the alias alone until the CLI has said).
    const picked = models.some((m) => m.id === $("trainer-model").value) && trainer.keep ? $("trainer-model").value : wanted;
    $("trainer-model").innerHTML = models
        .map((m) => `<option value="${esc(m.id)}"${m.id === picked ? " selected" : ""}>${esc(m.answeredByName || m.name)}${m.default ? " (default)" : ""}</option>`)
        .join("");
    renderTrainerEfforts();
}

/** The effort levels of the model shown: the one in use when it is the model in use, else none (its CLI's own default). */
function renderTrainerEfforts() {
    const s = trainer.settings;
    const p = trainerProvider();
    const model = (p?.models || []).find((m) => m.id === $("trainer-model").value);
    const efforts = model?.efforts || [];
    const inUse = p?.provider === s.provider && model?.id === s.model ? s.effort || "" : "";
    const picked = trainer.keep && ["", ...efforts].includes($("trainer-effort").value) ? $("trainer-effort").value : efforts.includes(inUse) ? inUse : "";
    // None is the CLI's own choice: named where the CLI says what that is (Codex lists each model's).
    const own = model?.defaultEffort ? `The model's own (${model.defaultEffort})` : "The CLI's own";
    $("trainer-effort").innerHTML = [`<option value=""${picked === "" ? " selected" : ""}>${esc(own)}</option>`, ...efforts.map((e) => `<option value="${esc(e)}"${e === picked ? " selected" : ""}>${esc(e)}</option>`)].join("");
    renderTrainerDetail();
}

function renderTrainerDetail() {
    const s = trainer.settings;
    const p = trainerProvider();
    const locked = s.fromEnv ? " Named by the environment (IBGAMER_TRAINER_PROVIDER / IBGAMER_TRAINER_MODEL / IBGAMER_TRAINER_EFFORT): start the app without them to choose it here." : "";
    // Claude Code's names are aliases, each its family's latest model: which one, as the CLI says (asked when this opens).
    const model = (p?.models || []).find((m) => m.id === $("trainer-model").value);
    const alias =
        p?.provider !== "claude-code" || !model
            ? ""
            : model.answeredBy
              ? ` “${model.id}” is ${model.answeredBy} now: the latest ${model.name} this CLI knows.`
              : trainer.asking
                ? ` Asking the CLI which model “${model.id}” stands for…`
                : ` “${model.id}” is the latest ${model.name} this CLI knows.`;
    $("trainer-detail").textContent = p ? `${p.ok ? `Installed: ${p.detail}.` : `Not installed: ${p.detail}.`} ${p.reads}${alias}${locked}` : "";
    $("trainer-provider").disabled = s.fromEnv;
    $("trainer-model").disabled = s.fromEnv || !p?.ok;
    $("trainer-effort").disabled = s.fromEnv || !p?.ok;
    const same = p?.provider === s.provider && $("trainer-model").value === s.model && $("trainer-effort").value === (s.effort || "");
    $("trainer-save").disabled = s.fromEnv || !p?.ok || same || !$("trainer-model").value;
}

async function openTrainer() {
    $("trainer-error").textContent = "";
    trainer.settings = await api("GET", "/api/trainer");
    const s = trainer.settings;
    $("trainer-provider").innerHTML = s.providers
        .map((p) => `<option value="${esc(p.provider)}"${p.provider === s.provider ? " selected" : ""}>${esc(p.label)}${p.ok ? "" : " — not installed"}</option>`)
        .join("");
    renderTrainerModels();
    $("trainer-dialog").showModal();
    // Which models Claude Code's aliases stand for: the CLI is asked (a second or two) when one is not known, or it was
    // last asked a week ago; the list and the pill follow.
    if (s.aliasesDue && !trainer.asking) {
        trainer.asking = true;
        renderTrainerDetail();
        api("POST", "/api/trainer/models")
            .then((settings) => {
                trainer.settings = settings;
            })
            .catch(() => {})
            .finally(() => {
                trainer.asking = false;
                // What is picked in the dialog stays picked.
                trainer.keep = true;
                renderTrainerModels();
                trainer.keep = false;
                loadStatus().catch(() => {});
            });
    }
}

$("status").addEventListener("click", (event) => {
    if (event.target.closest("[data-trainer]")) {
        openTrainer().catch(showError);
    }
});
$("trainer-provider").addEventListener("change", renderTrainerModels);
$("trainer-model").addEventListener("change", renderTrainerEfforts);
$("trainer-effort").addEventListener("change", renderTrainerDetail);
$("trainer-close").addEventListener("click", () => $("trainer-dialog").close());
$("trainer-save").addEventListener("click", async () => {
    $("trainer-error").textContent = "";
    $("trainer-save").disabled = true;
    try {
        trainer.settings = await api("POST", "/api/trainer", { provider: $("trainer-provider").value, model: $("trainer-model").value, effort: $("trainer-effort").value || null });
        await loadStatus();
        $("trainer-dialog").close();
    } catch (err) {
        $("trainer-error").textContent = err.message;
        renderTrainerDetail();
    }
});

// ---------- adding a game: a guided flow ----------

const add = {
    step: 1,
    probe: null,
    screenshot: null,
    target: null,
    click: null,
    reader: null,
    readerJob: null,
    readerStart: null,
    /** What the trainer's reader filled in, or did not, in words. */
    readerNote: "",
    /** The trainer's reader being written now: since when, and the step it is on (null: none is). */
    reading: null,
    /** Counts the reader's runs: one stopped, or begun again, is no longer the current one. */
    readerRun: 0,
    /** A start or a score chosen here (in this dialog), How to play written here: the reader's is not put over it. */
    startTouched: false,
    scoreTouched: false,
    goalTouched: false,
};

/** Whether this app can read the page's game, and how, in words. */
function verdictOf(probe) {
    if (probe.suggested === "phaser") {
        return { ok: true, text: "A Phaser game: the engine's own objects are read every step." };
    }
    if (probe.suggested === "pixi") {
        return { ok: true, text: "A PixiJS game: the display objects it renders are read every step." };
    }
    if (probe.suggested === "cocos") {
        return { ok: true, text: "A Cocos game: the scene the engine runs is read every step." };
    }
    if (probe.suggested === "three") {
        return { ok: true, text: "A Three.js game: its 3D scene — the objects near the camera, where each shows — and the page's text over it are read every step. Its own state is sharper: let the trainer read the game's code below." };
    }
    if (probe.suggested === "canvas2d") {
        return { ok: true, text: "Drawn on a 2D canvas: what it draws is recorded every step." };
    }
    if (probe.suggested === "pixels") {
        const canvas = gameCanvas(probe);
        const how = canvas && /webgl/i.test(canvas.context || "")
            ? `Drawn with WebGL${probe.engines.length ? ` by ${probe.engines.join(", ")}` : ""}, by an engine without an adapter`
            : "A canvas no adapter reads (nothing was drawn on it while the page was looked at)";
        return { ok: true, text: `${how}: it can be read by its pixels — a small colour grid each step, works for anything, less exact — or better, let the trainer read the game's code below.` };
    }
    const main = gameCanvas(probe);
    const webgl = main ? /webgl/i.test(main.context || "") : probe.canvases.some((c) => /webgl/i.test(c.context || ""));
    if (webgl) {
        return { ok: false, text: `Drawn with WebGL${probe.engines.length ? ` by ${probe.engines.join(", ")}` : ""}, by an engine this app does not read directly (it reads Phaser, PixiJS, Cocos, Three.js and 2D canvases). Let the trainer read the game's code below.` };
    }
    if (!probe.canvases.length) {
        return { ok: false, text: "No canvas on this page: the game may be made of page elements, or sit in a frame from another site (open the frame's own address instead)." };
    }
    return { ok: false, text: "There is a canvas, but nothing was drawn on it while the page was looked at: the game may need a click to load, or it draws with WebGL." };
}

/** The canvas the game is most likely on: the largest one. */
function gameCanvas(probe) {
    return [...probe.canvases].filter((c) => c.box && c.box.width > 0).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0] || null;
}

/**
 * What the game's clicks land on (its clickTarget: game_step clicks fractions of that element's box) and where
 * it is: the game's canvas — named only when it is not the first one, which is the default —, else the page
 * body. None when the body has no size (what it shows is placed out of its flow) or the probe gives no body:
 * no element's box is the picture's then, and no click start is picked. The page reader checks a start it
 * found by the same rule (clickTargetFor in src/reader/page-reader.ts): keep the two alike.
 */
function clickTargetOf(probe) {
    const main = gameCanvas(probe);
    if (main) {
        return { selector: main === probe.canvases[0] ? null : main.selector || null, box: main.box };
    }
    const body = probe.body;
    return body && body.width > 0 && body.height > 0 ? { selector: "body", box: body } : null;
}

/** The box (page CSS pixels) a start click is picked on, as a fraction of it: the click target's; null when there is none. */
function clickBox() {
    return add.target?.box || null;
}

const NO_CLICK_TARGET = "Nothing on this page takes a start click: it has no canvas, and its body has no size. Choose a key, or that it starts by itself.";

function showStep(step) {
    add.step = step;
    for (const section of document.querySelectorAll("#add-form .step")) {
        section.hidden = Number(section.dataset.step) !== step;
    }
    for (const li of document.querySelectorAll("#add-steps li")) {
        const n = Number(li.dataset.step);
        li.className = n === step ? "current" : n < step ? "done" : "";
    }
    $("add-back").hidden = step === 1;
    $("add-next").hidden = step === 4;
    $("add-save").hidden = step !== 4;
    $("add-error").textContent = "";
    if (step === 2) {
        // The picture again, here to click the start button on.
        $("add-start-shot").replaceChildren($("add-shot-wrap"));
        $("add-shot-wrap").classList.add("pickable");
    } else if (step === 1) {
        document.querySelector('#add-form .step[data-step="1"]').append($("add-shot-wrap"));
        $("add-shot-wrap").classList.remove("pickable");
    }
    if (step === 4) {
        const engines = state.status?.engines || {};
        // A new game needs only Laya's Python: its checkpoint comes with the distillation (Laya's own readiness is
        // whether a game has one to play).
        const python = engines.laya?.python;
        $("add-laya-status").textContent = python ? (python.ok ? "Ready on this machine." : `Not ready: ${python.detail}`) : "";
        $("add-jev-status").textContent = engines.jev ? (engines.jev.ok ? "Key configured." : `Not ready: ${engines.jev.detail}`) : "";
        const chosen = document.querySelector('input[name="add-engine"]:checked');
        if (!chosen) {
            document.querySelector(`input[name="add-engine"][value="${python?.ok || !engines.jev?.ok ? "laya" : "jev"}"]`).checked = true;
        }
        syncAddTrainLive();
    }
    // A reader still being written is said on the steps after the first (on the first, its own line says it).
    renderReaderNote();
    renderNext();
}

/** The wizard's "…for real time" box: not for Jev, whose hundreds of ms no game is played live with (as beside Train). */
function syncAddTrainLive() {
    const jev = addEngine() === "jev";
    $("add-train-live").disabled = jev;
    if (jev) {
        $("add-train-live").checked = false;
    }
}

for (const radio of document.querySelectorAll('input[name="add-engine"]')) {
    radio.addEventListener("change", syncAddTrainLive);
}

/**
 * A number field's value against its own min and max: { value } (`fallback` when it is empty) or { problem }, in
 * words. The form leaves checking to these (novalidate): the browser, finding a refused value in a step already
 * left, would drop "Add the game" with nothing said but a line in the console.
 */
function numberField(id, label, unit, fallback, whole) {
    const input = $(id);
    const text = input.value.trim();
    if (!input.validity.badInput && text === "") {
        return { value: fallback };
    }
    const n = Number(text);
    const min = Number(input.min);
    const max = Number(input.max);
    if (input.validity.badInput || !Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
        return { problem: `${label} must be a ${whole ? "whole " : ""}number${unit ? ` of ${unit}` : ""} from ${min} to ${max}.` };
    }
    return { value: n };
}

/** Whether a step can go on, and — for a value it holds that is refused — why not, in words; a field still empty only waits. */
function stepCheck(step) {
    if (step === 1) {
        if (!add.probe) {
            return { ok: false, problem: "", wait: "Next waits for the page: open it and look at it first." };
        }
        const ok = Boolean(verdictOf(add.probe).ok || add.reader);
        const wait = ok ? "" : add.reading ? "Next waits for the trainer's reader: this page is not read as it is drawn." : "Next waits for a reader: let the trainer read the game's code.";
        return { ok, problem: "", wait };
    }
    if (step === 2) {
        const load = numberField("add-load", "Loading time", "seconds", 0, false);
        if (load.problem) {
            return { ok: false, problem: load.problem };
        }
        if (startChoice() === "click" && !add.click && !clickBox()) {
            return { ok: false, problem: NO_CLICK_TARGET };
        }
        const picked = startChoice() !== "click" || Boolean(add.click);
        return { ok: picked, problem: "", wait: picked ? "" : "Next waits for the start: click the picture where the game is started." };
    }
    if (step === 3) {
        const id = $("add-id").value.trim();
        if (id && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
            return { ok: false, problem: "The id is lowercase letters, digits and dashes (at most 63), starting with a letter or a digit." };
        }
        const seconds = numberField("add-seconds", "Seconds per game", "", 60, true);
        if (seconds.problem) {
            return { ok: false, problem: seconds.problem };
        }
        // Chosen, the expression is the score: an empty one would be saved as the trainer's reading, with nothing said.
        if (scoreChoice() === "expression" && !$("add-score").value.trim()) {
            return { ok: false, problem: "Write the page expression for the score, or let the trainer read the score from what it perceives." };
        }
        // Written, then the trainer's reading chosen: the expression would be left out, with nothing said.
        if (scoreChoice() === "state" && $("add-score").value.trim()) {
            return { ok: false, problem: "A page expression is written, but the trainer's reading is chosen: choose the expression, or empty its field." };
        }
        // A field still empty only waits — said, so a Next that stays grey has a reason.
        const missing = [
            ...($("add-name").value.trim() ? [] : ["Name"]),
            ...(id ? [] : ["Id"]),
            ...($("add-goal").value.trim() ? [] : ["How to play"]),
        ];
        return { ok: missing.length === 0, problem: "", wait: missing.length ? `Next waits for: ${missing.join(", ")}.` : "" };
    }
    const trainNow = $("add-train-now").checked;
    const iterations = trainNow ? numberField("add-iterations", "Training iterations", "", 3, true) : {};
    if (iterations.problem) {
        return { ok: false, problem: iterations.problem };
    }
    const refusal = trainNow ? trainRefusal(addEngine()) : "";
    if (refusal) {
        return { ok: false, problem: `${refusal} Uncheck “Start training now” to add the game, and train it once that is ready.` };
    }
    // Asked for, the reader is how the game is read: added before it answered, the game would be read as it is drawn, unsaid.
    return add.reading
        ? { ok: false, problem: "", wait: "“Add the game” waits for the trainer's reader of this game (step 1 shows how far it is, and can stop it)." }
        : { ok: true, problem: "" };
}

function renderNext() {
    const check = stepCheck(add.step);
    $("add-next").disabled = !check.ok;
    $("add-save").disabled = add.step === 4 && !check.ok;
    $("add-invalid").textContent = check.problem;
    $("add-invalid").hidden = !check.problem;
    // What a grey Next (or Add) waits for, when nothing it holds is refused.
    const wait = check.problem ? "" : check.wait || "";
    $("add-wait").textContent = wait;
    $("add-wait").hidden = !wait;
}

/** Minutes and seconds since `since`, as m:ss. */
function elapsed(since) {
    const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What the trainer's reader filled into the later steps, or left: shown on every step once it has answered — and, while
 * it is still being written, that it is (the steps after the first go on meanwhile).
 */
function renderReaderNote() {
    const reading =
        add.reading && add.step > 1
            ? `The trainer is still reading the game's code (${elapsed(add.reading.since)}). Go on meanwhile: what it finds is filled in where nothing was chosen here, and “Add the game” waits for it.`
            : "";
    $("add-reader-note").textContent = reading || add.readerNote;
    $("add-reader-note").hidden = !(reading || add.readerNote);
}

const READ_LABEL = $("add-read").textContent;

/** The trainer's reader being written, said as it goes: the step it is on and its time so far (it takes minutes). */
function renderReading() {
    const reading = add.reading;
    $("add-reading").hidden = !reading;
    $("add-read-stop").hidden = !reading;
    $("add-read").textContent = reading ? "Reading the game's code…" : READ_LABEL;
    if (reading) {
        const step = reading.phase ? reading.phase.charAt(0).toUpperCase() + reading.phase.slice(1) : "Starting";
        $("add-reading-text").textContent = `${step} · ${elapsed(reading.since)}`;
    }
    renderReaderNote();
}

function startReading() {
    clearInterval(add.readingTimer);
    add.reading = { since: Date.now(), phase: "" };
    add.readingTimer = setInterval(renderReading, 1000);
    renderReading();
    renderNext();
}

function stopReading() {
    clearInterval(add.readingTimer);
    add.readingTimer = undefined;
    add.reading = null;
    renderReading();
}

function startChoice() {
    return document.querySelector('input[name="add-start"]:checked')?.value || "none";
}

function scoreChoice() {
    return document.querySelector('input[name="add-score"]:checked')?.value || "state";
}

/** The engine chosen in the last step (the game's preferredEngine). */
function addEngine() {
    return document.querySelector('input[name="add-engine"]:checked')?.value || "laya";
}

/**
 * A new look at a page, or a new game: nothing found for the page before stays — its probe, the trainer's reader
 * and what it filled in, the start picked on its picture — and a reader still being written for it is not waited for.
 * What was chosen here stays. Next waits for the new look.
 */
function forgetPage() {
    if (add.readerStart) {
        document.querySelector('input[name="add-start"][value="none"]').checked = true;
    }
    if (add.reader?.score && !add.scoreTouched && $("add-score").value === add.reader.score) {
        $("add-score").value = "";
        document.querySelector('input[name="add-score"][value="state"]').checked = true;
    }
    if (add.reader?.goal && !add.goalTouched && $("add-goal").value === add.reader.goal) {
        $("add-goal").value = "";
    }
    Object.assign(add, { probe: null, screenshot: null, target: null, click: null, reader: null, readerJob: null, readerStart: null, readerNote: "" });
    add.readerRun++;
    stopReading();
    $("add-reader").hidden = true;
    $("add-reader-status").textContent = "";
    $("add-reader-sample").hidden = true;
    $("add-shot-wrap").hidden = true;
    $("add-click-mark").hidden = true;
    renderReaderStart();
    renderReaderNote();
    renderNext();
}

// ---------- the Hugging Face library: games trained and shared, downloaded trained ----------

/** What this library has of a shared game, in words (the server's LocalState). */
const HF_STATE_TEXT = {
    missing: "Not in your library",
    "built-in": "In your library, not trained here",
    installed: "Downloaded · up to date",
    update: "Downloaded · a newer one is shared",
    local: "Trained in your library",
};

/** The button a shared game offers, by what this library has of it (none: up to date). */
const HF_ACTION = {
    missing: "⇩ Download",
    "built-in": "⇩ Download trained",
    update: "⇩ Update",
    local: "⇩ Replace with the shared one",
};

let hfPoll = null;

function hfPulling(game) {
    return Boolean(game.pull) && (game.pull.phase === "downloading" || game.pull.phase === "installing");
}

/** How a shared game plays: Laya and Jev, each version with its mean. */
function hfPlays(game) {
    return game.plays
        .filter((p) => p.engine === "laya" || p.engine === "jev")
        .map((p) => `${p.engine === "laya" ? "Laya" : "Jev"}${p.live ? " live" : ""}${p.version !== undefined ? ` v${p.version}` : ""}${p.mean !== undefined ? `: ${Number.isInteger(p.mean) ? p.mean : p.mean.toFixed(1)} ${game.scoreLabel}` : ""}`)
        .join(" · ");
}

function hfAction(game) {
    if (hfPulling(game)) {
        const pct = game.pull.totalBytes ? Math.floor((100 * game.pull.doneBytes) / game.pull.totalBytes) : 0;
        return `<span class="muted">${game.pull.phase === "installing" ? "Installing…" : `Downloading · ${pct}%`}</span><span class="bar-track small"><span style="width:${pct}%"></span></span>`;
    }
    const failed = game.pull?.phase === "failed" ? `<span class="error">${esc(game.pull.error)}</span>` : "";
    // Training of this library's own is replaced only once asked again, here (no browser dialog).
    if (state.hfConfirm === game.id) {
        return `<span class="muted">Replace ${esc(game.name)}'s versions and Laya models here? Its decision logs stay.</span><span class="row-buttons"><button type="button" class="secondary" data-hf-cancel="1">Cancel</button><button type="button" data-hf-replace="${esc(game.id)}">Replace</button></span>${failed}`;
    }
    const label = HF_ACTION[game.state];
    return `${label ? `<button type="button" class="secondary" data-hf-pull="${esc(game.id)}">${label}</button>` : `<span class="muted">✓ Up to date</span>`}${failed}`;
}

function renderHf() {
    const d = state.hf;
    $("hf-repo").textContent = d ? `${d.repo}${d.updatedAt ? ` · updated ${d.updatedAt.slice(0, 16).replace("T", " ")}` : ""}` : "Reading…";
    $("hf-error").textContent = d?.error || "";
    const games = d?.games || [];
    $("hf-list").innerHTML = games.length
        ? games
              .map(
                  (g) => `<div class="hf-game">
            <img src="/api/hf/${esc(g.id)}/thumbnail" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <div><b>${esc(g.name)}</b> <span class="muted">${esc(g.id)} · ${Math.round(g.size / 1e6)} MB</span>
                <div class="muted">${esc(hfPlays(g))}</div>
                <div class="muted">${esc(HF_STATE_TEXT[g.state] || g.state)}</div></div>
            <div class="hf-action">${hfAction(g)}</div>
        </div>`
              )
              .join("")
        : d && !d.error
          ? `<p class="muted">Nothing is shared yet.</p>`
          : "";
}

/** Reads the shared library (again, past the server's minute, when `refresh`); polled while a pull goes on. */
async function loadHf(refresh = false) {
    clearTimeout(hfPoll);
    try {
        state.hf = await api("GET", `/api/hf${refresh ? "?refresh=1" : ""}`);
    } catch (err) {
        state.hf = { repo: state.hf?.repo || "", games: state.hf?.games || [], error: err.message };
    }
    renderHf();
    if ($("hf-dialog").open && state.hf.games.some(hfPulling)) {
        hfPoll = setTimeout(() => loadHf(), 1500);
    }
}

async function startHfPull(id, replace) {
    state.hfConfirm = null;
    try {
        await api("POST", "/api/hf/pull", { gameId: id, replace });
    } catch (err) {
        $("hf-error").textContent = err.message;
    }
    await loadHf();
}

$("hf-open").addEventListener("click", () => {
    state.hfConfirm = null;
    $("hf-dialog").showModal();
    renderHf();
    loadHf();
});
$("hf-close").addEventListener("click", () => $("hf-dialog").close());
$("hf-refresh").addEventListener("click", () => loadHf(true));
$("hf-dialog").addEventListener("close", () => clearTimeout(hfPoll));
$("hf-list").addEventListener("click", (event) => {
    const pull = event.target.closest("[data-hf-pull]");
    const replace = event.target.closest("[data-hf-replace]");
    if (event.target.closest("[data-hf-cancel]")) {
        state.hfConfirm = null;
        renderHf();
    } else if (replace) {
        startHfPull(replace.dataset.hfReplace, true);
    } else if (pull) {
        const game = state.hf?.games.find((g) => g.id === pull.dataset.hfPull);
        if (game?.state === "local") {
            state.hfConfirm = game.id;
            renderHf();
        } else {
            startHfPull(pull.dataset.hfPull, false);
        }
    }
});

$("add-game").addEventListener("click", () => {
    forgetPage();
    $("add-form").reset();
    add.startTouched = false;
    add.scoreTouched = false;
    add.goalTouched = false;
    $("add-verdict").hidden = true;
    showStep(1);
    $("add-dialog").showModal();
});

$("add-cancel").addEventListener("click", () => $("add-dialog").close());
$("add-back").addEventListener("click", () => showStep(add.step - 1));
$("add-next").addEventListener("click", () => showStep(add.step + 1));
$("add-form").addEventListener("input", renderNext);
$("add-form").addEventListener("change", renderNext);
// What was found is for the address it was looked at with: another one is looked at afresh.
$("add-url").addEventListener("input", () => {
    if (add.probe) {
        forgetPage();
        $("add-verdict").hidden = true;
    }
});

$("add-probe").addEventListener("click", async () => {
    const url = $("add-url").value.trim();
    if (!/^https?:\/\//.test(url)) {
        $("add-error").textContent = "Enter the game's http(s) address.";
        return;
    }
    // A new look: what was found for the page before goes (the trainer's reader, the start picked on its picture).
    forgetPage();
    $("add-probe").disabled = true;
    $("add-verdict").hidden = false;
    $("add-verdict").className = "verdict";
    $("add-verdict").textContent = "Opening the page and looking at it (a few seconds)…";
    // Another address entered meanwhile, or the dialog opened afresh: this look is not for it.
    const stale = () => $("add-url").value.trim() !== url;
    try {
        const { probe, screenshot } = await api("POST", "/api/probe", { url });
        if (stale()) {
            $("add-verdict").hidden = true;
            return;
        }
        add.probe = probe;
        add.screenshot = screenshot || null;
        add.target = clickTargetOf(probe);
        const verdict = verdictOf(probe);
        $("add-verdict").className = `verdict ${verdict.ok ? "ok" : "bad"}`;
        $("add-verdict").textContent = `${verdict.ok ? "✓" : "✗"} ${verdict.text}`;
        if (screenshot) {
            $("add-shot").src = `${screenshot}?t=${Date.now()}`;
            $("add-shot-wrap").hidden = false;
            const vw = probe.viewport?.width || 1280;
            const vh = probe.viewport?.height || 720;
            // The framed area: where a start click is picked (the game's canvas, else the page body; none without either).
            const b = clickBox();
            $("add-canvas-box").hidden = !b;
            if (b) {
                Object.assign($("add-canvas-box").style, { left: `${(100 * b.x) / vw}%`, top: `${(100 * b.y) / vh}%`, width: `${(100 * b.width) / vw}%`, height: `${(100 * b.height) / vh}%` });
            }
        }
        $("add-reader").hidden = false;
        $("add-read").disabled = !state.status?.trainer?.ok;
        if (!state.status?.trainer?.ok) {
            $("add-reader-status").textContent = `The trainer is not available: ${state.status?.trainer?.detail || "no coding-agent CLI was found"}.`;
        }
        if (!$("add-name").value && probe.title) {
            $("add-name").value = probe.title.slice(0, 60);
        }
        if (!$("add-id").value) {
            try {
                const u = new URL(url);
                const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname.split(".")[0];
                $("add-id").value = last.toLowerCase().replace(/\.html?$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
            } catch {
                // not a URL
            }
        }
    } catch (err) {
        $("add-verdict").className = "verdict bad";
        $("add-verdict").textContent = err.message;
        $("add-verdict").hidden = stale();
    } finally {
        $("add-probe").disabled = false;
        renderNext();
    }
});

// Step 1, the other way in: the trainer reads the page's code and writes a reader for the game's own state.
$("add-read").addEventListener("click", async () => {
    // The reader is for the page looked at now: after a new look, another address or the dialog opened afresh,
    // its job is no longer the current one, and what it answers is left unread.
    const probe = add.probe;
    const run = ++add.readerRun;
    let id = null;
    const current = () => add.probe === probe && add.readerRun === run && add.readerJob === id;
    add.readerJob = null;
    $("add-read").disabled = true;
    $("add-reader-sample").hidden = true;
    $("add-reader-status").textContent = "";
    startReading();
    try {
        const { reader } = await api("POST", "/api/reader", { url: $("add-url").value.trim(), ...(probe?.viewport ? { viewport: probe.viewport } : {}) });
        if (!current()) {
            return;
        }
        id = reader.id;
        add.readerJob = id;
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (!current()) {
                return;
            }
            const { reader: job } = await api("GET", `/api/reader/${encodeURIComponent(id)}`);
            if (!current()) {
                return;
            }
            if (job.status === "running") {
                add.reading.phase = job.phase;
                renderReading();
                continue;
            }
            if (job.status === "failed") {
                throw new Error(job.error || "the trainer could not write a reader");
            }
            add.reader = job.result;
            $("add-reader-status").textContent = `✓ The trainer wrote a reader for the game's own state${job.result.notes ? `: ${job.result.notes}` : "."}`;
            $("add-reader-sample").textContent = `${job.result.format}\n\n${JSON.stringify(job.result.samples[job.result.samples.length - 1], null, 1)}`;
            $("add-reader-sample").hidden = false;
            applyReaderStart(job.result);
            return;
        }
    } catch (err) {
        if (current()) {
            $("add-reader-status").textContent = `✗ ${err.message}`;
        }
    } finally {
        if (current()) {
            stopReading();
            $("add-read").disabled = false;
            renderNext();
        }
    }
});

// Stopped, the reader is no longer waited for: what it answers is left unread (the trainer ends by itself), and the game
// is read as it is drawn unless its code is read again.
$("add-read-stop").addEventListener("click", () => {
    add.readerRun++;
    add.readerJob = null;
    stopReading();
    $("add-read").disabled = !state.status?.trainer?.ok;
    $("add-reader-status").textContent = add.reader
        ? "Stopped: the reader the trainer wrote before is kept."
        : "Stopped: the game is read as it is drawn, unless the trainer reads its code again.";
    renderNext();
});

/**
 * What the trainer found in the code about starting a game and the score, filled into the later steps — where
 * nothing was chosen yet: it may answer while those steps are open, and a choice made here is never replaced
 * (the note says what was left out). Its start is saved as it found it, every step, unless another start is
 * chosen here (step 2 shows its first press or click).
 */
function applyReaderStart(reader) {
    const filled = [];
    const left = [];
    if (add.startTouched) {
        if (reader.start?.length) {
            left.push(`a start (${reader.start.map((s) => JSON.stringify(s)).join(", then ")})`);
        }
    } else {
        add.readerStart = reader.start?.length ? reader.start : null;
        const first = (reader.start || []).find((s) => s.press || s.click);
        if (first?.press) {
            const key = first.press[0];
            if (![...$("add-start-key").options].some((o) => o.value === key)) {
                $("add-start-key").add(new Option(key, key));
            }
            $("add-start-key").value = key;
            document.querySelector('input[name="add-start"][value="key"]').checked = true;
        } else if (first?.click) {
            // `click: true` is the centre.
            const at = typeof first.click === "object" ? first.click : { x: 0.5, y: 0.5 };
            add.click = at;
            document.querySelector('input[name="add-start"][value="click"]').checked = true;
            const vw = add.probe?.viewport?.width || 1280;
            const vh = add.probe?.viewport?.height || 720;
            const b = clickBox();
            if (b) {
                Object.assign($("add-click-mark").style, { left: `${(100 * (b.x + at.x * b.width)) / vw}%`, top: `${(100 * (b.y + at.y * b.height)) / vh}%` });
                $("add-click-mark").hidden = false;
            }
        }
        if (add.readerStart) {
            filled.push("the start (step 2)");
        }
    }
    renderReaderStart();
    if (reader.score && add.scoreTouched) {
        left.push("a score expression");
    } else if (reader.score) {
        document.querySelector('input[name="add-score"][value="expression"]').checked = true;
        $("add-score").value = reader.score;
        filled.push("the score expression (step 3)");
    }
    // How the game is played, as the trainer read it in the page and its code: proposed where nothing is written, for the
    // person to check — it is what the trainer and the engine are told the game is.
    if (reader.goal && (add.goalTouched || $("add-goal").value.trim())) {
        left.push("how the game is played");
    } else if (reader.goal) {
        $("add-goal").value = reader.goal;
        filled.push("How to play (step 3: read it, and correct it where it is wrong)");
    }
    add.readerNote = [
        filled.length ? `The trainer's reader filled in ${filled.join(" and ")}.` : "",
        left.length ? `${filled.length ? "It found" : "The trainer's reader found"} ${left.join(" and ")}${filled.length ? " as well" : ""}, not applied: what was chosen here is kept.` : "",
    ]
        .filter(Boolean)
        .join(" ");
    renderReaderNote();
}

/** The trainer's start, while it is the one saved: a start chosen here replaces it. */
function renderReaderStart() {
    $("add-start-note").hidden = !add.readerStart;
    $("add-start-note").textContent = add.readerStart
        ? `The start the trainer found in the game's code is kept: ${add.readerStart.map((s) => JSON.stringify(s)).join(", then ")} — a start chosen here replaces it.`
        : "";
}

// A start or a score chosen here is the one saved: the trainer's, found already or still to come, is not put over it.
for (const input of [...document.querySelectorAll('input[name="add-start"]'), $("add-start-key")]) {
    input.addEventListener("change", () => {
        add.readerStart = null;
        add.startTouched = true;
        renderReaderStart();
    });
}
for (const input of [...document.querySelectorAll('input[name="add-score"]'), $("add-score")]) {
    for (const type of ["input", "change"]) {
        input.addEventListener(type, () => {
            add.scoreTouched = true;
        });
    }
}
// How to play written here (the reader's proposal corrected too) is the one saved: a reader still to answer leaves it.
$("add-goal").addEventListener("input", () => {
    add.goalTouched = true;
});

/** Checks a choice's radio as a click on it would, with no change event; true when another choice was checked before. */
function choose(name, value) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (radio.checked) {
        return false;
    }
    radio.checked = true;
    return true;
}

// The key list sits in "Press a key"'s label, and a label's control is its radio: using the list does not check it,
// and what is saved is read from the radios. Picking a key — or opening the list: the key shown may be the one wanted —
// chooses that start. Not its focus, nor Enter: tabbing through the form, or going on to the next step, must not
// change the start.
const chooseKeyStart = () => {
    if (choose("add-start", "key")) {
        add.readerStart = null;
        add.startTouched = true;
        renderReaderStart();
        renderNext();
    }
};
for (const type of ["pointerdown", "input", "change"]) {
    $("add-start-key").addEventListener(type, chooseKeyStart);
}
$("add-start-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        // Next, as in any field, on every platform: Chromium submits the form on Enter on a closed list on macOS only;
        // elsewhere it would open the list, "Press a key" not chosen.
        event.preventDefault();
        $("add-form").requestSubmit();
    } else if (!PASSING_KEYS.has(event.key)) {
        chooseKeyStart();
    }
});
// Likewise the expression field, in "I know a page expression"'s label: writing one chooses it (emptying it does not).
for (const type of ["input", "change"]) {
    $("add-score").addEventListener(type, () => {
        if ($("add-score").value.trim() && choose("add-score", "expression")) {
            renderNext();
        }
    });
}

// Step 2: the start button is picked on the picture; kept as a fraction of what the game's clicks land on.
$("add-shot").addEventListener("click", (event) => {
    if (add.step !== 2 || !add.probe) {
        return;
    }
    const b = clickBox();
    if (!b) {
        $("add-error").textContent = NO_CLICK_TARGET;
        return;
    }
    const rect = $("add-shot").getBoundingClientRect();
    const vw = add.probe.viewport?.width || 1280;
    const vh = add.probe.viewport?.height || 720;
    const px = ((event.clientX - rect.left) / rect.width) * vw;
    const py = ((event.clientY - rect.top) / rect.height) * vh;
    const x = (px - b.x) / b.width;
    const y = (py - b.y) / b.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
        $("add-error").textContent = "Pick a point on the game itself (the framed area).";
        return;
    }
    add.click = { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
    add.readerStart = null;
    add.startTouched = true;
    renderReaderStart();
    document.querySelector('input[name="add-start"][value="click"]').checked = true;
    Object.assign($("add-click-mark").style, { left: `${(100 * px) / vw}%`, top: `${(100 * py) / vh}%` });
    $("add-click-mark").hidden = false;
    $("add-error").textContent = "";
    renderNext();
});

$("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    // Enter in a field submits the form (Add, its only submit button, is hidden before the last step): there it is Next.
    if (add.step !== 4) {
        if (!$("add-next").disabled) {
            showStep(add.step + 1);
        }
        return;
    }
    // Every step again, the look at the page first: one that cannot go on is shown, and why.
    for (const step of [1, 2, 3, 4]) {
        const check = stepCheck(step);
        if (!check.ok) {
            showStep(step);
            if (!check.problem) {
                $("add-error").textContent = step === 1 ? "Open and look at the page first." : "This step is not complete yet.";
            }
            return;
        }
    }
    const engine = addEngine();
    let game;
    try {
        const wait = Math.round(1000 * numberField("add-load", "Loading time", "seconds", 0, false).value);
        const loading = wait ? [{ waitMs: wait, advanceMs: 500 }] : [];
        const choice = startChoice();
        // The trainer's start as it found it, every step, unless another was chosen here.
        const start = add.readerStart
            ? [...loading, ...add.readerStart]
            : choice === "key"
                ? [...loading, { press: [$("add-start-key").value], advanceMs: 500 }]
                : choice === "click" && add.click
                    ? [...loading, { click: add.click, advanceMs: 500 }]
                    : loading;
        const seconds = numberField("add-seconds", "Seconds per game", "", 60, true).value;
        const scoreLabel = $("add-score-label").value.trim() || "points";
        const expression = scoreChoice() === "expression" ? $("add-score").value.trim() : "";
        game = {
            id: $("add-id").value.trim(),
            name: $("add-name").value.trim(),
            url: $("add-url").value.trim(),
            goal: $("add-goal").value.trim(),
            perception: add.reader ? { adapter: add.reader.adapter, read: add.reader.read, format: add.reader.format } : { adapter: add.probe.suggested },
            ...(add.probe.viewport ? { viewport: { width: add.probe.viewport.width, height: add.probe.viewport.height } } : {}),
            // What the start click was picked on (a click lands on the first canvas unless named).
            ...(add.target?.selector ? { clickTarget: add.target.selector } : {}),
            // The boot the page was looked at with (the probe's picture: 4 s) and the trainer's reader checked its start
            // after (PROBE_BOOT_MS in src/reader/page-reader.ts: keep the two alike) — not the default 2.5 s, which pressed
            // the start in play before the moment it was picked or checked at.
            bootMs: 4000,
            start,
            score: expression ? { expression, label: scoreLabel } : { fromState: true, label: scoreLabel },
            budgets: { gameSeconds: seconds, episodes: 1, trainSeconds: seconds },
            tags: [add.reader ? "own state" : add.probe.suggested],
            preferredEngine: engine,
        };
        await api("POST", "/api/games", game);
    } catch (err) {
        $("add-error").textContent = err.message;
        return;
    }
    $("add-dialog").close();
    state.selected = game.id;
    await loadGames().catch(showError);
    if ($("add-train-now").checked) {
        const note = $("add-train-note").value.trim();
        if (note) {
            remember(`trainNote.${game.id}`, note);
            $("train-note").value = note;
        }
        await startTrain(engine, numberField("add-iterations", "Training iterations", "", 3, true).value, $("add-train-live").checked, note);
    }
});

// ---------- how far a training or distillation run has got ----------

const STAGE_MARK = { done: "✓", current: "●", todo: "○", skipped: "–" };

function renderProgress() {
    const run = state.run;
    const view = $("train-progress");
    const p = run && (run.kind === "train" || run.kind === "distill") ? run.progress : null;
    if (!p) {
        view.hidden = true;
        return;
    }
    const pct = Math.round(100 * (p.overall || 0));
    view.innerHTML = `
        <div class="progress-head"><b>${run.kind !== "train" ? "Teaching Laya" : run.improve ? `Training ${esc(engineLabel(run.improve.engine))}, the clock ${run.improve.live ? "running" : "paused"}` : /laya/.test(run.engine || "") ? "Training for Laya" : "Training the rules"}</b>
            <span class="muted">${run.status === "running" ? `${pct}%${p.eta ? ` · ${esc(p.eta)} left in this stage` : ""}` : esc(run.status)}</span></div>
        <div class="bar-track"><span style="width:${pct}%"></span></div>
        <ol class="stages">${p.stages
            .map((s) => `<li class="${esc(s.state)}"><span class="mark">${STAGE_MARK[s.state] || ""}</span><span><b>${esc(s.label)}</b>${s.detail ? ` <span class="muted">— ${esc(s.detail)}</span>` : ""}${s.state === "current" && p.fraction !== undefined && run.status === "running" ? `<span class="bar-track small"><span style="width:${Math.round(100 * p.fraction)}%"></span></span>` : ""}</span></li>`)
            .join("")}</ol>
        ${p.results.length ? `<div class="results"><span class="muted">So far:</span> ${p.results.map(esc).join(" · ")}</div>` : ""}`;
    view.hidden = false;
}

// ---------- a game's setup: what is done, what is next ----------

function renderSetup() {
    const d = state.detail;
    const list = $("setup");
    if (!d) {
        list.hidden = true;
        return;
    }
    const g = d.game;
    const trained = d.profiles.length > 0;
    const hasLaya = (d.laya || []).length > 0;
    // The engine it is set up for, the Train button's: the one it was added for, else the one chosen to play it.
    const engine = trainEngine();
    const run = running() && state.run.gameId === g.id ? state.run : null;
    const steps = [];
    const seen = g.perception.read ? "the game's own state" : { phaser: "Phaser", pixi: "PixiJS", cocos: "Cocos", three: "Three.js", canvas2d: "2D canvas", pixels: "its pixels" }[g.perception.adapter] || "custom";
    steps.push({ done: true, text: `Added · reads ${seen}` });
    const busyText = (r) => {
        const p = r.progress;
        const stage = p?.stages.find((s) => s.state === "current");
        return stage ? `${stage.label}${stage.detail ? ` — ${stage.detail}` : ""}` : r.phase;
    };
    // A training is not offered while the trainer, or Jev for one it decides, is not ready: the step says why instead —
    // and, as the Train button, the engine it is for while the Engine list shows another (trainNote).
    const refusal = trainRefusal(engine, liveChosen());
    const trainWhy = [refusal, trainNote()].filter(Boolean).join(" ");
    if (run?.kind === "train") {
        steps.push({ busy: true, text: `Training · ${busyText(run)}`, progress: run.progress });
    } else if (trained) {
        const a = d.active;
        steps.push({
            done: true,
            text: `Trained · v${a.version}${a.results ? ` · ${a.results.mean} ${g.score.label}` : ""}`,
            action: refusal ? null : { id: "train", label: "Train more" },
            why: trainWhy,
        });
    } else {
        steps.push({ text: "Not trained yet", action: refusal ? null : { id: "train", label: "✦ Train" }, why: trainWhy });
    }
    if (engine === "laya" || hasLaya) {
        // Not offered while Laya's Python, or the trainer for a version without its rules as code, is not ready: why instead.
        const unready = trained ? distillRefusal() : "";
        if (run?.kind === "distill") {
            steps.push({ busy: true, text: `Teaching Laya · ${busyText(run)}`, progress: run.progress });
        } else if (hasLaya) {
            steps.push({ done: true, text: "Laya learned it", action: trained && !unready ? { id: "distill", label: "Distill again" } : null, why: unready });
        } else {
            steps.push({
                text: trained ? "Laya not taught yet (~1 hour)" : "Laya: after the training",
                action: trained && !unready ? { id: "distill", label: "⚡ Distill to Laya" } : null,
                why: unready,
            });
        }
    }
    // The engine it plays with: Jev for a game trained for it, else Laya once it learnt the game — by the Engine list's own
    // test (unplayable): a clock offered with it that it can play, the engine ready (Jev's key, Laya's Python; not known
    // yet, it is taken as ready, as a training's refusal takes it) and, for Laya, a checkpoint of the version that clock
    // plays. Why not, beside the step.
    const named = engine === "jev" ? "jev" : hasLaya ? "laya" : null;
    const label = named === "jev" ? "Jev" : "Laya";
    const health = named === "laya" ? state.status?.engines?.laya?.python : named ? state.status?.engines?.[named] : null;
    const namedWhy = trained && named !== null ? unplayable(named) : "";
    const ready = trained && named !== null && !namedWhy;
    // Not ready: in the engine's own words (its key, its Python); else why no clock plays it (the version one pins).
    const down = namedWhy && health?.ok === false ? health.detail : namedWhy;
    steps.push({
        done: ready,
        text: ready ? `Ready to play with ${label}` : down ? `Playable with ${label} once it is ready` : "Playable when the steps above are done",
        why: ready ? "" : down,
    });
    // Live: a clock that never pauses, offered and playable (the game's configs, else a version trained for real time
    // that kept its score there, pinned with its floor) — else why not, and the training that gets it there.
    const liveWhy = unplayableOn("laya", true);
    // The live clock pinned to a version Laya has not learnt (one kept for real time only, say): Distill teaches it that one.
    const liveVersion = offered("laya", true)?.version;
    const unlearnt =
        trained && liveVersion !== undefined && !distilledVersions().includes(liveVersion) && d.profiles.some((p) => p.version === liveVersion && p.hasTeacher);
    const distillLive =
        unlearnt && state.status?.engines?.laya?.python?.ok !== false && run?.kind !== "distill" ? { id: "distill-live", label: `⚡ Distill v${liveVersion} for live` } : null;
    if (!liveWhy) {
        const c = offered("laya", true);
        steps.push({
            done: true,
            text: `Plays live with Laya${c?.version !== undefined ? ` · v${c.version}` : ""}${c?.lagMs !== undefined ? ` · inputs ≥ ${c.lagMs} ms` : ""}`,
            action: distillLive,
        });
    } else if (trained && run?.kind !== "train") {
        const why = (!g.configs && d.live?.why) || liveWhy;
        steps.push({ text: "Not played live yet", action: distillLive || (refusal || engine === "jev" ? null : { id: "train-live", label: "Train for real time" }), why });
    }
    list.innerHTML = steps
        .map(
            (s) =>
                `<li class="${s.done ? "done" : s.busy ? "busy" : ""}"><span>${esc(s.text)}</span>${
                    s.progress ? `<span class="bar-track small"><span style="width:${Math.round(100 * (s.progress.overall || 0))}%"></span></span><span class="muted">${Math.round(100 * (s.progress.overall || 0))}%${s.progress.eta ? ` · ${esc(s.progress.eta)}` : ""}</span>` : ""
                }${s.action && !running() ? ` <button type="button" class="ghost small" data-setup="${esc(s.action.id)}">${esc(s.action.label)}</button>` : ""}${
                    s.why && !running() ? ` <span class="muted">— ${esc(s.why)}</span>` : ""
                }</li>`
        )
        .join("");
    list.hidden = false;
}

$("setup").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-setup]");
    if (!button || !state.detail) {
        return;
    }
    if (button.dataset.setup === "train") {
        // As the Train button: the engine wanted, the clock and version chosen — with its notes.
        rememberWanted();
        await trainChosen();
    } else if (button.dataset.setup === "train-live") {
        await startTrain(trainEngine(), Number($("iterations").value) || 3, true, trainerNotes());
    } else if (button.dataset.setup === "distill-live") {
        await startDistill(offered("laya", true)?.version);
    } else if (button.dataset.setup === "distill") {
        await startDistill();
    }
});

/**
 * Train the game shown with `engine` (`live`: the clock running — not for Jev, whose hundreds of ms no game is played
 * live with; `note`: told to the trainer in its every prompt; `version`: the one checked where no config pins one).
 * With something to check the server checks it, fixes what loses (else trains for a higher score) and checks again;
 * with nothing yet, it trains from there (a first version, Laya's first lesson of one, a first training for real time).
 */
async function startTrain(engine, iterations, live = false, note = "", version = undefined) {
    // Not offered while the trainer, or Jev for a training it decides, is not ready; the server refuses it too.
    const refusal = trainRefusal(engine, live);
    if (refusal) {
        showError(new Error(refusal));
        return;
    }
    try {
        const { run } = await api("POST", "/api/runs", {
            kind: "train",
            gameId: state.selected,
            iterations,
            engine,
            live,
            ...(version !== undefined ? { version } : {}),
            ...(note ? { note } : {}),
        });
        renderStarted(run);
        showTab("training");
    } catch (err) {
        showError(err);
    }
}

// ---------- start ----------

(async () => {
    connect();
    await loadStatus();
    await loadGames().catch(showError);
    await loadRuns().catch(() => {});
    setInterval(loadStatus, 30_000);
})();
