"use strict";

function findLadders(units, catalog, emblem, pool, extraEmblems = [], scoreFn = null) {
  function bitCount(value) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  const traits = catalog.traits.filter(t => t.type !== "unique" && catalog.breakpoints[t.name][0] > 0);
  if (traits.length > 32) throw new Error("사다리 계산기의 특성 개수 범위를 초과했어.");
  const bits = new Map(traits.map((t, i) => [t.name, 1 << i]));
  const tier = [0, 0, 0, 0];
  for (const t of traits) {
    // A two-star K/DA member gives two points toward its first breakpoint.
    const need = Math.ceil(catalog.breakpoints[t.name][0] / (t.name === "K/DA" ? 2 : 1));
    if (need > 3) throw new Error("사다리 계산기가 지원하지 않는 활성 단계야.");
    tier[need] |= bits.get(t.name);
  }
  const goal = 13, size = 9, emblemBit = bits.get(emblem);
  const collected = [], boardKeys = new Set(), suggestions = new Map();
  let extra = null;
  const limit = 6;
  const collectLimit = scoreFn ? 24 : limit;
  const candidates = [];
  for (const unit of units) {
    if (unit.id === "DA_BaronNashor19") continue;
    const unlockLevel = Number(unit.unlock?.match(/(\d+)레벨 이상/)?.[1] || 1);
    const earliest = Math.max(unlockLevel, [0, 1, 3, 5, 7, 9][unit.cost] || unlockLevel);
    if (earliest > size) continue;
    let mask = 0;
    for (const t of unit.traits) mask |= bits.get(t) || 0;
    if (pool.includes(unit.id)) mask |= bits.get("Collab");
    if (!mask) continue;
    const value = 6 * bitCount(mask & tier[1]) + 3 * bitCount(mask & tier[2]) + 2 * bitCount(mask & tier[3]);
    candidates.push({id: unit.id, cost: unit.cost, mask, earliest, value, akali: unit.id.includes("Akali")});
  }
  candidates.sort((a, b) => b.value - a.value || a.earliest - b.earliest || b.cost - a.cost);
  const n = candidates.length;
  const sums = [0], available = new Int32Array(n + 1);
  for (const u of candidates) sums.push(sums.at(-1) + u.value);
  for (let i = n - 1; i >= 0; i--) available[i] = available[i + 1] | candidates[i].mask;
  const team = [], late = new Uint8Array(size + 1);
  function record() {
    const sorted = [...team].sort((a, b) => a.earliest - b.earliest);
    const equipment = {};
    let holder;
    for (const trait of extra ? [emblem, extra] : [emblem]) {
      const unit = sorted.find(u => !(u.mask & bits.get(trait)) && !equipment[u.id]?.includes(trait));
      if (!unit) return;
      (equipment[unit.id] ||= []).push(trait);
      holder ||= unit.id;
    }
    const ids = sorted.map(u => u.id);
    const route = {team: ids, holder, equipment, levels: sorted.map((u, i) => Math.max(u.earliest, i + 1))};
    if (scoreFn) {
      const scored = scoreFn(route, pool);
      route.score = scored.score;
      route.breakdown = scored.breakdown;
      route._raw = scored.rawScore;
    }
    if (extra) suggestions.set(extra, route);
    else {
      const key = [...ids].sort().join("/");
      if (!boardKeys.has(key)) {
        boardKeys.add(key);
        collected.push(route);
      }
    }
  }
  function search(start, once, twice, thrice, hasAkali, gradual) {
    const left = size - team.length;
    const active = (once & tier[1]) | (twice & tier[2]) | (thrice & tier[3]);
    if (!left) {
      if (bitCount(active) >= goal) record();
      return extra ? suggestions.has(extra) : collected.length >= collectLimit;
    }
    // Value is measured in sixths of an active trait. Cap past contributions
    // at the breakpoint and ignore unfinished traits no later unit can finish.
    const reachable = available[start];
    const partial = 6 * bitCount(active) +
      3 * bitCount(once & tier[2] & ~active & reachable) +
      2 * (bitCount(once & tier[3] & ~active & reachable) + bitCount(twice & tier[3] & ~active & reachable));
    for (let i = start; i <= n - left; i++) {
      if (partial + sums[i + left] - sums[i] < goal * 6) break;
      const u = candidates[i];
      if (u.akali && hasAkali) continue;
      // At most size-L+1 units can enter a one-addition-per-level route at level L or later.
      let fits = true;
      for (let l = 2; l <= u.earliest; l++) if (late[l] >= size - l + 1) fits = false;
      if (gradual && !fits) continue;
      for (let l = 2; l <= u.earliest; l++) late[l]++;
      team.push(u);
      const result = search(i + 1, once | u.mask, twice | (once & u.mask), thrice | (twice & u.mask), hasAkali || u.akali, gradual);
      team.pop();
      for (let l = 2; l <= u.earliest; l++) late[l]--;
      if (result) return true;
    }
    return null;
  }
  if (extraEmblems.length) {
    for (extra of extraEmblems) {
      const extraBit = bits.get(extra);
      search(0, emblemBit | extraBit, emblemBit & extraBit, 0, false, false);
    }
  } else if (!search(0, emblemBit, 0, 0, false, true) && collected.length < limit) {
    // Include less gradual routes when fewer than six smooth routes exist.
    search(0, emblemBit, 0, 0, false, false);
  }
  let routes = collected;
  if (scoreFn && routes.length > 1) {
    const ordered = [...routes].sort((a, b) => b._raw - a._raw);
    const picked = [];
    for (const r of ordered) {
      if (picked.length >= limit) break;
      const set = new Set(r.team);
      if (picked.every(p => p.team.filter(id => !set.has(id)).length >= 2)) picked.push(r);
    }
    for (const r of ordered) {
      if (picked.length >= limit) break;
      if (!picked.includes(r)) picked.push(r);
    }
    routes = picked;
    for (const r of routes) delete r._raw;
  } else {
    routes = routes.slice(0, limit);
  }
  for (const r of suggestions.values()) delete r._raw;
  return {routes, suggestions: extraEmblems.filter(t => suggestions.has(t)).map(extra => ({extra, route: suggestions.get(extra)}))};
}
