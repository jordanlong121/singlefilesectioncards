# Single File Section Cards

An [Obsidian](https://obsidian.md) plugin that shows the sections of **one** note as a wall of
cards — one card per heading — and lets you edit any section in place, writing straight back to
the source `.md` file. With the freeform **Custom Grid** canvas, it doubles as a home for ad hoc
dashboards, sticky notes, task management, and brainstorming — all stored as plain markdown in a
single note.

While this is a standalone plugin that works on any note, it pairs nicely with
[Single File Daily Notes](https://github.com/pranavmangal/obsidian-single-file-daily-notes).
That plugin keeps all your daily notes in a single file, one `### YYYY-MM-DD` heading per
day. This plugin turns those headings into a card wall you can scan, sort, and tick off.

**[Install it from the Obsidian community plugin directory →](https://community.obsidian.md/plugins/single-file-section-cards)**
· [Release notes](https://github.com/jordanlong121/singlefilesectioncards/releases)

## What it does

- **One card per heading.** Pick which level becomes a card (H1–H6); deeper headings stay nested
  inside their parent card. Multiple layouts, sort orders, and per-card colors.
- **Work directly on the cards.** Click a card to edit its markdown, tick task checkboxes (with
  optional `✅` done dates), quick-add a line with the `+` button, create a new card pre-filled
  with today's date, or delete one. Pinned cards stay at the top — on screen by default.
- **Drag and drop.** Reorder cards, or drag a task or paragraph onto another card (sub-items come
  along) — or right-click a line for a menu: move, mark done, or delete.
- **Plays with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin.**
  Ticking a checkbox uses its toggle (recurring tasks recur), and the right-click menu gains its
  create/edit dialogs.
- **Templates and dates.** New cards can start from a template note (`{{title}}`, `{{date}}`,
  `{{time}}`); when headings are dates, a calendar button jumps to any date's card.
- **Navigate as cards.** Wikilinks open the linked note's card wall, ↗ opens the section in a
  normal editor, and a card can be maximized over the others.
- **Keyboard shortcuts.** With a cards view focused and no editor open: `1`–`6` switch the
  heading level, `L` cycles layouts, `H` shows/hides the hierarchy columns, `N` creates a new
  card, and `Ctrl/⌘+F` jumps to the filter box.
- **Writes are surgical.** Only the touched section's lines change, and every write re-locates
  its section by content first, so a stale card refuses rather than touching the wrong lines.

## Layouts

### Vertical

Full-height cards side by side. The row scrolls sideways, and the mouse wheel pans it from anywhere
in the view — over the cards or over the toolbar. A card whose content overflows keeps the wheel
until it reaches its end.

![Vertical](screenshots/vertical.png)

### Custom Grid

A freeform canvas. Drag sections from the tray on the right onto the dot grid, then place, move,
and resize them however you like — cards snap to the grid and never overlap; the ✕ (or a drag back
onto the tray) returns one to the list. Zoom runs 40–160%, middle-click drag pans, and placements
are remembered per note in the plugin's data — never in your notes.

![Custom Grid](screenshots/custom.png)

### Grid

Masonry columns: every card takes only the height it needs, so a short card never leaves dead space
beneath it.

![Grid](screenshots/grid.png)

### Grid Aligned

A uniform grid — every row starts at the same height, with a rule between rows.

![Grid Aligned](screenshots/aligned.png)

### Tight

The same masonry packing, denser: narrower columns, smaller gaps and type. Roughly half the scroll
height of Grid on the same note.

![Tight](screenshots/tight.png)

### Horizontal

One card per row, full pane width.

![Horizontal](screenshots/horizontal.png)

### Hierarchy columns

A toolbar toggle (the tree button), not a layout: drill-down columns appear on the left — one per
heading level above the card level — and the cards pane shows the selected branch in whichever
layout is active (every layout except the Custom Grid canvas). At H3, click an H1 to list its H2s,
click an H2 to see its cards. Each row shows a card count plus a square unfinished-task badge
(toggleable in settings); jump-to-date and new-card creation drill to the right branch on their own.

![Hierarchy](screenshots/hierarchy.png)

## Brainstorming with cards

A single note makes a whole brainstorm: one `###` heading per theme, and the wall becomes your
sticky notes (`sample-vault/Brainstorm.md` is this example). Dump ideas as cards in Grid —
quick-add drops thoughts onto a card without opening an editor, and the filter pulls up "the
card with the satellite thing" instantly:

![Brainstorming in Grid](screenshots/brainstorm-grid.png)

Then switch to Custom Grid and arrange: cluster related themes, size cards by importance, and
leave the "later" cards in the list on the right. Drag tasks between cards as ideas graduate
from *Wild ideas* to *Feature ideas* — everything stays plain markdown in the one note:

![Brainstorming on the Custom Grid canvas](screenshots/brainstorm-custom.png)

## The right-click menu

Right-click a task or paragraph on a card (long-press on mobile) for a menu that works that
line without dragging or opening the editor:

![The right-click menu on a task, with the Tasks plugin installed](screenshots/context-menu.png)

- **Move line to previous / next card** — sends the block to the neighbouring card in the
  current sort order, exactly like dragging it there; a task brings its indented sub-items
  along.
- **Mark done / Mark undone** — ticks or unticks the task where it sits.
- **Delete line** — removes the block (and a task's sub-items) from the section.

The two **(Tasks)…** entries appear when the Tasks plugin is installed — see below.

## Working with the Tasks plugin

When the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin is installed
and enabled, the cards view hands task handling over to it — there's nothing to configure, the
integration switches on by itself:

- **Ticking a checkbox goes through Tasks.** Any checkbox ticked on a card (or via **Mark
  done**) is toggled with Tasks' own toggle, so its semantics apply: a recurring task spawns
  its next occurrence, and done dates follow your Tasks settings. This is the "Toggle tasks
  with the Tasks plugin" setting — on by default; turn it off to keep this plugin's simpler
  built-in toggle.
- **Edit task (Tasks)…** — on a task line, the right-click menu can open the task in Tasks'
  edit dialog for due dates, recurrence, and priority. (Tasks only edits at an editor cursor,
  so this jumps to the line in a normal editor and opens the dialog there.)
- **New task below (Tasks)…** — opens Tasks' create dialog and inserts the finished task line
  right below the clicked block. Right-clicking a card's empty space offers **New task
  (Tasks)…**, which appends the new task to the bottom of that section instead.

Without Tasks installed, the menu simply omits those entries and checkboxes are toggled by this
plugin itself — with the optional `✅ YYYY-MM-DD` completion date from the "Completion date on
tasks" setting.

## Pinned cards

Every card's title bar has a pin button (click again to unpin). Pinning pulls the card into a
pinned section at the top of the wall regardless of sort order, remembered per note across
layouts, views, and restarts. With **Keep pinned cards on screen** (on by default), that section
sticks below the toolbar while the rest scrolls — beside the row in Vertical; not applied on the
Custom Grid canvas. Pins are keyed to the heading line, so renaming a section unpins it.

## Card colors

Every card's title bar has a palette button offering nine colors, which tint the card's border and
title bar in every layout. Colors are remembered per note in the plugin's data — never in your
notes — and are keyed to the heading line, so renaming a section clears its color. The nine slots
are configurable under **Settings → Card colors**: change any color or label, or swap in a preset
palette (Catppuccin Mocha, Nord, Solarized, Gruvbox, Dracula, Pastel); cards keep their slot.

## New-card options, per note

The toolbar button beside **+ New card** holds the open note's new-card options: a template
note, and the note's own heading-name format.

**Heading name.** "Set heading name for this note…" gives the note its own moment date format
for pre-filling new cards (and for recognising date headings), overriding the global "Default
heading name" setting. Leave the prompt empty to go back to the default.

## Templates

A template pre-fills the body of every new card, so a daily-notes file can start each day with
the same skeleton instead of an empty section.

**Set it up.** Open the note in the cards view, click the new-card options button beside
**+ New card**, and "Choose template note…" — any markdown note in the vault works. The choice
is one template per note, stored in the plugin's data (never in your notes), so your daily
notes can use a daily skeleton while a project note uses a different one, or none. "Remove
template" goes back to empty cards, and the button wears the accent color while a template
is set.

**What happens on + New card.** The template note's contents are read at that moment, its
placeholders are filled in, and the result becomes the new section's body — inserted at your
"Default placement" position with the new card opened for editing. If the template note has
been deleted or renamed since you set it, you get a notice and an empty card instead.

**Placeholders.**

| Placeholder | Becomes |
| --- | --- |
| `{{title}}` | The new card's heading text |
| `{{date}}` / `{{date:FORMAT}}` | The date named in the new heading — today if it names none |
| `{{time}}` / `{{time:FORMAT}}` | The current time |

`FORMAT` is a [moment format string](https://momentjs.com/docs/#/displaying/format/), as in
Obsidian's core Templates. Note that `{{date}}` follows the card, not the clock: it reads the
date out of the new card's heading (an ISO date anywhere in it, or the note's heading-name
format), so back-filling a card for last Tuesday writes last Tuesday's date. Only when the
heading names no date does it fall back to today.

**Example.** With this template note:

```markdown
- [ ] Standup notes
- [ ] Review {{date:dddd}}'s plan
- [ ] Shutdown checklist ({{title}})
```

creating the card `2026-08-20, Thursday` produces:

```markdown
### 2026-08-20, Thursday
- [ ] Standup notes
- [ ] Review Thursday's plan
- [ ] Shutdown checklist (2026-08-20, Thursday)
```

## Dates, per note

The toolbar's **Dates** checkbox says whether the open note's headings name dates. It governs
the today-card highlight, the jump-to-today scroll, and the calendar button — per note, not
globally. Until you click it, it decides from the note itself: on when any heading at the
current level contains an ISO date or matches the "Default heading name" format. Click it once
and your choice is remembered for that note.

## Jump to a date

When a note's **Dates** checkbox is on and the note actually has date headings, a calendar
button appears beside the filter box. Pick a date and the view scrolls to that date's card and
flashes it — the same nudge a wikilink arrival gets.

## Usage

- Click the deck-of-cards icon in the ribbon, or run one of the commands:
  - `Single File Section Cards: Open section cards (default note)`
  - `Single File Section Cards: Open section cards for the active note`
  - `Single File Section Cards: Create new card`
- The toolbar button switches notes: your default note, notes you've viewed as cards, and recently
  opened notes lead the list, with the rest of the vault's notes below them — type to search
  everything by name or path.

## Settings

| Setting | What it does |
| --- | --- |
| Default note | Vault-relative path opened by the ribbon icon and command |
| Reopen remembered notes as cards | A note you've viewed as cards before opens in the cards view instead of the editor; a card's ↗ button still reaches the editor (off by default) |
| Heading level | Which heading rank becomes a card (H1–H6) |
| Jump to today's card | Scroll to today's card when a note opens in the view (on by default; needs the note's Dates checkbox) |
| Keep pinned cards on screen | Pinned cards stay on screen while the rest scroll — below the toolbar, or left of the row in Vertical (on by default; not in Custom Grid) |
| Card colors | Each of the nine card colors' RGB value and label, with preset palettes to apply in one pick |
| Default sort | A→Z, Z→A, or document order |
| Default layout | Grid, Grid Aligned, Tight, Horizontal, Vertical, Custom Grid |
| Show open-task counts in Hierarchy columns | Square badge per column row counting the unfinished tasks beneath it (on by default) |
| Default heading name | Date format used to pre-fill "New card" (any note can set its own from the toolbar's new-card options menu) |
| Default placement | Where a new card is inserted |
| Clicking a card's title bar | Makes the card big (default), or edits the raw markdown |
| Autosave open card editors | Write an open editor's content to the note every few minutes, and when the view closes, so an edit left open isn't lost (on by default) |
| Autosave interval | Minutes between autosaves while a card editor is open (default 5) |
| Toggle tasks with the Tasks plugin | Route checkbox ticks through the Tasks plugin when it's installed (recurrence, its done dates) |
| Completion date on tasks | Append `✅ YYYY-MM-DD` when a task is ticked |
| Cross out nested items | Whether ticking a task also strikes through the items nested beneath it |
| Card height | Maximum card height before the body scrolls |

## Install

### From the community plugin directory (recommended)

The plugin is listed in the
[Obsidian community plugin directory](https://community.obsidian.md/plugins/single-file-section-cards):
in Obsidian, open **Settings → Community plugins → Browse**, search for **Single File Section
Cards**, install, and enable. Updates arrive through Obsidian's normal plugin updater.

### With BRAT (pre-release versions)

To track releases straight from this repository — useful for trying fixes before they reach the
directory — add `jordanlong121/singlefilesectioncards` as a beta plugin in
[BRAT](https://github.com/TfTHacker/obsidian42-brat).

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release (or build them, below).
2. Put them in `<vault>/.obsidian/plugins/single-file-section-cards/`.
3. Reload Obsidian, then enable **Single File Section Cards** in Settings → Community plugins.

## Sample vault

`sample-vault/` is a small flat vault you can open in Obsidian to try the plugin:

- `Daily Notes 2026.md` — a single-file daily notes file in the format Single File Daily Notes
  produces (`## MMMM YYYY` months, `### YYYY-MM-DD, dddd` days), with generic schedule entries
- `Project Notes.md`, `Meeting Minutes.md`, `Field Log.md`, `Handbook.md`, `Reading List.md` —
  filler notes at different heading depths, for trying the H1–H6 selector
- `Daily Template.md`, `Meeting Template.md` — template notes to try the new-card options menu:
  point `Daily Notes 2026.md` at the first and `Meeting Minutes.md` at the second, then hit
  **+ New card** and watch the `{{date}}`, `{{time}}` and `{{title}}` placeholders fill in

The screenshots above were rendered from that vault with the default Obsidian theme.

## FAQ

**Is this vibe-coded?**
Yes!

**Will you maintain this?**
Don't know, but I use it every day so probably.

**Are there other plugins like it?**
I don't know, that's why I wrote it.

**Do you need the [Single File Daily Notes](https://github.com/pranavmangal/obsidian-single-file-daily-notes) plugin for this to work?**
No, but you should use it because it's cool.

## License

[MIT](LICENSE)
