import random
import tkinter as tk
from collections import Counter, defaultdict
from tkinter import ttk


SONA = "DA_Sona19"
BANDS = ("Heartsteel", "Ionic Spark", "K/DA", "Pentakill", "True Damage")


BONUS_SLOT = "bonus"
PROFILES = tuple(low + (3,) + high for low in ((1, 1, 2), (1, 2, 2))
                 for high in ((4,), (5,), (4, 5), (4, BONUS_SLOT), (5, BONUS_SLOT)))


def pool_slot(unit):
    if len(set(unit["traits"])) != 2:
        return None
    if unit["unlock"]:
        if unit["cost"] == 3 and unit["id"] in ("DA_Evelynn19", "DA_Tibbers19"):
            return BONUS_SLOT
    elif 1 <= unit["cost"] <= 5:
        return unit["cost"]
    return None


def draw_collab(units, rng=None):
    rng = rng or random
    by_cost = defaultdict(list)
    for unit in units:
        traits = frozenset(unit["traits"])
        slot = pool_slot(unit)
        if slot is not None:
            by_cost[slot].append((unit, traits))
    for candidates in by_cost.values():
        rng.shuffle(candidates)

    def search(costs, used):
        if not costs:
            return []
        for unit, traits in by_cost[costs[0]]:
            if traits.isdisjoint(used):
                rest = search(costs[1:], used | traits)
                if rest is not None:
                    return [unit, *rest]
        return None

    profiles = list(PROFILES)
    rng.shuffle(profiles)
    for profile in profiles:
        team = search(profile[::-1], frozenset())
        if team is not None:
            return sorted(team, key=lambda unit: unit["cost"])
    raise ValueError("추정 추첨 조건을 만족하는 조합이 없어.")


def count_traits(board, drawn, equipment, band):
    counts = Counter()
    for unit in board:
        uid = unit["id"]
        traits = set(unit["traits"]) | equipment.get(uid, set())
        if uid in drawn:
            traits.add("Collab")
        if uid == SONA and band:
            traits.add(band)
        counts.update(traits)
        if "K/DA" in traits:
            counts["K/DA"] += 1
    return counts


