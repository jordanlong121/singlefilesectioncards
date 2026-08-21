import { parseSections, sortSections, applyPinned, insertIntoSection, insertionLine, detectDirection, normalizeHeading, isTodayTitle, titleHasDate, applyTemplatePlaceholders, toggleTaskLine, taskLineIndexes, resolveViewSettings, wheelDeltaToPixels, canScrollVertically, splitLinktext, pickHeadingLevel, planCardReuse, trimTrailingBlankLines, sectionDeleteRange, computeTabEdit, moveSection, EditorHistory, sectionBlocks, movableBlocks, moveBlock, moveBlockBetween, rectsCollide, findFreeSpot, snapRect, sectionFromEdited, unfiledSection, parseCards, UNFILED_KEY, removeBlock, bodyForRender, hexToTriplet, normalizePalette, PALETTE_PRESETS, contrastForeground, parseAncestorHeadings, hierarchyColumnItems, HIER_GAP_KEY, openTaskCount, headingLevelsIn, groupByAncestor } from "./.tmp/main.js";
import fs from "fs";
import { fileURLToPath } from "url";

// The repo's sample vault stands in for a real single-file daily-notes vault.
const SAMPLE_NOTE = fileURLToPath(new URL("../sample-vault/Daily Notes 2026.md", import.meta.url));
import assert from "assert";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("ok   " + name); }
  catch (e) { fail++; console.log("FAIL " + name + "\n     " + e.message); } };

const L = (s) => s.split("\n");

t("splits H3 sections and keeps nested content", () => {
  const secs = parseSections(L(`## Month
### 2026-08-06
- [ ] a
	- [ ] nested
#### sub
text
### 2026-08-05
- [ ] b`), 3);
  assert.equal(secs.length, 2);
  assert.equal(secs[0].title, "2026-08-06");
  assert.ok(secs[0].body.includes("#### sub"), "nested H4 stays inside the card");
  assert.equal(secs[1].body, "- [ ] b");
});

t("a higher-rank heading closes the section", () => {
  const secs = parseSections(L(`### one
body1
## New Month
### two
body2`), 3);
  assert.equal(secs[0].body, "body1");
  assert.equal(secs[0].endLine, 2);
});

t("ignores headings inside code fences", () => {
  const secs = parseSections(L(`### real
\`\`\`md
### fake
\`\`\`
tail`), 3);
  assert.equal(secs.length, 1);
  assert.ok(secs[0].body.includes("### fake"));
});

t("skips frontmatter", () => {
  const secs = parseSections(L(`---
title: x
### notaheading
---
### real`), 3);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].title, "real");
});

t("raw round-trips exactly with the source lines", () => {
  const lines = L(`### h\na\nb\n\n### i\nc`);
  const secs = parseSections(lines, 3);
  for (const s of secs)
    assert.equal(s.raw, lines.slice(s.startLine, s.endLine).join("\n"));
});

t("alphanumeric sort is natural (2 before 10) both directions", () => {
  const mk = (t) => ({ title: t });
  const asc = sortSections(["Item 10", "Item 2", "item 1"].map(mk), "asc").map((s) => s.title);
  assert.deepEqual(asc, ["item 1", "Item 2", "Item 10"]);
  const desc = sortSections(["Item 10", "Item 2", "item 1"].map(mk), "desc").map((s) => s.title);
  assert.deepEqual(desc, ["Item 10", "Item 2", "item 1"]);
  const doc = sortSections(["b", "a"].map(mk), "doc").map((s) => s.title);
  assert.deepEqual(doc, ["b", "a"]);
});

t("sample vault: parses every H3 date section and sorts them chronologically", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const lines = data.split(/\r?\n/);
  const secs = parseSections(lines, 3);
  assert.ok(secs.length >= 15, "expected the sample days, got " + secs.length);

  // Ascending sort must be monotonic, and must not add/drop/alter any section.
  const asc = sortSections(secs, "asc");
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  for (let i = 1; i < asc.length; i++)
    assert.ok(cmp.compare(asc[i - 1].title, asc[i].title) <= 0,
      "out of order: " + asc[i - 1].title + " then " + asc[i].title);
  assert.equal(asc.length, secs.length);
  assert.deepEqual([...asc].map(s => s.raw).sort(), [...secs].map(s => s.raw).sort());
  assert.deepEqual(sortSections(secs, "desc").map(s => s.title), [...asc].reverse().map(s => s.title));

  // Every section's raw text is exactly its own slice of the file.
  for (const s of secs) assert.equal(s.raw, lines.slice(s.startLine, s.endLine).join("\n"));
  assert.ok(parseSections(lines, 2).length >= 1, "H2 month grouping also parses");
});

t("simulated edit replaces only the target section", () => {
  const lines = L(`### a\n1\n### b\n2\n### c\n3`);
  const secs = parseSections(lines, 3);
  const target = secs[1];
  const out = lines.slice();
  out.splice(target.startLine, target.endLine - target.startLine, ...L("### b renamed\n22\n33"));
  assert.equal(out.join("\n"), "### a\n1\n### b renamed\n22\n33\n### c\n3");
});


// ---------- Create New Card: placement ----------

t("detects a descending (newest-first) file", () => {
  assert.equal(detectDirection(["2026-08-06", "2026-08-05", "2026-07-31"]), "desc");
  assert.equal(detectDirection(["2026-01-01", "2026-02-01", "2026-03-01"]), "asc");
});

t("normalizeHeading keeps typed #'s, otherwise applies the view level", () => {
  assert.equal(normalizeHeading("## Sprint 4", 3), "## Sprint 4");
  assert.equal(normalizeHeading("Sprint 4", 3), "### Sprint 4");
  assert.equal(normalizeHeading("  #### Deep  ", 3), "#### Deep");
  assert.equal(normalizeHeading("###", 2), "## ");
});

t("placement: top inserts before the first section, after frontmatter", () => {
  const lines = L(`---\nkey: v\n---\n## Month\n### 2026-08-06\na\n### 2026-08-05\nb`);
  assert.equal(insertionLine(lines, 3, "2026-08-07", "top"), 4);
  const noSections = L(`---\nkey: v\n---\nprose`);
  assert.equal(insertionLine(noSections, 3, "x", "top"), 3);
});

t("placement: bottom inserts after the last section's content", () => {
  const lines = L(`### a\n1\n### b\n2`);
  assert.equal(insertionLine(lines, 3, "c", "bottom"), 4);
});

t("placement: logical follows a descending file (new newest date goes to top)", () => {
  const lines = L(`### 2026-08-06\na\n### 2026-08-05\nb\n### 2026-07-31\nc`);
  assert.equal(insertionLine(lines, 3, "2026-08-07", "logical"), 0);  // before 08-06
  assert.equal(insertionLine(lines, 3, "2026-08-01", "logical"), 4);  // between 08-05 and 07-31
  assert.equal(insertionLine(lines, 3, "2026-01-01", "logical"), 6);  // oldest -> end
});

t("placement: logical follows an ascending file", () => {
  const lines = L(`### 2026-01-01\na\n### 2026-02-01\nb`);
  assert.equal(insertionLine(lines, 3, "2026-01-15", "logical"), 2);
  assert.equal(insertionLine(lines, 3, "2026-03-01", "logical"), 4);
  assert.equal(insertionLine(lines, 3, "2025-12-01", "logical"), 0);
});

