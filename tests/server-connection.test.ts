import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';

import type { ServerListItemWithCredential } from '../src/shared/types/domain-types';

import { getServerUrl } from '../src/renderer/utils/normalize-server-url';
import {
    invalidateServerConnection,
    probeServerUrl,
    reportServerConnectionError,
    resolveServerUrl,
    SERVER_PROBE_TIMEOUT,
    subscribeServerConnections,
} from '../src/renderer/utils/server-connection';

let serverCount = 0;
const server = (
    overrides: Partial<ServerListItemWithCredential> = {},
): ServerListItemWithCredential => ({
    credential: 'u=alice&s=salt&t=token',
    id: `server-${++serverCount}`,
    name: 'Music',
    remoteUrl: 'https://public.example/music',
    type: 'subsonic' as ServerListItemWithCredential['type'],
    url: 'http://local.example/music',
    userId: 'alice',
    username: 'alice',
    ...overrides,
});
const ok = () => Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
const fetchMock = spyOn(globalThis, 'fetch');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

const desktopNetwork = (check: () => Promise<boolean | null>) => {
    const subnetCheck = mock(check);
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            api: { utils: { isLocalServerOnSubnet: subnetCheck } },
            process: { type: 'renderer' },
        },
    });
    return subnetCheck;
};

afterAll(() => {
    fetchMock.mockRestore();
});

afterEach(() => {
    fetchMock.mockReset();
    if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
        Reflect.deleteProperty(globalThis, 'window');
    }
});

test('single/equal addresses and forced public URLs never probe', async () => {
    const single = server({ remoteUrl: undefined });
    expect(await resolveServerUrl(single)).toBe(single.url);
    const equal = server({ remoteUrl: 'http://local.example/music/' });
    expect(await resolveServerUrl(equal)).toBe(equal.url);
    const dual = server();
    expect(await resolveServerUrl(dual, true)).toBe(dual.remoteUrl!);
    expect(getServerUrl(dual, true)).toBe(dual.remoteUrl!);
    expect(fetchMock).not.toHaveBeenCalled();
});

test('local priority caches one probe and falls back when a connection error is reported', async () => {
    const config = server();
    let localAvailable = true;
    fetchMock.mockImplementation(async (input) => {
        if (String(input).startsWith(config.url) && !localAvailable) {
            throw new TypeError('Network error');
        }
        return ok();
    });
    expect(await resolveServerUrl(config)).toBe(config.url);
    expect(await resolveServerUrl(config)).toBe(config.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    localAvailable = false;
    reportServerConnectionError(config, { code: 'ERR_NETWORK' }, config.url);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(getServerUrl(config)).toBe(config.remoteUrl!);
    expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('falls back to public and returns to local when it recovers', async () => {
    const config = server();
    let localAvailable = false;
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.url) && !localAvailable
            ? new Response('', { status: 503 })
            : ok(),
    );
    const changes: string[] = [];
    const unsubscribe = subscribeServerConnections((id, _prior, selected) => {
        if (id === config.id) {
            changes.push(selected);
        }
    });
    try {
        expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
        localAvailable = true;
        invalidateServerConnection(config.id);
        expect(await resolveServerUrl(config)).toBe(config.url);
        expect(changes).toEqual([config.remoteUrl!, config.url]);
    } finally {
        unsubscribe();
    }
});

test('public preference reverses fallback and recovery priority', async () => {
    const config = server({ preferRemoteUrl: true });
    let publicAvailable = false;
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.remoteUrl!) && !publicAvailable
            ? new Response('', { status: 502 })
            : ok(),
    );
    expect(await resolveServerUrl(config)).toBe(config.url);
    publicAvailable = true;
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
});

test('both addresses down preserves the last selection and does not erase credentials', async () => {
    const config = server();
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.url) ? new Response('', { status: 503 }) : ok(),
    );
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    fetchMock.mockImplementation(async () => {
        throw new TypeError('Offline');
    });
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(config.credential).toBe('u=alice&s=salt&t=token');
    expect(config.url).toBe('http://local.example/music');
    expect(config.preferRemoteUrl).toBeUndefined();
});

