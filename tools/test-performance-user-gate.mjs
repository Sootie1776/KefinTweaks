import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../scripts/homeScreen3.js', import.meta.url), 'utf8');
const start = source.indexOf('    function isPerformanceTestUser() {');
const end = source.indexOf('\n    // Configuration', start);
assert(start >= 0 && end > start, 'Home screen should define its performance-user guard');
const guard = source.slice(start, end).trim();
assert(source.includes("window.performance?.mark?.('KefinTweaks:HomePainted')"), 'Home completion mark should remain present');
assert(source.includes("document.dispatchEvent(new CustomEvent('kefinTweaksHomePainted'))"), 'Home completion event should remain present');

function makeGuard(userId, configuredIds) {
  const window = {
    ApiClient: { getCurrentUserId: () => userId },
    __KefinTweaksPerformanceTestUsers: configuredIds,
  };
  return vm.runInNewContext(`(() => { ${guard}; return isPerformanceTestUser; })()`, { window, Set });
}

assert.equal(makeGuard('test-user', new Set(['test-user']))(), true, 'allowlisted user should receive the test marker');
assert.equal(makeGuard('other-user', new Set(['test-user']))(), false, 'other users should not receive the test marker');
assert.equal(makeGuard('test-user', [])(), false, 'missing allowlist should preserve default behavior');

console.log('Performance-user gate tests passed.');
