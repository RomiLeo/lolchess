"use strict";

importScripts("./ladder-worker.js");
const bands = ["Heartsteel", "Ionic Spark", "K/DA", "Pentakill", "True Damage"];
const profiles = [[1, 1, 2], [1, 2, 2]].flatMap(low =>
  [[4], [5], [4, 5]].map(high => [...low, 3, ...high])
);
const weight = trait => trait === "K/DA" ? 2 : 1;
const byCost = Array.from({length: 6}, () => []);
let catalog, units, byId, tiers, nonunique, knownEmblems, eligible, loading;

async function load() {
  const [rawUnits, traits, emblems] = await Promise.all(
    ["units", "traits", "emblems"].map(async name => {
      const response = await fetch("./" + name + ".json");
      if (!response.ok) throw new Error(name + ".json 파일을 불러올 수 없어.");
      return response.json();
    })
  );
  catalog = {units: rawUnits, traits, emblems};
  units = rawUnits.map((u, i) => ({
    ...u, i, traits: [...new Set(u.traits)], tank: /tank/i.test(u.role),
    carry: /caster|marksman|fighter/i.test(u.role), akali: u.id.includes("Akali")
  }));
  byId = new Map(units.map(u => [u.id, u]));
  tiers = traits.breakpoints;
  nonunique = new Set(traits.traits.filter(t => t.type !== "unique").map(t => t.name));
  knownEmblems = new Set(emblems.items.map(e => e.trait));
  eligible = units.filter(u => !u.unlock && u.traits.length === 2 && u.cost >= 1 && u.cost <= 5);
  for (const u of eligible) byCost[u.cost].push(u);
}

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Fill the open cost slots without reusing any base trait.
function fill(costs, index, groups, taken, team) {
  if (index === costs.length) return true;
  for (const u of groups[costs[index]]) {
    if (u.traits.some(t => taken.has(t))) continue;
    for (const t of u.traits) taken.add(t);
    team.push(u);
    if (fill(costs, index + 1, groups, taken, team)) return true;
    team.pop();
    for (const t of u.traits) taken.delete(t);
  }
  return false;
}

function draw() {
  const groups = byCost.map(shuffle);
  for (const profile of shuffle(profiles)) {
    const team = [];
    if (fill([...profile].reverse(), 0, groups, new Set(), team)) {
      return team.sort((a, b) => a.cost - b.cost).map(u => u.id);
    }
  }
  throw new Error("추정 추첨 조건을 만족하는 조합이 없어.");
}

function possible(selected) {
  if (selected.some(u => !eligible.includes(u))) return false;
  const traits = new Set(selected.flatMap(u => u.traits));
  if (traits.size !== selected.length * 2) return false;
  return profiles.some(profile => {
    const remaining = [...profile];
    for (const u of selected) {
      const i = remaining.indexOf(u.cost);
      if (i < 0) return false;
      remaining.splice(i, 1);
    }
    return fill(remaining, 0, byCost, new Set(traits), []);
  });
}

function checkPool(selected) {
  if (!possible(selected)) throw new Error("선택한 기물로는 콜라보 후보군을 완성할 수 없어.");
}

function pool(ids) {
  const selected = ids.map(id => byId.get(id));
  checkPool(selected);
  return {selected: ids, candidates: eligible.filter(u => possible([...selected, u])).map(u => u.id)};
}

function placeEmblems(team, counts, inventory) {
  const holders = team.map(() => new Set());
  const entries = Object.entries(inventory);
  const options = new Map(entries.map(([trait]) => [
    trait, team.map((u, i) => u.traits.includes(trait) ? -1 : i).filter(i => i >= 0)
  ]));
  if (entries.length <= 3) {
    for (const [trait, n] of entries) {
      for (const i of options.get(trait).slice(0, n)) holders[i].add(trait);
    }
    return holders;
  }

  function assign(trait, visited) {
    if (visited.has(trait)) return false;
    visited.add(trait);
    const candidates = options.get(trait).filter(i => !holders[i].has(trait));
    for (const i of candidates) {
      if (holders[i].size < 3) {
        holders[i].add(trait);
        return true;
      }
    }
    for (const i of candidates) {
      for (const other of [...holders[i]].sort()) {
        if (assign(other, visited)) {
          holders[i].delete(other);
          holders[i].add(trait);
          return true;
        }
      }
    }
    return false;
  }

  const remaining = entries.map(([trait, n]) => ({
    trait, n: Math.min(n, options.get(trait).length), used: 0
  }));
  let slots = team.length * 3;
  while (slots) {
    let best, bestGain = -1;
    for (const item of remaining) {
      if (!item.n) continue;
      const t = item.trait, w = weight(t);
      const start = (counts[t] || 0) + item.used * w;
      let previous = 0, gain = 0;
      for (const tier of tiers[t]) {
        if (tier <= start) previous = tier;
        else if (tier <= start + w * item.n) {
          gain = Math.max(gain, (tier - previous) / Math.ceil((tier - start) / w));
        }
      }
      if (start < tiers[t].at(-1)) gain += 0.15 * w;
      if (gain > bestGain) {
        bestGain = gain;
        best = item;
      }
    }
    if (!best) break;
    if (assign(best.trait, new Set())) {
      best.n--;
      best.used++;
      slots--;
    } else best.n = 0;
  }
  return holders;
}

