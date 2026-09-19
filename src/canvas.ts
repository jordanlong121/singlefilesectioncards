// The canvases (Custom Grid, Images, Links): rectangles, snapping, and link extraction.

import type { PerFileView } from "./settings";



/**
 * Which existing cards a re-render can keep. Cards are matched to sections by exact raw
 * text, FIFO for duplicates; the result maps each next-section index to the previous card
 * index it can reuse, or -1 when it must be built. Reuse means an edit to one section
 * re-renders one card instead of the whole wall.
 */
/** A box as getBoundingClientRect reports it. */
export interface Box {
	top: number;
	bottom: number;
	left: number;
	right: number;
	width: number;
	height: number;
}

/**
 * Which of `rects` (card boxes, in document order) to render next: up to `n` that lie
 * within one viewport of `view` in any direction, in order — else the first `n`. Empty
 * boxes are hidden cards and never count as near. Returns ascending indexes.
 */
export function pickNearViewport(rects: Box[], view: Box, n: number): number[] {
	const pad = Math.max(view.height, view.width);
	const near: number[] = [];
	for (let i = 0; i < rects.length && near.length < n; i++) {
		const r = rects[i];
		if (r.width === 0 && r.height === 0) continue;
		if (r.bottom >= view.top - pad && r.top <= view.bottom + pad && r.right >= view.left - pad && r.left <= view.right + pad) {
			near.push(i);
		}
	}
	if (near.length) return near;
	return Array.from({ length: Math.min(n, rects.length) }, (_, i) => i);
}

/** A card's placement on the Custom Grid canvas, in px. */
export interface CardRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Canvas geometry: snap step matches the dot pattern; sizes are multiples of it. */
export const CUSTOM_SNAP = 24;

/** Required clearance between placed items. Zero: they may sit flush on the grid
 * (the snap already keeps them a whole cell apart otherwise); only real overlap
 * counts as a collision. */
export const CUSTOM_GAP = 0;

export const CUSTOM_MIN_W = 192;

export const CUSTOM_MIN_H = 120;

export const CUSTOM_DEFAULT_W = 288;

export const CUSTOM_DEFAULT_H = 192;

/** Images canvas: previews may shrink well below card size (a thumbnail row, say). */
export const IMAGE_MIN_W = 96;

export const IMAGE_MIN_H = 72;

export const IMAGE_DEFAULT_W = 288;

/** A fresh drop sizes itself to the image's aspect ratio, capped so a tall
 * screenshot doesn't land as a full-column monolith. */
export const IMAGE_DEFAULT_MAX_H = 480;

/** File extensions the Images layout treats as previewable images and videos. */
export const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|m4v)$/i;

/** One image link found in the note, in document order. `target` is the raw link
 * destination: a vault linkpath for embeds, a URL or data: URI for external ones. */
export interface ImageLink {
	target: string;
	external: boolean;
}

/** An image link plus where its full markup sits in the note, for surgical removal. */
export interface ImageLinkSpan extends ImageLink {
	start: number;
	end: number;
}

/** External here means "renderable as-is, no vault resolution": a URL or data: URI. */
export const EXTERNAL_SRC = /^(https?:\/\/|data:)/i;

/**
 * Every image or video the note links, in order of first appearance: wiki embeds
 * (`![[shot.png]]`, with optional `#block` and `|size` suffixes), markdown images
 * (`![alt](path "title")`, angle-bracketed paths and data: URIs included), and HTML
 * `<img>` tags. Wiki embeds of notes/PDFs are filtered later, at resolution — here
 * only markdown/HTML paths are screened, because an unresolvable URL never gets
 * another chance.
 */
