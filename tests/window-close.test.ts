import { expect, test } from 'bun:test';

import { shouldHideWindowOnClose } from '../src/main/utils/window-close';

test('macOS close keeps the window alive regardless of the tray setting', () => {
    expect(shouldHideWindowOnClose(true, false, false)).toBe(true);
    expect(shouldHideWindowOnClose(true, true, false)).toBe(true);
});

test('other platforms follow the exit-to-tray setting', () => {
    expect(shouldHideWindowOnClose(false, false, false)).toBe(false);
    expect(shouldHideWindowOnClose(false, true, false)).toBe(true);
});

test('explicit quit closes the window on every platform', () => {
    expect(shouldHideWindowOnClose(true, true, true)).toBe(false);
    expect(shouldHideWindowOnClose(false, true, true)).toBe(false);
});
