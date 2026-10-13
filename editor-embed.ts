/**
 * Live-preview card editing via Obsidian's internal embeddable markdown editor — the
 * same widget Canvas cards use. That class is not part of the public plugin API, so it
 * is resolved at runtime through the embed registry's prototype chain, the technique
 * shared by Kanban, Meta Bind, and other community plugins (credit to mgmeyers and
 * Fevol). Everything here is defensive: if any step fails on a future Obsidian
 * version, createEmbeddedEditor returns null and the caller falls back to the plain
 * textarea editor, which depends on nothing internal.
 */

import { App, MarkdownView, type TFile } from "obsidian";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";

export interface EmbeddedEditorOptions {
	value: string;
	/** The note the text belongs to: editor commands that act on "the file under the
	 * cursor" (the Tasks plugin's create/edit and toggle) need one to act at all. */
	file?: TFile;
	/** Live preview renders markdown as you type; source shows it with highlighting. */
	mode: "live" | "source";
	/** Mod+Enter inside the editor. */
	onSave: () => void;
	/** Escape inside the editor — the caller decides whether that discards or asks first. */
	onCancel: () => void;
	/** Mod+T inside the editor (the caller opens the Tasks plugin's create dialog). */
	onTask?: () => void;
	/** The document changed — the caller re-measures card layout. */
	onChange: () => void;
}

/** The slice of the editor the card code is allowed to touch. */
export interface EmbeddedEditor {
	readonly value: string;
	/** Return focus to the editor, leaving the cursor where it was. */
	focus(): void;
	/** Put `text` on its own line at the cursor: onto the current line if it's blank,
	 * else on a new line below it; the cursor lands at the end of the insert. */
	insertLine(text: string): void;
	focusEnd(): void;
	destroy(): void;
}

/** The runtime shape this file relies on. Undocumented, hence the fallback paths. */
interface InternalEditor {
	editor: { cm: EditorView };
	owner: { editMode: unknown; editor: unknown };
	/** The editor's own live-preview switch: its constructor seeds it from the vault's
	 * Live Preview config, and the first set() builds the CodeMirror state from it. */
	sourceMode: boolean;
	set(value: string, clear?: boolean): void;
	unload(): void;
	destroy(): void;
	_loaded?: boolean;
	buildLocalExtensions(): Extension[];
}

type InternalEditorCtor = new (app: App, container: HTMLElement, owner: unknown) => InternalEditor;

interface MarkdownEmbedWidget {
	editable: boolean;
	showEditor(): void;
	editMode?: unknown;
	unload(): void;
}

type EmbedFactory = (
	info: { app: App; containerEl: HTMLElement },
	file: null,
	subpath: string,
) => MarkdownEmbedWidget;

/** undefined = not yet attempted; null = attempted and unavailable this session. */
let resolvedCtor: InternalEditorCtor | null | undefined;

/**
 * Digs Obsidian's MarkdownEditor class out of a throwaway markdown embed: the embed's
 * edit mode is an instance of a subclass, so the class sits two prototypes up.
 */
function resolveEditorClass(app: App): InternalEditorCtor | null {
	if (resolvedCtor !== undefined) return resolvedCtor;
	resolvedCtor = null;
	try {
		const registry = (app as unknown as { embedRegistry?: { embedByExtension?: Record<string, unknown> } })
			.embedRegistry;
		const factory = registry?.embedByExtension?.["md"] as EmbedFactory | undefined;
		if (typeof factory !== "function") return null;
		const widget = factory({ app, containerEl: createDiv() }, null, "");
		widget.editable = true;
		widget.showEditor();
		const editMode = widget.editMode;
		if (!editMode) {
			widget.unload();
			return null;
		}
		const proto = Object.getPrototypeOf(Object.getPrototypeOf(editMode)) as { constructor?: unknown } | null;
		widget.unload();
		if (typeof proto?.constructor === "function") resolvedCtor = proto.constructor as InternalEditorCtor;
	} catch (error) {
		console.error("Single File Section Cards: live-preview editor unavailable, using plain markdown", error);
	}
	return resolvedCtor;
}

/**
 * Builds a live-preview editor inside `container`, pre-filled with `value`.
 * Returns null when the internal editor can't be resolved or constructed — the
 * caller must then fall back to the textarea editor.
 */
