// Renders the plugin's real DOM structure into standalone HTML files — one per layout —
// so they can be screenshotted in headless Chrome with Obsidian's app.css loaded.
//
// Usage:
//   node test/run.mjs                      # builds test/.tmp/main.js (the parse bundle)
//   node tools/asar-extract.mjs <obsidian.asar> app.css   # run inside the out dir
//   node tools/preview-harness.mjs <outdir>
//   chrome --headless=new --screenshot=grid.png --window-size=1280,760 <outdir>/grid.html
//
// The HTML mirrors the classes and nesting main.ts builds (toolbar with the filter box,
// pinned band, grid/tray/zoom for the Custom Grid) plus an inline script that replays
// layoutMasonry/insertRowRules, so styles.css lays the cards out exactly like the app.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCards, sortSections, parseAncestorHeadings, hierarchyColumnItems, groupByAncestor, HIER_GAP_KEY, openTaskCount } from "../test/.tmp/main.js";

const OUT_DIR = process.argv[2] ?? "harness-out";
const here = path.dirname(fileURLToPath(import.meta.url));
const notePath = process.env.NOTE ?? path.join(here, "..", "sample-vault", "Daily Notes 2026.md");
const LEVEL = Number(process.env.LEVEL ?? 3);
const SORT = process.env.SORT ?? "desc";
/** The card highlighted as "today" — the newest date in the sample vault. */
const TODAY = process.env.TODAY ?? "2026-08-06";

const note = fs.readFileSync(notePath, "utf8");
const sections = sortSections(parseCards(note.split(/\r?\n/), LEVEL, null), SORT);
/** Whether the note's headings name days — drives the toolbar's dates controls. */
const NOTE_HAS_DATES = sections.some((s) => /\d{4}-\d{2}-\d{2}/.test(s.title));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
	esc(s)
		.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<a class="internal-link" data-href="${t}" href="${t}">${t}</a>`)
		.replace(/(^|\s)(#[\w/-]+)/g, (_, sp, tag) => `${sp}<a href="${tag}" class="tag" target="_blank" rel="noopener">${tag}</a>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>");

const TASK = /^(\s*)- (?:\[([ x])\] )?(.*)$/;

/** Approximate Obsidian's reading-view DOM for the constructs in the sample vault:
 * paragraphs, task lists with one level of nesting, #tags, [[wikilinks]]. */
function renderBody(md) {
	const lines = md.split("\n");
	const out = [];
	let i = 0;
	const li = (mark, text, kidsHtml = "") => {
		const isTask = mark !== undefined;
		const checked = mark === "x";
		const box = isTask ? `<input type="checkbox" class="task-list-item-checkbox"${checked ? " checked" : ""}> ` : "";
		const cls = isTask ? ` class="task-list-item${checked ? " is-checked" : ""}" data-task="${checked ? "x" : " "}"` : "";
		return `<li${cls}>${box}${inline(text)}${kidsHtml}</li>`;
	};
	while (i < lines.length) {
		if (!lines[i].trim()) {
			i++;
			continue;
		}
		const m = TASK.exec(lines[i]);
		if (m && !m[1]) {
			out.push('<ul class="contains-task-list">');
			while (i < lines.length) {
				const t = TASK.exec(lines[i]);
				if (!t || t[1]) break;
				const kids = [];
				let j = i + 1;
				for (; j < lines.length; j++) {
					const k = TASK.exec(lines[j]);
					if (k && k[1]) kids.push(k);
					else break;
				}
				const kidsHtml = kids.length
					? '<ul class="contains-task-list">' + kids.map((k) => li(k[2], k[3])).join("") + "</ul>"
					: "";
				out.push(li(t[2], t[3], kidsHtml));
				i = j;
			}
			out.push("</ul>");
		} else {
			const para = [];
			while (i < lines.length && lines[i].trim() && !TASK.exec(lines[i])) para.push(lines[i++]);
			out.push(`<p dir="auto">${inline(para.join(" "))}</p>`);
		}
	}
	return out.join("\n");
}

/** Header buttons exist on every card (hidden until hover), matching renderCard: the
 * untray hugs the title's left in Custom Grid; the rest overlay from the right edge. */
const HEADER_BUTTONS = `<button class="section-card-untray"></button><div class="section-card-actions"><button class="section-card-quickadd"></button><button class="section-card-color"></button><button class="section-card-delete"></button><button class="section-card-big"></button><button class="section-card-open"></button><button class="section-card-pin"></button></div>`;

function cardHtml(s, { maxHeight = null, placed = null, hierHidden = false } = {}) {
	const today = s.title.includes(TODAY) ? " is-today" : "";
	const placedCls = (placed ? " is-placed" : "") + (hierHidden ? " is-hier-hidden" : "");
	const style = placed ? ` style="left:${placed.x}px;top:${placed.y}px;width:${placed.w}px;height:${placed.h}px"` : "";
	const bodyStyle = maxHeight ? ` style="max-height: ${maxHeight}px;"` : "";
	return `<div class="section-card${today}${placedCls}"${style} draggable="true">
	<div class="section-card-header is-click-big">
		<div class="section-card-title">${esc(s.title || "(untitled)")}</div>${HEADER_BUTTONS}
	</div>
	<div class="section-card-body markdown-rendered"${bodyStyle}>${renderBody(s.body) || '<div class="section-card-placeholder">Empty section — click to add content.</div>'}</div>
</div>`;
}

