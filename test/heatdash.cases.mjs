// The Heatmap's spans, metrics, and tags, and the Dashboard's note summary.
import {
  parseCards, heatmapDays, heatValue, heatLevel, heatmapTags, heatRangeSpan, shiftHeatAnchor, heatRangeLabel,
  bodyTextStats, summarizeNote, taskText,
} from "./.tmp/main.js";
import { t } from "./harness.mjs";
import assert from "assert";

t("bodyTextStats: words skip markers and fences; tags need a non-digit and a boundary", () => {
  const { words, tags } = bodyTextStats([
    "- [ ] call #Work about #2026 and a#b",
    "```",
    "#fenced words here",
    "```",
    "(#work) #home/garden",
  ]);
  assert.equal(words, 8, "call #Work about #2026 and a#b (#work) #home/garden");
  assert.deepEqual(tags, { work: 2, "home/garden": 1 });
});

t("heatmapDays pools words, tags, and text of same-day sections", () => {
  const lines = ["### 2026-08-05", "one two #a", "### 2026-08-05", "- [x] three #a #b"];
  const day = heatmapDays(parseCards(lines, 3, null), "YYYY-MM-DD").get("2026-08-05");
  assert.equal(day.words, 6);
  assert.deepEqual(day.tags, { a: 2, b: 1 });
  assert.equal(day.done, 1);
  assert.equal(day.title, "2026-08-05");
  assert.ok(day.body.includes("one two") && day.body.includes("three"));
});

t("heatValue and heatLevel follow the metric; a card counting nothing is level 1", () => {
  const day = { done: 2, open: 3, words: 40, tags: { gym: 1 }, headingLine: 0, title: "", body: "" };
  assert.equal(heatValue(day, "done"), 2);
  assert.equal(heatValue(day, "tasks"), 5);
  assert.equal(heatValue(day, "words"), 40);
  assert.equal(heatValue(day, "tag", "Gym"), 1);
  assert.equal(heatValue(day, "tag", "run"), 0);
  assert.equal(heatLevel(undefined, 0, 10), 0);
  assert.equal(heatLevel(day, 0, 10), 1);
  assert.equal(heatLevel(day, 10, 10), 4);
  assert.equal(heatLevel(day, 1, 10), 2);
});

t("heatmapTags: most used first, ties A→Z", () => {
  const days = [{ tags: { b: 1, a: 1 } }, { tags: { c: 3 } }];
  assert.deepEqual(heatmapTags(days), ["c", "a", "b"]);
});

t("heatRangeSpan: year, quarter, month, and all", () => {
  assert.deepEqual(heatRangeSpan("year", "2026-08-15", "2025-01-01", "2026-12-01"), { start: "2026-01-01", end: "2026-12-31" });
  assert.deepEqual(heatRangeSpan("quarter", "2026-08-15", "", ""), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(heatRangeSpan("quarter", "2026-12-31", "", ""), { start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(heatRangeSpan("month", "2028-02-10", "", ""), { start: "2028-02-01", end: "2028-02-29" });
  assert.deepEqual(heatRangeSpan("all", "2026-08-15", "2025-03-04", "2026-11-12"), { start: "2025-03-04", end: "2026-11-12" });
});

t("shiftHeatAnchor steps whole periods from the 1st, across year ends", () => {
  assert.equal(shiftHeatAnchor("2026-01-31", "month", 1), "2026-02-01");
  assert.equal(shiftHeatAnchor("2026-01-15", "month", -1), "2025-12-01");
  assert.equal(shiftHeatAnchor("2026-11-02", "quarter", 1), "2027-02-01");
  assert.equal(shiftHeatAnchor("2026-05-05", "year", -1), "2025-05-01");
  assert.equal(shiftHeatAnchor("2026-05-05", "all", 3), "2026-05-05");
  assert.equal(heatRangeLabel("quarter", "2026-08-01"), "Q3 2026");
  assert.equal(heatRangeLabel("year", "2026-08-01"), "2026");
});

t("taskText drops the checkbox and Tasks date fields", () => {
  assert.equal(taskText("- [ ] pay rent 📅 2026-11-01 #home"), "pay rent #home");
  assert.equal(taskText("  - [x] done thing ✅ 2026-10-02"), "done thing");
  assert.equal(taskText("- [ ] review [due:: 2026-11-20] now"), "review now");
});

t("summarizeNote: outline, tasks by due date, tags, links, rankings, dates", () => {
  const lines = [
    "---",
    "# not a heading in frontmatter",
    "---",
    "# 2026",
    "## 2026-11-10",
    "- [ ] late 📅 2026-11-01",
    "- [x] done",
    "see [[Other]] and [[Other#Part|alias]] and https://example.com",
    "## 2026-11-11",
    "- [ ] today 📅 2026-11-12 #work",
    "- [ ] soon 📅 2026-11-15",
    "- [ ] far 📅 2026-12-30",
    "![[pic.png]] #work #home",
    "```",
    "## fenced",
    "- [ ] fenced 📅 2020-01-01",
    "```",
    "## 2026-11-12",
  ];
  const sections = parseCards(lines, 2, null);
  const sum = summarizeNote(lines, sections, { todayIso: "2026-11-12", format: "YYYY-MM-DD", detect: "", dated: true, starEmoji: "⭐" });
  assert.deepEqual(sum.headings.slice(1, 3), [1, 3]);
  assert.equal(sum.sections, 3);
  assert.equal(sum.emptySections, 1);
  assert.equal(sum.open, 4);
  assert.equal(sum.done, 1);
  assert.deepEqual(sum.overdue.map((x) => [x.text, x.section, x.line]), [["late", "2026-11-10", 5]]);
  assert.deepEqual(sum.dueToday.map((x) => x.text), ["today #work"]);
  assert.deepEqual(sum.upcoming.map((x) => x.text), ["soon"]);
  assert.deepEqual(sum.tags, [["work", 2], ["home", 1]]);
  assert.equal(sum.wikilinks, 1);
  assert.equal(sum.links, 1);
  assert.equal(sum.images, 1);
  assert.equal(sum.busiest[0].title, "2026-11-11");
  assert.deepEqual(
    { first: sum.dates.first, last: sum.dates.last, count: sum.dates.count, current: sum.dates.current, todayLine: sum.dates.todayLine },
    { first: "2026-11-10", last: "2026-11-12", count: 3, current: 3, todayLine: 17 },
  );
  const undated = summarizeNote(lines, sections, { todayIso: "2026-11-12", format: "YYYY-MM-DD", detect: "", dated: false, starEmoji: "⭐" });
  assert.equal(undated.dates, null);
});
