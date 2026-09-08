# As Is

- Polygon annotation (`Q`) and polygon erase reject clicks outside the displayed image rectangle.
- The viewer may contain black letterbox margins around an image.
- Connected-region erase and connected-color replacement rely on exact in-image clicks.

# To Be

- Polygon annotation and polygon erase accept clicks in the current image viewport even when they fall in letterbox margins.
- Those points clamp to the nearest image edge or corner.
- The moving polygon guide line uses the same clamped coordinate.
- Connected-region erase and connected-color replacement remain strict and reject outside-image clicks.

# Requirements

1. Add a reusable canvas-to-image coordinate mapper with strict and clamp-to-edge modes.
2. `Q` annotation and polygon erase must use clamp-to-edge mode.
3. Single connected erase and connected-color replacement must use strict mode.
4. In comparison mode, a polygon must remain locked to its selected A or B viewport.
5. Existing image, Mask, file swap, blink-speed, and navigation behavior must remain unchanged.

# Acceptance Criteria

1. In strict mode, a point outside the displayed image returns no image coordinate.
2. In clamp mode, left/right/top/bottom margins map to the corresponding edge and corner margins map to image corners.
3. Points outside the transform clip remain invalid in both modes.
4. Polygon preview and committed points use the same clamped coordinate.
5. Electron tests, Python compatibility tests, and Electron self-test pass.

# Testing Plan

- Unit-test coordinate conversion for inside, strict outside, each edge, corners, and outside-clip cases.
- Add renderer contract assertions proving polygon and strict operations choose different modes.
- Run Electron and Python regression suites.
- Run Electron source self-test and build the Windows x64 installer.

# Implementation Plan

1. Add failing coordinate-mapper tests and renderer contract assertions.
2. Implement the small pure coordinate mapper and run its focused tests.
3. Route polygon click/preview through clamp mode and single-point operations through strict mode.
4. Update help text and version; run all regression tests and self-test.
5. Build the Windows installer.
