// The layout and functionality plan (see PLAN.md): every layout's pure pipeline and
// every file write, run over the fixture notes in test/fixtures.
import {
  parseCards, parseSections, sortSections, applyPinned, parseAncestorHeadings, groupByAncestor,
  hierarchyColumnItems, openTaskCount, dueTaskSummary, firstDueTaskIndex, sortTasksLayout,
  titleToIso, heatmapDays, heatmapStreaks, dateHeadingLevel, retitledDateTitle, pickHeadingLevel,
  snapRect, findFreeSpot, rectsCollide, plannerCards, plannerColumnSplit, plannerCardWeight,
  plannerBlockKey, wholeNoteSection, splitCardFaces, parsePeriod, shiftPeriod, formatPeriod,
  detectLevelSetup, movableBlocks, deckExcerpt, LAYOUT_OPTIONS, locateCard,
  insertSection, deleteSection, retitleSectionInFile, quickAddToSection, pasteAtSectionEnd,
  toggleTaskInFile, moveBlockInFile, deleteBlockInFile, replaceBlockInFile, insertAfterBlockInFile,
  moveRangeInFile, replaceRangeInFile, moveSectionInFile, mergeSectionsInFile,
} from "./.tmp/main.js";
import { t, ta } from "./harness.mjs";
import assert from "assert";
import fs from "fs";
import { fileURLToPath } from "url";

const FMT = "YYYY-MM-DD, dddd";
const fixture = (name) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const lines = (text) => text.split(/\r?\n/);
const cards = (text, level, unfiled = null, props = null) => parseCards(lines(text), level, unfiled, props);
const byTitle = (secs, prefix) => {
  const hit = secs.find((s) => s.title.startsWith(prefix));
  assert.ok(hit, `no section titled ${prefix}`);
  return hit;
};
/** A vault of one note: process() rewrites the text like Obsidian's vault.process. */
const fakeApp = (text) => {
  const state = { text };
  return { app: { vault: { process: async (_file, fn) => { state.text = fn(state.text); } } }, file: {}, get text() { return state.text; } };
};

const personal = fixture("personal.md");
const senstar = fixture("senstar.md");
const plain = fixture("plain.md");
const noHeadings = fixture("no-headings.md");
const deep = fixture("deep.md");
const crlf = fixture("crlf.md");
const weeks = fixture("weeks.md");

// ---------- Parsing ----------
t("personal: months, weeks (one duplicated), days; the fenced # line is never a heading", () => {
  assert.deepEqual(cards(personal, 1).map((s) => s.title), ["October 2026", "September 2026", "August"]);
  const weeksL2 = cards(personal, 2);
  assert.equal(weeksL2.length, 3);
  assert.equal(weeksL2.filter((s) => s.headingRaw === "## Week 40 (Sep 28–Oct 4)").length, 2, "the straddling week appears under both months");
  assert.equal(cards(personal, 3).length, 6);
  for (const level of [1, 2, 3]) assert.ok(cards(personal, level).every((s) => s.title !== "not a heading"));
});

t("senstar: properties card first, no unfiled card, months and days", () => {
  const secs = cards(senstar, 3, "_Unfiled_", "Properties");
  assert.ok(secs[0].properties && secs[0].body.includes("Status: Active"));
  assert.equal(secs.filter((s) => s.unfiled && !s.properties).length, 0, "only blank lines precede the first heading");
  assert.equal(secs.filter((s) => !s.unfiled).length, 4);
  assert.deepEqual(cards(senstar, 2).map((s) => s.title), ["September 2026", "August 2026"]);
});

t("plain: duplicate titles stay separate cards; blocks split as rendered", () => {
  const secs = cards(plain, 2);
  assert.equal(secs.length, 3);
  assert.equal(secs.filter((s) => s.title === "Ideas").length, 2);
  assert.equal(movableBlocks(secs[0].body.split("\n")).length, 3, "prose paragraph + two list items");
});

t("no headings: only the unfiled card, and only when asked for", () => {
  assert.equal(cards(noHeadings, 3).length, 0);
  const secs = cards(noHeadings, 3, "_Unfiled_");
  assert.equal(secs.length, 1);
  assert.ok(secs[0].unfiled && secs[0].body.includes("a task"));
});