test('HTTP authentication and Subsonic authentication errors indicate reachability', async () => {
    for (const status of [401, 403]) {
        const config = server();
        fetchMock.mockImplementation(async () => new Response('', { status }));
        expect(await resolveServerUrl(config)).toBe(config.url);
        reportServerConnectionError(config, { response: { status } }, config.url);
        expect(await resolveServerUrl(config)).toBe(config.url);
    }
    const config = server();
    fetchMock.mockImplementation(async () =>
        Response.json({
            'subsonic-response': { error: { code: 40 }, status: 'failed' },
        }),
    );
    expect(await resolveServerUrl(config)).toBe(config.url);
    expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('invalid/non-server responses do not count as a working address', async () => {
    const config = server();
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.url) ? Response.json({ hello: 'world' }) : ok(),
    );
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
});

test('probes retain server subpaths and encoded Subsonic credentials', async () => {
    const config = server({ credential: 'u=a%26b&p=p%2Bss' });
    fetchMock.mockImplementation(async () => ok());
    await resolveServerUrl(config);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/music/rest/ping.view');
    expect(url.searchParams.get('u')).toBe('a&b');
    expect(url.searchParams.get('p')).toBe('p+ss');
    expect(url.searchParams.get('f')).toBe('json');
});

test('Jellyfin uses its existing server info endpoint and token header', async () => {
    const config = server({
        credential: 'jf-token',
        type: 'jellyfin' as ServerListItemWithCredential['type'],
    });
    fetchMock.mockImplementation(async () => Response.json({ Version: '10.11.0' }));
    expect(await resolveServerUrl(config)).toBe(config.url);
    const [input, options] = fetchMock.mock.calls[0];
    expect(new URL(String(input)).pathname).toBe('/music/system/info');
    expect(options?.headers).toEqual({ 'X-Emby-Token': 'jf-token' });
});