class ManualBuilder(tk.Toplevel):
    def __init__(self, parent, units, catalog, emblems):
        super().__init__(parent)
        self.title("랜덤 콜라보 · 수동 덱빌더")
        self.units = {u["id"]: u for u in units}
        self.catalog = catalog
        self.labels = {t["name"]: t["nameKo"] for t in catalog["traits"]}
        self.emblems = sorted(emblems, key=emblems.get)
        self.board = {}
        self.drawn = set()
        self.equipment = {}
        self.band = None
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)
        header = ttk.Frame(self, padding=(8, 6))
        header.grid(sticky="ew")
        ttk.Button(header, text="콜라보 다시 추첨", command=self.reroll).pack(side="left")
        self.pool_text = ttk.Label(header)
        self.pool_text.pack(side="left", padx=8)
        rules = "추정 규칙 · 1코와 2코는 한쪽에서 2명, 다른 쪽에서 1명. 3코는 1명. 4코, 5코 중 한 명 또는 각각 한 명.\n기본 5명에 이블린 또는 티버를 추가해 6명이 될 수 있어. 다른 해금 기물 제외 · 고유 포함 기본 특성 2개 · 추첨 기물끼리 기본 특성 중복 없음."
        ttk.Label(self, text=rules, justify="left").grid(row=1, sticky="w", padx=8)
        ttk.Separator(self).grid(row=2, sticky="ew", pady=5)
        columns = ttk.Frame(self, padding=(8, 0))
        columns.grid(row=3, sticky="nsew")
        columns.columnconfigure((0, 1, 2), weight=1)
        columns.rowconfigure(1, weight=1)

        def panel(column, heading, width):
            title = ttk.Label(columns, text=heading)
            title.grid(row=0, column=column, sticky="w")
            pane = ttk.Frame(columns)
            pane.grid(row=1, column=column, sticky="nsew", padx=(0, 5))
            tree = ttk.Treeview(pane, show="tree", selectmode="browse", height=12)
            tree.column("#0", width=width, minwidth=90)
            scroll = ttk.Scrollbar(pane, command=tree.yview)
            tree.configure(yscrollcommand=scroll.set)
            scroll.pack(side="right", fill="y")
            tree.pack(fill="both", expand=True)
            return tree, title

        self.roster, _ = panel(0, "기물 목록", 255)
        self.field, self.field_title = panel(1, "배치", 220)
        self.synergies, self.synergy_title = panel(2, "특성", 185)
        self.only_drawn = tk.BooleanVar(self)
        ttk.Checkbutton(columns, text="추첨 기물만 보기", variable=self.only_drawn,
                        command=self.refresh_roster).grid(row=2, column=0, sticky="w")
        ttk.Button(columns, text="선택 기물 배치", command=self.add_unit).grid(row=3, column=0)
        ttk.Button(columns, text="선택 기물 빼기", command=self.remove_unit).grid(row=3, column=1)
        self.roster.bind("<Double-1>", lambda event: self.add_unit())
        self.field.bind("<Double-1>", lambda event: self.remove_unit())
        ttk.Label(columns, text="K/DA는 2성 기준").grid(row=2, column=2, sticky="w")

        tools = ttk.Frame(self, padding=(8, 8))
        tools.grid(row=4, sticky="w")
        ttk.Label(tools, text="선택 기물 상징").pack(side="left")
        self.emblem_picker = ttk.Combobox(tools, state="readonly", width=18,
                                          values=[emblems[t] for t in self.emblems])
        self.emblem_picker.pack(side="left", padx=4)
        if self.emblems:
            self.emblem_picker.current(0)
        ttk.Button(tools, text="장착", command=lambda: self.equip(True)).pack(side="left")
        ttk.Button(tools, text="해제", command=lambda: self.equip(False)).pack(side="left")
        ttk.Label(tools, text="소나 밴드").pack(side="left", padx=(14, 4))
        self.band_picker = ttk.Combobox(tools, state="disabled", width=14,
                                        values=["미선택", *(self.labels[t] for t in BANDS)])
        self.band_picker.current(0)
        self.band_picker.pack(side="left")
        self.band_picker.bind("<<ComboboxSelected>>", self.change_band)
        self.status = ttk.Label(self, padding=(8, 3))
        self.status.grid(row=5, sticky="w")
        self.reroll()

    def reroll(self):
        try:
            pool = draw_collab(self.units.values())
        except ValueError as exc:
            self.status.configure(text=str(exc))
            return
        self.drawn = {u["id"] for u in pool}
        self.pool_text.configure(text=" · ".join(f'{u["nameKo"]}({u["cost"]}코)' for u in pool))
        self.refresh_roster()
        self.refresh_board()
        self.status.configure(text="추첨 완료. 현재 배치와 상징은 유지돼.")

    def refresh_roster(self):
        self.roster.delete(*self.roster.get_children())
        for uid, unit in self.units.items():
            if self.only_drawn.get() and uid not in self.drawn:
                continue
            tag = " ★" if uid in self.drawn else ""
            text = f'{unit["cost"]}코 {unit["nameKo"]}{tag} · {", ".join(unit["traitsKo"])}'
            self.roster.insert("", "end", iid=uid, text=text)

    def add_unit(self):
        selected = self.roster.selection()
        if not selected:
            return
        uid = selected[0]
        if uid in self.board:
            self.status.configure(text="이미 배치한 기물이야.")
            return
        if "Akali" in uid and any("Akali" in other for other in self.board):
            self.status.configure(text="아칼리는 한 형태만 배치할 수 있어.")
            return
        self.board[uid] = self.units[uid]
        self.equipment[uid] = set()
        self.refresh_board(uid)
        self.status.configure(text=f'{self.units[uid]["nameKo"]} 배치 완료.')

    def remove_unit(self):
        selected = self.field.selection()
        if selected:
            uid = selected[0]
            del self.board[uid], self.equipment[uid]
            if uid == SONA:
                self.band = None
                self.band_picker.current(0)
            self.refresh_board()
            self.status.configure(text=f'{self.units[uid]["nameKo"]} 배치 해제.')

    def change_band(self, event):
        index = self.band_picker.current()
        band = BANDS[index - 1] if index > 0 else None
        if band in self.equipment.get(SONA, set()):
            self.band_picker.current(BANDS.index(self.band) + 1 if self.band else 0)
            self.status.configure(text="소나에게서 같은 특성의 상징을 먼저 해제해 줘.")
            return
        self.band = band
        self.refresh_board(SONA)
        self.status.configure(text="소나의 밴드 선택을 반영했어.")

    def equip(self, add):
        selected = self.field.selection()
        index = self.emblem_picker.current()
        if not selected or index < 0:
            self.status.configure(text="배치 목록에서 상징을 변경할 기물을 선택해 줘.")
            return
        uid, trait = selected[0], self.emblems[index]
        equipped = self.equipment[uid]
        if add:
            if trait in self.board[uid]["traits"] or (uid == SONA and trait == self.band) or trait in equipped:
                self.status.configure(text="이미 보유한 특성이야.")
                return
            if len(equipped) == 3:
                self.status.configure(text="기물당 상징은 최대 3개야.")
                return
            equipped.add(trait)
        else:
            if trait not in equipped:
                self.status.configure(text="이 기물이 장착한 상징을 선택해 줘.")
                return
            equipped.remove(trait)
        self.refresh_board(uid)
        self.status.configure(text="상징 변경을 반영했어.")

    def refresh_board(self, select=None):
        selection = self.field.selection()
        self.field.delete(*self.field.get_children())
        for uid, unit in self.board.items():
            text = unit["nameKo"]
            if uid in self.drawn or "Collab" in unit["traits"]:
                text += " ★콜라보"
            if uid == SONA and self.band:
                text += " · " + self.labels[self.band]
            if self.equipment[uid]:
                text += " · 상징 " + ", ".join(sorted(self.labels[t] for t in self.equipment[uid]))
            self.field.insert("", "end", iid=uid, text=text)
        selected = select or next(iter(selection), None)
        if selected in self.board:
            self.field.selection_set(selected)
            self.field.see(selected)
        self.field_title.configure(text=f"배치 {len(self.board)}명")
        self.band_picker.configure(state="readonly" if SONA in self.board else "disabled")
        counts = count_traits(self.board.values(), self.drawn, self.equipment, self.band)
        rows = []
        nonunique = 0
        for trait in self.catalog["traits"]:
            name = trait["name"]
            if counts[name]:
                tiers = self.catalog["breakpoints"][name]
                active = max((n for n in tiers if n <= counts[name]), default=0)
                if active and trait["type"] != "unique":
                    nonunique += 1
                marker = f"활성 {active}" if active else f"미활성 · {tiers[0]} 필요"
                rows.append((not active, self.labels[name], f'{self.labels[name]} {counts[name]} · {marker}'))
        self.synergy_title.configure(text=f"고유 제외 활성 특성 {nonunique}개")
        self.synergies.delete(*self.synergies.get_children())
        for _, _, text in sorted(rows):
            self.synergies.insert("", "end", text=text)