t("sample vault: a newer date lands logically at the top of the newest-first file", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const lines = data.split(/\r?\n/);
  const secs = parseSections(lines, 3);
  assert.equal(detectDirection(secs.map((s) => s.title)), "desc");

  // A date newer than anything in the file, so the expectation can't drift as the note grows.
  const title = "2099-12-31, Friday";
  assert.ok(!secs.some((s) => s.title === title), "fixture date must not already exist");

  const at = insertionLine(lines, 3, title, "logical");
  assert.equal(at, secs[0].startLine, "should go directly above the current newest section");

  const after = lines.slice();
  after.splice(at, 0, "### " + title, "");
  const reparsed = parseSections(after, 3);
  assert.equal(reparsed.length, secs.length + 1);
  assert.equal(reparsed[0].title, title);
  assert.equal(reparsed[0].body, "");
  assert.equal(reparsed[1].raw, secs[0].raw, "the previously-first section is unchanged");
  assert.equal(reparsed[reparsed.length - 1].raw, secs[secs.length - 1].raw, "last section unchanged");

  // A mid-range date lands between the right neighbours.
  const mid = insertionLine(lines, 3, "2026-07-25", "logical");
  const midAfter = lines.slice();
  midAfter.splice(mid, 0, "### 2026-07-25", "");
  const midParsed = parseSections(midAfter, 3);
  const i = midParsed.findIndex((s) => s.title === "2026-07-25");
  assert.ok(i > 0, "not first");
  assert.ok(midParsed[i - 1].title > "2026-07-25", "previous is newer: " + midParsed[i - 1].title);
  assert.ok(midParsed[i + 1].title < "2026-07-25", "next is older: " + midParsed[i + 1].title);
});

t("bottom/top on the real note keep every existing section intact", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const lines = data.split(/\r?\n/);
  const before = parseSections(lines, 3);
  for (const placement of ["top", "bottom"]) {
    const at = insertionLine(lines, 3, "### zzz test", placement);
    const out = lines.slice();
    out.splice(at, 0, "### zzz test", "");
    const after = parseSections(out, 3);
    assert.equal(after.length, before.length + 1, placement + ": one new section");
    const kept = after.filter((s) => s.title !== "zzz test").map((s) => s.raw);
    assert.deepEqual(kept, before.map((s) => s.raw), placement + ": existing sections byte-identical");
  }
});

// ---------- today highlighting ----------

t("isTodayTitle matches an ISO date inside a heading", () => {
  assert.ok(isTodayTitle("2026-08-06, Thursday", "2026-08-06", "2026-08-06, Thursday"));
  assert.ok(isTodayTitle("2026-08-06", "2026-08-06", "2026-08-06, Thursday"));
  assert.ok(!isTodayTitle("2026-08-05, Wednesday", "2026-08-06", "2026-08-06, Thursday"));
});

t("isTodayTitle matches the configured non-ISO format", () => {
  assert.ok(isTodayTitle("Thursday, August 6", "2026-08-06", "Thursday, August 6"));
  assert.ok(isTodayTitle("Thursday, August 6 — travel", "2026-08-06", "Thursday, August 6"));
  assert.ok(!isTodayTitle("Wednesday, August 5", "2026-08-06", "Thursday, August 6"));
});

t("isTodayTitle ignores a too-short format so text headings never all match", () => {
  assert.ok(!isTodayTitle("Ideas", "2026-08-06", "6"));
  assert.ok(!isTodayTitle("Backlog", "2026-08-06", ""));
});

t("sample vault: exactly one card is today (2026-08-06)", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const secs = parseSections(data.split(/\r?\n/), 3);
  const hits = secs.filter((s) => isTodayTitle(s.title, "2026-08-06", "2026-08-06, Thursday"));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, "2026-08-06, Thursday");
  // A day with no section yields no highlight rather than a wrong one.
  assert.equal(secs.filter((s) => isTodayTitle(s.title, "2026-08-07", "2026-08-07, Friday")).length, 0);
});

// ---------- clickable task checkboxes ----------

t("toggleTaskLine checks a task and appends the done date", () => {
  assert.equal(toggleTaskLine("- [ ] water the plants", "2026-08-06", true),
               "- [x] water the plants ✅ 2026-08-06");
  assert.equal(toggleTaskLine("- [ ] water the plants", "2026-08-06", false),
               "- [x] water the plants");
});

t("toggleTaskLine unchecks and strips the done date", () => {
  assert.equal(toggleTaskLine("- [x] file the expense report ✅ 2026-07-30", "2026-08-06", true),
               "- [ ] file the expense report");
  assert.equal(toggleTaskLine("- [X] upper case mark ✅ 2026-07-30", "2026-08-06", true),
               "- [ ] upper case mark");
});

t("toggleTaskLine preserves indentation, bullet style and inline metadata", () => {
  assert.equal(toggleTaskLine("\t- [ ] nested subtask", "2026-08-06", false), "\t- [x] nested subtask");
  assert.equal(toggleTaskLine("    * [ ] deep task", "2026-08-06", false), "    * [x] deep task");
  assert.equal(toggleTaskLine("1. [ ] numbered", "2026-08-06", false), "1. [x] numbered");
  assert.equal(toggleTaskLine("- [ ] tidy the shared drive #admin ", "2026-08-06", true),
               "- [x] tidy the shared drive #admin ✅ 2026-08-06");
  assert.equal(toggleTaskLine("- [ ] task [[Project Notes]] #writing", "2026-08-06", true),
               "- [x] task [[Project Notes]] #writing ✅ 2026-08-06");
});

t("toggleTaskLine round-trips: check then uncheck restores the original", () => {
  for (const line of ["- [ ] plain", "\t- [ ] nested #tag ", "- [ ] with [[link]]"]) {
    const checked = toggleTaskLine(line, "2026-08-06", true);
    assert.ok(/\[x\]/.test(checked));
    assert.equal(toggleTaskLine(checked, "2026-08-06", true), line.replace("[ ]", "[ ]").trimEnd());
  }
});

t("toggleTaskLine never rewrites a non-task line", () => {
  for (const line of ["plain text", "- bullet", "### 2026-08-06", "- [ incomplete", "  - [] no space"])
    assert.equal(toggleTaskLine(line, "2026-08-06", true), line);
});

t("taskLineIndexes counts rendered checkboxes only, skipping code fences", () => {
  const body = L(`- [ ] a\n\t- [x] nested\nprose\n\`\`\`md\n- [ ] not rendered\n\`\`\`\n- [ ] b`);
  assert.deepEqual(taskLineIndexes(body), [0, 1, 6]);
});

t("sample vault: checkbox N maps to task line N for every card", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const lines = data.split(/\r?\n/);
  const secs = parseSections(lines, 3);
  let totalTasks = 0;
  for (const s of secs) {
    const body = lines.slice(s.startLine + 1, s.endLine);
    const idx = taskLineIndexes(body);
    totalTasks += idx.length;
    // Every mapped line must really be a task, and in ascending order.
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i-1], "ascending");
    for (const i of idx) assert.ok(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(body[i]), "is a task: " + body[i]);
  }
  assert.ok(totalTasks > 40, "found " + totalTasks + " tasks");

  // Toggling the 1st task of the newest section changes exactly one line in the file.
  const s0 = secs[0];
  const body = lines.slice(s0.startLine + 1, s0.endLine);
  const at = s0.startLine + 1 + taskLineIndexes(body)[0];
  const out = lines.slice();
  out[at] = toggleTaskLine(lines[at], "2026-08-06", true);
  assert.notEqual(out[at], lines[at]);
  assert.equal(out.filter((l, i) => l !== lines[i]).length, 1, "exactly one line changed");
  assert.equal(parseSections(out, 3).length, secs.length, "section count unchanged");
  assert.ok(out[at].includes("✅ 2026-08-06"));
});

// ---------- per-note view memory ----------

const DEFAULTS = { layout: "grid", headingLevel: 3, sortOrder: "asc" };

t("a note with no saved view falls back to the defaults (grid)", () => {
  assert.deepEqual(resolveViewSettings(undefined, {}, DEFAULTS), { ...DEFAULTS, hierarchy: false });
});

