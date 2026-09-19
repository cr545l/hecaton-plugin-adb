'use strict';
// lib/actions.js — 단일 액션 어휘 [P4]. 클릭·메뉴·키보드가 전부 runAction(id) 로 수렴한다.
// 동적 인자는 'prefix:arg' 로 인코딩한다.

const adb = require('./adb');
const dialogs = require('./dialogs');
const S = require('./state');
const { t } = require('./i18n');
const { LEVELS } = require('./logcat');

const REBOOT_MODES = ['system', 'recovery', 'bootloader', 'fastboot', 'sideload', 'poweroff'];
const KEYEVENTS = [
  ['HOME', 3], ['BACK', 4], ['APP_SWITCH', 187], ['MENU', 82], ['POWER', 26], ['WAKEUP', 224], ['SLEEP', 223],
  ['VOLUME_UP', 24], ['VOLUME_DOWN', 25], ['MUTE', 164], ['ENTER', 66], ['TAB', 61], ['DEL', 67], ['ESCAPE', 111],
  ['CAMERA', 27], ['MEDIA_PLAY_PAUSE', 85], ['NOTIFICATION', 83], ['SETTINGS', 176],
];
const QUICK_COMMANDS = [
  'getprop', 'dumpsys battery', 'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"',
  'dumpsys window displays | grep -E "cur=|app="', 'wm size', 'wm density', 'df -h', 'free -m', 'top -n 1 -m 15',
  'ps -A | head -n 40', 'settings list system', 'settings list global', 'ip addr', 'netstat -tuln', 'logcat -d -t 50',
  'pm list features', 'dumpsys meminfo', 'cat /proc/cpuinfo', 'uptime', 'date',
];
const LOGCAT_BUFFERS = ['main', 'system', 'crash', 'radio', 'events', 'kernel'];

