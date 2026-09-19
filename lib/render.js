'use strict';
// lib/render.js — 화면 합성. 그리는 자리에서 존을 등록하고 [P3], 파생 레이아웃을 state.layout 에 기록한다 [L1].

const { ansi, theme, levelColor } = require('./ansi');
const { stringWidth, padEnd, padStart, truncate, fit, sanitize, formatBytes } = require('./text');
const zones = require('./zones');
const screen = require('./screen');
const w = require('./widgets');
const { t } = require('./i18n');
const S = require('./state');
const adb = require('./adb');
const { LEVELS } = require('./logcat');

const MIN_SIDEBAR = 22;
const MAX_SIDEBAR = 34;

function tabDefs() {
  return [
    { id: 'overview', label: t('tab.overview'), key: '1' },
    { id: 'logcat', label: t('tab.logcat'), key: '2' },
    { id: 'packages', label: t('tab.packages'), key: '3' },
    { id: 'files', label: t('tab.files'), key: '4' },
    { id: 'shell', label: t('tab.shell'), key: '5' },
    { id: 'forwards', label: t('tab.forwards'), key: '6' },
  ];
}

function stateTone(state) {
  if (state === 'device') return 'success';
  if (state === 'unauthorized' || state === 'offline' || state === 'no permissions') return 'error';
  return 'warn';
}

function stateLabel(state) {
  const key = 'devstate.' + String(state || '').replace(/\s+/g, '_');
  const text = t(key);
  return text === key ? state : text;
}

function kindMark(kind) {
  return kind === 'usb' ? 'U' : kind === 'emulator' ? 'E' : 'W';
}

function elapsed(since) {
  const s = Math.floor((Date.now() - since) / 1000);
  return s >= 3 ? ' ' + s + 's' : '';
}

function formatUptime(sec) {
  if (sec == null) return '';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}

// ============================================================
// 메인 렌더
// ============================================================

function render(ctx) {
  const s = ctx.state;
  if (s.minimized) return renderMinimized(ctx);
  const cols = s.cols, rows = s.rows;
  zones.beginFrame();
  const frame = screen.beginFrame(cols, rows);

  const showSidebar = s.sidebarVisible && cols >= 72;
  const sidebarW = showSidebar ? Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, Math.floor(cols * 0.27))) : 0;
  const contentCol = showSidebar ? sidebarW + 2 : 1;
  const contentW = cols - contentCol + 1;
  const bodyTop = 3, bodyBottom = rows - 2;
  Object.assign(s.layout, { sidebarW, contentCol, contentW, bodyTop, bodyBottom });

  // 행 버퍼: 사이드바와 본문을 따로 채우고 마지막에 합친다
  const side = new Array(rows + 1).fill('');
  const main = new Array(rows + 1).fill('');
  const putSide = (row, text) => { if (row >= bodyTop && row <= bodyBottom) side[row] = text; };
  const put = (row, text) => { if (row >= bodyTop && row <= bodyBottom) main[row] = text; };

  frame.row(1, renderTitle(ctx, cols));
  frame.row(2, theme.dim + (showSidebar ? '─'.repeat(sidebarW) + '┬' + '─'.repeat(Math.max(0, cols - sidebarW - 1)) : '─'.repeat(cols)) + ansi.reset);

  if (showSidebar) renderSidebar(ctx, putSide, sidebarW, bodyTop, bodyBottom);
  renderContent(ctx, put, contentCol, contentW, bodyTop, bodyBottom);

  for (let r = bodyTop; r <= bodyBottom; r++) {
    if (showSidebar) frame.row(r, fit(side[r], sidebarW) + theme.dim + '│' + ansi.reset + fit(main[r], contentW));
    else frame.row(r, fit(main[r], cols));
  }

  frame.row(rows - 1, renderStatus(ctx, cols));
  frame.row(rows, renderHints(ctx, cols));
  screen.commit(frame);
  zones.syncPointer();
}

// ---------- 제목 줄 ----------

function renderTitle(ctx, cols) {
  const s = ctx.state;
  let left = ' ' + theme.title + 'ADB' + ansi.reset;
  if (adb.state.version && adb.state.version.version) left += ' ' + theme.dim + adb.state.version.version + ansi.reset;
  if (s.adbProbing) left += ' ' + theme.dim + w.spinner() + ' ' + t('title.probing') + ansi.reset;
  else if (!s.adbReady) left += ' ' + w.badge(t('title.adbMissing'), 'error');
  else if (s.serverRunning === false) left += ' ' + w.badge(t('title.serverDown'), 'warn');
  else left += ' ' + w.badge(t('title.devices', { count: s.devices.length }), s.devices.length ? 'success' : 'dim');
  if (s.busy) left += ' ' + theme.warn + w.spinner() + ' ' + t(s.busy.key, s.busy.args) + elapsed(s.busy.since) + ansi.reset;

  // 사이드바가 숨겨지면 단말 선택 드롭다운을 제목 줄에 둔다
  let mid = '';
  const showSidebar = s.sidebarVisible && cols >= 72;
  if (!showSidebar && s.adbReady) {
    const dev = S.selectedDevice(s);
    const col = stringWidth(left) + 2;
    const dd = w.dropdown(1, col, t('title.device'), dev ? truncate(S.deviceLabel(dev), 18, '…') : t('title.noDevice'), 'device-menu', { tip: t('tip.deviceMenu') });
    mid = ' ' + dd.text;
  }

  // 우측 툴바 — 폭이 좁으면 뒤에서부터 떨어뜨린다 [W4]
  const buttons = [
    { label: t('btn.refresh'), action: 'refresh', tip: t('tip.refresh') },
    { label: t('btn.connect'), action: 'connect', tip: t('tip.connect') },
    { label: t('btn.pair'), action: 'pair', tip: t('tip.pair') },
    { label: t('btn.restartServer'), action: 'server-restart', tip: t('tip.restartServer'), tone: 'warn' },
    { label: t('btn.killServer'), action: 'server-kill', tip: t('tip.killServer'), tone: 'error' },
  ];
  if (!s.adbReady) buttons.splice(0, buttons.length, { label: t('btn.locateAdb'), action: 'locate-adb', tip: t('tip.locateAdb'), tone: 'accent' });
  const leftW = stringWidth(left) + stringWidth(mid);
  let avail = cols - leftW - 2;
  const widths = buttons.map((b) => stringWidth('[ ' + b.label + ' ]') + 1);
  let keep = buttons.length;
  while (keep > 0 && widths.slice(0, keep).reduce((a, b) => a + b, 0) > avail) keep--;
  let right = '';
  let col = cols - widths.slice(0, keep).reduce((a, b) => a + b, 0);
  for (let i = 0; i < keep; i++) {
    const b = buttons[i];
    const r = w.button(1, col, b.label, b.action, { tip: b.tip, tone: b.tone });
    right += r.text + ' ';
    col += r.width + 1;
  }
  const gap = Math.max(1, cols - leftW - stringWidth(right));
  return left + mid + ' '.repeat(gap) + right;
}