t("a note's saved view wins over restored tab state and defaults", () => {
  const saved = { layout: "vertical", headingLevel: 2, sortOrder: "desc", hierarchy: true };
  const state = { layout: "tight", headingLevel: 4, sortOrder: "asc", hierarchy: false };
  assert.deepEqual(resolveViewSettings(saved, state, DEFAULTS), saved);
});

t("restored tab state is used when the note has no saved view", () => {
  const state = { layout: "aligned", headingLevel: 2, sortOrder: "desc", hierarchy: true };
  assert.deepEqual(resolveViewSettings(undefined, state, DEFAULTS), state);
});

t("partial saved views fall through field by field", () => {
  assert.deepEqual(
    resolveViewSettings({ layout: "horizontal" }, { sortOrder: "desc" }, DEFAULTS),
    { layout: "horizontal", headingLevel: 3, sortOrder: "desc", hierarchy: false },
  );
});

t("a stale 'hierarchy' layout becomes grid with the columns toggled on", () => {
  assert.deepEqual(
    resolveViewSettings({ layout: "hierarchy" }, {}, DEFAULTS),
    { layout: "grid", headingLevel: 3, sortOrder: "asc", hierarchy: true },
  );
});

// ---------- wheel panning ----------

t("wheelDeltaToPixels normalises deltaMode and picks the dominant axis", () => {
  assert.equal(wheelDeltaToPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800), 120);
  assert.equal(wheelDeltaToPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800), 48);   // lines
  assert.equal(wheelDeltaToPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 800), 800);  // pages
  assert.equal(wheelDeltaToPixels({ deltaX: -90, deltaY: 0, deltaMode: 0 }, 800), -90); // trackpad sideways
  assert.equal(wheelDeltaToPixels({ deltaX: 5, deltaY: -120, deltaMode: 0 }, 800), -120); // vertical dominates
  assert.equal(wheelDeltaToPixels({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 800), 0);
});

t("canScrollVertically implements scroll chaining at both ends", () => {
  const mid = { scrollTop: 50, scrollHeight: 400, clientHeight: 200 };
  assert.ok(canScrollVertically(mid, 120), "can scroll down from the middle");
  assert.ok(canScrollVertically(mid, -120), "can scroll up from the middle");

  const top = { scrollTop: 0, scrollHeight: 400, clientHeight: 200 };
  assert.ok(canScrollVertically(top, 120), "down from the top");
  assert.ok(!canScrollVertically(top, -120), "up from the top hands off to the row");

  const bottom = { scrollTop: 200, scrollHeight: 400, clientHeight: 200 };
  assert.ok(!canScrollVertically(bottom, 120), "down from the bottom hands off to the row");
  assert.ok(canScrollVertically(bottom, -120), "up from the bottom");

  const fits = { scrollTop: 0, scrollHeight: 200, clientHeight: 200 };
  assert.ok(!canScrollVertically(fits, 120), "a card that fits never takes the wheel");
  assert.ok(!canScrollVertically(mid, 0), "no delta, no claim");
});

// ---------- wikilinks in cards ----------

t("splitLinktext separates the note from its heading", () => {
  assert.deepEqual(splitLinktext("Project Notes"), ["Project Notes", ""]);
  assert.deepEqual(splitLinktext("Project Notes#Sed Posuere"), ["Project Notes", "Sed Posuere"]);
  assert.deepEqual(splitLinktext("folder/Note#Heading With Spaces"), ["folder/Note", "Heading With Spaces"]);
  assert.deepEqual(splitLinktext("#Local Heading"), ["", "Local Heading"]);   // same-note link
  assert.deepEqual(splitLinktext("  Padded  #  Heading  "), ["Padded", "Heading"]);
  assert.deepEqual(splitLinktext("Note#^blockid"), ["Note", "^blockid"]);     // block ref, no card match
});

t("sample vault: its wikilinks resolve to sibling notes", () => {
  const data = fs.readFileSync(SAMPLE_NOTE, "utf8");
  const links = [...data.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => splitLinktext(m[1])[0]);
  assert.ok(links.length >= 4, "sample daily notes should link to other notes");
  const dir = SAMPLE_NOTE.replace(/[^/]+$/, "");
  for (const name of new Set(links))
    assert.ok(fs.existsSync(dir + name + ".md"), "link target exists: " + name);
});

// ---------- choosing a heading level for a note with no saved view ----------

t("pickHeadingLevel keeps the preferred level when the note has it", () => {
  const lines = L(`# Top\n## Mid\n### Deep\n### Deep 2`);
  assert.equal(pickHeadingLevel(lines, 3), 3);
  assert.equal(pickHeadingLevel(lines, 2), 2);
  assert.equal(pickHeadingLevel(lines, 1), 1);
});

t("pickHeadingLevel falls back to the densest level when the preferred one is absent", () => {
  const lines = L(`# One\nbody\n# Two\nbody\n# Three\nbody`);
  assert.equal(pickHeadingLevel(lines, 3), 1, "no H3s, so use the H1s");
  const mixed = L(`# Top\n## A\n## B\n## C`);
  assert.equal(pickHeadingLevel(mixed, 4), 2, "H2 is densest");
});

t("pickHeadingLevel leaves the preference alone for a note with no headings at all", () => {
  assert.equal(pickHeadingLevel(L("just prose\nand more prose"), 3), 3);
});

t("sample vault: every note opens at a level that renders cards", () => {
  const dir = SAMPLE_NOTE.replace(/[^/]+$/, "");
  // With a global preference of H3: notes that have H3s keep it, notes that don't
  // fall back to their densest level. Either way nothing opens empty.
  const expected = {
    "Daily Notes 2026.md": 3,   // has H3 days
    "Meeting Minutes.md": 3,    // has H3 subsections under two meetings
    "Field Log.md": 3,          // has H3 visits
    "Handbook.md": 3,           // has H3 sections
    "Reading List.md": 3,       // has H3 notes
    "Project Notes.md": 1,      // H1/H2 only -> densest level, H1
  };
  for (const [name, level] of Object.entries(expected)) {
    const lines = fs.readFileSync(dir + name, "utf8").split(/\r?\n/);
    const chosen = pickHeadingLevel(lines, 3);
    assert.equal(chosen, level, name + " should open at H" + level + ", got H" + chosen);
    assert.ok(parseSections(lines, chosen).length > 0, name + " must render at least one card");
  }
});

// ---------- incremental re-render planning ----------

t("planCardReuse keeps unchanged cards and rebuilds only what changed", () => {
  assert.deepEqual(planCardReuse(["a", "b", "c"], ["a", "b", "c"]), [0, 1, 2]);   // no change
  assert.deepEqual(planCardReuse(["a", "b", "c"], ["a", "B", "c"]), [0, -1, 2]);  // one edit
  assert.deepEqual(planCardReuse(["a", "b", "c"], ["c", "a", "b"]), [2, 0, 1]);   // resort reuses all
  assert.deepEqual(planCardReuse(["a", "b"], ["x", "a", "b"]), [-1, 0, 1]);       // insertion
  assert.deepEqual(planCardReuse(["a", "b", "c"], ["a", "c"]), [0, 2]);           // deletion
  assert.deepEqual(planCardReuse(["d", "d"], ["d", "d", "d"]), [0, 1, -1]);       // duplicates FIFO
  assert.deepEqual(planCardReuse([], ["a"]), [-1]);                               // first render
});

t("sample vault: a one-section edit reuses every other card", () => {
  const lines = fs.readFileSync(SAMPLE_NOTE, "utf8").split(/\r?\n/);
  const before = parseSections(lines, 3);
  const after = lines.slice();
  after.splice(before[4].startLine + 1, 0, "- [ ] a brand new task");
  const next = parseSections(after, 3);
  const plan = planCardReuse(before.map((s) => s.raw), next.map((s) => s.raw));
  assert.equal(plan.filter((i) => i === -1).length, 1, "exactly one card rebuilds");
  assert.equal(plan.length, before.length);
});

