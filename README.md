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

## What it does

- **One card per heading.** Pick which level becomes a card (H1–H6); deeper headings stay nested
  inside their parent card. Multiple layouts and sort orders. Use a front-matter (no heading)
  card as an inbox.
- **Work directly on the cards.** Click a card to edit its raw markdown (`Ctrl/⌘+Enter` saves,
  `Esc` cancels, `Tab` indents), tick task checkboxes — with optional `✅ 2026-08-06` done
  dates — create a new card pre-filled with today's date, or delete one after a confirmation.
- **Pin and quick add.** The pin button keeps a card at the top regardless of sort order, in every
  layout and view of that note — and by default the pinned band stays on screen while the rest
  scrolls (beside the row in Vertical). The `+` button pops a text box that appends what you type
  to the bottom of the section (or the top), without opening the editor.
- **Colour, template, jump.** Give any card its own colour from the palette button in its title
  bar. Point a note at a template note and every new card starts from its contents, with
  `{{title}}`, `{{date}}` and `{{time}}` filled in. When headings are dates, a calendar button
  jumps straight to any date's card.
- **Drag and drop.** Reorder cards in Document order, or drag a task or paragraph onto another
  card in any view — a task brings its sub-items along. Or skip the drag: right-click
  (long-press on mobile) a task or paragraph for a menu — move it to the next or previous card,
  mark it done or undone, or delete it.
- **Plays with the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin.**
  When Tasks is installed, ticking a checkbox uses its toggle — recurring tasks spawn their next
  occurrence — and the right-click menu gains its dialogs: create a task below the clicked line
  (or anywhere in a card, right-click empty space), or edit one in place.
- **Navigate as cards.** Wikilinks switch the tab to the linked note's card wall, ↗ opens the
  section in a normal editor, the four-arrow button blows a card up over the others, and you can
  open as many cards tabs as you like — including several of the same note.
- **Writes are surgical.** Only the touched section's lines change, and every write re-locates
  its section by content first, so a stale card refuses rather than touching the wrong lines.

## Layouts

### Vertical

Full-height cards side by side. The row scrolls sideways, and the mouse wheel pans it from anywhere
in the view — over the cards or over the toolbar. A card whose content overflows keeps the wheel
until it reaches its end.

![Vertical](screenshots/vertical.png)

### Custom Grid

A freeform canvas. Every section starts as a heading-only tile in the column on the right — drag
one onto the dot-patterned canvas and it becomes a full card you can place anywhere, move by its
title bar, and resize by its corner grip. Cards snap to the dot grid (a dashed preview shows where
a drag or resize will land, amber when the no-overlap rule will nudge it), and may never overlap
or touch. The ✕ in a card's corner — or dragging it onto the column — returns it to the list.

The right column keeps permanent controls: **Clear layout** (with confirmation) returns every card
to the list, the **A→Z / Z→A / Doc** buttons re-sort the sections, and today's heading is
highlighted. Zoom controls in the canvas's bottom-left go from 40% to 160%; scroll bars run in
every direction and **middle-click drag pans**. Placements and zoom are remembered per note in the
plugin's data — never in your notes.

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

## Pinned cards

Every card's title bar has a pin button. Pinning pulls the card into a pinned section at the top of
the wall, regardless of the sort order — within the pinned section and below it, cards still follow
the current sort. Pins are remembered per note, so they hold across every layout, every open view
of that note, and restarts. Click the pin again to unpin.

With **Keep pinned cards on screen** (on by default), the pinned section doesn't scroll away:

- **Grid, Grid Aligned, Tight, Horizontal** — the pinned cards sit in a band that sticks just below
  the toolbar while the rest of the cards scroll beneath it.
- **Vertical** — the pinned cards form a static column on the left, scrolling on its own if it
  outgrows the pane, while the card row scrolls sideways next to it.
- **Custom Grid** — not applied; cards on the canvas stay exactly where you placed them.

With the setting off, the pinned section still leads the wall but scrolls with it, separated by a
divider. Pins are keyed to the heading line, so renaming a section unpins it.

## Card colours

Every card's title bar has a palette button offering nine colours; a coloured card tints its
border and title bar in every layout, and its tile in the Custom Grid list. Colours are
remembered per note in the plugin's data — never in your notes — and, like pins, are keyed to
the heading line, so renaming a section clears its colour. Today's highlight still wins on
today's card.

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
template" goes back to empty cards, and the button wears the accent colour while a template
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
  opened notes are suggested; any other note can be reached by typing its name or path. (The plugin
  deliberately never enumerates the vault.)

## Settings

| Setting | What it does |
| --- | --- |
| Default note | Vault-relative path opened by the ribbon icon and command |
| Heading level | Which heading rank becomes a card (H1–H6) |
| Jump to today's card | Scroll to today's card when a note opens in the view (on by default; needs the note's Dates checkbox) |
| Keep pinned cards on screen | Pinned cards stay on screen while the rest scroll — below the toolbar, or left of the row in Vertical (on by default; not in Custom Grid) |
| Default sort | A→Z, Z→A, or document order |
| Default layout | Grid, Grid Aligned, Tight, Horizontal, Vertical, Custom Grid |
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