export function imageLinkSpans(content: string): ImageLinkSpan[] {
	const found: ImageLinkSpan[] = [];
	// exec loops rather than matchAll: the tsconfig's ES2019 lib has no matchAll,
	// whose any-typed matches tripped the plugin review's no-unsafe-* lints.
	const wiki = /!\[\[([^\][|#\n]+)(?:#[^\][|\n]*)?(?:\|[^\][\n]*)?\]\]/g;
	const md = /!\[[^\]\n]*\]\(\s*(?:<([^<>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g;
	const htmlImg = /<img\s[^>]*?src\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s>'"]+))[^>]*>/gi;
	for (let m = wiki.exec(content); m !== null; m = wiki.exec(content)) {
		found.push({ start: m.index, end: m.index + m[0].length, target: m[1].trim(), external: false });
	}
	const pathLike = (m: { index: number; 0: string }, target: string) => {
		if (!target) return;
		const external = EXTERNAL_SRC.test(target);
		const path = target.split("#")[0];
		if (!external && !IMAGE_EXT.test(path) && !VIDEO_EXT.test(path)) return;
		found.push({ start: m.index, end: m.index + m[0].length, target, external });
	};
	for (let m = md.exec(content); m !== null; m = md.exec(content)) {
		pathLike(m, (m[1] ?? m[2] ?? "").trim());
	}
	for (let m = htmlImg.exec(content); m !== null; m = htmlImg.exec(content)) {
		pathLike(m, (m[1] ?? m[2] ?? m[3] ?? "").trim());
	}
	return found.sort((a, b) => a.start - b.start);
}

export function imageLinksIn(content: string): ImageLink[] {
	return imageLinkSpans(content).map(({ target, external }) => ({ target, external }));
}

/** Links canvas: page previews start portrait-ish, like a browser window. */
export const LINK_DEFAULT_W = 288;

export const LINK_DEFAULT_H = 336;

/** One web link found in the note: the URL and the best display name for it. */
export interface UrlLink {
	url: string;
	label: string;
}

/** Punctuation a sentence hangs on a bare URL's tail without belonging to it. */
export const URL_TRAILING = /[)\],.;:!?'"<>]+$/;

/**
 * Every http(s) link the note carries, in order of first appearance and deduped by
 * URL: markdown links (`[label](url)` — their label wins) and bare/autolinked URLs.
 * URLs already embedded as media (`![](url)`, `<img src>`) belong to the Images
 * canvas and are skipped here.
 */
export function urlLinksIn(content: string): UrlLink[] {
	const media = new Set(imageLinkSpans(content).flatMap((s) => (s.external ? [s.target] : [])));
	const found: { index: number; url: string; label: string }[] = [];
	const seen = new Set<string>();
	const push = (index: number, rawUrl: string, label: string) => {
		const url = rawUrl.replace(URL_TRAILING, "");
		if (!url || seen.has(url) || media.has(url)) return;
		seen.add(url);
		let name = label.trim();
		if (!name) {
			try {
				const parsed = new URL(url);
				name = parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
			} catch {
				name = url;
			}
		}
		found.push({ index, url, label: name });
	};
	// Markdown links first, so their labels win over the bare-URL sweep below.
	const md = /(^|[^!])\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)[^)\n]*\)/g;
	for (let m = md.exec(content); m !== null; m = md.exec(content)) {
		push(m.index, m[3], m[2]);
	}
	const bare = /https?:\/\/[^\s<>()[\]"']+/g;
	for (let m = bare.exec(content); m !== null; m = bare.exec(content)) {
		push(m.index, m[0], "");
	}
	return found.sort((a, b) => a.index - b.index).map(({ url, label }) => ({ url, label }));
}

/** A short stable digest for keying data: URIs — storing the URI itself as a
 * placement key would copy the whole image into the plugin's data file. */
export function shortHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

/** A resolved image or video for the Images canvas: a stable placement key (vault
 * path, URL, or data-URI digest), a renderable src, and the name the tray and drag
 * ghost show. */
export interface NoteImage {
	key: string;
	src: string;
	label: string;
	kind: "image" | "video";
}

/** Round a rect onto the snap grid, clamped to the canvas and the minimum card size. */
export function snapRect(rect: CardRect, step: number, minW: number, minH: number): CardRect {
	const snap = (value: number) => Math.round(value / step) * step;
	return {
		x: Math.max(0, snap(rect.x)),
		y: Math.max(0, snap(rect.y)),
		w: Math.max(minW, snap(rect.w)),
		h: Math.max(minH, snap(rect.h)),
	};
}

/** Cards on the canvas may neither overlap nor touch: `gap` px of air is required. */
/** True when the rects overlap or come within `gap` px of each other; with a gap of 0,
 * edge-to-edge touching is allowed and only genuine overlap collides. */
export function rectsCollide(a: CardRect, b: CardRect, gap: number): boolean {
	return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * The nearest legal spot at or below the requested position: the rect marches down in
 * gap-sized steps until it clears every other card, falling back to below the lowest one.
 */
export function findFreeSpot(want: CardRect, others: CardRect[], gap: number, step = gap): CardRect {
	if (step <= 0) step = CUSTOM_SNAP; // a zero gap must still make progress
	const spot: CardRect = { ...want, x: Math.max(0, Math.round(want.x)), y: Math.max(0, Math.round(want.y)) };
	for (let i = 0; i < 4000; i++) {
		if (!others.some((other) => rectsCollide(spot, other, gap))) return spot;
		spot.y += step;
	}
	const bottom = others.reduce((max, other) => Math.max(max, other.y + other.h), 0);
	return { ...spot, y: bottom + step };
}

/**
 * A Custom Grid arrangement saved under a name (tray → save): the placements and
 * zoom, and the background as it was — so switching to it brings the look back too.
 * Absent background fields mean "no background" and clear the note's on apply.
 */
export interface SavedCanvasLayout {
	customGrid: Record<string, CardRect>;
	customZoom?: number;
	backgroundImage?: string;
	backgroundDim?: number;
	backgroundBrightness?: number;
	backgroundSaturation?: number;
	savedAt: number;
}

/** The note's current arrangement and background as a saved layout (deep-copied). */
export function snapshotCanvasLayout(entry: PerFileView, now = Date.now()): SavedCanvasLayout {
	const out: SavedCanvasLayout = { customGrid: {}, savedAt: now };
	for (const [key, r] of Object.entries(entry.customGrid ?? {})) out.customGrid[key] = { x: r.x, y: r.y, w: r.w, h: r.h };
	if (entry.customZoom !== undefined) out.customZoom = entry.customZoom;
	if (entry.backgroundImage !== undefined) out.backgroundImage = entry.backgroundImage;
	if (entry.backgroundDim !== undefined) out.backgroundDim = entry.backgroundDim;
	if (entry.backgroundBrightness !== undefined) out.backgroundBrightness = entry.backgroundBrightness;
	if (entry.backgroundSaturation !== undefined) out.backgroundSaturation = entry.backgroundSaturation;
	return out;
}

/** Put a saved layout onto the note: placements and zoom replaced, background fields
 * set or cleared to match. Copies, so later drags don't edit the saved layout. */
export function applyCanvasLayout(entry: PerFileView, saved: SavedCanvasLayout): void {
	entry.customGrid = {};
	for (const [key, r] of Object.entries(saved.customGrid)) entry.customGrid[key] = { x: r.x, y: r.y, w: r.w, h: r.h };
	if (saved.customZoom !== undefined) entry.customZoom = saved.customZoom;
	else delete entry.customZoom;
	if (saved.backgroundImage !== undefined) entry.backgroundImage = saved.backgroundImage;
	else delete entry.backgroundImage;
	if (saved.backgroundDim !== undefined) entry.backgroundDim = saved.backgroundDim;
	else delete entry.backgroundDim;
	if (saved.backgroundBrightness !== undefined) entry.backgroundBrightness = saved.backgroundBrightness;
	else delete entry.backgroundBrightness;
	if (saved.backgroundSaturation !== undefined) entry.backgroundSaturation = saved.backgroundSaturation;
	else delete entry.backgroundSaturation;
}

/** Whether two layouts arrange and dress the canvas the same (savedAt aside). */
export function canvasLayoutEquals(a: SavedCanvasLayout, b: SavedCanvasLayout): boolean {
	const ak = Object.keys(a.customGrid);
	const bk = Object.keys(b.customGrid);
	if (ak.length !== bk.length) return false;
	for (const key of ak) {
		const r = a.customGrid[key];
		const s = b.customGrid[key];
		if (!s || r.x !== s.x || r.y !== s.y || r.w !== s.w || r.h !== s.h) return false;
	}
	return (
		(a.customZoom ?? 1) === (b.customZoom ?? 1) &&
		a.backgroundImage === b.backgroundImage &&
		a.backgroundDim === b.backgroundDim &&
		a.backgroundBrightness === b.backgroundBrightness &&
		a.backgroundSaturation === b.backgroundSaturation
	);
}
