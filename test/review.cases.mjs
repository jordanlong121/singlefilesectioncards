// Regressions from the 2026-10-11 review: fence matching, YAML column-0 lists, the
// today match, multi-card moves with a member already in place, the blank line above
// an added card, a list item's continuation paragraph, fenced tasks in the due badge,
// and a calendar series whose rule can't be expanded.
import {
  parseSections, stepFence, taskLineIndexes, dueTaskSummary, isTodayTitle, parseYamlProperties, setYamlProperty,
  movableBlocks, moveSectionsInFile, insertSection, parseCards, feedEventsByDays,
} from "./.tmp/main.js";
import { t, ta } from "./harness.mjs";
import assert from "assert";

t("fences: a ``` fence closes only on ``` of at least its length, never on ~~~ or an inline ```x``` line", () => {
  const lines = ["## A", "````", "- [ ] in", "```", "- [ ] still in", "````", "- [ ] out", "## B", "```echo```", "text", "## C", "c"];
  assert.deepEqual(parseSections(lines, 2).map((s) => s.title), ["A", "B", "C"]);
  assert.deepEqual(taskLineIndexes(lines), [6]);
  assert.equal(stepFence("```", "~~~").open, "~~~", "a tilde fence stays open past a backtick line");
  assert.equal(stepFence("```echo```", null).open, null, "inline triple-backtick code opens nothing");
  assert.equal(stepFence("~~~", "~~~").open, null);
});

t("tasks: the due badge skips fenced code like the reveal does", () => {
  const body = "```\n- [ ] 📅 2020-01-01 fenced\n```\n- [ ] 📅 2027-01-01 later";
  assert.deepEqual(dueTaskSummary(body, "2026-10-11"), { overdue: 0, dueToday: 0 });
  assert.deepEqual(dueTaskSummary("- [ ] 📅 2020-01-01 late\n- [ ] 📅 2026-10-11 now", "2026-10-11"), { overdue: 1, dueToday: 1 });
});

t("dates: today's formatted date matches a whole word, not the tail of another day", () => {
  assert.equal(isTodayTitle("16 August 2026", "2026-08-06", "6 August 2026"), false);
  assert.equal(isTodayTitle("26 August 2026", "2026-08-06", "6 August 2026"), false);
  assert.equal(isTodayTitle("6 August 2026", "2026-08-06", "6 August 2026"), true);
  assert.equal(isTodayTitle("Thu, 6 August 2026 – planning", "2026-08-06", "6 August 2026"), true);
  assert.equal(isTodayTitle("October 10", "2026-10-01", "October 1"), false);
  assert.equal(isTodayTitle("October 1", "2026-10-01", "October 1"), true);
  assert.equal(isTodayTitle("2026-08-06, Thursday", "2026-08-06", "2026-08-06, Thursday"), true);
});

t("properties: a block list at the key's own column is read, and edited in place", () => {
  const yaml = "title: T\ntags:\n- a\n- b\nnext: 1";
  const tags = parseYamlProperties(yaml).find((p) => p.key === "tags");
  assert.deepEqual(tags.items, ["a", "b"]);
  assert.equal(tags.shape, "block");
  assert.equal(setYamlProperty(yaml, "tags", "p, q"), "title: T\ntags:\n- p\n- q\nnext: 1");
  // Indented lists keep their indent.
  assert.equal(setYamlProperty("tags:\n  - a\n", "tags", "z"), "tags:\n  - z\n");
});

t("blocks: a list item's continuation paragraph (blank line, then indented text) belongs to the item", () => {
  const body = ["- item", "", "    continuation", "", "- other", "", "plain", "  not a continuation of plain"];
  const blocks = movableBlocks(body);
  assert.deepEqual(blocks.map((b) => [b.kind, b.start, b.end]), [["item", 0, 3], ["item", 4, 5], ["paragraph", 6, 8]]);
  // Indented short of the content column, it's the next item of the list, not a continuation.
  assert.deepEqual(movableBlocks(["- a", "", " - b"]).map((b) => [b.start, b.end]), [[0, 1], [2, 3]]);
});

ta("writes: a multi-card move with one member already in place still moves the others", async () => {
  const state = { text: "## A\na\n\n## C\nc\n\n## B\nb\n" };
  const file = { path: "m.md" };
  const app = { vault: { process: async (_f, fn) => { state.text = fn(state.text); return state.text; } } };
  const cards = parseCards(state.text.split("\n"), 2);
  const [a, c, b] = ["A", "C", "B"].map((t) => cards.find((s) => s.title === t));
  assert.equal(await moveSectionsInFile(app, file, 2, [a, b], c, true), true);
  assert.equal(state.text, "## A\na\n\n## B\nb\n\n## C\nc\n");
});

ta("writes: a card added at the bottom gets a blank line above it", async () => {
  const state = { text: "## A\nfoo\n" };
  const file = { path: "b.md" };
  const app = { vault: { process: async (_f, fn) => { state.text = fn(state.text); return state.text; } } };
  await insertSection(app, file, "## Z", "bottom");
  assert.equal(state.text, "## A\nfoo\n\n## Z\n\n");
  await insertSection(app, file, "## Top", "top", "body");
  assert.ok(state.text.startsWith("## Top\nbody\n\n## A"), state.text);
});

t("feed: a series whose rule can't be expanded is skipped, and the other events still land", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:bad", "SUMMARY:Broken", "DTSTART;VALUE=DATE:20260101", "DTEND;VALUE=DATE:20260102", "RRULE:FREQ=DAILY;BYMONTH=13", "END:VEVENT",
    "BEGIN:VEVENT", "UID:good", "SUMMARY:Fine", "DTSTART;VALUE=DATE:20261011", "DTEND;VALUE=DATE:20261012", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const days = feedEventsByDays(ics, ["2026-10-11"]);
  assert.deepEqual(days.get("2026-10-11").map((e) => e.title), ["Fine"]);
});
