// KefinTweaks runtime bootstrap.
// Use this in JavaScript Injector for normal operation. It keeps the installer
// out of non-admin page loads while preserving the admin configuration surface.
(function () {
    'use strict';

    const config = window.KefinTweaksConfig || (window.KefinTweaksConfig = {});
    const bootstrapUrl = document.currentScript?.src || '';
    let rawRoot = '';
    try {
        rawRoot = bootstrapUrl ? new URL('.', bootstrapUrl).href : '';
    } catch (_) {
        rawRoot = '';
    }
    rawRoot = rawRoot || config.kefinTweaksRootResolved || config.kefinTweaksRoot || '';
    const root = String(rawRoot).replace(/\/+$/, '') + '/';

    if (!rawRoot) {
        console.warn('[KefinTweaks Runtime] No kefinTweaksRoot configured');
        return;
    }

    // Keep every runtime asset on the same revision as this bootstrap. The saved
    // installer config may still point at an older commit after a test upgrade.
    config.kefinTweaksRoot = root;
    config.kefinTweaksRootResolved = root;

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts || []).find((script) => script.src === url);
            if (existing) {
                if (existing.dataset.kefinTweaksLoaded === 'true') {
                    resolve();
                    return;
                }
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = url;
            script.async = true;
            script.addEventListener('load', () => {
                script.dataset.kefinTweaksLoaded = 'true';
                resolve();
            }, { once: true });
            script.addEventListener('error', reject, { once: true });
            document.head.appendChild(script);
        });
    }

    function schedule(callback) {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(callback, { timeout: 4000 });
        } else {
            window.setTimeout(callback, 1500);
        }
    }

    function isPerformanceTestUser() {
        try {
            const userId = String(window.ApiClient?.getCurrentUserId?.() || '');
            if (!userId) return false;

            const configured = window.KefinTweaksConfig?.performanceTestUserIds
                || window.__KefinTweaksPerformanceTestUsers;
            const userIds = configured instanceof Set
                ? configured
                : new Set(Array.isArray(configured) ? configured.map(String) : []);
            return userIds.has(userId);
        } catch (_) {
            return false;
        }
    }

    async function waitForAdmin(maxWaitMs = 8000) {
        const started = Date.now();
        while (Date.now() - started < maxWaitMs) {
            try {
                if (window.ApiClient?.getCurrentUser) {
                    const user = await window.ApiClient.getCurrentUser();
                    if (user) return user.Policy?.IsAdministrator === true;
                }
            } catch (_) {
                // Jellyfin may not have finished restoring the session yet.
            }
            await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        return false;
    }

    function isPluginsRoute() {
        return /^#\/dashboard\/plugins(?:[/?]|$)/i.test(String(window.location?.hash || ''));
    }

    let installerLoadPromise = null;
    async function loadInstallerOnPluginsRoute() {
        if (!isPluginsRoute() || installerLoadPromise) return installerLoadPromise;

        installerLoadPromise = (async () => {
            if (!(await waitForAdmin())) return;
            // Jellyfin is an SPA; the admin may navigate away while the session
            // is being restored. Avoid loading the installer after leaving its UI.
            if (!isPluginsRoute()) return;
            try {
                await loadScript(`${root}kefinTweaks-plugin.js`);
                console.log('[KefinTweaks Runtime] Admin installer loaded on Plugins page');
            } catch (error) {
                console.warn('[KefinTweaks Runtime] Deferred admin installer failed:', error);
            }
        })().finally(() => {
            installerLoadPromise = null;
        });

        return installerLoadPromise;
    }

    // Runtime code is the critical path. The installer is optional and deferred.
    loadScript(`${root}injector.js`).catch((error) => {
        console.error('[KefinTweaks Runtime] Failed to load injector:', error);
    });

    if (isPerformanceTestUser()) {
        // The installer only adds the KefinTweaks card to Dashboard → Plugins.
        // Keep this experiment account-scoped until traces confirm the benefit.
        window.addEventListener('hashchange', loadInstallerOnPluginsRoute);
        window.addEventListener('popstate', loadInstallerOnPluginsRoute);
        loadInstallerOnPluginsRoute();
    } else {
        // Preserve the existing behavior for all other accounts.
        schedule(async () => {
            if (!(await waitForAdmin())) return;
            try {
                await loadScript(`${root}kefinTweaks-plugin.js`);
                console.log('[KefinTweaks Runtime] Deferred admin installer loaded');
            } catch (error) {
                console.warn('[KefinTweaks Runtime] Deferred admin installer failed:', error);
            }
        });
    }
})();
