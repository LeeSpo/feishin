/**
 * Optional Tauri preload shim. When the web renderer runs inside Tauri,
 * expose a partial window.api so PlatformAdapter can resolve musicCache.
 */
import type { MusicCacheAdapter } from '/@/renderer/platform/platform-adapter';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const getInvoke = (): Invoke | null => {
    const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
    if (tauri?.core?.invoke) return tauri.core.invoke.bind(tauri.core);
    return null;
};

const createTauriMusicCache = (invoke: Invoke): MusicCacheAdapter => ({
    cancel: async () => undefined,
    clearAutomatic: () => invoke('music_cache_clear'),
    configure: (settings) => invoke('music_cache_configure', { settings }),
    list: () => invoke('music_cache_list'),
    lookup: (args) =>
        invoke('music_cache_lookup', {
            descriptor: args.descriptor ?? null,
            key: args.key ?? null,
        }),
    onChanged: () => () => undefined,
    openFolder: () => invoke('music_cache_open_folder'),
    register: async (_descriptor, url) => url,
    remove: async () => undefined,
    retry: async () => undefined,
    save: async () => undefined,
});

export const installTauriBridge = async () => {
    if (typeof window === 'undefined') return;
    if (window.__FEISHIN_SHELL__ === 'electron') return;
    if (!window.__TAURI_INTERNALS__ && !(window as unknown as { __TAURI__?: unknown }).__TAURI__) {
        return;
    }

    window.__FEISHIN_SHELL__ = 'tauri';

    const invoke = getInvoke();
    if (!invoke) return;

    const musicCache = createTauriMusicCache(invoke);

    // Minimal stub api surface for KEEP desktop features during migration.
    const existing = (window as unknown as { api?: Record<string, unknown> }).api ?? {};
    (window as unknown as { api: Record<string, unknown> }).api = {
        ...existing,
        musicCache,
        utils: existing.utils ?? {
            isLinux: () => false,
            isMacOS: () => navigator.userAgent.includes('Mac'),
            isWindows: () => navigator.userAgent.includes('Windows'),
        },
    };
};