t("deep: only H4/H5 — the level fallback picks the populated level", () => {
  assert.equal(cards(deep, 4).length, 2);
  assert.equal(cards(deep, 5).length, 1);
  assert.equal(cards(deep, 3).length, 0);
  assert.equal(pickHeadingLevel(lines(deep), 3), 4);
});

t("crlf: cards parse cleanly with no stray carriage returns", () => {
  const secs = cards(crlf, 3);
  assert.equal(secs.length, 2);
  assert.ok(secs.every((s) => !s.body.includes("\r") && !s.title.includes("\r")));
});

// ---------- Sorting / pins ----------
t("sorting keeps the set of cards in every order; pins lead", () => {
  const secs = cards(personal, 3);
  const titles = secs.map((s) => s.title).sort();
  for (const order of ["asc", "desc", "doc", "count-asc", "count-desc"]) {
    const sorted = sortSections(secs, order);
    assert.deepEqual(sorted.map((s) => s.title).sort(), titles, order);
  }
  const asc = sortSections(secs, "asc").map((s) => s.title);
  assert.deepEqual(asc, titles);
  assert.deepEqual(sortSections(secs, "desc").map((s) => s.title), titles.slice().reverse());
  const pinned = applyPinned(secs, ["### 2026-09-13, Sunday"]);
  assert.equal(pinned[0].title, "2026-09-13, Sunday");
  assert.equal(pinned.length, secs.length);
});

// ---------- Dividers / Hierarchy ----------
t("dividers: groups follow the nearest ancestor heading by line, duplicates apart", () => {
  const secs = cards(personal, 3);
  const groups = groupByAncestor(secs, parseAncestorHeadings(lines(personal), 3));
  assert.deepEqual(groups.map((g) => [g.title, g.sections.length]), [
    ["Week 40 (Sep 28–Oct 4)", 1],
    ["Week 40 (Sep 28–Oct 4)", 2],
    ["Week 38 (Sep 14–20)", 2],
    ["August", 1],
  ]);
});

t("hierarchy: the top column lists the H1s", () => {
  const headings = parseAncestorHeadings(lines(personal), 3);
  const cardLines = cards(personal, 3).map((s) => s.headingLine);
  const items = hierarchyColumnItems(headings, 1, 0, lines(personal).length, cardLines);
  assert.deepEqual(items.map((i) => i.label), ["October 2026", "September 2026", "August"]);
});

// ---------- Tasks layout ----------
t("tasks: open counts, due summaries, and the first overdue task (📅 and [due::])", () => {
  const day = byTitle(cards(personal, 3), "2026-09-14");
  assert.equal(openTaskCount(day.body), 3);
  assert.deepEqual(dueTaskSummary(day.body, "2026-09-14"), { overdue: 1, dueToday: 1 });
  assert.equal(firstDueTaskIndex(day.body, "2026-09-14"), 3, "the nested 'shoes' task is the 4th checkbox");
  const sen = byTitle(cards(senstar, 3), "2026-09-14");
  assert.deepEqual(dueTaskSummary(sen.body, "2026-09-14"), { overdue: 1, dueToday: 1 });
  assert.equal(firstDueTaskIndex(sen.body, "2026-09-14"), 1);
  const secs = cards(personal, 3);
  assert.equal(sortTasksLayout(secs, FMT, "", "asc").length, secs.length);
});

// ---------- Calendar / Heatmap ----------
t("calendar: every day title resolves to its ISO date; heatmap tallies and streaks", () => {
  const secs = cards(personal, 3);
  for (const s of secs) assert.ok(titleToIso(s.title, FMT, ""), s.title);
  const days = heatmapDays(secs, FMT, "");
  assert.equal(days.size, 6);
  assert.deepEqual([days.get("2026-09-14").done, days.get("2026-09-14").open], [1, 3]);
  assert.deepEqual(heatmapStreaks(["2026-09-13", "2026-09-14"], "2026-09-14"), { current: 2, longest: 2 });
  assert.equal(dateHeadingLevel(lines(personal), FMT, ""), 3);
  assert.equal(retitledDateTitle("2026-09-14, Monday", FMT, "2026-09-15", ""), "2026-09-15, Tuesday");
});