// ---------- 사이드바 ----------

function renderSidebar(ctx, put, width, top, bottom) {
  const s = ctx.state;
  let row = top;
  const inner = width - 1;
  const header = t('side.devices', { count: s.devices.length });
  put(row, ' ' + w.sectionHeader(header + (s.devicesLoading ? ' ' + w.spinner() : ''), inner - 1));
  row++;

  const lines = [];
  if (!s.adbReady && !s.adbProbing) {
    lines.push({ text: theme.error + ' ' + t('side.adbMissing') + ansi.reset });
  } else if (s.devices.length === 0) {
    lines.push({ text: theme.dim + ' ' + (s.devicesEverLoaded ? t('side.noDevices') : t('side.loading')) + ansi.reset });
    if (s.devicesEverLoaded) lines.push({ text: theme.dim + ' ' + t('side.noDevicesHint') + ansi.reset });
  }
  for (const d of s.devices) lines.push({ device: d });

  // 무선 디버깅 탐색 결과
  const connectables = s.mdns.filter((m) => m.kind === 'connect' && !s.devices.some((d) => d.serial.startsWith(m.name) || d.serial === m.address));
  const pairables = s.mdns.filter((m) => m.kind === 'pairing');
  if (connectables.length || pairables.length) {
    lines.push({ text: '' });
    lines.push({ text: ' ' + w.sectionHeader(t('side.wireless'), inner - 1) });
    for (const m of connectables) lines.push({ mdns: m });
    for (const m of pairables) lines.push({ mdns: m });
  }

  // 사이드바 스크롤 (단말이 많을 때)
  const footerRows = 3;
  const listRows = Math.max(1, bottom - row - footerRows + 1);
  s.layout.sideListTop = row;
  s.layout.sideListRows = listRows;
  const maxScroll = Math.max(0, lines.length - listRows);
  if (s.sidebarScroll > maxScroll) s.sidebarScroll = maxScroll;
  for (let i = s.sidebarScroll; i < lines.length && row <= bottom - footerRows; i++, row++) {
    const item = lines[i];
    if (item.device) {
      const d = item.device;
      const selected = d.serial === s.selectedSerial;
      const hot = zones.add(row, 1, width, 'device:' + d.serial, {
        label: t('menu.selectDevice', { name: S.deviceLabel(d) }),
        tip: d.serial + ' · ' + stateLabel(d.state),
        data: { serial: d.serial },
      });
      const mark = d.state === 'device' ? theme.success + '●' : theme.error + '○';
      const name = truncate(S.deviceLabel(d), inner - 8, '…');
      let text = ' ' + mark + ansi.reset + ' ' + (selected ? ansi.bold : '') + name + ansi.reset;
      const tag = ' ' + theme.dim + kindMark(d.kind) + ansi.reset;
      text += padStart(tag, inner - stringWidth(text));
      if (selected) text = theme.selBg + fit(text, inner) + ansi.reset;
      else if (hot) text = theme.hoverBg + fit(text, inner) + ansi.reset;
      if (d.state !== 'device') {
        text = (selected ? theme.selBg : hot ? theme.hoverBg : '') + ' ' + mark + ansi.reset + (selected ? theme.selBg : hot ? theme.hoverBg : '') + ' ' + truncate(S.deviceLabel(d), inner - 14, '…') + ' ' + w.badge(stateLabel(d.state), stateTone(d.state)) + ansi.reset;
        if (selected || hot) text = (selected ? theme.selBg : theme.hoverBg) + fit(text, inner) + ansi.reset;
      }
      put(row, text);
    } else if (item.mdns) {
      const m = item.mdns;
      const action = m.kind === 'pairing' ? 'pair-mdns:' + m.address : 'connect-mdns:' + m.address;
      const hot = zones.add(row, 1, width, action, {
        label: m.kind === 'pairing' ? t('menu.pairWith', { host: m.address }) : t('menu.connectTo', { host: m.address }),
        tip: m.name, data: { host: m.address },
      });
      const mark = m.kind === 'pairing' ? theme.warn + '◐' : theme.accent + '◍';
      let text = ' ' + mark + ansi.reset + ' ' + truncate(m.address, inner - 4, '…');
      if (hot) text = theme.hoverBg + fit(text, inner) + ansi.reset;
      put(row, text);
    } else {
      put(row, item.text);
    }
  }
  if (lines.length > listRows) {
    put(bottom - footerRows, theme.dim + ' ' + t('side.more', { count: lines.length - listRows - s.sidebarScroll }) + ansi.reset);
  }

  // 하단: 무선 연결 버튼, adb 경로
  let brow = bottom - footerRows + 1;
  let col = 2, line = '';
  for (const b of [
    { label: t('btn.connectShort'), action: 'connect', tip: t('tip.connect') },
    { label: t('btn.pairShort'), action: 'pair', tip: t('tip.pair') },
    { label: t('btn.scan'), action: 'mdns-scan', tip: t('tip.scan') },
  ]) {
    const r = w.button(brow, col, b.label, b.action, b);
    if (col + r.width > width) { put(brow, ' ' + line); brow++; col = 2; line = ''; if (brow > bottom) break; }
    line += r.text + ' ';
    col += r.width + 1;
  }
  if (line && brow <= bottom) put(brow, ' ' + line);
  const pathText = (adb.state.path === 'adb' && adb.state.version && adb.state.version.installed) || adb.state.path || 'adb';
  const hotPath = zones.add(bottom, 1, width, 'locate-adb', { label: t('btn.locateAdb'), tip: pathText });
  put(bottom, (hotPath ? theme.hoverBg : '') + theme.dim + ' ' + truncate(pathText, inner - 1, '…') + ansi.reset);
}

