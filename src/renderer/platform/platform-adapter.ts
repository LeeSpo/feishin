import type {
    MusicCacheDescriptor,
    MusicCacheSaveRequest,
    MusicCacheSettings,
    MusicCacheSnapshot,
} from '/@/shared/types/music-cache';

import isElectron from 'is-electron';

export type DesktopShell = 'electron' | 'tauri' | 'web';

/**
 * Cross-shell boundary for desktop capabilities used by KEEP features.
 * Electron implements via window.api; Tauri will implement via invoke/plugins.
 */
export interface MusicCacheAdapter {
    cancel: (key: string, collection?: boolean) => Promise<void>;
    clearAutomatic: () => Promise<void>;
    configure: (settings: MusicCacheSettings) => Promise<void>;
    list: () => Promise<MusicCacheSnapshot>;
    lookup: (args: { descriptor?: MusicCacheDescriptor; key?: string }) => Promise<null | string>;
    onChanged: (callback: () => void) => () => void;
    openFolder: () => Promise<string>;
    register: (descriptor: MusicCacheDescriptor, url: string) => Promise<string>;
    remove: (key: string, collection?: boolean) => Promise<void>;
    retry: (key: string, url: string) => Promise<void>;
    save: (args: MusicCacheSaveRequest) => Promise<void>;
}

declare global {
    interface Window {
        __FEISHIN_SHELL__?: DesktopShell;
        __TAURI_INTERNALS__?: unknown;
    }
}

export const getDesktopShell = (): DesktopShell => {
    if (typeof window !== 'undefined' && window.__FEISHIN_SHELL__) {
        return window.__FEISHIN_SHELL__;
    }
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
        return 'tauri';
    }
    if (isElectron()) {
        return 'electron';
    }
    return 'web';
};

export const isDesktopShell = (): boolean => {
    const shell = getDesktopShell();
    return shell === 'electron' || shell === 'tauri';
};

export const getMusicCacheAdapter = (): MusicCacheAdapter | null => {
    const shell = getDesktopShell();
    if (shell === 'electron' && typeof window !== 'undefined' && window.api?.musicCache) {
        return window.api.musicCache as MusicCacheAdapter;
    }
    // Tauri adapter is wired in Phase 3 once invoke commands exist.
    if (shell === 'tauri' && typeof window !== 'undefined' && window.api?.musicCache) {
        return window.api.musicCache as MusicCacheAdapter;
    }
    return null;
};