// ---------- Custom Grid ----------
t("custom grid: snapping and free-spot search", () => {
  const snapped = snapRect({ x: 10, y: 30, w: 100, h: 50 }, 24, 192, 120);
  assert.ok([snapped.x, snapped.y, snapped.w, snapped.h].every((v) => v % 24 === 0));
  assert.ok(snapped.w >= 192 && snapped.h >= 120);
  const obstacles = [{ x: 0, y: 0, w: 192, h: 120 }];
  const spot = findFreeSpot({ x: 0, y: 0, w: 192, h: 120 }, obstacles, 0, 24);
  assert.ok(!obstacles.some((o) => rectsCollide(spot, o, 0)));
});

// ---------- Day Planner ----------
const contiguous = (cs, end) => {
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i].start, cs[i - 1].end, "ranges abut");
  if (cs.length) assert.equal(cs[cs.length - 1].end, end, "last range runs to the end");
};

t("planner: a month card shows each week as a subcard, its days (and their H4s) inside", () => {
  const sept = byTitle(cards(personal, 1), "September 2026");
  const body = sept.body.split("\n");
  const cs = plannerCards(body);
  assert.deepEqual(cs.map((c) => [c.kind, c.title]), [["sub", "Week 40 (Sep 28–Oct 4)"], ["sub", "Week 38 (Sep 14–20)"]]);
  const week38 = body.slice(cs[1].start, cs[1].end).join("\n");
  assert.ok(week38.includes("### 2026-09-14, Monday") && week38.includes("#### Notes") && week38.includes("### 2026-09-13, Sunday"));
  contiguous(cs, body.length);
});

t("planner: a day with an H4 gives line cards above it plus the subcard; the flip marker is content", () => {
  const day = byTitle(cards(personal, 3), "2026-09-14");
  const cs = plannerCards(day.body.split("\n"));
  // Three line cards (the nested task rides with its parent), then the subcard to the end.
  assert.deepEqual(cs.map((c) => [c.kind, c.title ?? null, c.start, c.end]), [
    ["line", null, 0, 1], ["line", null, 1, 2], ["line", null, 2, 4], ["sub", "Notes", 5, 10],
  ]);
});

t("planner: a day with no sub-headings is line cards; fenced text is not a card", () => {
  const day = byTitle(cards(personal, 3), "2026-09-13");
  assert.deepEqual(plannerCards(day.body.split("\n")).map((c) => c.kind), ["line"]);
});

t("planner: without subcards only the front face shows; with them the whole body does", () => {
  const day = byTitle(cards(senstar, 3), "2026-09-09");
  assert.equal(plannerCards(day.body.split("\n")).length, 2, "the whole body has two task lines");
  assert.equal(plannerCards(splitCardFaces(day.body, "%% flip %%").front.split("\n")).length, 1, "the front has one");
});

t("planner: column balancing covers every card with 0/1 and honours placed cards", () => {
  const sept = byTitle(cards(personal, 1), "September 2026");
  const body = sept.body.split("\n");
  const cs = plannerCards(body);
  const cols = plannerColumnSplit(cs.map((c) => ({ weight: plannerCardWeight(body, c) })));
  assert.equal(cols.length, cs.length);
  assert.ok(cols.every((c) => c === 0 || c === 1));
  assert.ok(cols.includes(0) && cols.includes(1), "both columns get cards");
  const pinned = plannerColumnSplit(cs.map((c, i) => ({ col: i === 0 ? 1 : undefined, weight: plannerCardWeight(body, c) })));
  assert.equal(pinned[0], 1);
});

t("planner: a line's slot key survives ticking it off", () => {
  assert.equal(plannerBlockKey("- [ ] pack snacks 📅 2026-09-14"), plannerBlockKey("- [x] pack snacks 📅 2026-09-14 ✅ 2026-09-14"));
});

t("planner: no cards at a level — the whole note below its properties, every section a card", () => {
  assert.equal(cards(senstar, 1).length, 0);
  const whole = wholeNoteSection(lines(senstar));
  assert.equal(lines(senstar)[whole.startLine], "## September 2026");
  const cs = plannerCards(whole.body.split("\n"));
  assert.equal(cs.filter((c) => c.kind === "sub").length, 2, "2 months — the days and their H4s nest inside");
  assert.ok(cs.every((c) => c.kind === "sub"), "no lines above the first month");
  assert.ok(locateCard(lines(senstar), 2, whole).whole, "the whole-note card re-locates by position");
});

