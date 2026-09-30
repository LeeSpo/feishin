import clsx from 'clsx';
import isElectron from 'is-electron';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import styles from './action-bar.module.css';

import { useScanStatus } from '/@/renderer/features/shared/hooks/use-scan-status';
import { AppMenu } from '/@/renderer/features/titlebar/components/app-menu';
import { useCommandPalette, useWindowBarStyle } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { DropdownMenu } from '/@/shared/components/dropdown-menu/dropdown-menu';
import { Grid } from '/@/shared/components/grid/grid';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Platform } from '/@/shared/types/types';

const isMacHiddenInset = () => isElectron() && window.api.utils.isMacOS();

export const ActionBar = () => {
    const { t } = useTranslation();
    const { open } = useCommandPalette();
    const { isScanning } = useScanStatus();
    const windowBarStyle = useWindowBarStyle();
    const padForTrafficLights = isMacHiddenInset() && windowBarStyle === Platform.WEB;

    return (
        <div className={clsx(styles.container, padForTrafficLights && styles.macInset)}>
            <Grid
                display="flex"
                gap="sm"
                styles={{
                    inner: {
                        width: '100%',
                    },
                    root: {
                        padding: '0 var(--theme-spacing-md',
                        width: '100%',
                    },
                }}
            >
                <Grid.Col span={7}>
                    <button className={styles.searchButton} onClick={open} type="button">
                        <Icon icon="search" />
                        <span>{t('common.search')}</span>
                    </button>
                </Grid.Col>
                <Grid.Col span={5}>
                    <Group gap="sm" grow wrap="nowrap">
                        <DropdownMenu position="bottom-start">
                            <DropdownMenu.Target>
                                <Button p="0">
                                    <Icon
                                        animate={isScanning ? 'spin' : undefined}
                                        icon={isScanning ? 'spinner' : 'menu'}
                                        size="lg"
                                    />
                                </Button>
                            </DropdownMenu.Target>
                            <DropdownMenu.Dropdown>
                                <AppMenu />
                            </DropdownMenu.Dropdown>
                        </DropdownMenu>
                        <NavigateButtons />
                    </Group>
                </Grid.Col>
            </Grid>
        </div>
    );
};

const NavigateButtons = () => {
    const navigate = useNavigate();

    return (
        <>
            <Button onClick={() => navigate(-1)} p="0">
                <Icon icon="arrowLeftS" size="lg" />
            </Button>
            <Button onClick={() => navigate(1)} p="0">
                <Icon icon="arrowRightS" size="lg" />
            </Button>
        </>
    );
};