const DECK_ICON = `<svg viewBox="0 0 100 100" class="svg-icon" width="16" height="16"><g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="9" width="12" height="12.5" rx="2"/><path d="M5.5 6h10a2 2 0 0 1 2 2v10"/><path d="M8.5 3h10a2 2 0 0 1 2 2v10"/></g></svg>`;

const LAYOUT_LABELS = { grid: "Grid", aligned: "Grid Aligned", tight: "Tight", horizontal: "Horizontal", vertical: "Vertical", custom: "Custom Grid", images: "Images", links: "Links", calendar: "Calendar", heatmap: "Heatmap" };
const SORT_LABELS = { asc: "A → Z", desc: "Z → A", doc: "Document order" };
/* On the Calendar the sort control orders the months instead of the cards. */
const CAL_SORT_LABELS = { asc: "Ascending", desc: "Descending", doc: "Ascending" };

const CAL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-calendar-days"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>`;
const MENU_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-menu"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>`;
const TEMPLATE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-layout-template"><rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/></svg>`;

/** Mirrors buildToolbar: Heading+Filter on the left, date controls mid-bar, then the
 * View mode toggle, Layout/Sort, and the action buttons on the right.
 * mode: "default" | "hier" | "sections" — which View mode segment is active. */
function toolbarHtml(layout, mode = "default") {
	const seg = (label, key) =>
		`<button${mode === key ? ' class="is-active"' : ""}${["custom", "images", "links", "calendar", "heatmap"].includes(layout) ? " disabled" : ""}>${label}</button>`;
	// The Calendar hides the dates checkbox (redundant there), as does the Images
	// canvas (dates mean nothing to pictures); styles.css hides the Card level and
	// filter controls via the layout class.
	const datesHidden = ["calendar", "heatmap", "images", "links"].includes(layout) ? " is-hidden" : "";
	return `<div class="section-cards-toolbar${MOBILE ? " is-compact" : ""}">
	<button class="section-cards-icon-btn section-cards-menu-btn">${MENU_ICON}</button>
	<button class="section-cards-file-btn"><span>${path.basename(notePath)}</span></button>
	<div class="section-cards-control section-cards-level-control"><span class="section-cards-label">Card level</span><select class="dropdown"${["calendar", "heatmap"].includes(layout) ? " disabled" : ""}><option>H${LEVEL}</option></select></div>
	<div class="section-cards-control section-cards-filter"><input type="text" class="section-cards-filter-input" placeholder="Filter…" spellcheck="false"><button class="section-cards-filter-clear"></button></div>
	<div class="section-cards-spacer"></div>
	<div class="section-cards-control">
		<div class="section-cards-jump-date${NOTE_HAS_DATES ? "" : " is-hidden"}"><button class="section-cards-icon-btn section-cards-jump-btn">${CAL_ICON}</button></div>
		<label class="section-cards-dates-label${datesHidden}"><span class="section-cards-label">Dates</span><input type="checkbox" class="section-cards-dates-toggle"${NOTE_HAS_DATES ? " checked" : ""}></label>
	</div>
	<div class="section-cards-spacer"></div>
	<button class="section-cards-new-btn mod-cta">${MOBILE ? "+" : "+ New card"}</button>
	<div class="section-cards-control section-cards-mode-control"><span class="section-cards-label">View mode</span><div class="section-cards-segmented">${seg("Default", "default")}${seg("Hierarchy", "hier")}${seg("Dividers", "sections")}</div></div>
	<div class="section-cards-control section-cards-sort-control"><span class="section-cards-label">Sort</span><select class="dropdown"><option>${(layout === "calendar" ? CAL_SORT_LABELS : SORT_LABELS)[SORT]}</option></select></div>
	<div class="section-cards-control"><span class="section-cards-label">Layout</span><select class="dropdown"><option>${LAYOUT_LABELS[layout]}</option></select></div>
	<button class="section-cards-icon-btn section-cards-template-btn">${TEMPLATE_ICON}</button>
	<button class="section-cards-icon-btn">↻</button>
	<button class="section-cards-help-btn">?</button>
</div>`;
}

/** Custom Grid: placed cards (snap 24, gap ≥12), the rest listed in the tray.
 * Override with PLACEMENTS='[{"x":48,"y":48,"w":312,"h":216},…]' to stage other scenes;
 * placements map onto the sorted sections in order. */
const PLACEMENTS = process.env.PLACEMENTS
	? JSON.parse(process.env.PLACEMENTS)
	: [
			{ x: 48, y: 48, w: 408, h: 480 },
			{ x: 480, y: 48, w: 312, h: 216 },
			{ x: 480, y: 288, w: 312, h: 240 },
		];

const CHEVRON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-chevron-down"><path d="m6 9 6 6 6-6"/></svg>`;

/** Replays layoutCalendar: a weekday header row, then per month a full-width label,
 * leading pads to the 1st's weekday column, and a cell per day — card or blank. */
