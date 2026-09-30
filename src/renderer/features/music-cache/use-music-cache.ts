import { useQuery, useQueryClient } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { useEffect } from 'react';

export const useMusicCache = () => {
    const queryClient = useQueryClient();
    const query = useQuery({
        enabled: isElectron(),
        queryFn: () => window.api.musicCache.list(),
        queryKey: ['music-cache'],
        staleTime: Infinity,
    });
    useEffect(() => {
        if (!isElectron()) return;
        return window.api.musicCache.onChanged(() => {
            void queryClient.invalidateQueries(
                { queryKey: ['music-cache'] },
                { cancelRefetch: false },
            );
        });
    }, [queryClient]);
    return query;
};
