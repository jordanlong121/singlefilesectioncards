// Undo and redo for the cards' writes to a note. Every card operation goes through
// processNote, which reports the note's text before and after to a recorder; the
// plugin keeps a NoteHistory of those changes, per note. An undo puts the "before"
// text back only while the note still reads exactly as the change left it — an edit
// from elsewhere in between (the editor, another plugin, sync) makes it refuse.

import { App, TFile } from "obsidian";

/** Called after a write that changed a note, with its text before and after. */
export type NoteRecorder = (file: TFile, before: string, after: string, label: string, key?: string) => void;

let recorder: NoteRecorder | null = null;

/** Install (or with null, remove) the recorder every processNote write reports to. */
export function setNoteRecorder(next: NoteRecorder | null): void {
	recorder = next;
}

/**
 * app.vault.process, reporting the change to the recorder under `label` (what the
 * Undo item says: "Undo Move card"). Writes with the same `key` a moment apart — the
 * saves of one card edit — merge into one undo step. A write that changes nothing
 * isn't recorded.
 */
export async function processNote(app: App, file: TFile, label: string, fn: (data: string) => string, key?: string): Promise<string> {
	let before: string | null = null;
	let after = "";
	const out = await app.vault.process(file, (data) => {
		before = data;
		after = fn(data);
		return after;
	});
	if (recorder && before !== null && before !== after) recorder(file, before, after, label, key);
	return out;
}

export interface NoteChange {
	label: string;
	before: string;
	after: string;
	key?: string;
	/** When it was recorded (ms), for merging a key's writes. */
	at: number;
}

/** How long apart two writes with the same key can be and still merge. */
export const MERGE_WINDOW_MS = 60_000;

/** Per-note undo and redo stacks, bounded in steps and in total text kept. */
export class NoteHistory {
	private undos = new Map<string, NoteChange[]>();
	private redos = new Map<string, NoteChange[]>();

	constructor(
		readonly maxSteps = 30,
		readonly maxChars = 20_000_000,
	) {}

	record(path: string, before: string, after: string, label: string, key?: string, now = Date.now()): void {
		const stack = this.undos.get(path) ?? [];
		const top = stack[stack.length - 1];
		if (key && top && top.key === key && top.after === before && now - top.at < MERGE_WINDOW_MS) {
			top.after = after;
			top.at = now;
			if (top.after === top.before) stack.pop();
		} else {
			stack.push({ label, before, after, key, at: now });
		}
		this.undos.set(path, stack);
		this.redos.delete(path);
		this.trim(path);
	}

	/** The change the next undo would reverse, if any. */
	peekUndo(path: string): NoteChange | null {
		const s = this.undos.get(path);
		return s?.length ? s[s.length - 1] : null;
	}

	/** The change the next redo would repeat, if any. */
	peekRedo(path: string): NoteChange | null {
		const s = this.redos.get(path);
		return s?.length ? s[s.length - 1] : null;
	}

	/**
	 * Step back: given the note's current text, the text to write instead — or
	 * "changed" when the note no longer reads as the last change left it (the stacks
	 * for it are dropped: nothing older can be undone safely), or null with nothing to undo.
	 */
	undo(path: string, current: string): { change: NoteChange; text: string } | "changed" | null {
		return this.step(path, current, this.undos, this.redos, "after", "before");
	}

	/** Step forward again; the mirror of undo. */
	redo(path: string, current: string): { change: NoteChange; text: string } | "changed" | null {
		return this.step(path, current, this.redos, this.undos, "before", "after");
	}

	/** Keep a renamed note's history. */
	rename(from: string, to: string): void {
		for (const map of [this.undos, this.redos]) {
			const s = map.get(from);
			if (!s) continue;
			map.delete(from);
			map.set(to, s);
		}
	}

	forget(path: string): void {
		this.undos.delete(path);
		this.redos.delete(path);
	}

	private step(
		path: string,
		current: string,
		from: Map<string, NoteChange[]>,
		to: Map<string, NoteChange[]>,
		expect: "before" | "after",
		write: "before" | "after",
	): { change: NoteChange; text: string } | "changed" | null {
		const stack = from.get(path);
		const change = stack?.[stack.length - 1];
		if (!stack || !change) return null;
		if (current !== change[expect]) {
			this.forget(path);
			return "changed";
		}
		stack.pop();
		const other = to.get(path) ?? [];
		other.push({ ...change, key: undefined });
		to.set(path, other);
		return { change, text: change[write] };
	}

	/** Drop the oldest steps past the limits (the newest always stays). */
	private trim(path: string): void {
		const stack = this.undos.get(path);
		if (!stack) return;
		while (stack.length > this.maxSteps) stack.shift();
		let total = 0;
		for (const map of [this.undos, this.redos]) for (const s of map.values()) for (const c of s) total += c.before.length + c.after.length;
		while (total > this.maxChars && stack.length > 1) {
			const old = stack.shift();
			if (old) total -= old.before.length + old.after.length;
		}
	}
}