function calendarHtml() {
	const byIso = new Map();
	for (const s of sections) {
		const iso = /\d{4}-\d{2}-\d{2}/.exec(s.title)?.[0];
		if (iso && !byIso.has(iso)) byIso.set(iso, s);
	}
	const isos = [...byIso.keys()].sort();
	// A note with no dated headings can't stage a calendar; an empty grid keeps the
	// page valid when another note is rendered via NOTE=.
	if (!isos.length) return `<div class="section-cards-pinned"></div>\n<div class="section-cards-grid"></div>\n<div class="section-cards-tray"></div>`;
	const [y0, m0] = isos[0].split("-").map(Number);
	const [y1, m1] = isos[isos.length - 1].split("-").map(Number);
	const months = [];
	for (let year = y0, month = m0; year < y1 || (year === y1 && month <= m1); month++, month > 12 && (month = 1, year++)) {
		months.push([year, month]);
	}
	if (SORT === "desc") months.reverse();
	const parts = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n) => `<div class="sc-cal-dow">${n}</div>`);
	for (const [year, month] of months) {
		const label = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
		parts.push(`<div class="sc-cal-month">${label}</div>`);
		const lead = new Date(year, month - 1, 1).getDay();
		for (let i = 0; i < lead; i++) parts.push(`<div class="sc-cal-blank sc-cal-pad"></div>`);
		const days = new Date(year, month, 0).getDate();
		for (let day = 1; day <= days; day++) {
			const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
			const s = byIso.get(iso);
			parts.push(s ? cardHtml(s) : `<div class="sc-cal-blank" role="button">${day}</div>`);
		}
	}
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid">
${parts.join("\n")}
</div>
<div class="section-cards-tray"></div>`;
}

/** Images canvas: a few images placed at mixed sizes, the rest as thumbnail tiles
 * in the tray. Stage real photos (screenshots/images.png uses royalty-free ones)
 * by copying them into the out dir and passing IMAGES="a.jpg,b.jpg,…" — the first
 * four land on the canvas (spots sized 8:5, 11:7, 11:10, 16:9), the rest fill the
 * tray. Without the override the harness's abstract background SVGs stand in. */
function imagesHtml() {
	const files = process.env.IMAGES
		? process.env.IMAGES.split(",").map((f) => f.trim())
		: ["bg-sunset.svg", "bg-ocean.svg", "bg-forest.svg", "bg-plum.svg", "bg-aurora.svg", "bg-dunes.svg", "bg-meadow.svg"];
	const IMG_SPOTS = [
		{ x: 48, y: 48, w: 384, h: 240 },
		{ x: 456, y: 48, w: 264, h: 168 },
		{ x: 456, y: 240, w: 264, h: 240 },
		{ x: 48, y: 312, w: 384, h: 216 },
	];
	const placed = IMG_SPOTS.slice(0, files.length).map(
		(r, i) =>
			`<div class="sc-image-card is-placed" style="left: ${r.x}px; top: ${r.y}px; width: ${r.w}px; height: ${r.h}px;">` +
			`<img class="sc-image-card-img" src="${files[i]}" alt="${files[i]}" draggable="false">` +
			`<div class="sc-image-card-name">${files[i]}</div>` +
			`<button class="sc-image-untray">✕</button></div>`,
	);
	const tiles = files.slice(IMG_SPOTS.length).map(
		(name) =>
			`<div class="section-cards-tray-tile sc-image-tile">` +
			`<img class="sc-image-thumb" src="${name}" alt="${name}" draggable="false">` +
			`<div class="sc-image-tile-name">${name}</div></div>`,
	);
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid" style="--sc-zoom: 1;">
<div class="section-cards-canvas-extent" style="left: 1447px; top: 1049px;"></div>
${placed.join("\n")}
</div>
<div class="section-cards-tray">
	<div class="section-cards-tray-actions"><button class="section-cards-tray-clear">Clear layout</button></div>
	<div class="section-cards-tray-sorts"><button class="section-cards-tray-sort${SORT === "asc" ? " is-active" : ""}">A→Z</button><button class="section-cards-tray-sort${SORT === "desc" ? " is-active" : ""}">Z→A</button><button class="section-cards-tray-sort${SORT === "doc" ? " is-active" : ""}">Doc</button></div>
	<div class="section-cards-tray-hint">Drag an image onto the canvas</div>
${tiles.join("\n")}
</div>
<div class="section-cards-zoom"><button>−</button><button class="section-cards-zoom-label">100%</button><button>+</button></div>`;
}