export function createEmbeddedEditor(
	app: App,
	container: HTMLElement,
	options: EmbeddedEditorOptions,
): EmbeddedEditor | null {
	const Base = resolveEditorClass(app);
	if (!Base) return null;
	try {
		class CardMarkdownEditor extends Base {
			buildLocalExtensions(): Extension[] {
				const extensions = super.buildLocalExtensions();
				// Highest precedence: these must beat the editor's own Enter/Escape
				// bindings. Mod+Enter is also caught by the view's keymap scope and a
				// document-level fallback, but only this binding works when a future
				// Obsidian routes key events straight into CodeMirror.
				extensions.push(
					Prec.highest(
						keymap.of([
							{
								key: "Mod-Enter",
								run: () => {
									options.onSave();
									return true;
								},
							},
							{
								key: "Escape",
								run: () => {
									options.onCancel();
									return true;
								},
								preventDefault: true,
							},
							{
								key: "Mod-t",
								run: () => {
									if (!options.onTask) return false;
									options.onTask();
									return true;
								},
								preventDefault: true,
							},
						]),
					),
				);
				extensions.push(
					EditorView.updateListener.of((update: ViewUpdate) => {
						if (update.docChanged) options.onChange();
					}),
				);
				return extensions;
			}
		}

		// The owner mocks the MarkdownView the editor believes it lives in; getMode
		// keeps it in editing mode and onMarkdownScroll satisfies its scroll syncing.
		// `file` only when there is one: an explicit null trips editor suggesters that
		// test for undefined (the Tasks plugin's), while a missing member passes them by.
		const ownerTarget: Record<string, unknown> = {
			app,
			...(options.file ? { file: options.file } : {}),
			onMarkdownScroll: () => {},
			getMode: () => "source",
			getViewType: () => "markdown",
			// Obsidian's editor-command wrapper asks a view whether its title fields have
			// the focus before running a command; detached stand-ins never do.
			titleEl: createDiv(),
			inlineTitleEl: createDiv(),
		};
		// Editor commands from other plugins (the Tasks plugin's create/edit and toggle)
		// act only when the active editor's view `instanceof MarkdownView` and names a
		// file. The proxy answers that check with MarkdownView's prototype while serving
		// only the mock's own members — a real view's methods would reach for a leaf and
		// modes this editor doesn't have, so none of them is inherited. The pose is
		// dropped for the moment the owner is handed to the workspace: its activeEditor
		// setter keeps only what is *not* a MarkdownView (real views it finds by leaf).
		let poseAsView = true;
		const owner = new Proxy(ownerTarget, {
			getPrototypeOf: () => (poseAsView ? MarkdownView.prototype : Object.prototype),
		});
		const editor = new CardMarkdownEditor(app, container, owner);
		// Editor commands (bold, toggle checkbox, …) find their target through
		// workspace.activeEditor.editMode/.editor — point the mock at this instance.
		editor.owner.editMode = editor;
		editor.owner.editor = editor.editor;
		// Pin the mode before set(): the first set() builds the editor state, and the
		// live-preview class, plugin, and state field are all derived from sourceMode.
		editor.sourceMode = options.mode === "source";
		editor.set(options.value, true);

		// While the editor has focus, Obsidian's editor commands should act on it.
		const workspace = app.workspace as unknown as { activeEditor: unknown };
		const onFocusIn = () => {
			poseAsView = false;
			workspace.activeEditor = editor.owner;
			poseAsView = true;
		};
		editor.editor.cm.contentDOM.addEventListener("focusin", onFocusIn);

		let destroyed = false;
		return {
			get value(): string {
				return editor.editor.cm.state.doc.toString();
			},
			focus(): void {
				editor.editor.cm.focus();
			},
			insertLine(text: string): void {
				const cm = editor.editor.cm;
				const line = cm.state.doc.lineAt(cm.state.selection.main.head);
				const blank = line.text.trim() === "";
				const from = blank ? line.from : line.to;
				const insert = blank ? text : "\n" + text;
				cm.dispatch({
					changes: { from, to: blank ? line.to : line.to, insert },
					selection: EditorSelection.cursor(from + insert.length),
					scrollIntoView: true,
				});
				cm.focus();
			},
			focusEnd(): void {
				const cm = editor.editor.cm;
				cm.focus();
				cm.dispatch({
					selection: EditorSelection.cursor(cm.state.doc.length),
					scrollIntoView: true,
				});
			},
			destroy(): void {
				if (destroyed) return;
				destroyed = true;
				editor.editor.cm.contentDOM.removeEventListener("focusin", onFocusIn);
				if (workspace.activeEditor === editor.owner) workspace.activeEditor = null;
				try {
					if (editor._loaded) editor.unload();
					editor.destroy();
				} catch (error) {
					console.error("Single File Section Cards: embedded editor teardown failed", error);
				}
				container.empty();
			},
		};
	} catch (error) {
		console.error("Single File Section Cards: live-preview editor failed, using plain markdown", error);
		return null;
	}
}
