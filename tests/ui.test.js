'use strict';
// UI 통합 테스트 — 가짜 hecaton 호스트로 main.js 를 띄우고 렌더·클릭·키·메뉴를 검사한다.
// 실제 adb 는 실행하지 않는다 (process.exec 을 가짜 응답으로 대체).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); }

function makeHost(opts = {}) {
  const events = {};
  const calls = { exec: [], spawn: [], kill: [], dialogs: [], menus: [], clipboard: [], titles: [] };
  const devicesOut = opts.devices || 'List of devices attached\nSER123 device product:p model:Pixel_7 device:d transport_id:1\n192.168.0.9:5555 device model:Wifi_Dev transport_id:2\n';
  const host = {
    initialState: { locale: opts.locale || 'en', cols: opts.cols || 120, rows: opts.rows || 32 },
    on: (name, fn) => { events[name] = fn; },
    env: { get: async ({ name }) => ({ value: name === 'HECA_PLUGIN_DATA_DIR' ? 'C:/tmp/adbdata' : '' }), get_home: async () => ({ path: 'C:/Users/me' }) },
    sys: { get_platform: async () => ({ platform: 'windows' }), get_api_version: async () => ({ apiVersion: '1.16' }) },
    fs: { read_file: async () => ({ ok: false }), write_file: async () => ({ ok: true }), mkdir: async () => ({ ok: true }) },
    window: { set_title: async (p) => { calls.titles.push(p.title); }, set_minimized_label: async () => ({}), set_cursor: async () => ({}), set_tooltip: async () => ({}), close: async () => ({}), restore: async () => ({}) },
    dialog: { show: async (p) => { calls.dialogs.push(p); return { ok: true }; } },
    menu: { show: async (p) => { calls.menus.push(p); return { ok: true }; } },
    clipboard: { write: async (p) => { calls.clipboard.push(p.text); return { ok: true }; } },
    picker: { file: async () => ({ path: 'C:/apps/app.apk' }), save: async () => ({ path: 'C:/out/file.png' }), folder: async () => ({ path: 'C:/out' }) },
    shortcuts: { set: async () => ({}) },
    i18n: { get_locale: async () => ({ locale: opts.locale || 'en' }) },
    lifecycle: { request_shutdown_notice: async () => ({}), shutdown_complete: async () => ({}) },
    tabs: { open_terminal: async () => ({ ok: true, terminal_id: 7 }) },
    terminal: { send_command: async () => ({ ok: true }) },
    process: {
      exec: async (p) => {
        calls.exec.push(p);
        const args = p.args.join(' ');
        if (args === 'version') return { ok: true, exit_code: 0, stdout: 'Android Debug Bridge version 1.0.41\nVersion 36.0.0\nInstalled as ' + p.program + '\n' };
        if (args === 'devices -l') return { ok: true, exit_code: 0, stdout: devicesOut };
        if (args.includes('pm list packages')) return { ok: true, exit_code: 0, stdout: 'package:com.example.two\npackage:com.example.one\n' };
        if (args.includes('ls -lA')) return { ok: true, exit_code: 0, stdout: 'drwxrwx--- 2 root sdcard_rw 4096 2024-01-01 12:00 Download\n-rw-rw---- 1 root sdcard_rw 10 2024-01-01 12:00 note.txt\n' };
        if (args.includes('forward --list')) return { ok: true, exit_code: 0, stdout: 'SER123 tcp:8080 tcp:8080\n' };
        if (args.includes('reverse --list')) return { ok: true, exit_code: 0, stdout: '' };
        if (args.includes('mdns services')) return { ok: true, exit_code: 0, stdout: 'List of discovered mdns services\n' };
        if (args.includes('echo "@@manufacturer"')) return { ok: true, exit_code: 0, stdout: '@@manufacturer\nGoogle\n@@model\nPixel 7\n@@release\n14\n@@sdk\n34\n@@battery\nlevel: 55\nstatus: 3\n' };
        if (args.includes('kill-server') || args.includes('start-server')) return { ok: true, exit_code: 0, stdout: '' };
        if (args.startsWith('connect ')) return { ok: true, exit_code: 0, stdout: 'connected to ' + p.args[1] };
        if (args.includes(' shell ')) return { ok: true, exit_code: 0, stdout: 'ok-output\n' };
        return { ok: true, exit_code: 0, stdout: '' };
      },
      spawn: async (p) => { calls.spawn.push(p); return { ok: true, process_id: 'proc-' + calls.spawn.length }; },
      kill: async (p) => { calls.kill.push(p.process_id); return { ok: true }; },
    },
  };
  return { host, events, calls };
}

