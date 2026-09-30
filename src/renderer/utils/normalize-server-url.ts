import { getSelectedServerUrl } from './server-connection';

import { ServerListItem } from '/@/shared/types/domain-types';

export { normalizeServerUrl, resolveServerUrl } from './server-connection';

export const getServerUrl = (
    server: null | ServerListItem | undefined,
    forceRemoteUrl?: boolean,
): string | undefined => {
    if (!server) {
        return undefined;
    }

    if (forceRemoteUrl) {
        return server.remoteUrl || server.url;
    }

    return getSelectedServerUrl(server);
};