// ---------- 본문 ----------

function renderContent(ctx, put, col0, width, top, bottom) {
  const s = ctx.state;
  const tabs = tabDefs();
  const bar = w.tabBar(top, col0 + 1, tabs, s.tab, width - 2);
  let tabLine = ' ' + bar.text;
  // 탭 바 우측: 선택 단말 이름
  const dev = S.selectedDevice(s);
  if (dev) {
    const label = truncate(S.deviceLabel(dev), 24, '…');
    const badgeText = ' ' + (dev.state === 'device' ? theme.success : theme.error) + '●' + ansi.reset + ' ' + ansi.bold + label + ansi.reset + ' ';
    const bw = stringWidth(badgeText);
    if (bar.width + bw + 2 < width) tabLine += ' '.repeat(width - bar.width - bw - 1) + badgeText;
  }
  put(top, tabLine);
  put(top + 1, theme.dim + '─'.repeat(width) + ansi.reset);
  const bodyTop = top + 2;
  s.layout.listTop = bodyTop;

  if (!s.adbReady) return renderSetup(ctx, put, col0, width, bodyTop, bottom);
  if (!dev && s.tab !== 'forwards') return renderNoDevice(ctx, put, col0, width, bodyTop, bottom);

  switch (s.tab) {
    case 'overview': return renderOverview(ctx, put, col0, width, bodyTop, bottom, dev);
    case 'logcat': return renderLogcat(ctx, put, col0, width, bodyTop, bottom, dev);
    case 'packages': return renderPackages(ctx, put, col0, width, bodyTop, bottom, dev);
    case 'files': return renderFiles(ctx, put, col0, width, bodyTop, bottom, dev);
    case 'shell': return renderShell(ctx, put, col0, width, bodyTop, bottom, dev);
    case 'forwards': return renderForwards(ctx, put, col0, width, bodyTop, bottom, dev);
    default: return null;
  }
}

function renderSetup(ctx, put, col0, width, top, bottom) {
  const s = ctx.state;
  let row = top;
  if (s.adbProbing) { put(row, ' ' + w.spinner() + ' ' + t('setup.probing')); return; }
  put(row++, ' ' + ansi.bold + theme.error + t('setup.title') + ansi.reset);
  row++;
  if (s.adbDenied) {
    put(row++, ' ' + t('setup.denied'));
    put(row++, ' ' + theme.dim + t('setup.deniedHint') + ansi.reset);
  } else {
    put(row++, ' ' + t('setup.body'));
    if (s.adbError) put(row++, ' ' + theme.dim + truncate(String(s.adbError), width - 2, '…') + ansi.reset);
    row++;
    put(row++, ' ' + theme.dim + t('setup.tried') + ansi.reset);
    for (const p of s.adbTried.slice(0, Math.max(0, bottom - row - 3))) put(row++, '   ' + theme.dim + truncate(p, width - 4, '…') + ansi.reset);
  }
  row++;
  w.buttonFlow(row, col0 + 1, width - 2, [
    { label: t('btn.locateAdb'), action: 'locate-adb', tone: 'accent', tip: t('tip.locateAdb') },
    { label: t('btn.retry'), action: 'probe-adb', tip: t('tip.retryProbe') },
  ], put);
}

function renderNoDevice(ctx, put, col0, width, top, bottom) {
  const s = ctx.state;
  let row = top + 1;
  if (s.devicesError) {
    put(row++, ' ' + theme.error + t('nodev.error') + ansi.reset);
    put(row++, ' ' + theme.dim + truncate(s.devicesError, width - 2, '…') + ansi.reset);
    row++;
  } else if (!s.devicesEverLoaded) {
    put(row++, ' ' + w.spinner() + ' ' + t('side.loading'));
    return;
  } else {
    put(row++, ' ' + ansi.bold + t('nodev.title') + ansi.reset);
    row++;
    put(row++, ' ' + t('nodev.usb'));
    put(row++, ' ' + t('nodev.wifi'));
    put(row++, ' ' + t('nodev.pairHint'));
    row++;
  }
  w.buttonFlow(row, col0 + 1, width - 2, [
    { label: t('btn.refresh'), action: 'refresh', tip: t('tip.refresh') },
    { label: t('btn.connect'), action: 'connect', tone: 'accent', tip: t('tip.connect') },
    { label: t('btn.pair'), action: 'pair', tip: t('tip.pair') },
    { label: t('btn.scan'), action: 'mdns-scan', tip: t('tip.scan') },
    { label: t('btn.restartServer'), action: 'server-restart', tone: 'warn', tip: t('tip.restartServer') },
  ], put);
}

// ---------- 개요 ----------

