"use strict";
const $ = id => document.getElementById(id);
const ladderPage = document.documentElement.dataset.page === "ladder";
const sona = "DA_Sona19";
const bands = ["Heartsteel", "Ionic Spark", "K/DA", "Pentakill", "True Damage"];
const colors = {1: "#aeb4bd", 2: "#53c776", 3: "#429cf5", 4: "#bb70ec", 5: "#efbd40", 7: "#fb794b"};
const state = {
  units: [], byId: new Map(), traits: new Map(), tiers: {}, items: [],
  pool: [], candidates: [], board: [], equipment: {}, focused: null, band: "",
  inventory: {}, unlocked: new Set(), result: null, mode: "manual", library: "pool",
  cost: 0, poolBusy: false, building: false, revision: 0
};
function element(tag, text, cls) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function btn(text, action, cls) {
  const el = element("button", text, cls);
  el.type = "button";
  el.onclick = action;
  return el;
}
function img(id) {
  const el = element("img");
  el.alt = "";
  el.loading = "lazy";
  const unit = state.byId.get(id);
  if (unit) {
    el.className = "champion-portrait";
    el.style.setProperty("--cost", colors[unit.cost] || "#c7d4d9");
  }
  el.src = "./assets/" + encodeURIComponent(id) + ".png";
  return el;
}
function option(value, label) {
  return new Option(label, value);
}
function msg(text) { $("feedback").textContent = text; }
function teamCodeControl(team) {
  // Set 19 codes from https://data.metatft.com/lookups/TFTSet19_pbe_en_us.json
  const slots = team.map(id => state.byId.get(id)?.teamPlannerCode);
  if (team.length > 10) return element("p", "팀 코드는 최대 10명까지 담을 수 있어.", "note");
  if (!slots.length || slots.some(code => !/^[0-9a-f]{3}$/i.test(code) || code === "000")) {
    return element("p", "팀 코드가 없는 기물이 포함되어 있어.", "note");
  }
  const code = "02" + slots.join("").padEnd(30, "0") + "TFTSet19";
  const group = element("div");
  const status = element("span");
  status.setAttribute("role", "status");
  const button = btn("팀 코드 복사", async () => {
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = " 복사했어.";
    } catch {
      const input = element("input");
      input.readOnly = true;
      input.value = code;
      input.setAttribute("aria-label", "수동 복사용 팀 코드");
      status.replaceChildren(" 코드를 선택해서 복사해 줘. ", input);
      input.focus();
      input.select();
    }
  });
  group.append(button, status);
  return group;
}
function name(trait) { return state.traits.get(trait)?.nameKo || trait; }
function invalidate() { state.revision++; state.result = null; }
let plannerWorker;
let requestId = 0;
const pending = new Map();
function workerRequest(path, body) {
  if (!plannerWorker) {
    plannerWorker = new Worker(document.documentElement.dataset.worker || "./planner-worker.js");
    plannerWorker.onmessage = ({data: {id, result, error}}) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    };
    plannerWorker.onerror = () => {
      for (const request of pending.values()) request.reject(new Error("덱 계산기를 불러올 수 없어."));
      pending.clear();
      plannerWorker.terminate();
      plannerWorker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    plannerWorker.postMessage({id, path, body});
    pending.set(id, {resolve, reject});
  });
}
async function api(path, body) {
  if (document.documentElement.dataset.backend === "static") return workerRequest(path, body);
  const response = await fetch("./api/" + path, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "요청을 처리할 수 없어.");
  return data;
}
async function setPool(selected, random = false) {
  if (state.poolBusy) return;
  state.poolBusy = true;
  renderPool();
  renderRoster();
  try {
    const data = await api("pool", {selected, random});
    state.pool = data.selected;
    state.candidates = data.candidates;
    invalidate();
    if (ladderPage && $("ladder-collab").checked) renderLadder();
    msg("");
  } catch (error) { msg(error.message); }
  finally {
    state.poolBusy = false;
    render();
  }
}
function togglePick(id) {
  setPool(state.pool.includes(id) ? state.pool.filter(p => p !== id) : [...state.pool,id]);
}
function renderPool() {
  $("pool-count").textContent = state.pool.length + "명";
  $("random").disabled = state.poolBusy || !state.units.length;
  const picks = state.pool.map(id => {
    const unit = state.byId.get(id);
    const item = btn("", () => togglePick(id), "pick");
    item.disabled = state.poolBusy;
    item.title = unit.nameKo + " 선택 해제";
    item.append(img(id), element("span",unit.nameKo),element("b","×"));
    return item;
  });
  $("picks").replaceChildren(...(picks.length ? picks : [element("p","아래 후보에서 기물을 선택하거나 랜덤으로 추첨해.","empty-picks")]));
}
function switchLib(value) {
  state.library = value;
  if (value === "all") state.mode = "manual";
  render();
}
function renderRoster() {
  const poolMode = state.library === "pool";
  const term = $("search").value.trim().toLowerCase();
  const candidates = new Set(state.candidates);
  const visible = state.units.filter(u =>
    (poolMode ? candidates.has(u.id) : !$("only").checked || state.pool.includes(u.id)) &&
    (!state.cost || u.cost === state.cost) &&
    (!term || [u.nameKo,u.name,...u.traitsKo,...u.traits].join(" ").toLowerCase().includes(term))
  );
  if (!ladderPage) {
    $("drawn-filter").hidden = poolMode;
    for (const b of $("library-tabs").children) b.setAttribute("aria-pressed", b.dataset.lib === state.library);
  }
  $("library-hint").textContent = (poolMode ? "선택 가능한 콜라보 기물" : "선택해서 수동 배치") + " · " + visible.length + "명";
  for (const b of $("costs").children) b.setAttribute("aria-pressed", Number(b.value) === state.cost);
  const cards = visible.map(u => {
    const el = btn("", () => poolMode ? togglePick(u.id) : addUnit(u.id), "unit");
    el.disabled = poolMode && state.poolBusy;
    el.setAttribute("aria-pressed", (poolMode ? state.pool : state.board).includes(u.id));
    el.style.setProperty("--cost", colors[u.cost] || "#c7d4d9");
    el.title = [u.nameKo,u.cost+"코",u.roleKo,...u.traitsKo,u.unlock].filter(Boolean).join(" · ");
    const frame = element("div",undefined,"portrait");
    frame.append(img(u.id),element("span",u.cost+"코","coin"));
    el.append(frame,element("strong",u.nameKo),element("span",u.traitsKo.join(" · "),"traits"));
    return el;
  });
  $("roster").replaceChildren(...(cards.length ? cards : [element("p","이 조건에 맞는 기물이 없어.","quiet")]));
}
function addUnit(id) {
  if (state.board.includes(id)) {
    state.focused = id;
  } else {
    if (id.includes("Akali") && state.board.some(u => u.includes("Akali"))) return msg("아칼리는 한 형태만 배치할 수 있어.");
    state.board.push(id);
    state.equipment[id] = [];
    state.focused = id;
  }
  msg(""); render();
}
function removeUnit(id) {
  state.board = state.board.filter(u => u !== id);
  delete state.equipment[id];
  if (state.focused === id) state.focused = state.board[0] || null;
  if (id === sona) state.band = "";
  render();
}
function renderEditor() {
  const id = state.focused;
  const root = $("editor");
  root.replaceChildren();
  if (state.mode !== "manual" || !id) return;
  const unit = state.byId.get(id), equipped = state.equipment[id];
  const box = element("div",undefined,"editor");
  box.append(element("strong", unit.nameKo + " · 상징 장착"));
  const choices = state.items.filter(item => !unit.traits.includes(item.trait) && !equipped.includes(item.trait) && !(id === sona && item.trait === state.band));
  const picker = element("select");
  picker.setAttribute("aria-label","장착할 상징");
  picker.append(...choices.map(item => option(item.trait,item.nameKo)));
  const add = btn("장착", () => { equipped.push(picker.value); renderBoard(); });
  add.disabled = equipped.length >= 3 || !choices.length;
  const row = element("div",undefined,"control"); row.append(picker,add);
  box.append(row);
  const group = element("div",undefined,"equipment");
  for (const trait of equipped) {
    const b = btn(name(trait)+" ×", () => { state.equipment[id] = equipped.filter(t => t !== trait); renderBoard(); });
    b.title = name(trait)+" 상징 해제";
    group.append(b);
  }
  box.append(group);
  if (id === sona) {
    const label = element("label","소나 밴드","control"), select = element("select");
    select.append(option("","미선택"),...bands.filter(t => !equipped.includes(t)).map(t => option(t,name(t))));
    select.value = state.band;
    select.onchange = () => {state.band = select.value;renderBoard();};
    label.append(select);box.append(label);
  }
  if (unit.unlock) box.append(element("p","해금 조건 · "+unit.unlock,"note"));
  root.append(box);
}
function traitRows(team, equipment, collab, band) {
  const counts = new Map();
  for (const id of team) {
    const all = new Set([...state.byId.get(id).traits,...(equipment[id] || [])]);
    if (collab.includes(id)) all.add("Collab");
    if (id === sona && band) all.add(band);
    for (const t of all) counts.set(t,(counts.get(t)||0)+(t==="K/DA"?2:1));
  }
  return [...counts].filter(([t]) => state.traits.has(t)).map(([t,count]) => {
    const tiers = state.tiers[t] || [];
    const active = Math.max(0,...tiers.filter(n => n <= count));
    return {t,count,active,tiers};
  }).sort((a,b) => Number(!!b.active)-Number(!!a.active) || name(a.t).localeCompare(name(b.t),"ko"));
}
function renderSynergies(team, equipment) {
  const band = state.mode === "manual" ? state.band : currentDeck()?.band;
  const rows = traitRows(team, equipment, state.pool, band);
  $("active-count").textContent = "고유 제외 활성 " + rows.filter(r => r.active && state.traits.get(r.t).type !== "unique").length + "개";
  $("synergies").replaceChildren(...(rows.length ? rows.map(({t,count,active,tiers}) => {
    const el = element("div",undefined,"synergy"+(active?" active":""));
    const unique = state.traits.get(t).type === "unique";
    el.append(img(state.traits.get(t).id),element("span",name(t)+" · "+count),element("small",(active ? "활성 "+active : tiers[0]+" 필요")+(unique ? " · 고유" : "")));
    return el;
  }) : [element("p","기물을 배치하면 특성별 활성 단계가 표시돼.","quiet")]));
}
function currentDeck() {
  return state.result?.decks?.[state.deckIndex] || state.result;
}
function renderBoard() {
  const manual = state.mode === "manual";
  const deck = currentDeck();
  const team = manual ? state.board : deck?.team || [];
  const equipment = manual ? state.equipment : deck?.equipment || {};
  $("auto").hidden = manual;
  const collab = Number(document.querySelector('[name="collab"]:checked').value);
  const available = state.pool.filter(id => $("gu-feng").checked || !state.byId.get(id).traits.includes("Gu Feng")).length;
  const needs = available < collab - 1 || Number($("level").value) < collab;
  $("pool-needed").textContent = needs ? collab+"콜라보에는 사용 가능한 후보 "+(collab-1)+"명과 목표 인원 "+collab+"명 이상이 필요해." : "";
  $("build").disabled = needs || state.building || state.poolBusy;
  $("build").textContent = state.building ? "조합 계산 중…" : "덱 자동 완성";
  for (const b of $("board-tabs").children) b.setAttribute("aria-pressed",b.dataset.mode === state.mode);
  $("team-title").textContent = manual ? "배치 라인업" : "추천 라인업";
  $("team-count").textContent = team.length + "명";
  const rows = team.map(id => {
    const u = state.byId.get(id), row = element("div",undefined,"team-row");
    const main = manual ? btn("",() => {state.focused=id;renderBoard();}) : element("div",undefined,"result");
    if (manual) main.setAttribute("aria-pressed",state.focused === id);
    const labels = element("span",u.nameKo+(state.pool.includes(id) || id === sona ? " ★":""));
    labels.append(element("small", [u.cost+"코",u.roleKo,...u.traitsKo].join(" · ")));
    if (!manual && id === sona && deck?.band) labels.append(element("strong","추천 밴드 · "+name(deck.band)));
    if (equipment[id]?.length) labels.append(element("small","상징 · "+equipment[id].map(name).join(", ")));
    if (!manual && u.unlock) labels.append(element("small","해금 · "+u.unlock));
    main.append(img(id),labels);row.append(main);
    if (manual) { const b = btn("×",() => removeUnit(id),"remove"); b.setAttribute("aria-label",u.nameKo+" 배치 해제");row.append(b); }
    return row;
  });
  $("team").replaceChildren(...(rows.length ? rows : [element("p",manual?"배치용 기물에서 라인업에 넣을 기물을 골라 봐.":"추천 조건을 선택하고 덱 자동 완성을 눌러 줘.","quiet")]));
  if (!manual && team.length) {
    const copy = teamCodeControl(team);
    copy.classList.add("team-code");
    $("team").prepend(copy);
    if (state.result.decks?.length > 1) {
      const ranks = element("div", undefined, "tabs");
      state.result.decks.forEach((_, index) => {
        const button = btn((index + 1) + "순위", () => { state.deckIndex = index; renderBoard(); });
        button.setAttribute("aria-pressed", index === state.deckIndex);
        ranks.append(button);
      });
      $("team").prepend(ranks);
    }
  }
  const unused = {...state.inventory};
  for (const items of Object.values(equipment)) for (const item of items) unused[item]--;
  const remaining = Object.entries(unused).filter(([,n]) => n > 0).map(([t,n]) => name(t)+" ×"+n);
  $("unused").replaceChildren();
  if (!manual && state.result && remaining.length) $("unused").append(element("p","미장착 상징 · "+remaining.join(", "),"note"));
  renderEditor();renderSynergies(team,equipment);
}
function render() {
  renderPool();
  renderRoster();
  if (!ladderPage) renderBoard();
}
let ladderPlans, ladderRevision = 0;
async function renderLadder() {
  const revision = ++ladderRevision;
  const emblem = $("ladder-emblem").value;
  const pool = $("ladder-collab").checked ? [...state.pool] : [];
  const root = $("ladder-guide");
  root.replaceChildren();
  if (!emblem) return;
  root.append(element("p", "9레벨 조합 계산 중…", "note"));
  try {
    const {routes, suggestions} = await workerRequest("ladder", {emblem, selected: pool});
    if (revision !== ladderRevision) return;
    const choices = routes.map((route, i) => {
      const base = routes[0].team;
      const delta = i ? route.team.filter(id => !base.includes(id)) : [];
      return {route, label: "조합 "+(i+1)+(delta.length ? " · "+delta.map(id => state.byId.get(id).nameKo).join(", ")+" 포함" : "")};
    });
    if (!routes.length) {
      for (const {extra, route} of suggestions) choices.push({route, extra, label: name(extra)+" 상징"});
      if (!ladderPlans) {
        ladderPlans = fetch("./ladder-plans.json").then(response => {
          if (!response.ok) throw new Error();
          return response.json();
        }).catch(error => { ladderPlans = null; throw error; });
      }
      const team = (await ladderPlans)[emblem];
      if (revision !== ladderRevision) return;
      choices.push({label: "10레벨 · 시작 상징만 사용", route: {team, levels: team.map((_, i) => i + 1), equipment: {[team[0]]: [emblem]}}});
    }
    const context = pool.length ? "선택한 콜라보 풀" : "콜라보 미적용";
    root.replaceChildren();
    if (routes.length) {
      root.append(element("p", context+" · "+name(emblem)+" 상징 1개로 9레벨 13특성 가능", "note"));
      if (pool.length) root.append(element("p","반영한 콜라보 풀 · "+pool.map(id => state.byId.get(id).nameKo).join(", ")+" (★ 배치 후보)"));
      root.append(element("h3", "9레벨 추천 조합"));
    } else {
      root.append(element("h2", "9레벨 13특성 달성 불가", "ladder-unavailable"));
    }
    const list = element("div", undefined, routes.length ? "ladder-choices" : "ladder-extra-emblems");
    if (!routes.length) list.append(element("strong", "추가 필요 상징:"), ...(suggestions.length ? [] : ["없음"]));
    const detail = element("div");
    detail.id = "ladder-choice-detail";
    const buttons = choices.map(({route, label, extra}) => {
      const button = btn("", () => {
        for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
        renderLadderRoute(detail, route, pool);
      }, routes.length ? "ladder-choice" : "ladder-alternative");
      button.setAttribute("aria-controls", detail.id);
      if (extra) {
        button.title = label;
        button.setAttribute("aria-label", label);
        button.append(img(state.traits.get(extra).id));
        return button;
      }
      if (!routes.length) {
        button.textContent = label;
        return button;
      }
      const roster = element("span", undefined, "ladder-roster");
      roster.append(...route.team.map(id => ladderPick(id, pool)));
      button.append(element("strong", label), roster);
      return button;
    });
    if (routes.length) list.append(...buttons);
    else list.append(...buttons.slice(0, suggestions.length));
    root.append(list);
    if (!routes.length) root.append(buttons.at(-1));
    root.append(detail);
    buttons[0].click();
  } catch {
    if (revision === ladderRevision) root.replaceChildren(element("p","사다리 조합을 불러오지 못했어. 상징을 다시 선택해 줘.","note"));
  }
}
function ladderPick(id, pool) {
  const unit = state.byId.get(id);
  const item = element("span", undefined, "ladder-pick");
  const portrait = img(id);
  portrait.style.border = "2px solid " + (colors[unit.cost] || "#c7d4d9");
  item.append(portrait, unit.nameKo + (pool.includes(id) ? " ★" : ""));
  return item;
}
function renderLadderRoute(root, {team, levels, equipment}, pool) {
  const activeTraits = ids => traitRows(ids, equipment, pool, "").filter(
    row => row.active && state.traits.get(row.t).type !== "unique"
  );
  const card = id => ladderPick(id, pool);
  const title = text => element("h3", text);
  const roster = element("div", undefined, "ladder-roster");
  roster.append(...team.map(card));
  const active = activeTraits(team);
  const steps = element("ol", undefined, "ladder-steps");
  for (let level = 1; level <= team.length; level++) {
    const members = team.filter((_, i) => levels[i] <= level);
    const added = team.filter((_, i) => levels[i] === level);
    const rows = activeTraits(members);
    const line = element("li");
    const detail = element("details"), summary = element("summary");
    summary.append(element("b", level + "레벨"), ...(added.length ? added.map(card) : [element("span","추가 기물 없음")]), element("small","활성 "+rows.length+"개"));
    detail.append(summary, element("p","배치 · "+members.map(uid => state.byId.get(uid).nameKo).join(", ")),
      element("p","활성 특성 · "+(rows.map(row => name(row.t)).join(", ") || "없음")));
    line.append(detail); steps.append(line);
  }
  const unlocks = team.filter(id => state.byId.get(id).unlock);
  const kda = team.filter(id => state.byId.get(id).traits.includes("K/DA") || equipment[id]?.includes("K/DA"));
  const assignments = Object.entries(equipment).map(([id, items]) =>
    state.byId.get(id).nameKo+"에게 "+items.map(t => name(t)+" 상징").join(", "));
  root.replaceChildren(title(team.length+"레벨 · "+active.length+"특성 조합"), roster,
    teamCodeControl(team),
    element("p", "상징 장착 · "+assignments.join(" / ")),
    element("p", "활성 특성 · "+active.map(row => name(row.t)+" "+row.count).join(" / ")));
  if (kda.length) root.append(element("p","K/DA는 "+kda.map(id => state.byId.get(id).nameKo).join(", ")+" 2성 기준이야.","note"));
  root.append(title("해금 준비"));
  if (!unlocks.length) root.append(element("p","이 경로에 필요한 해금 기물은 없어."));
  for (const id of unlocks) {
    const u = state.byId.get(id);
    root.append(element("p",levels[team.indexOf(id)]+"레벨 배치 전 · "+u.nameKo+" — "+u.unlock));
  }
  root.append(title("레벨별 추가 기물"), steps);
  if (levels.some((l, i) => l > i+1)) root.append(element("p","완성 기물이 들어오기 전 빈자리는 임시 기물로 채워도 돼.","note"));
}
async function build() {
  const revision = state.revision;
  state.building = true;renderBoard();msg("");
  try {
    const result = await api("complete",{selected:state.pool,level:Number($("level").value),unlocked:[...state.unlocked],inventory:state.inventory,
      priority:document.querySelector('[name="priority"]:checked').value,
      collab:Number(document.querySelector('[name="collab"]:checked').value),
      jazz:Number(document.querySelector('[name="jazz"]:checked').value), guFeng:$("gu-feng").checked});
    if (revision === state.revision) {
      state.result = result;
      state.deckIndex = 0;
    }
  } catch (error) { if (revision === state.revision) msg(error.message); }
  finally {state.building=false;renderBoard();}
}
function initControls() {
  $("random").onclick = () => setPool([],true);
  $("search").oninput = renderRoster;
  for (const cost of [0,...new Set(state.units.map(u => u.cost).sort((a,b)=>a-b))]) {
    const b = btn(cost ? cost+"코" : "전체",() => {state.cost=cost;renderRoster();});
    b.value = cost;
    $("costs").append(b);
  }
  if (ladderPage) {
    $("ladder-emblem").append(...state.items.map(item => option(item.trait, item.nameKo)));
    $("ladder-emblem").onchange = renderLadder;
    $("ladder-collab").onchange = renderLadder;
    return;
  }
  $("build").onclick = build;
  $("deck-conditions").onchange = () => {invalidate();renderBoard();};
  $("only").onchange = renderRoster;
  for (const b of $("library-tabs").children) b.onclick = () => switchLib(b.dataset.lib);
  for (const b of $("board-tabs").children) b.onclick = () => {
    state.mode = b.dataset.mode;
    state.library = state.mode === "auto" ? "pool" : "all";
    render();
  };
  for (let n=3;n<=11;n++) $("level").append(option(n,n+"명"));
  $("level").value = 10;
  $("level").onchange = () => {invalidate();renderBoard();};
  for (const u of state.units.filter(u=>u.unlock && u.id !== sona)) {
    const label = element("label"), check = element("input");
    check.type = "checkbox";
    check.value = u.id;
    check.onchange = () => {
      if (check.checked) state.unlocked.add(u.id); else state.unlocked.delete(u.id);
      $("unlock-count").textContent = state.unlocked.size+"명";
      invalidate();renderBoard();
    };
    label.append(check," "+u.nameKo+" · "+u.cost+"코",element("small",u.unlock));
    $("unlocks").append(label);
  }
  function setAllUnlocks(enabled) {
    state.unlocked.clear();
    for (const check of $("unlocks").querySelectorAll("input")) {
      check.checked = enabled;
      if (enabled) state.unlocked.add(check.value);
    }
    $("unlock-count").textContent = state.unlocked.size+"명";
    invalidate();
    renderBoard();
  }
  $("unlock-all").onclick = () => setAllUnlocks(true);
  $("unlock-none").onclick = () => setAllUnlocks(false);
  for (const item of state.items) {
    const label = element("label",item.nameKo,"inventory-row"), input = element("input");
    input.type = "number";input.min = 0;input.step = 1;input.value = 0;
    input.oninput = () => {
      const n = Math.max(0,Math.floor(Number(input.value)||0));
      if (n) state.inventory[item.trait]=n; else delete state.inventory[item.trait];
      if (input.value && input.value !== String(n)) input.value=n;
      $("owned-count").textContent = Object.values(state.inventory).reduce((a,b)=>a+b,0)+"개";
      invalidate();renderBoard();
    };
    label.append(input);$("inventory").append(label);
  }
}
async function init() {
  try {
    const {units,traits,emblems} = await api("catalog");
    state.units = units;
    state.byId = new Map(units.map(u=>[u.id,u]));
    state.traits = new Map(traits.traits.map(t=>[t.name,t]));
    state.tiers = traits.breakpoints;
    state.items = [...emblems.items].sort((a,b)=>a.nameKo.localeCompare(b.nameKo,"ko"));
    initControls();
    await setPool([]);
  } catch (error) {msg("데이터를 불러올 수 없어. "+error.message);}
}
init();
