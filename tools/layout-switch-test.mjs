// Layout-switch regression test, run against the live Obsidian (see tools/drive-obsidian.mjs).
// For each note and each target layout: open the view fresh in that layout and record a
// signature of what it drew; then reach the same layout from every other layout and
// compare. Anything a previous layout leaves behind — elements, classes on the view,
// toolbar controls shown or hidden, popovers on the body — shows up as a difference.
//   node tools/layout-switch-test.mjs                      → both default notes, every pair
//   NOTES="Handbook.md" ONLY=dashboard,grid node tools/layout-switch-test.mjs
// ONLY narrows the targets (sources are always every layout). Exits 1 on any failure.
// The notes' per-note view settings are put back afterwards.

const port = process.env.PORT ?? "9222";
const LAYOUTS = ["grid", "aligned", "tight", "tasks", "horizontal", "vertical", "custom", "images", "links", "calendar", "heatmap", "dashboard", "rolodex", "planner", "binder", "table", "tree"];
const NOTES = (process.env.NOTES ?? "Daily Notes 2026.md,Handbook.md").split(",").map((s) => s.trim());
const TARGETS = process.env.ONLY ? process.env.ONLY.split(",").map((s) => s.trim()) : LAYOUTS;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /Obsidian/.test(t.title ?? "")) ?? targets.find((t) => t.type === "page");
if (!page) throw new Error("no Obsidian page target on port " + port);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.bad(new Error(JSON.stringify(d.error))) : p.ok(d.result); } };
const send = (method, params = {}) => new Promise((ok, bad) => { const n = ++id; pending.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => {
	const r = await send("Runtime.evaluate", { expression: `(async () => (${expression}))()`, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
	return r.result.value;
};
const sleep = (ms) => new Promise((k) => setTimeout(k, ms));

const P = `app.plugins.plugins["single-file-section-cards"]`;
const V = `app.workspace.getLeavesOfType("section-cards-view")[0]?.view`;

// What the view drew, as plain data. Classes that only track the pointer or focus are left
// out — they depend on where the mouse happens to be, not on what was rendered.
const VOLATILE = ["is-hovered", "is-focused", "has-focus", "is-hover", "is-dragging"];
const SIGNATURE = `(() => {
	const v = ${V};
	if (!v) return null;
	const volatile = new Set(${JSON.stringify(VOLATILE)});
	// Elements on screen (they have a box) count toward pass/fail; the rest are tallied
	// apart — a hidden leftover is invisible, but still worth knowing about.
	const counts = {};
	const hidden = {};
	for (const el of v.contentEl.querySelectorAll("*")) {
		if (el.closest(".markdown-rendered, .cm-editor")) continue; // rendered note text, not layout chrome
		const tag = el.tagName.toLowerCase();
		const classes = [...el.classList].filter((c) => !volatile.has(c));
		if (!classes.length) continue;
		const into = el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" ? counts : hidden;
		for (const c of classes) into[c] = (into[c] ?? 0) + 1;
		// Inline styles a layout sets (positions, spans, sizes) are tallied by property:
		// the values move with measurement, but a property one layout leaves on another's
		// elements is exactly the kind of leftover that misplaces things.
		for (let i = 0; i < el.style.length; i++) {
			const prop = el.style[i];
			if (prop.startsWith("--")) continue; // custom properties: zoom, offsets, colours
			into["style:" + prop] = (into["style:" + prop] ?? 0) + 1;
		}
		if (tag === "button" || tag === "input" || tag === "select") into["<" + tag + ">"] = (into["<" + tag + ">"] ?? 0) + 1;
	}
	const rootClasses = [...v.contentEl.classList].filter((c) => !volatile.has(c)).sort().join(" ");
	// Which toolbar controls a person can actually see.
	const shown = [...v.contentEl.querySelectorAll(".section-cards-toolbar button, .section-cards-toolbar input, .section-cards-toolbar select")]
		.filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden")
		.map((el) => [...el.classList].filter((c) => !volatile.has(c) && c !== "is-active").join(".") || el.tagName.toLowerCase())
		.sort();
	const label = v.contentEl.querySelector(".section-cards-layout-btn")?.textContent?.trim() ?? "";
	// Floating things a layout hangs on the body (popovers, previews, menus) must go too.
	const floating = [...document.body.querySelectorAll(":scope > .popover, :scope > .menu, :scope > .modal-container, :scope > .sc-heat-preview, :scope > [class*='sfsc-'], :scope > [class*='sc-']")]
		.map((el) => el.className).sort();
	return { layout: v.layout, rootClasses, counts, hidden, shown, label, floating };
})()`;

/** Wait until the signature stops changing (two equal reads 200 ms apart), up to 5 s. */
async function settled() {
	let last = null;
	let same = 0;
	for (let i = 0; i < 25; i++) {
		await sleep(200);
		const sig = await ev(SIGNATURE);
		const key = JSON.stringify(sig);
		if (key === last) { if (++same >= 2) return sig; } else { same = 0; last = key; }
	}
	return JSON.parse(last);
}

function diff(fresh, got) {
	const out = [];
	if (got.layout !== fresh.layout) out.push(`layout ${got.layout} ≠ ${fresh.layout}`);
	if (got.rootClasses !== fresh.rootClasses) {
		const a = new Set(fresh.rootClasses.split(" ")), b = new Set(got.rootClasses.split(" "));
		const extra = [...b].filter((c) => !a.has(c)), missing = [...a].filter((c) => !b.has(c));
		out.push(`view classes${extra.length ? " +" + extra.join(" +") : ""}${missing.length ? " -" + missing.join(" -") : ""}`);
	}
	if (got.label !== fresh.label) out.push(`layout button "${got.label}" ≠ "${fresh.label}"`);
	const fs = fresh.shown.join(","), gs = got.shown.join(",");
	if (fs !== gs) {
		const extra = got.shown.filter((c) => !fresh.shown.includes(c)), missing = fresh.shown.filter((c) => !got.shown.includes(c));
		out.push(`toolbar${extra.length ? " shows " + extra.join(", ") : ""}${missing.length ? " hides " + missing.join(", ") : ""}`);
	}
	if (got.floating.join("|") !== fresh.floating.join("|")) out.push(`on the body: ${JSON.stringify(got.floating)} vs ${JSON.stringify(fresh.floating)}`);
	const counted = countDiff(fresh.counts, got.counts);
	if (counted) out.push("visible elements " + counted);
	return out;
}

/** "class before→after, …" for the classes whose counts differ, or "" when none do. */
function countDiff(a, b) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	const changed = [...keys].filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).sort();
	if (!changed.length) return "";
	return changed.slice(0, 12).map((k) => `${k} ${a[k] ?? 0}→${b[k] ?? 0}`).join(", ") + (changed.length > 12 ? ` (+${changed.length - 12} more)` : "");
}

async function openFresh(note, layout) {
	await ev(`(async () => {
		const p = ${P};
		const pf = p.settings.perFile[${JSON.stringify(note)}] ?? (p.settings.perFile[${JSON.stringify(note)}] = {});
		pf.layout = ${JSON.stringify(layout)};
		await p.saveSettings();
		// Keep one empty tab while the old ones close: with no tab left, Obsidian has no
		// tab group to open the new view in.
		let keep;
		try { keep = app.workspace.getLeaf("tab"); } catch { keep = app.workspace.createLeafInParent(app.workspace.rootSplit, 0); }
		for (const l of app.workspace.getLeavesOfType("section-cards-view")) l.detach();
		for (const l of app.workspace.getLeavesOfType("markdown")) l.detach();
		await p.openCardsView(${JSON.stringify(note)});
		for (const l of app.workspace.getLeavesOfType("markdown")) l.detach();
		if (keep.view?.getViewType() === "empty" && app.workspace.getLeavesOfType("section-cards-view").length) keep.detach();
		const v = ${V};
		v.deckMode = false;
		if (v.layout !== ${JSON.stringify(layout)}) v.switchLayout(${JSON.stringify(layout)});
		return v.layout;
	})()`);
	return settled();
}

async function switchTo(layout) {
	await ev(`(() => { const v = ${V}; v.switchLayout(${JSON.stringify(layout)}); return v.layout; })()`);
	return settled();
}

// Errors the plugin throws while switching fail the run too.
await ev(`(() => {
	window.__sfscSwitchErrors = [];
	if (!window.__sfscSwitchHooked) {
		window.__sfscSwitchHooked = true;
		window.addEventListener("error", (e) => window.__sfscSwitchErrors.push(String(e.message)));
		window.addEventListener("unhandledrejection", (e) => window.__sfscSwitchErrors.push("rejection: " + String(e.reason)));
		const orig = console.error;
		console.error = (...a) => { window.__sfscSwitchErrors.push("console.error: " + a.map(String).join(" ").slice(0, 200)); orig.apply(console, a); };
	}
	return 1;
})()`);

const saved = JSON.parse(await ev(`JSON.stringify(Object.fromEntries(${JSON.stringify(NOTES)}.map((n) => [n, ${P}.settings.perFile[n] ?? null])))`));
const failures = [];
const notes = []; // hidden leftovers: not failures, reported after them
let pairs = 0;
const started = Date.now();
try {
	for (const note of NOTES) {
		for (const target of TARGETS) {
			const fresh = await openFresh(note, target);
			const errs0 = await ev(`window.__sfscSwitchErrors.splice(0).join(" | ")`);
			if (errs0) failures.push({ note, from: "(fresh)", to: target, problems: ["errors: " + errs0] });
			const bad = [];
			for (const from of LAYOUTS) {
				if (from === target) continue;
				pairs++;
				await switchTo(from);
				const got = await switchTo(target);
				const problems = diff(fresh, got);
				const errs = await ev(`window.__sfscSwitchErrors.splice(0).join(" | ")`);
				if (errs) problems.push("errors: " + errs);
				if (problems.length) {
					bad.push(from);
					failures.push({ note, from, to: target, problems });
				}
				const leftover = countDiff(fresh.hidden, got.hidden);
				if (leftover) notes.push({ note, from, to: target, leftover });
			}
			console.log(`${bad.length ? "FAIL" : "PASS"}  ${note} → ${target}${bad.length ? "  from " + bad.join(", ") : ""}`);
		}
	}
} finally {
	await ev(`(async () => {
		const p = ${P};
		const saved = ${JSON.stringify(saved)};
		for (const [n, pf] of Object.entries(saved)) { if (pf) p.settings.perFile[n] = pf; else delete p.settings.perFile[n]; }
		await p.saveSettings();
		return 1;
	})()`);
	ws.close();
}

console.log(`\n${pairs - failures.filter((f) => f.from !== "(fresh)").length}/${pairs} switches matched a fresh render (${Math.round((Date.now() - started) / 1000)} s)`);
for (const f of failures) console.log(`\n✗ ${f.note}: ${f.from} → ${f.to}\n   ${f.problems.join("\n   ")}`);
if (notes.length) {
	console.log(`\nHidden leftovers (not on screen, so not failures): ${notes.length} switches`);
	for (const n of notes) console.log(`   ${n.note}: ${n.from} → ${n.to}: ${n.leftover}`);
}
process.exit(failures.length ? 1 : 0);
