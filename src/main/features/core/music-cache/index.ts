import type { MusicCacheDescriptor, MusicCacheSaveRequest } from '/@/shared/types/music-cache';

import { app, ipcMain, net, shell } from 'electron';
import { parseFile } from 'music-metadata';
import { join } from 'node:path';
import { z } from 'zod';

import { MusicCache } from './cache';

import { getMainWindow } from '/@/main/index';
import log from '/@/main/logger';

const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const urlSchema = z
    .string()
    .max(32768)
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const descriptorSchema = z.object({
    account: z.string().min(1).max(1024),
    profile: z.object({
        bitrate: z.number().finite().nonnegative().nullable(),
        enabled: z.boolean(),
        format: z.string().max(64).nullable(),
        maxSampleRate: z.number().finite().nonnegative().nullable(),
    }),
    serverName: z.string().max(1024),
    song: z
        .object({
            _serverId: z.string().min(1).max(1024),
            duration: z.number().finite().nonnegative(),
            id: z.string().min(1).max(1024),
            name: z.string(),
            size: z.number().finite().nonnegative(),
        })
        .passthrough(),
});

let cache: MusicCache | undefined;

export const getMusicCache = () => {
    if (!cache) {
        cache = new MusicCache(join(app.getPath('userData'), 'music-cache'), {
            changed: () => getMainWindow()?.webContents.send('music-cache-changed'),
            fetch: (url, options) => net.fetch(url, options),
            validateAudio: async (path, descriptor) => {
                const metadata = await parseFile(path, { duration: true, skipCovers: true });
                if (!metadata.format.container) throw new Error('Audio validation failed');
                const duration = metadata.format.duration;
                const expected = descriptor.song.duration / 1000;
                if (
                    duration &&
                    expected > 0 &&
                    Math.abs(duration - expected) > Math.max(2, expected * 0.02)
                ) {
                    throw new Error('Audio duration does not match the complete song');
                }
            },
            warn: (key, reason) => log.warn('Music cache operation failed', { key, reason }),
        });
    }
    return cache;
};

const handle = (channel: string, action: (data: unknown) => unknown) => {
    ipcMain.handle(`music-cache-${channel}`, (event, data: unknown) => {
        if (
            event.sender !== getMainWindow()?.webContents ||
            event.senderFrame !== event.sender.mainFrame
        ) {
            throw new Error('Invalid music cache caller');
        }
        return action(data);
    });
};

handle('lookup', (data) => {
    const args = z
        .object({ descriptor: descriptorSchema.optional(), key: keySchema.optional() })
        .parse(data);
    if (!args.key && !args.descriptor) throw new Error('Cache identity is required');
    return getMusicCache().lookup(args.descriptor as MusicCacheDescriptor | undefined, args.key);
});
handle('register', (data) => {
    const args = z.object({ descriptor: descriptorSchema, url: urlSchema }).parse(data);
    return getMusicCache().register(args.descriptor as MusicCacheDescriptor, args.url);
});
handle('save', (data) => {
    const args = z
        .object({
            collection: z
                .object({
                    id: z.string().min(1).max(1024),
                    name: z.string().max(4096),
                    type: z.enum(['album', 'playlist']),
                })
                .optional(),
            items: z
                .array(z.object({ descriptor: descriptorSchema, url: urlSchema.optional() }))
                .min(1)
                .max(50000),
        })
        .parse(data);
    return getMusicCache().save(args as MusicCacheSaveRequest);
});
handle('retry', (data) => {
    const args = z.object({ key: keySchema, url: urlSchema }).parse(data);
    return getMusicCache().retry(args.key, args.url);
});
for (const action of ['cancel', 'remove'] as const) {
    handle(action, (data) => {
        const args = z.object({ collection: z.boolean().optional(), key: keySchema }).parse(data);
        return getMusicCache()[action](args.key, args.collection);
    });
}
handle('list', () => getMusicCache().snapshot());
handle('clear', () => getMusicCache().clearAutomatic());
handle('configure', (data) =>
    getMusicCache().configure(
        z
            .object({
                enabled: z.boolean(),
                maxBytes: z
                    .number()
                    .finite()
                    .int()
                    .min(1024 ** 3)
                    .max(1024 ** 4),
            })
            .parse(data),
    ),
);
handle('open-folder', async () => {
    await getMusicCache().snapshot();
    return shell.openPath(join(app.getPath('userData'), 'music-cache'));
});
let closing: Promise<void> | undefined;
let closed = false;
app.on('before-quit', (event) => {
    if (!cache || closed) return;
    event.preventDefault();
    closing ??= cache
        .close()
        .catch(() => {
            log.warn('Unable to finish music cache shutdown');
        })
        .finally(() => {
            closed = true;
            app.quit();
        });
});
