import type {
    MusicCacheDescriptor,
    MusicCacheSaveRequest,
    MusicCacheSettings,
    MusicCacheSnapshot,
} from '/@/shared/types/music-cache';

import { ipcRenderer } from 'electron';

export const musicCache = {
    cancel: (key: string, collection = false): Promise<void> =>
        ipcRenderer.invoke('music-cache-cancel', { collection, key }),
    clearAutomatic: (): Promise<void> => ipcRenderer.invoke('music-cache-clear'),
    configure: (settings: MusicCacheSettings): Promise<void> =>
        ipcRenderer.invoke('music-cache-configure', settings),
    list: (): Promise<MusicCacheSnapshot> => ipcRenderer.invoke('music-cache-list'),
    lookup: (args: { descriptor?: MusicCacheDescriptor; key?: string }): Promise<null | string> =>
        ipcRenderer.invoke('music-cache-lookup', args),
    onChanged: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on('music-cache-changed', listener);
        return () => {
            ipcRenderer.removeListener('music-cache-changed', listener);
        };
    },
    openFolder: (): Promise<string> => ipcRenderer.invoke('music-cache-open-folder'),
    register: (descriptor: MusicCacheDescriptor, url: string): Promise<string> =>
        ipcRenderer.invoke('music-cache-register', { descriptor, url }),
    remove: (key: string, collection = false): Promise<void> =>
        ipcRenderer.invoke('music-cache-remove', { collection, key }),
    retry: (key: string, url: string): Promise<void> =>
        ipcRenderer.invoke('music-cache-retry', { key, url }),
    save: (args: MusicCacheSaveRequest): Promise<void> =>
        ipcRenderer.invoke('music-cache-save', args),
};
