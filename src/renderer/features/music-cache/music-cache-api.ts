import type { TranscodingConfig } from '/@/renderer/store';
import type { QueueSong, Song } from '/@/shared/types/domain-types';
import type {
    MusicCacheDescriptor,
    MusicCacheEntry,
    MusicCacheSaveRequest,
} from '/@/shared/types/music-cache';

import isElectron from 'is-electron';

import { api } from '/@/renderer/api';
import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { getServerById, useSettingsStore } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

export const getCacheDescriptor = (
    song: Song,
    transcode: Partial<TranscodingConfig>,
): MusicCacheDescriptor => {
    const server = getServerById(song._serverId);
    if (!server) throw new Error('Server configuration is unavailable');
    const enabled = transcode.enabled ?? false;
    return {
        account: server.userId || server.username,
        profile: {
            bitrate: enabled ? (transcode.bitrate ?? null) : null,
            enabled,
            format: enabled ? transcode.format?.toLowerCase() || null : null,
            maxSampleRate: enabled ? (transcode.maxSampleRate ?? null) : null,
        },
        serverName: server.name,
        song,
    };
};

export const getMpvSongUrl = async (
    song: QueueSong,
    transcode: Partial<TranscodingConfig>,
    skipAutoTranscode = true,
): Promise<string | undefined> => {
    const cache = isElectron() ? window.api.musicCache : null;
    if (song._localCacheKey) {
        const file = await cache?.lookup({ key: song._localCacheKey });
        if (!file)
            throw new Error('Local audio file is missing. Download it again from Local music.');
        return file;
    }
    let descriptor: MusicCacheDescriptor | undefined;
    if (cache) {
        try {
            descriptor = getCacheDescriptor(song, transcode);
            const file = await cache.lookup({ descriptor });
            if (file) return file;
        } catch {
            logger.warn('Music cache lookup unavailable, using server playback', {
                serverId: song._serverId,
                songId: song.id,
            });
        }
    }
    const url = await getSongUrl(song, transcode, skipAutoTranscode);
    if (cache && descriptor) {
        try {
            return await cache.register(descriptor, url);
        } catch {
            logger.warn('Music cache proxy unavailable, using server playback', {
                serverId: song._serverId,
                songId: song.id,
            });
        }
    }
    return url;
};

export const saveSongsOffline = async (
    songs: Song[],
    collection?: MusicCacheSaveRequest['collection'],
) => {
    if (!isElectron()) return;
    if (!songs.length) throw new Error('There are no songs to save in this collection');
    const transcode = useSettingsStore.getState().playback.transcode;
    const items: MusicCacheSaveRequest['items'] = [];
    const resolved = new Map<string, MusicCacheSaveRequest['items'][number]>();
    for (const song of songs) {
        const identity = `${song._serverId}:${song.id}`;
        let item = resolved.get(identity);
        if (!item) {
            const descriptor = getCacheDescriptor(song, transcode);
            const file = await window.api.musicCache.lookup({ descriptor });
            item = {
                descriptor,
                url: file
                    ? undefined
                    : await api.controller.getStreamUrl({
                          apiClientProps: { serverId: song._serverId },
                          query: {
                              bitrate: transcode.bitrate,
                              container: song.container,
                              format: transcode.format,
                              id: song.id,
                              maxSampleRate: transcode.maxSampleRate,
                              sampleRate: song.sampleRate,
                              skipAutoTranscode: true,
                              transcode: transcode.enabled,
                          },
                      }),
            };
            resolved.set(identity, item);
        }
        items.push(item);
    }
    await window.api.musicCache.save({ collection, items });
};

export const retryOfflineSong = async (entry: MusicCacheEntry) => {
    const server = getServerById(entry.song._serverId);
    if (!server || (server.userId || server.username) !== entry.account) {
        throw new Error('Reconnect to the original server account before retrying this download');
    }
    const url = await api.controller.getStreamUrl({
        apiClientProps: { serverId: entry.song._serverId },
        query: {
            bitrate: entry.profile.bitrate ?? undefined,
            container: entry.song.container,
            format: entry.profile.format ?? undefined,
            id: entry.song.id,
            maxSampleRate: entry.profile.maxSampleRate ?? undefined,
            sampleRate: entry.song.sampleRate,
            skipAutoTranscode: true,
            transcode: entry.profile.enabled,
        },
    });
    await window.api.musicCache.retry(entry.key, url);
};

export const getOfflineCollectionSongs = async (
    serverId: string,
    id: string,
    type: 'album' | 'playlist',
) => {
    if (type === 'playlist') {
        // Keep the server order, including repeated tracks, for an offline snapshot.
        return (
            await api.controller.getPlaylistSongList({
                apiClientProps: { serverId },
                query: { id },
            })
        ).items;
    }
    const tracks: Song[] = [];
    let startIndex = 0;
    while (true) {
        const page = await api.controller.getSongList({
            apiClientProps: { serverId },
            query: {
                albumIds: [id],
                limit: 500,
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });
        tracks.push(...page.items);
        startIndex += page.items.length;
        if (
            !page.items.length ||
            (page.totalRecordCount != null
                ? startIndex >= page.totalRecordCount
                : page.items.length < 500)
        )
            break;
    }
    return tracks.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
};
