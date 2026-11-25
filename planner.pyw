import json
from collections import Counter
from itertools import combinations, islice
from pathlib import Path

from manual_builder import BANDS, SONA
from web_planner import serve

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "traits.json").read_text(encoding="utf-8"))
TIERS = CATALOG["breakpoints"]
NONUNIQUE = {t["name"] for t in CATALOG["traits"] if t["type"] != "unique"}
LABELS = {t["name"]: t["nameKo"] for t in CATALOG["traits"]}
EMBLEMS = {item["trait"]: item["nameKo"] for item in
           json.loads((ROOT / "emblems.json").read_text(encoding="utf-8"))["items"]}


def weight(trait):
    return 2 if trait == "K/DA" else 1


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

    # Choose the next reachable breakpoint per slot, rerouting equipped copies
    # between holders to avoid stranding an emblem on a full unit.
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
        return {**unit, "traits": [*unit["traits"], band]}
    return unit


def evaluate(team, collab, inventory, band=None):
    if band:
        team = [with_band(unit, band) for unit in team]
    counts = Counter()
    tanks = carries = 0
    for unit in team:
        traits = set(unit["traits"])
        if unit["id"] in collab:
            traits.add("Collab")
        counts.update(traits)
        if "K/DA" in traits:
            counts["K/DA"] += 1
        role = unit["role"].lower()
        tanks += "tank" in role
        carries += any(word in role for word in ("caster", "marksman", "fighter"))
    holders = place_emblems(team, counts, inventory)
    for equipped in holders:
        for trait in equipped:
            counts[trait] += weight(trait)
    score = 0
    active = {}
    for trait, count in counts.items():
        tiers = TIERS.get(trait, [])
        tier = max((n for n in tiers if n <= count), default=0)
        if tier:
            active[trait] = tier
        if tiers and max(tiers) > 1:
            score += tier + 0.15 * min(count, max(tiers))
    score += 1.5 * min(tanks, 2) + min(carries, 1)
    if "Jazz" in active:
        score += len(NONUNIQUE.intersection(active))
    return score, active, holders


def assess(team, collab, inventory=None):
    return evaluate(team, collab, inventory or {})[:2]


def complete(units, selected, level, unlocked, inventory=None):
    team, _ = complete_with_band(units, selected, level, unlocked, inventory)
    return team


def complete_with_band(units, selected, level, unlocked, inventory=None):
    return ranked_decks(units, selected, level, unlocked, inventory)[0]


def ranked_decks(units, selected, level, unlocked, inventory=None, collab=3, jazz=None, gu_feng=False, priority="synergy"):
    if priority not in ("five", "synergy"):
        raise ValueError("추천 모드를 확인해 줘.")
    if collab not in (3, 5) or jazz not in (None, 2, 3) or type(gu_feng) is not bool:
        raise ValueError("추천 조건을 확인해 줘.")
    allowed = [i for i, u in enumerate(units) if u["id"] != SONA and (gu_feng or "Gu Feng" not in u["traits"])]
    candidates = [i for i in allowed if units[i]["id"] in selected]
    if len(candidates) < collab - 1 or level < collab:
        raise ValueError("콜라보 후보 또는 목표 인원이 부족해.")
    sona = next(i for i, u in enumerate(units) if u["id"] == SONA)
    recruits = [i for i in allowed if units[i]["id"] not in selected
                and (not units[i]["unlock"] or units[i]["id"] in unlocked)]
    akalis = {i for i, u in enumerate(units) if "Akali" in u["id"]}
    jazz_units = {i for i, u in enumerate(units) if "Jazz" in u["traits"]}

    seeds = [(sona, *group) for group in combinations(candidates, collab - 1)
             if len(akalis.intersection(group)) <= 1]
    finalists = {}
    for band in BANDS:
        roster = list(units)
        roster[sona] = with_band(units[sona], band)

        def rank(state):
            team = [roster[i] for i in state]
            score, active, holders = evaluate(team, selected, inventory or {})
            active_count = len(NONUNIQUE.intersection(active))
            five_cost = sum(u["cost"] == 5 for u in team)
            count = sum("Jazz" in u["traits"] for u in team) + sum("Jazz" in h for h in holders)
            distance = -abs(jazz - count) if jazz else 0
            if priority == "five":
                return distance, min(active_count, 8), five_cost, active_count, score
            return distance, 0, active_count if "Jazz" in active else 0, five_cost, score

        states = {seed: rank(seed) for seed in seeds}
        for _ in range(level - collab):
            choices = {}
            for state in states:
                for i in recruits:
                    if i in state or (i in akalis and not akalis.isdisjoint(state)):
                        continue
                    key = (*state[:collab], *sorted((*state[collab:], i)))
                    if key not in choices:
                        choices[key] = rank(key)
            ordered = sorted(choices, key=choices.get, reverse=True)
            states = {key: choices[key] for key in ordered[:24]}
            # Preserve a path to Jazz when high-cost units crowd out its first member.
            if ordered and (priority == "five" or not choices[ordered[0]][2]):
                starters = (key for key in ordered if not jazz_units.isdisjoint(key))
                for key in islice(starters, 24):
                    states[key] = choices[key]
        for state in sorted(states, key=states.get, reverse=True)[:3]:
            if states[state][0] != 0 or (priority == "five" and states[state][1] < 8):
                continue
            if state not in finalists or states[state] > finalists[state][0]:
                finalists[state] = states[state], band
    if not finalists:
        if priority == "five":
            raise ValueError("선택한 조건에서 활성 시너지 8개 이상인 덱을 찾지 못했어.")
        raise ValueError("이 조건으로 채울 수 있는 조합이 없어.")
    ordered = sorted(finalists, key=lambda state: finalists[state][0], reverse=True)
    return [([units[i] for i in state], finalists[state][1]) for state in ordered[:3]]


def main():
    serve(ranked_decks, evaluate)


if __name__ == "__main__":
    main()