/** Links canvas: page previews staged offline via srcdoc stand-in pages. */
function linksHtml() {
	const GLOBE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-globe"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
	const fakePage = (title, hue) =>
		`<html><body style="margin:0;font-family:sans-serif;background:#fff"><div style="background:hsl(${hue},60%,45%);color:#fff;padding:14px 16px;font-size:15px;font-weight:700">${title}</div><div style="padding:12px 16px"><div style="height:10px;width:80%;background:#ddd;border-radius:4px;margin:8px 0"></div><div style="height:10px;width:95%;background:#e7e7e7;border-radius:4px;margin:8px 0"></div><div style="height:10px;width:70%;background:#ddd;border-radius:4px;margin:8px 0"></div><div style="height:72px;background:hsl(${hue},45%,88%);border-radius:6px;margin:12px 0"></div><div style="height:10px;width:88%;background:#e7e7e7;border-radius:4px;margin:8px 0"></div><div style="height:10px;width:60%;background:#ddd;border-radius:4px;margin:8px 0"></div></div></body></html>`;
	// Entirely fictional pages and reserved-.example domains — nothing real to date.
	const LINKS = [
		{ label: "Quarterly planning guide", url: "https://planwise.example/guides/quarterly", hue: 210, spot: { x: 48, y: 48, w: 312, h: 336 } },
		{ label: "Espresso machine manual", url: "https://brewtech.example/manuals/lx-9", hue: 0, spot: { x: 384, y: 48, w: 312, h: 240 } },
		{ label: "Trail map — Pine Ridge loop", url: "https://trailatlas.example/pine-ridge", hue: 150, spot: { x: 384, y: 312, w: 312, h: 264 } },
		{ label: "Sourdough starter FAQ", url: "https://crumbworks.example/faq", hue: 265 },
		{ label: "Home office lighting ideas", url: "https://lumenlab.example/office", hue: 330 },
	];
	const placed = LINKS.filter((l) => l.spot).map(
		({ label, hue, spot: r }) =>
			`<div class="sc-image-card sc-link-card is-placed" style="left: ${r.x}px; top: ${r.y}px; width: ${r.w}px; height: ${r.h}px;">` +
			`<div class="sc-link-card-bar"><span class="sc-link-card-icon">${GLOBE}</span><span class="sc-link-card-title">${esc(label)}</span></div>` +
			`<iframe class="sc-link-card-frame" scrolling="no" srcdoc="${esc(fakePage(label, hue)).replace(/"/g, "&quot;")}"></iframe>` +
			`<button class="sc-image-untray">✕</button></div>`,
	);
	const tiles = LINKS.filter((l) => !l.spot).map(
		({ label, url }) =>
			`<div class="section-cards-tray-tile sc-link-tile">` +
			`<div class="sc-link-tile-row"><span class="sc-link-card-icon">${GLOBE}</span><span class="sc-link-tile-name">${esc(label)}</span></div>` +
			`<div class="sc-link-tile-url">${esc(url)}</div></div>`,
	);
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid" style="--sc-zoom: 1;">
<div class="section-cards-canvas-extent" style="left: 1447px; top: 1049px;"></div>
${placed.join("\n")}
</div>
<div class="section-cards-tray">
	<div class="section-cards-tray-actions"><button class="section-cards-tray-clear">Clear layout</button></div>
	<div class="section-cards-tray-sorts"><button class="section-cards-tray-sort${SORT === "asc" ? " is-active" : ""}">A→Z</button><button class="section-cards-tray-sort${SORT === "desc" ? " is-active" : ""}">Z→A</button><button class="section-cards-tray-sort${SORT === "doc" ? " is-active" : ""}">Doc</button></div>
	<div class="section-cards-tray-hint">Drag a link onto the canvas</div>
${tiles.join("\n")}
</div>
<div class="section-cards-zoom"><button>−</button><button class="section-cards-zoom-label">100%</button><button>+</button></div>`;
}

/** Heatmap: a deterministic fake year of activity — most weekdays filled, weekends
 * sparse, done-counts varying — so the graph reads like a real daily-notes note. */
function heatmapHtml() {
	const today = new Date(Date.UTC(2026, 7, 6)); // the sample vault's "today"
	const start = new Date(Date.UTC(2026, 0, 1));
	let seed = 42;
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

	// Lead-in pads to the week start (Sunday).
	const first = new Date(start);
	while (first.getUTCDay() !== 0) first.setUTCDate(first.getUTCDate() - 1);
	let lastMonth = "";
	const weeks = [];
	let week = null;
	let days = 0, done = 0;
	for (const d = new Date(first); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
		if (d.getUTCDay() === 0) {
			week = { label: "", cells: [] };
			weeks.push(week);
			const labelDay = d < start ? start : d;
			const month = labelDay.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
			if (month !== lastMonth) week.label = month;
			lastMonth = month;
		}
		if (d < start) {
			week.cells.push('<div class="sc-heat-cell is-pad"></div>');
			continue;
		}
		const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
		const hasCard = rand() > (weekend ? 0.72 : 0.14);
		const n = hasCard ? Math.floor(rand() * 6) : 0;
		const level = !hasCard ? 0 : n === 0 ? 1 : 1 + Math.ceil((3 * n) / 5);
		if (hasCard) { days++; done += n; }
		const isToday = d.getTime() === today.getTime() ? " is-today" : "";
		week.cells.push(`<div class="sc-heat-cell lv${level}${isToday}"></div>`);
	}
	const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const stat = (value, label) =>
		`<div class="sc-heat-stat"><div class="sc-heat-stat-value">${value}</div><div class="sc-heat-stat-label">${label}</div></div>`;
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid">
<div class="sc-heat-wrap">
<div class="sc-heat-stats">${stat(9, "day streak")}${stat(23, "longest streak")}${stat(days, "days with cards")}${stat(done, "tasks done")}${stat(31, "still open")}</div>
<div class="sc-heat-scroll"><div class="sc-heat-graph">
<div class="sc-heat-week sc-heat-dows"><div class="sc-heat-mlabel"></div>${dows.map((n, i) => `<div class="sc-heat-dow">${i % 2 === 1 ? n : ""}</div>`).join("")}</div>
${weeks.map((w) => `<div class="sc-heat-week"><div class="sc-heat-mlabel">${w.label}</div>${w.cells.join("")}</div>`).join("\n")}
</div></div>
<div class="sc-heat-legend"><span>Less</span><div class="sc-heat-cell lv0"></div><div class="sc-heat-cell lv1"></div><div class="sc-heat-cell lv2"></div><div class="sc-heat-cell lv3"></div><div class="sc-heat-cell lv4"></div><span>More</span></div>
</div>
</div>
<div class="section-cards-tray"></div>`;
}

