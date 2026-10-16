/**
 * The Table layout's model: the whole note as an outline of headings, then as the rows
 * of a table — one row per heading, a parent's cell spanning its sub-headings' rows,
 * and each heading's own text in one cell. Pure functions over the note's lines; the
 * view renders the rows and writes an edited cell back by its line range.
 */

import { HEADING_RE, stepFence } from "./sections";

/** One heading of the note, with its own text and the headings nested under it. */
export interface TableNode {
	title: string;
	/** The heading's rank: the number of #'s. */
	level: number;
	headingLine: number;
	/** [textStart, textEnd) are the heading's own lines — after it and before the next
	 * heading of any rank — with trailing blank lines left out. Equal when it has none. */
	textStart: number;
	textEnd: number;
	children: TableNode[];
}

export interface TableOutline {
	/** Text above the first heading (the properties block aside), or null when none. */
	preamble: { textStart: number; textEnd: number } | null;
	roots: TableNode[];
	/** How deep the nesting goes: 1 with only top-level headings, 0 with none. */
	depth: number;
}

/**
 * Reads the note's headings into a tree. Nesting follows rank the way an outline does:
 * a heading nests under the nearest heading above it of a smaller rank, so an H3 right
 * under an H1 is that H1's child (the missing H2 costs no column).
 */
export function parseTableOutline(lines: string[]): TableOutline {
	const heads: { line: number; level: number; title: string }[] = [];
	let fence: string | null = null;
	let inFrontmatter = false;
	let beforeContent = true;
	let contentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (beforeContent) {
			if (line.trim() === "") continue;
			beforeContent = false;
			contentStart = i;
			if (line.trim() === "---") {
				inFrontmatter = true;
				continue;
			}
		}
		if (inFrontmatter) {
			if (line.trim() === "---") {
				inFrontmatter = false;
				contentStart = i + 1;
			}
			continue;
		}
		const c0 = line.charCodeAt(0);
		if (c0 === 96 || c0 === 126 || c0 === 32 || c0 === 9) {
			const step = stepFence(line, fence);
			fence = step.open;
			if (step.marker) continue;
		}
		if (fence || c0 !== 35) continue;
		const match = HEADING_RE.exec(line);
		if (!match) continue;
		heads.push({ line: i, level: match[1].length, title: match[2].trim() });
	}

	const trimmedEnd = (start: number, end: number): number => {
		while (end > start && lines[end - 1].trim() === "") end--;
		return end;
	};

	const roots: TableNode[] = [];
	const stack: TableNode[] = [];
	let depth = 0;
	for (let h = 0; h < heads.length; h++) {
		const head = heads[h];
		const nextLine = h + 1 < heads.length ? heads[h + 1].line : lines.length;
		const node: TableNode = {
			title: head.title,
			level: head.level,
			headingLine: head.line,
			textStart: head.line + 1,
			textEnd: trimmedEnd(head.line + 1, nextLine),
			children: [],
		};
		while (stack.length && stack[stack.length - 1].level >= head.level) stack.pop();
		if (stack.length) stack[stack.length - 1].children.push(node);
		else roots.push(node);
		stack.push(node);
		if (stack.length > depth) depth = stack.length;
	}

	const firstHeading = heads.length ? heads[0].line : lines.length;
	const preEnd = trimmedEnd(contentStart, firstHeading);
	let preStart = contentStart;
	while (preStart < preEnd && lines[preStart].trim() === "") preStart++;
	const preamble = preStart < preEnd ? { textStart: preStart, textEnd: preEnd } : null;

	return { preamble, roots, depth };
}

export interface TableCell {
	/** heading: a heading's name; text: a heading's own lines (editable); pad: the blank
	 * heading columns beside a parent's own text row; preamble: the no-heading label. */
	kind: "heading" | "text" | "pad" | "preamble";
	text: string;
	rowSpan: number;
	colSpan: number;
	/** The heading the cell belongs to (none for the preamble's cells). */
	node?: TableNode;
	/** Text cells: the lines the cell shows, [start, end). */
	range?: [number, number];
}

export interface TableRow {
	cells: TableCell[];
}

/**
 * Lays the outline out as rows. A heading without sub-headings is one row: its name
 * (spanning the heading columns it doesn't use), then its text. A heading with
 * sub-headings spans their rows — plus one of its own first, when it has text of its
 * own above them. Text above the first heading comes first, under a label.
 */
export function tableRows(outline: TableOutline, lines: string[]): TableRow[] {
	const columns = Math.max(outline.depth, 1);
	const textOf = (start: number, end: number) => lines.slice(start, end).join("\n");
	const textCell = (node: TableNode | undefined, start: number, end: number): TableCell => ({
		kind: "text",
		text: textOf(start, end),
		rowSpan: 1,
		colSpan: 1,
		node,
		range: [start, end],
	});

	const rowsOf = (node: TableNode, col: number): TableRow[] => {
		const spare = columns - col; // heading columns from this one to the text column
		if (!node.children.length) {
			return [
				{
					cells: [
						{ kind: "heading", text: node.title, rowSpan: 1, colSpan: spare, node },
						textCell(node, node.textStart, node.textEnd),
					],
				},
			];
		}
		const rows: TableRow[] = [];
		if (node.textEnd > node.textStart) {
			const cells: TableCell[] = [];
			if (spare > 1) cells.push({ kind: "pad", text: "", rowSpan: 1, colSpan: spare - 1, node });
			cells.push(textCell(node, node.textStart, node.textEnd));
			rows.push({ cells });
		}
		for (const child of node.children) rows.push(...rowsOf(child, col + 1));
		rows[0].cells.unshift({ kind: "heading", text: node.title, rowSpan: rows.length, colSpan: 1, node });
		return rows;
	};

	const rows: TableRow[] = [];
	if (outline.preamble) {
		const { textStart, textEnd } = outline.preamble;
		rows.push({
			cells: [
				{ kind: "preamble", text: "", rowSpan: 1, colSpan: columns },
				textCell(undefined, textStart, textEnd),
			],
		});
	}
	for (const root of outline.roots) rows.push(...rowsOf(root, 0));
	return rows;
}

/** A cell's one-line reading of its text: blank lines dropped, the rest joined with a
 * dot, runs of whitespace closed up. The cell clips it with an ellipsis. */
export function tableLineText(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "")
		.join(" · ");
}
