export const shouldHideWindowOnClose = (
    isMacOS: boolean,
    exitToTray: boolean,
    isQuitting: boolean,
): boolean => !isQuitting && (isMacOS || exitToTray);