function evaluate(team, selected, inventory) {
  const counts = Object.create(null);
  let tanks = 0, carries = 0, fiveCost = 0;
  for (const u of team) {
    for (const t of u.traits) counts[t] = (counts[t] || 0) + weight(t);
    if (selected.has(u.id) && !u.traits.includes("Collab")) counts.Collab = (counts.Collab || 0) + 1;
    tanks += u.tank;
    carries += u.carry;
    if (u.cost === 5) fiveCost++;
  }
  let holders;
  if (inventory) {
    holders = placeEmblems(team, counts, inventory);
    for (const equipped of holders) {
      for (const t of equipped) counts[t] = (counts[t] || 0) + weight(t);
    }
  }

  // Score in twentieths so mathematically tied compositions stay tied.
  let score = 30 * Math.min(tanks, 2) + 20 * Math.min(carries, 1);
  let activeCount = 0, jazz = false;
  for (const t in counts) {
    const levels = tiers[t];
    if (!levels?.length) continue;
    let tier = 0;
    for (const n of levels) if (n <= counts[t]) tier = n;
    if (tier && nonunique.has(t)) activeCount++;
    if (tier && t === "Jazz") jazz = true;
    const max = levels.at(-1);
    if (max > 1) score += 20 * tier + 3 * Math.min(counts[t], max);
  }
  return {rank: [jazz ? activeCount : 0, fiveCost, score + (jazz ? 20 * activeCount : 0)], holders};
}

function compare(a, b) {
  return b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2];
}

function complete({selected, level, unlocked, inventory = {}}) {
  const picks = new Set(selected);
  checkPool(selected.map(id => byId.get(id)));
  if (!Number.isInteger(level) || level < 3 || level > 11 || !Array.isArray(unlocked) ||
      Object.entries(inventory).some(([t, n]) => !knownEmblems.has(t) || !Number.isInteger(n) || n < 0)) {
    throw new Error("덱 인원과 상징 수량을 확인해 줘.");
  }
  const sona = byId.get("DA_Sona19");
  const candidates = units.filter(u => u !== sona && picks.has(u.id));
  if (candidates.length < 2) throw new Error("3콜라보 추천을 받으려면 후보를 두 명 이상 입력해 줘.");
  const recruits = units.filter(u => u !== sona && !picks.has(u.id) && (!u.unlock || unlocked.includes(u.id)));
  const items = Object.keys(inventory).length ? inventory : null;
  let winner;
  for (const band of bands) {
    const leader = {...sona, traits: [...new Set([...sona.traits, band])]};
    const rankTeam = team => ({team, rank: evaluate(team, picks, items).rank});
    let states = [];
    for (const [i, a] of candidates.entries()) {
      for (const b of candidates.slice(i + 1)) {
        if (!(a.akali && b.akali)) states.push(rankTeam([leader, a, b]));
      }
    }
    for (let size = 3; size < level; size++) {
      const choices = new Map();
      for (const {team} of states) {
        const hasAkali = team.some(u => u.akali);
        for (const u of recruits) {
          if (team.includes(u) || (hasAkali && u.akali)) continue;
          const next = [...team.slice(0, 3), ...[...team.slice(3), u].sort((a, b) => a.i - b.i)];
          const key = next.map(member => member.i).join(",");
          if (!choices.has(key)) choices.set(key, rankTeam(next));
        }
      }
      const ordered = [...choices.values()].sort(compare);
      states = ordered.slice(0, 24);
      if (ordered.length && !ordered[0].rank[0]) {
        const starters = ordered.filter(s => s.team.some(u => u.traits.includes("Jazz"))).slice(0, 24);
        states = [...new Set([...states, ...starters])];
      }
    }
    const best = states.sort(compare)[0];
    if (best && (!winner || compare(best, winner) < 0)) winner = {...best, band};
  }
  if (!winner) throw new Error("이 조건으로 채울 수 있는 조합이 없어.");
  const team = winner.team.map(u => u.id);
  const {holders} = evaluate(winner.team, picks, items);
  const equipment = Object.fromEntries(team.map((id, i) => [id, holders ? [...holders[i]].sort() : []]));
  return {team, band: winner.band, equipment};
}

self.onmessage = async ({data: {id, path, body}}) => {
  try {
    if (!loading) loading = load().catch(error => { loading = null; throw error; });
    await loading;
    let result;
    if (path === "catalog") result = catalog;
    else {
      if (!Array.isArray(body.selected) || body.selected.some(uid => !byId.has(uid))) {
        throw new Error("기물 선택을 확인해 줘.");
      }
      if (path === "pool") result = pool(body.random ? draw() : body.selected);
      else if (path === "ladder") {
        if (!knownEmblems.has(body.emblem)) throw new Error("시작 상징을 확인해 줘.");
        checkPool(body.selected.map(uid => byId.get(uid)));
        const {emblem, selected} = body;
        const base = findLadders(units, catalog.traits, emblem, []).routes;
        const routes = selected.length ? findLadders(units, catalog.traits, emblem, selected).routes : base;
        const suggestions = routes.length ? [] : findLadders(units, catalog.traits, emblem, selected, [...knownEmblems]).suggestions;
        result = {route: routes[0] || null, routes, suggestions, withoutCollab: base.length > 0};
      }
      else if (path === "complete") result = complete(body);
      else throw new Error("요청을 처리할 수 없어.");
    }
    self.postMessage({id, result});
  } catch (error) {
    self.postMessage({id, error: error.message});
  }
};