t("parseSections stays exact on a large doc with a closer between every section", () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push("## month " + i, "### day " + i, "- [ ] item " + i, "");
  const secs = parseSections(lines, 3);
  assert.equal(secs.length, 1500);
  for (const s of secs) assert.equal(s.raw, lines.slice(s.startLine, s.endLine).join("\n"));
  assert.equal(secs[7].body, "- [ ] item 7");
});

// ---------- editor newline padding ----------

t("trimTrailingBlankLines strips the editor's padding and nothing else", () => {
  assert.equal(trimTrailingBlankLines("### h\n- [ ] a\n"), "### h\n- [ ] a");
  assert.equal(trimTrailingBlankLines("### h\n- [ ] a\n\n  \n"), "### h\n- [ ] a");
  assert.equal(trimTrailingBlankLines("### h\n\n- [ ] a"), "### h\n\n- [ ] a");  // interior blank kept
  assert.equal(trimTrailingBlankLines("### h"), "### h");
  assert.equal(trimTrailingBlankLines(""), "");
});

t("an untouched editor round-trips to no change", () => {
  const lines = fs.readFileSync(SAMPLE_NOTE, "utf8").split(/\r?\n/);
  for (const section of parseSections(lines, 3).slice(0, 5)) {
    const editorValue = section.raw + "\n";              // what startEditing shows
    assert.equal(trimTrailingBlankLines(editorValue), section.raw, "no-op edit saves nothing");
  }
});

// ---------- delete card ----------

t("sectionDeleteRange takes the section plus its trailing blank separators", () => {
  const lines = L(`### a\n1\n\n### b\n2\n\n\n### c\n3`);
  const secs = parseSections(lines, 3);
  assert.deepEqual(sectionDeleteRange(lines, secs[0]), [0, 3]);   // heading, body, one blank
  assert.deepEqual(sectionDeleteRange(lines, secs[1]), [3, 7]);   // heading, body, two blanks
  assert.deepEqual(sectionDeleteRange(lines, secs[2]), [7, 9]);   // last section, no trailing
});

t("deleting a middle section leaves the neighbours byte-identical, no doubled blanks", () => {
  const lines = L(`### a\n1\n\n### b\n2\n\n### c\n3`);
  const secs = parseSections(lines, 3);
  const [start, end] = sectionDeleteRange(lines, secs[1]);
  const out = lines.slice(); out.splice(start, end - start);
  assert.equal(out.join("\n"), "### a\n1\n\n### c\n3");
  const after = parseSections(out, 3);
  assert.equal(after.length, 2);
  assert.equal(after[0].raw, secs[0].raw);
  assert.equal(after[1].raw, secs[2].raw);
});

t("sample vault: deleting any one section keeps every other section intact", () => {
  const lines = fs.readFileSync(SAMPLE_NOTE, "utf8").split(/\r?\n/);
  const secs = parseSections(lines, 3);
  for (let i = 0; i < secs.length; i++) {
    const [start, end] = sectionDeleteRange(lines, secs[i]);
    const out = lines.slice(); out.splice(start, end - start);
    const after = parseSections(out, 3);
    assert.equal(after.length, secs.length - 1, "one fewer section when deleting #" + i);
    const kept = secs.filter((_, j) => j !== i).map((s) => s.raw);
    assert.deepEqual(after.map((s) => s.raw), kept, "others unchanged when deleting #" + i);
    // no run of 3+ blank lines introduced
    assert.ok(!/\n\s*\n\s*\n\s*\n/.test(out.join("\n")), "no blank pile-up when deleting #" + i);
  }
});

// ---------- Tab in the card editor ----------

const applyEdit = (text, e) => text.slice(0, e.start) + e.insert + text.slice(e.end);

t("Tab at a bare caret inserts a tab character", () => {
  const e = computeTabEdit("- [ ] task", 6, 6, false);
  assert.deepEqual(e, { start: 6, end: 6, insert: "\t", selStart: 7, selEnd: 7 });
  assert.equal(applyEdit("- [ ] task", e), "- [ ] \ttask");
});

t("Tab with a multi-line selection indents whole lines", () => {
  const text = "### h\n- [ ] a\n- [ ] b\n- [ ] c";
  const e = computeTabEdit(text, 8, 24, false);              // selection inside a..c
  assert.equal(applyEdit(text, e), "### h\n\t- [ ] a\n\t- [ ] b\n\t- [ ] c");
  assert.equal(e.selStart, 6, "whole region selected after");
});

t("a selection ending exactly at a line start leaves that line alone", () => {
  const text = "aa\nbb\ncc";
  const e = computeTabEdit(text, 0, 6, false);               // ends right after bb's newline
  assert.equal(applyEdit(text, e), "\taa\n\tbb\ncc");
});

t("Shift+Tab removes one tab or up to four leading spaces per line", () => {
  const text = "\t- [ ] a\n    - [ ] b\n- [ ] c";
  const e = computeTabEdit(text, 0, text.length, true);
  assert.equal(applyEdit(text, e), "- [ ] a\n- [ ] b\n- [ ] c");
});

t("Shift+Tab at a caret outdents its line and keeps the caret in place", () => {
  const text = "\t- [ ] nested";
  const e = computeTabEdit(text, 5, 5, true);
  assert.equal(applyEdit(text, e), "- [ ] nested");
  assert.equal(e.selStart, 4, "caret follows the text it sat in");
});

t("Shift+Tab on unindented text is a no-op, not a broken edit", () => {
  assert.equal(computeTabEdit("- [ ] plain", 3, 3, true), null);
});

t("indenting skips empty lines so blank separators stay blank", () => {
  const text = "aa\n\nbb";
  const e = computeTabEdit(text, 0, text.length, false);
  assert.equal(applyEdit(text, e), "\taa\n\n\tbb");
});

// ---------- drag to reorder ----------

const T3 = "### a\n1\n\n### b\n2\n\n### c\n3";

t("moveSection moves a section down, keeping every section's text exact", () => {
  const out = moveSection(L(T3), 3, 0, 2);              // a before c
  assert.equal(out.join("\n"), "### b\n2\n\n### a\n1\n\n### c\n3");
});

t("moveSection moves a section up", () => {
  const out = moveSection(L(T3), 3, 2, 0);              // c to the top
  assert.equal(out.join("\n"), "### c\n3\n\n### a\n1\n\n### b\n2");
});

t("moveSection to the end drops dangling separators; from the end gains one", () => {
  const toEnd = moveSection(L(T3), 3, 0, 3);            // a to the end
  assert.equal(toEnd.join("\n"), "### b\n2\n\n### c\n3\n\n### a\n1");
  const fromEnd = moveSection(L(T3), 3, 2, 1);          // c (no trailing blank) above b
  assert.equal(fromEnd.join("\n"), "### a\n1\n\n### c\n3\n\n### b\n2");
});

t("moveSection returns null for no-op or out-of-range moves", () => {
  assert.equal(moveSection(L(T3), 3, 1, 1), null);      // before itself
  assert.equal(moveSection(L(T3), 3, 1, 2), null);      // before its own successor
  assert.equal(moveSection(L(T3), 3, 5, 0), null);
  assert.equal(moveSection(L(T3), 3, 0, 9), null);
});

