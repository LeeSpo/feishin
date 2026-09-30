import { afterEach, expect, test } from 'bun:test';
import { parseFile } from 'music-metadata';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Song } from '../src/shared/types/domain-types';
import type { MusicCacheDescriptor, MusicCacheSnapshot } from '../src/shared/types/music-cache';

import { MusicCache, musicCacheKey } from '../src/main/features/core/music-cache/cache';

const audio = Buffer.alloc(16044);
audio.write('RIFF');
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24);
audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(16000, 40);

const descriptor = (id = 'one'): MusicCacheDescriptor => ({
    account: 'alice',
    profile: { bitrate: null, enabled: false, format: null, maxSampleRate: null },
    serverName: 'Music',
    song: {
        _serverId: 'server',
        bitDepth: 16,
        channels: 1,
        container: 'wav',
        duration: 1000,
        id,
        imageId: 'cover',
        imageUrl: 'https://server/image?apiKey=secret',
        name: id,
        sampleRate: 8000,
        size: audio.length,
    } as Song,
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action();
});

const fixture = async (minimumFreeBytes = 0) => {
    const directory = await mkdtemp(join(tmpdir(), 'feishin-music-cache-'));
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    let requests = 0;
    let release: (() => void) | undefined;
    const server: Server = createServer((request, response) => {
        requests++;
        if (request.url === '/json') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{"error":"expired token"}');
            return;
        }
        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Number(range[2]) : audio.length - 1;
        const body = audio.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, {
            'Content-Type': 'audio/wav',
            ...(request.url === '/chunks' ? {} : { 'Content-Length': body.length }),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}),
        });
        if (request.method === 'HEAD') response.end();
        else if (request.url === '/slow') {
            response.write(body.subarray(0, 4000));
            release = () => response.end(body.subarray(4000));
        } else if (request.url === '/short') {
            response.write(body.subarray(0, 4000));
            setTimeout(() => response.destroy(), 10);
        } else {
            response.write(body);
            response.end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server unavailable');
    const url = `http://127.0.0.1:${address.port}`;
    const makeCache = () => {
        const cache = new MusicCache(directory, {
            fetch: globalThis.fetch,
            minimumFreeBytes,
            validateAudio: async (path) => {
                const metadata = await parseFile(path, { duration: true, skipCovers: true });
                if (metadata.format.duration !== 1) throw new Error('Audio validation failed');
            },
        });
        cleanup.push(() => cache.close());
        return cache;
    };
    return { directory, makeCache, release: () => release?.(), requests: () => requests, url };
};

const waitFor = async (cache: MusicCache, predicate: (data: MusicCacheSnapshot) => boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const data = await cache.snapshot();
        if (predicate(data)) return data;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(
        `Cache did not reach expected state: ${JSON.stringify(await cache.snapshot())}`,
    );
};

test('one audio transfer fills cache; range replay and restart use the disk file', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const song = descriptor();
    const proxy = await cache.register(song, `${f.url}/audio?token=secret`);
    expect(Buffer.from(await (await fetch(proxy)).arrayBuffer())).toEqual(audio);
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    expect(f.requests()).toBe(1);
    const replay = await fetch(proxy, { headers: { Range: 'bytes=44-99' } });
    expect(replay.status).toBe(206);
    expect(Buffer.from(await replay.arrayBuffer())).toEqual(audio.subarray(44, 100));
    expect((await fetch(proxy, { method: 'HEAD' })).headers.get('content-length')).toBe(
        String(audio.length),
    );
    expect(f.requests()).toBe(1);
    const path = await cache.lookup(song);
    expect(path).not.toBeNull();
    const manifest = await readFile(join(f.directory, 'index.json'), 'utf8');
    expect(manifest).not.toContain('secret');
    expect(manifest).not.toContain(f.url);
    await cache.close();
    const reopened = f.makeCache();
    expect(await reopened.lookup(song)).toBe(path);
    expect(await readFile(path!)).toEqual(audio);
    expect(f.requests()).toBe(1);
});

