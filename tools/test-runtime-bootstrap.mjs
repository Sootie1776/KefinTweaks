import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../kefinTweaks-runtime.js', import.meta.url), 'utf8');

function createRuntime({ hash = '#/home', isAdmin = true, performanceTestUser = false } = {}) {
  const listeners = new Map();
  const loadedScripts = [];
  const idleCallbacks = [];
  const document = {
    scripts: [],
    currentScript: { src: 'https://cdn.example/KefinTweaks@abc/kefinTweaks-runtime.js' },
    head: {
      appendChild(script) {
        loadedScripts.push(script.src);
        document.scripts.push(script);
        queueMicrotask(() => {
          script.dataset.kefinTweaksLoaded = 'true';
          script.listeners.load?.();
        });
      },
    },
    createElement() {
      return {
        dataset: {},
        listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
      };
    },
  };
  const window = {
    location: { hash },
    ApiClient: { async getCurrentUser() { return { Policy: { IsAdministrator: isAdmin } }; } },
    requestIdleCallback(callback) { idleCallbacks.push(callback); },
    addEventListener(name, callback) {
      const entries = listeners.get(name) || new Set();
      entries.add(callback);
      listeners.set(name, entries);
    },
    async fire(name) {
      await Promise.all([...(listeners.get(name) || [])].map(callback => callback()));
    },
    async fireIdle() {
      await Promise.all(idleCallbacks.splice(0).map(callback => callback()));
    },
  };
  if (performanceTestUser) {
    window.ApiClient.getCurrentUserId = () => 'perf-user-id';
    window.__KefinTweaksPerformanceTestUsers = ['perf-user-id'];
  }
  vm.runInNewContext(source, { window, document, URL, console });
  return { window, loadedScripts, idleCallbacks };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

{
  const runtime = createRuntime();
  await flush();
  assert.equal(runtime.loadedScripts.length, 1, 'normal Home should load only the runtime injector');
  assert.equal(runtime.idleCallbacks.length, 1, 'non-test users retain the existing idle installer schedule');
  assert.match(runtime.loadedScripts[0], /injector\.js$/);

  await runtime.window.fireIdle();
  await flush();
  assert.equal(runtime.loadedScripts.length, 2, 'other admins retain the existing installer behavior');
}

{
  const runtime = createRuntime({ performanceTestUser: true });
  await flush();
  assert.equal(runtime.loadedScripts.length, 1, 'test-user Home should load only the runtime injector');
  assert.equal(runtime.idleCallbacks.length, 0, 'test-user installer should not be scheduled during idle');

  runtime.window.location.hash = '#/dashboard/plugins';
  await runtime.window.fire('hashchange');
  await flush();
  assert.equal(runtime.loadedScripts.length, 2, 'test-user admin Plugins page should load the installer');
  assert.match(runtime.loadedScripts[1], /kefinTweaks-plugin\.js$/);
}

{
  const runtime = createRuntime({ hash: '#/dashboard/plugins', isAdmin: false, performanceTestUser: true });
  await flush();
  assert.equal(runtime.loadedScripts.length, 1, 'non-admins should not load the installer on Plugins page');
}

{
  const runtime = createRuntime({ hash: '#/dashboard/plugins', performanceTestUser: true });
  await flush();
  assert.equal(runtime.loadedScripts.length, 2, 'direct admin navigation to Plugins should load installer');
  assert.match(runtime.loadedScripts[1], /kefinTweaks-plugin\.js$/);
}

console.log('Runtime bootstrap route-gating tests passed.');
