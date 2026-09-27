// Nesting a card into another: the dragged card becomes a section of the target, one
// heading level down, at a section boundary near where it was dropped.

import { HEADING_RE } from "./sections";

/** Walk lines, calling `each` for every line outside fenced code with its heading
 * level (0 for a non-heading line). */
function eachUnfenced(lines: string[], each: (i: number, level: number) => void): void {
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const open = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		const h = HEADING_RE.exec(lines[i]);
		each(i, h ? h[1].length : 0);
	}
}

/**
 * A card's lines (its heading and body) demoted one level to sit inside another card:
 * its heading and every heading within it gain a `#`, fenced code untouched. Null when
 * any heading is already H6 — there's no H7 to move it to.
 */
export function demoteSection(lines: string[]): string[] | null {
	const out = lines.slice();
	let tooDeep = false;
	eachUnfenced(lines, (i, level) => {
		if (!level) return;
		if (level >= 6) tooDeep = true;
		else out[i] = `#${lines[i]}`;
	});
	return tooDeep ? null : out;
}

/**
 * Where a section at `level` can go in a card's body without taking text that isn't its
 * own: a heading owns every line below it up to the next heading at its level or above,
 * so the only places a new one can start are just before such a heading — and at the end
 * of the card's front (before a Card Flip marker at `frontEnd`). Body line indexes,
 * ascending; the last is always the front's end.
 */
export function nestBoundaries(body: string[], level: number, frontEnd: number = body.length): number[] {
	const out: number[] = [];
	eachUnfenced(body.slice(0, frontEnd), (i, headingLevel) => {
		if (headingLevel && headingLevel <= level) out.push(i);
	});
	out.push(frontEnd);
	return out;
}

/** The boundary a drop just before body line `dropLine` lands on: the first at or after
 * it — the new section goes after the text it was dropped into, not through it. */
export function nestInsertLine(boundaries: number[], dropLine: number): number {
	return boundaries.find((b) => b >= dropLine) ?? boundaries[boundaries.length - 1];
}

/**
 * Splice `block` (demoted section lines) into `lines` at `at`, keeping a blank line
 * between it and non-blank text on either side, and none doubled.
 */
export function spliceSection(lines: string[], at: number, block: string[]): string[] {
	const body = block.slice();
	while (body.length && body[body.length - 1].trim() === "") body.pop();
	const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
	const after = at < lines.length && lines[at].trim() !== "" ? [""] : [];
	return [...lines.slice(0, at), ...before, ...body, ...after, ...lines.slice(at)];
}
