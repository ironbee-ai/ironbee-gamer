"""Fine-tunes a copy of a Laya checkpoint on a game's decisions, so it can play the game locally.

The rows are the decisions a teacher engine (Jev) made while playing — each one the state, the
question as asked (goal, rules, actions) and the teacher's probabilities over the actions — as
`ibgamer` logs them (`<library>/<game>/decisions/*.jsonl`). The teacher applies the rules the
trainer (an LLM) wrote; the student learns to do the same from the state alone, in a fraction of
the time, on this machine.

    python laya/finetune.py --data rows.jsonl --out ~/.ibgamer/library/<game>/laya/<name> [--base multilingual]

How it trains, and why:
- The sequence is built by Laya's own inference path (`Agent._encode_state`) for the state the
  player sends (`{"game": state}`): the model trains on exactly what it will see.
- The loss is the cross-entropy against the teacher's probabilities (soft targets): a strictly
  proper score, so the model learns honest probabilities, not just the argmax.
- A game's decisions are lopsided (a runner mostly keeps running), so rows are drawn with weights
  that lift the rare actions, and identical rows are merged.
- Validation is held out in stretches of play, not in rows drawn at random: frames of one game are
  near duplicates, and a row split would grade the model on what it has seen. The rows carry their
  game's seed (as ibgamer logs them), so whole games go to validation. Where there are fewer than 3
  games, or a row carries no seed — logged before rows did, from a game that cannot be seeded, or from
  a live play that was not seeded; a single such row is enough — validation is one contiguous block of
  the rows instead: they are logged game by game, so only the games at its two edges are split.
- The token-embedding table stays frozen (a game's state uses few tokens; it is most of the
  memory). The temperature is fitted on the validation games and written into the checkpoint.
- A DAgger round is for the student's mistakes: the hard rows the checkpoint it starts from still
  gets wrong are drawn as a fixed share of every batch (`--mistakes-share`), and it stops early only
  once every one of them is right (a sample of all hard rows passed with a few decisive rows still wrong).
- MPS can drop a command buffer mid-run; `--resume` carries on from the last saved step. A run
  started without it first removes a resume state left in `--out` (a crashed run's): its retry
  must not go on from another run.
- Every forward pass runs under one autocast (bf16 on MPS), recorded in the checkpoint: the model
  learns under that precision only, and `serve.py` answers under it too (in fp32 a model can answer
  otherwise — one answered the same action to nearly everything it had learnt).
- Memory stays bounded: a batch runs in pieces of at most TOKEN_BUDGET padded tokens, gradients
  summed (16 long states at once took over 30 GB of a 48 GB machine and pushed it into swap until it
  froze); a piece is padded to a multiple of 64 tokens (MPS keeps kernels and cached blocks per shape),
  the MPS cache is emptied every step, and the MPS allocator may not go past the recommended
  working set (PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.6, cached blocks handed back past 0.35): too much
  memory is an error, which `--resume` recovers from, instead of a machine that stops answering.
"""

import argparse
import collections
import json
import math
import os
import random
import shutil
import sys
import time

# Before torch: the MPS allocator reads them once (the default high mark, 1.7, lets it spill far into
# swap). The low mark (default 1.4) must not be above the high one, or MPS does not start at all.
# Ratios of the device's recommended working set (~36 GB of a 48 GB Mac): past the low mark the
# allocator hands cached blocks back, past the high one an allocation fails (and --resume carries on).
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.6")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.35")

import torch
import torch.nn.functional as F

import laya
from laya.common import QTYPES, collate_items, temp_bucket


