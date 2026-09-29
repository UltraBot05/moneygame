# QA-007 accessibility review

Date: 2026-09-29. Scope: landing, lobby, game screen (board, stage, rail, dialogs), profile.
Method: code review against WCAG 2.2 AA for the critical flows, contrast ratios computed from the
design tokens, and Playwright keyboard checks (`e2e/smoke.spec.ts`). An assistive-technology pass
by a human (screen reader on Windows and macOS) is still recommended before public release.

## Passes

- **Keyboard**: every action is a native `button`, link or input; tiles with deeds are buttons
  with descriptive labels ("Cairo, owned by Asha Rao, mortgaged"). Enter opens a deed; Escape
  closes the deed panel, trade dialog and bankruptcy confirmation. Focus rings use the brass
  focus token (2px, offset 2px) on every focusable element.
- **Dialogs** (trade, bankruptcy confirm, paused, final standings) have roles and names and now
  take focus when they open.
- **Status**: rejection notices use `role="status"`; chat and log are an `aria-live="polite"`
  region; the Collusion Guard warning is a status notice.
- **Not colour alone**: sets carry a pattern and a code as well as a colour; mortgaged deeds
  have a strip and a label; turn and connection states are written out in the players panel.
- **Motion**: `prefers-reduced-motion` disables the dice tumble, token pulse and card reveal.
- **Forms**: every input has a label (visible or visually hidden).
- **Zoom/reflow**: below 820px the layout becomes one column; the board scrolls horizontally
  inside its own area instead of the page.

## Fixed in this pass

| Issue | Before | Fix |
| --- | --- | --- |
| Brass label text on paper ("Last", "Winner", "Offer", titles) | about 2.5:1 | new `--brass-text` token, about 5.2:1 |
| White initials on light tokens (lime, orange, teal) | about 2.5 to 3.2:1 | initials switch to ink when the token colour is light (`textOn`), at least 5:1 |
| Faint slate text and chat timestamps | about 3.1 to 3.9:1 | raised to the muted token, at least 4.6:1 |
| Dialogs did not take focus | focus stayed behind the overlay | focus moves into the dialog on open |

## Known limitations

- Board tiles are many tab stops (40 or 52). A "jump to board / jump to actions" shortcut would
  help keyboard users; not in v1.
- Dialog focus is not trapped (Tab can leave the dialog). Escape and the close buttons work.
- Countdown timers are visual; they are not announced.
