// The Table and Tree layouts' model: the note's outline and its rows.
import { parseTableOutline, tableRows, tableLineText, tableWrapText } from "./.tmp/main.js";
import assert from "assert";
import { t } from "./harness.mjs";

const L = (s) => s.split("\n");

const NOTE = L(`---
tags: [a]
---
Intro line one.

Intro line two.

# Alpha
alpha text
## Alpha one
one text
## Alpha two
### Alpha two deep
deep text
# Beta
## Beta one
# Gamma
gamma text only
`);

t("parseTableOutline: nests by rank, keeps each heading's own text, skips frontmatter", () => {
  const o = parseTableOutline(NOTE);
  assert.equal(o.depth, 3);
  assert.deepEqual(o.roots.map((r) => r.title), ["Alpha", "Beta", "Gamma"]);
  const alpha = o.roots[0];
  assert.deepEqual(alpha.children.map((c) => c.title), ["Alpha one", "Alpha two"]);
  assert.equal(NOTE.slice(alpha.textStart, alpha.textEnd).join("\n"), "alpha text");
  const deep = alpha.children[1].children[0];
  assert.equal(deep.title, "Alpha two deep");
  assert.equal(deep.level, 3);
  assert.equal(NOTE.slice(deep.textStart, deep.textEnd).join("\n"), "deep text");
  // Beta one has no text: an empty range right after its heading.
  const betaOne = o.roots[1].children[0];
  assert.equal(betaOne.textStart, betaOne.headingLine + 1);
  assert.equal(betaOne.textEnd, betaOne.textStart);
  // The preamble is the text between the properties block and the first heading, trimmed.
  assert.equal(NOTE.slice(o.preamble.textStart, o.preamble.textEnd).join("\n"), "Intro line one.\n\nIntro line two.");
});

t("parseTableOutline: an H3 under an H1 nests directly (no empty H2 column); fenced #'s aren't headings", () => {
  const o = parseTableOutline(L("# Top\n### Deep\ntext\n```\n# not a heading\n```\n## Mid"));
  assert.equal(o.depth, 2);
  assert.deepEqual(o.roots[0].children.map((c) => c.title), ["Deep", "Mid"]);
  assert.equal(o.preamble, null);
});

t("parseTableOutline: no headings — just a preamble, or nothing", () => {
  const o = parseTableOutline(L("just text\nmore"));
  assert.equal(o.depth, 0);
  assert.deepEqual(o.roots, []);
  assert.deepEqual(o.preamble, { textStart: 0, textEnd: 2 });
  const empty = parseTableOutline(L("\n\n"));
  assert.equal(empty.preamble, null);
  assert.equal(empty.roots.length, 0);
});

t("tableRows: a parent spans its children's rows, plus one for its own text; leaves span the spare columns", () => {
  const o = parseTableOutline(NOTE);
  const rows = tableRows(o, NOTE);
  // preamble, Alpha(own) + Alpha one + Alpha two deep, Beta one, Gamma = 6 rows
  assert.equal(rows.length, 6);
  const [pre, alphaOwn, alphaOne, alphaTwo, betaOne, gamma] = rows;
  assert.deepEqual(pre.cells.map((c) => c.kind), ["preamble", "text"]);
  assert.equal(pre.cells[0].colSpan, 3);
  // Alpha's heading cell leads its first row and spans three rows: its own text, Alpha one, Alpha two deep.
  assert.equal(alphaOwn.cells[0].kind, "heading");
  assert.equal(alphaOwn.cells[0].text, "Alpha");
  assert.equal(alphaOwn.cells[0].rowSpan, 3);
  assert.deepEqual(alphaOwn.cells.slice(1).map((c) => [c.kind, c.colSpan]), [["pad", 2], ["text", 1]]);
  assert.equal(alphaOwn.cells[2].text, "alpha text");
  // Alpha one is a leaf under Alpha at column 1: its heading spans the two remaining heading columns.
  assert.deepEqual(alphaOne.cells.map((c) => [c.kind, c.text, c.rowSpan, c.colSpan]), [
    ["heading", "Alpha one", 1, 2],
    ["text", "one text", 1, 1],
  ]);
  // Alpha two has one child and no own text: its cell spans that one row, then the child's cells.
  assert.deepEqual(alphaTwo.cells.map((c) => [c.kind, c.text, c.rowSpan, c.colSpan]), [
    ["heading", "Alpha two", 1, 1],
    ["heading", "Alpha two deep", 1, 1],
    ["text", "deep text", 1, 1],
  ]);
  assert.deepEqual(betaOne.cells.map((c) => [c.kind, c.text, c.rowSpan, c.colSpan]), [
    ["heading", "Beta", 1, 1],
    ["heading", "Beta one", 1, 2],
    ["text", "", 1, 1],
  ]);
  assert.deepEqual(gamma.cells.map((c) => [c.kind, c.text, c.colSpan]), [
    ["heading", "Gamma", 3],
    ["text", "gamma text only", 1],
  ]);
  // Every text cell names the lines it shows, so an edit can write them back.
  const deepText = alphaTwo.cells[2];
  assert.deepEqual(NOTE.slice(...deepText.range), ["deep text"]);
});

t("tableRows: every row fills the same number of columns", () => {
  const o = parseTableOutline(NOTE);
  const width = o.depth + 1;
  // Replay the rowspans: a grid of occupied cells, row by row.
  const taken = [];
  tableRows(o, NOTE).forEach((row, r) => {
    let col = 0;
    for (const cell of row.cells) {
      while (taken[r]?.[col]) col++;
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        taken[r + dr] = taken[r + dr] ?? [];
        for (let dc = 0; dc < cell.colSpan; dc++) taken[r + dr][col + dc] = true;
      }
      col += cell.colSpan;
    }
    while (taken[r]?.[col]) col++;
    assert.equal(col, width, `row ${r} ends at column ${col}`);
  });
});

t("tableLineText: blank lines dropped, the rest on one line", () => {
  assert.equal(tableLineText("- [ ] a   task\n\n  second\t line \n"), "- [ ] a task · second line");
  assert.equal(tableLineText(""), "");
  assert.equal(tableLineText("\n \n"), "");
});

t("tableWrapText: blank lines dropped, the rest kept as lines", () => {
  assert.equal(tableWrapText("- [ ] a   task\n\n  second\t line \n"), "- [ ] a task\nsecond line");
  assert.equal(tableWrapText(""), "");
});