async function boot(opts) {
  const { host, events, calls } = makeHost(opts);
  global.hecaton = host;
  const frames = [];
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  const screen = require(path.join(root, 'lib/screen'));
  screen.setWriter((s) => { frames.push(String(s)); });
  const stdinResume = process.stdin.resume; process.stdin.resume = () => process.stdin;
  const stdinRaw = process.stdin.setRawMode; process.stdin.setRawMode = () => process.stdin;
  globalThis.__HECATON_ADB_NO_AUTORUN__ = true;
  const app = require(path.join(root, 'main.js'));
  app.main();
  // initAsync 가 끝날 때까지 기다린다 (adb 탐색 → 단말 목록)
  for (let i = 0; i < 50 && !app.state.devicesEverLoaded; i++) await new Promise((r) => setTimeout(r, 10));
  await flush();
  process.stdin.resume = stdinResume;
  process.stdin.setRawMode = stdinRaw;
  const api = {
    app, state: app.state, ctx: app.ctx, events, calls, frames, screen,
    lastFrame: () => stripAnsi(frames[frames.length - 1] || ''),
    screenText: () => stripAnsi(frames.slice(-3).join('')),
    restore: () => { app.cleanup(); process.stdin.pause(); },
    flush,
  };
  return api;
}

async function flush() { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 5)); }

test('boots, probes adb, lists devices, renders tabs and device sidebar', async () => {
  const u = await boot();
  try {
    assert.equal(u.state.adbReady, true);
    assert.equal(u.state.devices.length, 2);
    assert.equal(u.state.selectedSerial, 'SER123');
    const txt = u.lastFrame();
    assert.ok(txt.includes('Overview') && txt.includes('Logcat') && txt.includes('Packages'));
    assert.ok(txt.includes('Pixel 7'));
    assert.ok(txt.includes('Wifi Dev'));
    assert.ok(txt.includes('Restart server'));
    assert.ok(u.calls.titles.some((t) => t.includes('Pixel 7')));
  } finally { u.restore(); }
});

test('tab keys, device cycling and logcat auto-start via spawn', async () => {
  const u = await boot();
  try {
    u.app.onKey('2');
    await u.flush();
    assert.equal(u.state.tab, 'logcat');
    assert.equal(u.calls.spawn.length, 1);
    assert.deepEqual(u.calls.spawn[0].args.slice(0, 3), ['-s', 'SER123', 'logcat']);
    // 출력 이벤트 → 줄 누적 → 렌더
    u.events.process_output({ process_id: 'proc-1', stream: 'stdout', data: '09-20 08:12:33.123  1  2 E MyTag: boom happened\n' });
    await new Promise((r) => setTimeout(r, 90));
    await u.flush();
    assert.ok(u.lastFrame().includes('boom happened'));
    // 단말 전환 → 이전 logcat kill
    u.app.onKey(']');
    await u.flush();
    assert.equal(u.state.selectedSerial, '192.168.0.9:5555');
    assert.ok(u.calls.kill.includes('proc-1'));
    u.app.onKey('Tab');
    await u.flush();
    assert.equal(u.state.tab, 'packages');
    assert.equal(u.ctx.state.packages.list.length, 2);
    assert.ok(u.lastFrame().includes('com.example.one'));
  } finally { u.restore(); }
});

