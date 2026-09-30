// Renaming a card rewrites the links to its heading (src/headinglinks.ts): which links
// match, how each spelling is rewritten, and that a moved-on file is left alone.
import { headingLinkEdits, applyLinkEdits, retitleSectionInFile, parseCards } from "./.tmp/main.js";
import { t, ta } from "./harness.mjs";
import assert from "assert";

/** A vault of in-memory notes with a hand-built metadata cache: each note's headings
 * and links found by regex, links resolved by bare note name. */
function fakeVault(notes) {
	const files = Object.fromEntries(Object.keys(notes).map((p) => [p, { path: p, basename: p.replace(/\.md$/, "") }]));
	const cacheOf = (p) => {
		const text = notes[p];
		const headings = [];
		const links = [];
		const embeds = [];
		let offset = 0;
		text.split("\n").forEach((line, i) => {
			const h = /^(#+)\s+(.*)$/.exec(line);
			if (h) headings.push({ heading: h[2], level: h[1].length, position: { start: { line: i } } });
			for (const m of line.matchAll(/(!?)\[\[([^\]|]+)(\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\)/g)) {
				const link = m[2] ?? decodeURI(m[4]);
				const ref = { link, original: m[0], position: { start: { offset: offset + m.index }, end: { offset: offset + m.index + m[0].length } } };
				(m[1] ? embeds : links).push(ref);
			}
			offset += line.length + 1;
		});
		return { headings, links, embeds };
	};
	const dest = (path, source) => (path === "" ? files[source] : files[`${path.replace(/\.md$/, "")}.md`] ?? null);
	const resolvedLinks = {};
	for (const p of Object.keys(notes)) {
		resolvedLinks[p] = {};
		for (const r of [...cacheOf(p).links, ...cacheOf(p).embeds]) {
			const d = dest(r.link.split("#")[0], p);
			if (d) resolvedLinks[p][d.path] = 1;
		}
	}
	return {
		files,
		notes,
		app: {
			metadataCache: {
				resolvedLinks,
				getFileCache: (f) => cacheOf(f.path),
				getCache: (p) => cacheOf(p),
				getFirstLinkpathDest: (path, source) => dest(path, source),
			},
			vault: {
				getFileByPath: (p) => files[p] ?? null,
				process: async (f, fn) => (notes[f.path] = fn(notes[f.path])),
			},
		},
	};
}

const DAILY = "# Daily\n\n### Plans\n- [ ] ship it\n\n### Other\nsee [[#Plans]]\n";
const OTHER = "Links: [[Daily#Plans]], [[Daily#Plans|the plan]], ![[Daily#Plans]], [x](Daily.md#Plans), [[Daily#Other]], [[Daily]]\n";

t("links: every spelling of a link to the heading is found, and only those", () => {
	const v = fakeVault({ "Daily.md": DAILY, "Other.md": OTHER });
	const edits = headingLinkEdits(v.app, v.files["Daily.md"], 2, "Plans", "Big plans");
	assert.deepEqual(
		edits.get("Other.md").map((e) => e.to),
		["[[Daily#Big plans]]", "[[Daily#Big plans|the plan]]", "[x](Daily.md#Big%20plans)", "![[Daily#Big plans]]"],
	);
	assert.deepEqual(edits.get("Daily.md").map((e) => e.to), ["[[#Big plans]]"], "the note's own link, path left empty");
});

t("links: a heading the cache puts elsewhere (a stale cache) matches nothing", () => {
	const v = fakeVault({ "Daily.md": DAILY, "Other.md": OTHER });
	assert.equal(headingLinkEdits(v.app, v.files["Daily.md"], 3, "Plans", "Big plans").size, 0);
	assert.equal(headingLinkEdits(v.app, v.files["Daily.md"], 2, "Not plans", "Big plans").size, 0);
});

t("links: characters a link can't hold become spaces, a parent chain is kept", () => {
	const v = fakeVault({ "Daily.md": DAILY, "Other.md": "[[Daily#Daily#Plans]]\n" });
	const [edit] = headingLinkEdits(v.app, v.files["Daily.md"], 2, "Plans", "Q3: plans #work").get("Other.md");
	assert.equal(edit.to, "[[Daily#Daily#Q3 plans work]]");
});

t("links: applying skips a span that no longer holds the link", () => {
	const text = "a [[N#X]] b [[N#X]]";
	const edits = [
		{ start: 2, end: 9, from: "[[N#X]]", to: "[[N#Y]]" },
		{ start: 12, end: 19, from: "[[N#Q]]", to: "[[N#Y]]" },
	];
	assert.deepEqual(applyLinkEdits(text, edits), { text: "a [[N#Y]] b [[N#X]]", applied: 1 });
});

ta("links: the rename writes the heading and the note's own links in one pass", async () => {
	const v = fakeVault({ "Daily.md": DAILY, "Other.md": OTHER });
	const section = parseCards(DAILY.split("\n"), 3).find((s) => s.title === "Plans");
	const own = headingLinkEdits(v.app, v.files["Daily.md"], section.headingLine, "Plans", "Big plans").get("Daily.md");
	assert.ok(await retitleSectionInFile(v.app, v.files["Daily.md"], 3, section, "### Big plans", own));
	assert.equal(v.notes["Daily.md"], "# Daily\n\n### Big plans\n- [ ] ship it\n\n### Other\nsee [[#Big plans]]\n");
});
