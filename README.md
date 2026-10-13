# park

`/park` saves your work in the current Claude Code tab and writes a short note for your next session. `/unpark` reads that note and picks up where you stopped.

[herdr](https://herdr.dev) is optional. Both commands work without it. If you run Claude Code inside herdr, `/park` also asks every other idle agent tab to save first, and `/park close` closes the tabs that saved.

## Why you might want it

At the end of a day you stop in the middle of something. Tomorrow you have to remember what was done, what is still open, and what to do first.

Type `/park` and Claude writes that down in a note: what is done, what is open, the first step. Tomorrow, `/unpark` has Claude read the note and carry on. If you have five agent tabs open in herdr, `/park` asks each idle one to save before your note is written, so nothing is left half-saved.

## Install

Paste these two lines into a terminal (not into Claude):

```
claude plugin marketplace add varunmoka7/park
claude plugin install park@park
```

Needs Claude Code 2.1.287 or newer with mods enabled. herdr is not required. Install it (https://herdr.dev) only if you want `/park` to save your other agent tabs too.

macOS and Linux only for the full feature set. The note-finding step uses `find`. On Windows the commands work, but the session-start message and `/unpark` will not find your notes.

## How to use

- `/park` saves this tab and writes the next-session note. In herdr it first asks every other idle agent tab to save, and waits for them (up to 9 minutes each).
- `/park close` closes the tabs that saved, in herdr only. It refuses if any tab did not save or has started working again, and it never closes the tab you are in.
- `/unpark` reads the newest note and follows it.
- At session start, a short message tells you if a note from the last 3 days exists.

The commands are registered in every interactive Claude Code session. There is no account or persona check.

Notes go to the `.park/` folder of the project, as `.park/park-<topic>.md`. You may want to add `.park/` to your `.gitignore`.

## What it touches

- Network: none.
- Files read: the `.park` folder in your project, to find the newest note.
- Files written: the note, `.park/park-<topic>.md`, written by Claude when you run `/park`. Nothing else.
- Other programs: it runs the `herdr` binary only when you are inside herdr, to list tabs, send the save request and close tabs.
- Model cost: one turn for each tab you park, plus one turn for this tab to write the note.
- Off or on: nothing runs until you type `/park`. It acts only on command.

## Turn it off / uninstall

```
claude plugin uninstall park@park
```

You can delete the `.park` folder in a project at any time.

## Known limits

- "Saved" means the tab took the save request and went quiet. The mod does not read the tab to confirm that it really saved.
- The list of parked tabs is kept in memory. If you reload Claude Code after `/park`, run `/park` again before `/park close`.
- Busy tabs are skipped, not interrupted. They are listed in the note.

## License

MIT. Copyright (c) 2026 Varun Moka.
