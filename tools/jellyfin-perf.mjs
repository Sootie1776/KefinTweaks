#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.resolve(repoRoot, '..', 'jellyfin.env');
const defaultBaseUrl = 'https://upstream.richardson.page';
const pluginName = 'JavaScript Injector';
const revisionEntryNames = ['Kefin Tweaks', 'KefinTweaks-injector'];

function usage() {
  console.log(`Jellyfin/KefinTweaks local test helper

Usage:
  node tools/jellyfin-perf.mjs status
  node tools/jellyfin-perf.mjs set-revision <full-commit-sha> [--apply --confirm-shared-config]
  node tools/jellyfin-perf.mjs test-user <username-or-user-id> [--remove] [--config-only] [--apply --confirm-shared-config]
  node tools/jellyfin-perf.mjs compare <baseline-trace.json> <test-trace.json>

Commands:
  status       Read the active Injector entries and report pinned KefinTweaks revisions.
  set-revision Show a proposed change by default. Applying posts the shared Injector
               configuration, and requires both explicit flags above.
  test-user    Add/remove one account from KefinTweaks' per-user performance gate.
               This changes the shared config script, but only the selected user takes
               the gated code path. Applying also requires both explicit flags.
  compare      Extract comparable Home-navigation paint timings from Chrome trace exports.

JELLYFIN_URL can override the server URL. The API key is read from jellyfin.env or
JELLYFIN_API_KEY; its value is never printed. Trace files stay local.`);
}

function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    vars[match[1]] = value;
  }
  return vars;
}