t("planner: month stepping finds the neighbouring month card by its title", () => {
  const key = parsePeriod("September 2026", "month", "MMMM YYYY");
  const prev = formatPeriod(shiftPeriod(key, "month", -1), "month", "MMMM YYYY");
  assert.equal(prev, "August 2026");
  assert.ok(cards(senstar, 2).some((s) => s.title === prev));
});

t("planner: level setup detection per fixture", () => {
  const p = detectLevelSetup(lines(personal), FMT, "", true);
  assert.deepEqual([p["1"].role, p["2"].role, p["3"].role, p["4"].role], ["month", "text", "day", "text"]);
  const s = detectLevelSetup(lines(senstar), FMT, "", true);
  assert.deepEqual([s["1"].role, s["2"].role, s["3"].role], ["none", "month", "day"]);
  const w = detectLevelSetup(lines(weeks), FMT, "", true);
  assert.deepEqual(w["2"], { role: "week", format: "[Week] W, YYYY" });
  assert.equal(w["3"].role, "day");
  assert.equal(detectLevelSetup(lines(plain), FMT, "", true)["2"].role, "text");
});

// ---------- Rolodex / Deck / options ----------
t("rolodex: duplicate headings are distinct cards the strip can list", () => {
  const secs = cards(personal, 2);
  const dup = secs.filter((s) => s.headingRaw === "## Week 40 (Sep 28–Oct 4)");
  assert.equal(dup.length, 2);
  assert.notEqual(dup[0].headingLine, dup[1].headingLine);
});

t("deck: the excerpt skips frontmatter", () => {
  const excerpt = deckExcerpt(senstar);
  assert.ok(!excerpt.includes("Status: Active"));
  assert.ok(excerpt.includes("September 2026") || excerpt.includes("2026-09-15"));
});

t("every layout has a label and a hint; the planner is among them", () => {
  assert.ok(LAYOUT_OPTIONS.every(([value, label, hint]) => value && label && hint));
  assert.ok(LAYOUT_OPTIONS.some(([value]) => value === "planner"));
});

// ---------- Writes ----------
ta("write: insert a section at top, bottom, and logical placement; duplicates flagged", async () => {
  const v = fakeApp(personal);
  const top = await insertSection(v.app, v.file, "### 2026-09-30, Wednesday", "top");
  assert.deepEqual(top, { level: 3, duplicate: false });
  assert.equal(cards(v.text, 3)[0].title, "2026-09-30, Wednesday");
  await insertSection(v.app, v.file, "### 2026-07-01, Wednesday", "bottom");
  const secs = cards(v.text, 3);
  assert.equal(secs[secs.length - 1].title, "2026-07-01, Wednesday");
  await insertSection(v.app, v.file, "### 2026-09-20, Sunday", "logical", "- [ ] body line");
  assert.ok(byTitle(cards(v.text, 3), "2026-09-20").body.includes("body line"));
  const again = await insertSection(v.app, v.file, "### 2026-09-13, Sunday", "top");
  assert.equal(again.duplicate, true);
});

ta("write: delete a section removes exactly it", async () => {
  const v = fakeApp(personal);
  const target = byTitle(cards(v.text, 3), "2026-09-13");
  assert.equal(await deleteSection(v.app, v.file, 3, target), true);
  const after = cards(v.text, 3);
  assert.equal(after.length, 5);
  assert.ok(!v.text.includes("cut grass"));
  assert.ok(v.text.includes("pack for GCXPO") && v.text.includes("get started"));
});

ta("write: rename a card rewrites only the heading line", async () => {
  const v = fakeApp(personal);
  const target = byTitle(cards(v.text, 3), "2026-09-28");
  assert.equal(await retitleSectionInFile(v.app, v.file, 3, target, "### 2026-09-27, Sunday"), true);
  const renamed = byTitle(cards(v.text, 3), "2026-09-27");
  assert.equal(renamed.body, target.body);
  assert.ok(!v.text.includes("2026-09-28, Monday"));
});

