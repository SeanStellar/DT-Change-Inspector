# As Is

- Every fast pan frame redraws the visible Mask through `getImageData`, allocates several full-viewport typed arrays, and loops over every visible pixel.
- Every fast render creates its own delayed full-quality render, so continuous pointer movement accumulates expensive Mask edge renders.
- The existing performance test measures Mask file operations but does not measure renderer panning with a 4K image and active annotation.

# To Be

- Fast pan frames use a GPU-composited Mask preview without per-pixel CPU processing.
- Continuous pan or zoom activity keeps only one delayed full-quality render pending.
- The final settled frame preserves the current exact Mask colors, opacity, and red boundaries.
- A 4K renderer benchmark measures repeated zoomed panning while annotation mode and Mask display are active.

# Requirements

1. During fast rendering, draw the Mask without `getImageData` or per-pixel typed-array allocation.
2. Debounce the delayed full-quality render so only the latest fast render schedules one.
3. Preserve the existing full-quality Mask rendering path after interaction settles.
4. Add a repeatable 4K pan benchmark to the Electron render self-test.
5. Preserve annotation coordinates, middle-button panning, persistent colored annotation, and existing Mask editing behavior.

# Acceptance Criteria

1. Fast Mask rendering uses canvas compositing and returns before the CPU pixel-processing path.
2. `scheduleRender(true)` cancels the previous settle timer before creating the next one.
3. A non-fast render still applies fill alpha and red class boundaries exactly as before.
4. The self-test reports average and p95 pan-frame time for configurable repeated zoomed pans with annotation active.
5. The 4K benchmark improves materially from baseline and the complete Electron test suite passes.

# Testing Plan

- Add renderer contract assertions for a single settle timer and an early fast Mask compositing path.
- Extend `__APP_RENDER_TEST__` with an optional 4K pan benchmark result.
- Generate synthetic 3840x2160 A/B/Mask images using the installed `sharp` dependency.
- Record baseline average and p95 fast pan render time.
- Implement the optimization, rerun the same benchmark, and compare results.
- Run all Node tests and Electron smoke tests.

# Implementation Plan

1. Add failing renderer contract assertions and benchmark instrumentation; confirm the focused contract test fails.
2. Add one settle-timer variable and debounce delayed high-quality rendering; rerun the focused test.
3. Add a fast canvas-composited Mask preview before the existing exact CPU path; rerun the focused test.
4. Run the same 4K benchmark and compare baseline versus optimized average and p95.
5. Run full regression and packaged smoke tests, then rebuild installer and portable artifacts if verification succeeds.

# API Verification

- External web search was previously unavailable in this environment with HTTP 404. This change relies only on the existing Canvas 2D APIs already used by the renderer: `globalCompositeOperation`, `globalAlpha`, clipping, and `drawImage`.

# Verification Results

- Baseline, 3840x2160 image, Mask visible, annotation active, 4x zoom, 40 pan frames: average 15.4 ms, p95 52.3 ms.
- Optimized development build, same scenario after warm-up, 60 pan frames: average 0.2 ms, p95 0.6 ms, max 0.9 ms.
- Packaged 3.3.2 build, same scenario, 60 pan frames: average 0.1 ms, p95 0.2 ms, max 0.2 ms.
- Full Node suite: 22 passed, 0 failed.
- 4K annotation, connected erase, polygon erase, persistent-add, and pan self-test: passed.
