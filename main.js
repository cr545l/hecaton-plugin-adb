#!/usr/bin/env node
'use strict';
/**
 * ADB Manager — Hecaton Plugin
 *
 * adb 의 일상 작업을 GUI 로: 단말 목록·무선 연결·서버 재시작, 실시간 logcat, 패키지·파일·포트 포워딩, 셸.
 * 모든 컨트롤은 클릭 가능하고 우클릭 메뉴와 키보드 경로를 함께 가진다 [P4][K3].
 *
 * 부팅 [M3]: 첫 프레임 → stdin → 비동기 초기화(adb 탐색 → 단말 목록 → 폴링).
 * 종료 [M4]: logcat 프로세스 kill, 커서/툴팁 원복, 긴급 경로에서는 await 금지.
 */

const i18n = require('./lib/i18n');
const { t } = i18n;
const screen = require('./lib/screen');
const zones = require('./lib/zones');
const input = require('./lib/input');
const dialogs = require('./lib/dialogs');
const { ansi } = require('./lib/ansi');
const S = require('./lib/state');
const adb = require('./lib/adb');
const logcatLib = require('./lib/logcat');
const configLib = require('./lib/config');
const renderLib = require('./lib/render');
const actionsLib = require('./lib/actions');
const menusLib = require('./lib/menus');

const state = S.createState();
const ctx = { state, logcat: null, config: null, actions: null, menus: null, rerender: screen.scheduleRender, quit };

let devicesTimer = null;
let tickTimer = null;
let lastClick = { row: -1, col: -1, at: 0 };
let shuttingDown = false;

function main() {
  try { i18n.setLocale((hecaton.initialState || {}).locale); } catch { /* ignore */ }
  const init = hecaton.initialState || {};
  state.cols = Number(init.cols) || 80;
  state.rows = Number(init.rows) || 24;
  state.minimized = !!init.minimized;

  ctx.logcat = logcatLib.create({ onChange: onLogcatChange });
  ctx.config = { get: () => configLib.DEFAULTS, update() {}, rememberHost() {} };  // 로드 전 임시
  ctx.actions = actionsLib.create(ctx);
  ctx.menus = menusLib.create(ctx);

  screen.init(() => renderLib.render(ctx));
  screen.scheduleRender();               // 1. 첫 프레임
  setupStdin();                          // 2. 입력
  setupEvents();
  initAsync().catch((e) => { process.stderr.write('init error: ' + (e && e.stack || e) + '\n'); });   // 3. 비동기 초기화
}

async function initAsync() {
  // 터미널 크기 확인 (initialState 에 없을 때)
  try {
    const c = await hecaton.env.get({ name: 'HECA_COLS' });
    const r = await hecaton.env.get({ name: 'HECA_ROWS' });
    if (c && c.value) state.cols = parseInt(c.value, 10) || state.cols;
    if (r && r.value) state.rows = parseInt(r.value, 10) || state.rows;
  } catch { /* ignore */ }
  screen.scheduleRender();

  const store = await configLib.createStore();
  await store.load();
  ctx.config = store;
  const cfg = store.get();
  state.sidebarVisible = cfg.sidebarVisible;
  state.packages.showAll = cfg.showAllPackages;
  state.files.path = cfg.filesPath || '/sdcard';
  state.logcatBuffers = cfg.logcatBuffers || [];
  if (state.tabs.includes(cfg.lastTab)) state.tab = cfg.lastTab;
  ctx.logcat.setFilter({ minLevel: cfg.minLevel || 'V' });
  // actions 는 config 참조를 ctx 를 통해 읽으므로 다시 만들 필요가 없다 — 단, 생성 시 구조 분해로 잡은 config 를 갱신한다
  ctx.actions = actionsLib.create(ctx);
  ctx.menus = menusLib.create(ctx);

  try { hecaton.i18n.get_locale().then((loc) => { if (loc && loc.locale && i18n.setLocale(loc.locale)) { registerShortcuts(); screen.scheduleRender(); } }).catch(() => {}); } catch { /* < 1.11 */ }
  try { hecaton.sys.get_api_version().then((v) => { state.hostVersion = v; }).catch(() => {}); } catch { /* ignore */ }
  try { hecaton.lifecycle.request_shutdown_notice({ grace_ms: 500 }).catch(() => {}); } catch { /* ignore */ }
  registerShortcuts();
  ctx.actions.updateTitle();

  await ctx.actions.probeAdb();
  if (state.adbReady) ctx.actions.mdnsScan(true);
  setupTimers();
}

