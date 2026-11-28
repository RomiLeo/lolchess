import json
import math
from collections import Counter
from itertools import combinations
from pathlib import Path

from manual_builder import BANDS, SONA
from web_planner import serve

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "traits.json").read_text(encoding="utf-8"))
TIERS = CATALOG["breakpoints"]
NONUNIQUE = {t["name"] for t in CATALOG["traits"] if t["type"] != "unique" and TIERS.get(t["name"], [0])[0] > 0}
LABELS = {t["name"]: t["nameKo"] for t in CATALOG["traits"]}
EMBLEMS = {item["trait"]: item["nameKo"] for item in
           json.loads((ROOT / "emblems.json").read_text(encoding="utf-8"))["items"]}
TEAM_BUFFS = {"Arcanist", "Bodyguard", "Choreographer", "Frontman", "Illbeats", "Manager", "Prodigy", "Swiftstriker"}
ECON_TRAITS = {"Hyperpop", "True Damage"}
VALID_TIER_IDX = {
    t: {n: idx for idx, n in enumerate(v for v in levels if v >= 2)}
    for t, levels in TIERS.items()
}
MIN_CARRY_TIER = {t: min(idx_map) for t, idx_map in VALID_TIER_IDX.items() if idx_map}


def weight(trait):
    return 2 if trait == "K/DA" else 1


def round1(value):
    return math.floor(value * 10 + 0.5) / 10


def slot_size(unit):
    return 2 if unit["id"] == "DA_BaronNashor19" else 1


def is_tank(unit):
    return "tank" in unit["role"].lower()


def front_weight(unit):
    if is_tank(unit) or slot_size(unit) == 2:
        return 1.0
    role = unit["role"].lower()
    if "fighter" in role or unit["id"] in ("DA_Nunu19", "DA_Rakan19"):
        return 0.5
    return 0.0


def is_high_carry(unit):
    if unit["cost"] < 4:
        return False
    role = unit["role"].lower()
    return (any(word in role for word in ("caster", "marksman", "fighter", "assassin"))
            or unit["id"] in ("DA_Jhin19", "DA_Smeech19"))


def carry_traits(unit):
    if unit.get("_leader"):
        return ()
    seen = []
    for t in unit["traits"]:
        if t not in seen and t in NONUNIQUE and t != "Collab" and max(TIERS.get(t, (0,))) >= 2:
            seen.append(t)
    return tuple(seen)


