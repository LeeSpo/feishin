import type { MusicCacheCollection, MusicCacheEntry } from '/@/shared/types/music-cache';

import { closeAllModals, openModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './local-music-route.module.css';
import { getOfflineCollectionSongs, retryOfflineSong, saveSongsOffline } from './music-cache-api';
import { MusicCacheSettingsSection } from './music-cache-settings';
import { useMusicCache } from './use-music-cache';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useRadioStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { AppRoute } from '/@/renderer/router/routes';
import { getServerById, useSettingsStore } from '/@/renderer/store';
import { formatSizeString } from '/@/renderer/utils/format';
import { logger } from '/@/renderer/utils/logger';
import { Badge } from '/@/shared/components/badge/badge';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Progress } from '/@/shared/components/progress/progress';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Stack } from '/@/shared/components/stack/stack';
import { Table } from '/@/shared/components/table/table';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { Play, PlayerType } from '/@/shared/types/types';

const LocalMusicRoute = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const player = usePlayer();
    const { data, error, isLoading } = useMusicCache();
    const [view, setView] = useState('saved');
    const [selected, setSelected] = useState<null | string>(null);
    const [search, setSearch] = useState('');
    const [busy, setBusy] = useState(false);
    const entriesByKey = useMemo(
        () => new Map(data?.entries.map((entry) => [entry.key, entry]) || []),
        [data?.entries],
    );
    const collection = data?.collections.find((item) => item.key === selected);
    const text = search.trim().toLocaleLowerCase();
    const entries = (
        collection
            ? (collection.keys.length ? collection.keys : collection.pendingKeys || [])
                  .map((key) => entriesByKey.get(key))
                  .filter((entry): entry is MusicCacheEntry => !!entry)
            : [...(data?.entries || [])]
                  .filter((entry) => (view === 'automatic' ? !entry.saved : entry.saved))
                  .sort((a, b) => b.lastUsed - a.lastUsed)
    ).filter((entry) =>
        [
            entry.song.name,
            entry.song.artistName,
            entry.song.album,
            entry.serverName,
            entry.account,
        ].some((value) => value?.toLocaleLowerCase().includes(text)),
    );

    const run = async (action: () => Promise<unknown>) => {
        setBusy(true);
        try {
            await action();
        } catch (failure) {
            logger.warn('Local music action failed');
            toast.error({ message: (failure as Error).message });
        } finally {
            setBusy(false);
        }
    };

    const play = async (items: MusicCacheEntry[], type: Play) => {
        const songs = [];
        for (const entry of items) {
            if (entry.status !== 'ready') continue;
            const file = await window.api.musicCache.lookup({ key: entry.key });
            if (!file) throw new Error(t('musicCache.missingFile'));
            songs.push({ ...entry.song, _localCacheKey: entry.key });
        }
        if (!songs.length) return;
        useRadioStore.getState().actions.stop();
        useSettingsStore.getState().actions.setSettings({ playback: { type: PlayerType.LOCAL } });
        player.addToQueueByData(songs, type);
    };

    const updateCollection = async (item: MusicCacheCollection) => {
        const server = getServerById(item.serverId);
        if (!server || (server.userId || server.username) !== item.account)
            throw new Error(t('musicCache.reconnectAccount'));
        const songs = await getOfflineCollectionSongs(item.serverId, item.id, item.type);
        await saveSongsOffline(songs, { id: item.id, name: item.name, type: item.type });
    };

    const remove = (key: string, isCollection = false) =>
        openModal({
            children: (
                <ConfirmModal
                    onConfirm={() =>
                        run(async () => {
                            await window.api.musicCache.remove(key, isCollection);
                            if (key === selected) setSelected(null);
                            closeAllModals();
                        })
                    }
                >
                    {t(
                        isCollection
                            ? 'musicCache.removeCollectionDescription'
                            : 'musicCache.removeFileDescription',
                    )}
                </ConfirmModal>
            ),
            title: t(isCollection ? 'musicCache.removeCollection' : 'musicCache.removeFile'),
        });

    if (!isElectron()) return null;
    return (
        <AnimatedPage>
            <div className={styles.content}>
                <Group justify="space-between">
                    <Text size="xl" weight={600}>
                        {t('musicCache.title')}
                    </Text>
                    <Button onClick={() => navigate(AppRoute.HOME)} variant="default">
                        {t('musicCache.returnOnline')}
                    </Button>
                </Group>
                <Text isMuted size="sm">
                    {t('musicCache.localDescription')}
                </Text>
                <Group>
                    <SegmentedControl
                        data={[
                            { label: t('musicCache.savedSongs'), value: 'saved' },
                            { label: t('musicCache.collections'), value: 'collections' },
                            { label: t('musicCache.automatic'), value: 'automatic' },
                        ]}
                        onChange={(value) => {
                            setView(value);
                            setSelected(null);
                        }}
                        value={view}
                    />
                    <TextInput
                        aria-label={t('common.search')}
                        onChange={(event) => setSearch(event.currentTarget.value)}
                        placeholder={t('common.search')}
                        value={search}
                    />
                </Group>
                {(error || data?.error) && <Text>{error?.message || data?.error}</Text>}
                {isLoading && <Text>{t('musicCache.loading')}</Text>}
                {collection && (
                    <Group>
                        <Button onClick={() => setSelected(null)} variant="subtle">
                            {t('common.back')}
                        </Button>
                        <Text weight={600}>{collection.name}</Text>
                    </Group>
                )}
                {(view !== 'collections' || collection) && (
                    <Group>
                        <Button
                            disabled={busy || !entries.some((entry) => entry.status === 'ready')}
                            onClick={() => {
                                void run(() => play(entries, Play.NOW));
                            }}
                        >
                            {t('musicCache.playAll')}
                        </Button>
                        <Button
                            disabled={busy || !entries.some((entry) => entry.status === 'ready')}
                            onClick={() => {
                                void run(() => play(entries, Play.LAST));
                            }}
                            variant="default"
                        >
                            {t('musicCache.addToQueue')}
                        </Button>
                    </Group>
                )}
                <ScrollArea className={styles.list} scrollX>
                    {view === 'collections' && !collection ? (
                        <Stack>
                            {data?.collections
                                .filter((item) =>
                                    `${item.name} ${item.serverName} ${item.account}`
                                        .toLocaleLowerCase()
                                        .includes(text),
                                )
                                .map((item) => {
                                    const keys = item.pendingKeys || item.keys;
                                    const completed = keys.filter(
                                        (key) => entriesByKey.get(key)?.status === 'ready',
                                    ).length;
                                    return (
                                        <Group justify="space-between" key={item.key}>
                                            <Button
                                                onClick={() => setSelected(item.key)}
                                                variant="subtle"
                                            >
                                                {item.name}
                                            </Button>
                                            <Text isMuted size="sm">
                                                {t(`musicCache.${item.type}`)} · {item.serverName} ·{' '}
                                                {completed}/{keys.length}
                                            </Text>
                                            <Group gap="xs">
                                                <Button
                                                    disabled={busy}
                                                    onClick={() => {
                                                        void run(() => updateCollection(item));
                                                    }}
                                                    size="xs"
                                                    variant="default"
                                                >
                                                    {t('musicCache.update')}
                                                </Button>
                                                {item.pendingKeys && (
                                                    <Button
                                                        disabled={busy}
                                                        onClick={() => {
                                                            void run(() =>
                                                                window.api.musicCache.cancel(
                                                                    item.key,
                                                                    true,
                                                                ),
                                                            );
                                                        }}
                                                        size="xs"
                                                        variant="default"
                                                    >
                                                        {t('common.cancel')}
                                                    </Button>
                                                )}
                                                <Button
                                                    disabled={busy}
                                                    onClick={() => remove(item.key, true)}
                                                    size="xs"
                                                    variant="default"
                                                >
                                                    {t('musicCache.removeCollection')}
                                                </Button>
                                            </Group>
                                        </Group>
                                    );
                                })}
                            {!data?.collections.length && (
                                <Text isMuted>{t('musicCache.empty')}</Text>
                            )}
                        </Stack>
                    ) : (
                        <Table highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('musicCache.song')}</Table.Th>
                                    <Table.Th>{t('musicCache.source')}</Table.Th>
                                    <Table.Th>{t('musicCache.quality')}</Table.Th>
                                    <Table.Th>{t('musicCache.statusLabel')}</Table.Th>
                                    <Table.Th>{t('musicCache.actions')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {entries.map((entry, index) => (
                                    <Table.Tr key={`${entry.key}:${index}`}>
                                        <Table.Td>
                                            <Text weight={500}>{entry.song.name}</Text>
                                            <Text isMuted size="sm">
                                                {entry.song.artistName} · {entry.song.album}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">{entry.serverName}</Text>
                                            <Text isMuted size="xs">
                                                {entry.account}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">
                                                {entry.profile.enabled
                                                    ? `${entry.profile.format || 'MP3'} ${entry.profile.bitrate || ''}`
                                                    : t('musicCache.original')}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge>{t(`musicCache.status.${entry.status}`)}</Badge>
                                            <Text isMuted size="xs">
                                                {formatSizeString(
                                                    entry.status === 'ready'
                                                        ? entry.bytes
                                                        : entry.downloadedBytes,
                                                )}
                                            </Text>
                                            {entry.status === 'downloading' && entry.totalBytes && (
                                                <Progress
                                                    value={Math.min(
                                                        100,
                                                        (entry.downloadedBytes / entry.totalBytes) *
                                                            100,
                                                    )}
                                                />
                                            )}
                                            {entry.error && <Text size="xs">{entry.error}</Text>}
                                        </Table.Td>
                                        <Table.Td>
                                            <Group gap="xs">
                                                {entry.status === 'ready' ? (
                                                    <>
                                                        <Button
                                                            disabled={busy}
                                                            onClick={() => {
                                                                void run(() =>
                                                                    play([entry], Play.NOW),
                                                                );
                                                            }}
                                                            size="xs"
                                                        >
                                                            {t('player.play')}
                                                        </Button>
                                                        <Button
                                                            disabled={busy}
                                                            onClick={() => {
                                                                void run(() =>
                                                                    play([entry], Play.LAST),
                                                                );
                                                            }}
                                                            size="xs"
                                                            variant="default"
                                                        >
                                                            {t('musicCache.addToQueue')}
                                                        </Button>
                                                        {!entry.directSaved && (
                                                            <Button
                                                                disabled={busy}
                                                                onClick={() => {
                                                                    void run(() =>
                                                                        window.api.musicCache.save({
                                                                            items: [
                                                                                {
                                                                                    descriptor:
                                                                                        entry,
                                                                                },
                                                                            ],
                                                                        }),
                                                                    );
                                                                }}
                                                                size="xs"
                                                                variant="default"
                                                            >
                                                                {t('musicCache.keep')}
                                                            </Button>
                                                        )}
                                                        {entry.directSaved && (
                                                            <Button
                                                                disabled={busy}
                                                                onClick={() => {
                                                                    void run(() =>
                                                                        window.api.musicCache.cancel(
                                                                            entry.key,
                                                                        ),
                                                                    );
                                                                }}
                                                                size="xs"
                                                                variant="default"
                                                            >
                                                                {t('musicCache.cancelSave')}
                                                            </Button>
                                                        )}
                                                    </>
                                                ) : (
                                                    entry.saved && (
                                                        <>
                                                            {entry.status === 'queued' ||
                                                            entry.status === 'downloading' ? (
                                                                <Button
                                                                    disabled={busy}
                                                                    onClick={() => {
                                                                        void run(() =>
                                                                            window.api.musicCache.cancel(
                                                                                entry.key,
                                                                            ),
                                                                        );
                                                                    }}
                                                                    size="xs"
                                                                    variant="default"
                                                                >
                                                                    {t('common.cancel')}
                                                                </Button>
                                                            ) : (
                                                                <Button
                                                                    disabled={busy}
                                                                    onClick={() => {
                                                                        void run(() =>
                                                                            retryOfflineSong(entry),
                                                                        );
                                                                    }}
                                                                    size="xs"
                                                                    variant="default"
                                                                >
                                                                    {t('common.retry')}
                                                                </Button>
                                                            )}
                                                        </>
                                                    )
                                                )}
                                                <Button
                                                    disabled={busy}
                                                    onClick={() => remove(entry.key)}
                                                    size="xs"
                                                    variant="default"
                                                >
                                                    {t('musicCache.removeFile')}
                                                </Button>
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                                {!entries.length && (
                                    <Table.Tr>
                                        <Table.Td colSpan={5}>
                                            <Text isMuted>{t('musicCache.empty')}</Text>
                                        </Table.Td>
                                    </Table.Tr>
                                )}
                            </Table.Tbody>
                        </Table>
                    )}
                </ScrollArea>
                <details className={styles.settings}>
                    <summary>{t('musicCache.settings')}</summary>
                    <MusicCacheSettingsSection />
                </details>
            </div>
        </AnimatedPage>
    );
};

export default LocalMusicRoute;
