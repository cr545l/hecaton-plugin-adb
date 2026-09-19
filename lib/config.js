'use strict';
// lib/config.js — 플러그인 설정 영속화 [A4]. HECA_PLUGIN_DATA_DIR/config.json, 없으면 ~/.hecaton/data/dev.hecaton.adb.

const VERSION = 1;

const DEFAULTS = Object.freeze({
  version: VERSION,
  adbPath: '',
  recentHosts: [],
  minLevel: 'V',
  showAllPackages: false,
  sidebarVisible: true,
  filesPath: '/sdcard',
  logcatBuffers: [],
  lastTab: 'overview',
});

function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function sanitize(raw) {
  const out = { ...DEFAULTS, recentHosts: [] };
  if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return out;
  if (typeof raw.adbPath === 'string') out.adbPath = raw.adbPath;
  if (Array.isArray(raw.recentHosts)) out.recentHosts = raw.recentHosts.filter((h) => typeof h === 'string').slice(0, 10);
  if (['V', 'D', 'I', 'W', 'E', 'F'].includes(raw.minLevel)) out.minLevel = raw.minLevel;
  if (typeof raw.showAllPackages === 'boolean') out.showAllPackages = raw.showAllPackages;
  if (typeof raw.sidebarVisible === 'boolean') out.sidebarVisible = raw.sidebarVisible;
  if (typeof raw.filesPath === 'string' && raw.filesPath.startsWith('/')) out.filesPath = raw.filesPath;
  if (Array.isArray(raw.logcatBuffers)) out.logcatBuffers = raw.logcatBuffers.filter((b) => ['main', 'system', 'crash', 'radio', 'events', 'kernel', 'all'].includes(b));
  if (typeof raw.lastTab === 'string') out.lastTab = raw.lastTab;
  return out;
}

async function createStore() {
  let dir = '';
  try { dir = (((await hecaton.env.get({ name: 'HECA_PLUGIN_DATA_DIR' })) || {}).value) || ''; } catch { /* ignore */ }
  if (!dir) {
    try {
      const home = ((await hecaton.env.get_home()) || {}).path || '';
      dir = joinPath(home, '.hecaton', 'data', 'dev.hecaton.adb');
    } catch { dir = ''; }
  }
  const file = dir ? joinPath(dir, 'config.json') : '';
  let current = { ...DEFAULTS, recentHosts: [] };
  let saveTimer = null;
  let lastError = null;

  async function load() {
    if (!file) return current;
    try {
      const r = await hecaton.fs.read_file({ path: file });
      if (r && r.ok !== false && r.content) current = sanitize(JSON.parse(r.content));
    } catch { /* 첫 실행이거나 읽기 거부 — 기본값 */ }
    return current;
  }

  async function flush() {
    if (!file) return false;
    try {
      await hecaton.fs.mkdir({ path: dir, recursive: true });
      const r = await hecaton.fs.write_file({ path: file, content: JSON.stringify(current, null, 2) });
      lastError = r && r.ok === false ? (r.error || 'write failed') : null;
      return !lastError;
    } catch (e) {
      lastError = String(e && e.message || e);
      return false;
    }
  }

  // 변경 즉시 저장 (디바운스) — 저장 버튼 없음 [A4]
  function update(patch) {
    Object.assign(current, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 400);
    if (saveTimer.unref) saveTimer.unref();
  }

  function rememberHost(host) {
    const list = [host, ...current.recentHosts.filter((h) => h !== host)].slice(0, 10);
    update({ recentHosts: list });
  }

  return {
    get: () => current,
    file, dir,
    load, flush, update, rememberHost,
    lastError: () => lastError,
  };
}

module.exports = { createStore, sanitize, DEFAULTS, VERSION };