test('concurrent callers share a probe; cancelling a caller does not cancel other callers', async () => {
    const config = server();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(
        () =>
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
    );
    const controller = new AbortController();
    const cancelled = resolveServerUrl(config, false, controller.signal);
    const active = resolveServerUrl(config);
    controller.abort();
    finish(ok());
    await expect(cancelled).rejects.toThrow();
    expect(await active).toBe(config.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('configuration changes discard pending results from the old configuration', async () => {
    const oldConfig = server();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
        () =>
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
    );
    const pending = resolveServerUrl(oldConfig);
    const newConfig = { ...oldConfig, url: 'http://new.example/music' };
    fetchMock.mockImplementation(async () => ok());
    expect(await resolveServerUrl(newConfig)).toBe(newConfig.url);
    finish(ok());
    await pending;
    expect(getServerUrl(newConfig)).toBe(newConfig.url);
});

test('a failure from the old address does not invalidate an already switched connection', async () => {
    const config = server();
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.url) ? new Response('', { status: 503 }) : ok(),
    );
    await resolveServerUrl(config);
    reportServerConnectionError(config, { code: 'ERR_NETWORK' }, config.url);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('a hung preferred probe times out and then uses the public address', async () => {
    const config = server();
    fetchMock.mockImplementation((input, options) => {
        if (!String(input).startsWith(config.url)) {
            return Promise.resolve(ok());
        }
        return new Promise<Response>((_resolve, reject) => {
            options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
                once: true,
            });
        });
    });
    const started = Date.now();
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SERVER_PROBE_TIMEOUT - 50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('a cancelled probe does not contact the alternate server', async () => {
    const config = server();
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementation(async (_input, options) => {
        options!.signal!.throwIfAborted();
        return ok();
    });
    expect(await probeServerUrl(config, config.url, controller.signal)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('desktop outside the fixed subnet selects public without any HTTP probe', async () => {
    const subnetCheck = desktopNetwork(async () => false);
    const config = server({
        remoteUrl: 'https://public.example:8443/music/',
        url: 'http://10.0.0.10:4533/music',
    });
    const changes: string[] = [];
    const unsubscribe = subscribeServerConnections((id, _prior, selected) => {
        if (id === config.id) {
            changes.push(selected);
        }
    });
    try {
        expect(getServerUrl(config)).toBe('https://public.example:8443/music');
        expect(await resolveServerUrl(config)).toBe('https://public.example:8443/music');
        expect(getServerUrl(config)).toBe('https://public.example:8443/music');
        expect(await resolveServerUrl(config)).toBe('https://public.example:8443/music');
        expect(subnetCheck).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([]);
        // Even a failed public request must not trigger a private-address probe.
        reportServerConnectionError(config, { code: 'ERR_NETWORK' }, getServerUrl(config));
        expect(await resolveServerUrl(config)).toBe('https://public.example:8443/music');
        expect(subnetCheck).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
    } finally {
        unsubscribe();
    }
});

test('desktop changes networks and retains same-subnet fallback and public preference', async () => {
    let localNetwork = true;
    let localAvailable = true;
    const subnetCheck = desktopNetwork(async () => localNetwork);
    const config = server({ url: 'http://10.0.0.10:4533/music' });
    fetchMock.mockImplementation(async (input) =>
        String(input).startsWith(config.url) && !localAvailable
            ? new Response('', { status: 503 })
            : ok(),
    );
    expect(await resolveServerUrl(config)).toBe(config.url);
    localNetwork = false;
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    localNetwork = true;
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.url);
    localAvailable = false;
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    expect(await resolveServerUrl({ ...config, preferRemoteUrl: true })).toBe(config.remoteUrl!);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(subnetCheck).toHaveBeenCalledTimes(5);
});

test('only desktop servers at 10.0.0.10 with distinct public URLs check the subnet', async () => {
    const subnetCheck = desktopNetwork(async () => false);
    fetchMock.mockImplementation(async () => ok());
    for (const url of ['http://10.0.0.11/music', 'http://local.example/music']) {
        const config = server({ url });
        expect(await resolveServerUrl(config)).toBe(url);
    }
    const single = server({ remoteUrl: undefined, url: 'http://10.0.0.10/music' });
    expect(await resolveServerUrl(single)).toBe(single.url);
    const equal = server({ remoteUrl: single.url, url: single.url });
    expect(await resolveServerUrl(equal)).toBe(equal.url);
    const forced = server({ url: single.url });
    expect(await resolveServerUrl(forced, true)).toBe(forced.remoteUrl!);
    expect(subnetCheck).not.toHaveBeenCalled();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { api: { utils: { isLocalServerOnSubnet: subnetCheck } } },
    });
    const web = server({ url: single.url });
    expect(await resolveServerUrl(web)).toBe(web.url);
    expect(subnetCheck).not.toHaveBeenCalled();
});

test('unknown subnet or IPC failure falls back to existing reachability checks', async () => {
    const subnetCheck = desktopNetwork(async () => null);
    fetchMock.mockImplementation(async () => ok());
    const config = server({ url: 'http://10.0.0.10/music' });
    expect(await resolveServerUrl(config)).toBe(config.url);
    subnetCheck.mockRejectedValueOnce(new Error('IPC failed'));
    invalidateServerConnection(config.id);
    expect(await resolveServerUrl(config)).toBe(config.url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('concurrent desktop callers share a subnet check and discard an invalidated result', async () => {
    let finish!: (matches: boolean) => void;
    const subnetCheck = desktopNetwork(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const config = server({ url: 'http://10.0.0.10/music' });
    const first = resolveServerUrl(config);
    const shared = resolveServerUrl(config);
    expect(subnetCheck).toHaveBeenCalledTimes(1);
    invalidateServerConnection(config.id);
    subnetCheck.mockResolvedValueOnce(false);
    expect(await resolveServerUrl(config)).toBe(config.remoteUrl!);
    finish(true);
    expect(await first).toBe(config.remoteUrl!);
    expect(await shared).toBe(config.remoteUrl!);
    expect(getServerUrl(config)).toBe(config.remoteUrl!);
    expect(fetchMock).not.toHaveBeenCalled();
});

test('desktop synchronous URLs stay public until the first successful local check', async () => {
    let finish!: (matches: boolean) => void;
    desktopNetwork(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const config = server({ url: 'http://10.0.0.10:4533/music' });
    const changes: string[] = [];
    const unsubscribe = subscribeServerConnections((id, _prior, selected) => {
        if (id === config.id) {
            changes.push(selected);
        }
    });
    fetchMock.mockImplementation(async () => ok());
    try {
        expect(getServerUrl(config)).toBe(config.remoteUrl!);
        const pending = resolveServerUrl(config);
        expect(getServerUrl(config)).toBe(config.remoteUrl!);
        expect(fetchMock).not.toHaveBeenCalled();
        finish(true);
        expect(await pending).toBe(config.url);
        expect(getServerUrl(config)).toBe(config.url);
        expect(changes).toEqual([config.url]);
    } finally {
        unsubscribe();
    }
});
