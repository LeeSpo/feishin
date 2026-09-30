import isElectron from 'is-electron';

import type { ServerListItem, ServerListItemWithCredential } from '../../shared/types/domain-types';

export const SERVER_CHECK_INTERVAL = 30_000;
export const SERVER_PROBE_TIMEOUT = 3_000;

type Connection = {
    checkedAt: number;
    controller?: AbortController;
    key: string;
    pending?: Promise<string>;
    selected: string;
};

const connections = new Map<string, Connection>();
const listeners = new Set<(serverId: string, previousUrl: string, url: string) => void>();

export const normalizeServerUrl = (url: string) => url.trim().replace(/\/$/, '');

const getAddresses = (server: ServerListItem) => {
    const local = normalizeServerUrl(server.url);
    const remote = server.remoteUrl ? normalizeServerUrl(server.remoteUrl) : local;
    return server.preferRemoteUrl ? [remote, local] : [local, remote];
};

const getConnectionKey = (server: ServerListItem) =>
    JSON.stringify([server.type, ...getAddresses(server)]);

const canCheckLocalServerSubnet = (server: ServerListItem) => {
    if (
        !server.remoteUrl ||
        !isElectron() ||
        typeof window === 'undefined' ||
        !window.api?.utils?.isLocalServerOnSubnet
    ) {
        return false;
    }
    try {
        return new URL(server.url).hostname === '10.0.0.10';
    } catch {
        return false;
    }
};

const getInitialServerUrl = (server: ServerListItem) =>
    // Synchronous image/download URLs must not contact the LAN before the first subnet check.
    canCheckLocalServerSubnet(server)
        ? normalizeServerUrl(server.remoteUrl!)
        : getAddresses(server)[0];

const isLocalServerOnSubnet = (server: ServerListItem): null | Promise<boolean | null> =>
    canCheckLocalServerSubnet(server)
        ? window.api.utils.isLocalServerOnSubnet().catch(() => null)
        : null;

export const subscribeServerConnections = (
    listener: (serverId: string, previousUrl: string, url: string) => void,
) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

export const getSelectedServerUrl = (server: ServerListItem) => {
    const connection = connections.get(server.id);
    return connection?.key === getConnectionKey(server)
        ? connection.selected
        : getInitialServerUrl(server);
};

// Separate from backend clients: health checks must never log out or refresh credentials.
export const probeServerUrl = async (
    server: ServerListItemWithCredential,
    baseUrl: string,
    signal: AbortSignal,
) => {
    try {
        const jellyfin = server.type === 'jellyfin';
        const url = new URL(`${baseUrl}/${jellyfin ? 'system/info' : 'rest/ping.view'}`);
        if (!jellyfin) {
            new URLSearchParams(server.credential).forEach((value, key) => {
                url.searchParams.set(key, value);
            });
            url.searchParams.set('c', 'Feishin');
            url.searchParams.set('f', 'json');
            url.searchParams.set('v', '1.13.0');
        }
        const response = await fetch(url, {
            cache: 'no-store',
            headers: jellyfin ? { 'X-Emby-Token': server.credential } : {},
            signal: AbortSignal.any([signal, AbortSignal.timeout(SERVER_PROBE_TIMEOUT)]),
        });
        // Authentication/permission errors establish reachability, not a different address.
        if (response.status === 401 || response.status === 403) {
            return true;
        }
        if (!response.ok) {
            return false;
        }
        const body = await response.json();
        return jellyfin
            ? typeof body?.Version === 'string'
            : typeof body?.['subsonic-response']?.status === 'string';
    } catch {
        // Includes timeouts, CORS/mixed-content restrictions and invalid/non-server responses.
        return false;
    }
};

export const invalidateServerConnection = (serverId: string, failedUrl?: string) => {
    const connection = connections.get(serverId);
    if (!connection || (failedUrl && connection.selected !== failedUrl)) {
        return;
    }
    connection.controller?.abort();
    connection.pending = undefined;
    connection.checkedAt = -Infinity;
};

export const resolveServerUrl = async (
    server: null | ServerListItemWithCredential | undefined,
    forceRemoteUrl = false,
    signal?: AbortSignal,
): Promise<string | undefined> => {
    signal?.throwIfAborted();
    if (!server) {
        return undefined;
    }
    const [preferred, alternate] = getAddresses(server);
    if (forceRemoteUrl) {
        return server.remoteUrl ? normalizeServerUrl(server.remoteUrl) : preferred;
    }
    if (preferred === alternate || !server.credential) {
        return preferred;
    }
    const key = getConnectionKey(server);
    let connection = connections.get(server.id);
    if (!connection || connection.key !== key) {
        connection?.controller?.abort();
        connection = { checkedAt: -Infinity, key, selected: getInitialServerUrl(server) };
        connections.set(server.id, connection);
    }
    const entry = connection;
    if (!entry.pending && Date.now() - entry.checkedAt >= SERVER_CHECK_INTERVAL) {
        const controller = new AbortController();
        entry.controller = controller;
        const pending: Promise<string> = (async () => {
            let selected = entry.selected;
            const subnetCheck = isLocalServerOnSubnet(server);
            const onLocalSubnet = subnetCheck ? await subnetCheck : null;
            if (controller.signal.aborted) {
                return getSelectedServerUrl(server);
            }
            if (onLocalSubnet === false) {
                // Outside the fixed server's subnet, never probe/fall back to the private URL.
                selected = normalizeServerUrl(server.remoteUrl!);
            } else if (await probeServerUrl(server, preferred, controller.signal)) {
                selected = preferred;
            } else if (
                !controller.signal.aborted &&
                (await probeServerUrl(server, alternate, controller.signal))
            ) {
                selected = alternate;
            }
            if (connections.get(server.id) === entry && entry.pending === pending) {
                const previousUrl = entry.selected;
                entry.selected = selected;
                entry.checkedAt = Date.now();
                entry.pending = undefined;
                if (previousUrl !== selected) {
                    listeners.forEach((listener) => listener(server.id, previousUrl, selected));
                }
            }
            return getSelectedServerUrl(server);
        })();
        entry.pending = pending;
    }
    const selected = entry.pending ? await entry.pending : entry.selected;
    signal?.throwIfAborted();
    return selected;
};

export const reportServerConnectionError = (
    server: null | ServerListItemWithCredential,
    error: unknown,
    failedUrl: string | undefined,
) => {
    const failure = error as null | { code?: string; response?: { status?: number } };
    if (
        server &&
        (['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ERR_NETWORK', 'ETIMEDOUT'].includes(
            failure?.code || '',
        ) ||
            (failure?.response?.status ?? 0) >= 500)
    ) {
        invalidateServerConnection(server.id, failedUrl);
        // Only re-probe. Replaying a failed write could perform the operation twice.
        void resolveServerUrl(server);
    }
};
