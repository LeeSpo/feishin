/**
 * Slim Mac-first product surface for the Tauri migration branch.
 *
 * Keep flags centralized so Electron and (later) Tauri share one product cut.
 * Flip a flag to true to temporarily restore a cut feature during development.
 */
export const PRODUCT_FEATURES = {
    /** Usage analytics / umami trackers */
    analytics: false,
    /** Custom global hotkey manager UI (media session / media keys kept) */
    complexGlobalHotkeys: false,
    /** Scrobble percentage/duration/notify extras (keep enable toggle) */
    complexScrobbleExtras: false,
    /** Discord Rich Presence */
    discordRpc: false,
    /** Disk-loaded custom theme packs (built-in themes + CSS still kept) */
    diskCustomThemes: false,
    /** DLNA casting + Subsonic/Navidrome jukebox player types */
    dlnaJukebox: false,
    /** Internet radio stations /radio route and radio player hooks */
    internetRadio: false,
    /** Phone remote-control server + remote SPA hooks */
    phoneRemote: false,
    /** Share item context menu + share modal */
    sharing: false,
    /** Smart playlist query builder settings + create/edit editor */
    smartPlaylistQueryEditor: false,
} as const;

export type ProductFeature = keyof typeof PRODUCT_FEATURES;

export const isProductFeatureEnabled = (feature: ProductFeature): boolean =>
    PRODUCT_FEATURES[feature];

/** Sidebar item ids that map to cut product surfaces */
export const CUT_SIDEBAR_ITEM_IDS = new Set<string>(
    PRODUCT_FEATURES.internetRadio ? [] : ['Radio'],
);

export const isAllowedPlaybackType = (type: string): boolean => {
    if (!PRODUCT_FEATURES.dlnaJukebox && (type === 'dlna' || type === 'jukebox')) {
        return false;
    }
    return true;
};
