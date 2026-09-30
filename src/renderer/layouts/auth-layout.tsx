import clsx from 'clsx';
import isElectron from 'is-electron';
import { Outlet } from 'react-router';

import styles from './auth-layout.module.css';

import { Titlebar } from '/@/renderer/features/titlebar/components/titlebar';
import { useWindowBarStyle } from '/@/renderer/store';
import { Platform } from '/@/shared/types/types';

export const AuthLayout = () => {
    const windowBarStyle = useWindowBarStyle();
    const padForTrafficLights =
        isElectron() && window.api.utils.isMacOS() && windowBarStyle === Platform.WEB;

    return (
        <>
            <div
                className={clsx(
                    styles.windowTitlebarContainer,
                    padForTrafficLights && styles.macInset,
                )}
            >
                <Titlebar />
            </div>
            <div className={styles.contentContainer}>
                <Outlet />
            </div>
        </>
    );
};
