import { useEffect, useSyncExternalStore } from 'react';

import { useAuthStore, usePlayerStore } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { getServerUrl, normalizeServerUrl } from '/@/renderer/utils/normalize-server-url';
import {
    invalidateServerConnection,
    resolveServerUrl,
    SERVER_CHECK_INTERVAL,
    subscribeServerConnections,
} from '/@/renderer/utils/server-connection';

const subscribe = (onChange: () => void) => subscribeServerConnections(onChange);

export const useServerUrl = (serverId: string | undefined) => {
    const server = useAuthStore((state) => (serverId ? state.serverList[serverId] : undefined));
    const getSnapshot = () => getServerUrl(server);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const useServerConnections = () => {
    const servers = useAuthStore((state) => state.serverList);
    const currentServerId = useAuthStore((state) => state.currentServer?.id);
    const songs = usePlayerStore((state) => state.queue.songs);

    useEffect(() => {
        const serverIds = new Set([
            currentServerId,
            ...Object.values(songs).map((song) => song._serverId),
        ]);
        const check = (refresh = false) => {
            serverIds.forEach((id) => {
                const server = id ? servers[id] : undefined;
                if (!server?.credential || !server.remoteUrl) {
                    return;
                }
                if (refresh) {
                    invalidateServerConnection(server.id);
                }
                void resolveServerUrl(server);
            });
        };
        const refresh = () => check(true);
        check();
        const interval = window.setInterval(refresh, SERVER_CHECK_INTERVAL);
        window.addEventListener('online', refresh);
        window.addEventListener('focus', refresh);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('online', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [currentServerId, servers, songs]);

    useEffect(
        () =>
            subscribeServerConnections((serverId, _previousUrl, url) => {
                const server = useAuthStore.getState().serverList[serverId];
                logger.info('Server address changed after connection check', {
                    address:
                        server?.remoteUrl && url === normalizeServerUrl(server.remoteUrl)
                            ? 'public'
                            : 'regular',
                    serverId,
                });
            }),
        [],
    );
};
