import { expect, test } from 'bun:test';

import type { ServerListItemWithCredential } from '../src/shared/types/domain-types';

import { getServerUrl } from '../src/renderer/utils/normalize-server-url';
import {
    invalidateServerConnection,
    resolveServerUrl,
} from '../src/renderer/utils/server-connection';

test('real HTTP probes switch and recover for all three server types', async () => {
    for (const type of ['subsonic', 'navidrome', 'jellyfin']) {
        const requests: string[] = [];
        const handler = (request: Request) => {
            const url = new URL(request.url);
            requests.push(`${request.method} ${url.pathname}`);
            if (type === 'jellyfin') {
                expect(request.headers.get('X-Emby-Token')).toBe('dummy-token');
                expect(url.pathname).toBe('/music/system/info');
                return Response.json({ Version: '10.11.0' });
            }
            expect(url.pathname).toBe('/music/rest/ping.view');
            expect(url.searchParams.get('u')).toBe('alice');
            return Response.json({ 'subsonic-response': { status: 'ok' } });
        };
        let primary = Bun.serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
        const standby = Bun.serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
        const port = primary.port;
        const config: ServerListItemWithCredential = {
            credential: type === 'jellyfin' ? 'dummy-token' : 'u=alice&s=salt&t=dummy-token',
            id: `http-${type}`,
            name: 'HTTP test',
            remoteUrl: `${standby.url}music`,
            type: type as ServerListItemWithCredential['type'],
            url: `${primary.url}music`,
            userId: 'alice',
            username: 'alice',
        };
        try {
            expect(await resolveServerUrl(config)).toBe(config.url);
            primary.stop(true);
            invalidateServerConnection(config.id);
            expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
            expect(getServerUrl(config)).toBe(config.remoteUrl!);
            primary = Bun.serve({ fetch: handler, hostname: '127.0.0.1', port });
            invalidateServerConnection(config.id);
            expect(await resolveServerUrl(config)).toBe(config.url);
            primary.stop(true);
            invalidateServerConnection(config.id);
            expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
            standby.stop(true);
            invalidateServerConnection(config.id);
            expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
            expect(requests).toHaveLength(4);
        } finally {
            primary.stop(true);
            standby.stop(true);
        }
    }
});
