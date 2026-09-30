import { PRODUCT_FEATURES } from '/@/shared/lib/product-features';

export const isAnalyticsDisabled = () => {
    if (!PRODUCT_FEATURES.analytics) {
        return true;
    }

    const isSettingOptOut = localStorage.getItem('umami.disabled') === '1';
    const isDevMode = process.env.NODE_ENV === 'development';
    const isEnvOptOut =
        window && (window.ANALYTICS_DISABLED === true || window.ANALYTICS_DISABLED === 'true');

    return isSettingOptOut || isDevMode || isEnvOptOut;
};
