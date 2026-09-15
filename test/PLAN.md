# Layout and functionality test plan

`npm test` bundles `main.ts` with the Obsidian API stubbed and runs two case files:
`parse.cases.mjs` (unit cases for the parsers and helpers) and `layouts.cases.mjs`
(this plan). The view layer itself — DOM, drag, Obsidian menus — cannot run outside
Obsidian; everything below exercises the pure pipelines each layout is built on and
the file-write operations behind every action, against a fake vault.

## Fixture notes (`test/fixtures/`)

| Fixture | Models | Traps it carries |
|---|---|---|
| `personal.md` | Daily Notes 2026: H1 months, H2 weeks, H3 days | duplicate week heading straddling two months, a month without its year (`# August`), an H4 inside a day, a Card Flip marker, a code fence containing a `#` line |
| `senstar.md` | Senstar Daily Notes 2026: frontmatter, H2 months, H3 days | properties block, empty task line, H4 Goal/Tasks subcards, flip marker in a day, blockquoted task, table |
| `plain.md` | an undated topic note | duplicate titles, ordered list, setext heading, horizontal rule |
| `no-headings.md` | prose only | nothing to card at any level |
| `deep.md` | only H4/H5 headings | level fallback |
| `crlf.md` | Windows line endings | every write must keep CRLF |
| `weeks.md` | H2 "Week N, YYYY" | week role detection and stepping |

## Matrix

| Area | Checks |
|---|---|
| Parsing (all layouts) | card counts per level per fixture; fenced `#` never a heading; frontmatter → properties card; unfiled card only when text precedes the first heading; CRLF split cleanly; level fallback picks the populated level |
| Sorting / pins | asc, desc, doc, count sorts keep the set; pinned cards lead |
| Dividers / Hierarchy | groups follow the nearest ancestor by line (duplicate ancestors stay separate groups); column items at a level |
| Tasks layout | open counts, due summaries (📅 and `[due::]`), first overdue task index, task sort keeps the set |
| Calendar / Heatmap | every dated title resolves to an ISO day; heatmap tallies per day; streaks; date level detection; day retitle keeps the weekday |
| Custom Grid | snapping to the grid and minimums; free-spot search avoids obstacles |
| Day Planner | split into line cards above the first heading + subcards at every level; line cards when no headings; flip marker respected only without subcards; column balancing invariants; slot key stable across task completion; whole-note fallback; period parse/shift/format round trips; level setup detection per fixture |
| Rolodex | duplicate headings are distinct cards (the view keys them by occurrence) |
| Deck | excerpt skips frontmatter |
| Writes (every action) | insert (top/bottom/logical, duplicate flag), delete, rename, quick add (top/bottom, above a flip marker), paste at end, toggle task (nth mapping, done date), move/delete/replace/insert-after block, move/replace line range (planner), move section, merge sections — each re-parsed afterwards; CRLF preserved |

## Real notes

`node tools/check-note.mjs <note.md> [...]` (after `npm test`) runs the same invariants over
any real note without asserting exact counts: parsing at every level, raw text matching its
lines, dated titles resolving, planner cards tiling a card that has subcards, the column
split covering every card, due summaries not throwing. Duplicate headings are reported as
information (they are distinct cards; planner slots are shared by title).
