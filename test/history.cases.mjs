// Undo and redo of the cards' writes (src/history.ts): what gets recorded, merged,
// refused, and kept across a rename — and the block key line drags compare with.
import { NoteHistory, MERGE_WINDOW_MS, setNoteRecorder, processNote, insertSection, deleteSection, parseCards, SectionCardsView } from "./.tmp/main.js";
import { t, ta } from "./harness.mjs";
import assert from "assert";

t("history: undo puts the text back, redo repeats it, and a new change clears redo", () => {
  const h = new NoteHistory();
  h.record("n.md", "a", "b", "Move card");
  h.record("n.md", "b", "c", "Delete card");
  assert.equal(h.peekUndo("n.md").label, "Delete card");
  const u = h.undo("n.md", "c");
  assert.equal(u.text, "b");
  assert.equal(h.peekRedo("n.md").label, "Delete card");
  assert.equal(h.undo("n.md", "b").text, "a");
  assert.equal(h.undo("n.md", "a"), null, "nothing left");
  assert.equal(h.redo("n.md", "a").text, "b");
  h.record("n.md", "b", "x", "Edit card");
  assert.equal(h.peekRedo("n.md"), null, "a fresh change drops the redo stack");
  assert.equal(h.peekUndo("other.md"), null, "stacks are per note");
});

t("history: a note changed elsewhere since refuses the undo and drops its stacks", () => {
  const h = new NoteHistory();
  h.record("n.md", "a", "b", "Move card");
  h.record("n.md", "b", "c", "Nest card");
  assert.equal(h.undo("n.md", "c typed more"), "changed");
  assert.equal(h.peekUndo("n.md"), null);
  assert.equal(h.peekRedo("n.md"), null);
});

t("history: one card edit's saves merge into a step, within the window and the same key only", () => {
  const h = new NoteHistory();
  h.record("n.md", "a", "b", "Edit card", "edit:### X", 1000);
  h.record("n.md", "b", "c", "Edit card", "edit:### X", 2000);
  assert.equal(h.undo("n.md", "c").text, "a", "two saves, one undo");
  const g = new NoteHistory();
  g.record("n.md", "a", "b", "Edit card", "edit:### X", 1000);
  g.record("n.md", "b", "c", "Edit card", "edit:### Y", 2000);
  g.record("n.md", "c", "d", "Edit card", "edit:### Y", 2000 + MERGE_WINDOW_MS + 1);
  assert.equal(g.undo("n.md", "d").text, "c", "past the window: its own step");
  assert.equal(g.undo("n.md", "c").text, "b");
  assert.equal(g.undo("n.md", "b").text, "a", "another card's edit: its own step");
  const back = new NoteHistory();
  back.record("n.md", "a", "b", "Edit card", "k", 0);
  back.record("n.md", "b", "a", "Edit card", "k", 1);
  assert.equal(back.peekUndo("n.md"), null, "an edit typed back to where it started leaves no step");
});

t("history: bounded in steps and in text, and follows a rename", () => {
  const h = new NoteHistory(3, 1000);
  for (let i = 0; i < 5; i++) h.record("n.md", `v${i}`, `v${i + 1}`, "Move card");
  assert.equal(h.undo("n.md", "v5").text, "v4");
  assert.equal(h.undo("n.md", "v4").text, "v3");
  assert.equal(h.undo("n.md", "v3").text, "v2");
  assert.equal(h.undo("n.md", "v2"), null, "only the newest 3 kept");
  const big = new NoteHistory(30, 100);
  big.record("n.md", "x".repeat(40), "y".repeat(40), "Edit card");
  big.record("n.md", "y".repeat(40), "z".repeat(40), "Edit card");
  assert.equal(big.undo("n.md", "z".repeat(40)).text, "y".repeat(40));
  assert.equal(big.undo("n.md", "y".repeat(40)), null, "the oldest dropped past the text limit");
  const r = new NoteHistory();
  r.record("old.md", "a", "b", "Move card");
  r.rename("old.md", "new.md");
  assert.equal(r.peekUndo("old.md"), null);
  assert.equal(r.undo("new.md", "b").text, "a");
});

ta("history: the card writes report to the recorder with their label; an unchanged write doesn't", async () => {
  const state = { text: "### A\none\n\n### B\ntwo\n" };
  const file = { path: "rec.md" };
  const app = { vault: { process: async (_f, fn) => { state.text = fn(state.text); return state.text; } } };
  const seen = [];
  setNoteRecorder((f, before, after, label) => { if (f === file) seen.push({ before, after, label }); });
  try {
    const b = parseCards(state.text.split("\n"), 3).find((s) => s.title === "B");
    const start = state.text;
    assert.ok(await deleteSection(app, file, 3, b));
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].label, seen[0].before, seen[0].after], ["Delete card", start, state.text]);
    await insertSection(app, file, "### C", "bottom", "three");
    assert.equal(seen[1].label, "New card");
    await processNote(app, file, "Nothing", (d) => d);
    assert.equal(seen.length, 2, "a write that changes nothing isn't a step");
  } finally {
    setNoteRecorder(null);
  }
});

t("line drags: a hidden block id or comment doesn't count toward the text a line is matched by", () => {
  const key = (s) => SectionCardsView["blockKey"](s);
  assert.equal(key("- [ ] 08:00–08:30 Garbage ^ical-abc123"), key("- [ ] 08:00–08:30 Garbage"));
  assert.equal(key("- [ ] 08:00–08:30 Garbage ^ical-abc123"), "08:00–08:30 garbage");
  assert.equal(key("text %%hidden note%% more"), key("text  more"));
});