// ---------- 타이머 [A2] ----------

function setupTimers() {
  const schedule = () => {
    if (devicesTimer) clearTimeout(devicesTimer);
    const period = state.minimized ? 10000 : 3000;
    devicesTimer = setTimeout(async () => {
      if (state.adbReady && !shuttingDown) {
        await ctx.actions.refreshDevices(true);
        if (!state.minimized && Date.now() - state.mdnsAt > 20000) ctx.actions.mdnsScan(true);
        const d = S.selectedDevice(state);
        if (!state.minimized && d && state.tab === 'overview') {
          const rec = state.info[d.serial];
          if (!rec || Date.now() - (rec.at || 0) > 30000) ctx.actions.loadInfo(d.serial);
        }
      }
      schedule();
    }, period);
    if (devicesTimer.unref) devicesTimer.unref();
  };
  schedule();
  // 66ms 틱: logcat 유입 코얼레싱, 스피너·상태 만료 갱신
  tickTimer = setInterval(() => {
    if (state.dirty) { state.dirty = false; screen.scheduleRender(); return; }
    if (state.busy || (state.status && state.status.until && state.status.until < Date.now() + 100)) screen.scheduleRender();
    else if (!state.minimized && (state.devicesLoading || state.packages.loading || state.files.loading || state.shell.running || state.forwards.loading || Object.values(state.info).some((r) => r.loading))) screen.scheduleRender();
  }, 66);
  if (tickTimer.unref) tickTimer.unref();
}

function onLogcatChange(kind) {
  if (kind === 'data') {
    if (!state.logcat.follow) {
      const visibleNow = ctx.logcat.visible().length;
      state.logcat.newSince += Math.max(0, visibleNow - state.logcat.lastVisibleCount);
      state.logcat.lastVisibleCount = visibleNow;
    }
    if (state.tab === 'logcat' || state.minimized) state.dirty = true;
    return;
  }
  if (kind === 'error' && ctx.logcat.session.error && !ctx.logcat.session.running) ctx.actions.setStatusText('logcat: ' + ctx.logcat.session.error, 'error', 8000);
  screen.scheduleRender();
}

// ---------- 단축키 카드 (API 1.13, 표시 전용) ----------

function registerShortcuts() {
  try {
    hecaton.shortcuts.set({
      group: t('shortcuts.group'),
      shortcuts: [
        { key: 'Shift+R', description: t('shortcuts.reboot') },
        { key: 'Shift+S', description: t('shortcuts.saveLog') },
        { key: 'Shift+Tab', description: t('shortcuts.prevTab') },
        { key: 'Ctrl+L', description: t('shortcuts.clearLog') },
        { key: 'Ctrl+F', description: t('shortcuts.filter') },
      ],
    }).catch(() => {});
  } catch { /* < 1.13 */ }
}

// ---------- 입력 ----------

