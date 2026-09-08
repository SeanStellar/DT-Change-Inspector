# As Is

- Every navigation input can start a fast render on the next animation frame.
- Rapid repeated navigation starts decode and `createImageBitmap` work for intermediate 4K pairs that are superseded before they are displayed.
- Those asynchronous preview jobs cannot be cancelled and compete for CPU/GPU resources, causing frame stalls during fast browsing.
- Existing benchmarks cover one page switch and panning but not many consecutive image changes.

# To Be

- Pair index changes remain immediate.
- Actual navigation rendering is debounced, with one trailing render for the final selected pair.
- Intermediate pairs skipped during rapid navigation do not each start a new preview-generation job.
- Single-step navigation remains responsive and the final selected pair is always rendered.
- A multi-pair 4K benchmark measures frame blocking during rapid repeated navigation.

# Requirements

1. Add a navigation render debounce of 100 ms.
2. Coalesce every navigation input within the debounce window into one trailing fast render.
3. Do not start preview generation for intermediate pairs while rapid input continues.
4. Cancel a pending trailing navigation render when another render path already renders the latest state.
5. Update status immediately when the selected index changes.
6. Add an optional rapid-navigation benchmark over multiple pairs.

# Acceptance Criteria

1. Repeated navigation starts no renderer job until input has been quiet for 100 ms.
2. After rapid input stops, the visible canvas catches up to the final `state.index`.
3. One normal click renders the selected pair after at most the 100 ms debounce plus its preview load time.
4. Zoom, pan, reset, and other explicit renders do not leave a stale navigation timer that redraws later.
5. The multi-pair 4K benchmark reports p95 frame blocking below 16.7 ms and all existing tests pass.

# Testing Plan

- Add renderer contract assertions for the throttle interval, immediate branch, trailing timer, and use from `navigate`.
- Generate at least twelve unique 3840x2160 pairs and Masks.
- Record rapid-navigation baseline frame intervals.
- Implement throttled/coalesced navigation rendering.
- Rerun the same benchmark and compare p95 blocking.
- Run full Node and packaged Electron self-tests.

# Implementation Plan

1. Add failing contract assertions and rapid-navigation benchmark instrumentation.
2. Add navigation throttle state and scheduling function.
3. Route `navigate` through the scheduler and update status immediately.
4. Ensure general rendering cancels stale trailing navigation timers without cancelling the active navigation render.
5. Run multi-pair 4K benchmark, full regression, version bump, and packaging.

# API Verification

- This change uses existing `performance.now`, `setTimeout`, and `clearTimeout` APIs already present in the renderer. No new external API or dependency is introduced.

# Verification Results

- Baseline with twelve 3840x2160 pairs and 24 rapid navigation steps: p95 frame blocking 157.6 ms.
- Debounced result with the same dataset and steps: p95 frame blocking 0.4 ms.
- Final selected index and last rendered index both matched the expected pair.
- Full Node suite: 22 passed, 0 failed.
