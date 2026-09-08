# As Is

- Electron 3.2.5 uses the `B` key and the “闪烁 [B]” toolbar button to start or stop A/B blinking.
- The interval is fixed at 350 ms in `toggleBlink()`.
- User settings already persist directories and Mask fill opacity.

# To Be

- Add a compact native speed selector immediately after “闪烁 [B]”.
- Offer five named intervals: 极快 150 ms, 快 250 ms, 标准 350 ms, 慢 600 ms, 极慢 1000 ms.
- Keep 350 ms as the default for existing users.
- Apply a changed speed immediately while blinking and persist it for future launches.

# Requirements

1. The toolbar must expose an accessible blink-speed selector beside the blink button.
2. Blink timing must use the selected interval and maintain at most one interval timer.
3. Changing speed during blinking must restart the timer immediately without stopping blink mode.
4. The selected speed must be normalized and persisted in settings.
5. Existing viewing, annotation, Mask, delete, replacement, swap, and shortcut behavior must remain unchanged.

# Acceptance Criteria

1. The selector contains exactly 150, 250, 350, 600, and 1000 ms options, with 350 ms selected by default.
2. Starting blink creates one timer using the current value; stopping clears it.
3. A selector change while blinking clears the old timer and creates one timer with the new value.
4. Invalid or legacy setting values load as 350 ms; valid supported values round-trip through save/load.
5. Electron unit tests, self-test, packaged self-test, and installer install/run verification pass.

# Testing Plan

- Add contract assertions for selector placement, values, setting normalization, and timer restart behavior.
- Run the Electron unit suite.
- Run the existing Python compatibility suite.
- Run the Electron source self-test.
- Build the Windows x64 NSIS installer, install into an isolated workspace folder, and run the installed executable self-test.

# Implementation Plan

1. Add failing contract tests for the new UI, settings, and timer lifecycle; run the Electron suite and confirm failure.
2. Add the native selector and matching existing toolbar styling; rerun the focused contract test.
3. Add `blinkIntervalMs` normalization, persistence, initialization, and timer restart logic; rerun Electron tests.
4. Update documentation and version, then run full regression and self-test.
5. Package, install into an isolated folder, run installed self-test, and remove the diagnostic installation.