def resolve_base(base):
    """A local checkpoint directory, or one of Laya's own by name (downloaded once)."""
    if os.path.isdir(os.path.expanduser(base)):
        return os.path.expanduser(base)
    from huggingface_hub import snapshot_download

    sub = {"english": None, "multilingual": "multilingual", "typed-decisions": "typed-decisions"}.get(base, "missing")
    if sub == "missing":
        sys.exit("--base must be a checkpoint directory or one of english, multilingual, typed-decisions")
    prefix = f"{sub}/" if sub else ""
    root = snapshot_download(
        "convaiinnovations/laya",
        allow_patterns=[prefix + p for p in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")],
    )
    return os.path.join(root, sub) if sub else root


def no_state(state):
    """A frame with no state (`{"extractorError": "<why>"}`: the page read or the extractor failed), as ibgamer tells one."""
    return isinstance(state, dict) and len(state) == 1 and isinstance(state.get("extractorError"), str)


def load_rows(paths):
    """Rows merged by (state, question): the mean of their targets, how often each was seen.

    A row of a frame with no state is left out: an engine's decision log holds some from before the player
    stopped asking about such frames, and a label of one teaches nothing of the game. A line that is no row (not
    a JSON object: a row cut short by a write that failed, maybe inside a character) is skipped, and said once
    for its file: one such line once failed every later fine-tuning of the version.
    """
    merged = collections.OrderedDict()
    for path in paths:
        skipped, first = 0, None
        with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    if not isinstance(r, dict):
                        raise ValueError("not a JSON object")
                except ValueError as e:
                    skipped += 1
                    first = first or str(e)
                    continue
                if no_state(r["state"]):
                    continue
                keys = list(r["criteria"].keys())
                target = [float(r["probabilities"].get(k, 0.0)) for k in keys]
                total = sum(target)
                if total <= 0:
                    continue
                target = [t / total for t in target]
                key = json.dumps([r["state"], r["criteria"], r["instructions"]], sort_keys=True)
                # A DAgger row carries the student's choice: where it differs from the teacher's, the row is hard.
                hard = "student" in r and r["student"] != r.get("choice")
                if key in merged:
                    m = merged[key]
                    m["target"] = [a + b for a, b in zip(m["target"], target)]
                    m["count"] += 1
                    m["hard"] = m["hard"] or hard
                else:
                    merged[key] = {
                        "state": r["state"],
                        "criteria": r["criteria"],
                        "instructions": r["instructions"],
                        "target": target,
                        "count": 1,
                        "hard": hard,
                        "game": str(r.get("seed", r.get("game_id", ""))),
                    }
        if skipped:
            print("skipped %d line%s of %s that %s no row (the first: %s)"
                  % (skipped, "" if skipped == 1 else "s", path, "is" if skipped == 1 else "are", first), flush=True)
    rows = []
    for m in merged.values():
        m["target"] = [t / m["count"] for t in m["target"]]
        m["label"] = max(range(len(m["target"])), key=m["target"].__getitem__)
        rows.append(m)
    return rows


def split_rows(rows, val_frac, seed):
    """Training and validation rows, validation val_frac of them in stretches of play.

    Rows with game ids (ibgamer's carry the game's seed; 3 games or more): whole games go to validation
    until they hold val_frac of the rows (a short game is not enough). Otherwise (a single row with none —
    logged before rows carried the seed, from a game that cannot be seeded, from an unseeded live play —
    or fewer than 3 games): one contiguous block of val_frac of the rows, at a place drawn from `seed` —
    the rows are in the order they were logged.
    """
    by_game = collections.defaultdict(list)
    for r in rows:
        by_game[r["game"]].append(r)
    games = sorted(by_game)
    rng = random.Random(seed)
    if len(games) >= 3 and "" not in by_game:
        rng.shuffle(games)
        val, want = [], val_frac * len(rows)
        for g in games[:-1]:
            if len(val) >= want:
                break
            val += by_game[g]
        val_games = {r["game"] for r in val}
        return [r for r in rows if r["game"] not in val_games], val
    n = len(rows)
    size = min(n - 1, max(1, int(round(n * val_frac)))) if n > 1 else 0
    start = rng.randrange(n - size + 1)
    return rows[:start] + rows[start + size:], rows[start:start + size]


class Encoder:
    """Laya's inference sequence for a row: `{"game": state}` against its question."""

    def __init__(self, agent):
        self.agent = agent

    def item(self, row):
        q = self.agent._to_internal({"type": "choice", "criteria": row["criteria"], "instructions": row["instructions"]})
        (item,) = self.agent._encode_state({"game": row["state"]}, ["action"], {"action": q})
        item["target"] = row["target"]
        item["label"] = row["label"]
        return item


PAD_TO = 64
EMPTY_CACHE_EVERY = 1
# Padded tokens in one forward pass while training. What the backward pass keeps grows with the tokens
# (the attention with their square): 16 states of ~950 tokens took over 30 GB, so a batch is run in
# pieces of at most this many tokens and their gradients summed (the step is the whole batch's).
TOKEN_BUDGET = 2048


def pieces(items, budget):
    """Consecutive runs of items whose padded size (count x longest, rounded up to PAD_TO) fits the budget."""
    out, run, longest = [], [], 0
    for it in items:
        size = -(-max(longest, len(it["ids"])) // PAD_TO) * PAD_TO
        if run and size * (len(run) + 1) > budget:
            out.append(run)
            run, longest = [], 0
            size = -(-len(it["ids"]) // PAD_TO) * PAD_TO
        run.append(it)
        longest = max(longest, len(it["ids"]))
    if run:
        out.append(run)
    return out


def collate(items, pad_id):
    """collate_items, with the sequence padded to a multiple of PAD_TO: few distinct shapes."""
    batch = collate_items([items], pad_id)
    n, length = batch["input_ids"].shape
    padded = -(-length // PAD_TO) * PAD_TO
    if padded != length:
        ids = torch.full((n, padded), pad_id, dtype=batch["input_ids"].dtype)
        ids[:, :length] = batch["input_ids"]
        att = torch.zeros((n, padded), dtype=batch["attention_mask"].dtype)
        att[:, :length] = batch["attention_mask"]
        batch["input_ids"], batch["attention_mask"] = ids, att
    return batch


def forward(model, batch, device):
    logits, _ = model(
        batch["input_ids"].to(device),
        batch["attention_mask"].to(device),
        batch["marker_pos"].to(device),
        batch["marker_mask"].to(device),
        batch["qtype"].to(device),
    )
    return logits.float()


def soft_ce(logits, target):
    return -(target * F.log_softmax(logits, -1)).sum(-1)


@torch.no_grad()
def evaluate(model, items, rows, device, bs, pad_id, ctx):
    """Loss, accuracy per teacher action, balanced accuracy; and the logits for the temperature."""
    model.eval()
    logits_all, labels_all, loss = [], [], 0.0
    for s in range(0, len(items), bs):
        # No backward pass here, so a piece may hold twice the training budget.
        for piece in pieces(items[s:s + bs], 2 * TOKEN_BUDGET):
            batch = collate(piece, pad_id)
            with ctx():
                lg = forward(model, batch, device)
            loss += soft_ce(lg, batch["target"].to(device)).sum().item()
            logits_all.append(lg.cpu())
            labels_all.append(batch["label"])
            del lg, batch
        if device.type == "mps":
            torch.mps.empty_cache()
    model.train()
    if device.type == "mps":
        torch.mps.empty_cache()
    if not items:
        return {"loss": 0.0, "acc": 0.0, "balanced": 0.0, "per_action": {}, "logits": None, "labels": None}
    lg, lb = torch.cat(logits_all), torch.cat(labels_all)
    pred = lg.argmax(-1)
    # A choice the teacher rated as high as its own is right: where the rules leave a tie, either option is.
    targets = [it["target"] for it in items]
    right = torch.tensor([t[p] >= max(t) - 1e-6 if p < len(t) else False for t, p in zip(targets, pred.tolist())])
    names = list(rows[0]["criteria"].keys())
    per = {}
    for i, name in enumerate(names):
        sel = lb == i
        if sel.any():
            per[name] = "%d/%d" % (int(right[sel].sum()), int(sel.sum()))
    accs = [int(right[lb == i].sum()) / int((lb == i).sum()) for i in range(len(names)) if (lb == i).any()]
    return {
        "loss": loss / len(items),
        "acc": float(right.float().mean()),
        "balanced": sum(accs) / max(1, len(accs)),
        "per_action": per,
        "logits": lg,
        "labels": lb,
    }


def fit_temperature(logits, labels):
    """The NLL-optimal temperature on the validation rows, within Laya's accepted [0.5, 5]."""
    best = (math.inf, 1.0)
    for i in range(61):
        t = math.exp(math.log(0.5) + i * (math.log(5.0) - math.log(0.5)) / 60)
        nll = F.cross_entropy(logits / t, labels).item()
        best = min(best, (nll, t))
    return best[1]


def save_checkpoint(model, cfg, base, out, meta):
    from safetensors import safe_open
    from safetensors.torch import save_file

    os.makedirs(out, exist_ok=True)
    # Keep the base's dtypes: an fp16 checkpoint stays half the size of an fp32 one.
    with safe_open(os.path.join(base, "model.safetensors"), "pt") as f:
        dtypes = {k: f.get_slice(k).get_dtype() for k in f.keys()}
    to_torch = {"F16": torch.float16, "BF16": torch.bfloat16, "F32": torch.float32}
    weights = {k: v.detach().cpu().to(to_torch.get(dtypes.get(k), v.dtype)).contiguous() for k, v in model.state_dict().items()}
    save_file(weights, os.path.join(out, "model.safetensors"))
    for d in ("tokenizer", "encoder"):
        if os.path.isdir(os.path.join(base, d)):
            shutil.copytree(os.path.join(base, d), os.path.join(out, d), dirs_exist_ok=True)
    with open(os.path.join(out, "rl_agent_config.json"), "w") as f:
        json.dump(dict(cfg, model_name=meta.get("name", "laya-game"), ibgamer=meta), f, indent=2)


def summary(tag, ev):
    return "%s: loss %.3f acc %.3f balanced %.3f %s" % (tag, ev["loss"], ev["acc"], ev["balanced"], ev["per_action"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, action="append", help="decision rows (.jsonl); repeat for several files")
    ap.add_argument("--train-only", action="append", default=[], help="rows used for training only (states off the teacher's own path)")
    ap.add_argument("--out", required=True, help="where the fine-tuned checkpoint goes")
    ap.add_argument("--base", default="multilingual", help="checkpoint to start from: a directory, or english / multilingual")
    ap.add_argument("--name", default="laya-game")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr-enc", type=float, default=3e-5)
    ap.add_argument("--lr-head", type=float, default=2e-4)
    ap.add_argument("--balance", type=float, default=0.7, help="rare actions drawn more: weight = count^-balance (0 = as logged)")
    ap.add_argument("--hard", type=float, default=4.0, help="weight of a row the student got wrong (DAgger)")
    ap.add_argument("--mistakes-share", type=float, default=0.1,
                    help="share of every batch drawn from the hard rows the starting checkpoint still gets wrong")
    ap.add_argument("--val-frac", type=float, default=0.15)
    ap.add_argument("--limit", type=int, default=None, help="use only N rows (a smoke test)")
    ap.add_argument("--save-every", type=int, default=200)
    ap.add_argument("--early-stop", type=float, default=0.998,
                    help="stop once the running loss is small and a validation sample is at least this balanced-accurate (0 = off)")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--device", default=None)
    ap.add_argument("--threads", type=int, default=4, help="CPU threads torch may use")
    ap.add_argument("--pause", type=float, default=0.0, help="seconds to rest after each step (keeps the machine usable)")
    ap.add_argument("--amp", choices=["auto", "off", "bf16", "fp16"], default="auto")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    torch.set_num_threads(max(1, a.threads))
    random.seed(a.seed)
    torch.manual_seed(a.seed)
    rng = random.Random(a.seed)
    out = os.path.expanduser(a.out)
    resume_file = os.path.join(out, "resume.pt")
    # Started afresh: a resume state left here is another run's (one that crashed), and this run's
    # retry (--resume) would go on from it — first thing, before anything that can fail.
    if not a.resume:
        for stale in (resume_file, resume_file + ".tmp"):
            if os.path.exists(stale):
                os.remove(stale)
    base = resolve_base(a.base)
    if os.path.abspath(out) == os.path.abspath(base):
        sys.exit("--out must differ from --base: the base checkpoint is never overwritten")

    rows = load_rows(a.data)
    if a.limit:
        rng.shuffle(rows)
        rows = rows[: a.limit]
    train, val = split_rows(rows, a.val_frac, a.seed)
    if a.train_only:
        seen = {json.dumps([r["state"], r["criteria"]], sort_keys=True) for r in val}
        extra = [r for r in load_rows(a.train_only) if json.dumps([r["state"], r["criteria"]], sort_keys=True) not in seen]
        train += extra
        rows += extra
    if not train:
        # Nothing labelled (an empty data file): stop here, not at a max() over no rows after loading the model.
        sys.exit("no labelled rows to train on in %s" % ", ".join(a.data + a.train_only))
    counts = collections.Counter(r["label"] for r in train)
    print("rows %d unique (train %d, val %d) | train actions %s" % (len(rows), len(train), len(val), dict(counts)), flush=True)

    agent = laya.load(base, device=a.device)
    model, device, cfg = agent.model, agent.device, dict(agent.cfg)
    model.float().train()
    amp = {"auto": "fp16" if device.type == "cuda" else "bf16" if device.type == "mps" else "off"}.get(a.amp, a.amp)
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(amp)

    def ctx():
        if dtype is None:
            return torch.autocast(device_type="cpu", enabled=False)
        return torch.autocast(device_type=device.type, dtype=dtype)

    pad_id = agent.tok.pad_token_id
    enc = Encoder(agent)
    t0 = time.time()
    train_items = [enc.item(r) for r in train]
    val_items = [enc.item(r) for r in val]
    longest = max(len(it["ids"]) for it in train_items)
    print("device %s | amp %s | encoded in %.0fs (longest %d tokens of %d)" % (device, amp, time.time() - t0, longest, cfg.get("max_len", 512)), flush=True)

    ev0 = evaluate(model, val_items, val, device, a.bs * 2, pad_id, ctx)
    print(summary("before", ev0), flush=True)

    # A DAgger round is for the student's mistakes, and the ones that matter are those the checkpoint it
    # starts from still makes. A few rare states — a single decisive tick, where one action a tick early
    # loses the game — are a handful of rows among tens of thousands: weighted like every other hard row they
    # are hardly drawn, and a 99.8 % check over a sample of the hard rows passes with them still wrong.
    # So they are drawn as a fixed share of every batch, and the early stop waits for every one of them.
    hard_all = [i for i, r in enumerate(train) if r.get("hard")]
    wrong = []
    if hard_all:
        evw = evaluate(model, [train_items[i] for i in hard_all], [train[i] for i in hard_all], device, a.bs * 2, pad_id, ctx)
        for i, p in zip(hard_all, evw["logits"].argmax(-1).tolist()):
            t = train_items[i]["target"]
            if not (p < len(t) and t[p] >= max(t) - 1e-6):
                wrong.append(i)
        print("the student's mistakes still wrong: %d of %d hard rows" % (len(wrong), len(hard_all)), flush=True)

    model.encoder.embeddings.tok_embeddings.weight.requires_grad_(False)
    enc_params = [p for n, p in model.named_parameters() if n.startswith("encoder.") and p.requires_grad]
    head_params = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": a.lr_enc}, {"params": head_params, "lr": a.lr_head}], weight_decay=0.01)
    per_epoch = math.ceil(len(train_items) / a.bs)
    total = max(1, int(per_epoch * a.epochs))
    warm = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min((s + 1) / warm, max(0.0, (total - s) / max(1, total - warm))))
    weights = [counts[r["label"]] ** -a.balance * (a.hard if r.get("hard") else 1.0) for r in train]
    print("hard rows (the student chose otherwise): %d" % sum(1 for r in train if r.get("hard")), flush=True)
    if wrong and 0 < a.mistakes_share < 1:
        wrong_set = set(wrong)
        rest = sum(w for i, w in enumerate(weights) if i not in wrong_set)
        each = a.mistakes_share * rest / ((1 - a.mistakes_share) * len(wrong))
        for i in wrong:
            weights[i] = max(weights[i], each)

    step, run_loss = 0, 0.0
    if a.resume and os.path.exists(resume_file):
        st = torch.load(resume_file, map_location=device, weights_only=False)
        model.load_state_dict(st["model"])
        opt.load_state_dict(st["opt"])
        sched.load_state_dict(st["sched"])
        rng.setstate(st["rng"])
        step, run_loss = st["step"], st["run_loss"]
        print("resumed at step %d/%d" % (step, total), flush=True)

    def save_resume():
        os.makedirs(out, exist_ok=True)
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "rng": rng.getstate(),
                    "step": step, "run_loss": run_loss}, resume_file + ".tmp")
        os.replace(resume_file + ".tmp", resume_file)

    # A small, fixed validation sample for the early-stop check (the full set is evaluated at the end).
    check_items = val_items[:: max(1, len(val_items) // 600)][:600]
    check_rows = val[:: max(1, len(val_items) // 600)][:600]
    # In a DAgger round the point is the student's mistakes: every one the starting checkpoint still
    # makes must be learnt before stopping (without such rows, a sample of the hard rows is checked).
    hard_idx = wrong if wrong else hard_all[:: max(1, len(hard_all) // 300)][:300]
    hard_items = [train_items[i] for i in hard_idx]
    hard_rows = [train[i] for i in hard_idx]
    hard_needed = 1.0 if wrong else a.early_stop

    t0 = time.time()
    first = step
    while step < total:
        idx = rng.choices(range(len(train_items)), weights=weights, k=a.bs)
        chosen = [train_items[i] for i in idx]
        opt.zero_grad(set_to_none=True)
        step_loss = 0.0
        for piece in pieces(chosen, TOKEN_BUDGET):
            batch = collate(piece, pad_id)
            with ctx():
                logits = forward(model, batch, device)
            # Each piece's share of the batch mean: the summed gradients are the whole batch's.
            loss = soft_ce(logits, batch["target"].to(device)).sum() / len(chosen)
            loss.backward()
            step_loss += loss.item()
            del logits, loss, batch
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        step += 1
        run_loss = 0.95 * run_loss + 0.05 * step_loss if step > 1 else step_loss
        if device.type == "mps" and step % EMPTY_CACHE_EVERY == 0:
            torch.mps.empty_cache()
        if a.pause > 0:
            time.sleep(a.pause)
        if step % 25 == 0 or step == total:
            done = step - first
            el = time.time() - t0
            eta = (total - step) * el / max(1, done)
            mem = " | mps %.1f GB" % (torch.mps.driver_allocated_memory() / 2**30) if device.type == "mps" else ""
            print("step %d/%d loss %.3f %.2f it/s ETA %dm%02ds%s" % (step, total, run_loss, done / el, eta // 60, eta % 60, mem), flush=True)
        if a.save_every and step % a.save_every == 0 and step < total:
            save_resume()
        if step % per_epoch == 0 and step < total:
            print(summary("epoch %d" % (step // per_epoch), evaluate(model, val_items, val, device, a.bs * 2, pad_id, ctx)), flush=True)
        # Checked every 100 steps: a loss against soft targets never reaches zero, so it cannot say when.
        if a.early_stop and check_items and step % 100 == 0 and step < total:
            ev = evaluate(model, check_items, check_rows, device, a.bs * 2, pad_id, ctx)
            print(summary("check at step %d" % step, ev), flush=True)
            hard_ok = True
            if hard_items:
                evh = evaluate(model, hard_items, hard_rows, device, a.bs * 2, pad_id, ctx)
                print(summary("  the student's mistakes", evh), flush=True)
                hard_ok = evh["acc"] >= hard_needed
            if ev["balanced"] >= a.early_stop and hard_ok:
                print("early stop at step %d/%d: the validation sample is learnt" % (step, total), flush=True)
                break

    ev1 = evaluate(model, val_items, val, device, a.bs * 2, pad_id, ctx)
    k = len(rows[0]["criteria"])
    temperature = fit_temperature(ev1["logits"], ev1["labels"]) if ev1["logits"] is not None else 1.0
    print(summary("after", ev1) + " | temperature %.3f" % temperature, flush=True)
    by_options = dict(cfg.get("temperature_by_options", {}))
    by_options[temp_bucket(QTYPES["choice"], k)] = temperature
    cfg["temperature_by_options"] = by_options
    meta = {
        "name": a.name,
        "base": a.base,
        "rows": len(rows),
        "train_rows": len(train),
        "val_rows": len(val),
        "epochs": a.epochs,
        "steps": total,
        "minutes": round((time.time() - t0) / 60, 1),
        "val_before": {"acc": ev0["acc"], "balanced": ev0["balanced"], "per_action": ev0["per_action"]},
        "val_after": {"acc": ev1["acc"], "balanced": ev1["balanced"], "per_action": ev1["per_action"]},
        "temperature": temperature,
        "actions": list(rows[0]["criteria"].keys()),
        # The autocast every forward pass here ran under: serve.py answers under the same one.
        "amp": amp,
    }
    save_checkpoint(model, cfg, base, out, meta)
    if os.path.exists(resume_file):
        os.remove(resume_file)
    with open(os.path.join(out, "training.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("saved %s" % out, flush=True)


if __name__ == "__main__":
    main()
