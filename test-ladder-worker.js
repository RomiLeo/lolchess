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

function planner() {
  let reply;
  const worker = vm.createContext({
    self: {postMessage: data => { reply = data; }},
    fetch: async file => ({ok: true, json: () => JSON.parse(read(file))}),
    importScripts: file => vm.runInContext(read(file), worker)
  });
  vm.runInContext(read("planner-worker.js"), worker);
  return async (emblem, selected) => {
    await worker.self.onmessage({data: {id: 1, path: emblem ? "ladder" : "pool", body: {emblem, selected}}});
    assert.ifError(reply.error);
    return reply.result;
  };
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
