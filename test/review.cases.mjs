// Regressions from the 2026-10-11 review: fence matching, YAML column-0 lists, the
// today match, multi-card moves with a member already in place, the blank line above
// an added card, a list item's continuation paragraph, fenced tasks in the due badge,
// and a calendar series whose rule can't be expanded.
import {
  parseSections, stepFence, taskLineIndexes, dueTaskSummary, isTodayTitle, parseYamlProperties, setYamlProperty,
  movableBlocks, moveSectionsInFile, insertSection, insertSections, insertionLine, titleSortKey, parseCards, feedEventsByDays,
  openTaskCount, toggleTaskLine, NoteHistory, setNoteRecorder, writeSection,
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

// ---- the review's recommendations, implemented 2026-10-11

t("placement: logical order follows the date a title names, not its spelling", () => {
  // The test stub's moment reads only ISO dates, so the key is spelled out here; in
  // the app titleSortKey reads the note's heading format.
  const iso = { "Sep 29, 2026": "2026-09-29", "Sep 30, 2026": "2026-09-30", "Oct 1, 2026": "2026-10-01", "Oct 2, 2026": "2026-10-02" };
  const key = (t) => iso[t] ?? t;
  assert.equal(titleSortKey("YYYY-MM-DD, dddd")("2026-10-02, Friday"), "2026-10-02");
  assert.equal(titleSortKey("YYYY-MM-DD, dddd")("Inbox"), "Inbox");
  const lines = ["## Sep 30, 2026", "a", "", "## Oct 1, 2026", "b", ""];
  assert.equal(insertionLine(lines, 2, "Oct 2, 2026", "logical"), 3, "by text, Oct 2 lands before Oct 1");
  assert.equal(insertionLine(lines, 2, "Oct 2, 2026", "logical", key), 5, "by date it goes last");
  assert.equal(insertionLine(lines, 2, "Sep 29, 2026", "logical", key), 0);
  // Newest-first notes are detected by date too.
  const desc = ["## Oct 1, 2026", "b", "", "## Sep 30, 2026", "a", ""];
  assert.equal(insertionLine(desc, 2, "Oct 2, 2026", "logical", key), 0);
});

ta("feed inserts: many cards in one parse land where one-at-a-time inserts put them, in order, once", async () => {
  const make = () => ({ text: "### 2026-10-02, Friday\nb\n\n### 2026-10-05, Monday\ne\n" });
  const app = (state) => ({ vault: { process: async (_f, fn) => { state.text = fn(state.text); return state.text; } } });
  const items = [
    { headingRaw: "### 2026-10-04, Sunday", bodyLines: ["d"] },
    { headingRaw: "### 2026-10-01, Thursday", bodyLines: ["a"] },
    { headingRaw: "### 2026-10-03, Saturday", bodyLines: ["c"] },
    { headingRaw: "### 2026-10-05, Monday", bodyLines: ["dup"] },
    { headingRaw: "### 2026-10-06, Tuesday", bodyLines: ["f"] },
    { headingRaw: "### 2026-10-06, Tuesday", bodyLines: ["twice"] },
  ];
  const batched = make();
  assert.equal(await insertSections(app(batched), { path: "f.md" }, items, "logical"), 4);
  const oneByOne = make();
  for (const it of items) await insertSection(app(oneByOne), { path: "g.md" }, it.headingRaw, "logical", it.bodyLines.join("\n"));
  // One-at-a-time would add the duplicate titles; drop those and compare the rest.
  assert.ok(!batched.text.includes("dup") && !batched.text.includes("twice"));
  assert.deepEqual(
    parseCards(batched.text.split("\n"), 3).map((s) => s.title.slice(0, 10)),
    ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"],
  );
  assert.equal(parseCards(batched.text.split("\n"), 3).find((s) => s.title.startsWith("2026-10-06")).body.trim(), "f");
  // Bottom placement keeps the given order.
  const bottom = make();
  await insertSections(app(bottom), { path: "h.md" }, items.slice(0, 3), "bottom");
  assert.ok(bottom.text.endsWith("### 2026-10-04, Sunday\nd\n\n### 2026-10-01, Thursday\na\n\n### 2026-10-03, Saturday\nc\n\n"), bottom.text);
});

t("tasks: custom states count as open tasks and check to [x]", () => {
  assert.equal(openTaskCount("- [/] half\n- [-] dropped\n- [x] done\n- [ ] todo"), 3);
  assert.deepEqual(taskLineIndexes(["- [/] half", "- [ ] todo", "- [x] done"]), [0, 1, 2]);
  assert.equal(toggleTaskLine("- [/] half", "2026-10-11", false), "- [x] half");
  assert.equal(toggleTaskLine("- [x] done ✅ 2026-10-10", "2026-10-11", true), "- [ ] done");
  assert.deepEqual(dueTaskSummary("- [>] 📅 2020-01-01 forwarded", "2026-10-11"), { overdue: 1, dueToday: 0 });
});

t("feed: a series that ended before the span is skipped, one spanning it still lands", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:old", "SUMMARY:Old daily", "DTSTART;VALUE=DATE:20200101", "DTEND;VALUE=DATE:20200102", "RRULE:FREQ=DAILY;UNTIL=20200201", "END:VEVENT",
    "BEGIN:VEVENT", "UID:live", "SUMMARY:Weekly", "DTSTART;VALUE=DATE:20261004", "DTEND;VALUE=DATE:20261005", "RRULE:FREQ=WEEKLY", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const days = feedEventsByDays(ics, ["2026-10-11", "2026-10-12"]);
  assert.deepEqual(days.get("2026-10-11").map((e) => e.title), ["Weekly"]);
  assert.deepEqual(days.get("2026-10-12"), []);
});

ta("history: edits to two cards with the same heading are two undo steps", async () => {
  const state = { text: "## Todo\na\n\n## Todo\nb\n" };
  const file = { path: "u.md" };
  const app = { vault: { process: async (_f, fn) => { state.text = fn(state.text); return state.text; } } };
  const history = new NoteHistory();
  const [first, second] = parseCards(state.text.split("\n"), 2);
  setNoteRecorder((f, before, after, label, key) => { if (f === file) history.record(f.path, before, after, label, key); });
  try {
    await writeSection(app, file, 2, first, "## Todo\na1");
    await writeSection(app, file, 2, second, "## Todo\nb1");
  } finally {
    setNoteRecorder(null);
  }
  assert.equal(history.undo("u.md", state.text).text, "## Todo\na1\n\n## Todo\nb\n", "the second edit alone comes off");
});
