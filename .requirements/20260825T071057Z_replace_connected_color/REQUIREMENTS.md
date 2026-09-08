# Replace Connected Mask Color

## As Is

The Electron viewer can add polygon Mask regions and delete a clicked same-color connected region. It cannot recolor an existing connected region to the currently selected label color.

## To Be

The toolbar provides `替换颜色 [W]`. Clicking the button or pressing `W` enters a one-shot replace mode. Clicking an existing non-black Mask region recolors only that clicked same-color connected region to the current label color, refreshes the Mask, and exits replace mode. Pressing `W` again before use cancels the mode.

## Requirements

1. Add a `替换颜色 [W]` toolbar button beside the existing annotation tools.
2. Toggle replace mode with the button or `W`; a second toggle cancels it.
3. In replace mode, a left click recolors only the clicked exact-RGB connected Mask region to the active label color.
4. A successful click refreshes the Mask and exits replace mode after one use.
5. Clicking black background does not modify the Mask and keeps replace mode active for another click.
6. Existing behavior remains intact; `W` is reserved from label assignment.

## Acceptance Criteria

1. The toolbar contains `data-action="replace-color"` and visible text `替换颜色 [W]`.
2. `W` enters and exits replace mode in both keyboard paths.
3. Only the clicked exact-RGB connected component changes to the active label RGB.
4. A replacement, including clicking a region already using the active color, exits replace mode.
5. A black-background click reports no replacement and leaves replace mode active.
6. `W` is reserved and existing tests pass.

## Testing Plan

- Add a core Mask-service test with disconnected same-color components and another color.
- Add renderer/IPC contract assertions for the button, API, IPC route, shortcut, and one-shot reset.
- Run focused tests, full Electron tests, syntax checks, and Electron self-test.

## Implementation Plan

1. Add failing core and desktop contract tests.
2. Implement connected-region recoloring and IPC; run the core test.
3. Add UI state, click handling, status text, and `W`; run the contract test.
4. Run all verification and open the source build for user testing.