test('HEAD and partial seeks never create offline files; a complete 206 does', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/audio`);
    await fetch(proxy, { method: 'HEAD' });
    const partial = await fetch(proxy, { headers: { Range: 'bytes=44-99' } });
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(audio.subarray(44, 100));
    expect(await cache.lookup(descriptor())).toBeNull();
    const full = await fetch(proxy, { headers: { Range: 'bytes=0-' } });
    expect(full.status).toBe(206);
    await full.arrayBuffer();
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    expect(f.requests()).toBe(3);
});

test('unknown-length chunked audio is saved after successful EOF', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    await cache.save({ items: [{ descriptor: descriptor(), url: `${f.url}/chunks` }] });
    const data = await waitFor(cache, (state) => state.entries[0]?.status === 'ready');
    expect(data.savedBytes).toBe(audio.length);
    expect(f.requests()).toBe(1);
});

test('saving during playback promotes the same transfer rather than downloading again', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const song = descriptor();
    const proxy = await cache.register(song, `${f.url}/slow`);
    const playback = await fetch(proxy);
    await waitFor(cache, (data) => data.entries[0]?.downloadedBytes > 0);
    await cache.save({ items: [{ descriptor: song }] });
    f.release();
    await playback.arrayBuffer();
    const data = await waitFor(cache, (state) => state.entries[0]?.status === 'ready');
    expect(data.entries[0].saved).toBe(true);
    expect(f.requests()).toBe(1);
});

test('collection snapshots preserve duplicates, share files and retain overlapping saves', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const item = { descriptor: descriptor(), url: `${f.url}/audio` };
    await cache.save({ collection: { id: 'a', name: 'A', type: 'playlist' }, items: [item, item] });
    await waitFor(cache, (data) => data.collections[0]?.keys.length === 2);
    await cache.save({ collection: { id: 'b', name: 'B', type: 'album' }, items: [item] });
    const data = await cache.snapshot();
    expect(data.entries).toHaveLength(1);
    expect(data.savedBytes).toBe(audio.length);
    expect(f.requests()).toBe(1);
    await cache.remove(data.collections[0].key, true);
    expect((await cache.snapshot()).entries[0].saved).toBe(true);
    await cache.clearAutomatic();
    expect(await cache.lookup(descriptor())).not.toBeNull();
});

test('automatic LRU respects active files and removes them after protection is released', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/audio`);
    await cache.holdSources([proxy]);
    await (await fetch(proxy)).arrayBuffer();
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    const path = await cache.lookup(descriptor());
    await cache.holdSources([path!]);
    await cache.clearAutomatic();
    expect(await readFile(path!)).toEqual(audio);
    await cache.holdSources([]);
    expect(await readdir(f.directory)).not.toContain(`${musicCacheKey(descriptor())}.audio`);
});

test('cache write failure does not interrupt playback and manual saves report failure', async () => {
    const f = await fixture(Number.MAX_SAFE_INTEGER);
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/audio`);
    expect(Buffer.from(await (await fetch(proxy)).arrayBuffer())).toEqual(audio);
    expect(await cache.lookup(descriptor())).toBeNull();
    await cache.save({ items: [{ descriptor: descriptor(), url: `${f.url}/audio` }] });
    const data = await waitFor(cache, (state) => state.entries[0]?.status === 'failed');
    expect(data.entries[0].error).toContain('disk space');
    expect(data.savedBytes).toBe(0);
});

test('shutdown retains interrupted manual tasks; restart removes partial audio', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    await cache.save({ items: [{ descriptor: descriptor(), url: `${f.url}/slow` }] });
    await waitFor(cache, (data) => data.entries[0]?.downloadedBytes > 0);
    await cache.close();
    const reopened = f.makeCache();
    const data = await reopened.snapshot();
    expect(data.entries[0].status).toBe('interrupted');
    expect(data.entries[0].saved).toBe(true);
    expect((await readdir(f.directory)).some((name) => name.endsWith('.part'))).toBe(false);
    expect(await reopened.lookup(descriptor())).toBeNull();
});

test('corrupt indexes preserve existing audio; namespaces and playback qualities are isolated', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    await cache.save({ items: [{ descriptor: descriptor(), url: `${f.url}/audio` }] });
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    await cache.close();
    await writeFile(join(f.directory, 'index.json'), '{broken');
    const reopened = f.makeCache();
    expect((await reopened.snapshot()).error).not.toBeNull();
    expect(await readFile(join(f.directory, `${musicCacheKey(descriptor())}.audio`))).toEqual(
        audio,
    );
    expect(musicCacheKey({ ...descriptor(), account: 'bob' })).not.toBe(
        musicCacheKey(descriptor()),
    );
    expect(
        musicCacheKey({ ...descriptor(), profile: { ...descriptor().profile, enabled: true } }),
    ).not.toBe(musicCacheKey(descriptor()));
});

test('truncated responses and non-audio bodies never become ready entries', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    await cache.save({ items: [{ descriptor: descriptor(), url: `${f.url}/short` }] });
    await waitFor(cache, (data) => data.entries[0]?.status === 'failed');
    expect(await cache.lookup(descriptor())).toBeNull();
    expect((await readdir(f.directory)).filter((name) => name.endsWith('.audio'))).toHaveLength(0);
    await cache.retry(musicCacheKey(descriptor()), `${f.url}/json`);
    await waitFor(cache, (data) => data.entries[0]?.status === 'failed');
    expect(await cache.lookup(descriptor())).toBeNull();
});

test('LRU evicts older automatic files while keeping manual saves outside the quota', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    await cache.configure({ enabled: true, maxBytes: audio.length });
    await cache.save({ items: [{ descriptor: descriptor('saved'), url: `${f.url}/audio` }] });
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    for (const id of ['old', 'new']) {
        const proxy = await cache.register(descriptor(id), `${f.url}/audio`);
        await cache.holdSources([proxy]);
        await (await fetch(proxy)).arrayBuffer();
        await waitFor(cache, (data) =>
            data.entries.some((entry) => entry.song.id === id && entry.status === 'ready'),
        );
        await cache.holdSources([]);
    }
    const data = await cache.snapshot();
    expect(data.entries.map((entry) => entry.song.id).sort()).toEqual(['new', 'saved']);
    expect(data.automaticBytes).toBe(audio.length);
    expect(data.savedBytes).toBe(audio.length);
    await cache.close();
    expect((await f.makeCache().snapshot()).entries).toHaveLength(2);
});

test('a collection keeps its old snapshot until every updated track is ready', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const collection = { id: 'list', name: 'List', type: 'playlist' as const };
    await cache.save({
        collection,
        items: [{ descriptor: descriptor('old'), url: `${f.url}/audio` }],
    });
    await waitFor(cache, (data) => data.collections[0]?.keys.length === 1);
    await cache.save({
        collection,
        items: [{ descriptor: descriptor('new'), url: `${f.url}/slow` }],
    });
    const pending = await waitFor(cache, (data) =>
        data.entries.some((entry) => entry.song.id === 'new' && entry.downloadedBytes > 0),
    );
    expect(pending.collections[0].keys).toEqual([musicCacheKey(descriptor('old'))]);
    expect(pending.entries.every((entry) => entry.saved)).toBe(true);
    f.release();
    const complete = await waitFor(cache, (data) => !data.collections[0]?.pendingKeys);
    expect(complete.collections[0].keys).toEqual([musicCacheKey(descriptor('new'))]);
    expect(complete.entries.find((entry) => entry.song.id === 'old')?.saved).toBe(false);
});

test('canceling a collection update aborts unshared downloads and keeps the previous snapshot', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const collection = { id: 'list', name: 'List', type: 'playlist' as const };
    await cache.save({
        collection,
        items: [{ descriptor: descriptor('old'), url: `${f.url}/audio` }],
    });
    await waitFor(cache, (data) => data.collections[0]?.keys.length === 1);
    await cache.save({
        collection,
        items: [{ descriptor: descriptor('new'), url: `${f.url}/slow` }],
    });
    const pending = await waitFor(cache, (data) =>
        data.entries.some((entry) => entry.song.id === 'new' && entry.downloadedBytes > 0),
    );
    await cache.cancel(pending.collections[0].key, true);
    const data = await waitFor(
        cache,
        (state) => !state.entries.some((entry) => entry.song.id === 'new'),
    );
    expect(data.collections[0].keys).toEqual([musicCacheKey(descriptor('old'))]);
    expect(await cache.lookup(descriptor('old'))).not.toBeNull();
});

test('clearing during playback leaves the stream intact and prevents a completed cache file', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/slow`);
    await cache.holdSources([proxy]);
    const playback = await fetch(proxy);
    await waitFor(cache, (data) => data.entries[0]?.downloadedBytes > 0);
    await cache.clearAutomatic();
    f.release();
    expect(Buffer.from(await playback.arrayBuffer())).toEqual(audio);
    await cache.holdSources([]);
    expect(await cache.lookup(descriptor())).toBeNull();
    expect((await cache.snapshot()).entries).toHaveLength(0);
});

