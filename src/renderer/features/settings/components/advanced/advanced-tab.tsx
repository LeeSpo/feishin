import { memo } from 'react';
import { Fragment } from 'react/jsx-runtime';

import { AnalyticsSettings } from '/@/renderer/features/settings/components/advanced/analytics-settings';
import { ExportImportSettings } from '/@/renderer/features/settings/components/advanced/export-import-settings';
import { LoggerSettings } from '/@/renderer/features/settings/components/advanced/logger-settings';
import { CacheSettings } from '/@/renderer/features/settings/components/window/cache-settngs';
import { UpdateSettings } from '/@/renderer/features/settings/components/window/update-settings';
import { Divider } from '/@/shared/components/divider/divider';
import { Stack } from '/@/shared/components/stack/stack';
import { PRODUCT_FEATURES } from '/@/shared/lib/product-features';

const sections = [
    { component: UpdateSettings, key: 'update' },
    {
        component: AnalyticsSettings,
        hidden: !PRODUCT_FEATURES.analytics,
        key: 'analytics',
    },
    { component: ExportImportSettings, key: 'export-import' },
    { component: LoggerSettings, key: 'logger' },
    { component: CacheSettings, key: 'cache' },
];

export const AdvancedTab = memo(() => {
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