t("sample vault: every (from, to) move preserves all sections and hits the right slot", () => {
  const lines = fs.readFileSync(SAMPLE_NOTE, "utf8").split(/\r?\n/);
  const before = parseSections(lines, 3);
  const raws = before.map((s) => s.raw);
  let moves = 0;
  for (let from = 0; from < before.length; from++) {
    for (const to of [0, Math.floor(before.length / 2), before.length]) {
      const out = moveSection(lines, 3, from, to);
      if (out === null) continue;                       // no-op combinations
      const after = parseSections(out, 3);
      assert.equal(after.length, before.length, `count kept for ${from}->${to}`);
      // same sections, byte-identical, just reordered
      assert.deepEqual([...after.map((s) => s.raw)].sort(), [...raws].sort(), `content kept for ${from}->${to}`);
      // the moved section landed where asked (index shifts down when passing its old slot)
      const expectedIndex = to > from ? to - 1 : to;
      assert.equal(after[expectedIndex].raw, raws[from], `position for ${from}->${to}`);
      assert.ok(!/\n\s*\n\s*\n\s*\n/.test(out.join("\n")), `no blank pile-up for ${from}->${to}`);
      moves++;
    }
  }
  assert.ok(moves > 40, "exercised " + moves + " real moves");
});

// ---------- the card editor's owned undo history ----------

const snap = (value, sel = value.length) => ({ value, selStart: sel, selEnd: sel });

t("undo walks back through recorded states; redo walks forward", () => {
  const h = new EditorHistory(snap("a"));
  h.record(snap("ab"));
  h.record(snap("abc"));
  assert.equal(h.undo().value, "ab");
  assert.equal(h.undo().value, "a");
  assert.equal(h.undo(), null, "stops at the initial state");
  assert.equal(h.redo().value, "ab");
  assert.equal(h.redo().value, "abc");
  assert.equal(h.redo(), null, "stops at the newest state");
});

t("a new edit after undo discards the redo branch", () => {
  const h = new EditorHistory(snap("a"));
  h.record(snap("ab"));
  h.undo();
  h.record(snap("aX"));
  assert.equal(h.redo(), null);
  assert.equal(h.undo().value, "a");
});

t("same-text records only refresh the selection", () => {
  const h = new EditorHistory(snap("abc", 0));
  h.record({ value: "abc", selStart: 2, selEnd: 3 });   // caret moved, no text change
  assert.equal(h.undo(), null, "no extra state was pushed");
});

t("a Tab edit round-trips through undo", () => {
  const text = "### h\n- [ ] a";
  const h = new EditorHistory(snap(text));
  const e = computeTabEdit(text, 8, 8, false);
  const after = text.slice(0, e.start) + e.insert + text.slice(e.end);
  h.record({ value: after, selStart: e.selStart, selEnd: e.selEnd });
  assert.equal(h.undo().value, text, "undo restores the pre-indent text");
  assert.equal(h.redo().value, after);
});

t("history is capped, dropping the oldest states", () => {
  const h = new EditorHistory(snap("0"));
  for (let i = 1; i <= 250; i++) h.record(snap("v" + i));
  let steps = 0;
  while (h.undo()) steps++;
  assert.ok(steps <= 200, "walked back " + steps + " steps");
});

// ---------- body blocks (drag a paragraph/task between cards) ----------

t("sectionBlocks: items take their indented children; paragraphs group prose lines", () => {
  const body = L("- [ ] a\n\t- [ ] a child\n\tnote under a\n- [ ] b\n\nSome prose that\nwraps two lines.\n\n- [ ] c");
  const blocks = sectionBlocks(body);
  assert.deepEqual(blocks.map((b) => [b.kind, b.start, b.end]), [
    ["item", 0, 3],        // a + two children
    ["item", 3, 4],        // b
    ["paragraph", 5, 7],   // the prose
    ["item", 8, 9],        // c
  ]);
});

t("sectionBlocks: fences, headings, blockquotes, tables, html are 'other' (not draggable)", () => {
  const body = L("```js\n- [ ] not a task\n```\n#### sub\n> quoted\n> more\n| a | b |\n<div>x</div>\n- [ ] real");
  const kinds = sectionBlocks(body).map((b) => b.kind);
  assert.deepEqual(kinds, ["other", "other", "other", "other", "other", "item"]);
  assert.equal(movableBlocks(body).length, 1);
});

t("sectionBlocks: thematic breaks are 'other', including the spaced and list-lookalike forms", () => {
  const body = L("---\n\n* * *\n\n___\n\n- - -\n\n- [ ] real");
  const kinds = sectionBlocks(body).map((b) => b.kind);
  assert.deepEqual(kinds, ["other", "other", "other", "other", "item"]);
});

t("sectionBlocks: a setext underline turns the paragraph run into 'other' (it renders a heading)", () => {
  assert.deepEqual(sectionBlocks(L("Title text\n---\nafter")).map((b) => [b.kind, b.start, b.end]), [
    ["other", 0, 2],       // setext h2
    ["paragraph", 2, 3],
  ]);
  assert.deepEqual(sectionBlocks(L("Two lines\nof title\n===")).map((b) => b.kind), ["other"]);
  assert.deepEqual(sectionBlocks(L("Short\n-")).map((b) => b.kind), ["other"]); // single dash is setext too
});

t("sectionBlocks: a '***' rule directly under a paragraph stays a separate <hr> block", () => {
  const blocks = sectionBlocks(L("prose line\n***\nmore prose"));
  assert.deepEqual(blocks.map((b) => [b.kind, b.start, b.end]), [
    ["paragraph", 0, 1],
    ["other", 1, 2],
    ["paragraph", 2, 3],
  ]);
});

t("unfiled card starts below a properties block even with stray leading blanks", () => {
  // Blanks, a ----fenced properties run, then a task. The properties are never part
  // of the card, so no unfiled write can land above or inside the --- fences.
  const lines = L("\n\n---\nStatus: Active\nTaskCount: 74\n\n---\n- [ ] put videos in presentation\n\n## July 2026\n- [ ] x");
  const s = unfiledSection(lines, "_Unfiled_");
  assert.equal(s.body, "- [ ] put videos in presentation");
  assert.equal(s.startLine, 7, "card begins on the task line, below the closing ---");
  const blocks = sectionBlocks(s.body.split("\n"));
  assert.deepEqual(blocks.map((b) => b.kind), ["item"]);
});

t("adding to the unfiled card never writes above the properties block", () => {
  const lines = L("\n---\nStatus: Active\n---\nunfiled text\n### 2026-08-20");
  const s = unfiledSection(lines, "_Unfiled_");
  assert.equal(s.body, "unfiled text", "the --- fences are not card content");
  const top = insertIntoSection(lines, s, "NEW LINE", "top");
  assert.deepEqual(top.slice(0, 6), ["", "---", "Status: Active", "---", "NEW LINE", "unfiled text"]);
  const bottom = insertIntoSection(lines, s, "NEW LINE", "bottom");
  assert.deepEqual(bottom.slice(3, 6), ["---", "unfiled text", "NEW LINE"]);
});

t("parseSections honors a properties block behind leading blank lines", () => {
  const secs = parseSections(L("\n\n---\ntags: x\n---\n### real\nbody"), 3);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].title, "real");
});

t("bodyForRender: a blank line stops a leading '---' being swallowed as frontmatter", () => {
  assert.equal(bodyForRender("---\na: b\n---\ntext"), "\n---\na: b\n---\ntext");
  assert.equal(bodyForRender("plain text"), "plain text");
  assert.equal(bodyForRender("text\n---\nmore"), "text\n---\nmore"); // only a leading --- needs it
});

t("hexToTriplet parses #rrggbb and #rgb; rejects everything else", () => {
  assert.equal(hexToTriplet("#e05252"), "224, 82, 82");
  assert.equal(hexToTriplet("4C82EB"), "76, 130, 235");   // bare and uppercase
  assert.equal(hexToTriplet("#f00"), "255, 0, 0");
  assert.equal(hexToTriplet("red"), null);
  assert.equal(hexToTriplet("#12345"), null);
  assert.equal(hexToTriplet(""), null);
});