function setupStdin() {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch { /* ignore */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  input.init({ onMove, onClick, onRelease, onScroll, onKey });
  process.stdin.on('data', (d) => input.handleStdin(d));
  process.stdin.on('end', () => emergencyExit());
  process.on('SIGTERM', () => emergencyExit());
  process.on('SIGINT', () => emergencyExit());
}

function onMove(row, col) {
  if (state.minimized) return;
  if (zones.setHover(row, col)) screen.scheduleRender();
  else zones.syncPointer();
}

function onClick(row, col, button, mods) {
  zones.setHover(row, col);
  if (state.minimized) {
    if (button === 0) ctx.actions.runAction('restore');
    return;
  }
  const zone = zones.hitTest(row, col);
  // 우클릭은 호스트의 menu_requested 이벤트로 온다 — SGR 버튼 2 를 따로 처리하면 메뉴가 두 번 뜬다
  if (button !== 0) return;
  const now = Date.now();
  const doubleClick = lastClick.row === row && lastClick.col === col && now - lastClick.at < 400;
  lastClick = { row, col, at: now };
  if (!zone || !zone.action) return;
  // 리스트 행: 클릭 = 선택, 같은 행 재클릭(더블클릭) = 열기/메뉴
  const head = zone.action.split(':')[0];
  if (head === 'pk-row' && doubleClick) { ctx.actions.runAction('pk-menu:' + zone.data.name); return; }
  if (head === 'lc-line' && doubleClick) { ctx.actions.runAction('lc-line-menu:' + zone.data.idx); return; }
  if (head === 'fw-row' && doubleClick) { ctx.actions.runAction('fw-menu:' + zone.data.idx); return; }
  ctx.actions.runAction(zone.action, { ...zone.data, doubleClick, mods });
}

function onRelease() { /* 드래그 없음 */ }

function onScroll(deltaY, deltaX) {
  if (state.minimized) return;
  const pos = zones.hoverPos();
  const inSidebar = state.layout.sidebarW > 0 && pos.col <= state.layout.sidebarW;
  const step = Math.sign(deltaY) * Math.max(1, Math.min(10, Math.abs(Math.round(deltaY))));
  if (step) ctx.actions.scrollList(step, inSidebar);
}

function onKey(name) {
  if (state.minimized) return;
  if (dialogs.isOpen()) return;          // 모달 중에는 단축키 중단 [W15]
  const a = (id) => ctx.actions.runAction(id);
  switch (name) {
    case 'q': return a('quit');
    case '?': return a('help');
    case 'Tab': return a('next-tab');
    case 'Shift+Tab': return a('prev-tab');
    case '1': case '2': case '3': case '4': case '5': case '6': return a('tab:' + state.tabs[Number(name) - 1]);
    case '[': return a('prev-device');
    case ']': return a('next-device');
    case 'D': return a('device-menu');
    case 'r': return a('refresh');
    case 'b': return a('toggle-sidebar');
    case 'Up': return a('list-up');
    case 'Down': return a('list-down');
    case 'PageUp': return a('page-up');
    case 'PageDown': return a('page-down');
    case 'Home': return a('list-home');
    case 'End': return a('list-end');
    case 'Enter': return a('enter');
    case 'Ctrl+F': case '/': return a(state.tab === 'packages' ? 'pk-search' : state.tab === 'logcat' ? 'lc-text' : state.tab === 'files' ? 'fs-goto' : 'device-menu');
    case 'R': return a('reboot-menu');
    case 'w': return a('wifi-enable');
    case 'W': return a('connect');
    case 'P': return a('pair');
    case 'K': return a('server-kill');
    case 'default': return;
  }
  switch (state.tab) {
    case 'overview':
      if (name === 's') return a('screenshot');
      if (name === 'i') return a('install');
      if (name === 't') return a('open-shell-tab');
      break;
    case 'logcat':
      if (name === 'p' || name === 'Space') return a('lc-follow');
      if (name === 'l') return a('lc-level-cycle');
      if (name === 'c' || name === 'Ctrl+L') return a('lc-clear');
      if (name === 'S') return a('lc-save');
      if (name === 'x') return a('lc-clear-filters');
      if (name === 'y') return a('lc-copy-selected');
      if (name === 'm') return state.logcat.sel >= 0 ? a('lc-line-menu:' + state.logcat.sel) : null;
      if (name === 'Escape') { state.logcat.sel = -1; screen.scheduleRender(); return; }
      break;
    case 'packages':
      if (name === 'i') return a('install');
      if (name === 'm') return a('pk-menu');
      if (name === 'a') return a('pk-scope:' + (state.packages.showAll ? 0 : 1));
      if (name === 'Escape' && state.packages.query) return a('pk-clear-search');
      break;
    case 'files':
      if (name === 'Backspace' || name === 'Left') return a('fs-up');
      if (name === 'Right') return a('fs-enter');
      if (name === 'm') return a('fs-menu');
      if (name === 'g') return a('fs-goto');
      if (name === 'u') return a('fs-push');
      if (name === 'n') return a('fs-mkdir');
      if (name === 'Delete') return a('fs-delete:' + state.files.sel);
      break;
    case 'shell':
      if (name === '.') return a('sh-repeat');
      if (name === 'c') return a('sh-clear');
      if (name === 'k') return a('sh-quick');
      if (name === 't') return a('open-shell-tab');
      break;
    case 'forwards':
      if (name === 'f') return a('fw-add');
      if (name === 'v') return a('rv-add');
      if (name === 'Delete' || name === 'x') return a('fw-remove');
      if (name === 'm') return a('fw-menu');
      break;
    default: break;
  }
}

async function openContextMenu(row, col) {
  const zone = zones.hitTest(row, col);
  const result = ctx.menus.itemsForZone(zone);
  if (result === null) return;
  if (result && result.deferred) { screen.scheduleRender(); result.deferred(); return; }
  if (!result || !result.length) return;
  try { await hecaton.menu.show({ items: result }); } catch { /* ignore */ }
}

// ---------- 호스트 이벤트 ----------

function setupEvents() {
  hecaton.on('window_resized', (p) => {
    if (p && p.cols) state.cols = p.cols;
    if (p && p.rows) state.rows = p.rows;
    screen.invalidate();
    screen.scheduleRender();
  });
  hecaton.on('window_minimized', () => { state.minimized = true; zones.clearHover(); zones.resetPointer(); screen.scheduleRender(); });
  hecaton.on('window_restored', () => { state.minimized = false; screen.invalidate(); screen.scheduleRender(); if (ctx.actions) ctx.actions.onTabShown(); });
  hecaton.on('window_maximized', () => { screen.invalidate(); screen.scheduleRender(); });
  hecaton.on('mouse_event', (p) => input.handleHostMouseEvent(p));
  hecaton.on('menu_requested', (p) => { if (!state.minimized) openContextMenu(p.row || 1, p.col || 1); else openMinimizedMenu(); });
  hecaton.on('menu_activated', (p) => { if (p && p.id) ctx.actions.runAction(p.id); });
  hecaton.on('dialog_resolved', (p) => { dialogs.handleResolved(p); screen.scheduleRender(); });
  hecaton.on('process_output', (p) => { ctx.logcat.handleOutput(p); });
  hecaton.on('process_exited', (p) => { if (ctx.logcat.handleExited(p)) screen.scheduleRender(); });
  hecaton.on('locale_changed', (p) => {
    if (!i18n.setLocale(p && p.locale)) return;
    registerShortcuts();
    ctx.actions.updateTitle();
    screen.invalidate();
    screen.scheduleRender();
  });
  hecaton.on('shutdown', () => {
    cleanup();
    try { hecaton.lifecycle.shutdown_complete().catch(() => {}); } catch { /* ignore */ }
  });
}

async function openMinimizedMenu() {
  try { await hecaton.menu.show({ items: [{ id: 'restore', label: t('menu.restore'), icon: 'chrome-restore' }, { id: 'refresh', label: t('btn.refresh'), icon: 'refresh' }, { id: 'quit', label: t('hint.quit'), icon: 'close' }] }); } catch { /* ignore */ }
}

// ---------- 종료 [M4] ----------

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (devicesTimer) clearTimeout(devicesTimer);
  if (tickTimer) clearInterval(tickTimer);
  const id = ctx.logcat && ctx.logcat.session.processId;
  if (id) { try { hecaton.process.kill({ process_id: id }).catch(() => {}); } catch { /* ignore */ } }
  try { hecaton.shortcuts.set({ group: 'ADB', shortcuts: [] }).catch(() => {}); } catch { /* ignore */ }
  zones.resetPointer();
  screen.write(ansi.showCursor + ansi.reset + ansi.clear);
}

async function quit() {
  cleanup();
  try { await hecaton.window.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 80);
}

function emergencyExit() {
  cleanup();
  setTimeout(() => process.exit(0), 60);
}

// 호스트는 진입 파일을 로더에서 require 하므로 require.main 검사로 게이트하면 안 된다 — 항상 실행한다.
// 테스트 하네스만 전역 플래그로 자동 실행을 끄고 main() 을 직접 부른다.
if (!globalThis.__HECATON_ADB_NO_AUTORUN__) {
  try { main(); } catch (e) { process.stderr.write('Error: ' + (e && e.stack || e) + '\n'); process.exit(1); }
}

module.exports = { main, ctx, state, onKey, onClick, onScroll, onMove, openContextMenu, cleanup };
