import type { QueueSong, Song } from '/@/shared/types/domain-types';
import type { ReactNode } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo } from 'react';

import { createMusicCacheIndex, getSongCacheEntries } from './music-cache-index';

import { getMusicCacheAdapter, isDesktopShell } from '/@/renderer/platform/platform-adapter';
import { useAuthStore } from '/@/renderer/store';

const useMusicCacheQuery = () => {
    const queryClient = useQueryClient();
    const cache = getMusicCacheAdapter();
    const query = useQuery({
        enabled: isDesktopShell() && !!cache,
        queryFn: () => {
            const adapter = getMusicCacheAdapter();
            if (!adapter) throw new Error('Music cache adapter unavailable');
            return adapter.list();
        },
        queryKey: ['music-cache'],
        staleTime: Infinity,
    });
    useEffect(() => {
        const adapter = getMusicCacheAdapter();
        if (!adapter) return;
        return adapter.onChanged(() => {
            void queryClient.invalidateQueries(
                { queryKey: ['music-cache'] },
                { cancelRefetch: false },
            );
        });
    }, [queryClient]);
    return query;
};

const MusicCacheContext = createContext<null | ReturnType<typeof useMusicCacheQuery>>(null);
const MusicCacheIndexContext = createContext(createMusicCacheIndex([]));

export const MusicCacheProvider = ({ children }: { children: ReactNode }) => {
    const query = useMusicCacheQuery();
    const index = useMemo(
        () => createMusicCacheIndex(isDesktopShell() ? query.data?.entries || [] : []),
        [query.data?.entries],
    );
    return (
        <MusicCacheContext.Provider value={query}>
            <MusicCacheIndexContext.Provider value={index}>
                {children}
            </MusicCacheIndexContext.Provider>
        </MusicCacheContext.Provider>
    );
};

export const useMusicCache = () => {
    const query = useContext(MusicCacheContext);
    if (!query) throw new Error('MusicCacheProvider is missing');
    return query;
};

export const useSongCacheEntries = (song: Partial<Pick<QueueSong, '_localCacheKey'>> & Song) => {
    const index = useContext(MusicCacheIndexContext);
    const account = useAuthStore((state) => {
        const server = state.serverList[song._serverId];
        return server ? server.userId || server.username : undefined;
    });
    return getSongCacheEntries(index, song, account);
};