function renderOverview(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const rec = s.info[dev.serial] || {};
  const info = rec.data || {};
  let row = top;
  const labelW = 14;
  const half = Math.floor((width - 2) / 2);
  const twoCol = width >= 96;

  const fields = [
    [t('ov.model'), info.model ? (info.manufacturer ? info.manufacturer + ' ' : '') + info.model : dev.model.replace(/_/g, ' ')],
    [t('ov.android'), info.release ? info.release + (info.sdk ? ' (API ' + info.sdk + ')' : '') : ''],
    [t('ov.build'), info.build],
    [t('ov.security'), info.security],
    [t('ov.serial'), dev.serial],
    [t('ov.state'), w.badge(stateLabel(dev.state), stateTone(dev.state)) + '  ' + theme.dim + t('ov.kind.' + dev.kind) + (dev.transportId ? ' · tid ' + dev.transportId : '') + ansi.reset],
    [t('ov.abi'), info.abi],
    [t('ov.screen'), info.screen ? info.screen + (info.density ? ' @' + info.density + 'dpi' : '') : ''],
    [t('ov.ip'), info.ip],
    [t('ov.uptime'), formatUptime(info.uptimeSec)],
    [t('ov.memory'), info.memTotalKb ? formatBytes((info.memTotalKb - (info.memAvailKb || 0)) * 1024) + ' / ' + formatBytes(info.memTotalKb * 1024) : ''],
    [t('ov.storage'), info.storage],
  ];
  const batteryText = info.batteryLevel != null
    ? w.gauge(info.batteryLevel, 12, true) + ' ' + info.batteryLevel + '%' + (info.charging ? ' ' + theme.success + '⚡' + ansi.reset : '') + (info.batteryTemp != null ? theme.dim + ' ' + info.batteryTemp.toFixed(1) + '°C' + ansi.reset : '')
    : '';
  fields.push([t('ov.battery'), batteryText]);

  const headerExtra = rec.loading ? ' ' + w.spinner() : rec.error ? ' ' + w.badge(t('ov.infoError'), 'error') : '';
  put(row++, ' ' + w.sectionHeader(t('ov.info') + headerExtra, width - 2));
  if (twoCol) {
    const leftCount = Math.ceil(fields.length / 2);
    for (let i = 0; i < leftCount; i++) {
      const l = fields[i], r = fields[i + leftCount];
      let text = ' ' + w.fieldRow(l[0], labelW, l[1]);
      if (r) text = padEnd(text, half + 1) + ' ' + w.fieldRow(r[0], labelW, r[1]);
      put(row++, text);
    }
  } else {
    for (const f of fields) { if (row >= bottom - 3) break; put(row++, ' ' + w.fieldRow(f[0], labelW, f[1])); }
  }
  if (rec.error && row < bottom) put(row++, ' ' + theme.dim + truncate(rec.error, width - 2, '…') + ansi.reset);

  row++;
  if (row >= bottom) return;
  put(row++, ' ' + w.sectionHeader(t('ov.actions'), width - 2));
  const online = dev.state === 'device';
  const buttons = [
    { label: t('btn.screenshot'), action: 'screenshot', tip: t('tip.screenshot'), disabled: !online },
    { label: t('btn.installApk'), action: 'install', tip: t('tip.installApk'), disabled: !online },
    { label: t('btn.reboot'), action: 'reboot-menu', tip: t('tip.reboot'), tone: 'warn' },
    { label: t('btn.wifi'), action: 'wifi-enable', tip: t('tip.wifi'), disabled: !online || adb.isNetworkDevice(dev) },
    { label: t('btn.tcpip'), action: 'tcpip', tip: t('tip.tcpip'), disabled: !online },
  ];
  if (adb.isNetworkDevice(dev)) buttons.push({ label: t('btn.disconnect'), action: 'disconnect', tip: t('tip.disconnect'), tone: 'error' });
  else buttons.push({ label: t('btn.usbMode'), action: 'usb-mode', tip: t('tip.usbMode'), disabled: !online });
  buttons.push(
    { label: t('btn.pushFile'), action: 'push', tip: t('tip.pushFile'), disabled: !online },
    { label: t('btn.pullFile'), action: 'pull', tip: t('tip.pullFile'), disabled: !online },
    { label: t('btn.openShellTab'), action: 'open-shell-tab', tip: t('tip.openShellTab') },
    { label: t('btn.inputText'), action: 'input-text', tip: t('tip.inputText'), disabled: !online },
    { label: t('btn.keyevent'), action: 'keyevent-menu', tip: t('tip.keyevent'), disabled: !online },
    { label: t('btn.copySerial'), action: 'copy-serial', tip: dev.serial },
    { label: t('btn.refreshInfo'), action: 'info-refresh', tip: t('tip.refreshInfo') },
  );
  w.buttonFlow(row, col0 + 1, width - 2, buttons, put, Math.max(1, bottom - row + 1));
}

// ---------- Logcat ----------

