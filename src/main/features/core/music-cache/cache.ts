import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    statfs,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import type {
    MusicCacheCollection,
    MusicCacheDescriptor,
    MusicCacheEntry,
    MusicCacheSaveRequest,
    MusicCacheSettings,
    MusicCacheSnapshot,
} from '../../../../shared/types/music-cache';

const GIB = 1024 ** 3;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const musicCacheKey = ({ account, profile, song }: MusicCacheDescriptor) =>
    hash([
        song._serverId,
        account,
        song.id,
        [profile.enabled, profile.format, profile.bitrate, profile.maxSampleRate],
        [song.size, song.duration, song.container, song.sampleRate, song.bitDepth, song.channels],
    ]);

interface Job {
    cacheEnabled: boolean;
    controller: AbortController;
    done: Promise<void>;
    playback: boolean;
}

interface Manifest {
    collections: Record<string, MusicCacheCollection>;
    entries: Record<string, MusicCacheEntry>;
    settings: MusicCacheSettings;
    version: 1;
}

interface Options {
    changed?: () => void;
    fetch: (url: string, options?: RequestInit) => Promise<Response>;
    minimumFreeBytes?: number;
    validateAudio: (path: string, descriptor: MusicCacheDescriptor) => Promise<void>;
    warn?: (key: string, reason: string) => void;
}

