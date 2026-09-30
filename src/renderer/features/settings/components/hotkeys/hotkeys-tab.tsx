import isElectron from 'is-electron';
import { memo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { HotkeyManagerSettings } from '/@/renderer/features/settings/components/hotkeys/hotkey-manager-settings';
import { MediaSessionSettings } from '/@/renderer/features/settings/components/hotkeys/media-session-settings';
import { WindowHotkeySettings } from '/@/renderer/features/settings/components/hotkeys/window-hotkey-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';
import { PRODUCT_FEATURES } from '/@/shared/lib/product-features';

const sections = [
    {
        component: WindowHotkeySettings,
        hidden: !isElectron() || !PRODUCT_FEATURES.complexGlobalHotkeys,
        key: 'window',
    },
    { component: MediaSessionSettings, key: 'media-session' },
    {
        component: HotkeyManagerSettings,
        hidden: !PRODUCT_FEATURES.complexGlobalHotkeys,
        key: 'hotkey-manager',
    },
];

export const HotkeysTab = memo(() => {
    const visible = sections.filter((section) => !section.hidden);

    return (
        <Stack gap="md">
            {visible.map(({ component: Section, key }, index) => (
                <Fragment key={key}>
                    <Section />
                    {index < visible.length - 1 && <Divider />}
                </Fragment>
            ))}
        </Stack>
    );
});
