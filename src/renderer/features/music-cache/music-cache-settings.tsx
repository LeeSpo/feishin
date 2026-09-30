import { closeAllModals, openModal } from '@mantine/modals';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMusicCache } from './use-music-cache';

import { SettingsSection } from '/@/renderer/features/settings/components/settings-section';
import { formatSizeString } from '/@/renderer/utils/format';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { NumberInput } from '/@/shared/components/number-input/number-input';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { MUSIC_CACHE_GIB } from '/@/shared/types/music-cache';

export const MusicCacheSettingsSection = () => {
    const { t } = useTranslation();
    const { data, error } = useMusicCache();
    const [limit, setLimit] = useState<number | string>(5);
    const [busy, setBusy] = useState(false);
    const maxBytes = data?.settings.maxBytes;
    useEffect(() => {
        if (maxBytes !== undefined) setLimit(maxBytes / MUSIC_CACHE_GIB);
    }, [maxBytes]);

    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await action();
        } catch (failure) {
            toast.error({ message: (failure as Error).message });
        } finally {
            setBusy(false);
        }
    };

    if (!data) return error ? <Text>{error.message}</Text> : null;
    if (data.error) return <Text>{data.error}</Text>;

    const confirmClear = () =>
        openModal({
            children: (
                <ConfirmModal
                    onConfirm={() =>
                        run(async () => {
                            await window.api.musicCache.clearAutomatic();
                            closeAllModals();
                        })
                    }
                >
                    {t('musicCache.clearDescription')}
                </ConfirmModal>
            ),
            title: t('musicCache.clearAutomatic'),
        });

    return (
        <Stack gap="sm">
            <SettingsSection
                options={[
                    {
                        control: (
                            <Switch
                                aria-label={t('musicCache.automatic')}
                                checked={data.settings.enabled}
                                disabled={busy}
                                onChange={(event) => {
                                    void run(() =>
                                        window.api.musicCache.configure({
                                            ...data.settings,
                                            enabled: event.currentTarget.checked,
                                        }),
                                    );
                                }}
                            />
                        ),
                        description: t('musicCache.automaticDescription'),
                        title: t('musicCache.automatic'),
                    },
                    {
                        control: (
                            <NumberInput
                                aria-label={t('musicCache.limit')}
                                decimalScale={0}
                                disabled={busy}
                                max={1024}
                                min={1}
                                onBlur={() => {
                                    const amount = Number(limit);
                                    if (!Number.isInteger(amount) || amount < 1 || amount > 1024) {
                                        setLimit(data.settings.maxBytes / MUSIC_CACHE_GIB);
                                        return;
                                    }
                                    void run(() =>
                                        window.api.musicCache.configure({
                                            ...data.settings,
                                            maxBytes: amount * MUSIC_CACHE_GIB,
                                        }),
                                    );
                                }}
                                onChange={setLimit}
                                value={limit}
                            />
                        ),
                        description: t('musicCache.limitDescription'),
                        title: t('musicCache.limit'),
                    },
                ]}
                title={t('musicCache.settings')}
            />
            <Text isMuted size="sm">
                {t('musicCache.usage', {
                    automatic: formatSizeString(data.automaticBytes),
                    saved: formatSizeString(data.savedBytes),
                })}
            </Text>
            <Group>
                <Button disabled={busy} onClick={confirmClear} variant="default">
                    {t('musicCache.clearAutomatic')}
                </Button>
                <Button
                    disabled={busy}
                    onClick={() => {
                        void run(async () => {
                            const message = await window.api.musicCache.openFolder();
                            if (message) throw new Error(message);
                        });
                    }}
                    variant="default"
                >
                    {t('musicCache.openFolder')}
                </Button>
            </Group>
        </Stack>
    );
};
