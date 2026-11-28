import json
import unittest
from collections import Counter
from pathlib import Path


def read_catalog_file(stem):
    return json.loads(Path(__file__).with_name(stem + ".json").read_text(encoding="utf-8-sig"))


class LadderTest(unittest.TestCase):
    def test_every_emblem_reaches_thirteen(self):
        plans = read_catalog_file("ladder-plans")
        units = {u["id"]: u for u in read_catalog_file("units")}
        traits = read_catalog_file("traits")
        thresholds = {t["name"]: traits["breakpoints"][t["name"]][0]
                      for t in traits["traits"] if t["type"] != "unique"}
        self.assertEqual(set(plans), {e["trait"] for e in read_catalog_file("emblems")["items"]})
        for emblem, team in plans.items():
            with self.subTest(emblem=emblem):
                self.assertEqual(len(team), 10)
                self.assertEqual(len(set(team)), 10)
                self.assertNotIn(emblem, units[team[0]]["traits"])
                self.assertLessEqual(sum("Akali" in uid for uid in team), 1)
                counts = Counter({emblem: 1})
                for level, uid in enumerate(team, 1):
                    unit = units[uid]
                    self.assertGreaterEqual(level, {1: 1, 2: 3, 3: 5, 4: 7, 5: 9}[unit["cost"]])
                    if unit["unlock"] and "레벨 이상" in unit["unlock"]:
                        minimum = int(unit["unlock"].split("레벨 이상")[0])
                        self.assertGreaterEqual(level, minimum)
                    counts.update(unit["traits"])
                counts["K/DA"] *= 2
                active = {t for t in counts if thresholds.get(t, 0) > 0 and counts[t] >= thresholds[t]}
                self.assertEqual(len(active), 13)
                self.assertIn(emblem, active)
                self.assertLess(counts[emblem] - (2 if emblem == "K/DA" else 1), thresholds[emblem])

    def test_every_unit_has_five_sorted_recommended_items(self):
        import web_planner
        root = Path(__file__).resolve().parent
        units = read_catalog_file("units")
        self.assertGreater(len(units), 0)
        for unit in units:
            with self.subTest(unit=unit["id"]):
                items = unit.get("recommendedItems", [])
                self.assertEqual(len(items), 5)
                deltas = [item["placeChange"] for item in items]
                self.assertEqual(deltas, sorted(deltas))
                for item in items:
                    self.assertTrue(item["nameKo"])
                    rel = f"assets/{item['id']}.png"
                    self.assertTrue((root / rel).is_file(), rel)
                    self.assertEqual(web_planner.FILES.get("/" + rel), rel)

    def test_python_planner_matches_new_scoring_and_lucky_rules(self):
        from importlib.machinery import SourceFileLoader
        from importlib.util import module_from_spec, spec_from_loader

        root = Path(__file__).resolve().parent
        loader = SourceFileLoader("planner_pyw", str(root / "planner.pyw"))
        spec = spec_from_loader(loader.name, loader)
        planner_mod = module_from_spec(spec)
        loader.exec_module(planner_mod)

        units = read_catalog_file("units")
        selected = {"DA_Sett19", "DA_Taric19", "DA_Karthus19", "DA_Malzahar19", "DA_Yuumi19"}
        decks = planner_mod.ranked_decks(
            units, selected, 9, set(), {}, collab=3, jazz=2,
            gu_feng=False, priority="value", smeech=False, lucky=["DA_Jinx19"],
        )
        self.assertEqual(len(decks), 3)
        for team, band in decks:
            ids = [u["id"] for u in team]
            self.assertIn("DA_Jinx19", ids)
            score, active, _, meta = planner_mod.evaluate(
                team, selected, {}, band, lucky=["DA_Jinx19"], priority="value"
            )
            self.assertGreaterEqual(meta["activeCount"], 9)
            self.assertFalse(meta["invalidCarry"])
            self.assertGreater(score, 0)


if __name__ == "__main__":
    unittest.main()