t("normalizePalette: always nine slots; blank labels and bad colors fall back per field", () => {
  const defaults = normalizePalette(undefined);
  assert.equal(defaults.length, 9);
  assert.deepEqual(defaults[0], { label: "Red", hex: "#e05252" });
  const merged = normalizePalette([{ label: "Urgent", hex: "#ff0000" }, { label: "  ", hex: "nope" }]);
  assert.deepEqual(merged[0], { label: "Urgent", hex: "#ff0000" });
  assert.deepEqual(merged[1], { label: "Orange", hex: "#eb8c34" }); // both fields fell back
  assert.deepEqual(merged[8], defaults[8]);                          // missing entries fall back
});

t("contrastForeground stays light except on genuinely pale colors", () => {
  assert.equal(contrastForeground("#d4aa14"), "#ffffff"); // default yellow: mid-tone, stays white
  assert.equal(contrastForeground("#4c82eb"), "#ffffff"); // default blue
  assert.equal(contrastForeground("#f0bcd5"), "#000000"); // pastel blush flips to black
  assert.equal(contrastForeground("#ffffff"), "#000000");
  assert.equal(contrastForeground("#000000"), "#ffffff");
  assert.equal(contrastForeground("not-a-color"), "#ffffff"); // safe fallback
});

t("every palette preset has nine parseable colors and non-empty labels", () => {
  for (const preset of PALETTE_PRESETS) {
    assert.equal(preset.colors.length, 9, preset.name);
    for (const c of preset.colors) {
      assert.ok(hexToTriplet(c.hex), `${preset.name}: ${c.hex}`);
      assert.ok(c.label.trim().length, `${preset.name}: empty label`);
    }
  }
});

t("moveBlock: a task moves to the end of another section, byte-identical", () => {
  const lines = L("### A\n- [ ] one\n\t- [ ] child\n- [ ] two\n\n### B\n- [ ] bee");
  const out = moveBlock(lines, 3, 0, 0, 1, null);   // A's first item -> end of B
  assert.equal(out.join("\n"), "### A\n- [ ] two\n\n### B\n- [ ] bee\n- [ ] one\n\t- [ ] child");
});

t("moveBlock: before a specific block in the target", () => {
  const lines = L("### A\n- [ ] one\n- [ ] two\n\n### B\n- [ ] bee1\n- [ ] bee2");
  const out = moveBlock(lines, 3, 0, 1, 1, 1);      // A's 'two' before B's 'bee2'
  assert.equal(out.join("\n"), "### A\n- [ ] one\n\n### B\n- [ ] bee1\n- [ ] two\n- [ ] bee2");
});

t("moveBlock: paragraphs gain blank separators; tasks don't", () => {
  const lines = L("### A\nA standalone thought.\n\n### B\n- [ ] task");
  const out = moveBlock(lines, 3, 0, 0, 1, null);
  assert.equal(out.join("\n"), "### A\n\n### B\n- [ ] task\n\nA standalone thought.");
});

t("moveBlock: reorder within the same section, both directions", () => {
  const lines = L("### A\n- [ ] one\n- [ ] two\n- [ ] three");
  assert.equal(moveBlock(lines, 3, 0, 0, 0, 2).join("\n"), "### A\n- [ ] two\n- [ ] one\n- [ ] three");
  assert.equal(moveBlock(lines, 3, 0, 2, 0, 0).join("\n"), "### A\n- [ ] three\n- [ ] one\n- [ ] two");
});

t("moveBlock: dropping a block on its own position is a no-op", () => {
  const lines = L("### A\n- [ ] one\n- [ ] two");
  assert.equal(moveBlock(lines, 3, 0, 0, 0, 0), null);
  assert.equal(moveBlock(lines, 3, 0, 0, 0, 1), null);  // before its own successor
});

t("sample vault: moving any task of the newest day to another day touches only those two sections", () => {
  const lines = fs.readFileSync(SAMPLE_NOTE, "utf8").split(/\r?\n/);
  const before = parseSections(lines, 3);
  const src = 0, dst = 5;
  const srcBody = lines.slice(before[src].startLine + 1, before[src].endLine);
  const blocks = movableBlocks(srcBody);
  assert.ok(blocks.length >= 2, "newest day has movable blocks");
  for (let b = 0; b < blocks.length; b++) {
    const out = moveBlock(lines, 3, src, b, dst, null);
    const after = parseSections(out, 3);
    assert.equal(after.length, before.length, "section count kept");
    for (let i = 0; i < before.length; i++) {
      if (i === src || i === dst) continue;
      assert.equal(after[i].raw, before[i].raw, "section " + i + " untouched moving block " + b);
    }
    const movedText = srcBody.slice(blocks[b].start, blocks[b].end).join("\n");
    assert.ok(after[dst].raw.includes(movedText), "target gained block " + b);
    assert.ok(!after[src].raw.includes(movedText) || srcBody.join("\n").split(movedText).length > 2,
      "source lost block " + b);
    assert.ok(!/\n\s*\n\s*\n\s*\n/.test(out.join("\n")), "no blank pile-up for block " + b);
  }
});

// ---------- Custom Grid placement ----------

const R = (x, y, w, h) => ({ x, y, w, h });

t("rectsCollide: overlap, touching, and near-touching all count within the gap", () => {
  assert.ok(rectsCollide(R(0, 0, 100, 100), R(50, 50, 100, 100), 12), "overlap");
  assert.ok(rectsCollide(R(0, 0, 100, 100), R(100, 0, 100, 100), 12), "edge-touching");
  assert.ok(rectsCollide(R(0, 0, 100, 100), R(108, 0, 100, 100), 12), "inside the gap");
  assert.ok(!rectsCollide(R(0, 0, 100, 100), R(113, 0, 100, 100), 12), "clear of the gap");
  assert.ok(!rectsCollide(R(0, 0, 100, 100), R(0, 300, 100, 100), 12), "far apart");
});

t("findFreeSpot returns the request when it's legal, clamped to the canvas", () => {
  assert.deepEqual(findFreeSpot(R(40, 60, 280, 200), [], 12), R(40, 60, 280, 200));
  assert.deepEqual(findFreeSpot(R(-30, -5, 280, 200), [], 12), R(0, 0, 280, 200));
});

t("findFreeSpot marches down past occupied space", () => {
  const placed = [R(0, 0, 300, 220)];
  const spot = findFreeSpot(R(10, 10, 280, 200), placed, 12);
  assert.equal(spot.x, 10, "x is kept");
  assert.ok(spot.y >= 232, "cleared below the obstacle plus gap, got y=" + spot.y);
  assert.ok(!placed.some((o) => rectsCollide(spot, o, 12)));
});

t("findFreeSpot threads a gap between two cards when one exists", () => {
  const placed = [R(0, 0, 280, 100), R(0, 400, 280, 100)];
  const spot = findFreeSpot(R(0, 90, 280, 150), placed, 12);
  assert.ok(spot.y >= 112 && spot.y + 150 + 12 <= 400, "landed between, got y=" + spot.y);
});

// ---------- canvas snapping ----------

t("snapRect rounds onto the 24px grid and respects minimums", () => {
  assert.deepEqual(snapRect(R(101, 130, 275, 190), 24, 192, 120), R(96, 120, 264, 192));
  assert.deepEqual(snapRect(R(-15, 5, 100, 40), 24, 192, 120), R(0, 0, 192, 120));
  assert.deepEqual(snapRect(R(48, 72, 288, 192), 24, 192, 120), R(48, 72, 288, 192), "already snapped is unchanged");
});

t("findFreeSpot with a snap step keeps snapped rects on the grid", () => {
  const placed = [R(48, 0, 288, 192)];
  const want = snapRect(R(50, 10, 280, 190), 24, 192, 120);
  const spot = findFreeSpot(want, placed, 12, 24);
  assert.equal(spot.x % 24, 0, "x on grid");
  assert.equal(spot.y % 24, 0, "y on grid, got " + spot.y);
  assert.ok(!placed.some((o) => rectsCollide(spot, o, 12)));
});