ta("write: quick add at bottom and top; bottom stays above a flip marker", async () => {
  const v = fakeApp(personal);
  let day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.equal(await quickAddToSection(v.app, v.file, 3, day, "- [ ] new task", "bottom", "%% flip %%"), true);
  day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.ok(day.body.trimEnd().endsWith("- [ ] new task"));
  assert.equal(await quickAddToSection(v.app, v.file, 3, day, "- [ ] first", "top", "%% flip %%"), true);
  day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.ok(day.body.startsWith("- [ ] first"));
  let flipped = byTitle(cards(v.text, 3), "2026-09-14");
  assert.equal(await quickAddToSection(v.app, v.file, 3, flipped, "- [ ] on the front", "bottom", "%% flip %%"), true);
  flipped = byTitle(cards(v.text, 3), "2026-09-14");
  const body = flipped.body.split("\n");
  assert.ok(body.indexOf("- [ ] on the front") < body.findIndex((l) => l.trim() === "%% flip %%"));
});

ta("write: paste at a section's end lands before the next heading", async () => {
  const v = fakeApp(personal);
  const day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.equal(await pasteAtSectionEnd(v.app, v.file, 3, day, "pasted paragraph"), true);
  const after = byTitle(cards(v.text, 3), "2026-09-28");
  assert.ok(after.body.trimEnd().endsWith("pasted paragraph"));
  assert.equal(cards(v.text, 3).length, 6);
});

ta("write: toggle the nth task (nested ones count) and stamp the done date", async () => {
  const v = fakeApp(personal);
  let day = byTitle(cards(v.text, 3), "2026-09-14");
  assert.equal(await toggleTaskInFile(v.app, v.file, 3, day, 3, "2026-09-14", true), true);
  day = byTitle(cards(v.text, 3), "2026-09-14");
  const shoes = day.body.split("\n").find((l) => l.includes("shoes"));
  assert.ok(/^\t- \[x\] shoes/.test(shoes) && shoes.includes("✅ 2026-09-14"), shoes);
  assert.equal(await toggleTaskInFile(v.app, v.file, 3, day, 1, "2026-09-14", true), false, "unticking the done task");
  day = byTitle(cards(v.text, 3), "2026-09-14");
  assert.ok(day.body.split("\n").some((l) => /^- \[ \] pickup twins/.test(l)));
});

ta("write: move, delete, replace, and insert-after blocks", async () => {
  const v = fakeApp(personal);
  let from = byTitle(cards(v.text, 3), "2026-09-14");
  const to = byTitle(cards(v.text, 3), "2026-09-13");
  const dance = "- [ ] dance #home\n\t- [ ] shoes 📅 2026-09-10";
  assert.equal(await moveBlockInFile(v.app, v.file, 3, from, 2, dance, to, null), true);
  assert.ok(!byTitle(cards(v.text, 3), "2026-09-14").body.includes("dance"));
  assert.ok(byTitle(cards(v.text, 3), "2026-09-13").body.includes("shoes 📅 2026-09-10"), "the nested line travels with its parent");
  let day = byTitle(cards(v.text, 3), "2026-09-13");
  assert.equal(await deleteBlockInFile(v.app, v.file, 3, day, 0, "- [ ] cut grass, clean backyard"), true);
  assert.ok(!v.text.includes("cut grass"));
  day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.equal(await replaceBlockInFile(v.app, v.file, 3, day, 0, "- [ ] pack for GCXPO", "- [ ] pack for the show"), true);
  day = byTitle(cards(v.text, 3), "2026-09-28");
  assert.equal(await insertAfterBlockInFile(v.app, v.file, 3, day, 0, "- [ ] pack for the show", "- [ ] second"), true);
  assert.deepEqual(byTitle(cards(v.text, 3), "2026-09-28").body.split("\n").slice(0, 2), ["- [ ] pack for the show", "- [ ] second"]);
  assert.equal(await replaceBlockInFile(v.app, v.file, 3, day, 0, "stale text", "x"), false, "a changed block is refused");
});

