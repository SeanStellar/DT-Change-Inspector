# SAM Assisted Annotation

## As Is

The Electron application displays paired A/B images with shared image coordinates and stores annotations as black-background RGB masks. Users currently add annotations by drawing polygons. There is no prompt-based segmentation or binary-mask merge operation.

## To Be

The application provides an offline SAM-assisted mode. The user chooses the clearer A or B image, adds positive and negative point prompts, previews the predicted binary mask, and confirms it into the current RGB label without losing existing annotations. Existing polygon, erase, and color-replacement tools continue to work when SAM is unavailable.

## Requirements

1. Add an AI selection mode available from the toolbar and the `F` shortcut.
2. Run a bundled lightweight SAM-compatible ONNX model locally without uploading imagery.
3. Support positive prompts with left click and negative prompts with `Shift+left click` or right click.
4. Recompute and preview the candidate mask after prompt changes.
5. Support `Backspace` to remove the last prompt, `Enter` to confirm, and `Esc` to cancel.
6. Merge confirmed foreground pixels into the existing RGB mask using the active label color while preserving all other pixels.
7. Cache the current image embedding and surface clear loading/error state without blocking existing manual annotation.

## Acceptance Criteria

1. The toolbar contains an AI selection command and `F` toggles the mode without colliding with existing shortcuts.
2. Inference works with local application files and does not require Python, CUDA, a network connection, or model training.
3. Prompt labels distinguish foreground and background, and prompts remain bound to the selected image transform.
4. A returned candidate mask is visibly overlaid and updates after adding or removing prompts.
5. Keyboard cancellation and confirmation behave consistently with the existing annotation workflow.
6. Confirming a mask writes the active RGB value only where the binary mask is foreground and preserves existing labels elsewhere.
7. Missing model files or inference errors show a message and leave polygon annotation usable.

## Testing Plan

- Unit test binary mask validation, resizing, and RGB mask merge behavior.
- Unit test SAM coordinate scaling and prompt tensor construction.
- Contract test the toolbar, preload IPC surface, main-process handlers, keyboard shortcuts, and packaged model resources.
- Run the full Node test suite.
- Run the Electron self-test and a packaged-directory smoke test.

## Implementation Plan

1. Add failing unit and contract tests for mask merge and SAM integration points.
2. Implement binary-mask merge in the existing mask service and run its focused tests.
3. Add the local ONNX SAM service with explicit image/prompt coordinate transforms and focused tests.
4. Expose IPC calls and implement renderer state, prompt interaction, preview, and confirmation; run contract tests.
5. Bundle model/runtime resources, run all tests, Electron self-test, and packaged smoke verification.
