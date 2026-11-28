"""Sync top 5 recommended items per Set 19 champion from MetaTFT and download item icons."""

import argparse
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
STAT_API = "https://api-hc.metatft.com/tft-stat-api"
LOOKUP_BASE = "https://data.metatft.com/lookups"
ICON_BASE = "https://cdn.metatft.com/file/metatft/items"
LIVE_RANKS = "CHALLENGER,DIAMOND,EMERALD,GRANDMASTER,MASTER,PLATINUM"
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json,*/*"}
TAG_RE = re.compile(r"</?[^>]+(>|$)")


def fetch_bytes(url, retries=3):
    for attempt in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=20) as resp:
                return resp.read()
        except Exception:
            if attempt + 1 == retries:
                raise
            time.sleep(0.5 * (attempt + 1))


def fetch_json(url):
    return json.loads(fetch_bytes(url).decode("utf-8"))


def resolve_mode(mode):
    if mode in ("pbe", "live"):
        return mode
    probe = fetch_json(f"{STAT_API}/units?queue=1100&patch=current&days=3&permit_filter_adjustment=true")
    return "live" if str(probe.get("tft_set", "")).startswith("TFTSet19") else "pbe"


def load_item_lookup(mode):
    suffix = "latest" if mode == "live" else "pbe"
    data = fetch_json(f"{LOOKUP_BASE}/TFTSet19_{suffix}_ko_kr.json")
    lookup = {}
    for item in data.get("items", ()):
        api_name = item.get("apiName")
        if not api_name or "Debug" in api_name or "TFT15_HiddenTech_" in api_name:
            continue
        name_ko = TAG_RE.sub("", item.get("name") or api_name).strip()
        lookup[api_name] = {"id": api_name, "nameKo": name_ko}
    return lookup


def split_item_occurrence(raw_name):
    idx = raw_name.rfind("-")
    if idx > 0 and raw_name[idx + 1 :].isdigit():
        return raw_name[:idx], int(raw_name[idx + 1 :])
    return raw_name, 1


def compute_place_change(places, sample_count, baseline_avg, baseline_count, adjusted_count):
    avg_place = sum(count * (i + 1) for i, count in enumerate(places)) / sample_count
    variance = sum(count * ((i + 1 - avg_place) ** 2) for i, count in enumerate(places)) / sample_count
    upper_bound = avg_place + 1.282 * math.sqrt(variance / sample_count)
    rest_avg = (baseline_avg * baseline_count - avg_place * adjusted_count) / (baseline_count - adjusted_count)
    return avg_place, upper_bound - rest_avg


def build_query(endpoint, mode, extra):
    params = {"patch": "current", "days": "3", "permit_filter_adjustment": "true"}
    if mode == "live":
        params["queue"] = "1100"
        params["rank"] = LIVE_RANKS
    else:
        params["queue"] = "PBE"
    params.update(extra)
    return f"{STAT_API}/{endpoint}?{urlencode(params)}"


def rank_items_for_unit(unit_id, mode, item_lookup, num_items_filter=3):
    overall = fetch_json(build_query("unit_detail_overall", mode, {"unit": unit_id}))
    extra = {"unit": unit_id}
    if num_items_filter is not None:
        extra["num_items"] = str(num_items_filter)
    detail = fetch_json(build_query("unit_detail_items", mode, extra))

    raw_items = detail.get("items") or []
    if num_items_filter is not None and len(raw_items) < 5:
        return rank_items_for_unit(unit_id, mode, item_lookup, num_items_filter=None)
    if not raw_items:
        return []

    total_count = total_place = filtered_count = filtered_place = 0
    for row in overall.get("levels", ()):
        places = row["places"]
        count = sum(places)
        weighted = sum(c * (i + 1) for i, c in enumerate(places))
        total_count += count
        total_place += weighted
        star_lvl, item_cnt = int(row["lvl_items"][0]), int(row["lvl_items"][1])
        if star_lvl <= 4 and (num_items_filter is None or item_cnt == num_items_filter):
            filtered_count += count
            filtered_place += weighted

    base_count = filtered_count if filtered_count > 0 else total_count
    base_avg = (filtered_place / filtered_count) if filtered_count > 0 else (
        (total_place / total_count) if total_count > 0 else 4.5
    )
    if base_count <= 0:
        return []

    max_item_count = max((sum(r["places"]) for r in raw_items), default=0)
    if max_item_count <= 0:
        return []

    scored = []
    for row in raw_items:
        base_name, occurrence = split_item_occurrence(row["itemName"])
        meta = item_lookup.get(base_name)
        sample_count = sum(row["places"])
        if not meta or sample_count <= 0:
            continue
        adjusted = (
            base_count * (0.85 + 0.1 * sample_count / (3 * base_count))
            if sample_count / base_count > 0.85
            else sample_count
        )
        if base_count <= adjusted:
            continue
        _, place_change = compute_place_change(row["places"], sample_count, base_avg, base_count, adjusted)
        play_rate = sample_count / base_count
        freq_penalty = (play_rate / 0.08) ** 0.5 if play_rate < 0.08 else 1.0
        tier_val = -(place_change - 0.5) * 0.7 * freq_penalty * ((sample_count / max_item_count) ** 0.1)
        entry = {
            "id": base_name,
            "nameKo": meta["nameKo"],
            "placeChange": round(place_change, 2),
            "_rawPlaceChange": place_change,
            "_tierVal": tier_val,
        }
        if occurrence > 1:
            entry["occurrence"] = occurrence
        scored.append(entry)

    scored.sort(key=lambda x: x["_tierVal"], reverse=True)
    top5 = scored[:5]
    top5.sort(key=lambda x: (x["_rawPlaceChange"], -x["_tierVal"]))
    for entry in top5:
        del entry["_rawPlaceChange"], entry["_tierVal"]
    return top5


def download_icon(item_id, refresh=False):
    dest = ASSETS / f"{item_id}.png"
    if dest.exists() and not refresh:
        return False
    raw = fetch_bytes(f"{ICON_BASE}/{item_id.lower()}.png")
    if not raw.startswith(b"\x89PNG"):
        raise ValueError(f"Unexpected image payload for {item_id}")
    dest.write_bytes(raw)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("auto", "pbe", "live"), default="auto")
    parser.add_argument("--refresh-icons", action="store_true")
    args = parser.parse_args()

    mode = resolve_mode(args.mode)
    item_lookup = load_item_lookup(mode)
    units_path = ROOT / "units.json"
    units = json.loads(units_path.read_text(encoding="utf-8-sig"))

    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(rank_items_for_unit, u["id"], mode, item_lookup): u["id"] for u in units}
        for future in as_completed(futures):
            uid = futures[future]
            results[uid] = future.result()

    needed_icons = sorted({item["id"] for items in results.values() for item in items})
    ASSETS.mkdir(exist_ok=True)
    downloaded = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(download_icon, item_id, args.refresh_icons): item_id for item_id in needed_icons}
        for future in as_completed(futures):
            if future.result():
                downloaded += 1

    for unit in units:
        unit["recommendedItems"] = results[unit["id"]]

    units_path.write_text(json.dumps(units, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = [len(u["recommendedItems"]) for u in units]
    print(f"Mode: {mode} | Units: {len(units)} | Min items: {min(counts)} | Unique icons: {len(needed_icons)} (new: {downloaded})")


if __name__ == "__main__":
    main()
