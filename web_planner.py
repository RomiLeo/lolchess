import json
import mimetypes
import time
import webbrowser
from collections import Counter
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from manual_builder import BANDS, PROFILES, draw_collab, pool_slot


ROOT = Path(__file__).resolve().parent


def read_json(filename):
    return json.loads((ROOT / filename).read_text(encoding="utf-8-sig"))


UNITS = read_json("units.json")
CATALOG = {"units": UNITS, "traits": read_json("traits.json"), "emblems": read_json("emblems.json")}
BY_ID = {u["id"]: u for u in UNITS}
SLOTS = {u["id"]: pool_slot(u) for u in UNITS}
ELIGIBLE = {u["id"]: u for u in UNITS if SLOTS[u["id"]] is not None}
FILES = {"/": "index.html", "/index.html": "index.html", "/ui.js": "ui.js", "/style.css": "style.css", "/theme.js": "theme.js"}
for name in ("ladder.html", "ladder-plans.json", "planner-worker.js", "ladder-worker.js", "units.json", "traits.json", "emblems.json"):
    FILES["/" + name] = name
for row in [*UNITS, *CATALOG["traits"]["traits"], *(item for u in UNITS for item in u.get("recommendedItems", ()))]:
    asset = "assets/" + row["id"] + ".png"
    FILES["/" + asset] = asset


@lru_cache(maxsize=8192)
def can_complete(selected):
    used = set()
    counts = Counter()
    for uid in selected:
        unit = ELIGIBLE.get(uid)
        if not unit or used.intersection(unit["traits"]):
            return False
        used.update(unit["traits"])
        counts[SLOTS[uid]] += 1

    def fill(remaining, taken):
        if not remaining:
            return True
        return any(fill(remaining[1:], taken.union(unit["traits"]))
                   for unit in ELIGIBLE.values() if SLOTS[unit["id"]] == remaining[0]
                   and taken.isdisjoint(unit["traits"]))

    for profile in PROFILES:
        quotas = Counter(profile)
        if not counts - quotas and fill(tuple((quotas - counts).elements()), used):
            return True
    return False


def pool(selected):
    if not can_complete(tuple(sorted(selected))):
        raise ValueError("선택한 기물로는 콜라보 후보군을 완성할 수 없어.")
    candidates = [uid for uid in ELIGIBLE if uid not in selected and
                  can_complete(tuple(sorted([*selected, uid])))]
    return {"selected": selected, "candidates": candidates}


def serve(complete, evaluate):
    class Handler(BaseHTTPRequestHandler):
        def respond(self, data, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_json(self, value, status=200):
            self.respond(json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

        def do_GET(self):
            self.server.last_use = time.monotonic()
            path = urlsplit(self.path).path
            if path == "/api/catalog":
                return self.send_json(CATALOG)
            name = FILES.get(path)
            if not name:
                return self.send_error(404)
            self.respond((ROOT / name).read_bytes(), mimetypes.guess_type(name)[0] or "application/octet-stream")

        def do_POST(self):
            self.server.last_use = time.monotonic()
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 32768:
                    raise ValueError("입력 크기를 확인해 줘.")
                data = json.loads(self.rfile.read(size))
                if self.path == "/api/score":
                    team_ids = data.get("team", [])
                    selected = data.get("selected", [])
                    priority = data.get("priority", "balance")
                    band = data.get("band") or None
                    if band and band not in BANDS:
                        band = None
                    if priority not in ("balance", "value"):
                        raise ValueError("추천 모드를 확인해 줘.")
                    if not isinstance(team_ids, list) or any(uid not in BY_ID for uid in team_ids):
                        raise ValueError("배치 기물을 확인해 줘.")
                    team = [BY_ID[uid] for uid in team_ids]
                    score, _, _, meta = evaluate(
                        team, set(selected), {}, band,
                        lucky=data.get("lucky", ()), priority=priority,
                        fixed_equipment=data.get("equipment", {}),
                    )
                    return self.send_json({
                        "score": score,
                        "breakdown": meta["breakdown"],
                        "activeCount": meta["activeCount"],
                        "unmetCarries": meta["unmetCarries"],
                    })

                selected = data["selected"]
                if not isinstance(selected, list) or any(uid not in BY_ID for uid in selected):
                    raise ValueError("기물 선택을 확인해 줘.")
                if self.path == "/api/pool":
                    if data.get("random"):
                        selected = [u["id"] for u in draw_collab(UNITS)]
                    return self.send_json(pool(selected))
                if self.path != "/api/complete":
                    return self.send_error(404)
                pool(selected)
                level = data["level"]
                inventory = data.get("inventory", {})
                lucky = data.get("lucky", [])
                priority = data.get("priority", "balance")
                known = {e["trait"] for e in CATALOG["emblems"]["items"]}
                if level not in range(3, 12) or any(t not in known or type(n) != int or n < 0
                                                      for t, n in inventory.items()):
                    raise ValueError("덱 인원과 상징 수량을 확인해 줘.")
                decks = []
                for team, band in complete(UNITS, set(selected), level, set(data["unlocked"]), inventory,
                                           data.get("collab", 3), data.get("jazz"), data.get("guFeng", False),
                                           priority, data.get("smeech", False), lucky):
                    score, _, holders, meta = evaluate(
                        team, set(selected), inventory, band, lucky=lucky, priority=priority
                    )
                    decks.append({
                        "team": [u["id"] for u in team],
                        "band": band,
                        "equipment": {u["id"]: sorted(h) for u, h in zip(team, holders)},
                        "score": score,
                        "breakdown": meta["breakdown"],
                        "activeCount": meta["activeCount"],
                    })
                self.send_json({**decks[0], "decks": decks})
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                self.send_json({"error": str(exc)}, 400)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 30
        server.last_use = time.monotonic()
        url = f"http://127.0.0.1:{server.server_port}/"
        webbrowser.open(url)
        while time.monotonic() - server.last_use < 12 * 3600:
            server.handle_request()