function gridHtml(layout, mode = "default") {
	const hier = mode === "hier";
	if (layout === "calendar") return calendarHtml();
	if (layout === "images") return imagesHtml();
	if (layout === "links") return linksHtml();
	if (layout === "heatmap") return heatmapHtml();
	if (layout === "custom") {
		const placedCards = sections.slice(0, PLACEMENTS.length).map((s, i) => cardHtml(s, { placed: PLACEMENTS[i] }));
		const hidden = sections.slice(PLACEMENTS.length).map((s) => cardHtml(s));
		const tiles = sections
			.slice(PLACEMENTS.length)
			.map((s) => `<div class="section-cards-tray-tile${s.title.includes(TODAY) ? " is-today" : ""}">${esc(s.title)}</div>`)
			.join("\n");
		return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid" style="--sc-zoom: 1;">
<div class="section-cards-canvas-extent" style="left: 1447px; top: 1049px;"></div>
${placedCards.join("\n")}
${hidden.join("\n")}
</div>
<div class="section-cards-tray">
	<div class="section-cards-tray-actions"><button class="section-cards-tray-clear">Clear layout</button></div>
	<div class="section-cards-tray-sorts"><button class="section-cards-tray-sort${SORT === "asc" ? " is-active" : ""}">A→Z</button><button class="section-cards-tray-sort${SORT === "desc" ? " is-active" : ""}">Z→A</button><button class="section-cards-tray-sort${SORT === "doc" ? " is-active" : ""}">Doc</button></div>
	<div class="section-cards-tray-hint">Drag a section onto the canvas</div>
${tiles}
</div>
<div class="section-cards-zoom"><button>−</button><button class="section-cards-zoom-label">100%</button><button>+</button></div>`;
	}
	if (hier) {
		// Replays rebuildHierarchy: each column defaults to its first item, and cards
		// off the selected branch wear is-hier-hidden. The cards keep `layout`.
		const lines = note.split(/\r?\n/);
		const heads = parseAncestorHeadings(lines, LEVEL);
		const cardInfo = sections.map((s) => ({ line: s.headingLine, open: openTaskCount(s.body) }));
		const cardLines = cardInfo.map((c) => c.line);
		let start = 0;
		let end = lines.length;
		const cols = [];
		for (let level = 1; level < LEVEL; level++) {
			const items = hierarchyColumnItems(heads, level, start, end, cardLines);
			if (!items.length) break;
			// Mirrors rebuildHierarchy: a lone gap item means no headings at this level,
			// so the column is skipped and the range falls through unchanged.
			if (items.length === 1 && items[0].key === HIER_GAP_KEY) continue;
			const selected = items[0];
			cols.push({ level, items, selected });
			start = selected.start;
			end = selected.end;
		}
		const colHtml = cols
			.map(
				({ level, items, selected }) => `<div class="section-cards-hier-col">
	<div class="section-cards-hier-col-label">H${level}</div>
${items
	.map((it) => {
		const inRange = cardInfo.filter((c) => c.line >= it.start && c.line < it.end);
		const open = inRange.reduce((n, c) => n + c.open, 0);
		const cls = (it === selected ? " is-selected" : "") + (it.key === HIER_GAP_KEY ? " is-gap" : "");
		const tasks = open > 0 ? `<span class="section-cards-hier-tasks">${open}</span>` : "";
		return `	<button class="section-cards-hier-item${cls}"><span class="section-cards-hier-item-label">${esc(it.label)}</span><span class="section-cards-hier-count">${inRange.length}</span>${tasks}</button>`;
	})
	.join("\n")}
</div>`,
			)
			.join("\n");
		const constrain = LEVEL > 1;
		const hierMaxHeight = layout === "vertical" ? null : layout === "tight" ? 190 : 320;
		return `<div class="section-cards-pinned"></div>
<div class="section-cards-hier">${colHtml}</div>
<div class="section-cards-grid">
${sections
	.map((s) =>
		cardHtml(s, {
			maxHeight: hierMaxHeight,
			hierHidden: constrain && (s.headingLine < start || s.headingLine >= end),
		}),
	)
	.join("\n")}
</div>
<div class="section-cards-tray"></div>`;
	}
	const maxHeight = layout === "vertical" ? null : layout === "tight" ? 190 : 320;
	if (mode === "sections") {
		// Replays insertSectionBars: cards regroup under their nearest ancestor heading,
		// each group led by a collapsible divider bar (chevron, title, rule, count).
		const heads = parseAncestorHeadings(note.split(/\r?\n/), LEVEL);
		const grouped = groupByAncestor(sections, heads);
		const parts = grouped.map((g) => {
			const bar =
				g.key === ""
					? ""
					: `<div class="section-cards-section-bar"><span class="section-cards-section-chevron">${CHEVRON_ICON}</span><span class="section-cards-section-title">${esc(g.title)}</span><span class="section-cards-section-count">${g.sections.length}</span></div>`;
			return bar + "\n" + g.sections.map((s) => cardHtml(s, { maxHeight })).join("\n");
		});
		return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid">
${parts.join("\n")}
</div>
<div class="section-cards-tray"></div>`;
	}
	return `<div class="section-cards-pinned"></div>
<div class="section-cards-grid">
${sections.map((s) => cardHtml(s, { maxHeight })).join("\n")}
</div>
<div class="section-cards-tray"></div>`;
}

