# As Is

- Double-clicking the image canvas calls `resetView`, restoring zoom and pan.
- The toolbar reset button and `R`/`0` shortcuts also call `resetView`.

# To Be

- Double-clicking the image canvas has no zoom or pan effect.
- Explicit reset controls remain unchanged.

# Requirements

1. Remove the canvas `dblclick` listener that calls `resetView`.
2. Preserve the reset toolbar action and `R`/`0` keyboard shortcuts.

# Acceptance Criteria

1. Renderer source contains no canvas double-click reset binding.
2. `reset: resetView` and the `R`/`0` shortcut branch remain present.

# Testing Plan

- Add a renderer contract assertion that rejects a canvas `dblclick` listener.
- Keep existing reset-control assertions and run the full suite.

# Implementation Plan

1. Add the failing contract assertion.
2. Remove the one event-listener line.
3. Run focused, full, and packaged smoke tests.

# API Verification

- No API verification is needed; this change removes an existing event binding.

# Verification Results

- Canvas double-click binding removed.
- Toolbar reset and `R`/`0` shortcuts remain present.
- Full Node suite: 22 passed, 0 failed.
