import isElectron from 'is-electron';
import { memo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { DiscordSettings } from '/@/renderer/features/settings/components/window/discord-settings';
import { PasswordSettings } from '/@/renderer/features/settings/components/window/password-settings';
import { RemoteSettings } from '/@/renderer/features/settings/components/window/remote-settings';
import { WindowSettings } from '/@/renderer/features/settings/components/window/window-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';
import { PRODUCT_FEATURES } from '/@/shared/lib/product-features';

const utils = isElectron() ? window.api.utils : null;

const sections = [
    { component: WindowSettings, key: 'window' },
    {
        component: DiscordSettings,
        hidden: !PRODUCT_FEATURES.discordRpc,
        key: 'discord',
    },
    {
        component: RemoteSettings,
        hidden: !PRODUCT_FEATURES.phoneRemote,
        key: 'remote',
    },
    { component: PasswordSettings, hidden: !utils?.isLinux(), key: 'password' },
];

export const WindowTab = memo(() => {
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