/** Lucide path data for the icons openBlockMenu uses, so the staged menu matches the app. */
const LUCIDE = {
	"arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
	"arrow-down": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	pencil:
		'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	"list-plus": '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
	"calendar-check":
		'<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
	star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
	"trash-2":
		'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
};

const menuItem = (icon, title, selected = false) =>
	`<div class="menu-item tappable${selected ? " selected" : ""}"><div class="menu-item-icon"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${icon}">${LUCIDE[icon]}</svg></div><div class="menu-item-title">${esc(title)}</div></div>`;

/** The block context menu exactly as openBlockMenu builds it for an unchecked task
 * on a middle card with the Tasks plugin installed. Anchored beside that task by
 * MENU_SCRIPT once the grid has packed. */
function menuHtml() {
	const label = (target) => {
		const title = target.title || "(untitled)";
		return title.length > 28 ? `${title.slice(0, 27)}…` : title;
	};
	const today = sections.find((s) => s.title.startsWith(TODAY)) ?? sections[0];
	return `<div class="menu" style="left: 0; top: 0;"><div class="menu-scroll">
${menuItem("arrow-up", `Move line to previous card (${label(sections[0])})`)}
${menuItem("arrow-down", `Move line to next card (${label(sections[2])})`)}
${menuItem("calendar-check", `Move line to today (${label(today)})`)}
<div class="menu-separator"></div>
${menuItem("check", "Mark done")}
${menuItem("pencil", "Edit task (Tasks)…", true)}
${menuItem("list-plus", "New task below (Tasks)…")}
${menuItem("star", "Add star (⭐)")}
${menuItem("trash-2", "Delete line")}
</div></div>`;
}

/** Positions the staged menu as showAtMouseEvent would: at a right-click on the
 * second card's first unchecked task. Runs after PACK_SCRIPT has laid cards out. */
const MENU_SCRIPT = `<script>
(() => {
	const menu = document.querySelector(".menu");
	if (!menu) return;
	const cards = [...document.querySelectorAll(".section-cards-grid > .section-card")];
	const line = cards[1]?.querySelector("li.task-list-item:not(.is-checked)");
	if (!line) return;
	const r = line.getBoundingClientRect();
	menu.style.left = Math.round(r.left + r.width * 0.45) + "px";
	menu.style.top = Math.round(r.bottom + 4) + "px";
})();
</script>`;

/** Replays layoutMasonry + insertRowRules so styles.css packs cards like the app does. */
const PACK_SCRIPT = `<script>
(() => {
	const layout = document.currentScript.dataset.layout;
	const grid = document.querySelector(".section-cards-grid");
	if (layout === "calendar") {
		// The weekday header pins just under the toolbar, like the app's sticky row.
		const bar = document.querySelector(".section-cards-toolbar");
		document.querySelector(".section-cards-view").style.setProperty("--sc-toolbar-h", bar.offsetHeight + "px");
		return;
	}
	if (layout === "vertical" || layout === "custom") return;
	const style = getComputedStyle(grid);
	const cards = [...grid.children].filter((c) =>
		(c.classList.contains("section-card") || c.classList.contains("section-cards-section-bar")) &&
		!c.classList.contains("is-hier-hidden") && !c.classList.contains("is-section-hidden"));
	const columns = style.gridTemplateColumns.split(" ").filter((t) => t.trim()).length;
	if (layout === "aligned") {
		for (let i = columns; i < cards.length; i += columns) {
			const rule = document.createElement("div");
			rule.className = "section-cards-row-rule";
			grid.insertBefore(rule, cards[i]);
		}
		return;
	}
	if (columns <= 1) { grid.classList.add("is-one-col"); return; }
	const rowH = parseFloat(style.gridAutoRows) || 4;
	const gap = parseFloat(style.rowGap) || 0;
	const cardGap = parseFloat(style.getPropertyValue("--sc-card-gap")) || 12;
	const heights = cards.map((c) => c.getBoundingClientRect().height);
	cards.forEach((c, i) => { c.style.gridRowEnd = "span " + Math.max(1, Math.ceil((heights[i] + cardGap) / (rowH + gap))); });
})();
</script>`;