ta("write: planner ranges — reorder subcards within a card, a no-op drop, a move across cards", async () => {
  const v = fakeApp(personal);
  let sept = byTitle(cards(v.text, 1), "September 2026");
  let body = sept.body.split("\n");
  let cs = plannerCards(body);
  const week38 = cs.find((c) => c.title.startsWith("Week 38"));
  const week40 = cs.find((c) => c.title.startsWith("Week 40"));
  const text = body.slice(week38.start, week38.end).join("\n");
  assert.equal(await moveRangeInFile(v.app, v.file, 1, sept, week38.start, week38.end, text, sept, week40.start), true);
  const order = cards(v.text, 2).map((s) => s.title);
  assert.deepEqual(order, ["Week 40 (Sep 28–Oct 4)", "Week 38 (Sep 14–20)", "Week 40 (Sep 28–Oct 4)"]);
  assert.equal(cards(v.text, 3).length, 6, "every day survived the move");
  // Dropping a range back inside itself changes nothing.
  sept = byTitle(cards(v.text, 1), "September 2026");
  body = sept.body.split("\n");
  cs = plannerCards(body);
  const w38 = cs.find((c) => c.title.startsWith("Week 38"));
  const before = v.text;
  assert.equal(await moveRangeInFile(v.app, v.file, 1, sept, w38.start, w38.end, body.slice(w38.start, w38.end).join("\n"), sept, w38.start + 1), true);
  assert.equal(v.text, before);
  // A day moves from August into September's end.
  const aug = byTitle(cards(v.text, 1), "August");
  const augBody = aug.body.split("\n");
  const day = plannerCards(augBody)[0];
  sept = byTitle(cards(v.text, 1), "September 2026");
  assert.equal(await moveRangeInFile(v.app, v.file, 1, aug, day.start, day.end, augBody.slice(day.start, day.end).join("\n"), sept, sept.endLine - sept.startLine - 1), true);
  assert.ok(!byTitle(cards(v.text, 1), "August").body.includes("###"));
  assert.ok(byTitle(cards(v.text, 1), "September 2026").body.includes("### 2026-08-31, Monday"));
});

ta("write: replace a subcard's text; a stale range is refused", async () => {
  const v = fakeApp(personal);
  const day = byTitle(cards(v.text, 3), "2026-09-14");
  const body = day.body.split("\n");
  const notes = plannerCards(body).find((c) => c.title === "Notes");
  let end = notes.end;
  while (end > notes.start + 1 && body[end - 1].trim() === "") end--;
  const text = body.slice(notes.start, end).join("\n");
  assert.equal(await replaceRangeInFile(v.app, v.file, 3, day, notes.start, end, text, "#### Notes\nWent fine."), true);
  assert.ok(v.text.includes("Went fine.") && !v.text.includes("Ran long"));
  assert.equal(await replaceRangeInFile(v.app, v.file, 3, day, notes.start, end, text, "x"), false);
});

ta("write: move a section before another; merge one into another", async () => {
  const v = fakeApp(personal);
  const moved = byTitle(cards(v.text, 3), "2026-09-13");
  const target = byTitle(cards(v.text, 3), "2026-09-29");
  assert.equal(await moveSectionInFile(v.app, v.file, 3, moved, target, true), true);
  const titles = cards(v.text, 3).map((s) => s.title);
  assert.ok(titles.indexOf("2026-09-13, Sunday") < titles.indexOf("2026-09-29, Tuesday"));
  const from = byTitle(cards(v.text, 3), "2026-09-28");
  const into = byTitle(cards(v.text, 3), "2026-09-29");
  assert.equal(await mergeSectionsInFile(v.app, v.file, 3, from, into), true);
  const after = cards(v.text, 3);
  assert.ok(!after.some((s) => s.title.startsWith("2026-09-28")));
  assert.ok(byTitle(after, "2026-09-29").body.includes("pack for GCXPO"));
});

ta("write: CRLF notes keep their line endings through a write", async () => {
  const v = fakeApp(crlf);
  const day = byTitle(cards(v.text, 3), "2026-09-14");
  assert.equal(await quickAddToSection(v.app, v.file, 3, day, "- [ ] c", "bottom", ""), true);
  assert.ok(v.text.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(v.text), "no bare LF crept in");
  assert.ok(byTitle(cards(v.text, 3), "2026-09-14").body.includes("- [ ] c"));
});
