import type { QueueSong, Song } from '/@/shared/types/domain-types';

import { useTranslation } from 'react-i18next';

import styles from './music-cache-indicator.module.css';
import { useSongCacheEntries } from './use-music-cache';

import { Icon } from '/@/shared/components/icon/icon';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';

export const MusicCacheIndicator = ({
    song,
}: {
    song: Partial<Pick<QueueSong, '_localCacheKey'>> & Song;
}) => {
    const { t } = useTranslation();
    const entries = useSongCacheEntries(song);
    if (!entries?.length) return null;

    const saved = entries.some((entry) => entry.saved);
    const qualities = [
        ...new Set(
            entries.map(({ profile }) => {
                if (!profile.enabled) return t('musicCache.original');
                return [
                    profile.format?.toUpperCase() || t('musicCache.serverDefaultFormat'),
                    profile.bitrate ? `${profile.bitrate} kbps` : null,
                    profile.maxSampleRate ? `≤ ${profile.maxSampleRate} Hz` : null,
                ]
                    .filter(Boolean)
                    .join(' ');
            }),
        ),
    ].join(', ');
    const label = `${t(saved ? 'musicCache.indicatorSaved' : 'musicCache.indicatorAutomatic')} · ${t('musicCache.quality')}: ${qualities}`;

    return (
        <Tooltip label={label}>
            <span aria-label={label} className={styles.root} role="img">
                <Icon
                    color={saved ? 'success' : 'muted'}
                    icon={saved ? 'downloadDone' : 'hardDrive'}
                    size="sm"
                />
            </span>
        </Tooltip>
    );
};
