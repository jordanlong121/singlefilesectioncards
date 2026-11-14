// The dashboard sidebar: the Dashboard's panels in a right-side pane, stacked for a
// narrow column, beside whatever layout a cards tab shows. It follows the cards tab
// last in front and redraws whenever that view renders or its note changes on disk.

import { ItemView, debounce, type WorkspaceLeaf } from "obsidian";
import { renderDashboard } from "./dashrender";
import { SectionCardsView } from "./view";
import { VIEW_TYPE_SECTION_CARDS } from "./settings";

export const VIEW_TYPE_DASH_SIDEBAR = "section-cards-dashboard-sidebar";

export class DashSidebarView extends ItemView {
	/** The cards view this pane summarises. */
	private target: SectionCardsView | null = null;
	/** Bumped per draw: a slow read finishing after a newer one started is dropped. */
	private generation = 0;
	/** Many triggers arrive together (a save is a modify plus the view's refresh). */
	private readonly scheduleRender = debounce(() => void this.render(), 150, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_DASH_SIDEBAR;
	}

	getDisplayText(): string {
		return "Card dashboard";
	}

	getIcon(): string {
		return "gauge";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("sc-dash-sidebar");
		const ws = this.app.workspace;
		this.registerEvent(
			ws.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof SectionCardsView) this.follow(leaf.view);
			}),
		);
		// A closed target hands over to another open cards tab.
		this.registerEvent(ws.on("layout-change", () => {
			if (!this.targetAlive()) this.scheduleRender();
		}));
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path === this.target?.dashboardFile()?.path) this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const path = this.target?.dashboardFile()?.path;
				if (path === file.path || path === oldPath) this.scheduleRender();
			}),
		);
		const active = ws.getActiveViewOfType(SectionCardsView);
		this.target = active ?? this.anyCardsView();
		await this.render();
	}

	async onClose(): Promise<void> {
		this.scheduleRender.cancel();
		this.target = null;
	}

	/** Summarise this cards view from now on. */
	follow(view: SectionCardsView): void {
		if (view !== this.target) {
			this.target = view;
			this.contentEl.scrollTop = 0;
		}
		this.scheduleRender();
	}

	/** A cards view rendered: redraw when it's the one followed, or adopt it when
	 * nothing is followed yet. */
	viewChanged(view: SectionCardsView): void {
		if (view === this.target || !this.targetAlive()) this.follow(view);
	}

	private targetAlive(): boolean {
		const target = this.target;
		return !!target && this.app.workspace.getLeavesOfType(VIEW_TYPE_SECTION_CARDS).some((l) => l.view === target);
	}

	private anyCardsView(): SectionCardsView | null {
		const ws = this.app.workspace;
		const recent = ws.getMostRecentLeaf(ws.rootSplit);
		if (recent?.view instanceof SectionCardsView) return recent.view;
		for (const leaf of ws.getLeavesOfType(VIEW_TYPE_SECTION_CARDS)) {
			if (leaf.view instanceof SectionCardsView) return leaf.view;
		}
		return null;
	}

	private async render(): Promise<void> {
		const gen = ++this.generation;
		if (!this.targetAlive()) this.target = this.anyCardsView();
		const ctx = this.target ? await this.target.sidebarDashContext() : null;
		if (gen !== this.generation) return;
		const el = this.contentEl;
		const scroll = el.scrollTop;
		el.empty();
		if (!ctx) {
			const empty = el.createDiv({ cls: "sc-dash-sidebar-empty" });
			empty.createEl("p", { text: this.target ? "Pick a note to see its dashboard." : "Open a note as cards to see its dashboard here." });
			return;
		}
		renderDashboard(el, ctx);
		el.scrollTop = scroll;
	}
}