test('a protected cached proxy remains readable after clear, then its file is removed on release', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/audio`);
    await cache.holdSources([proxy]);
    await (await fetch(proxy)).arrayBuffer();
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    await cache.clearAutomatic();
    expect(Buffer.from(await (await fetch(proxy)).arrayBuffer())).toEqual(audio);
    expect(f.requests()).toBe(1);
    await cache.holdSources([]);
    expect((await readdir(f.directory)).filter((name) => name.endsWith('.audio'))).toHaveLength(0);
});

test('disabling the cache midstream does not interrupt audio or keep a partial file', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const proxy = await cache.register(descriptor(), `${f.url}/slow`);
    const playback = await fetch(proxy);
    await waitFor(cache, (data) => data.entries[0]?.downloadedBytes > 0);
    await cache.configure({ enabled: false, maxBytes: audio.length });
    f.release();
    expect(Buffer.from(await playback.arrayBuffer())).toEqual(audio);
    await waitFor(cache, (data) => !data.entries.length);
    expect(await cache.register(descriptor('next'), `${f.url}/audio`)).toBe(`${f.url}/audio`);
});

test('offline metadata excludes authenticated images and transient queue identifiers', async () => {
    const f = await fixture();
    const cache = f.makeCache();
    const song = descriptor();
    song.song.artists = [
        {
            id: 'artist',
            imageId: 'cover',
            imageUrl: 'https://server?secret=token',
            name: 'Artist',
            userFavorite: false,
            userRating: null,
        },
    ];
    Object.assign(song.song, {
        _contextPlaylistId: 'transient-list',
        _localCacheKey: 'queue-cache',
        _uniqueId: 'queue-only',
    });
    await cache.save({ items: [{ descriptor: song, url: `${f.url}/audio?secret=token` }] });
    await waitFor(cache, (data) => data.entries[0]?.status === 'ready');
    await cache.close();
    const manifest = await readFile(join(f.directory, 'index.json'), 'utf8');
    expect(manifest).not.toContain('secret');
    expect(manifest).not.toContain('queue-only');
    expect(manifest).not.toContain('transient-list');
    expect(manifest).not.toContain('queue-cache');
});
