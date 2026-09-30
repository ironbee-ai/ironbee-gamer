"""Serves Laya checkpoints — the base ones and the ones fine-tuned per game — over the same
`POST /v1/systemone` protocol Jev speaks, so `ibgamer` asks either the same way.

    python laya/serve.py --checkpoint <game>=~/.ibgamer/library/<game>/laya/<name> [--port 8000] [--device mps]

The request's `model` names the checkpoint (`<game>` above, or `english` / `multilingual`); without
one, the first `--checkpoint` answers, and a model it does not serve is refused (404) rather than
answered by another. `/health` lists the models (`loaded`), the directory each checkpoint was
loaded from (`checkpoints`) and the mtime of the weights file it loaded (`weights_mtime_ns`, taken
before the load): `ibgamer` reuses a server only when it serves the very checkpoints it wants, as
they are now — a checkpoint made again under the same directory name is not the one it loaded. One
forward pass at a time: a single GPU does not gain from running two.

A checkpoint fine-tuned here answers under the autocast it was trained under (`finetune.py`
records it; bf16 before it did). A model that only ever ran in bf16 can answer quite differently in
fp32 — one answered the same action to nearly every state it had learnt.
"""

import argparse
import contextlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Before torch (imported by laya): MPS keeps cached blocks per tensor shape, and every state is its own
# length — capped at the recommended working set (low mark below the high one, or MPS does not start),
# and the cache emptied every EMPTY_CACHE_EVERY answers.
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "1.0")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.8")

import laya
import torch

MAX_BODY = 2 * 1024 * 1024
EMPTY_CACHE_EVERY = 500
AUTOCAST = {"bf16": torch.bfloat16, "fp16": torch.float16}


def trained_precision(path):
    """The autocast dtype a checkpoint fine-tuned here was trained under; None for any other."""
    try:
        with open(os.path.join(path, "rl_agent_config.json")) as f:
            meta = json.load(f).get("ibgamer")
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    return AUTOCAST.get(meta.get("amp", "bf16"))


def weights_mtime(path):
    """The mtime of a checkpoint's weights file in ns, as a string (a JSON number loses digits past 2**53); None when it has none."""
    try:
        return str(os.stat(os.path.join(path, "model.safetensors")).st_mtime_ns)
    except OSError:
        return None


def precision(agent, dtype):
    if dtype is None:
        return contextlib.nullcontext()
    return torch.autocast(device_type=torch.device(agent.device).type, dtype=dtype)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--checkpoint", action="append", default=[], help="name=directory (repeatable)")
    ap.add_argument("--base", action="append", default=[], help="a base checkpoint to serve too: english / multilingual")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--device", default=None)
    a = ap.parse_args()

    agents, dtypes, order, dirs, weights = {}, {}, [], {}, {}
    for spec in a.checkpoint:
        name, _, path = spec.partition("=")
        if not name or not path:
            sys.exit("--checkpoint takes name=directory")
        started = time.time()
        dirs[name] = os.path.realpath(os.path.expanduser(path))
        # Before the load: weights written again while it loads are not taken for the ones it holds.
        weights[name] = weights_mtime(dirs[name])
        agents[name] = laya.load(os.path.expanduser(path), device=a.device)
        dtypes[name] = trained_precision(os.path.expanduser(path))
        order.append(name)
        under = " under %s autocast" % str(dtypes[name]).replace("torch.", "") if dtypes[name] is not None else ""
        print("[laya] %s <- %s on %s%s (%.1fs)" % (name, path, agents[name].device, under, time.time() - started), flush=True)
    for name in a.base:
        agents[name] = laya.load("convaiinnovations/laya", device=a.device, subfolder=None if name == "english" else name)
        dtypes[name] = None
        order.append(name)
        print("[laya] %s (base) on %s" % (name, agents[name].device), flush=True)
    if not agents:
        sys.exit("give at least one --checkpoint or --base")
    lock = threading.Lock()
    answered = [0]
    # The first call on a device compiles kernels: pay it now, not in a game.
    for name, agent in agents.items():
        with precision(agent, dtypes[name]):
            agent.system_one({"warm": True}, {"q": {"type": "choice", "instructions": "warm up", "criteria": {"a": "a", "b": "b"}}})

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                stamps = {n: w for n, w in weights.items() if w is not None}
                self.reply(200, {"status": "ok", "loaded": order, "checkpoints": dirs, "weights_mtime_ns": stamps})
            else:
                self.reply(404, {"detail": "not found"})

        def do_HEAD(self):
            self.send_response(200 if self.path in ("/health", "/v1/systemone") else 404)
            self.send_header("content-length", "0")
            self.end_headers()

        def do_POST(self):
            if self.path != "/v1/systemone":
                self.reply(404, {"detail": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY:
                self.reply(413, {"detail": "request body too large"})
                return
            try:
                body = json.loads(self.rfile.read(length))
                # No model named: the first. A model named that is not here is refused, never answered by another.
                name = body.get("model") or order[0]
                if name not in agents:
                    self.reply(404, {"detail": "no model %r here: this server answers for %s" % (name, ", ".join(order))})
                    return
                started = time.perf_counter()
                with lock, precision(agents[name], dtypes[name]):
                    result = agents[name].system_one(body.get("state"), body["questions"])
                    answered[0] += 1
                    if answered[0] % EMPTY_CACHE_EVERY == 0 and torch.backends.mps.is_available():
                        torch.mps.empty_cache()
                result["model"] = name
                result["inference_ms"] = round((time.perf_counter() - started) * 1000, 1)
                self.reply(200, result)
            except (ValueError, KeyError, TypeError) as e:
                self.reply(422, {"detail": str(e)[:300]})

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer((a.host, a.port), Handler)
    print("[laya] serving %s on http://%s:%d/v1/systemone" % (", ".join(order), a.host, a.port), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
