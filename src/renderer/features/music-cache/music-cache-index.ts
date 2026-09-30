import type { QueueSong, Song } from '../../../shared/types/domain-types';
import type { MusicCacheEntry } from '../../../shared/types/music-cache';

import { musicCacheSongFingerprint } from '../../../shared/types/music-cache';

const songIdentity = (song: Song, account: string) =>
    JSON.stringify([song._serverId, account, song.id, musicCacheSongFingerprint(song)]);

export const createMusicCacheIndex = (entries: MusicCacheEntry[]) => {
    const byKey = new Map<string, MusicCacheEntry[]>();
    const bySong = new Map<string, MusicCacheEntry[]>();
    for (const entry of entries) {
        if (entry.status !== 'ready' || entry.deletePending) continue;
        byKey.set(entry.key, [entry]);
        const identity = songIdentity(entry.song, entry.account);
        const matches = bySong.get(identity) || [];
        matches.push(entry);
        bySong.set(identity, matches);
    }
    return { byKey, bySong };
};

export const getSongCacheEntries = (
    index: ReturnType<typeof createMusicCacheIndex>,
    song: Partial<Pick<QueueSong, '_localCacheKey'>> & Song,
    account?: string,
) => {
    if (song._localCacheKey) return index.byKey.get(song._localCacheKey);
    if (account === undefined) return undefined;
    return index.bySong.get(songIdentity(song, account));
};
