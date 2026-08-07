import { parseSections, sortSections, insertionLine, detectDirection, normalizeHeading, isTodayTitle, toggleTaskLine, taskLineIndexes, resolveViewSettings, wheelDeltaToPixels, canScrollVertically, splitLinktext, pickHeadingLevel, planCardReuse, trimTrailingBlankLines, sectionDeleteRange } from "./.tmp/main.js";
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
  assert.deepEqual(resolveViewSettings(undefined, {}, DEFAULTS), DEFAULTS);
});

t("a note's saved view wins over restored tab state and defaults", () => {
  const saved = { layout: "vertical", headingLevel: 2, sortOrder: "desc" };
  const state = { layout: "tight", headingLevel: 4, sortOrder: "asc" };
  assert.deepEqual(resolveViewSettings(saved, state, DEFAULTS), saved);
});

t("restored tab state is used when the note has no saved view", () => {
  const state = { layout: "aligned", headingLevel: 2, sortOrder: "desc" };
  assert.deepEqual(resolveViewSettings(undefined, state, DEFAULTS), state);
});

t("partial saved views fall through field by field", () => {
  assert.deepEqual(
    resolveViewSettings({ layout: "horizontal" }, { sortOrder: "desc" }, DEFAULTS),
    { layout: "horizontal", headingLevel: 3, sortOrder: "desc" },
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