// ---------- pinned cards ----------

const PINNED_DOC = L(`### 2026-08-01
a
### 2026-08-02
b
### 2026-08-03
c
### 2026-08-04
d`);

t("applyPinned pulls pinned sections to the front, keeping sort order in both groups", () => {
  const secs = sortSections(parseSections(PINNED_DOC, 3), "desc");
  const out = applyPinned(secs, ["### 2026-08-03", "### 2026-08-01"]);
  assert.deepEqual(out.map((s) => s.title), ["2026-08-03", "2026-08-01", "2026-08-04", "2026-08-02"],
    "pinned lead in desc order, the rest follow in desc order");
});

t("applyPinned ignores pins that match no section and leaves order alone when none match", () => {
  const secs = sortSections(parseSections(PINNED_DOC, 3), "asc");
  assert.deepEqual(applyPinned(secs, ["### gone"]).map((s) => s.title),
    secs.map((s) => s.title));
  assert.deepEqual(applyPinned(secs, ["### gone", "### 2026-08-04"]).map((s) => s.title),
    ["2026-08-04", "2026-08-01", "2026-08-02", "2026-08-03"]);
});

t("applyPinned with every section pinned is the plain sort order", () => {
  const secs = sortSections(parseSections(PINNED_DOC, 3), "asc");
  const all = secs.map((s) => s.headingRaw);
  assert.deepEqual(applyPinned(secs, all).map((s) => s.title), secs.map((s) => s.title));
});

// ---------- quick add ----------

const QUICK_DOC = L(`### 2026-08-02
- [ ] first
- [ ] last

### 2026-08-01
old`);

t("insertIntoSection bottom lands after the last content line, before the blank separator", () => {
  const secs = parseSections(QUICK_DOC, 3);
  const out = insertIntoSection(QUICK_DOC, secs[0], "- [ ] new task", "bottom");
  assert.deepEqual(out.slice(0, 5), ["### 2026-08-02", "- [ ] first", "- [ ] last", "- [ ] new task", ""]);
  assert.equal(out.length, QUICK_DOC.length + 1);
});

t("insertIntoSection top lands right under the heading", () => {
  const secs = parseSections(QUICK_DOC, 3);
  const out = insertIntoSection(QUICK_DOC, secs[0], "urgent", "top");
  assert.deepEqual(out.slice(0, 3), ["### 2026-08-02", "urgent", "- [ ] first"]);
});

t("insertIntoSection keeps multi-line text and strips trailing whitespace", () => {
  const secs = parseSections(QUICK_DOC, 3);
  const out = insertIntoSection(QUICK_DOC, secs[1], "line one\nline two\n\n", "bottom");
  assert.deepEqual(out.slice(-3), ["old", "line one", "line two"]);
});

t("insertIntoSection round-trips: the other section is untouched", () => {
  const secs = parseSections(QUICK_DOC, 3);
  const out = insertIntoSection(QUICK_DOC, secs[0], "x", "bottom");
  const after = parseSections(out, 3);
  assert.equal(after[1].raw, secs[1].raw);
});

t("sectionFromEdited re-describes the section, heading edits included", () => {
  const [orig] = parseSections(L(`### 2026-08-06
- [ ] a`), 3);
  const edited = "### renamed\n- [ ] a\n- [ ] b";
  const next = sectionFromEdited(orig, edited);
  assert.equal(next.headingRaw, "### renamed");
  assert.equal(next.title, "renamed");
  assert.equal(next.raw, edited);
  assert.equal(next.body, "- [ ] a\n- [ ] b");
  assert.equal(next.endLine, orig.startLine + 3);
});

t("sectionFromEdited predicts what parseSections yields after the write", () => {
  const lines = L(`### one
a
### two
b`);
  const secs = parseSections(lines, 3);
  const edited = "### one\na\nc";
  lines.splice(secs[0].startLine, secs[0].endLine - secs[0].startLine, ...edited.split("\n"));
  const after = parseSections(lines, 3);
  const predicted = sectionFromEdited(secs[0], edited);
  assert.equal(after[0].raw, predicted.raw);
  assert.equal(after[0].headingRaw, predicted.headingRaw);
  assert.equal(after[0].endLine, predicted.endLine);
  assert.equal(after[1].raw, secs[1].raw);
});

t("unfiledSection grabs text above the first heading, below frontmatter", () => {
  const pre = unfiledSection(L(`---
title: x
---

- [ ] loose task
note line

### 2026-08-06
body`), "_Unfiled_");
  assert.equal(pre.title, "_Unfiled_");
  assert.equal(pre.headingRaw, UNFILED_KEY);
  assert.equal(pre.raw, "- [ ] loose task\nnote line");
  assert.equal(pre.startLine, 4);
  assert.equal(pre.endLine, 6);
  assert.ok(pre.unfiled);
});

t("unfiledSection: any heading rank ends the preamble; fenced headings don't", () => {
  const pre = unfiledSection(L(`\`\`\`
### fenced
\`\`\`
tail
## real`), "_Unfiled_");
  assert.equal(pre.raw, "```\n### fenced\n```\ntail");
});

t("unfiledSection is null when the file starts at a heading or is blank", () => {
  assert.equal(unfiledSection(L(`### top
body`), "_Unfiled_"), null);
  assert.equal(unfiledSection(L(`---
a: 1
---

### top`), "_Unfiled_"), null);
});

t("parseCards prepends the unfiled card; null title turns it off", () => {
  const lines = L(`loose
### one
a`);
  const cards = parseCards(lines, 3, "_Unfiled_");
  assert.equal(cards.length, 2);
  assert.ok(cards[0].unfiled);
  assert.equal(cards[1].title, "one");
  assert.equal(parseCards(lines, 3, null).length, 1);
});

t("sortSections keeps the unfiled card first in every order", () => {
  const cards = parseCards(L(`loose
### 2026-08-05
a
### 2026-08-07
b`), 3, "_Unfiled_");
  for (const order of ["asc", "desc", "doc"]) {
    assert.ok(sortSections(cards, order)[0].unfiled, `unfiled first under ${order}`);
  }
});

t("moveBlockBetween moves a task out of the unfiled preamble into a section", () => {
  const lines = L(`- [ ] loose
### one
- [ ] a`);
  const [pre, one] = parseCards(lines, 3, "_Unfiled_");
  const out = moveBlockBetween(lines, pre, 0, one, null);
  assert.equal(out.join("\n"), `### one
- [ ] a
- [ ] loose`);
});

t("moveBlockBetween moves a task into the unfiled preamble's top", () => {
  const lines = L(`loose
### one
- [ ] a`);
  const [pre, one] = parseCards(lines, 3, "_Unfiled_");
  const out = moveBlockBetween(lines, one, 0, pre, 0);
  assert.equal(out.join("\n"), `- [ ] a
loose
### one`);
});

t("sectionFromEdited on the unfiled card treats every line as body", () => {
  const pre = unfiledSection(L(`loose
### one`), "_Unfiled_");
  const edited = "loose\nmore";
  const after = sectionFromEdited(pre, edited);
  assert.equal(after.raw, edited);
  assert.equal(after.body, edited);
  assert.equal(after.headingRaw, UNFILED_KEY);
  assert.equal(after.title, "_Unfiled_");
  assert.equal(after.endLine, 2);
});

t("removeBlock deletes a task with its sub-items", () => {
  const lines = L(`### one
- [ ] a
	- [ ] nested
- [ ] b`);
  const [one] = parseSections(lines, 3);
  const out = removeBlock(lines, one, 0);
  assert.equal(out.join("\n"), `### one
- [ ] b`);
});

