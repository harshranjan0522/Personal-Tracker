# Personal Tracker

A fast, private daily tracker for **tasks**, **money**, and **splitting bills with friends**.

No accounts, no server, no invites — everything is stored in your own browser's
`localStorage` and never leaves your device.

## Features

**Tasks**
- Any day, not just today — step back and forward through dates
- Priority, time, deadline, tags, notes
- Repeating tasks (daily / weekdays / weekly / monthly)
- Overdue tasks from earlier days stay visible, with one-tap "move to today"
- Search, filter, sort; delete with undo
- Completion streak and a 30-day completion chart

**Money**
- Spent / received entries with category, method and description
- Range, category, type filters and free-text search
- Monthly budget with progress
- CSV export

**Split** (Splitwise-style, entirely local)
- Add friends by name — no sign-ups
- Record who paid and split **equally / by exact amounts / by shares / by percentage**
- Net balance per person, and a **settle-up** list showing the fewest payments
  that clear everything
- Settlement history
- All split maths runs in integer paise/cents with largest-remainder rounding,
  so shares always add up to the total exactly

**Everywhere**
- Dark and light themes (or follow the system)
- Nine currencies
- Keyboard shortcuts (press `?`)
- JSON backup / restore, CSV export
- Responsive — bottom tab bar on phones
- Works offline

## Running it

It is a static site. Either open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8777
# then open http://localhost:8777
```

New install? **Settings → Load sample data** fills every screen with a demo month
so you can look around before entering anything real.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup, SVG icon sprite |
| `app.css` | Design tokens, layout, components, light/dark themes |
| `app.js` | State, storage + migration, split maths, all views |

Chart.js is the only dependency, loaded from a CDN.

## Data

Stored under the `dt_state_v2` key. Data from the earlier single-file version
(`dt_tasks_v1` / `dt_expenses_v1`) is imported automatically the first time you
open this version.

Clearing your browser's site data deletes everything — use
**Settings → Export backup** if it matters.
