import isElectron from 'is-electron';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
    getOfflineCollectionSongs,
    saveSongsOffline,
} from '/@/renderer/features/music-cache/music-cache-api';
import { useCurrentServerId } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem, Song } from '/@/shared/types/domain-types';

interface SaveOfflineActionProps {
    items: { id: string; name: string }[];
    itemType: LibraryItem;
    songs?: Song[];
}

export const SaveOfflineAction = ({ items, itemType, songs }: SaveOfflineActionProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const [busy, setBusy] = useState(false);

    const save = async () => {
        setBusy(true);
        try {
            if (songs) await saveSongsOffline(songs);
            else
                for (const item of items) {
                    const type = itemType === LibraryItem.PLAYLIST ? 'playlist' : 'album';
                    const tracks = await getOfflineCollectionSongs(serverId, item.id, type);
                    await saveSongsOffline(tracks, { id: item.id, name: item.name, type });
                }
            toast.success({ message: t('musicCache.saveRequested') });
        } catch (error) {
            logger.warn('Unable to prepare offline music', { itemType, serverId });
            toast.error({ message: (error as Error).message });
        } finally {
            setBusy(false);
        }
    };

    if (!isElectron() || songs?.some((song) => '_localCacheKey' in song)) return null;
    return (
        <ContextMenu.Item
            disabled={busy || !items.length}
            leftIcon="download"
            onSelect={() => {
                void save();
            }}
        >
            {t('musicCache.save')}
        </ContextMenu.Item>
    );
};
