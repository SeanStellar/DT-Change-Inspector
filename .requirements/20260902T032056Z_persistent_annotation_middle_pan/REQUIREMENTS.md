# As Is

- The image canvas starts panning on a left-button drag when annotation mode is inactive.
- Pointer movement prioritizes annotation preview, so panning cannot run while annotation mode is active.
- Saving a colored polygon calls the full annotation reset and exits annotation mode.

# To Be

- Image panning starts only while the middle mouse button is held, including during annotation mode.
- Left-button dragging never pans the image; left clicks remain available for annotation actions.
- Saving a colored polygon clears only the completed polygon draft and keeps colored annotation mode active for the next polygon.
- Other annotation tools keep their existing completion and reset behavior.

# Requirements

1. Start image panning only from a middle-button pointer press.
2. Allow middle-button panning while colored annotation or another annotation tool is active.
3. Do not start panning from a left-button pointer press.
4. After a successful colored polygon save, keep `annotationMode` enabled with `annotationAction` set to `add`, while clearing points, cursor, and transform lock.
5. Preserve the existing reset behavior for polygon erase, connected erase, color replacement, and SAM completion.

# Acceptance Criteria

1. A middle-button drag changes `panX` and `panY`; releasing or cancelling that pointer ends the drag.
2. An active annotation mode does not block an already-started middle-button drag.
3. A left-button press outside annotation mode does not create `state.drag`.
4. A successful colored polygon save shows the mask, clears the completed draft, and leaves the annotate button active so another polygon can be started immediately.
5. Existing erase, replacement, SAM, navigation, workspace loading, and explicit cancel flows continue to use the full annotation reset.

# Testing Plan

- Add renderer contract assertions for middle-button-only pan startup and drag precedence during pointer movement.
- Add renderer contract assertions for persistent colored annotation after polygon save.
- Run the focused renderer contract test first.
- Run the full Electron Node test suite.
- Run the packaged renderer smoke test when available.

# Implementation Plan

1. Add failing interaction contract assertions; run the focused test and confirm failure.
2. Add a minimal draft-clearing helper and use it after successful colored polygon saves; rerun the focused test.
3. Change pointer handling so middle-button press owns panning and drag movement runs before annotation preview; rerun the focused test.
4. Remove the left-drag cursor affordance and update the renderer interaction self-test expectation; run the full test suite and smoke test.

# API Verification

- The configured web-search backend returned HTTP 404, so no external API result was available. The implementation uses the existing Pointer Events API already present in the renderer and the standard `MouseEvent.button === 1` middle-button value.