function create(ctx) {
  const { state: s, logcat, config, rerender } = ctx;

  // ---------- 상태·진행 표시 ----------

  function setStatus(key, kind = 'info', args = null, ms = 6000) {
    s.status = { key, args, kind, until: ms ? Date.now() + ms : 0 };
    rerender();
  }
  function setStatusText(text, kind = 'info', ms = 6000) {
    s.status = { text, kind, until: ms ? Date.now() + ms : 0 };
    rerender();
  }
  function fail(key, error, args = {}) {
    setStatusText(t(key, args) + (error ? ' — ' + String(error).slice(0, 160) : ''), 'error', 10000);
  }

  // [A1] 긴 작업은 busy 표시 + 재진입 가드
  let busyDepth = 0;
  async function op(key, args, fn) {
    if (s.busy) { setStatus('status.busy', 'warn'); return null; }
    s.busy = { key, args, since: Date.now() };
    busyDepth++;
    rerender();
    try { return await fn(); }
    catch (e) { fail('status.failed', e && e.message || e); return null; }
    finally { busyDepth--; if (!busyDepth) s.busy = null; rerender(); }
  }

  function dev() { return S.selectedDevice(s); }
  function requireDevice(online = true) {
    const d = dev();
    if (!d) { setStatus('status.noDevice', 'warn'); return null; }
    if (online && d.state !== 'device') { setStatus('status.deviceOffline', 'warn', { state: d.state }); return null; }
    return d;
  }

  async function copy(text, what) {
    try {
      const r = await hecaton.clipboard.write({ text: String(text) });
      if (r && r.ok === false) fail('status.copyFailed', r.error);
      else setStatus('status.copied', 'success', { what: what || String(text).slice(0, 40) }, 3000);
    } catch (e) { fail('status.copyFailed', e.message); }
  }

  async function menu(items) {
    try { await hecaton.menu.show({ items }); } catch { /* 메뉴 미지원 호스트 */ }
  }

  // ---------- adb 탐색 ----------

  async function probeAdb() {
    s.adbProbing = true; s.adbError = null; s.adbDenied = false;
    rerender();
    const r = await adb.probe(config.get().adbPath);
    s.adbProbing = false;
    if (r.ok) {
      s.adbReady = true;
      if (r.path !== config.get().adbPath && r.path !== 'adb') config.update({ adbPath: r.path });
      setStatusText('adb ' + (r.version.version || r.version.bridge) + ' · ' + r.path, 'success', 4000);
      await refreshDevices(true);
    } else {
      s.adbReady = false;
      s.adbError = r.error;
      s.adbDenied = !!r.denied;
      s.adbTried = r.tried || [];
      rerender();
    }
  }

  async function locateAdb() {
    let r = null;
    try { r = await hecaton.picker.file({ filters: [{ name: 'adb', spec: 'exe,*' }, { name: 'All Files', spec: '*' }] }); } catch { /* ignore */ }
    if (!r || !r.path) return;
    config.update({ adbPath: r.path });
    await probeAdb();
  }

  // ---------- 단말 목록 ----------

  let refreshing = false;
  async function refreshDevices(quiet) {
    if (!s.adbReady || refreshing) return;
    refreshing = true;
    s.devicesLoading = !quiet;
    if (!quiet) rerender();
    const before = new Set(s.devices.map((d) => d.serial + ':' + d.state));
    const r = await adb.listDevices();
    refreshing = false;
    s.devicesLoading = false;
    s.devicesAt = Date.now();
    if (!r.ok) {
      s.devicesError = r.error;
      s.serverRunning = /cannot connect to daemon|failed to start daemon|could not install/i.test(r.error || '') ? false : s.serverRunning;
      s.devicesEverLoaded = true;
      rerender();
      return;
    }
    s.devicesError = null;
    s.serverRunning = true;
    s.devicesEverLoaded = true;
    s.devices = r.devices;
    // 변화 알림 — 상태 전이 시에만 [F4]
    const after = new Set(s.devices.map((d) => d.serial + ':' + d.state));
    if (before.size || quiet !== 'initial') {
      for (const d of s.devices) if (!before.has(d.serial + ':' + d.state) && d.state === 'device') setStatus('status.deviceOnline', 'success', { name: S.deviceLabel(d) });
      for (const key of before) if (!after.has(key) && key.endsWith(':device')) setStatus('status.deviceGone', 'warn', { name: key.split(':')[0] });
    }
    ensureSelection();
    rerender();
  }

  function ensureSelection() {
    const current = s.devices.find((d) => d.serial === s.selectedSerial);
    if (current) return;
    const first = s.devices.find((d) => d.state === 'device') || s.devices[0];
    selectDevice(first ? first.serial : null, true);
  }

  function selectDevice(serial, silent) {
    if (serial === s.selectedSerial) return;
    s.selectedSerial = serial;
    // 단말이 바뀌면 단말별 탭 데이터는 낡은 것 — 지운다
    s.packages = { ...s.packages, serial: null, list: [], error: null, sel: 0, scroll: 0, at: 0 };
    s.files = { ...s.files, serial: null, entries: [], error: null, warning: null, sel: 0, scroll: 0, at: 0 };
    s.forwards = { ...s.forwards, serial: null, forward: [], reverse: [], error: null, sel: 0, scroll: 0, at: 0 };
    s.logcatAuto = true;
    if (logcat.session.running && logcat.session.serial !== serial) logcat.stop();
    if (!silent) { const d = dev(); if (d) setStatus('status.selected', 'info', { name: S.deviceLabel(d) }, 2500); }
    updateTitle();
    onTabShown();
    rerender();
  }

  function updateTitle() {
    const d = dev();
    const title = d ? 'ADB — ' + S.deviceLabel(d) : 'ADB';
    try { hecaton.window.set_title({ title }).catch(() => {}); } catch { /* ignore */ }
    try {
      const label = d ? 'ADB ' + (d.state === 'device' ? '●' : '○') : 'ADB';
      hecaton.window.set_minimized_label({ label, color: d && d.state !== 'device' ? '#E06C75' : '#3DDC84' }).catch(() => {});
    } catch { /* ignore */ }
  }

  // ---------- 탭 ----------

  function setTab(id) {
    if (!s.tabs.includes(id)) return;
    s.tab = id;
    config.update({ lastTab: id });
    onTabShown();
    rerender();
  }

  // 탭이 보이면 필요한 데이터를 (낡았을 때만) 불러온다
  function onTabShown() {
    const d = dev();
    if (!d) return;
    const stale = (at, ms) => Date.now() - at > ms;
    switch (s.tab) {
      case 'overview':
        if (!s.info[d.serial] || stale(s.info[d.serial].at || 0, 30000)) loadInfo(d.serial);
        break;
      case 'logcat':
        if (s.logcatAuto !== false && d.state === 'device' && !(logcat.session.running && logcat.session.serial === d.serial)) startLogcat();
        break;
      case 'packages':
        if (s.packages.serial !== d.serial || stale(s.packages.at, 120000)) loadPackages();
        break;
      case 'files':
        if (s.files.serial !== d.serial) loadFiles(config.get().filesPath || '/sdcard');
        break;
      case 'forwards':
        if (s.forwards.serial !== d.serial || stale(s.forwards.at, 15000)) loadForwards();
        break;
      default: break;
    }
  }

  // ---------- 로더 ----------

  async function loadInfo(serial) {
    const rec = s.info[serial] || (s.info[serial] = { data: null, loading: false, error: null, at: 0 });
    if (rec.loading) return;
    rec.loading = true; rec.error = null;
    rerender();
    const r = await adb.deviceInfo(serial);
    rec.loading = false; rec.at = Date.now();
    if (r.ok) rec.data = r.info; else rec.error = r.error;
    rerender();
  }

  async function loadPackages() {
    const d = dev(); if (!d) return;
    const pk = s.packages;
    if (pk.loading) return;
    pk.loading = true; pk.error = null; pk.serial = d.serial;
    rerender();
    const r = await adb.listPackages(d.serial, { thirdPartyOnly: !pk.showAll });
    if (pk.serial !== d.serial) return;
    pk.loading = false; pk.at = Date.now();
    if (r.ok) pk.list = r.packages; else pk.error = r.error;
    rerender();
  }

  async function loadFiles(path) {
    const d = dev(); if (!d) return;
    const fsS = s.files;
    const target = normalizeRemotePath(path);
    fsS.loading = true; fsS.error = null; fsS.warning = null; fsS.serial = d.serial;
    rerender();
    const r = await adb.ls(d.serial, target);
    if (fsS.serial !== d.serial) return;
    fsS.loading = false; fsS.at = Date.now();
    if (r.ok) {
      if (fsS.path !== target) { fsS.sel = 0; fsS.scroll = 0; }
      fsS.path = target; fsS.entries = r.entries; fsS.warning = r.warning;
      config.update({ filesPath: target });
    } else fsS.error = r.error;
    rerender();
  }

  function normalizeRemotePath(p) {
    let out = String(p || '/').trim().replace(/\/+/g, '/');
    if (!out.startsWith('/')) out = '/' + out;
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  }

  function joinRemote(dir, name) { return dir === '/' ? '/' + name : dir + '/' + name; }

  async function loadForwards() {
    const fw = s.forwards;
    const d = dev();
    if (fw.loading) return;
    fw.loading = true; fw.error = null; fw.serial = d ? d.serial : null;
    rerender();
    const [f, r] = await Promise.all([adb.listForwards(d ? d.serial : null), d ? adb.listReverses(d.serial) : Promise.resolve({ ok: true, items: [] })]);
    fw.loading = false; fw.at = Date.now();
    fw.forward = f.ok ? f.items : [];
    fw.reverse = r.ok ? r.items : [];
    fw.error = !f.ok ? f.error : (!r.ok && !/more than one device|no devices/i.test(r.error || '') ? r.error : null);
    rerender();
  }

  async function mdnsScan(quiet) {
    if (!s.adbReady) return;
    const r = await adb.mdnsServices();
    s.mdnsAt = Date.now();
    if (r.ok) {
      s.mdns = r.services;
      if (!quiet) setStatus('status.mdnsFound', r.services.length ? 'success' : 'info', { count: r.services.length });
    } else if (!quiet) fail('status.mdnsFailed', r.error);
    rerender();
  }

  // ---------- 서버 / 연결 ----------

  async function serverRestart() {
    await op('busy.restartServer', null, async () => {
      const k = await adb.killServer();
      const st = await adb.startServer();
      if (!st.ok) { fail('status.serverStartFailed', st.error); return; }
      s.serverRunning = true;
      setStatus('status.serverRestarted', 'success');
      await refreshDevices(true);
    });
  }

  async function serverKill() {
    dialogs.confirmDanger('killsrv', t('dlg.killServer.title'), t('dlg.killServer.body'), t('dlg.killServer.confirm'), async () => {
      await op('busy.killServer', null, async () => {
        const r = await adb.killServer();
        if (!r.ok && !/server not running/i.test(r.error || '')) { fail('status.serverKillFailed', r.error); return; }
        s.serverRunning = false;
        s.devices = [];
        logcat.stop();
        setStatus('status.serverKilled', 'success');
      });
    });
  }

  async function serverStart() {
    await op('busy.startServer', null, async () => {
      const r = await adb.startServer();
      if (!r.ok) { fail('status.serverStartFailed', r.error); return; }
      s.serverRunning = true;
      setStatus('status.serverStarted', 'success');
      await refreshDevices(true);
    });
  }

  function connectDialog(prefill) {
    const recent = config.get().recentHosts;
    const def = prefill || recent[0] || '192.168.0.';
    dialogs.input('connect', t('dlg.connect.title'), t('dlg.connect.body') + (recent.length ? '\n' + t('dlg.connect.recent', { hosts: recent.slice(0, 3).join(', ') }) : ''), def, (value) => {
      const host = adb.normalizeHost(value, 5555);
      if (!host) return;
      connectTo(host);
    });
  }

  async function connectTo(host) {
    await op('busy.connect', { host }, async () => {
      const r = await adb.connect(host);
      if (r.ok) {
        config.rememberHost(host);
        setStatus('status.connected', 'success', { host });
        await refreshDevices(true);
        const found = s.devices.find((d) => d.serial === host || d.serial.startsWith(host.split(':')[0]));
        if (found) selectDevice(found.serial, true);
      } else fail('status.connectFailed', r.error || r.text, { host });
    });
  }

  function pairDialog(prefillHost) {
    dialogs.input('pairhost', t('dlg.pair.title'), t('dlg.pair.hostBody'), prefillHost || '', (host) => {
      host = host.trim();
      if (!host) return;
      dialogs.input('paircode', t('dlg.pair.title'), t('dlg.pair.codeBody', { host }), '', async (code) => {
        code = code.trim();
        if (!code) return;
        await op('busy.pair', { host }, async () => {
          const r = await adb.pair(host, code);
          if (!r.ok) { fail('status.pairFailed', r.error || r.text, { host }); return; }
          setStatus('status.paired', 'success', { host });
          await mdnsScan(true);
          // 페어링 포트와 연결 포트가 다르다 — 연결 주소를 이어서 묻는다
          const ip = host.split(':')[0];
          const svc = s.mdns.find((m) => m.kind === 'connect' && m.address.startsWith(ip + ':'));
          setTimeout(() => connectDialog(svc ? svc.address : ip + ':'), 200);
        });
      });
    });
  }

  async function disconnectDevice(serial) {
    const d = s.devices.find((x) => x.serial === serial) || dev();
    if (!d) return;
    if (!adb.isNetworkDevice(d)) { setStatus('status.notNetwork', 'warn'); return; }
    await op('busy.disconnect', { host: d.serial }, async () => {
      const r = await adb.disconnect(d.serial);
      if (r.ok) setStatus('status.disconnected', 'success', { host: d.serial }); else fail('status.disconnectFailed', r.error);
      await refreshDevices(true);
    });
  }

  async function wifiEnable() {
    const d = requireDevice(); if (!d) return;
    const info = (s.info[d.serial] || {}).data || {};
    await op('busy.wifi', null, async () => {
      const r = await adb.enableWifi(d.serial, 5555, info.ip);
      if (r.ok) {
        config.rememberHost(r.host);
        setStatus('status.wifiEnabled', 'success', { host: r.host });
        await refreshDevices(true);
      } else if (r.step === 'ip') setStatus('status.wifiNoIp', 'error', null, 10000);
      else fail('status.wifiFailed', r.error, { step: r.step });
    });
  }

  function tcpipDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('tcpip', t('dlg.tcpip.title'), t('dlg.tcpip.body'), '5555', async (value) => {
      const port = parseInt(value, 10);
      if (!port) return;
      await op('busy.tcpip', { port }, async () => {
        const r = await adb.tcpip(d.serial, port);
        if (r.ok) setStatus('status.tcpipOk', 'success', { port }); else fail('status.tcpipFailed', r.error);
      });
    }, { serial: d.serial });
  }

  async function usbMode() {
    const d = requireDevice(); if (!d) return;
    await op('busy.usb', null, async () => {
      const r = await adb.usbMode(d.serial);
      if (r.ok) setStatus('status.usbOk', 'success'); else fail('status.usbFailed', r.error);
      await refreshDevices(true);
    });
  }

  // ---------- 단말 액션 ----------

  function rebootMenu() {
    const d = requireDevice(false); if (!d) return;
    menu(REBOOT_MODES.map((m) => ({ id: 'reboot:' + m, label: t('reboot.' + m), icon: m === 'poweroff' ? 'debug-stop' : 'debug-restart', color: m === 'poweroff' ? '#E06C75' : undefined })));
  }

  function rebootConfirm(mode) {
    const d = requireDevice(false); if (!d) return;
    dialogs.confirmDanger('reboot', t('dlg.reboot.title'), t('dlg.reboot.body', { name: S.deviceLabel(d), mode: t('reboot.' + mode) }), t('dlg.reboot.confirm'), async (snap) => {
      await op('busy.reboot', { mode: t('reboot.' + mode) }, async () => {
        const r = mode === 'poweroff' ? await adb.shell(snap.serial, 'reboot -p') : await adb.reboot(snap.serial, mode);
        if (r.ok || /closed|offline/i.test(r.error || '')) setStatus('status.rebooting', 'success', { name: snap.name }); else fail('status.rebootFailed', r.error);
        setTimeout(() => refreshDevices(true), 1500);
      });
    }, { serial: d.serial, name: S.deviceLabel(d) });
  }

  async function screenshot() {
    const d = requireDevice(); if (!d) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let r = null;
    try { r = await hecaton.picker.save({ default_name: 'screenshot-' + safeName(d) + '-' + stamp + '.png', filters: [{ name: 'PNG', spec: 'png' }] }); } catch { /* ignore */ }
    if (!r || !r.path) return;
    await op('busy.screenshot', null, async () => {
      const res = await adb.screenshot(d.serial, r.path);
      if (res.ok) setStatusText(t('status.screenshotSaved', { path: r.path }), 'success', 10000); else fail('status.screenshotFailed', res.error);
    });
  }

  function safeName(d) { return String(d.model || d.serial).replace(/[^\w.-]+/g, '_'); }

  async function installApk(path) {
    const d = requireDevice(); if (!d) return;
    if (!path) {
      let r = null;
      try { r = await hecaton.picker.file({ filters: [{ name: 'APK', spec: 'apk,apks,aab' }, { name: 'All Files', spec: '*' }] }); } catch { /* ignore */ }
      if (!r || !r.path) return;
      path = r.path;
    }
    const name = path.replace(/\\/g, '/').split('/').pop();
    await op('busy.install', { name }, async () => {
      const res = await adb.install(d.serial, path, { reinstall: true });
      if (res.ok && /Success/i.test(res.stdout + res.stderr)) {
        setStatus('status.installed', 'success', { name });
        if (s.tab === 'packages') loadPackages();
      } else fail('status.installFailed', res.error || (res.stdout + res.stderr).trim().split('\n').pop(), { name });
    });
  }

  function pushDialog(remoteDir) {
    const d = requireDevice(); if (!d) return;
    (async () => {
      let r = null;
      try { r = await hecaton.picker.file({}); } catch { /* ignore */ }
      if (!r || !r.path) return;
      const local = r.path;
      const base = local.replace(/\\/g, '/').split('/').pop();
      const def = remoteDir || s.files.path || '/sdcard/Download';
      dialogs.input('push', t('dlg.push.title'), t('dlg.push.body', { name: base }), def, async (remote) => {
        remote = remote.trim() || def;
        await op('busy.push', { name: base }, async () => {
          const res = await adb.push(d.serial, local, remote);
          if (res.ok) { setStatus('status.pushed', 'success', { name: base, remote }); if (s.tab === 'files') loadFiles(s.files.path); }
          else fail('status.pushFailed', res.error, { name: base });
        });
      });
    })();
  }

  function pullDialog(remotePath, isDir) {
    const d = requireDevice(); if (!d) return;
    const doPull = async (remote) => {
      const base = remote.split('/').filter(Boolean).pop() || 'pulled';
      let r = null;
      try {
        r = isDir ? await hecaton.picker.folder({}) : await hecaton.picker.save({ default_name: base, filters: [{ name: 'All Files', spec: '*' }] });
      } catch { /* ignore */ }
      if (!r || !r.path) return;
      await op('busy.pull', { name: base }, async () => {
        const res = await adb.pull(d.serial, remote, r.path);
        if (res.ok) setStatusText(t('status.pulled', { name: base, path: r.path }), 'success', 10000); else fail('status.pullFailed', res.error, { name: base });
      });
    };
    if (remotePath) doPull(remotePath);
    else dialogs.input('pull', t('dlg.pull.title'), t('dlg.pull.body'), s.files.path ? s.files.path + '/' : '/sdcard/', (v) => { if (v.trim()) doPull(v.trim()); });
  }

  async function openShellTab() {
    const d = requireDevice(false); if (!d) return;
    try {
      const r = await hecaton.tabs.open_terminal({ name: 'adb ' + S.deviceLabel(d), icon: 'device-mobile' });
      if (!r || r.ok === false || !r.terminal_id) { fail('status.openTabFailed', r && (r.error || r.error_code)); return; }
      const cmd = quoteForShell(adb.getPath()) + ' -s ' + d.serial + ' shell';
      const sent = await hecaton.terminal.send_command({ terminal_id: r.terminal_id, command: cmd }).catch((e) => ({ ok: false, error: e.message }));
      if (sent && sent.ok === false) setStatusText(t('status.openTabNoInput', { cmd }), 'warn', 12000);
      else setStatus('status.openedTab', 'success');
    } catch (e) { fail('status.openTabFailed', e.message); }
  }

  function quoteForShell(p) { return /\s/.test(p) ? '"' + p + '"' : p; }

  function inputTextDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('inputtext', t('dlg.inputText.title'), t('dlg.inputText.body'), '', async (text) => {
      if (!text) return;
      const r = await adb.inputText(d.serial, text);
      if (r.ok) setStatus('status.textSent', 'success'); else fail('status.textFailed', r.error);
    });
  }

  function keyeventMenu() {
    const d = requireDevice(); if (!d) return;
    const items = KEYEVENTS.map(([name, code]) => ({ id: 'keyevent:' + code, label: name + '  ' + code }));
    items.push({ type: 'separator' }, { id: 'keyevent-custom', label: t('menu.keyeventCustom') });
    menu(items);
  }

  async function sendKey(code) {
    const d = requireDevice(); if (!d) return;
    const r = await adb.keyevent(d.serial, code);
    if (r.ok) setStatus('status.keySent', 'success', { key: code }, 2500); else fail('status.keyFailed', r.error);
  }

  // ---------- Logcat ----------

  async function startLogcat() {
    const d = requireDevice(); if (!d) return;
    s.logcatAuto = true;
    s.logcat.follow = true; s.logcat.sel = -1; s.logcat.newSince = 0;
    const ok = await logcat.start(d.serial, { buffers: s.logcatBuffers || [] });
    if (!ok) fail('status.logcatFailed', logcat.session.error);
    rerender();
  }

  async function stopLogcat() {
    s.logcatAuto = false;
    await logcat.stop();
    rerender();
  }

  async function clearLogcat() {
    const d = requireDevice(); if (!d) return;
    const wasRunning = logcat.session.running;
    await logcat.stop();
    const r = await adb.logcatClear(d.serial);
    logcat.resetBuffer();
    if (!r.ok) fail('status.logcatClearFailed', r.error);
    if (wasRunning) await startLogcat(); else rerender();
  }

  function levelMenu() {
    menu(LEVELS.map((l) => ({ id: 'lc-level:' + l, label: l + '  ' + t('level.' + l), checked: logcat.session.filter.minLevel === l })));
  }

  function setLevel(l) {
    if (!LEVELS.includes(l)) return;
    logcat.setFilter({ minLevel: l });
    config.update({ minLevel: l });
    rerender();
  }

  function cycleLevel() {
    const idx = LEVELS.indexOf(logcat.session.filter.minLevel);
    setLevel(LEVELS[(idx + 1) % LEVELS.length]);
  }

  function buffersMenu() {
    const cur = new Set(s.logcatBuffers || []);
    const items = LOGCAT_BUFFERS.map((b) => ({ id: 'lc-buffer:' + b, label: b, checked: cur.has(b) }));
    items.push({ type: 'separator' }, { id: 'lc-buffer:default', label: t('lc.bufferDefault'), checked: cur.size === 0 });
    menu(items);
  }

  async function toggleBuffer(b) {
    let list = (s.logcatBuffers || []).slice();
    if (b === 'default') list = [];
    else if (list.includes(b)) list = list.filter((x) => x !== b);
    else list.push(b);
    s.logcatBuffers = list;
    config.update({ logcatBuffers: list });
    if (logcat.session.running) await startLogcat(); else rerender();
  }

  function textFilterDialog() {
    dialogs.input('lctext', t('dlg.lcText.title'), t('dlg.lcText.body'), logcat.session.filter.text, (v) => { logcat.setFilter({ text: v.trim() }); unfollowReset(); });
  }
  function tagFilterDialog() {
    dialogs.input('lctag', t('dlg.lcTag.title'), t('dlg.lcTag.body'), logcat.session.filter.tag, (v) => { logcat.setFilter({ tag: v.trim() }); unfollowReset(); });
  }
  function pidFilterDialog() {
    const d = requireDevice(); if (!d) return;
    const f = logcat.session.filter;
    dialogs.input('lcpid', t('dlg.lcPid.title'), t('dlg.lcPid.body'), f.pkgName || (f.pid ? String(f.pid) : ''), async (v) => {
      v = v.trim();
      if (!v) { logcat.setFilter({ pid: null, pkgName: '' }); unfollowReset(); return; }
      if (/^\d+$/.test(v)) { logcat.setFilter({ pid: Number(v), pkgName: '' }); unfollowReset(); return; }
      const pid = await adb.pidof(d.serial, v);
      if (!pid) { setStatus('status.pidNotFound', 'warn', { name: v }); return; }
      logcat.setFilter({ pid, pkgName: v });
      unfollowReset();
    });
  }
  function unfollowReset() { s.logcat.follow = true; s.logcat.sel = -1; rerender(); }

  function excludesMenu() {
    const tags = Array.from(logcat.session.filter.excludeTags);
    if (!tags.length) return;
    menu(tags.map((tag) => ({ id: 'lc-unexclude:' + tag, label: t('menu.unexclude', { tag }), checked: true })));
  }

  async function saveLogcat() {
    const d = dev();
    const sess = logcat.session;
    if (!sess.lines.length) { setStatus('status.logcatEmpty', 'warn'); return; }
    const doSave = async (entries) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      let r = null;
      try { r = await hecaton.picker.save({ default_name: 'logcat-' + (d ? safeName(d) : 'device') + '-' + stamp + '.txt', filters: [{ name: 'Text', spec: 'txt,log' }] }); } catch { /* ignore */ }
      if (!r || !r.path) return;
      try {
        const res = await hecaton.fs.write_file({ path: r.path, content: logcat.toText(entries) });
        if (res && res.ok === false) fail('status.saveFailed', res.error); else setStatusText(t('status.logSaved', { count: entries.length, path: r.path }), 'success', 10000);
      } catch (e) { fail('status.saveFailed', e.message); }
    };
    if (logcat.hasFilter()) {
      dialogs.select('lcsave', t('dlg.lcSave.title'), t('dlg.lcSave.body'), [t('dlg.lcSave.filtered', { count: logcat.visible().length }), t('dlg.lcSave.all', { count: sess.lines.length })], (idx) => doSave(idx === 0 ? logcat.visible() : sess.lines));
    } else doSave(sess.lines);
  }

  function logLine(idx) { return logcat.visible()[idx] || null; }

  function selectLogLine(idx) {
    s.logcat.sel = idx;
    s.logcat.follow = false;
    rerender();
  }

  // ---------- 패키지 ----------

  function packageAt(idx) { return S.filteredPackages(s)[idx] || null; }

  function packageMenu(name) {
    if (!name) return;
    menu([
      { id: 'pk-launch:' + name, label: t('menu.launch', { name }), icon: 'play' },
      { id: 'pk-stop:' + name, label: t('menu.forceStop'), icon: 'debug-stop' },
      { id: 'pk-logcat:' + name, label: t('menu.logcatFor'), icon: 'output' },
      { id: 'pk-info:' + name, label: t('menu.appInfo'), icon: 'info' },
      { type: 'separator' },
      { id: 'pk-pull-apk:' + name, label: t('menu.pullApk'), icon: 'cloud-download' },
      { id: 'pk-copy:' + name, label: t('menu.copyName'), icon: 'clippy' },
      { type: 'separator' },
      { id: 'pk-clear:' + name, label: t('menu.clearData'), icon: 'clear-all', color: '#E5C07B' },
      { id: 'pk-uninstall:' + name, label: t('menu.uninstall'), icon: 'trash', color: '#E06C75' },
    ]);
  }

  async function pkLaunch(name) {
    const d = requireDevice(); if (!d) return;
    const r = await adb.launchPackage(d.serial, name);
    if (r.ok && !/No activities found|monkey aborted/i.test(r.stdout + r.stderr)) setStatus('status.launched', 'success', { name }); else fail('status.launchFailed', r.error || (r.stdout + r.stderr).trim().split('\n').pop(), { name });
  }
  async function pkStop(name) {
    const d = requireDevice(); if (!d) return;
    const r = await adb.forceStop(d.serial, name);
    if (r.ok) setStatus('status.stopped', 'success', { name }); else fail('status.stopFailed', r.error, { name });
  }
  function pkClear(name) {
    const d = requireDevice(); if (!d) return;
    dialogs.confirmDanger('pkclear', t('dlg.clearData.title'), t('dlg.clearData.body', { name }), t('dlg.clearData.confirm'), async () => {
      await op('busy.clearData', { name }, async () => {
        const r = await adb.clearData(d.serial, name);
        if (r.ok && /Success/i.test(r.stdout)) setStatus('status.cleared', 'success', { name }); else fail('status.clearFailed', r.error || r.stdout.trim(), { name });
      });
    });
  }
  function pkUninstall(name) {
    const d = requireDevice(); if (!d) return;
    dialogs.confirmDanger('pkuninst', t('dlg.uninstall.title'), t('dlg.uninstall.body', { name }), t('dlg.uninstall.confirm'), async () => {
      await op('busy.uninstall', { name }, async () => {
        const r = await adb.uninstall(d.serial, name);
        if (r.ok && /Success/i.test(r.stdout + r.stderr)) { setStatus('status.uninstalled', 'success', { name }); loadPackages(); }
        else fail('status.uninstallFailed', r.error || (r.stdout + r.stderr).trim().split('\n').pop(), { name });
      });
    });
  }
  async function pkInfo(name) {
    const d = requireDevice(); if (!d) return;
    const r = await adb.packageInfo(d.serial, name);
    if (!r.ok) { fail('status.infoFailed', r.error); return; }
    const text = r.text.replace(/^\s+/gm, '').replace(/@@path\n?/, '\n') || t('status.noInfo');
    dialogs.message('pkinfo', name, text.slice(0, 1800));
  }
  async function pkLogcat(name) {
    const d = requireDevice(); if (!d) return;
    const pid = await adb.pidof(d.serial, name);
    if (!pid) { setStatus('status.pidNotFound', 'warn', { name }); return; }
    logcat.setFilter({ pid, pkgName: name });
    setTab('logcat');
    unfollowReset();
  }
  async function pkPullApk(name) {
    const d = requireDevice(); if (!d) return;
    const p = await adb.pmPath(d.serial, name);
    if (!p.ok) { fail('status.pullFailed', p.error, { name }); return; }
    let r = null;
    try { r = await hecaton.picker.save({ default_name: name + '.apk', filters: [{ name: 'APK', spec: 'apk' }] }); } catch { /* ignore */ }
    if (!r || !r.path) return;
    await op('busy.pull', { name }, async () => {
      const res = await adb.pull(d.serial, p.paths[0], r.path);
      if (res.ok) setStatusText(t('status.pulled', { name, path: r.path }), 'success', 10000); else fail('status.pullFailed', res.error, { name });
    });
  }
  function pkSearchDialog() {
    dialogs.input('pksearch', t('dlg.pkSearch.title'), t('dlg.pkSearch.body'), s.packages.query, (v) => { s.packages.query = v.trim(); s.packages.sel = 0; s.packages.scroll = 0; rerender(); });
  }
  function pkScope(showAll) {
    if (s.packages.showAll === showAll) return;
    s.packages.showAll = showAll;
    config.update({ showAllPackages: showAll });
    s.packages.at = 0;
    loadPackages();
  }

  // ---------- 파일 ----------

  function fileAt(idx) { return s.files.entries[idx] || null; }

  function fsOpen(idx) {
    const e = fileAt(idx); if (!e) return;
    if (e.type === 'dir') loadFiles(joinRemote(s.files.path, e.name));
    else if (e.type === 'link') loadFiles(e.target && e.target.startsWith('/') ? e.target : joinRemote(s.files.path, e.name));
    else fileMenu(idx);
  }

  function fsUp() {
    const parts = s.files.path.split('/').filter(Boolean);
    parts.pop();
    loadFiles('/' + parts.join('/'));
  }

  function fileMenu(idx) {
    const e = fileAt(idx); if (!e) return;
    const full = joinRemote(s.files.path, e.name);
    const items = [];
    if (e.type !== 'file') items.push({ id: 'fs-open:' + idx, label: t('menu.open', { name: e.name }), icon: 'folder-opened' });
    items.push({ id: 'fs-pull:' + idx, label: t('menu.pull', { name: e.name }), icon: 'cloud-download' });
    items.push({ id: 'fs-copy-path:' + idx, label: t('menu.copyPath'), icon: 'clippy' });
    items.push({ type: 'separator' });
    items.push({ id: 'fs-push', label: t('btn.pushHere'), icon: 'cloud-upload' });
    items.push({ id: 'fs-mkdir', label: t('btn.mkdir'), icon: 'new-folder' });
    items.push({ type: 'separator' });
    items.push({ id: 'fs-delete:' + idx, label: t('menu.delete', { name: e.name }), icon: 'trash', color: '#E06C75' });
    menu(items);
    void full;
  }

  function fsDelete(idx) {
    const d = requireDevice(); if (!d) return;
    const e = fileAt(idx); if (!e) return;
    const full = joinRemote(s.files.path, e.name);
    dialogs.confirmDanger('fsdel', t('dlg.delete.title'), t('dlg.delete.body', { path: full }), t('dlg.delete.confirm'), async () => {
      await op('busy.delete', { name: e.name }, async () => {
        const r = await adb.rm(d.serial, full, e.type === 'dir');
        if (r.ok) { setStatus('status.deleted', 'success', { name: e.name }); loadFiles(s.files.path); } else fail('status.deleteFailed', r.error, { name: e.name });
      });
    });
  }

  function fsMkdirDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('mkdir', t('dlg.mkdir.title'), t('dlg.mkdir.body', { path: s.files.path }), '', async (name) => {
      name = name.trim(); if (!name) return;
      const r = await adb.mkdir(d.serial, joinRemote(s.files.path, name));
      if (r.ok) { setStatus('status.mkdirOk', 'success', { name }); loadFiles(s.files.path); } else fail('status.mkdirFailed', r.error, { name });
    });
  }

  function fsGotoDialog() {
    dialogs.input('fsgoto', t('dlg.goto.title'), t('dlg.goto.body'), s.files.path, (v) => { if (v.trim()) loadFiles(v.trim()); });
  }

  // ---------- 셸 ----------

  async function runShell(cmd) {
    const d = requireDevice(); if (!d) return;
    cmd = String(cmd || '').trim();
    if (!cmd) return;
    const entry = { cmd, output: '', code: null, at: Date.now(), running: true };
    s.shell.entries.push(entry);
    if (s.shell.entries.length > 200) s.shell.entries.shift();
    s.shell.lastCmd = cmd;
    s.shell.running = true;
    s.shell.follow = true;
    rerender();
    const r = await adb.shell(d.serial, cmd, { timeout: 60000 });
    entry.running = false;
    entry.code = r.code;
    let out = (r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
    if (!r.ok && !out) out = r.error || '';
    const lines = out.replace(/\n+$/, '').split('\n');
    if (lines.length > 2000) { entry.output = lines.slice(0, 2000).join('\n') + '\n' + t('sh.truncated', { count: lines.length - 2000 }); }
    else entry.output = lines.join('\n');
    s.shell.running = s.shell.entries.some((e) => e.running);
    rerender();
  }

  function shellDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('shell', t('dlg.shell.title'), t('dlg.shell.body', { name: S.deviceLabel(d) }), s.shell.lastCmd, (v) => runShell(v), null, t('btn.run'));
  }

  function quickMenu() {
    menu(QUICK_COMMANDS.map((c, i) => ({ id: 'sh-quick:' + i, label: c })));
  }

  // ---------- 포워딩 ----------

  function parseRule(value, defaultPrefix) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const norm = (p) => (/^\d+$/.test(p) ? defaultPrefix + p : p);
    const a = norm(parts[0]);
    const b = parts[1] ? norm(parts[1]) : a;
    return [a, b];
  }

  function forwardDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('fwadd', t('dlg.forward.title'), t('dlg.forward.body'), 'tcp:8080 tcp:8080', async (v) => {
      const rule = parseRule(v, 'tcp:'); if (!rule) return;
      const r = await adb.addForward(d.serial, rule[0], rule[1]);
      if (r.ok) { setStatus('status.forwardAdded', 'success', { rule: rule[0] + ' → ' + rule[1] }); loadForwards(); } else fail('status.forwardFailed', r.error);
    });
  }

  function reverseDialog() {
    const d = requireDevice(); if (!d) return;
    dialogs.input('rvadd', t('dlg.reverse.title'), t('dlg.reverse.body'), 'tcp:8081 tcp:8081', async (v) => {
      const rule = parseRule(v, 'tcp:'); if (!rule) return;
      const r = await adb.addReverse(d.serial, rule[0], rule[1]);
      if (r.ok) { setStatus('status.reverseAdded', 'success', { rule: rule[0] + ' ← ' + rule[1] }); loadForwards(); } else fail('status.forwardFailed', r.error);
    });
  }

  async function removeForwardAt(idx) {
    const items = S.forwardItems(s);
    const it = items[idx]; if (!it) return;
    const d = dev();
    const r = it.kind === 'forward' ? await adb.removeForward(it.serial || (d && d.serial), it.local) : await adb.removeReverse(d && d.serial, it.local);
    if (r.ok) { setStatus('status.forwardRemoved', 'success', { rule: it.local }); loadForwards(); } else fail('status.forwardFailed', r.error);
  }

  function removeAllForwards() {
    const d = dev();
    dialogs.confirmDanger('fwall', t('dlg.removeAll.title'), t('dlg.removeAll.body'), t('dlg.removeAll.confirm'), async () => {
      await adb.removeAllForwards(d ? d.serial : null);
      if (d) await adb.removeAllReverses(d.serial);
      setStatus('status.forwardsCleared', 'success');
      loadForwards();
    });
  }

  // ---------- 단말 메뉴 / 도움말 ----------

  function deviceMenu() {
    const items = s.devices.map((d) => ({ id: 'device:' + d.serial, label: S.deviceLabel(d) + '  ' + d.serial + (d.state !== 'device' ? '  (' + d.state + ')' : ''), checked: d.serial === s.selectedSerial, icon: d.kind === 'usb' ? 'plug' : d.kind === 'emulator' ? 'vm' : 'radio-tower' }));
    if (items.length) items.push({ type: 'separator' });
    items.push({ id: 'connect', label: t('btn.connect'), icon: 'radio-tower' }, { id: 'pair', label: t('btn.pair'), icon: 'key' }, { id: 'mdns-scan', label: t('btn.scan'), icon: 'search' }, { id: 'refresh', label: t('btn.refresh'), icon: 'refresh', shortcut: 'r' });
    menu(items);
  }

  function help() {
    dialogs.message('help', t('help.title'), t('help.body'));
  }

  function cycleDevice(delta) {
    if (!s.devices.length) return;
    const idx = Math.max(0, s.devices.findIndex((d) => d.serial === s.selectedSerial));
    const next = (idx + delta + s.devices.length) % s.devices.length;
    selectDevice(s.devices[next].serial);
  }

  // ---------- 리스트 이동 (키보드) ----------

  function moveList(delta, absolute) {
    const list = S.currentList(s, logcat.visible());
    if (!list) return;
    const { store, items } = list;
    const rows = s.layout.listRows || 10;
    if (s.tab === 'logcat') {
      const cur = store.sel >= 0 ? store.sel : items.length - 1;
      let next = absolute === 'home' ? 0 : absolute === 'end' ? items.length - 1 : cur + delta;
      next = Math.max(0, Math.min(items.length - 1, next));
      store.sel = next;
      store.follow = next >= items.length - 1;
      if (next < store.scroll) store.scroll = next;
      if (next >= store.scroll + rows) store.scroll = next - rows + 1;
      rerender();
      return;
    }
    if (s.tab === 'shell') {
      const max = Math.max(0, items.length - rows);
      store.scroll = absolute === 'home' ? 0 : absolute === 'end' ? max : Math.max(0, Math.min(max, store.scroll + delta));
      store.follow = store.scroll >= max;
      rerender();
      return;
    }
    let next = absolute === 'home' ? 0 : absolute === 'end' ? items.length - 1 : store.sel + delta;
    next = Math.max(0, Math.min(Math.max(0, items.length - 1), next));
    store.sel = next;
    if (next < store.scroll) store.scroll = next;
    if (next >= store.scroll + rows) store.scroll = next - rows + 1;
    rerender();
  }

  // 휠 — 뷰포트만 움직인다 [P7]
  function scrollList(delta, inSidebar) {
    if (inSidebar) {
      s.sidebarScroll = Math.max(0, s.sidebarScroll + delta);
      rerender();
      return;
    }
    const list = S.currentList(s, logcat.visible());
    if (!list) return;
    const { store, items } = list;
    const rows = s.layout.listRows || 10;
    const max = Math.max(0, items.length - rows);
    const next = Math.max(0, Math.min(max, store.scroll + delta));
    if (next === store.scroll) return;
    store.scroll = next;
    if (s.tab === 'logcat' || s.tab === 'shell') {
      store.follow = next >= max;
      if (s.tab === 'logcat' && store.follow) store.newSince = 0;
    }
    rerender();
  }

  function enterCurrent() {
    const list = S.currentList(s, logcat.visible());
    switch (s.tab) {
      case 'packages': packageMenu(packageAt(s.packages.sel)); break;
      case 'files': fsOpen(s.files.sel); break;
      case 'forwards': if (list && list.items[s.forwards.sel]) forwardRowMenu(s.forwards.sel); break;
      case 'logcat': if (s.logcat.sel >= 0) logLineMenu(s.logcat.sel); break;
      case 'shell': shellDialog(); break;
      default: break;
    }
  }

  function forwardRowMenu(idx) {
    const it = S.forwardItems(s)[idx]; if (!it) return;
    menu([
      { id: 'fw-remove:' + idx, label: t('menu.removeForward', { rule: it.local + (it.kind === 'forward' ? ' → ' : ' ← ') + it.remote }), icon: 'trash', color: '#E06C75' },
      { id: 'fw-copy:' + idx, label: t('menu.copyRule'), icon: 'clippy' },
      { type: 'separator' },
      { id: 'fw-add', label: t('btn.addForward'), icon: 'add' },
      { id: 'rv-add', label: t('btn.addReverse'), icon: 'add' },
    ]);
  }

  function logLineMenu(idx) {
    const e = logLine(idx); if (!e) return;
    const items = [{ id: 'lc-copy-line:' + idx, label: t('menu.copyLine'), icon: 'clippy', shortcut: 'c' }];
    if (e.tag) {
      items.push({ id: 'lc-filter-tag:' + idx, label: t('menu.filterTag', { tag: e.tag }), icon: 'filter' });
      items.push({ id: 'lc-exclude-tag:' + idx, label: t('menu.excludeTag', { tag: e.tag }), icon: 'filter-filled' });
    }
    if (e.pid) items.push({ id: 'lc-filter-pid:' + idx, label: t('menu.filterPid', { pid: e.pid }), icon: 'filter' });
    items.push({ type: 'separator' });
    items.push({ id: 'lc-follow', label: t('lc.follow'), icon: 'arrow-down', shortcut: 'p' });
    if (logcat.hasFilter()) items.push({ id: 'lc-clear-filters', label: t('btn.clearFilters'), icon: 'clear-all' });
    menu(items);
  }

  // ---------- 디스패치 ----------

  async function runAction(action, data) {
    if (!action) return;
    const sep = action.indexOf(':');
    const head = sep >= 0 ? action.slice(0, sep) : action;
    const arg = sep >= 0 ? action.slice(sep + 1) : null;

    switch (head) {
      // 전역
      case 'refresh': await Promise.all([refreshDevices(false), s.tab === 'overview' && dev() ? loadInfo(dev().serial) : null]); onTabShownForce(); return;
      case 'probe-adb': return probeAdb();
      case 'locate-adb': return locateAdb();
      case 'connect': return connectDialog();
      case 'connect-mdns': return connectTo(arg);
      case 'pair': return pairDialog();
      case 'pair-mdns': return pairDialog(arg);
      case 'mdns-scan': return mdnsScan(false);
      case 'server-restart': return serverRestart();
      case 'server-kill': return serverKill();
      case 'server-start': return serverStart();
      case 'device': return selectDevice(arg);
      case 'device-menu': return deviceMenu();
      case 'device-disconnect': return disconnectDevice(arg);
      case 'device-copy': return copy(arg, arg);
      case 'next-device': return cycleDevice(1);
      case 'prev-device': return cycleDevice(-1);
      case 'tab': return setTab(arg);
      case 'next-tab': return setTab(s.tabs[(s.tabs.indexOf(s.tab) + 1) % s.tabs.length]);
      case 'prev-tab': return setTab(s.tabs[(s.tabs.indexOf(s.tab) - 1 + s.tabs.length) % s.tabs.length]);
      case 'toggle-sidebar': s.sidebarVisible = !s.sidebarVisible; config.update({ sidebarVisible: s.sidebarVisible }); require('./screen').invalidate(); rerender(); return;
      case 'help': return help();
      case 'quit': return ctx.quit();
      case 'restore': try { await hecaton.window.restore(); } catch { /* ignore */ } return;
      case 'list-up': return moveList(-1);
      case 'list-down': return moveList(1);
      case 'page-up': return moveList(-(s.layout.listRows || 10));
      case 'page-down': return moveList(s.layout.listRows || 10);
      case 'list-home': return moveList(0, 'home');
      case 'list-end': return moveList(0, 'end');
      case 'enter': return enterCurrent();
      // 개요
      case 'screenshot': return screenshot();
      case 'install': return installApk();
      case 'reboot-menu': return rebootMenu();
      case 'reboot': return rebootConfirm(arg);
      case 'wifi-enable': return wifiEnable();
      case 'tcpip': return tcpipDialog();
      case 'disconnect': return disconnectDevice(s.selectedSerial);
      case 'usb-mode': return usbMode();
      case 'push': return pushDialog();
      case 'pull': return pullDialog();
      case 'open-shell-tab': return openShellTab();
      case 'input-text': return inputTextDialog();
      case 'keyevent-menu': return keyeventMenu();
      case 'keyevent': return sendKey(arg);
      case 'keyevent-custom': return dialogs.input('keycustom', t('btn.keyevent'), t('dlg.keyevent.body'), '', (v) => { if (v.trim()) sendKey(v.trim()); });
      case 'copy-serial': return dev() ? copy(dev().serial, dev().serial) : null;
      case 'info-refresh': return dev() ? loadInfo(dev().serial) : null;
      // logcat
      case 'lc-start': return startLogcat();
      case 'lc-stop': return stopLogcat();
      case 'lc-follow': s.logcat.follow = !s.logcat.follow; if (s.logcat.follow) { s.logcat.sel = -1; s.logcat.newSince = 0; } rerender(); return;
      case 'lc-level': return arg ? setLevel(arg) : levelMenu();
      case 'lc-level-cycle': return cycleLevel();
      case 'lc-clear': return clearLogcat();
      case 'lc-save': return saveLogcat();
      case 'lc-buffers': return buffersMenu();
      case 'lc-buffer': return toggleBuffer(arg);
      case 'lc-text': return textFilterDialog();
      case 'lc-tag': return tagFilterDialog();
      case 'lc-pid': return pidFilterDialog();
      case 'lc-excludes': return excludesMenu();
      case 'lc-unexclude': logcat.toggleExcludeTag(arg); rerender(); return;
      case 'lc-clear-filters': logcat.clearFilters(); unfollowReset(); return;
      case 'lc-line': return selectLogLine(Number(arg));
      case 'lc-line-menu': return logLineMenu(Number(arg));
      case 'lc-copy-line': { const e = logLine(Number(arg)); if (e) copy(e.raw, t('menu.logLine')); return; }
      case 'lc-copy-selected': { const e = logLine(s.logcat.sel); if (e) copy(e.raw, t('menu.logLine')); return; }
      case 'lc-filter-tag': { const e = logLine(Number(arg)); if (e) { logcat.setFilter({ tag: e.tag }); unfollowReset(); } return; }
      case 'lc-exclude-tag': { const e = logLine(Number(arg)); if (e) { logcat.toggleExcludeTag(e.tag); unfollowReset(); } return; }
      case 'lc-filter-pid': { const e = logLine(Number(arg)); if (e) { logcat.setFilter({ pid: e.pid, pkgName: '' }); unfollowReset(); } return; }
      // 패키지
      case 'pk-scope': return pkScope(arg === '1');
      case 'pk-search': return pkSearchDialog();
      case 'pk-clear-search': s.packages.query = ''; s.packages.sel = 0; s.packages.scroll = 0; rerender(); return;
      case 'pk-refresh': s.packages.at = 0; return loadPackages();
      case 'pk-row': s.packages.sel = Number(arg); rerender(); return;
      case 'pk-menu': return packageMenu(arg || packageAt(s.packages.sel));
      case 'pk-launch': return pkLaunch(arg);
      case 'pk-stop': return pkStop(arg);
      case 'pk-clear': return pkClear(arg);
      case 'pk-uninstall': return pkUninstall(arg);
      case 'pk-info': return pkInfo(arg);
      case 'pk-logcat': return pkLogcat(arg);
      case 'pk-copy': return copy(arg, arg);
      case 'pk-pull-apk': return pkPullApk(arg);
      // 파일
      case 'fs-crumb': { const i = Number(arg); const parts = s.files.path.split('/').filter(Boolean); return loadFiles('/' + parts.slice(0, i + 1).join('/')); }
      case 'fs-up': return fsUp();
      case 'fs-goto': return fsGotoDialog();
      case 'fs-push': return pushDialog(s.files.path);
      case 'fs-mkdir': return fsMkdirDialog();
      case 'fs-refresh': return loadFiles(s.files.path);
      case 'fs-row': { const i = Number(arg); if (s.files.sel === i && data && data.doubleClick) return fsOpen(i); s.files.sel = i; rerender(); return; }
      case 'fs-enter': return fsOpen(s.files.sel);
      case 'fs-open': return fsOpen(Number(arg));
      case 'fs-menu': return fileMenu(arg != null ? Number(arg) : s.files.sel);
      case 'fs-pull': { const e = fileAt(Number(arg)); if (e) pullDialog(joinRemote(s.files.path, e.name), e.type === 'dir'); return; }
      case 'fs-delete': return fsDelete(Number(arg));
      case 'fs-copy-path': { const e = fileAt(Number(arg)); if (e) copy(joinRemote(s.files.path, e.name), e.name); return; }
      // 셸
      case 'sh-run': return shellDialog();
      case 'sh-quick': return arg != null ? runShell(QUICK_COMMANDS[Number(arg)]) : quickMenu();
      case 'sh-repeat': return s.shell.lastCmd ? runShell(s.shell.lastCmd) : shellDialog();
      case 'sh-clear': s.shell.entries = []; s.shell.scroll = 0; rerender(); return;
      case 'sh-cmd': { const l = S.shellLines(s)[Number(arg)]; if (l && l.kind === 'cmd') runShell(l.text); return; }
      case 'sh-copy': { const l = S.shellLines(s)[Number(arg)]; if (l) copy(l.text, t('menu.command')); return; }
      case 'sh-copy-output': { const e = s.shell.entries[s.shell.entries.length - 1]; if (e) copy(e.output, t('menu.output')); return; }
      // 포워딩
      case 'fw-add': return forwardDialog();
      case 'rv-add': return reverseDialog();
      case 'fw-refresh': return loadForwards();
      case 'fw-remove-all': return removeAllForwards();
      case 'fw-row': s.forwards.sel = Number(arg); rerender(); return;
      case 'fw-menu': return forwardRowMenu(arg != null ? Number(arg) : s.forwards.sel);
      case 'fw-remove': return removeForwardAt(arg != null ? Number(arg) : s.forwards.sel);
      case 'fw-copy': { const it = S.forwardItems(s)[Number(arg)]; if (it) copy(it.local + ' ' + it.remote, it.local); return; }
      default:
        return;
    }
  }

  function onTabShownForce() {
    if (s.tab === 'packages') s.packages.at = 0;
    if (s.tab === 'forwards') s.forwards.at = 0;
    if (s.tab === 'files') s.files.serial = null;
    onTabShown();
  }

  return {
    runAction, setStatus, setStatusText, probeAdb, refreshDevices, mdnsScan, loadInfo, onTabShown, selectDevice, updateTitle,
    scrollList, moveList, copy, packageMenu, fileMenu, logLineMenu, forwardRowMenu, deviceMenu,
    disconnectDevice, QUICK_COMMANDS, REBOOT_MODES, KEYEVENTS,
  };
}

module.exports = { create, REBOOT_MODES, KEYEVENTS, QUICK_COMMANDS, LOGCAT_BUFFERS };
