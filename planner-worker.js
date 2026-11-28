"use strict";

importScripts("./ladder-worker.js");
const bands = ["Heartsteel", "Ionic Spark", "K/DA", "Pentakill", "True Damage"];
const teamBuffs = new Set(["Arcanist", "Bodyguard", "Choreographer", "Frontman", "Illbeats", "Manager", "Prodigy", "Swiftstriker"]);
const econTraits = new Set(["Hyperpop", "True Damage"]);
const bonusSlot = 6; // Separate pool slot for an extra unlockable three-cost.
const bonusUnits = new Set(["DA_Evelynn19", "DA_Tibbers19"]);
const poolSlot = u => u.unlock ? bonusSlot : u.cost;
const profiles = [[1, 1, 2], [1, 2, 2]].flatMap(low =>
  [[4], [5], [4, 5], [4, bonusSlot], [5, bonusSlot]].map(high => [...low, 3, ...high])
);
const weight = trait => trait === "K/DA" ? 2 : 1;
const round1 = value => Math.round(value * 10) / 10;
const byCost = Array.from({length: bonusSlot + 1}, () => []);
let catalog, units, byId, tiers, validTierIndex, minCarryTier, nonunique, knownEmblems, eligible, loading;

async function load() {
  const [rawUnits, traits, emblems] = await Promise.all(
    ["units", "traits", "emblems"].map(async name => {
      const response = await fetch("./" + name + ".json");
      if (!response.ok) throw new Error(name + ".json 파일을 불러올 수 없어.");
      return response.json();
    })
  );
  catalog = {units: rawUnits, traits, emblems};
  tiers = traits.breakpoints;
  validTierIndex = Object.create(null);
  minCarryTier = Object.create(null);
  for (const [t, levels] of Object.entries(tiers)) {
    const valid = levels.filter(n => n >= 2);
    if (valid.length) {
      minCarryTier[t] = valid[0];
      validTierIndex[t] = Object.fromEntries(valid.map((n, idx) => [n, idx]));
    }
  }
  nonunique = new Set(traits.traits.filter(t => t.type !== "unique" && (tiers[t.name]?.[0] || 0) > 0).map(t => t.name));
  knownEmblems = new Set(emblems.items.map(e => e.trait));
  units = rawUnits.map((u, i) => {
    const unitTraits = [...new Set(u.traits)];
    const tank = /tank/i.test(u.role);
    const slots = u.id === "DA_BaronNashor19" ? 2 : 1;
    const bruiser = /fighter/i.test(u.role) || u.id === "DA_Nunu19" || u.id === "DA_Rakan19";
    const frontWeight = tank || slots === 2 ? 1 : bruiser ? 0.5 : 0;
    const highCarry = u.cost >= 4 && (/caster|marksman|fighter|assassin/i.test(u.role) || u.id === "DA_Jhin19" || u.id === "DA_Smeech19");
    const carryTraits = unitTraits.filter(t => nonunique.has(t) && t !== "Collab" && (tiers[t]?.at(-1) || 0) >= 2);
    return {
      ...u, i, traits: unitTraits, tank, slots, frontWeight, highCarry, carryTraits,
      akali: u.id.includes("Akali")
    };
  });
  byId = new Map(units.map(u => [u.id, u]));
  eligible = units.filter(u => (!u.unlock || (u.cost === 3 && bonusUnits.has(u.id))) && u.traits.length === 2 && u.cost >= 1 && u.cost <= 5);
  for (const list of byCost) list.length = 0;
  for (const u of eligible) byCost[poolSlot(u)].push(u);
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
      const i = remaining.indexOf(poolSlot(u));
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

function evaluate(team, selected, inventory, options = {}) {
  const {lucky = new Set(), priority = "balance", fixedEquipment = null} = options;
  if (!team.length) {
    return {
      activeCount: 0, jazzCount: 0, legendUnits: 0, invalidCarry: false, unmetCarries: [],
      holders: [], counts: Object.create(null), activeTiers: Object.create(null),
      rawScore: 0, costSum: 0, score: 0,
      breakdown: {total: 0, synergy: 0, carry: 0, value: 0, frontline: 0}
    };
  }
  const counts = Object.create(null);
  let tanks = 0, front = 0, legendUnits = 0, teamSlots = 0, costSum = 0;
  for (const u of team) {
    for (const t of u.traits) counts[t] = (counts[t] || 0) + weight(t);
    if (selected.has(u.id) && !u.traits.includes("Collab")) counts.Collab = (counts.Collab || 0) + 1;
    tanks += u.tank ? 1 : 0;
    front += u.frontWeight;
    teamSlots += u.slots;
    costSum += u.cost;
    if (u.id !== "DA_Sona19" && u.cost >= 5) legendUnits += u.slots;
  }
  let holders;
  if (fixedEquipment) {
    holders = team.map(u => new Set((fixedEquipment[u.id] || []).filter(t => !u.traits.includes(t))));
    for (const equipped of holders) {
      for (const t of equipped) counts[t] = (counts[t] || 0) + weight(t);
    }
  } else if (inventory) {
    holders = placeEmblems(team, counts, inventory);
    for (const equipped of holders) {
      for (const t of equipped) counts[t] = (counts[t] || 0) + weight(t);
    }
  }

  const activeTiers = Object.create(null);
  let activeCount = 0, synergyRaw = 0;
  for (const t in counts) {
    const levels = tiers[t];
    if (!levels?.length || !levels[0]) continue;
    let tier = 0;
    for (const n of levels) if (n <= counts[t]) tier = n;
    if (tier && nonunique.has(t)) {
      activeTiers[t] = tier;
      activeCount++;
      const eff = tier / weight(t);
      const mult = teamBuffs.has(t) ? 1.25 : econTraits.has(t) ? 0.85 : 1.0;
      synergyRaw += mult * (1.5 + 3.0 * eff);
    }
  }
  const jazzTier = activeTiers.Jazz || 0;
  if (jazzTier === 2) synergyRaw += 1.5 * activeCount;
  else if (jazzTier === 3) synergyRaw += 2.25 * activeCount;
  else if (jazzTier >= 4) synergyRaw += 3.0 * activeCount;

  let carryScore = 0, invalidCarry = false;
  const unmetCarries = [];
  for (const u of team) {
    const isLucky = lucky.has(u.id);
    if (!isLucky && !u.highCarry) continue;
    const cTraits = u.carryTraits;
    if (!cTraits.length) continue;
    let unitGain = 0, onCount = 0;
    for (const t of cTraits) {
      const tier = activeTiers[t] || 0;
      if (tier >= 2) {
        onCount++;
        unitGain += 4.0 + 2.0 * (validTierIndex[t]?.[tier] || 0);
      }
    }
    if (!onCount) {
      unmetCarries.push(u.id);
      if (isLucky || !selected.has(u.id)) invalidCarry = true;
      carryScore -= isLucky ? 30.0 : 15.0;
    } else {
      if (cTraits.length >= 2 && onCount === cTraits.length) unitGain += 4.0;
      carryScore += (isLucky ? 2.0 : 1.0) * unitGain;
    }
  }

  const valueRaw = 6.0 * legendUnits;
  const targetFront = Math.max(2.0, 0.35 * teamSlots);
  let frontlineScore = 4.0 * Math.min(front, targetFront) + Math.min(3.0, 1.5 * Math.max(0, front - targetFront));
  if (teamSlots >= 7 && tanks < 2 && front < 2.5) frontlineScore -= 8.0;

  const wSyn = priority === "value" ? 0.85 : 1.0;
  const wVal = priority === "value" ? 2.2 : 1.0;
  const synergy = round1(wSyn * synergyRaw);
  const carry = round1(carryScore);
  const value = round1(wVal * valueRaw);
  const frontline = round1(frontlineScore);
  const total = round1(synergy + carry + value + frontline);
  const rawScore = Math.round((wSyn * synergyRaw + carryScore + wVal * valueRaw + frontlineScore) * 1000) * 100 + costSum;

  return {
    activeCount,
    jazzCount: counts.Jazz || 0,
    legendUnits,
    invalidCarry,
    unmetCarries,
    holders,
    counts,
    activeTiers,
    rawScore,
    costSum,
    score: total,
    breakdown: {total, synergy, carry, value, frontline}
  };
}

function compareFinal(a, b) {
  return b.rawScore - a.rawScore;
}

function selectDiverse(candidates, count = 3) {
  const ordered = [...candidates].sort(compareFinal);
  const picked = [];
  for (const state of ordered) {
    if (picked.length >= count) break;
    const ids = new Set(state.team.map(u => u.id));
    if (picked.every(p => p.team.filter(u => !ids.has(u.id)).length >= 2)) picked.push(state);
  }
  for (const state of ordered) {
    if (picked.length >= count) break;
    if (!picked.includes(state)) picked.push(state);
  }
  return picked;
}

function pruneBeam(states, minActive, jazz) {
  if (states.length <= 44) return states;
  const bySearch = [...states].sort((a, b) =>
    (jazz ? Math.abs(a.jazzCount - jazz) - Math.abs(b.jazzCount - jazz) : 0) || b.searchScore - a.searchScore
  );
  const kept = new Set(bySearch.slice(0, 36));
  if (minActive > 0) {
    const byActive = [...states].sort((a, b) => b.activeCount - a.activeCount || b.searchScore - a.searchScore);
    for (const s of byActive.slice(0, 18)) kept.add(s);
  }
  if (jazz && bySearch[0].jazzCount < jazz) {
    const byJazz = [...states].filter(s => s.jazzCount > 0).sort((a, b) => b.jazzCount - a.jazzCount || b.searchScore - a.searchScore);
    for (const s of byJazz.slice(0, 16)) kept.add(s);
  }
  return [...kept];
}

function complete({selected, level, unlocked, inventory = {}, collab = 3, jazz = null, guFeng = false, priority = "balance", smeech = false, lucky = []}) {
  const picks = new Set(selected);
  checkPool(selected.map(id => byId.get(id)));
  if (!Number.isInteger(level) || level < 3 || level > 11 || !Array.isArray(unlocked) ||
      Object.entries(inventory).some(([t, n]) => !knownEmblems.has(t) || !Number.isInteger(n) || n < 0)) {
    throw new Error("덱 인원과 상징 수량을 확인해 줘.");
  }
  if (!["balance", "value"].includes(priority)) throw new Error("추천 모드를 확인해 줘.");
  if (![3, 5].includes(collab) || ![null, 2, 3].includes(jazz) || typeof guFeng !== "boolean") throw new Error("추천 조건을 확인해 줘.");
  if (typeof smeech !== "boolean") throw new Error("스미치 포함 설정을 확인해 줘.");
  if (!Array.isArray(lucky) || lucky.length > 2 || new Set(lucky).size !== lucky.length ||
      lucky.some(id => !byId.has(id) || ![4, 5].includes(byId.get(id).cost))) {
    throw new Error("럭키 기물은 4·5코스트 기물 중 최대 2명까지 선택할 수 있어.");
  }
  const luckyUnits = lucky.map(id => byId.get(id));
  if (luckyUnits.filter(u => u.akali).length > 1) throw new Error("아칼리는 한 형태만 배치할 수 있어.");

  const sona = byId.get("DA_Sona19");
  const smeechUnit = byId.get("DA_Smeech19");
  if (smeech && level <= collab) throw new Error("스미치를 포함하려면 콜라보 외에 한 자리가 더 필요해.");

  const luckySet = new Set(lucky);
  const allowGuFengPool = guFeng || luckyUnits.some(u => u.traits.includes("Gu Feng"));
  const allowed = units.filter(u => u !== sona && u !== smeechUnit && (allowGuFengPool || !u.traits.includes("Gu Feng")));
  const luckyCollab = luckyUnits.filter(u => picks.has(u.id));
  const luckyExtra = luckyUnits.filter(u => !picks.has(u.id));
  const candidates = allowed.filter(u => picks.has(u.id) && !luckySet.has(u.id));
  if (luckyCollab.length + candidates.length < collab - 1 || level < collab) {
    throw new Error("콜라보 후보 또는 목표 인원이 부족해.");
  }
  const fixedExtras = [...(smeech ? [smeechUnit] : []), ...luckyExtra];
  const minSlots = collab + fixedExtras.reduce((sum, u) => sum + u.slots, 0);
  if (level < minSlots) throw new Error("콜라보와 필수 기물을 모두 배치하려면 목표 인원을 늘려 줘.");

  const recruits = allowed.filter(u => !picks.has(u.id) && !luckySet.has(u.id) && (
    (guFeng && u.traits.includes("Gu Feng")) ||
    (!guFeng && allowGuFengPool && u.traits.includes("Gu Feng") && !u.unlock) ||
    !u.unlock || unlocked.includes(u.id)
  ));
  const items = Object.keys(inventory).length ? inventory : null;
  const minActive = priority === "value" || (smeech && level >= 9) ? 9 : 0;
  const fixedPrefix = collab + fixedExtras.length;
  const finalists = new Map();

  for (const band of bands) {
    const leader = {...sona, traits: [...new Set([...sona.traits, band])], carryTraits: []};
    const rankStep = (team, remainingSlots) => {
      const res = evaluate(team, picks, items, {lucky: luckySet, priority});
      if (jazz !== null) {
        const equippedJazz = res.holders ? res.holders.reduce((s, h) => s + h.has("Jazz"), 0) : 0;
        const spareJazz = items?.Jazz ? Math.max(0, items.Jazz - equippedJazz) : 0;
        if (res.jazzCount > jazz || res.jazzCount + remainingSlots + spareJazz < jazz) return null;
      }
      if (!remainingSlots) return {...res, team, searchScore: res.rawScore};

      let potential = 0;
      const urgentTraits = new Set();
      for (const u of team) {
        const isLucky = luckySet.has(u.id);
        if (!isLucky && !u.highCarry) continue;
        if (!u.carryTraits.length) continue;
        const anyOn = u.carryTraits.some(t => (res.activeTiers[t] || 0) >= 2);
        if (anyOn) continue;
        let canReach = false;
        for (const t of u.carryTraits) {
          const minTier = minCarryTier[t];
          const equipped = res.holders ? res.holders.reduce((s, h) => s + h.has(t), 0) : 0;
          const spare = items?.[t] ? Math.max(0, items[t] - equipped) : 0;
          const need = Math.ceil((minTier - (res.counts[t] || 0)) / weight(t));
          if (need <= remainingSlots + spare) {
            canReach = true;
            urgentTraits.add(t);
          }
        }
        if (!canReach && (isLucky || !picks.has(u.id))) return null;
      }

      // Compensate temporary unmet-carry penalty while slots remain open, and reward near-complete traits.
      for (const uid of res.unmetCarries) {
        potential += (luckySet.has(uid) ? 26.0 : 13.0) * 100000;
      }
      for (const t in res.counts) {
        if (!nonunique.has(t)) continue;
        const nextTier = tiers[t]?.find(n => n > (res.counts[t] || 0));
        if (!nextTier) continue;
        const need = Math.ceil((nextTier - res.counts[t]) / weight(t));
        if (need <= remainingSlots) {
          if (urgentTraits.has(t)) potential += Math.round((4.0 / need) * 100000);
          else if (!(res.activeTiers[t] || 0) && need === 1) potential += 150000;
        }
      }
      return {...res, team, searchScore: res.rawScore + potential};
    };

    const buckets = Array.from({length: level + 1}, () => new Map());
    function seed(collabTeam, start) {
      if (collabTeam.length === collab) {
        const fullSeed = [...collabTeam, ...fixedExtras];
        const usedSlots = fullSeed.reduce((s, u) => s + u.slots, 0);
        if (usedSlots <= level) {
          const step = rankStep(fullSeed, level - usedSlots);
          if (step) buckets[usedSlots].set(fullSeed.map(u => u.i).join(","), step);
        }
        return;
      }
      for (let i = start; i < candidates.length; i++) {
        const u = candidates[i];
        if (u.akali && (collabTeam.some(m => m.akali) || fixedExtras.some(m => m.akali))) continue;
        seed([...collabTeam, u], i + 1);
      }
    }
    seed([leader, ...luckyCollab], 0);

    for (let s = minSlots; s < level; s++) {
      const states = pruneBeam([...buckets[s].values()], minActive, jazz);
      for (const {team} of states) {
        const hasAkali = team.some(u => u.akali);
        for (const u of recruits) {
          const nextSlots = s + u.slots;
          if (nextSlots > level || team.includes(u) || (hasAkali && u.akali)) continue;
          const next = [...team.slice(0, fixedPrefix), ...[...team.slice(fixedPrefix), u].sort((a, b) => a.i - b.i)];
          const key = next.map(member => member.i).join(",");
          if (!buckets[nextSlots].has(key)) {
            const step = rankStep(next, level - nextSlots);
            if (step) buckets[nextSlots].set(key, step);
          }
        }
      }
    }

    const valid = [...buckets[level].values()].filter(s =>
      !s.invalidCarry && (jazz === null || s.jazzCount === jazz) && s.activeCount >= minActive
    );
    for (const state of valid.sort(compareFinal).slice(0, 24)) {
      const key = state.team.map(u => u.id).join(",");
      const previous = finalists.get(key);
      if (!previous || compareFinal(state, previous) < 0) finalists.set(key, {...state, band});
    }
  }

  if (!finalists.size) {
    if (minActive >= 9) throw new Error("선택한 조건에서 활성 시너지 9개 이상인 덱을 찾지 못했어.");
    throw new Error("이 조건으로 채울 수 있는 조합이 없어.");
  }
  const decks = selectDiverse([...finalists.values()], 3).map(winner => {
    const team = winner.team.map(u => u.id);
    const res = evaluate(winner.team, picks, items, {lucky: luckySet, priority});
    const equipment = Object.fromEntries(team.map((id, i) => [id, res.holders ? [...res.holders[i]].sort() : []]));
    return {
      team, band: winner.band, equipment,
      score: res.score, breakdown: res.breakdown, activeCount: res.activeCount
    };
  });
  return {...decks[0], decks};
}

function scoreBoard({selected = [], team = [], equipment = {}, band = "", lucky = [], priority = "balance"}) {
  if (!Array.isArray(team) || team.some(uid => !byId.has(uid))) throw new Error("배치 기물을 확인해 줘.");
  if (!["balance", "value"].includes(priority)) throw new Error("추천 모드를 확인해 줘.");
  const sona = byId.get("DA_Sona19");
  const teamUnits = team.map(id => {
    const u = byId.get(id);
    if (u === sona && band && bands.includes(band) && !u.traits.includes(band)) {
      return {...u, traits: [...u.traits, band], carryTraits: []};
    }
    return u;
  });
  const res = evaluate(teamUnits, new Set(selected), null, {
    lucky: new Set(Array.isArray(lucky) ? lucky : []),
    priority,
    fixedEquipment: equipment || {}
  });
  return {
    score: res.score,
    breakdown: res.breakdown,
    activeCount: res.activeCount,
    unmetCarries: res.unmetCarries
  };
}

function scoreLadderRoute(route, poolIds) {
  const teamUnits = route.team.map(id => byId.get(id));
  return evaluate(teamUnits, new Set(poolIds), null, {priority: "balance", fixedEquipment: route.equipment});
}

self.onmessage = async ({data: {id, path, body}}) => {
  try {
    if (!loading) loading = load().catch(error => { loading = null; throw error; });
    await loading;
    let result;
    if (path === "catalog") result = catalog;
    else if (path === "score") result = scoreBoard(body || {});
    else {
      if (!Array.isArray(body.selected) || body.selected.some(uid => !byId.has(uid))) {
        throw new Error("기물 선택을 확인해 줘.");
      }
      if (path === "pool") result = pool(body.random ? draw() : body.selected);
      else if (path === "ladder") {
        if (!knownEmblems.has(body.emblem)) throw new Error("시작 상징을 확인해 줘.");
        checkPool(body.selected.map(uid => byId.get(uid)));
        const {emblem, selected} = body;
        const base = findLadders(units, catalog.traits, emblem, [], [], scoreLadderRoute).routes;
        const routes = selected.length ? findLadders(units, catalog.traits, emblem, selected, [], scoreLadderRoute).routes : base;
        const suggestions = routes.length ? [] : findLadders(units, catalog.traits, emblem, selected, [...knownEmblems], scoreLadderRoute).suggestions;
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
