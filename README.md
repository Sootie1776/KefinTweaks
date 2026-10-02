# KefinTweaks — private performance fork

This repository is a personal, experimental fork used to test Jellyfin Web UI performance changes.

It is not the canonical KefinTweaks project. For the original project, documentation, releases, support, and community discussions, visit:

<https://github.com/ranaldsgift/KefinTweaks>

The `experimental` branch may contain account-scoped performance experiments and should not be treated as a general-purpose release. Changes are tested against a small allowlist of Jellyfin accounts before they are considered for broader use.

## Fork-specific notes

- The fork uses `Sootie1776/KefinTweaks` for its own CDN and GitHub API lookups.
- The normal KefinTweaks feature documentation remains upstream.
- Do not use this fork as a drop-in replacement unless you understand the changes in the selected commit.

## Faster runtime bootstrap

After the fork is installed and the `KefinTweaks-Config` entry exists in JavaScript Injector, use the small runtime bootstrap for normal page loads:

```javascript
const script = document.createElement('script');
script.src = 'https://cdn.jsdelivr.net/gh/Sootie1776/KefinTweaks@performance-test-user-gate/kefinTweaks-runtime.js';
script.async = true;
document.head.appendChild(script);
```

It loads the runtime injector immediately and defers the larger installer to administrators during idle time. The installer remains available for admin configuration, while regular users avoid parsing it on every page.
