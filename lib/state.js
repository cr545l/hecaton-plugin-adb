'use strict';
// lib/state.js — 앱 전역 상태. 렌더·액션·메뉴가 같은 객체를 공유한다.
// 화면 문자열은 저장하지 않고 {key, args} 나 원시 데이터만 둔다 (언어 변경 시 다시 그리기 위해).

const TABS = ['overview', 'logcat', 'packages', 'files', 'shell', 'forwards'];

function createState() {
  return {
    cols: 80, rows: 24, minimized: false,
    // adb 탐색
    adbReady: false, adbProbing: true, adbError: null, adbDenied: false, adbTried: [],
    // 단말
    devices: [], selectedSerial: null, devicesError: null, devicesLoading: false, devicesAt: 0, devicesEverLoaded: false,
    serverRunning: null,
    mdns: [], mdnsAt: 0,
    info: {},                 // serial -> { data, loading, error, at }
    // 화면
    tab: 'overview', tabs: TABS,
    sidebarVisible: true, sidebarScroll: 0,
    status: null,             // { key?, text?, args?, kind, until }
    busy: null,               // { key, args, since }
    hostVersion: null,
    toastSupported: undefined,
    // 탭별
    packages: { serial: null, list: [], loading: false, error: null, query: '', showAll: false, sel: 0, scroll: 0, at: 0 },
    files: { serial: null, path: '/sdcard', entries: [], loading: false, error: null, warning: null, sel: 0, scroll: 0, at: 0 },
    shell: { entries: [], scroll: 0, follow: true, running: false, lastCmd: '' },
    forwards: { serial: null, forward: [], reverse: [], loading: false, error: null, sel: 0, scroll: 0, section: 'forward', at: 0 },
    logcat: { follow: true, scroll: 0, sel: -1, newSince: 0, lastVisibleCount: 0 },
    // 렌더가 기록하는 레이아웃 파생값 (입력 코드는 이것만 읽는다) [L1]
    layout: { sidebarW: 0, contentCol: 1, contentW: 80, bodyTop: 3, bodyBottom: 22, listTop: 5, listRows: 10, sideListTop: 4, sideListRows: 10 },
    dirty: false,
  };
}

function selectedDevice(s) {
  return s.devices.find((d) => d.serial === s.selectedSerial) || null;
}

function deviceLabel(d) {
  if (!d) return '';
  return d.displayName || d.serial;
}

// 현재 탭의 리스트 상태 { items, sel, scroll } 접근자 — 키보드/휠 처리를 한 곳에 모으기 위함
function currentList(s, logcatVisible) {
  switch (s.tab) {
    case 'packages': return { store: s.packages, items: filteredPackages(s) };
    case 'files': return { store: s.files, items: s.files.entries };
    case 'forwards': return { store: s.forwards, items: forwardItems(s) };
    case 'logcat': return { store: s.logcat, items: logcatVisible || [] };
    case 'shell': return { store: s.shell, items: shellLines(s) };
    default: return null;
  }
}

function filteredPackages(s) {
  const q = s.packages.query.trim().toLowerCase();
  if (!q) return s.packages.list;
  return s.packages.list.filter((p) => p.toLowerCase().includes(q));
}

function forwardItems(s) {
  const out = [];
  for (const f of s.forwards.forward) out.push({ kind: 'forward', ...f });
  for (const r of s.forwards.reverse) out.push({ kind: 'reverse', ...r });
  return out;
}

// 셸 출력 패널의 줄 배열 (캐시)
function shellLines(s) {
  const sh = s.shell;
  if (sh._cache && sh._cacheLen === sh.entries.length && sh._cacheLast === (sh.entries[sh.entries.length - 1] || {}).output) return sh._cache;
  const lines = [];
  for (const e of sh.entries) {
    lines.push({ kind: 'cmd', text: e.cmd, code: e.code, at: e.at, running: e.running });
    for (const l of String(e.output || '').split('\n')) lines.push({ kind: 'out', text: l, err: e.code !== 0 && e.code !== null });
  }
  sh._cache = lines;
  sh._cacheLen = sh.entries.length;
  sh._cacheLast = (sh.entries[sh.entries.length - 1] || {}).output;
  return lines;
}

module.exports = { TABS, createState, selectedDevice, deviceLabel, currentList, filteredPackages, forwardItems, shellLines };
