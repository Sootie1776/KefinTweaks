import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('../', import.meta.url);
const injector = fs.readFileSync(new URL('injector.js', repoRoot), 'utf8');
const start = injector.indexOf('    function scheduleAfterHomePaint(');
const end = injector.indexOf('    // Reuse the same LCP-aware scheduling', start);
assert(start >= 0 && end > start, 'scheduleAfterHomePaint function should exist in injector.js');
const functionSource = injector.slice(start, end);

function createWindow(homeAlreadyPainted = false) {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    __kefinTweaksHomePaintedAt: homeAlreadyPainted ? Date.now() : undefined,
    addEventListener(name, callback) {
      const entries = listeners.get(name) || new Set();
      entries.add(callback);
      listeners.set(name, entries);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestIdleCallback(callback) { callback(); },
    fire(name) { for (const callback of [...(listeners.get(name) || [])]) callback(); },
    fireTimer(delay) {
      const timer = [...timers].find(([, item]) => item.delay === delay);
      assert(timer, `expected a ${delay}ms fallback timer`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    timerCount() { return timers.size; },
  };
  return window;
}

function loadScheduler(window) {
  const context = vm.createContext({ window });
  return vm.runInContext(`${functionSource}\nscheduleAfterHomePaint`, context);
}

{
  const window = createWindow();
  const schedule = loadScheduler(window);
  let calls = 0;
  schedule(() => calls++, 8000);
  assert.equal(calls, 0, 'optional work must wait before Home paint');
  window.fire('kefinTweaksHomePainted');
  window.fire('kefinTweaksHomePainted');
  assert.equal(calls, 1, 'Home paint should schedule the callback once');
  assert.equal(window.timerCount(), 0, 'Home paint should clear the fallback');
}

{
  const window = createWindow();
  const schedule = loadScheduler(window);
  let calls = 0;
  schedule(() => calls++, 8000);
  window.fireTimer(8000);
  assert.equal(calls, 1, 'the fallback should prevent optional work from being starved');
}

{
  const window = createWindow(true);
  const schedule = loadScheduler(window);
  let calls = 0;
  schedule(() => calls++, 8000);
  assert.equal(calls, 1, 'already-painted Home should not wait for a missed event');
}

console.log('Home-paint scheduler tests passed.');