function renderLogcat(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const lc = ctx.logcat;
  const sess = lc.session;
  const f = sess.filter;
  let row = top;

  // 툴바 1: 실행 상태·따라가기·레벨·지우기·저장
  let col = col0 + 1, line = ' ';
  const push = (r) => { line += r.text + ' '; col += r.width + 1; };
  const running = sess.running && sess.serial === dev.serial;
  push(w.button(row, col, running ? t('lc.running') : t('lc.stopped'), running ? 'lc-stop' : 'lc-start', { tone: running ? 'success' : 'default', tip: running ? t('tip.lcStop') : t('tip.lcStart') }));
  push(w.button(row, col, s.logcat.follow ? t('lc.follow') : t('lc.paused'), 'lc-follow', { active: s.logcat.follow, tone: s.logcat.follow ? 'accent' : 'warn', tip: t('tip.lcFollow') }));
  push(w.dropdown(row, col, t('lc.level'), f.minLevel, 'lc-level', { tip: t('tip.lcLevel') }));
  push(w.button(row, col, t('btn.clear'), 'lc-clear', { tip: t('tip.lcClear') }));
  push(w.button(row, col, t('btn.save'), 'lc-save', { tip: t('tip.lcSave') }));
  if (width - (col - col0) > 14) push(w.dropdown(row, col, t('lc.buffers'), (s.logcatBuffers && s.logcatBuffers.length ? s.logcatBuffers.join(',') : t('lc.bufferDefault')), 'lc-buffers', { tip: t('tip.lcBuffers') }));
  put(row++, line);

  // 툴바 2: 필터
  col = col0 + 1; line = ' ';
  push(w.button(row, col, t('lc.filterText') + ': ' + (f.text ? truncate(f.text, 16, '…') : '—'), 'lc-text', { active: !!f.text, tip: t('tip.lcText') }));
  push(w.button(row, col, t('lc.filterTag') + ': ' + (f.tag ? truncate(f.tag, 14, '…') : '—'), 'lc-tag', { active: !!f.tag, tip: t('tip.lcTag') }));
  push(w.button(row, col, t('lc.filterPid') + ': ' + (f.pid ? (f.pkgName ? truncate(f.pkgName, 14, '…') : String(f.pid)) : '—'), 'lc-pid', { active: !!f.pid, tip: t('tip.lcPid') }));
  if (f.excludeTags.size) push(w.button(row, col, t('lc.excluded', { count: f.excludeTags.size }), 'lc-excludes', { active: true, tip: Array.from(f.excludeTags).join(', ') }));
  if (lc.hasFilter()) push(w.button(row, col, t('btn.clearFilters'), 'lc-clear-filters', { tone: 'warn', tip: t('tip.lcClearFilters') }));
  put(row++, line);

  // 카운터 줄
  const visible = lc.visible();
  const counts = sess.counts;
  let counter = ' ' + theme.dim + t('lc.lines', { shown: visible.length, total: sess.lines.length }) + ansi.reset +
    '  ' + levelColor.W + 'W ' + counts.W + ansi.reset + ' ' + levelColor.E + 'E ' + counts.E + ansi.reset + ' ' + levelColor.F + 'F ' + counts.F + ansi.reset;
  if (sess.dropped) counter += theme.dim + '  ' + t('lc.dropped', { count: sess.dropped }) + ansi.reset;
  if (sess.error) counter += '  ' + theme.error + truncate(sess.error, 40, '…') + ansi.reset;
  put(row++, counter);

  const listTop = row;
  const listRows = Math.max(1, bottom - listTop + 1);
  s.layout.listTop = listTop;
  s.layout.listRows = listRows;

  // 스크롤 위치 — follow 면 항상 바닥
  const maxScroll = Math.max(0, visible.length - listRows);
  if (s.logcat.follow) { s.logcat.scroll = maxScroll; s.logcat.newSince = 0; }
  else if (s.logcat.scroll > maxScroll) s.logcat.scroll = maxScroll;
  s.logcat.lastVisibleCount = visible.length;

  if (!visible.length) {
    const msg = !running && !sess.lines.length ? t('lc.emptyStopped') : lc.hasFilter() ? t('lc.emptyFiltered') : t('lc.emptyWaiting');
    put(listTop, ' ' + theme.dim + msg + ansi.reset);
    if (lc.hasFilter() && sess.lines.length) {
      const b = w.button(listTop + 1, col0 + 1, t('btn.clearFilters'), 'lc-clear-filters', { tone: 'warn' });
      put(listTop + 1, ' ' + b.text);
    }
    return;
  }

  const tsW = width >= 110 ? 18 : width >= 80 ? 12 : 0;
  const showPid = width >= 100;
  const tagW = width >= 120 ? 24 : width >= 90 ? 18 : 12;
  const rowText = new Map();
  for (let i = 0; i < listRows; i++) {
    const idx = s.logcat.scroll + i;
    if (idx >= visible.length) break;
    const e = visible[idx];
    const r = listTop + i;
    const selected = idx === s.logcat.sel;
    const hot = zones.add(r, col0, col0 + width - 1, 'lc-line:' + idx, {
      label: t('menu.logLine'), data: { idx }, cursor: 'default', tip: null,
    });
    let text;
    if (e.marker) text = theme.dim + ' ' + e.raw + ansi.reset;
    else if (e.unparsed) text = ' ' + sanitize(e.raw);
    else {
      const color = levelColor[e.level] || '';
      text = ' ' + (tsW ? theme.dim + (tsW === 18 ? e.ts : e.ts.slice(6)) + ansi.reset + ' ' : '') +
        (showPid ? theme.dim + padStart(String(e.pid), 5) + ansi.reset + ' ' : '') +
        color + e.level + ansi.reset + ' ' +
        color + fit(e.tag, tagW, '…') + ansi.reset + ' ' +
        (e.level === 'E' || e.level === 'F' ? color : '') + sanitize(e.msg) + ansi.reset;
    }
    if (selected) text = theme.selBg + fit(text, width) + ansi.reset;
    else if (hot) text = theme.hoverBg + fit(text, width) + ansi.reset;
    rowText.set(r, text);
    put(r, text);
  }
  // 우하단 배지: 따라가기 해제 중 새 줄 수 [W24], 아니면 스크롤 위치 [S4]
  let badgeText = null, badgeAction = null;
  if (!s.logcat.follow && s.logcat.newSince > 0) {
    badgeText = '↓ ' + t('lc.newLines', { count: s.logcat.newSince });
    badgeAction = 'lc-follow';
  } else if (visible.length > listRows) {
    badgeText = Math.min(visible.length, s.logcat.scroll + listRows) + '/' + visible.length;
  }
  if (badgeText) {
    const bw = stringWidth(badgeText) + 2;
    const bcol = col0 + width - bw;
    const hot = badgeAction && zones.add(bottom, bcol, bcol + bw - 1, badgeAction, { label: t('lc.follow') });
    const base = truncate(rowText.get(bottom) || '', width - bw - 1, '…');
    const style = badgeAction ? (hot ? theme.hoverBg : theme.warn + ansi.inverse) : theme.dim;
    put(bottom, padEnd(base, width - bw) + style + ' ' + badgeText + ' ' + ansi.reset);
  }
}

// ---------- 패키지 ----------