t("removeBlock collapses the doubled blank a deleted paragraph leaves", () => {
  const lines = L(`### one
first

middle

last`);
  const [one] = parseSections(lines, 3);
  const out = removeBlock(lines, one, 1);
  assert.equal(out.join("\n"), `### one
first

last`);
});

t("removeBlock refuses an out-of-range block", () => {
  const lines = L(`### one
- [ ] a`);
  const [one] = parseSections(lines, 3);
  assert.equal(removeBlock(lines, one, 5), null);
});

t("titleHasDate spots an ISO date anywhere in the title", () => {
  assert.ok(titleHasDate("2026-08-06, Thursday", "YYYY-MM-DD, dddd"));
  assert.ok(titleHasDate("prefix 2026-08-06 suffix", ""));
  assert.ok(!titleHasDate("Groceries", "YYYY-MM-DD, dddd"), "plain title is not a date");
  assert.ok(!titleHasDate("Meeting 12-34", ""), "partial numbers are not a date");
});

t("template placeholders fill title, the card's own date, and formats", () => {
  const out = applyTemplatePlaceholders(
    "# {{title}}\n- [ ] plan {{date}}\n- [ ] recap {{ date : MM-DD }}\nat {{time:HH}}",
    "2026-08-20, Thursday",
    "YYYY-MM-DD, dddd",
  );
  assert.ok(out.includes("# 2026-08-20, Thursday"), "title replaced");
  assert.ok(out.includes("plan 2026-08-20"), "{{date}} uses the heading's date, not today");
  assert.ok(out.includes("recap STUB-MM-DD"), "custom date format passed through");
  assert.ok(out.includes("at STUB-HH"), "custom time format passed through");
});

t("a template without placeholders passes through untouched", () => {
  const raw = "- [ ] standing item\n\ttab-indented note";
  assert.equal(applyTemplatePlaceholders(raw, "Groceries", "YYYY-MM-DD, dddd"), raw);
});

// ---------- hierarchy layout ----------

const HIER_NOTE = L(`intro card text
# Alpha
## A1
### card1
- a
### card2
## A2
### card3
# Beta
### card4
## B1
### card5`);

t("parseAncestorHeadings collects only headings above the card level", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  assert.deepEqual(heads.map((h) => [h.level, h.title]), [
    [1, "Alpha"], [2, "A1"], [2, "A2"], [1, "Beta"], [2, "B1"],
  ]);
  assert.equal(heads[0].line, 1);
});

t("parseAncestorHeadings skips fences and frontmatter", () => {
  const heads = parseAncestorHeadings(L(`---
title: x
---
\`\`\`
# fake
\`\`\`
# real`), 3);
  assert.deepEqual(heads.map((h) => h.title), ["real"]);
});

t("hierarchy column 1 lists H1s with ranges to the next H1", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = parseSections(HIER_NOTE, 3).map((s) => s.headingLine);
  const items = hierarchyColumnItems(heads, 1, 0, HIER_NOTE.length, cards);
  assert.deepEqual(items.map((i) => i.label), ["Alpha", "Beta"]);
  assert.equal(items[0].start, 1);
  assert.equal(items[0].end, 8, "Alpha ends where Beta starts");
  assert.equal(items[1].end, HIER_NOTE.length);
});

t("a drilled column lists only the selected branch's children", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = parseSections(HIER_NOTE, 3).map((s) => s.headingLine);
  const alpha = hierarchyColumnItems(heads, 1, 0, HIER_NOTE.length, cards)[0];
  const items = hierarchyColumnItems(heads, 2, alpha.start, alpha.end, cards);
  assert.deepEqual(items.map((i) => i.label), ["A1", "A2"]);
  // cards under A1 are card1+card2, under A2 just card3
  assert.equal(cards.filter((l) => l >= items[0].start && l < items[0].end).length, 2);
  assert.equal(cards.filter((l) => l >= items[1].start && l < items[1].end).length, 1);
});

t("cards before the level's first heading get a synthetic gap item", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = parseSections(HIER_NOTE, 3).map((s) => s.headingLine);
  const beta = hierarchyColumnItems(heads, 1, 0, HIER_NOTE.length, cards)[1];
  const items = hierarchyColumnItems(heads, 2, beta.start, beta.end, cards);
  assert.equal(items[0].key, HIER_GAP_KEY, "card4 has no H2, so Beta leads with the gap item");
  assert.ok(cards.some((l) => l >= items[0].start && l < items[0].end), "card4 falls in the gap");
  assert.deepEqual(items.slice(1).map((i) => i.label), ["B1"]);
});

t("the unfiled preamble reaches the cards pane through gap items", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const pre = unfiledSection(HIER_NOTE, "Unfiled");
  const cards = [pre.headingLine, ...parseSections(HIER_NOTE, 3).map((s) => s.headingLine)];
  const items = hierarchyColumnItems(heads, 1, 0, HIER_NOTE.length, cards);
  assert.equal(items[0].key, HIER_GAP_KEY);
  assert.ok(pre.headingLine >= items[0].start && pre.headingLine < items[0].end);
});

t("headingLevelsIn lists only levels present, skipping fences and frontmatter", () => {
  assert.deepEqual(headingLevelsIn(L(HIER_NOTE.join("\n"))), [1, 2, 3]);
  assert.deepEqual(headingLevelsIn(L("---\ntags: x\n---\n\`\`\`\n# fake\n\`\`\`\n## real\n##### deep")), [2, 5]);
  assert.deepEqual(headingLevelsIn(L("no headings here")), []);
});

t("openTaskCount counts unchecked tasks only, skipping fences", () => {
  assert.equal(openTaskCount("- [ ] a\n- [x] done\n\t- [ ] nested\nplain text\n1. [ ] numbered"), 3);
  assert.equal(openTaskCount("```\n- [ ] fenced\n```\n- [ ] real"), 1);
  assert.equal(openTaskCount("no tasks here"), 0);
});

t("a range with no headings at the level yields only the gap item (or nothing)", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = parseSections(HIER_NOTE, 3).map((s) => s.headingLine);
  const withCards = hierarchyColumnItems(heads, 2, 9, 10, cards); // Beta's headingless start
  assert.deepEqual(withCards.map((i) => i.key), [HIER_GAP_KEY]);
  const empty = hierarchyColumnItems(heads, 2, 0, 1, []); // just the intro text
  assert.equal(empty.length, 0);
});

t("groupByAncestor groups cards under their nearest ancestor heading", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = parseSections(HIER_NOTE, 3);
  const groups = groupByAncestor(cards, heads);
  assert.deepEqual(groups.map((g) => g.title), ["A1", "A2", "Beta", "B1"]);
  assert.deepEqual(groups.map((g) => g.sections.map((s) => s.title)), [
    ["card1", "card2"], ["card3"], ["card4"], ["card5"],
  ], "card4 has no H2, so its nearest ancestor is the H1 Beta");
  assert.ok(groups.every((g) => g.key.startsWith("#")), "keys are the raw heading lines");
});

t("groupByAncestor: groups follow their first card's order; no ancestor means key \"\"", () => {
  const heads = parseAncestorHeadings(HIER_NOTE, 3);
  const cards = sortSections(parseSections(HIER_NOTE, 3), "desc");
  const groups = groupByAncestor(cards, heads);
  assert.deepEqual(groups.map((g) => g.title), ["B1", "Beta", "A2", "A1"]);
  assert.deepEqual(groups[3].sections.map((s) => s.title), ["card2", "card1"], "in-group sort order kept");
  const pre = unfiledSection(HIER_NOTE, "Unfiled");
  const withPre = groupByAncestor([pre, ...parseSections(HIER_NOTE, 3)], heads);
  assert.equal(withPre[0].key, "", "the preamble card has no ancestor");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