/** Generic abstract backgrounds for the screenshots: a diagonal base gradient with
 * two soft radial glows, one SVG file per palette, written into the out dir. */
const BG_PALETTES = {
	"bg-aurora": { base: ["#0f2027", "#203a43", "#2c5364"], glowA: "#66e0c2", glowB: "#7f7fd5" },
	"bg-sunset": { base: ["#2d1b3d", "#7a2f4f", "#c96a4a"], glowA: "#ffb36b", glowB: "#e05f9a" },
	"bg-forest": { base: ["#10241b", "#1e3d2f", "#2f5d43"], glowA: "#7fd8a4", glowB: "#cfe97f" },
	"bg-ocean": { base: ["#071f33", "#0d3b5e", "#14597f"], glowA: "#47b5ff", glowB: "#8ef4e0" },
	"bg-dunes": { base: ["#2a2016", "#4d3a24", "#7a5a33"], glowA: "#e8c07d", glowB: "#ff9f68" },
	"bg-plum": { base: ["#241b2f", "#45305c", "#6d4a86"], glowA: "#c69df2", glowB: "#f29dc4" },
	"bg-meadow": { base: ["#17261a", "#35502c", "#5c7a3a"], glowA: "#b9e769", glowB: "#7dd8c0" },
};

function backgroundSvg({ base, glowA, glowB }) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${base[0]}"/><stop offset=".5" stop-color="${base[1]}"/><stop offset="1" stop-color="${base[2]}"/></linearGradient>
<radialGradient id="a" cx=".22" cy=".25" r=".65"><stop offset="0" stop-color="${glowA}" stop-opacity=".5"/><stop offset="1" stop-color="${glowA}" stop-opacity="0"/></radialGradient>
<radialGradient id="b" cx=".8" cy=".78" r=".7"><stop offset="0" stop-color="${glowB}" stop-opacity=".45"/><stop offset="1" stop-color="${glowB}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1920" height="1080" fill="url(#g)"/>
<rect width="1920" height="1080" fill="url(#a)"/>
<rect width="1920" height="1080" fill="url(#b)"/>
</svg>`;
}

/** Which background each page wears; BG=<name> overrides all pages for a run, BG=none clears. */
const PAGE_BACKGROUNDS = {
	grid: "bg-sunset",
	aligned: "bg-forest",
	tight: "bg-ocean",
	horizontal: "bg-dunes",
	vertical: "bg-aurora",
	custom: "bg-plum",
	images: null, // the previews are the pictures — a photo background would fight them
	links: null, // same story: the page frames are the content
	calendar: "bg-meadow",
	heatmap: "bg-ocean",
	hierarchy: "bg-aurora",
	dividers: "bg-dunes",
	"context-menu": null,
};

function pageBackground(page) {
	if (process.env.BG === "none") return null;
	return process.env.BG ?? PAGE_BACKGROUNDS[page] ?? null;
}

/** MOBILE=1 stages the pages as Obsidian iOS: phone body classes (styles.css and
 * app.css key off them), the compact toolbar, no desktop tab strip — and a faked
 * status bar / view header / home indicator so the shot reads as an iPhone.
 * Screenshot at phone size, e.g. --window-size=390,844 --force-device-scale-factor=3. */
const MOBILE = !!process.env.MOBILE;

const STATUS_ICONS = `<svg width="46" height="12" viewBox="0 0 46 12" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="7" width="2.5" height="5" rx="0.8"/><rect x="4.5" y="5" width="2.5" height="7" rx="0.8"/><rect x="9" y="2.5" width="2.5" height="9.5" rx="0.8"/><rect x="13.5" y="0.5" width="2.5" height="11.5" rx="0.8"/><path d="M25.5 3.5a7 7 0 0 1 5 2.1l-1.2 1.2a5.3 5.3 0 0 0-7.6 0l-1.2-1.2a7 7 0 0 1 5-2.1z"/><path d="M25.5 6.9a3.6 3.6 0 0 1 2.6 1.1l-2.6 2.6-2.6-2.6a3.6 3.6 0 0 1 2.6-1.1z"/><rect x="34" y="1.5" width="10" height="9" rx="2.4" fill="none" stroke="currentColor"/><rect x="35.4" y="2.9" width="6" height="6.2" rx="1.2"/><path d="M45 4.5v3a1.7 1.7 0 0 0 0-3z"/></svg>`;

function mobileChromeCss() {
	return `
