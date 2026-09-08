# As Is

Version 3.2.7 loads `annotation-coordinates.js` and `app.js` as classic scripts. The helper declares `canvasPointToImage` globally while `app.js` declares a top-level constant with the same name, so the renderer stops with a duplicate declaration before initialization and button event binding.

# To Be

The renderer must initialize normally, bind the directory selection buttons, and retain annotation edge snapping.

# Requirements

1. Coordinate helper loading must not create duplicate global declarations.
2. The application must complete renderer initialization and expose the self-test API.
3. Existing annotation snapping and all previous functions must remain unchanged.
4. Produce a corrected Windows installer using the configured fast mirror.

# Acceptance Criteria

1. Loading the helper followed by `app.js` does not throw a syntax error.
2. Packaged-app smoke test returns `ok: true`, including DOM and control readiness.
3. Electron and Python regression suites pass.
4. The corrected installer has a new version and contains the fixed renderer assets.

# Testing Plan

- Add a VM regression test that evaluates the helper and the renderer declaration in one classic-script context.
- Run coordinate and desktop contract tests.
- Run complete Electron and Python suites.
- Run the unpacked/packaged executable self-test and verify directory controls initialize.
- Build and inspect the NSIS installer.

# Implementation Plan

1. Add the failing classic-script collision test.
2. Isolate the helper implementation scope without adding dependencies; rerun focused tests.
3. Increment the patch version and update usage instructions.
4. Run full regression and packaged smoke checks.
5. Build the corrected installer using npmmirror and verify its contents/version.