export class MusicCache {
    private closing = false;
    private draining = false;
    private error: null | string = null;
    private readonly held = new Set<string>();
    private readonly initialized: Promise<void>;
    private readonly jobs = new Map<string, Job>();
    private manifest: Manifest = {
        collections: {},
        entries: {},
        settings: { enabled: true, maxBytes: 5 * GIB },
        version: 1,
    };
    private notificationTimer: ReturnType<typeof setTimeout> | undefined;
    private persistence = Promise.resolve();
    private readonly queue = new Set<string>();
    private readonly reservations = new Map<string, number>();
    private readonly routes = new Map<string, string>();
    private readonly server = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        });
    });
    private serverStarted: Promise<number> | undefined;
    private readonly urls = new Map<string, string>();

    constructor(
        private readonly directory: string,
        private readonly options: Options,
    ) {
        this.initialized = this.initialize();
    }

    async cancel(key: string, collection = false) {
        await this.ready();
        if (collection) {
            const item = this.manifest.collections[key];
            if (item) {
                delete item.pendingKeys;
                if (!item.keys.length) delete this.manifest.collections[key];
            }
        } else {
            const entry = this.manifest.entries[key];
            if (entry) entry.directSaved = false;
            for (const item of Object.values(this.manifest.collections)) {
                if (item.pendingKeys?.includes(key)) {
                    // Cancel the snapshot update rather than silently saving an incomplete collection.
                    delete item.pendingKeys;
                    if (!item.keys.length) delete this.manifest.collections[item.key];
                }
            }
        }
        this.refreshSaved();
        for (const entry of Object.values(this.manifest.entries)) {
            if (!entry.saved) {
                this.queue.delete(entry.key);
                const job = this.jobs.get(entry.key);
                if (job && !job.playback) job.controller.abort();
            }
        }
        await this.persist();
        await this.trim();
        this.changed();
    }
    async clearAutomatic() {
        await this.ready();
        for (const entry of Object.values(this.manifest.entries)) {
            if (!entry.saved) await this.deleteEntry(entry.key);
        }
        await this.persist();
        this.changed();
    }

    async close() {
        this.closing = true;
        await this.initialized;
        this.queue.clear();
        for (const job of this.jobs.values()) job.controller.abort();
        await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
        if (this.server.listening) {
            this.server.closeAllConnections();
            await new Promise<void>((resolve) => this.server.close(() => resolve()));
        }
        clearTimeout(this.notificationTimer);
        await this.persistence;
    }

    async configure(settings: MusicCacheSettings) {
        await this.ready();
        this.manifest.settings = settings;
        if (!settings.enabled) {
            for (const [key, job] of this.jobs) {
                if (!this.manifest.entries[key]?.saved) job.cacheEnabled = false;
            }
        }
        await this.trim();
        await this.persist();
        this.changed();
    }

    async holdSources(sources: (string | undefined)[]) {
        await this.ready();
        const prior = new Set(this.held);
        this.held.clear();
        for (const [key] of Object.entries(this.manifest.entries)) {
            if (sources.includes(this.file(key))) this.held.add(key);
        }
        for (const source of sources) {
            if (!source) continue;
            try {
                const key = this.routes.get(new URL(source).pathname.split('/').pop() || '');
                if (key) this.held.add(key);
            } catch {
                /* File paths are handled above. */
            }
        }
        for (const key of prior) {
            if (!this.held.has(key)) this.reservations.delete(key);
        }
        for (const entry of Object.values(this.manifest.entries)) {
            if (entry.deletePending && !this.protected(entry.key)) await this.erase(entry.key);
        }
        for (const [token, key] of this.routes) {
            if (!this.protected(key) && !this.jobs.has(key) && !this.queue.has(key)) {
                this.routes.delete(token);
                this.urls.delete(key);
            }
        }
        await this.trim();
        await this.persist();
        this.changed();
    }

    async lookup(descriptor?: MusicCacheDescriptor, key?: string): Promise<null | string> {
        await this.ready();
        const entry = this.manifest.entries[key || (descriptor && musicCacheKey(descriptor)) || ''];
        if (!entry || entry.deletePending || entry.status !== 'ready') return null;
        const info = await stat(this.file(entry.key)).catch(() => null);
        if (!info || info.size !== entry.bytes) {
            entry.status = 'missing';
            entry.error = 'Local audio file is missing';
            await this.persist();
            this.changed();
            return null;
        }
        entry.lastUsed = Date.now();
        this.reserve(entry.key);
        await this.persist();
        return this.file(entry.key);
    }

    async register(descriptor: MusicCacheDescriptor, url: string) {
        await this.ready();
        if (!['http:', 'https:'].includes(new URL(url).protocol))
            throw new Error('Invalid audio source');
        if (!this.manifest.settings.enabled) return url;
        const previous = this.manifest.entries[musicCacheKey(descriptor)];
        if (previous?.deletePending) {
            if (this.protected(previous.key) || this.jobs.has(previous.key)) return url;
            await this.erase(previous.key);
        }
        const entry = this.entry(descriptor);
        this.urls.set(entry.key, url);
        this.reserve(entry.key);
        let token = [...this.routes].find(([, key]) => key === entry.key)?.[0];
        if (!token) {
            token = randomUUID();
            this.routes.set(token, entry.key);
        }
        return `http://127.0.0.1:${await this.port()}/audio/${token}`;
    }

    async remove(key: string, collection = false) {
        await this.ready();
        if (collection) {
            delete this.manifest.collections[key];
            this.refreshSaved();
            for (const entry of Object.values(this.manifest.entries)) {
                if (!entry.saved) {
                    this.queue.delete(entry.key);
                    const job = this.jobs.get(entry.key);
                    if (job && !job.playback) job.controller.abort();
                }
            }
        } else {
            for (const item of Object.values(this.manifest.collections)) {
                item.keys = item.keys.filter((value) => value !== key);
                if (item.pendingKeys)
                    item.pendingKeys = item.pendingKeys.filter((value) => value !== key);
            }
            await this.deleteEntry(key);
        }
        await this.trim();
        await this.persist();
        this.changed();
    }

    async retry(key: string, url: string) {
        await this.ready();
        const entry = this.manifest.entries[key];
        if (!entry?.saved || entry.deletePending) throw new Error('Saved song not found');
        if (!['http:', 'https:'].includes(new URL(url).protocol))
            throw new Error('Invalid audio source');
        if (entry.status === 'ready') return;
        this.urls.set(key, url);
        if (entry.status !== 'downloading') entry.status = 'queued';
        entry.error = null;
        this.queue.add(key);
        await this.persist();
        this.changed();
        void this.drain();
    }

    async save(request: MusicCacheSaveRequest) {
        await this.ready();
        const entries = request.items.map(({ descriptor, url }) => {
            const entry = this.entry(descriptor);
            entry.deletePending = false;
            if (url) {
                if (!['http:', 'https:'].includes(new URL(url).protocol))
                    throw new Error('Invalid audio source');
                this.urls.set(entry.key, url);
            }
            if (
                entry.status !== 'ready' &&
                !this.jobs.has(entry.key) &&
                !this.urls.has(entry.key)
            ) {
                throw new Error('Audio source is required to save this song');
            }
            return entry;
        });
        if (request.collection && entries.length) {
            const first = entries[0];
            const key = hash([
                first.song._serverId,
                first.account,
                request.collection.type,
                request.collection.id,
            ]);
            const prior = this.manifest.collections[key];
            this.manifest.collections[key] = {
                ...request.collection,
                account: first.account,
                key,
                keys: prior?.keys || [],
                pendingKeys: entries.map((entry) => entry.key),
                serverId: first.song._serverId,
                serverName: first.serverName,
            };
        } else {
            for (const entry of entries) entry.directSaved = true;
        }
        this.refreshSaved();
        for (const entry of entries) {
            if (entry.status !== 'ready') {
                entry.deletePending = false;
                if (entry.status !== 'downloading') entry.status = 'queued';
                entry.error = null;
                this.queue.add(entry.key);
            }
        }
        this.finishCollections();
        await this.persist();
        this.changed();
        void this.drain();
    }

    async snapshot(): Promise<MusicCacheSnapshot> {
        await this.initialized;
        const entries = Object.values(this.manifest.entries).filter(
            (entry) =>
                !entry.deletePending &&
                (entry.saved || entry.status === 'ready' || entry.status === 'downloading'),
        );
        return {
            automaticBytes: entries
                .filter((entry) => !entry.saved)
                .reduce((sum, entry) => sum + entry.bytes, 0),
            collections: Object.values(this.manifest.collections),
            entries,
            error: this.error,
            savedBytes: entries
                .filter((entry) => entry.saved)
                .reduce((sum, entry) => sum + entry.bytes, 0),
            settings: { ...this.manifest.settings },
        };
    }

    private changed() {
        if (this.notificationTimer) return;
        this.notificationTimer = setTimeout(() => {
            this.notificationTimer = undefined;
            this.options.changed?.();
        }, 200);
    }

    private async deleteEntry(key: string) {
        const entry = this.manifest.entries[key];
        if (!entry) return;
        this.queue.delete(key);
        const job = this.jobs.get(key);
        if (job) {
            job.cacheEnabled = false;
            if (!job.playback) job.controller.abort();
        }
        if (this.protected(key) || job) entry.deletePending = true;
        else await this.erase(key);
    }

    private async drain() {
        if (this.draining || this.closing) return;
        this.draining = true;
        try {
            for (const key of this.queue) {
                this.queue.delete(key);
                const entry = this.manifest.entries[key];
                if (!entry?.saved || entry.status === 'ready') continue;
                const active = this.jobs.get(key);
                if (active) {
                    await active.done;
                    if (!entry.saved || (entry.status as string) === 'ready' || this.closing)
                        continue;
                }
                await this.transfer(key);
                if (this.closing) break;
            }
        } catch {
            this.options.warn?.('queue', 'Offline download queue failed');
        } finally {
            this.draining = false;
        }
    }

    private async ensureSpace(bytes: number) {
        const info = await statfs(this.directory);
        if (info.bavail * info.bsize < bytes + (this.options.minimumFreeBytes ?? GIB)) {
            throw new Error('Not enough free disk space');
        }
    }

    private entry(descriptor: MusicCacheDescriptor) {
        const key = musicCacheKey(descriptor);
        if (!this.manifest.entries[key]) {
            const song = { ...descriptor.song, imageId: null, imageUrl: null };
            for (const name of [
                '_uniqueId',
                '_contextPlaylistId',
                '_localCacheKey',
                'playlistItemId',
            ]) {
                delete (song as unknown as Record<string, unknown>)[name];
            }
            const withoutImages = <T extends { imageId: null | string; imageUrl: null | string }>(
                items: T[],
            ) => items?.map((item) => ({ ...item, imageId: null, imageUrl: null }));
            song.artists = withoutImages(song.artists);
            song.albumArtists = withoutImages(song.albumArtists);
            song.genres = withoutImages(song.genres);
            if (song.participants) {
                song.participants = Object.fromEntries(
                    Object.entries(song.participants).map(([role, artists]) => [
                        role,
                        withoutImages(artists),
                    ]),
                );
            }
            this.manifest.entries[key] = {
                ...descriptor,
                bytes: 0,
                directSaved: false,
                downloadedBytes: 0,
                error: null,
                key,
                lastUsed: Date.now(),
                saved: false, // Image URLs can contain server credentials. Local views use placeholders.
                song,
                status: 'queued',
                totalBytes: null,
            };
        }
        return this.manifest.entries[key];
    }

    private async erase(key: string) {
        await rm(this.file(key), { force: true });
        if (!this.jobs.has(key)) await rm(this.part(key), { force: true });
        delete this.manifest.entries[key];
        this.urls.delete(key);
    }

    private file(key: string) {
        return join(this.directory, `${key}.audio`);
    }

    private finishCollections() {
        for (const collection of Object.values(this.manifest.collections)) {
            if (
                collection.pendingKeys?.every(
                    (key) => this.manifest.entries[key]?.status === 'ready',
                )
            ) {
                collection.keys = collection.pendingKeys;
                delete collection.pendingKeys;
            }
        }
        this.refreshSaved();
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse) {
        await this.ready();
        if (this.closing) {
            response.writeHead(503);
            response.end();
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405);
            response.end();
            return;
        }
        const token = request.url?.match(/^\/audio\/([a-f0-9-]+)$/)?.[1];
        const key = token && this.routes.get(token);
        const entry = key && this.manifest.entries[key];
        if (!key || !entry || (entry.deletePending && !this.protected(key))) {
            response.writeHead(404);
            response.end();
            return;
        }
        if (entry.status === 'ready') {
            // A leased file remains playable until MPV releases it, even after a clear.
            const path = entry.deletePending
                ? (await stat(this.file(key)).catch(() => null))?.size === entry.bytes
                    ? this.file(key)
                    : null
                : await this.lookup(undefined, key);
            if (path) {
                const size = entry.bytes;
                const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
                let start = 0;
                let end = size - 1;
                if (request.headers.range) {
                    if (!range || (!range[1] && !range[2])) {
                        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
                        response.end();
                        return;
                    }
                    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
                    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
                    if (start > end || start >= size) {
                        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
                        response.end();
                        return;
                    }
                }
                response.writeHead(range ? 206 : 200, {
                    'Accept-Ranges': 'bytes',
                    'Content-Length': end - start + 1,
                    'Content-Type': 'application/octet-stream',
                    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
                });
                if (request.method === 'HEAD') response.end();
                else {
                    const stream = createReadStream(path, { end, start });
                    stream.on('error', () => response.destroy());
                    response.once('close', () => stream.destroy());
                    stream.pipe(response);
                }
                return;
            }
        }
        if (
            this.jobs.has(key) ||
            request.method === 'HEAD' ||
            (request.headers.range && !/^bytes=0-/.test(request.headers.range))
        ) {
            // Concurrent seek/probe requests retain normal HTTP behavior; only one writes the cache.
            const job: Job = {
                cacheEnabled: false,
                controller: new AbortController(),
                done: Promise.resolve(),
                playback: true,
            };
            await this.receive(key, job, request, response);
        } else {
            await this.transfer(key, request, response);
        }
    }

    private async initialize() {
        try {
            await mkdir(this.directory, { recursive: true });
            let raw: string | undefined;
            try {
                raw = await readFile(join(this.directory, 'index.json'), 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (raw) {
                const data = JSON.parse(raw) as Manifest;
                if (
                    data.version !== 1 ||
                    !data.entries ||
                    !data.collections ||
                    typeof data.settings?.enabled !== 'boolean' ||
                    !Number.isFinite(data.settings.maxBytes) ||
                    data.settings.maxBytes <= 0
                )
                    throw new Error('Invalid cache index');
                for (const [key, entry] of Object.entries(data.entries)) {
                    if (
                        !/^[a-f0-9]{64}$/.test(key) ||
                        entry.key !== key ||
                        !entry.song?.id ||
                        !Number.isFinite(entry.bytes) ||
                        !Number.isFinite(entry.lastUsed)
                    ) {
                        throw new Error('Invalid cache entry');
                    }
                }
                this.manifest = data;
            }
            for (const name of await readdir(this.directory)) {
                if (/^[a-f0-9]{64}\.part$/.test(name) || name === 'index.json.part') {
                    await rm(join(this.directory, name), { force: true });
                }
            }
            this.refreshSaved();
            for (const entry of Object.values(this.manifest.entries)) {
                if (entry.status === 'ready') {
                    const info = await stat(this.file(entry.key)).catch(() => null);
                    if (!info || info.size !== entry.bytes) {
                        entry.status = 'missing';
                        entry.error = 'Local audio file is missing';
                    }
                } else if (entry.status === 'downloading' || entry.status === 'queued') {
                    entry.status = 'interrupted';
                    entry.error = 'Download interrupted';
                    entry.downloadedBytes = 0;
                }
                if (entry.deletePending) await this.erase(entry.key);
                else if (!entry.saved && entry.status !== 'ready') {
                    delete this.manifest.entries[entry.key];
                }
            }
            await this.trim();
            await this.persist();
        } catch {
            this.error = 'Music cache is unavailable. Existing audio files have been preserved.';
            this.options.warn?.('index', 'Cache initialization failed');
        }
    }

    private part(key: string) {
        return join(this.directory, `${key}.part`);
    }

    private persist() {
        const json = JSON.stringify(this.manifest);
        // ponytail: one serialized index; use a database if library size makes this costly.
        const write = this.persistence.then(async () => {
            await writeFile(join(this.directory, 'index.json.part'), json);
            await rename(
                join(this.directory, 'index.json.part'),
                join(this.directory, 'index.json'),
            );
        });
        this.persistence = write.catch(() => {
            this.error = 'Unable to write the music cache index';
            this.options.warn?.('index', 'Cache index write failed');
            this.changed();
        });
        return write;
    }

    private async port() {
        if (!this.serverStarted) {
            this.serverStarted = new Promise<number>((resolve, reject) => {
                this.server.once('error', reject);
                this.server.listen(0, '127.0.0.1', () => {
                    this.server.removeListener('error', reject);
                    const address = this.server.address();
                    if (address && typeof address !== 'string') resolve(address.port);
                    else reject(new Error('Unable to start music cache proxy'));
                });
            });
        }
        return this.serverStarted;
    }

    private protected(key: string) {
        return this.held.has(key) || (this.reservations.get(key) || 0) > Date.now();
    }

    private async ready() {
        await this.initialized;
        if (this.error) throw new Error(this.error);
    }

    private async receive(
        key: string,
        job: Job,
        request?: IncomingMessage,
        response?: ServerResponse,
    ) {
        const entry = this.manifest.entries[key];
        let file: FileHandle | undefined;
        let finished = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let cacheError: null | string = null;
        const armTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => job.controller.abort(), 15_000);
        };
        const disconnect = () => {
            if (!finished && !response?.writableFinished && !entry.saved) job.controller.abort();
        };
        response?.once('close', disconnect);
        try {
            const url = this.urls.get(key);
            if (!url) throw new Error('Audio source is unavailable');
            armTimeout();
            const upstream = await this.options.fetch(url, {
                headers: {
                    'Accept-Encoding': 'identity',
                    ...(request?.headers.range ? { Range: request.headers.range } : {}),
                    ...(request?.headers['if-range']
                        ? { 'If-Range': request.headers['if-range'] }
                        : {}),
                },
                method: request?.method || 'GET',
                signal: job.controller.signal,
            });
            clearTimeout(timeout);
            const encoded =
                !!upstream.headers.get('content-encoding') &&
                upstream.headers.get('content-encoding') !== 'identity';
            const lengthHeader = upstream.headers.get('content-length');
            const length =
                !encoded && lengthHeader !== null && /^\d+$/.test(lengthHeader)
                    ? Number(lengthHeader)
                    : null;
            const range = upstream.headers
                .get('content-range')
                ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
            const completeRange =
                !!range && Number(range[1]) === 0 && Number(range[2]) + 1 === Number(range[3]);
            const completeResponse =
                upstream.status === 200 || (upstream.status === 206 && completeRange);
            const mime = upstream.headers.get('content-type') || '';
            const eligible =
                completeResponse &&
                request?.method !== 'HEAD' &&
                !/json|html|xml|mpegurl/i.test(mime) &&
                !!upstream.body;
            if (response) {
                const headers: Record<string, string> = {};
                for (const name of [
                    'content-type',
                    'content-length',
                    'content-range',
                    'accept-ranges',
                    'etag',
                    'last-modified',
                ]) {
                    const value = upstream.headers.get(name);
                    if (value !== null && !(encoded && name === 'content-length'))
                        headers[name] = value;
                }
                response.writeHead(upstream.status, headers);
            }
            if (!response && !eligible)
                throw new Error('Server did not return a complete audio file');
            if (eligible && (entry.saved || this.manifest.settings.enabled) && job.cacheEnabled) {
                try {
                    if (
                        !entry.saved &&
                        length !== null &&
                        length > this.manifest.settings.maxBytes
                    ) {
                        throw new Error('Audio exceeds the automatic cache limit');
                    }
                    await this.ensureSpace(length ?? 16 * 1024 ** 2);
                    file = await open(this.part(key), 'w');
                    entry.status = 'downloading';
                    entry.downloadedBytes = 0;
                    entry.totalBytes = length;
                    entry.error = null;
                    this.changed();
                } catch (error) {
                    cacheError = (error as Error).message;
                }
            }
            const reader = upstream.body?.getReader();
            let bytes = 0;
            let checkedBytes = 0;
            try {
                while (reader) {
                    armTimeout();
                    const chunk = await reader.read();
                    clearTimeout(timeout);
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (file && job.cacheEnabled && !cacheError) {
                        try {
                            if (bytes - checkedBytes >= 16 * 1024 ** 2) {
                                await this.ensureSpace(16 * 1024 ** 2 + chunk.value.byteLength);
                                checkedBytes = bytes;
                            }
                            if (!entry.saved) {
                                await this.trim(bytes);
                                const other = Object.values(this.manifest.entries)
                                    .filter((item) => !item.saved && item.key !== key)
                                    .reduce(
                                        (sum, item) =>
                                            sum + Math.max(item.bytes, item.downloadedBytes),
                                        0,
                                    );
                                if (other + bytes > this.manifest.settings.maxBytes)
                                    throw new Error('Automatic cache is full');
                            }
                            await file.writeFile(chunk.value);
                            entry.downloadedBytes = bytes;
                            this.changed();
                        } catch {
                            cacheError = 'Unable to write audio cache';
                            this.options.warn?.(key, 'Cache write failed; playback continues');
                        }
                    }
                    if (response && !response.destroyed) {
                        if (!response.write(chunk.value)) {
                            await new Promise<void>((resolve) => {
                                const resume = () => {
                                    response.removeListener('drain', resume);
                                    response.removeListener('close', resume);
                                    resolve();
                                };
                                response.once('drain', resume);
                                response.once('close', resume);
                            });
                        }
                    }
                }
            } finally {
                reader?.releaseLock();
            }
            finished = true;
            clearTimeout(timeout);
            response?.end();
            if (file) {
                await file.close();
                file = undefined;
            }
            if (!job.cacheEnabled || !eligible) return;
            if (cacheError) throw new Error(cacheError);
            if (
                !bytes ||
                (length !== null && bytes !== length) ||
                (range && bytes !== Number(range[3]))
            ) {
                throw new Error('Incomplete audio response');
            }
            await this.options.validateAudio(this.part(key), entry);
            await rename(this.part(key), this.file(key));
            entry.status = 'ready';
            entry.bytes = bytes;
            entry.error = null;
            entry.lastUsed = Date.now();
            this.finishCollections();
            await this.trim();
        } catch (error) {
            if (file) await file.close().catch(() => {});
            if (response && !finished && !response.writableFinished) response.destroy();
            if (!job.cacheEnabled) return;
            entry.status = this.closing ? 'interrupted' : 'failed';
            entry.error = job.controller.signal.aborted
                ? 'Download interrupted'
                : cacheError ||
                  (error instanceof Error &&
                  /^(Incomplete|Audio|Server|Not enough)/.test(error.message)
                      ? error.message
                      : 'Audio download failed');
            entry.downloadedBytes = 0;
            if (entry.saved) this.options.warn?.(key, entry.error);
        } finally {
            clearTimeout(timeout);
            response?.removeListener('close', disconnect);
        }
    }

    private refreshSaved() {
        const retained = new Set(
            Object.values(this.manifest.collections).flatMap((collection) => [
                ...collection.keys,
                ...(collection.pendingKeys || []),
            ]),
        );
        for (const entry of Object.values(this.manifest.entries)) {
            entry.saved = entry.directSaved || retained.has(entry.key);
        }
    }

    private reserve(key: string) {
        this.reservations.set(key, Date.now() + 30_000);
        setTimeout(() => {
            if (this.closing || this.protected(key)) return;
            this.reservations.delete(key);
            if (this.manifest.entries[key]?.deletePending && !this.jobs.has(key)) {
                void this.erase(key)
                    .then(() => this.persist())
                    .then(() => this.changed())
                    .catch(() => this.options.warn?.(key, 'Unable to remove expired audio'));
            }
        }, 30_010).unref();
    }

    private transfer(key: string, request?: IncomingMessage, response?: ServerResponse) {
        const controller = new AbortController();
        const job: Job = {
            cacheEnabled: !this.manifest.entries[key].deletePending,
            controller,
            done: Promise.resolve(),
            playback: !!response,
        };
        this.jobs.set(key, job);
        job.done = this.receive(key, job, request, response).finally(async () => {
            await rm(this.part(key), { force: true }).catch(() => {});
            const entry = this.manifest.entries[key];
            if (entry && !job.cacheEnabled && entry.status !== 'ready') {
                entry.status = 'interrupted';
                entry.downloadedBytes = 0;
            }
            if (entry?.deletePending && !this.protected(key)) {
                await this.erase(key).catch(() =>
                    this.options.warn?.(key, 'Unable to remove released audio'),
                );
            }
            await this.persist().catch(() => {});
            this.jobs.delete(key);
            this.changed();
        });
        return job.done;
    }

    private async trim(additionalBytes = 0) {
        const candidates = Object.values(this.manifest.entries)
            .filter((entry) => !entry.saved && entry.status === 'ready' && !entry.deletePending)
            .sort((a, b) => a.lastUsed - b.lastUsed);
        let bytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
        for (const entry of candidates) {
            if (bytes + additionalBytes <= this.manifest.settings.maxBytes) break;
            if (this.protected(entry.key)) continue;
            await this.erase(entry.key);
            bytes -= entry.bytes;
        }
    }
}