def place_emblems(team, counts, inventory):
    holders = [set() for _ in team]
    if not inventory:
        return holders
    eligible = {t: [i for i, u in enumerate(team) if t not in u["traits"]] for t in inventory}
    if len(inventory) <= 3:
        for trait, quantity in inventory.items():
            for i in eligible[trait][:quantity]:
                holders[i].add(trait)
        return holders

    def assign(trait, visited):
        if trait in visited:
            return False
        visited.add(trait)
        candidates = [i for i in eligible[trait] if trait not in holders[i]]
        for i in candidates:
            if len(holders[i]) < 3:
                holders[i].add(trait)
                return True
        for i in candidates:
            for other in sorted(holders[i]):
                if assign(other, visited):
                    holders[i].remove(other)
                    holders[i].add(trait)
                    return True
        return False

    remaining = {t: min(n, len(eligible[t])) for t, n in inventory.items()}
    used = Counter()
    slots = 3 * len(team)
    while slots:
        best = None
        best_gain = -1
        for t, n in remaining.items():
            if not n:
                continue
            start = counts[t] + used[t] * weight(t)
            tiers = TIERS[t]
            previous = max((v for v in tiers if v <= start), default=0)
            gain = max(
                ((v - previous) / ((v - start + weight(t) - 1) // weight(t))
                 for v in tiers if start < v <= start + weight(t) * n),
                default=0,
            ) + (0.15 * weight(t) if start < tiers[-1] else 0)
            if gain > best_gain:
                best, best_gain = t, gain
        if best is None:
            break
        if assign(best, set()):
            remaining[best] -= 1
            used[best] += 1
            slots -= 1
        else:
            remaining[best] = 0
    return holders


def with_band(unit, band):
    if unit["id"] == SONA and band and band not in unit["traits"]:
        return {**unit, "traits": [*unit["traits"], band], "_leader": True}
    if unit["id"] == SONA:
        return {**unit, "_leader": True}
    return unit


def evaluate(team, collab, inventory, band=None, *, lucky=(), priority="balance", fixed_equipment=None):
    lucky_set = set(lucky)
    if not team:
        empty_meta = {
            "activeCount": 0, "jazzCount": 0, "legendUnits": 0, "invalidCarry": False,
            "unmetCarries": [], "counts": Counter(), "activeTiers": {},
            "rawScore": 0, "costSum": 0, "score": 0,
            "breakdown": {"total": 0, "synergy": 0, "carry": 0, "value": 0, "frontline": 0},
        }
        return 0, {}, [], empty_meta

    if band:
        team = [with_band(unit, band) for unit in team]
    counts = Counter()
    tanks = 0
    front = 0.0
    legend_units = 0
    team_slots = 0
    cost_sum = 0
    for unit in team:
        traits = list(dict.fromkeys(unit["traits"]))
        for t in traits:
            counts[t] += weight(t)
        if unit["id"] in collab and "Collab" not in traits:
            counts["Collab"] += 1
        tanks += is_tank(unit)
        front += front_weight(unit)
        s = slot_size(unit)
        team_slots += s
        cost_sum += unit["cost"]
        if unit["id"] != SONA and unit["cost"] >= 5:
            legend_units += s

    if fixed_equipment is not None:
        holders = [set(t for t in fixed_equipment.get(u["id"], ()) if t not in u["traits"]) for u in team]
    else:
        holders = place_emblems(team, counts, inventory)
    for equipped in holders:
        for trait in equipped:
            counts[trait] += weight(trait)

    active = {}
    active_tiers = {}
    active_count = 0
    synergy_raw = 0.0
    for trait, count in counts.items():
        tiers = TIERS.get(trait, [])
        if not tiers:
            continue
        tier = max((n for n in tiers if n <= count), default=0)
        if tier:
            active[trait] = tier
            if trait in NONUNIQUE:
                active_tiers[trait] = tier
                active_count += 1
                eff = tier / weight(trait)
                mult = 1.25 if trait in TEAM_BUFFS else (0.85 if trait in ECON_TRAITS else 1.0)
                synergy_raw += mult * (1.5 + 3.0 * eff)

    jazz_tier = active_tiers.get("Jazz", 0)
    if jazz_tier == 2:
        synergy_raw += 1.5 * active_count
    elif jazz_tier == 3:
        synergy_raw += 2.25 * active_count
    elif jazz_tier >= 4:
        synergy_raw += 3.0 * active_count

    carry_score = 0.0
    invalid_carry = False
    unmet_carries = []
    for unit in team:
        uid = unit["id"]
        is_lucky = uid in lucky_set
        if not is_lucky and not is_high_carry(unit):
            continue
        c_traits = carry_traits(unit)
        if not c_traits:
            continue
        unit_gain = 0.0
        on_count = 0
        for t in c_traits:
            tier = active_tiers.get(t, 0)
            if tier >= 2:
                on_count += 1
                unit_gain += 4.0 + 2.0 * VALID_TIER_IDX.get(t, {}).get(tier, 0)
        if on_count == 0:
            unmet_carries.append(uid)
            if is_lucky or uid not in collab:
                invalid_carry = True
            carry_score -= 30.0 if is_lucky else 15.0
        else:
            if len(c_traits) >= 2 and on_count == len(c_traits):
                unit_gain += 4.0
            carry_score += (2.0 if is_lucky else 1.0) * unit_gain

    value_raw = 6.0 * legend_units
    target_front = max(2.0, 0.35 * team_slots)
    frontline_score = 4.0 * min(front, target_front) + min(3.0, 1.5 * max(0.0, front - target_front))
    if team_slots >= 7 and tanks < 2 and front < 2.5:
        frontline_score -= 8.0

    w_syn = 0.85 if priority == "value" else 1.0
    w_val = 2.2 if priority == "value" else 1.0
    synergy = round1(w_syn * synergy_raw)
    carry = round1(carry_score)
    value = round1(w_val * value_raw)
    frontline = round1(frontline_score)
    total = round1(synergy + carry + value + frontline)
    raw_score = math.floor((w_syn * synergy_raw + carry_score + w_val * value_raw + frontline_score) * 1000 + 0.5) * 100 + cost_sum

    meta = {
        "activeCount": active_count,
        "jazzCount": counts.get("Jazz", 0),
        "legendUnits": legend_units,
        "invalidCarry": invalid_carry,
        "unmetCarries": unmet_carries,
        "counts": counts,
        "activeTiers": active_tiers,
        "rawScore": raw_score,
        "costSum": cost_sum,
        "score": total,
        "breakdown": {"total": total, "synergy": synergy, "carry": carry, "value": value, "frontline": frontline},
    }
    return total, active, holders, meta


def assess(team, collab, inventory=None):
    return evaluate(team, collab, inventory or {})[:2]


def complete(units, selected, level, unlocked, inventory=None):
    team, _ = complete_with_band(units, selected, level, unlocked, inventory)
    return team


def complete_with_band(units, selected, level, unlocked, inventory=None):
    return ranked_decks(units, selected, level, unlocked, inventory)[0]


def prune_beam(states, min_active, jazz):
    items = list(states.values())
    if len(items) <= 44:
        return items
    by_search = sorted(
        items,
        key=lambda s: (-(abs(s["jazzCount"] - jazz)) if jazz else 0, s["searchScore"]),
        reverse=True,
    )
    kept = {s["key"]: s for s in by_search[:36]}
    if min_active > 0:
        by_active = sorted(items, key=lambda s: (s["activeCount"], s["searchScore"]), reverse=True)
        for s in by_active[:18]:
            kept[s["key"]] = s
    if jazz and by_search[0]["jazzCount"] < jazz:
        by_jazz = sorted((s for s in items if s["jazzCount"] > 0), key=lambda s: (s["jazzCount"], s["searchScore"]), reverse=True)
        for s in by_jazz[:16]:
            kept[s["key"]] = s
    return list(kept.values())


def select_diverse(candidates, count=3):
    ordered = sorted(candidates, key=lambda s: s["rawScore"], reverse=True)
    picked = []
    for state in ordered:
        if len(picked) >= count:
            break
        ids = {u["id"] for u in state["team"]}
        if all(sum(1 for u in p["team"] if u["id"] not in ids) >= 2 for p in picked):
            picked.append(state)
    for state in ordered:
        if len(picked) >= count:
            break
        if state not in picked:
            picked.append(state)
    return picked


def ranked_decks(units, selected, level, unlocked, inventory=None, collab=3, jazz=None,
                 gu_feng=False, priority="balance", smeech=False, lucky=()):
    if priority not in ("balance", "value"):
        raise ValueError("추천 모드를 확인해 줘.")
    if collab not in (3, 5) or jazz not in (None, 2, 3) or type(gu_feng) is not bool:
        raise ValueError("추천 조건을 확인해 줘.")
    if type(smeech) is not bool:
        raise ValueError("스미치 포함 설정을 확인해 줘.")

    by_id = {u["id"]: (i, u) for i, u in enumerate(units)}
    if (not isinstance(lucky, (list, tuple)) or len(lucky) > 2 or len(set(lucky)) != len(lucky)
            or any(uid not in by_id or by_id[uid][1]["cost"] not in (4, 5) for uid in lucky)):
        raise ValueError("럭키 기물은 4·5코스트 기물 중 최대 2명까지 선택해 줘.")
    lucky_indices = [by_id[uid][0] for uid in lucky]
    if sum("Akali" in units[i]["id"] for i in lucky_indices) > 1:
        raise ValueError("아칼리는 한 형태만 배치할 수 있어.")

    if smeech and level <= collab:
        raise ValueError("스미치를 포함하려면 콜라보 외에 한 자리가 더 필요해.")

    lucky_set = set(lucky)
    allow_gu_feng_pool = gu_feng or any("Gu Feng" in units[i]["traits"] for i in lucky_indices)
    allowed = [i for i, u in enumerate(units) if u["id"] not in (SONA, "DA_Smeech19")
               and (allow_gu_feng_pool or "Gu Feng" not in u["traits"])]

    lucky_collab = [i for i in lucky_indices if units[i]["id"] in selected]
    lucky_extra = [i for i in lucky_indices if units[i]["id"] not in selected]
    candidates = [i for i in allowed if units[i]["id"] in selected and units[i]["id"] not in lucky_set]
    if len(lucky_collab) + len(candidates) < collab - 1 or level < collab:
        raise ValueError("콜라보 후보 또는 목표 인원이 부족해.")

    sona = by_id[SONA][0]
    smeech_idx = by_id["DA_Smeech19"][0]
    fixed_extras = (*( (smeech_idx,) if smeech else () ), *lucky_extra)
    min_slots = collab + sum(slot_size(units[i]) for i in fixed_extras)
    if level < min_slots:
        raise ValueError("콜라보와 필수 기물을 모두 배치하려면 목표 인원을 늘려 줘.")

    recruits = [
        i for i in allowed
        if units[i]["id"] not in selected and units[i]["id"] not in lucky_set and (
            (gu_feng and "Gu Feng" in units[i]["traits"])
            or (not gu_feng and allow_gu_feng_pool and "Gu Feng" in units[i]["traits"] and not units[i]["unlock"])
            or not units[i]["unlock"]
            or units[i]["id"] in unlocked
        )
    ]
    akalis = {i for i, u in enumerate(units) if "Akali" in u["id"]}
    unit_slots = [slot_size(u) for u in units]
    inv = inventory or {}
    min_active = 9 if (priority == "value" or (smeech and level >= 9)) else 0
    fixed_prefix = collab + len(fixed_extras)

    need_collab = collab - 1 - len(lucky_collab)
    seeds = []
    for group in combinations(candidates, need_collab):
        full = (sona, *lucky_collab, *group, *fixed_extras)
        if len(akalis.intersection(full)) <= 1:
            seeds.append(full)

    finalists = {}
    for band in BANDS:
        roster = list(units)
        roster[sona] = with_band(units[sona], band)

        def rank_step(state, remaining_slots):
            team = [roster[i] for i in state]
            _, _, holders, res = evaluate(team, selected, inv, lucky=lucky_set, priority=priority)
            if jazz is not None:
                equipped_jazz = sum("Jazz" in h for h in holders)
                spare_jazz = max(0, inv.get("Jazz", 0) - equipped_jazz)
                if res["jazzCount"] > jazz or res["jazzCount"] + remaining_slots + spare_jazz < jazz:
                    return None
            if remaining_slots == 0:
                return {**res, "key": state, "team": [units[i] for i in state], "searchScore": res["rawScore"]}

            potential = 0
            urgent = set()
            for u in team:
                uid = u["id"]
                is_l = uid in lucky_set
                if not is_l and not is_high_carry(u):
                    continue
                c_traits = carry_traits(u)
                if not c_traits:
                    continue
                if any(res["activeTiers"].get(t, 0) >= 2 for t in c_traits):
                    continue
                can_reach = False
                for t in c_traits:
                    min_tier = MIN_CARRY_TIER[t]
                    equipped = sum(t in h for h in holders)
                    spare = max(0, inv.get(t, 0) - equipped)
                    need = math.ceil((min_tier - res["counts"].get(t, 0)) / weight(t))
                    if need <= remaining_slots + spare:
                        can_reach = True
                        urgent.add(t)
                if not can_reach and (is_l or uid not in selected):
                    return None

            for uid in res["unmetCarries"]:
                potential += int((26.0 if uid in lucky_set else 13.0) * 100000)
            for t, cnt in res["counts"].items():
                if t not in NONUNIQUE:
                    continue
                next_tier = next((n for n in TIERS.get(t, ()) if n > cnt), None)
                if next_tier is None:
                    continue
                need = math.ceil((next_tier - cnt) / weight(t))
                if need <= remaining_slots:
                    if t in urgent:
                        potential += round((4.0 / need) * 100000)
                    elif not res["activeTiers"].get(t, 0) and need == 1:
                        potential += 150000
            return {**res, "key": state, "team": [units[i] for i in state], "searchScore": res["rawScore"] + potential}

        buckets = [{} for _ in range(level + 1)]
        for seed in seeds:
            used = sum(unit_slots[i] for i in seed)
            if used <= level:
                step = rank_step(seed, level - used)
                if step is not None:
                    buckets[used][seed] = step

        for s in range(min_slots, level):
            if not buckets[s]:
                continue
            states = prune_beam(buckets[s], min_active, jazz)
            for entry in states:
                state = entry["key"]
                has_akali = not akalis.isdisjoint(state)
                for i in recruits:
                    next_slots = s + unit_slots[i]
                    if next_slots > level or i in state or (has_akali and i in akalis):
                        continue
                    key = (*state[:fixed_prefix], *sorted((*state[fixed_prefix:], i)))
                    if key not in buckets[next_slots]:
                        step = rank_step(key, level - next_slots)
                        if step is not None:
                            buckets[next_slots][key] = step

        valid = [
            entry for entry in buckets[level].values()
            if not entry["invalidCarry"]
            and (jazz is None or entry["jazzCount"] == jazz)
            and entry["activeCount"] >= min_active
        ]
        valid.sort(key=lambda s: s["rawScore"], reverse=True)
        for entry in valid[:24]:
            team_key = tuple(u["id"] for u in entry["team"])
            if team_key not in finalists or entry["rawScore"] > finalists[team_key]["rawScore"]:
                finalists[team_key] = {**entry, "band": band}

    if not finalists:
        if min_active >= 9:
            raise ValueError("선택한 조건에서 활성 시너지 9개 이상인 덱을 찾지 못했어.")
        raise ValueError("이 조건으로 채울 수 있는 조합이 없어.")
    winners = select_diverse(list(finalists.values()), 3)
    return [(w["team"], w["band"]) for w in winners]


def main():
    serve(ranked_decks, evaluate)


if __name__ == "__main__":
    main()
