import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { Song } from '../src/shared/types/domain-types';
import type { MusicCacheEntry, MusicCacheStatus } from '../src/shared/types/music-cache';

import { musicCacheKey } from '../src/main/features/core/music-cache/cache';
import {
    createMusicCacheIndex,
    getSongCacheEntries,
} from '../src/renderer/features/music-cache/music-cache-index';

const song = {
    _serverId: 'server',
    bitDepth: 16,
    channels: 2,
    container: 'flac',
    duration: 120000,
    id: 'song',
    name: 'Track',
    sampleRate: 44100,
    size: 123456,
} as Song;

const entry = (overrides: Partial<MusicCacheEntry> = {}): MusicCacheEntry => ({
    account: 'alice',
    bytes: song.size,
    directSaved: false,
    downloadedBytes: song.size,
    error: null,
    key: 'original',
    lastUsed: 0,
    profile: { bitrate: null, enabled: false, format: null, maxSampleRate: null },
    saved: false,
    serverName: 'Music',
    song,
    status: 'ready',
    totalBytes: song.size,
    ...overrides,
});

test('only complete entries that are not pending deletion are indexed', () => {
    const incomplete: MusicCacheStatus[] = [
        'queued',
        'downloading',
        'failed',
        'interrupted',
        'missing',
    ];
    const index = createMusicCacheIndex([
        ...incomplete.map((status) => entry({ key: status, status })),
        entry({ deletePending: true }),
    ]);
    expect(index.byKey.size).toBe(0);
    expect(getSongCacheEntries(index, song, 'alice')).toBeUndefined();
    expect(getSongCacheEntries(createMusicCacheIndex([]), song, 'alice')).toBeUndefined();
});

test('all ready qualities match, including collection saves without a direct save', () => {
    const automatic = entry();
    const saved = entry({
        key: 'opus',
        profile: { bitrate: 128, enabled: true, format: 'opus', maxSampleRate: 48000 },
        saved: true,
    });
    const matches = getSongCacheEntries(createMusicCacheIndex([automatic, saved]), song, 'alice');
    expect(matches).toEqual([automatic, saved]);
    expect(matches?.some((match) => match.saved)).toBe(true);
    expect(saved.directSaved).toBe(false);
});

test('server, account, song ID and every audio fingerprint field must match', () => {
    const index = createMusicCacheIndex([entry()]);
    expect(getSongCacheEntries(index, song, 'bob')).toBeUndefined();
    expect(getSongCacheEntries(index, song)).toBeUndefined();
    for (const change of [
        { _serverId: 'other' },
        { id: 'other' },
        { size: song.size + 1 },
        { duration: song.duration + 1 },
        { container: 'mp3' },
        { sampleRate: 48000 },
        { bitDepth: 24 },
        { channels: 1 },
    ]) {
        expect(getSongCacheEntries(index, { ...song, ...change }, 'alice')).toBeUndefined();
    }
    expect(getSongCacheEntries(index, { ...song, name: 'Renamed' }, 'alice')).toHaveLength(1);
});

test('local keys match exactly without the server account and never fall back', () => {
    const index = createMusicCacheIndex([entry(), entry({ key: 'opus', saved: true })]);
    expect(getSongCacheEntries(index, { ...song, _localCacheKey: 'opus' })).toEqual([
        entry({ key: 'opus', saved: true }),
    ]);
    expect(
        getSongCacheEntries(index, { ...song, _localCacheKey: 'absent' }, 'alice'),
    ).toBeUndefined();
});

test('new snapshots reflect download completion, promotion, demotion and removal', () => {
    const matches = (entries: MusicCacheEntry[]) =>
        getSongCacheEntries(createMusicCacheIndex(entries), song, 'alice');
    expect(matches([entry({ status: 'downloading' })])).toBeUndefined();
    expect(matches([entry()])?.[0].saved).toBe(false);
    expect(matches([entry({ saved: true })])?.[0].saved).toBe(true);
    expect(matches([entry({ directSaved: false, saved: false })])?.[0].saved).toBe(false);
    expect(matches([entry({ status: 'missing' })])).toBeUndefined();
    expect(matches([])).toBeUndefined();
});

test('sharing the fingerprint helper preserves existing cache keys', () => {
    const expected = createHash('sha256')
        .update(
            JSON.stringify([
                'server',
                'alice',
                'song',
                [false, null, null, null],
                [123456, 120000, 'flac', 44100, 16, 2],
            ]),
        )
        .digest('hex');
    expect(musicCacheKey(entry())).toBe(expected);
});