function renderPackages(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const pk = s.packages;
  let row = top;
  let col = col0 + 1, line = ' ';
  const push = (r) => { line += r.text + ' '; col += r.width + 1; };
  push(w.segmented(row, col, [t('pk.thirdParty'), t('pk.all')], pk.showAll ? 1 : 0, 'pk-scope', { tip: t('tip.pkScope') }));
  push(w.button(row, col, t('btn.search') + ': ' + (pk.query ? truncate(pk.query, 18, '…') : '—'), 'pk-search', { active: !!pk.query, tip: t('tip.pkSearch') }));
  if (pk.query) push(w.button(row, col, t('btn.clear'), 'pk-clear-search', { tip: t('tip.pkClearSearch') }));
  push(w.button(row, col, t('btn.refresh'), 'pk-refresh', { tip: t('tip.pkRefresh') }));
  push(w.button(row, col, t('btn.installApk'), 'install', { tip: t('tip.installApk') }));
  put(row++, line);

  const items = S.filteredPackages(s);
  let counter = ' ' + theme.dim + t('pk.count', { shown: items.length, total: pk.list.length }) + ansi.reset;
  if (pk.loading) counter += ' ' + w.spinner();
  if (pk.error) counter += '  ' + theme.error + truncate(pk.error, width - 30, '…') + ansi.reset;
  put(row++, counter);

  const listTop = row;
  const listRows = Math.max(1, bottom - listTop + 1);
  s.layout.listTop = listTop; s.layout.listRows = listRows;
  clampList(pk, items.length, listRows);
  if (!items.length) {
    put(listTop, ' ' + theme.dim + (pk.loading ? t('side.loading') : pk.query ? t('pk.emptyFiltered') : t('pk.empty')) + ansi.reset);
    return;
  }
  let lastText = '';
  for (let i = 0; i < listRows; i++) {
    const idx = pk.scroll + i;
    if (idx >= items.length) break;
    const name = items[idx];
    const r = listTop + i;
    const hot = zones.add(r, col0, col0 + width - 1, 'pk-row:' + idx, { label: t('menu.packageActions', { name }), data: { idx, name }, tip: null });
    let text = ' ' + highlightQuery(name, pk.query);
    if (idx === pk.sel) text = theme.selBg + fit(text, width) + ansi.reset;
    else if (hot) text = theme.hoverBg + fit(text, width) + ansi.reset;
    if (r === bottom) lastText = text;
    put(r, text);
  }
  if (items.length > listRows) put(bottom, withScrollIndicator(lastText, pk, items.length, listRows, width));
}

function highlightQuery(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return text.slice(0, idx) + ansi.underline + theme.accent + text.slice(idx, idx + query.length) + ansi.reset + text.slice(idx + query.length);
}

// 리스트 마지막 행 우측에 `12/140` 위치 표시를 덧붙인다 [S4]
function withScrollIndicator(rowText, store, total, listRows, width) {
  const label = ' ' + Math.min(total, store.scroll + listRows) + '/' + total + ' ';
  const bw = stringWidth(label);
  return padEnd(truncate(rowText, width - bw - 1, '…'), width - bw) + theme.dim + label + ansi.reset;
}

function clampList(store, total, listRows) {
  if (store.sel >= total) store.sel = Math.max(0, total - 1);
  if (store.sel < 0) store.sel = 0;
  const maxScroll = Math.max(0, total - listRows);
  if (store.scroll > maxScroll) store.scroll = maxScroll;
  if (store.scroll < 0) store.scroll = 0;
}

// ---------- 파일 ----------

function renderFiles(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const fsS = s.files;
  let row = top;
  // 경로 브레드크럼
  const parts = fsS.path.split('/').filter(Boolean);
  let col = col0 + 1, line = ' ';
  const hotRoot = zones.add(row, col, col, 'fs-crumb:-1', { label: t('menu.goTo', { name: '/' }) });
  line += (hotRoot ? theme.hoverBg : '') + theme.accent + '/' + ansi.reset;
  col += 1;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const pw = stringWidth(parts[i]);
    if (col + pw > col0 + width - 20) { line += theme.dim + '…' + ansi.reset; col += 1; break; }
    const hot = !last && zones.add(row, col, col + pw - 1, 'fs-crumb:' + i, { label: t('menu.goTo', { name: parts[i] }) });
    line += last ? ansi.bold + parts[i] + ansi.reset : (hot ? theme.hoverBg : '') + theme.accent + parts[i] + ansi.reset;
    col += pw;
    if (!last) { line += theme.dim + '/' + ansi.reset; col += 1; }
  }
  col += 2;
  const push = (r) => { line += ' ' + r.text; col += r.width + 1; };
  line += ' ';
  push(w.button(row, col, t('btn.up'), 'fs-up', { tip: t('tip.fsUp') }));
  push(w.button(row, col, t('btn.goTo'), 'fs-goto', { tip: t('tip.fsGoto') }));
  push(w.button(row, col, t('btn.pushHere'), 'fs-push', { tip: t('tip.fsPush') }));
  push(w.button(row, col, t('btn.mkdir'), 'fs-mkdir', { tip: t('tip.fsMkdir') }));
  push(w.button(row, col, t('btn.refresh'), 'fs-refresh', { tip: t('tip.fsRefresh') }));
  put(row++, line);

  let counter = ' ' + theme.dim + t('fs.count', { count: fsS.entries.length }) + ansi.reset;
  if (fsS.loading) counter += ' ' + w.spinner();
  if (fsS.error) counter += '  ' + theme.error + truncate(fsS.error, width - 20, '…') + ansi.reset;
  else if (fsS.warning) counter += '  ' + theme.warn + truncate(fsS.warning, width - 20, '…') + ansi.reset;
  put(row++, counter);

  const listTop = row;
  const listRows = Math.max(1, bottom - listTop + 1);
  s.layout.listTop = listTop; s.layout.listRows = listRows;
  const items = fsS.entries;
  clampList(fsS, items.length, listRows);
  if (!items.length) { put(listTop, ' ' + theme.dim + (fsS.loading ? t('side.loading') : t('fs.empty')) + ansi.reset); return; }
  const sizeW = 8, dateW = width >= 90 ? 17 : 0;
  for (let i = 0; i < listRows; i++) {
    const idx = fsS.scroll + i;
    if (idx >= items.length) break;
    const e = items[idx];
    const r = listTop + i;
    const hot = zones.add(r, col0, col0 + width - 1, 'fs-row:' + idx, { label: e.type === 'file' ? t('menu.fileActions', { name: e.name }) : t('menu.open', { name: e.name }), data: { idx, name: e.name }, tip: null });
    const mark = e.type === 'dir' ? theme.accent + '▸' : e.type === 'link' ? theme.warn + '→' : theme.dim + '·';
    const nameW = width - 3 - sizeW - 1 - dateW - 1;
    let name = e.type === 'dir' ? ansi.bold + fit(e.name, nameW, '…') + ansi.reset : e.type === 'link' ? fit(e.name + (e.target ? theme.dim + ' → ' + e.target : ''), nameW, '…') + ansi.reset : fit(e.name, nameW, '…');
    if (e.error) name = theme.error + fit(e.name, nameW, '…') + ansi.reset;
    let text = ' ' + mark + ansi.reset + ' ' + name + ' ' + theme.dim + padStart(e.size != null && e.type === 'file' ? formatBytes(e.size) : '', sizeW) + (dateW ? ' ' + padEnd(e.mtime || '', dateW) : '') + ansi.reset;
    if (idx === fsS.sel) text = theme.selBg + fit(text, width) + ansi.reset;
    else if (hot) text = theme.hoverBg + fit(text, width) + ansi.reset;
    put(r, text);
  }
}

