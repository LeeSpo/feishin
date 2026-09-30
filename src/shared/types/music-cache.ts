import type { Song } from './domain-types';

export const MUSIC_CACHE_GIB = 1024 ** 3;

export interface MusicCacheCollection {
    account: string;
    id: string;
    key: string;
    keys: string[];
    name: string;
    pendingKeys?: string[];
    serverId: string;
    serverName: string;
    type: 'album' | 'playlist';
}

export interface MusicCacheDescriptor {
    account: string;
    profile: MusicCacheProfile;
    serverName: string;
    song: Song;
}

export interface MusicCacheEntry extends MusicCacheDescriptor {
    bytes: number;
    deletePending?: boolean;
    directSaved: boolean;
    downloadedBytes: number;
    error: null | string;
    key: string;
    lastUsed: number;
    saved: boolean;
    status: MusicCacheStatus;
    totalBytes: null | number;
}

export interface MusicCacheProfile {
    bitrate: null | number;
    enabled: boolean;
    format: null | string;
    maxSampleRate: null | number;
}

export interface MusicCacheSaveRequest {
    collection?: Pick<MusicCacheCollection, 'id' | 'name' | 'type'>;
    items: { descriptor: MusicCacheDescriptor; url?: string }[];
}

export interface MusicCacheSettings {
    enabled: boolean;
    maxBytes: number;
}

export interface MusicCacheSnapshot {
    automaticBytes: number;
    collections: MusicCacheCollection[];
    entries: MusicCacheEntry[];
    error: null | string;
    savedBytes: number;
    settings: MusicCacheSettings;
}

export type MusicCacheStatus =
    'downloading' | 'failed' | 'interrupted' | 'missing' | 'queued' | 'ready';