test('clicking toolbar buttons and list rows dispatches actions; right-click opens context menu', async () => {
  const u = await boot();
  try {
    // 1행 제목줄의 "Kill server" 버튼 클릭 → 확인 다이얼로그
    const title = u.lastFrame().split('\n')[0] || stripAnsi(u.frames[u.frames.length - 1]).split('\x1b')[0];
    const zones = require(path.join(root, 'lib/zones'));
    const killZone = findZone(zones, 'server-kill');
    assert.ok(killZone, 'kill server button zone registered');
    u.app.onClick(killZone.row, killZone.colStart, 0, {});
    await u.flush();
    assert.ok(u.calls.dialogs.some((d) => d.buttons.some((b) => b.id === 'killsrv:confirm')));
    // 확인 → kill-server 실행
    u.events.dialog_resolved({ button_id: 'killsrv:confirm' });
    await u.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(u.calls.exec.some((c) => c.args[0] === 'kill-server'));
    assert.equal(u.state.devices.length, 0, 'device list is emptied after kill-server');
    // 새로고침으로 목록 복구 후 패키지 탭 행 우클릭 → 패키지 메뉴
    u.app.onKey('r');
    await u.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(u.state.devices.length, 2);
    u.app.onKey('3');
    await u.flush();
    await new Promise((r) => setTimeout(r, 20));
    await u.flush();
    const rowZone = findZone(zones, 'pk-row:1');
    assert.ok(rowZone);
    await u.app.openContextMenu(rowZone.row, rowZone.colStart + 2);
    await u.flush();
    const menu = u.calls.menus[u.calls.menus.length - 1];
    assert.ok(menu.items.some((i) => i.id === 'pk-uninstall:com.example.two'));
    // 메뉴 항목 활성화 → 확인 다이얼로그 (파괴적)
    u.events.menu_activated({ id: 'pk-uninstall:com.example.two' });
    await u.flush();
    const dlg = u.calls.dialogs[u.calls.dialogs.length - 1];
    assert.ok(dlg.message.includes('com.example.two'));
    assert.ok(dlg.buttons.find((b) => b.id === 'pkuninst:cancel').default, 'cancel is the default button');
    // 빈 영역 우클릭도 폴백 메뉴 [X3]
    await u.app.openContextMenu(u.state.rows - 3, u.state.cols - 2);
    assert.ok(u.calls.menus[u.calls.menus.length - 1].items.some((i) => i.id === 'refresh'));
  } finally { u.restore(); }
});

test('narrow window hides sidebar, shows device dropdown; korean locale renders translated labels', async () => {
  const u = await boot({ cols: 60, rows: 20, locale: 'ko-KR' });
  try {
    const txt = u.lastFrame();
    assert.equal(u.state.layout.sidebarW, 0);
    assert.ok(txt.includes('개요'), 'korean tab label');
    assert.ok(txt.includes('단말:'), 'device dropdown in title row');
    u.events.locale_changed({ locale: 'en' });
    await u.flush();
    assert.ok(u.lastFrame().includes('Overview'));
  } finally { u.restore(); }
});

test('files tab navigates into folders and shell tab records command output', async () => {
  const u = await boot();
  try {
    u.app.onKey('4');
    await u.flush();
    assert.equal(u.state.files.entries.length, 2);
    assert.equal(u.state.files.entries[0].name, 'Download');
    u.app.onKey('Enter');
    await u.flush();
    assert.equal(u.state.files.path, '/sdcard/Download');
    u.app.onKey('Backspace');
    await u.flush();
    assert.equal(u.state.files.path, '/sdcard');
    u.app.onKey('5');
    await u.flush();
    u.app.onKey('Enter');
    await u.flush();
    u.events.dialog_resolved({ button_id: 'shell:ok', value: 'getprop ro.x' });
    await u.flush();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(u.state.shell.entries.length, 1);
    assert.equal(u.state.shell.entries[0].output, 'ok-output');
    assert.ok(u.lastFrame().includes('$ getprop ro.x'));
    u.app.onKey('6');
    await u.flush();
    assert.equal(u.state.forwards.forward.length, 1);
    assert.ok(u.lastFrame().includes('tcp:8080'));
  } finally { u.restore(); }
});

test('minimized view renders a single line and restore click', async () => {
  const u = await boot();
  try {
    u.events.window_minimized();
    await u.flush();
    const line = u.lastFrame();
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes('ADB'));
    assert.ok(line.includes('2 devices'));
    u.events.window_restored();
    await u.flush();
    assert.ok(u.lastFrame().includes('Overview'));
  } finally { u.restore(); }
});

function findZone(zones, action) {
  for (let r = 1; r < 60; r++) for (let c = 1; c < 200; c++) {
    const z = zones.hitTest(r, c);
    if (z && z.action === action) return z;
  }
  return null;
}