/* Harness-only iOS dressing: status bar, view header, home indicator. */
.sfsc-harness-statusbar { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 14px 28px 6px; font-size: 15px; font-weight: 600; color: var(--text-normal); background-color: var(--background-primary); }
.sfsc-harness-viewheader { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; position: relative; padding: 6px 44px 8px; background-color: var(--background-primary); }
.sfsc-harness-viewheader .back { position: absolute; left: 14px; display: flex; color: var(--text-muted); }
.sfsc-harness-viewheader .title { font-size: 16px; font-weight: 600; color: var(--text-normal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sfsc-harness-viewheader .more { position: absolute; right: 14px; display: flex; color: var(--text-muted); }
.sfsc-harness-homebar { flex: 0 0 auto; display: flex; justify-content: center; padding: 8px 0 8px; background-color: var(--background-primary); }
.sfsc-harness-homebar::after { content: ""; width: 134px; height: 5px; border-radius: 3px; background-color: var(--text-normal); opacity: 0.9; }
/* A fixed iPhone-sized stage: headless Chrome clamps windows to ~500px wide, so the
   page centers a real 390x844 phone screen instead — screenshot, then crop to it. */
.sfsc-harness-phone { width: 390px; height: 844px; margin: 0 auto; overflow: hidden; display: flex; flex-direction: column; background-color: var(--background-primary); }
.sfsc-harness-phone .workspace-leaf-content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
`;
}

const BACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
const MORE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;

function pageHtml(layout, { withMenu = false, mode = "default", background = null } = {}) {
	const view = `<div class="workspace-leaf-content" data-type="section-cards-view">
<div class="view-content section-cards-view is-layout-${layout}${mode === "hier" ? " is-hier-on" : ""}${background ? " has-sfsc-bg" : ""}"${background ? ` style="--sfsc-bg-image: url('${background}.svg')"` : ""}>
${toolbarHtml(layout, mode)}
${gridHtml(layout, mode)}
</div>
</div>`;
	const desktopShell = `<div class="app-container"><div class="horizontal-main-container"><div class="workspace">
<div class="workspace-split mod-root mod-vertical"><div class="workspace-tabs mod-top mod-active">
<div class="workspace-tab-header-container">
	<div class="workspace-tab-header-container-inner">
		<div class="workspace-tab-header tappable is-active mod-active">
			<div class="workspace-tab-header-inner">
				<div class="workspace-tab-header-inner-icon">${DECK_ICON}</div>
				<div class="workspace-tab-header-inner-title">Cards: ${esc(path.basename(notePath, ".md"))}</div>
			</div>
		</div>
	</div>
	<div class="workspace-tab-header-spacer"></div>
</div>
<div class="workspace-tab-container">
<div class="workspace-leaf mod-active">${view}</div></div></div></div></div></div></div>`;
	const phoneShell = `<div class="sfsc-harness-phone">
<div class="sfsc-harness-statusbar"><span>9:41</span><span>${STATUS_ICONS}</span></div>
<div class="sfsc-harness-viewheader"><span class="back">${BACK_ICON}</span><span class="title">${esc(path.basename(notePath, ".md"))}</span><span class="more">${MORE_ICON}</span></div>
${view}
<div class="sfsc-harness-homebar"></div>
</div>`;
	return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="styles.css">
<style>
/* Harness-only: the real app sizes the workspace chain via JS we don't reproduce. */
html, body { height: 100%; margin: 0; }
.app-container, .horizontal-main-container, .workspace { height: 100%; display: flex; flex-direction: column; }
.workspace-split.mod-root { flex: 1 1 auto; min-height: 0; display: flex; }
.workspace-tabs { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.workspace-tab-container { flex: 1 1 auto; min-height: 0; display: flex; }
.workspace-leaf { flex: 1 1 auto; min-width: 0; display: flex; }
.workspace-leaf-content { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
${MOBILE ? mobileChromeCss() : ""}
</style>
</head>
<body class="${MOBILE ? "theme-dark mod-ios is-mobile is-phone is-ios" : "theme-dark mod-windows"} is-focused preset-default bg-auto no-animation disable-splash-screen">
${MOBILE ? phoneShell : desktopShell}
${withMenu ? menuHtml() : ""}
${PACK_SCRIPT.replace("<script>", `<script data-layout="${layout}">`)}
${withMenu ? MENU_SCRIPT : ""}
</body></html>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(path.join(here, "..", "styles.css"), path.join(OUT_DIR, "styles.css"));
if (!fs.existsSync(path.join(OUT_DIR, "theme.css"))) fs.writeFileSync(path.join(OUT_DIR, "theme.css"), "");
for (const [name, palette] of Object.entries(BG_PALETTES)) {
	fs.writeFileSync(path.join(OUT_DIR, `${name}.svg`), backgroundSvg(palette));
}
for (const layout of Object.keys(LAYOUT_LABELS)) {
	fs.writeFileSync(path.join(OUT_DIR, `${layout}.html`), pageHtml(layout, { background: pageBackground(layout) }));
}
// The two grouping view modes, staged on the Grid layout (HIER_LAYOUT overrides).
const hierLayout = process.env.HIER_LAYOUT ?? "grid";
fs.writeFileSync(
	path.join(OUT_DIR, "hierarchy.html"),
	pageHtml(hierLayout, { mode: "hier", background: pageBackground("hierarchy") }),
);
fs.writeFileSync(
	path.join(OUT_DIR, "dividers.html"),
	pageHtml(hierLayout, { mode: "sections", background: pageBackground("dividers") }),
);
fs.writeFileSync(
	path.join(OUT_DIR, "context-menu.html"),
	pageHtml("grid", { withMenu: true, background: pageBackground("context-menu") }),
);
console.log("wrote", Object.keys(LAYOUT_LABELS).length + 3, "pages to", OUT_DIR, "with", sections.length, "cards");
