"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, file), "utf8").replace(/^\uFEFF/, "");
const units = new Map(JSON.parse(read("units.json")).map(u => [u.id, u]));
const traits = JSON.parse(read("traits.json"));
const emblems = JSON.parse(read("emblems.json")).items;
const nonunique = new Set(traits.traits.filter(t => t.type !== "unique" && (traits.breakpoints[t.name]?.[0] || 0) > 0).map(t => t.name));

function planner() {
  let reply;
  const worker = vm.createContext({
    self: {postMessage: data => { reply = data; }},
    fetch: async file => ({ok: true, json: () => JSON.parse(read(file))}),
    importScripts: file => vm.runInContext(read(file), worker)
  });
  vm.runInContext(read("planner-worker.js"), worker);
  const request = async (emblem, selected, conditions) => {
    const pathName = conditions ? "complete" : emblem ? "ladder" : "pool";
    await worker.self.onmessage({data: {id: 1, path: pathName, body: {emblem, selected, ...conditions}}});
    assert.ifError(reply.error);
    return reply.result;
  };
  request.raw = async (pathName, body) => {
    await worker.self.onmessage({data: {id: 1, path: pathName, body}});
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  return request;
}

function activeTraitTiers(team, equipment, selected, band) {
  const counts = new Map();
  for (const id of team) {
    const names = new Set([...units.get(id).traits, ...(equipment[id] || [])]);
    if (selected.includes(id)) names.add("Collab");
    if (id === "DA_Sona19" && band) names.add(band);
    for (const t of names) counts.set(t, (counts.get(t) || 0) + (t === "K/DA" ? 2 : 1));
  }
  const active = new Map();
  for (const t of nonunique) {
    const count = counts.get(t) || 0;
    const tier = Math.max(0, ...(traits.breakpoints[t] || []).filter(n => n <= count));
    if (tier > 0) active.set(t, tier);
  }
  return active;
}

test("selecting one two-cost keeps compatible two-cost picks until the second slot is filled", async () => {
  const request = planner();
  const [first, second] = ["Camille", "Ezreal"].map(name =>
    [...units.values()].find(unit => unit.name === name && unit.cost === 2).id);
  const afterFirst = await request(null, [first]);
  assert(afterFirst.candidates.includes(second));
  const afterSecond = await request(null, [first, second]);
  assert(!afterSecond.candidates.some(id => units.get(id).cost === 2));
  assert(afterSecond.candidates.some(id => units.get(id).cost === 1));
});

test("both modes enforce active synergies on recruited high-cost carries and produce diverse top decks", async () => {
  const request = planner();
  const selected = ["DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19"];
  for (const priority of ["balance", "value"]) {
    const {decks} = await request(null, selected, {priority, level: 10, jazz: 2, unlocked: [...units.keys()]});
    assert.equal(decks.length, 3);
    const scores = Array.from(decks, d => d.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    for (let i = 0; i < decks.length; i++) {
      const d = decks[i];
      const active = activeTraitTiers(d.team, d.equipment, selected, d.band);
      if (priority === "value") assert(active.size >= 9);
      const b = d.breakdown;
      assert.equal(b.total, Math.round((b.synergy + b.carry + b.value + b.frontline) * 10) / 10);
      for (const id of d.team) {
        if (selected.includes(id) || id === "DA_Sona19") continue;
        const u = units.get(id);
        const isHighCarry = u.cost >= 4 && (/caster|marksman|fighter|assassin/i.test(u.role) || id === "DA_Jhin19" || id === "DA_Smeech19");
        const cTraits = u.traits.filter(t => nonunique.has(t) && t !== "Collab" && Math.max(...traits.breakpoints[t]) >= 2);
        if (isHighCarry && cTraits.length) {
          assert(cTraits.some(t => (active.get(t) || 0) >= 2), `${u.name} must have an active carry trait in ${priority}`);
        }
      }
      for (let j = i + 1; j < decks.length; j++) {
        const other = new Set(decks[j].team);
        assert(d.team.filter(id => !other.has(id)).length >= 2);
      }
    }
  }
});

test("all recommended decks satisfy the selected collab and Jazz counts", async () => {
  const request = planner();
  const selected = ["DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19"];
  for (const collab of [3, 5]) {
    for (const jazz of [2, 3]) {
      const {decks} = await request(null, selected, {
        collab, jazz, guFeng: false, priority: "balance",
        level: collab + 1, unlocked: [...units.keys()], inventory: {Jazz: jazz - 1}
      });
      assert(decks.length > 0);
      for (const {team, equipment} of decks) {
        assert.equal(team.filter(id => selected.includes(id) || id === "DA_Sona19").length, collab);
        assert.equal(team.filter(id => units.get(id).traits.includes("Jazz")).length +
          Object.values(equipment).flat().filter(t => t === "Jazz").length, jazz);
        assert(team.every(id => !units.get(id).traits.includes("Gu Feng")));
      }
    }
  }
});

test("value mode enforces nine active synergies and rejects impossible low-slot boards", async () => {
  const request = planner();
  const selected = ["DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19"];
  const options = {priority: "value", level: 9, jazz: 2, unlocked: [...units.keys()], inventory: {Jazz: 1}};
  const {decks} = await request(null, selected, options);
  assert.equal(decks.length, 3);
  for (const {team, equipment, band} of decks) {
    const active = activeTraitTiers(team, equipment, selected, band);
    assert(active.size >= 9);
  }
  await assert.rejects(request(null, selected, {...options, level: 3}), /9개/);
});

test("Smeech inclusion overrides general unlocks and requires nine synergies at level 9+", async () => {
  const request = planner();
  const selected = ["DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19"];
  for (const jazz of [2, 3]) {
    for (const smeech of [false, true]) {
      const {decks} = await request(null, selected.slice(0, 2), {
        level: 5, jazz, smeech, priority: "balance", inventory: {Jazz: jazz - 1},
        unlocked: smeech ? [] : [...units.keys()], guFeng: false
      });
      assert(decks.length);
      for (const {team, equipment} of decks) {
        assert.equal(team.includes("DA_Smeech19"), smeech);
        assert.equal(team.filter(id => units.get(id).traits.includes("Jazz")).length +
          Object.values(equipment).flat().filter(t => t === "Jazz").length, jazz);
      }
    }
  }
  const lv9 = await request(null, selected, {level: 9, jazz: 2, smeech: true, priority: "balance", unlocked: []});
  for (const d of lv9.decks) {
    assert(d.team.includes("DA_Smeech19"));
    assert(activeTraitTiers(d.team, d.equipment, selected, d.band).size >= 9);
  }
});

test("lucky units are always included with unlocked status and active core synergies", async () => {
  const request = planner();
  const selected = ["DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19", "DA_Yuumi19"];
  // Unlockable lucky units (Jinx + Aphelios) work even with unlocked: [] and activate tier >= 2 traits
  const {decks} = await request(null, selected, {
    level: 9, jazz: 2, priority: "balance", unlocked: [],
    lucky: ["DA_Jinx19", "DA_Aphelios19"]
  });
  assert(decks.length > 0);
  for (const d of decks) {
    assert(d.team.includes("DA_Jinx19"));
    assert(d.team.includes("DA_Aphelios19"));
    const active = activeTraitTiers(d.team, d.equipment, selected, d.band);
    assert((active.get("Ionic Spark") || 0) >= 3 || (active.get("Hitmaker") || 0) >= 2);
    assert((active.get("Heartsteel") || 0) >= 3);
  }

  // Lucky unit already inside the collab pool (Yuumi) is placed into the collab slots
  const inPool = await request(null, selected, {
    level: 8, collab: 3, jazz: 2, priority: "balance", unlocked: [], lucky: ["DA_Yuumi19"]
  });
  for (const d of inPool.decks) {
    assert(d.team.includes("DA_Yuumi19"));
    assert.equal(d.team.filter(id => selected.includes(id) || id === "DA_Sona19").length, 3);
  }

  // Gu Feng lucky unit (Wukong) activates Gu Feng >= 2 even when guFeng toggle is false
  const guFengLucky = await request(null, selected, {
    level: 8, collab: 3, jazz: 2, guFeng: false, priority: "balance", unlocked: [], lucky: ["DA_Wukong19"]
  });
  for (const d of guFengLucky.decks) {
    assert(d.team.includes("DA_Wukong19"));
    const active = activeTraitTiers(d.team, d.equipment, selected, d.band);
    assert((active.get("Gu Feng") || 0) >= 2);
  }

  await assert.rejects(request(null, selected, {
    level: 9, unlocked: [], lucky: ["DA_Jinx19", "DA_Aphelios19", "DA_19_Ahri"]
  }), /최대 2명/);
  await assert.rejects(request(null, selected, {
    level: 9, unlocked: [], lucky: ["DA_Akali_TrueDamage19", "DA_AkaliKDA19"]
  }), /아칼리/);
});

test("manual board score endpoint evaluates breakdowns and detects unmet carries", async () => {
  const request = planner();
  const withoutSynergy = await request.raw("score", {
    selected: [], team: ["DA_MissFortune19", "DA_Elise19"], equipment: {}, band: "", priority: "balance"
  });
  assert(withoutSynergy.unmetCarries.includes("DA_MissFortune19"));

  const withSynergy = await request.raw("score", {
    selected: [], team: ["DA_MissFortune19", "DA_Lucian19"], equipment: {}, band: "", priority: "balance"
  });
  assert.equal(withSynergy.unmetCarries.length, 0);
  assert(withSynergy.score > withoutSynergy.score);
});

test("a five-unit pool can add one unlockable three-cost alongside its regular three-cost", async () => {
  const request = planner();
  for (const [bonus, ...base] of [
    ["DA_Tibbers19", "DA_Zoe19", "DA_Katarina19", "DA_Ezreal19", "DA_Malzahar19", "DA_Yorick19"],
    ["DA_Evelynn19", "DA_Kayn19", "DA_Taric19", "DA_RenataGlasc19", "DA_Malzahar19", "DA_Yuumi19"]
  ]) {
    assert((await request(null, base)).candidates.includes(bonus));
    assert((await request(null, [bonus])).candidates.includes("DA_Malzahar19"));
    assert.equal((await request(null, [...base, bonus])).candidates.length, 0);
  }
  await assert.rejects(request(null, ["DA_Evelynn19", "DA_Tibbers19"]));
});

function checkRoute(route, emblem, pool, extra) {
  assert.equal(new Set(route.team).size, 9);
  assert.equal(route.team.length, 9);
  assert(route.team.includes(route.holder));
  assert(!units.get(route.holder).traits.includes(emblem));
  assert.deepEqual(Array.from(Object.values(route.equipment).flat()).sort(), (extra ? [emblem, extra] : [emblem]).sort());
  for (const [holder, items] of Object.entries(route.equipment)) {
    assert(route.team.includes(holder));
    assert.equal(new Set(items).size, items.length);
    for (const item of items) assert(!units.get(holder).traits.includes(item));
  }
  assert(route.team.filter(id => id.includes("Akali")).length <= 1);
  const counts = new Map();
  route.team.forEach((id, i) => {
    const u = units.get(id);
    const level = route.levels[i];
    assert(level >= i + 1 && level <= 9);
    assert(level >= ([0, 1, 3, 5, 7, 9][u.cost] || 1));
    assert(level >= Number(u.unlock?.match(/(\d+)레벨 이상/)?.[1] || 1));
    const names = new Set(u.traits);
    if (pool.includes(id)) names.add("Collab");
    for (const item of route.equipment[id] || []) names.add(item);
    for (const t of names) counts.set(t, (counts.get(t) || 0) + (t === "K/DA" ? 2 : 1));
  });
  const active = traits.traits.filter(t => t.type !== "unique" && traits.breakpoints[t.name][0] > 0 &&
    counts.get(t.name) >= traits.breakpoints[t.name][0]);
  assert(active.length >= 13);
  return active.map(t => t.name);
}

test("all emblems agree with independent no-collab feasibility results", async () => {
  const search = planner();
  const possible = new Set(["Frontman", "Hyperpop", "Hitmaker", "Jazz", "Juggernaut", "Slayer", "Classical"]);
  for (const {trait} of emblems) {
    const {route, routes, suggestions, withoutCollab} = await search(trait, []);
    assert.equal(withoutCollab, possible.has(trait), trait);
    assert.equal(Boolean(route), withoutCollab, trait);
    for (const board of routes) checkRoute(board, trait, []);
    if (routes.length > 1) {
      const scores = Array.from(routes, r => r.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    }
    assert.equal(new Set(routes.map(board => [...board.team].sort().join(","))).size, routes.length);
    if (["Jazz", "Hitmaker"].includes(trait)) assert(routes.length >= 2);
    if (!route) assert(suggestions.length > 0);
    for (const {extra, route: witness} of suggestions) checkRoute(witness, trait, [], extra);
    if (trait === "Arcanist") assert.deepEqual(Array.from(suggestions, s => s.extra).sort(), [
      "Bodyguard","Choreographer","Frontman","Hyperpop","Hitmaker","Illbeats","Ionic Spark",
      "Jazz","Juggernaut","Slayer","Renegade","Swiftstriker","Classical"
    ].sort());
    if (trait === "Rock") assert(suggestions.some(s => s.extra === trait));
  }
});

test("a legal pool enables a nine-unit Arcanist board via three deployed collab units", async () => {
  const search = planner();
  const pool = ["Elise", "Kennen", "Ezreal", "Bard", "Rell"].map(n => "DA_" + n + "19");
  const {route, withoutCollab} = await search("Arcanist", pool);
  assert.equal(withoutCollab, false);
  assert(checkRoute(route, "Arcanist", pool).includes("Collab"));
  assert(route.team.filter(id => pool.includes(id)).length >= 3);
  assert.equal((await search("Arcanist", pool.slice(0, 2))).route, null);
});