// ---------- 셸 ----------

function renderShell(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const sh = s.shell;
  let row = top;
  let col = col0 + 1, line = ' ';
  const push = (r) => { line += r.text + ' '; col += r.width + 1; };
  push(w.button(row, col, t('btn.runCommand'), 'sh-run', { tone: 'accent', tip: t('tip.shRun') }));
  push(w.dropdown(row, col, '', t('sh.quick'), 'sh-quick', { tip: t('tip.shQuick') }));
  push(w.button(row, col, t('btn.repeatLast'), 'sh-repeat', { tip: sh.lastCmd || t('tip.shRepeat'), disabled: !sh.lastCmd }));
  push(w.button(row, col, t('btn.clear'), 'sh-clear', { tip: t('tip.shClear') }));
  push(w.button(row, col, t('btn.openShellTab'), 'open-shell-tab', { tip: t('tip.openShellTab') }));
  if (sh.running) line += theme.warn + w.spinner() + ansi.reset;
  put(row++, line);
  put(row++, ' ' + theme.dim + t('sh.hint') + ansi.reset);

  const listTop = row;
  const listRows = Math.max(1, bottom - listTop + 1);
  s.layout.listTop = listTop; s.layout.listRows = listRows;
  const items = S.shellLines(s);
  const maxScroll = Math.max(0, items.length - listRows);
  if (sh.follow) sh.scroll = maxScroll;
  else if (sh.scroll > maxScroll) sh.scroll = maxScroll;
  if (!items.length) { put(listTop, ' ' + theme.dim + t('sh.empty') + ansi.reset); return; }
  for (let i = 0; i < listRows; i++) {
    const idx = sh.scroll + i;
    if (idx >= items.length) break;
    const l = items[idx];
    const r = listTop + i;
    let text;
    if (l.kind === 'cmd') {
      const hot = zones.add(r, col0, col0 + width - 1, 'sh-cmd:' + idx, { label: t('menu.rerun', { cmd: truncate(l.text, 30, '…') }), data: { cmd: l.text } });
      const status = l.running ? theme.warn + w.spinner() : l.code === 0 ? theme.success + '✓' : theme.error + '✗' + (l.code != null ? ' ' + l.code : '');
      text = ' ' + theme.accent + '$ ' + ansi.bold + sanitize(l.text) + ansi.reset + ' ' + status + ansi.reset;
      if (hot) text = theme.hoverBg + fit(text, width) + ansi.reset;
    } else {
      text = '   ' + (l.err ? theme.warn : '') + sanitize(l.text) + ansi.reset;
    }
    put(r, text);
  }
}

// ---------- 포워딩 ----------

function renderForwards(ctx, put, col0, width, top, bottom, dev) {
  const s = ctx.state;
  const fw = s.forwards;
  let row = top;
  let col = col0 + 1, line = ' ';
  const push = (r) => { line += r.text + ' '; col += r.width + 1; };
  push(w.button(row, col, t('btn.addForward'), 'fw-add', { tone: 'accent', tip: t('tip.fwAdd'), disabled: !dev }));
  push(w.button(row, col, t('btn.addReverse'), 'rv-add', { tone: 'accent', tip: t('tip.rvAdd'), disabled: !dev }));
  push(w.button(row, col, t('btn.refresh'), 'fw-refresh', { tip: t('tip.fwRefresh') }));
  push(w.button(row, col, t('btn.removeAll'), 'fw-remove-all', { tone: 'error', tip: t('tip.fwRemoveAll'), disabled: !fw.forward.length && !fw.reverse.length }));
  if (fw.loading) line += theme.warn + w.spinner() + ansi.reset;
  put(row++, line);
  if (fw.error) put(row++, ' ' + theme.error + truncate(fw.error, width - 2, '…') + ansi.reset);
  else put(row++, ' ' + theme.dim + t('fw.hint') + ansi.reset);

  const listTop = row;
  const listRows = Math.max(1, bottom - listTop + 1);
  s.layout.listTop = listTop; s.layout.listRows = listRows;
  const items = S.forwardItems(s);
  clampList(fw, items.length, listRows);
  if (!items.length) { put(listTop, ' ' + theme.dim + (dev ? t('fw.empty') : t('fw.noDevice')) + ansi.reset); return; }
  let lastKind = null;
  let r = listTop;
  let drawn = 0;
  for (let idx = fw.scroll; idx < items.length && r <= bottom; idx++) {
    const it = items[idx];
    if (it.kind !== lastKind) {
      if (r > bottom) break;
      put(r++, ' ' + w.sectionHeader(it.kind === 'forward' ? t('fw.forwardSection') : t('fw.reverseSection'), width - 2));
      lastKind = it.kind;
      if (r > bottom) break;
    }
    const hot = zones.add(r, col0, col0 + width - 1, 'fw-row:' + idx, { label: t('menu.removeForward', { rule: it.local + ' → ' + it.remote }), data: { idx }, tip: it.serial });
    const arrow = it.kind === 'forward' ? ' → ' : ' ← ';
    let text = '   ' + ansi.bold + it.local + ansi.reset + theme.dim + arrow + ansi.reset + it.remote + (it.serial && it.serial !== dev?.serial && it.kind === 'forward' ? theme.dim + '   ' + it.serial + ansi.reset : '');
    if (idx === fw.sel) text = theme.selBg + fit(text, width) + ansi.reset;
    else if (hot) text = theme.hoverBg + fit(text, width) + ansi.reset;
    put(r++, text);
    drawn++;
  }
}