async function loadConfig() {
  let vars = {};
  try { vars = parseEnv(await fs.readFile(envPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const apiKey = process.env.JELLYFIN_API_KEY || vars.JELLYFIN_API_KEY;
  if (!apiKey) throw new Error(`JELLYFIN_API_KEY was not found in ${envPath} or the environment.`);
  return {
    apiKey,
    baseUrl: (process.env.JELLYFIN_URL || vars.JELLYFIN_URL || defaultBaseUrl).replace(/\/+$/, ''),
  };
}

function authHeader(apiKey) {
  return `MediaBrowser Client="Codex Perf Harness", Device="Local", DeviceId="codex-perf-harness", Version="1.0", Token="${apiKey}"`;
}

async function apiRequest(config, endpoint, options = {}) {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: authHeader(config.apiKey),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Jellyfin API returned HTTP ${response.status} for ${endpoint}.`);
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function getInjectorConfiguration(config) {
  const plugins = await apiRequest(config, '/Plugins');
  const plugin = plugins.find(item => (item.Name || item.name || '').toLowerCase() === pluginName.toLowerCase());
  const pluginId = plugin?.Id || plugin?.id || plugin?.Guid || plugin?.guid;
  if (!pluginId) throw new Error(`Could not find the installed ${pluginName} plugin.`);
  const configuration = await apiRequest(config, `/Plugins/${encodeURIComponent(pluginId)}/Configuration`);
  return { plugin, pluginId, configuration };
}

function scriptEntries(configuration) {
  return [
    ...(configuration.CustomJavaScripts || []).map(entry => ({ kind: 'CustomJavaScripts', entry })),
    ...(configuration.PluginJavaScripts || []).map(entry => ({ kind: 'PluginJavaScripts', entry })),
  ];
}

function revisionRefs(entry) {
  const source = String(entry.Code || entry.Script || '');
  const refs = new Set();
  for (const match of source.matchAll(/cdn\.jsdelivr\.net\/gh\/Sootie1776\/KefinTweaks@([0-9a-f]{7,40})/gi)) refs.add(match[1]);
  return [...refs];
}

function configuredTestUsers(script) {
  const source = String(script || '');
  const values = [];
  const patterns = [
    /window\.KefinTweaksConfig\.performanceTestUserIds\s*=\s*(\[[\s\S]*?\])\s*;/g,
    /window\.__KefinTweaksPerformanceTestUsers\s*=\s*new Set\s*\(\s*(\[[\s\S]*?\])\s*\)\s*;/g,
  ];
  try {
    for (const pattern of patterns) {
      const matches = [...source.matchAll(pattern)];
      if (matches.length) values.push(...JSON.parse(matches.at(-1)[1]));
    }
    return [...new Set(values.map(String))];
  } catch {
    throw new Error('Could not parse the existing performance-test user allowlist; refusing to modify it.');
  }
}

function testUserSources(configuration) {
  const sources = [];
  for (const section of ['CustomJavaScripts', 'PluginJavaScripts']) {
    for (const entry of configuration[section] || []) {
      const field = typeof entry.Script === 'string' ? 'Script' : typeof entry.Code === 'string' ? 'Code' : null;
      if (!field) continue;
      const script = entry[field];
      const globalSet = /window\.__KefinTweaksPerformanceTestUsers\s*=\s*new Set\s*\(/.test(script);
      const configArray = /window\.KefinTweaksConfig\.performanceTestUserIds\s*=/.test(script);
      if (globalSet || configArray) {
        sources.push({
          section,
          entry,
          field,
          script,
          kind: globalSet ? 'global-set' : 'config-array',
          enabled: entry.Enabled ?? entry.enabled ?? true,
        });
      }
    }
  }
  return sources;
}

async function status() {
  const config = await loadConfig();
  const { plugin, configuration } = await getInjectorConfiguration(config);
  const allowlistSources = testUserSources(configuration).map(source => ({
    name: source.entry.Name || source.entry.name || '(unnamed)',
    section: source.section,
    type: source.kind,
    enabled: source.enabled,
    userIds: configuredTestUsers(source.script),
  }));
  const entries = scriptEntries(configuration).map(({ kind, entry }) => ({
    section: kind,
    name: entry.Name || entry.name || '(unnamed)',
    enabled: entry.Enabled ?? entry.enabled ?? null,
    kefinTweaksPinnedRevisions: revisionRefs(entry),
  }));
  console.log(JSON.stringify({
    server: config.baseUrl,
    plugin: plugin.Name || plugin.name,
    version: plugin.Version || plugin.version,
    performanceTestUserIds: [...new Set(allowlistSources.filter(source => source.enabled).flatMap(source => source.userIds))],
    allowlistSources,
    entries,
  }, null, 2));
}

async function changeTestUser(identifier, args) {
  if (!identifier) throw new Error('Provide an exact Jellyfin username or user ID.');
  const config = await loadConfig();
  const users = await apiRequest(config, '/Users');
  const user = users.find(item => item.Id === identifier)
    || users.find(item => (item.Name || '').toLowerCase() === identifier.toLowerCase());
  if (!user?.Id) throw new Error(`No Jellyfin user matched "${identifier}".`);

  const { plugin, pluginId, configuration } = await getInjectorConfiguration(config);
  const sources = testUserSources(configuration);
  const globalSources = sources.filter(source => source.kind === 'global-set' && source.enabled);
  const targets = args.includes('--config-only')
    ? sources.filter(source => source.kind === 'config-array')
    : args.includes('--remove')
      ? sources
      : globalSources.length ? globalSources : sources.filter(source => source.kind === 'config-array');
  if (!targets.length) {
    throw new Error('No existing test-user allowlist script was found. Configure a dedicated allowlist script first; no changes were made.');
  }
  if (targets.some(source => source.entry.Enabled === false || source.entry.enabled === false)) {
    throw new Error('A target allowlist script is disabled; no changes were made.');
  }
  const prior = [...new Set(targets.flatMap(source => configuredTestUsers(source.script)))];
  const remove = args.includes('--remove');
  const next = remove ? prior.filter(id => id !== user.Id) : [...new Set([...prior, user.Id])];
  const proposed = structuredClone(configuration);
  for (const source of targets) {
    const proposedEntry = proposed[source.section].find(item => (item.Name || item.name) === (source.entry.Name || source.entry.name));
    let updated = source.script;
    if (source.kind === 'global-set') {
      const assignment = `window.__KefinTweaksPerformanceTestUsers = new Set(${JSON.stringify(next)});`;
      updated = updated.replace(/window\.__KefinTweaksPerformanceTestUsers\s*=\s*new Set\s*\(\s*\[[\s\S]*?\]\s*\)\s*;?/, assignment);
    } else if (source.kind === 'config-array') {
      const assignment = `window.KefinTweaksConfig.performanceTestUserIds = ${JSON.stringify(next)};`;
      const pattern = /window\.KefinTweaksConfig\.performanceTestUserIds\s*=\s*\[[\s\S]*?\]\s*;/g;
      if (next.length) updated = updated.replace(pattern, assignment);
      else updated = updated.replace(pattern, '').replace(/\n*\/\/ Per-user performance experiment allowlist\s*$/, '');
    }
    proposedEntry[source.field] = updated;
  }
  console.log(JSON.stringify({
    mode: args.includes('--apply') ? 'apply-requested' : 'dry-run',
    change: remove ? 'remove' : 'allow',
    user: user.Name,
    userId: user.Id,
    previousAllowlist: prior,
    proposedAllowlist: next,
    target: `${plugin.Name || plugin.name} → ${targets.map(source => source.entry.Name || source.entry.name).join(', ')}`,
    sharedConfigPost: args.includes('--apply'),
  }, null, 2));
  if (!args.includes('--apply')) {
    console.log('Dry run only. No server settings were changed.');
    return;
  }
  if (!args.includes('--confirm-shared-config')) {
    throw new Error('Refusing to write shared Injector configuration without --confirm-shared-config.');
  }

  await apiRequest(config, `/Plugins/${encodeURIComponent(pluginId)}/Configuration`, {
    method: 'POST',
    body: JSON.stringify(proposed),
  });
  const { configuration: verified } = await getInjectorConfiguration(config);
  const savedIds = [...new Set(testUserSources(verified).flatMap(source => configuredTestUsers(source.script)))];
  const expectedIds = [...new Set(testUserSources(proposed).flatMap(source => configuredTestUsers(source.script)))];
  if (JSON.stringify(savedIds) !== JSON.stringify(expectedIds)) {
    throw new Error('The POST completed, but the saved per-user allowlist did not match the requested value.');
  }
  console.log('Verified the saved test-user allowlist. Refresh only that account to activate the experiment.');
}

async function setRevision(revision, args) {
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('Use a full 40-character commit SHA, not a branch or tag.');
  const config = await loadConfig();
  const { plugin, pluginId, configuration } = await getInjectorConfiguration(config);
  const targets = revisionEntryNames.map(name => {
    const entry = (configuration.CustomJavaScripts || []).find(item => (item.Name || item.name) === name);
    if (!entry) throw new Error(`Could not find the CustomJavaScripts entry named "${name}".`);
    const field = typeof entry.Code === 'string' ? 'Code' : typeof entry.Script === 'string' ? 'Script' : null;
    if (!field) throw new Error(`The ${name} entry has no recognized Code/Script field; no changes were made.`);
    return { name, entry, field, before: entry[field] };
  });
  const pattern = /(cdn\.jsdelivr\.net\/gh\/Sootie1776\/KefinTweaks@)[0-9a-f]{7,40}(?=\/)/gi;
  const proposed = structuredClone(configuration);
  const changes = targets.map(({ name, before }) => {
    const after = before.replace(pattern, `$1${revision}`);
    if (after === before) throw new Error(`No pinned Sootie1776/KefinTweaks commit URL was found in ${name}.`);
    const proposedEntry = proposed.CustomJavaScripts.find(entry => (entry.Name || entry.name) === name);
    const field = typeof proposedEntry.Code === 'string' ? 'Code' : 'Script';
    proposedEntry[field] = after;
    return { name, previousPinnedRevisions: revisionRefs({ Code: before }), replacements: [...before.matchAll(pattern)].length };
  });
  console.log(JSON.stringify({
    mode: args.includes('--apply') ? 'apply-requested' : 'dry-run',
    server: config.baseUrl,
    target: `${plugin.Name || plugin.name} → ${revisionEntryNames.join(', ')}`,
    changes,
    proposedRevision: revision,
    sharedConfigPost: args.includes('--apply'),
  }, null, 2));
  if (!args.includes('--apply')) {
    console.log('Dry run only. No server settings were changed.');
    return;
  }
  if (!args.includes('--confirm-shared-config')) {
    throw new Error('Refusing to write shared Injector configuration without --confirm-shared-config.');
  }
  await apiRequest(config, `/Plugins/${encodeURIComponent(pluginId)}/Configuration`, {
    method: 'POST',
    body: JSON.stringify(proposed),
  });
  console.log('Updated the Kefin Tweaks pinned revision. Refresh Jellyfin to load it; existing sessions are unaffected until refreshed.');
}

function navigationStarts(events) {
  return events
    .filter(event => event.ph === 'b' && typeof event.ts === 'number' && /Navigation: .*\/web\/#\/home/.test(event.name || ''))
    .sort((a, b) => a.ts - b.ts);
}

async function readTrace(file) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed.traceEvents)) throw new Error(`${path.basename(file)} is not a Chrome trace export (traceEvents missing).`);
  const events = parsed.traceEvents;
  const homes = navigationStarts(events);
  if (!homes.length) throw new Error(`No Jellyfin Home navigation was found in ${path.basename(file)}.`);
  // Use the first captured Home navigation. Later same-route SPA transitions
  // can create short paint intervals that are not the page-load measurement.
  const nav = homes[0];
  const scoped = events.filter(event => event.pid === nav.pid && event.ts >= nav.ts);
  const firstEvent = name => scoped.find(event => event.name === name && event.ts >= nav.ts);
  const fcp = firstEvent('firstContentfulPaint');
  const lcpCandidates = scoped.filter(event => event.name === 'largestContentfulPaint::Candidate' && event.ph === 'R');
  const latestLcp = lcpCandidates.at(-1);
  const msFromStart = event => event ? Math.round((event.ts - nav.ts) / 1000) : null;
  const markTime = name => {
    const event = scoped.find(item => {
      const data = item.args?.data || {};
      return item.name === name || data.name === name || data.message === name;
    });
    return msFromStart(event);
  };
  const requests = new Map();
  const responses = new Map();
  const finishes = new Map();
  for (const event of events) {
    const data = event.args?.data || {};
    if (event.name === 'ResourceSendRequest') requests.set(data.requestId, { ...data, ts: event.ts });
    else if (event.name === 'ResourceReceiveResponse') responses.set(data.requestId, data);
    else if (event.name === 'ResourceFinish') finishes.set(data.requestId, { ...data, ts: event.ts });
  }

  const imageTotals = new Map();
  let imageBytes = 0;
  let imageCount = 0;
  const imageCache = { fromCache: 0, fromServiceWorker: 0, network: 0 };
  for (const [requestId, request] of requests) {
    const response = responses.get(requestId);
    if (!(response?.mimeType || '').startsWith('image/')) continue;
    if (response.fromCache) imageCache.fromCache += 1;
    else if (response.fromServiceWorker) imageCache.fromServiceWorker += 1;
    else imageCache.network += 1;
    const bytes = finishes.get(requestId)?.encodedDataLength || 0;
    let imagePath = 'unknown';
    try {
      const url = new URL(request.url);
      imagePath = `${url.host}${url.pathname}`
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<guid>')
        .replace(/[0-9a-f]{32}/gi, '<id>');
    } catch { /* Keep the path redacted if parsing fails. */ }
    const current = imageTotals.get(imagePath) || { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += bytes;
    imageTotals.set(imagePath, current);
    imageBytes += bytes;
    imageCount += 1;
  }

  const kefinRequests = [...requests.values()].filter(request => {
    try {
      const url = new URL(request.url);
      return url.host === 'cdn.jsdelivr.net' && url.pathname.includes('/gh/Sootie1776/KefinTweaks@');
    } catch { return false; }
  });
  const kefinFirstStart = kefinRequests.length ? Math.min(...kefinRequests.map(request => request.ts)) : null;
  const longTasks = scoped.filter(event => event.pid === nav.pid && event.name === 'RunTask'
    && event.ph === 'X' && event.dur >= 50000);
  const lastEventTs = scoped.reduce((max, event) => Math.max(max, event.ts || max), nav.ts);
  const recordingWindowMs = Math.round((lastEventTs - nav.ts) / 1000);
  return {
    file: path.basename(file),
    traceStart: parsed.metadata?.startTime || null,
    recordingWindowMs,
    fcpMs: msFromStart(fcp),
    lcpLastCandidateMs: msFromStart(latestLcp),
    lcpCandidateCount: lcpCandidates.length,
    lcpLastCandidateNode: latestLcp?.args?.data?.nodeName || null,
    lcpLastCandidateSize: latestLcp?.args?.data?.size || null,
    homePaintedMs: markTime('KefinTweaks:HomePainted'),
    optionalAssetsStartMs: markTime('KefinTweaks:OptionalAssetsStart'),
    kefinTweaks: {
      scriptRequests: kefinRequests.length,
      firstRequestMs: kefinFirstStart == null ? null : Math.round((kefinFirstStart - nav.ts) / 1000),
      firstRequestBeforeFcp: kefinFirstStart != null && fcp ? kefinFirstStart < fcp.ts : null,
    },
    images: {
      requestCount: imageCount,
      transferredKB: Math.round(imageBytes / 1024),
      cacheSources: imageCache,
      largestPaths: [...imageTotals].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5).map(([imagePath, value]) => ({
        path: imagePath,
        requestCount: value.count,
        transferredKB: Math.round(value.bytes / 1024),
      })),
    },
    mainThreadLongTasks: {
      count: longTasks.length,
      totalMs: Math.round(longTasks.reduce((sum, event) => sum + event.dur, 0) / 1000),
      maxMs: longTasks.length ? Math.round(Math.max(...longTasks.map(event => event.dur)) / 1000) : 0,
    },
  };
}

async function compare(baselinePath, testPath) {
  const [baseline, test] = await Promise.all([readTrace(baselinePath), readTrace(testPath)]);
  const valueAt = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
  const delta = (key) => {
    const before = valueAt(baseline, key);
    const after = valueAt(test, key);
    return before == null || after == null ? null : after - before;
  };
  const result = {
    baseline,
    test,
    recordingWindowDeltaPct: baseline.recordingWindowMs
      ? Math.round(((test.recordingWindowMs - baseline.recordingWindowMs) / baseline.recordingWindowMs) * 100)
      : null,
    changeMs: {
      fcp: delta('fcpMs'),
      lcpLastCandidate: delta('lcpLastCandidateMs'),
      homePainted: delta('homePaintedMs'),
      optionalAssetsStart: delta('optionalAssetsStartMs'),
      kefinFirstRequest: delta('kefinTweaks.firstRequestMs'),
      imageTransferKB: delta('images.transferredKB'),
      imageCacheHits: delta('images.cacheSources.fromCache'),
      mainThreadLongTaskTotal: delta('mainThreadLongTasks.totalMs'),
    },
    note: 'Negative is faster. Check recording-window consistency. LCP is only valid when both traces include meaningful Home content; compare candidate count/node/size too.',
  };
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') return usage();
  if (command === 'status') return status();
  if (command === 'set-revision') return setRevision(args[0], args.slice(1));
  if (command === 'test-user') return changeTestUser(args[0], args.slice(1));
  if (command === 'compare') {
    if (args.length !== 2) throw new Error('compare needs a baseline and a test trace file.');
    return compare(path.resolve(args[0]), path.resolve(args[1]));
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
