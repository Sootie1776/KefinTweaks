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

    // Runtime code is the critical path. The installer is optional and deferred.
    loadScript(`${root}injector.js`).catch((error) => {
        console.error('[KefinTweaks Runtime] Failed to load injector:', error);
    });

    schedule(async () => {
        if (!(await waitForAdmin())) return;
        try {
            await loadScript(`${root}kefinTweaks-plugin.js`);
            console.log('[KefinTweaks Runtime] Deferred admin installer loaded');
        } catch (error) {
            console.warn('[KefinTweaks Runtime] Deferred admin installer failed:', error);
        }
    });
})();
