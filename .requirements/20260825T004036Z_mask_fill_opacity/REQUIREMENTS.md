# Mask Fill Opacity

## As Is

The Electron viewer always draws non-black Mask pixels with a fixed alpha value of 118 (about 46%). The Mask can only be shown or hidden as a whole with the `Mask [S]` control or the `S` shortcut. Red Mask boundaries are drawn fully opaque.

## To Be

The bottom toolbar provides a compact Mask fill-opacity slider. Moving it updates the visible Mask fill immediately while keeping red boundaries fully opaque. The selected percentage is restored on the next launch, and `S` continues to show or hide the complete Mask overlay.

## Requirements

1. Add a Mask fill-opacity range control beside `Mask [S]`, supporting 0% through 100%.
2. Update Mask fill opacity immediately while the range control is dragged.
3. Keep detected Mask boundaries fully opaque red at every fill-opacity value.
4. Preserve the existing 46% appearance as the default for users without a saved value.
5. Save the selected fill opacity in the existing application settings and restore it at startup.
6. Preserve the existing `S` Mask visibility toggle.

## Acceptance Criteria

1. The toolbar displays a range input and its current numeric percentage beside `Mask [S]`; it accepts values from 0 to 100.
2. Changing the range input schedules a render without requiring an additional click.
3. At 0%, Mask interiors are transparent while red boundary pixels remain alpha 255.
4. With no saved value, the control and renderer use 46%.
5. Changing the control writes `maskOpacity` to `settings.json`; loading settings clamps a saved value to 0-100.
6. Clicking `Mask [S]` or pressing `S` still toggles the whole Mask overlay.

## Testing Plan

- Add renderer contract checks for the range input, dynamic fill alpha, opaque boundary alpha, live render handler, and settings persistence.
- Run the Electron Node test suite.
- Run the Electron self-test to verify startup and DOM wiring.
- Inspect the running app to confirm the compact toolbar layout and immediate visual response.

## Implementation Plan

1. Add failing contract assertions for the new control, rendering behavior, and persistence; run the focused test.
2. Add the toolbar range control and styling; rerun the focused test.
3. Add renderer state, live updates, and dynamic fill alpha; rerun the focused test.
4. Extend existing settings normalization to persist the value; run the full test suite and self-test.