// ---------- 상태줄 / 힌트 ----------

function renderStatus(ctx, cols) {
  const s = ctx.state;
  const now = Date.now();
  if (s.status && s.status.until && s.status.until < now) s.status = null;
  let text = '';
  if (s.status) {
    const c = s.status.kind === 'error' ? theme.error : s.status.kind === 'success' ? theme.success : s.status.kind === 'warn' ? theme.warn : theme.accent;
    const mark = s.status.kind === 'error' ? '✗' : s.status.kind === 'success' ? '✓' : '·';
    text = ' ' + c + mark + ' ' + (s.status.key ? t(s.status.key, s.status.args) : s.status.text) + ansi.reset;
  } else {
    const z = zones.hitTest(zones.hoverPos().row, zones.hoverPos().col);
    if (z && z.label) text = ' ' + theme.dim + z.label + ansi.reset;
    else if (s.devicesAt) text = ' ' + theme.dim + t('status.idle', { time: new Date(s.devicesAt).toLocaleTimeString() }) + ansi.reset;
  }
  return truncate(text, cols, '…');
}

function renderHints(ctx, cols) {
  const s = ctx.state;
  const hints = [];
  const add = (key, label, action, tip) => hints.push({ key, label, action, tip });
  add('Tab', t('hint.nextTab'), 'next-tab');
  add('[ ]', t('hint.switchDevice'), 'device-menu');
  switch (s.tab) {
    case 'logcat':
      add('p', t('hint.follow'), 'lc-follow'); add('l', t('hint.level'), 'lc-level'); add('/', t('hint.filter'), 'lc-text'); add('c', t('hint.clear'), 'lc-clear'); add('S', t('hint.save'), 'lc-save');
      break;
    case 'packages':
      add('/', t('hint.search'), 'pk-search'); add('Enter', t('hint.actions'), 'pk-menu'); add('i', t('hint.install'), 'install');
      break;
    case 'files':
      add('Enter', t('hint.open'), 'fs-enter'); add('Bksp', t('hint.up'), 'fs-up'); add('m', t('hint.actions'), 'fs-menu'); add('g', t('hint.goTo'), 'fs-goto');
      break;
    case 'shell':
      add('Enter', t('hint.run'), 'sh-run'); add('.', t('hint.repeat'), 'sh-repeat'); add('c', t('hint.clear'), 'sh-clear');
      break;
    case 'forwards':
      add('f', t('hint.addForward'), 'fw-add'); add('v', t('hint.addReverse'), 'rv-add'); add('Del', t('hint.remove'), 'fw-remove');
      break;
    default:
      add('s', t('hint.screenshot'), 'screenshot'); add('i', t('hint.install'), 'install'); add('w', t('hint.wifi'), 'wifi-enable'); add('R', t('hint.reboot'), 'reboot-menu');
  }
  add('r', t('hint.refresh'), 'refresh');
  add('b', t('hint.sidebar'), 'toggle-sidebar');
  add('?', t('hint.help'), 'help');
  add('q', t('hint.quit'), 'quit');
  return ' ' + w.hintBar(s.rows, 2, hints, cols - 2).text;
}

// ---------- 최소화 ----------

function renderMinimized(ctx) {
  const s = ctx.state;
  zones.beginFrame();
  const dev = S.selectedDevice(s);
  const sess = ctx.logcat.session;
  let text = ' ' + theme.title + 'ADB' + ansi.reset + ' ' + theme.dim + '·' + ansi.reset + ' ';
  if (!s.adbReady) text += theme.error + t('title.adbMissing') + ansi.reset;
  else {
    text += t('title.devices', { count: s.devices.length });
    if (dev) text += theme.dim + ' · ' + ansi.reset + (dev.state === 'device' ? theme.success : theme.error) + '●' + ansi.reset + ' ' + S.deviceLabel(dev);
    if (sess.running) text += theme.dim + ' · ' + ansi.reset + t('min.logcat', { count: sess.lines.length }) + (sess.counts.E ? ' ' + levelColor.E + 'E ' + sess.counts.E + ansi.reset : '');
  }
  if (s.busy) text += ' ' + theme.warn + w.spinner() + ' ' + t(s.busy.key, s.busy.args) + ansi.reset;
  zones.add(1, 1, s.cols, 'restore', { label: t('menu.restore') });
  screen.write(ansi.hideCursor + ansi.moveTo(1, 1) + ansi.reset + fit(truncate(text, s.cols - 1, '…'), s.cols - 1) + ansi.reset);
}

module.exports = { render, renderMinimized, tabDefs, stateLabel, stateTone };
