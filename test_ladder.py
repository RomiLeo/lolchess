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


if __name__ == "__main__":
    unittest.main()
