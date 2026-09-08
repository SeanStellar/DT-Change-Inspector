# As Is

- `navigate` schedules a full-quality render immediately after switching pairs.
- Full-quality Mask rendering performs foreground, edge-detection, and edge-thickening loops without yielding.
- Once that work begins, a later zoom or pan render cannot interrupt it until the old Mask frame completes.
- The existing 4K benchmark covers panning on the current image but not interaction immediately after changing images.

# To Be

- Pair navigation displays a fast first frame and defers exact Mask rendering until interaction settles.
- Full-quality Mask processing yields between bounded row chunks.
- A stale full-quality Mask render exits after a yield when a newer navigation, zoom, or pan render supersedes it.
- The renderer self-test measures readiness immediately after switching to a prefetched 4K pair and then panning.

# Requirements

1. Make `navigate` call `scheduleRender(true)`.
2. Split all full-quality Mask pixel loops into bounded row chunks.
3. Yield to the next animation frame between chunks and check `renderSequence` before continuing.
4. Never draw a stale Mask scratch buffer onto the visible canvas.
5. Add an optional page-switch benchmark using at least two image pairs.
6. Prefetch a screen-sized `ImageBitmap` preview for neighboring original images and Masks, and use it for fast frames.

# Acceptance Criteria

1. Switching pairs no longer starts the exact CPU Mask path in the first navigation frame.
2. Each Mask-processing chunk holds the main thread for only a bounded number of rows.
3. Starting zoom or pan invalidates and stops the previous exact Mask render at its next yield.
4. The settled frame still uses the existing exact fill opacity and red-boundary algorithm.
5. The two-pair 4K benchmark stays below one 60Hz frame at p95 for immediate post-switch panning, and the full regression suite passes.
6. Navigation does not synchronously upload full-resolution 4K textures before the first interactive frame.

# Testing Plan

- Add renderer contract assertions for fast navigation and cancellable chunk yields.
- Extend the renderer self-test with a two-pair page-switch timing result.
- Generate a second 3840x2160 pair and Mask.
- Record the current page-switch blocking baseline.
- Implement fast navigation and chunked cancellation, then rerun the same benchmark.
- Run all Node tests and packaged Electron self-tests.

# Implementation Plan

1. Add failing contract assertions and page-switch benchmark instrumentation.
2. Change navigation to fast rendering and verify the focused contract.
3. Add a small animation-frame yield helper and chunk the three exact Mask loops with stale-render checks.
4. Prefetch and use screen-sized `ImageBitmap` objects for fast image and Mask frames.
5. Compare before/after 4K page-switch timings.
6. Run full regression, bump the patch version, and rebuild installer plus portable artifacts.

# API Verification

- The implementation uses the existing browser `requestAnimationFrame` API already used by the renderer. External web search is unavailable in this environment, so no new browser or package API is introduced.

# Verification Results

- Baseline with two prefetched 3840x2160 pairs: switch-to-interaction 111.2 ms; immediate pan 83.3 ms.
- Optimized two-pair run: switch blocking above idle frame cadence 3.3 ms; immediate-pan blocking 0.1 ms.
- Continuous 4x zoom pan: average 0.1 ms, p95 0.2 ms, max 0.2 ms.
- Full Node suite: 22 passed, 0 failed.
- 4K page switch, persistent polygon add, connected erase, polygon erase, and settled exact render self-test: passed.
