'use strict';
// lib/menus.js — 우클릭 컨텍스트 메뉴 [X1]~[X4]. 존의 action/data 로 대상을 판정하고, 폴백 메뉴를 항상 띄운다.

const S = require('./state');
const adb = require('./adb');
const { t } = require('./i18n');

function create(ctx) {
  const { state: s, logcat, actions } = ctx;

  function globalItems() {
    const items = [
      { id: 'refresh', label: t('btn.refresh'), icon: 'refresh', shortcut: 'r' },
      { id: 'device-menu', label: t('menu.switchDevice'), icon: 'device-mobile', shortcut: '[ ]' },
      { type: 'separator' },
      { id: 'connect', label: t('btn.connect'), icon: 'radio-tower' },
      { id: 'pair', label: t('btn.pair'), icon: 'key' },
      { id: 'mdns-scan', label: t('btn.scan'), icon: 'search' },
      { type: 'separator' },
      { id: 'server-restart', label: t('btn.restartServer'), icon: 'debug-restart', color: '#E5C07B' },
      { id: 'server-start', label: t('btn.startServer'), icon: 'play' },
      { id: 'server-kill', label: t('btn.killServer'), icon: 'debug-stop', color: '#E06C75' },
      { type: 'separator' },
      { id: 'toggle-sidebar', label: s.sidebarVisible ? t('menu.hideSidebar') : t('menu.showSidebar'), shortcut: 'b' },
      { id: 'help', label: t('hint.help'), icon: 'question', shortcut: '?' },
      { id: 'quit', label: t('hint.quit'), icon: 'close', shortcut: 'q' },
    ];
    if (!s.adbReady) items.unshift({ id: 'locate-adb', label: t('btn.locateAdb'), icon: 'folder-opened' }, { type: 'separator' });
    return items;
  }

  function deviceItems(serial) {
    const d = s.devices.find((x) => x.serial === serial);
    if (!d) return [];
    const items = [
      { id: 'device:' + serial, label: t('menu.selectDevice', { name: S.deviceLabel(d) }), icon: 'check', checked: serial === s.selectedSerial },
      { type: 'separator' },
      { id: 'device-copy:' + serial, label: t('menu.copySerial', { serial }), icon: 'clippy' },
    ];
    if (adb.isNetworkDevice(d)) items.push({ id: 'device-disconnect:' + serial, label: t('menu.disconnectDevice', { host: serial }), icon: 'debug-disconnect', color: '#E06C75' });
    items.push({ type: 'separator' });
    items.push({ id: 'reboot-menu', label: t('btn.reboot'), icon: 'debug-restart', color: '#E5C07B' });
    return items;
  }

  function tabItems() {
    switch (s.tab) {
      case 'logcat': {
        const f = logcat.session.filter;
        return [
          { id: logcat.session.running ? 'lc-stop' : 'lc-start', label: logcat.session.running ? t('lc.stopMenu') : t('lc.startMenu'), icon: logcat.session.running ? 'debug-stop' : 'play' },
          { id: 'lc-follow', label: t('lc.follow'), icon: 'arrow-down', checked: s.logcat.follow, shortcut: 'p' },
          { id: 'lc-level', label: t('lc.level') + ': ' + f.minLevel, icon: 'filter', shortcut: 'l' },
          { id: 'lc-text', label: t('lc.filterText'), icon: 'search', shortcut: '/' },
          { id: 'lc-tag', label: t('lc.filterTag'), icon: 'tag' },
          { id: 'lc-pid', label: t('lc.filterPid'), icon: 'symbol-number' },
          ...(logcat.hasFilter() ? [{ id: 'lc-clear-filters', label: t('btn.clearFilters'), icon: 'clear-all' }] : []),
          { type: 'separator' },
          { id: 'lc-clear', label: t('tip.lcClear'), icon: 'trash', shortcut: 'c', color: '#E5C07B' },
          { id: 'lc-save', label: t('tip.lcSave'), icon: 'save', shortcut: 'S' },
        ];
      }
      case 'packages':
        return [
          { id: 'pk-search', label: t('btn.search'), icon: 'search', shortcut: '/' },
          { id: 'pk-scope:' + (s.packages.showAll ? 0 : 1), label: s.packages.showAll ? t('pk.thirdPartyMenu') : t('pk.allMenu'), icon: 'filter' },
          { id: 'pk-refresh', label: t('btn.refresh'), icon: 'refresh' },
          { id: 'install', label: t('btn.installApk'), icon: 'package', shortcut: 'i' },
        ];
      case 'files':
        return [
          { id: 'fs-up', label: t('btn.up'), icon: 'arrow-up', shortcut: 'Backspace' },
          { id: 'fs-goto', label: t('btn.goTo'), icon: 'go-to-file', shortcut: 'g' },
          { id: 'fs-push', label: t('btn.pushHere'), icon: 'cloud-upload' },
          { id: 'fs-mkdir', label: t('btn.mkdir'), icon: 'new-folder' },
          { id: 'fs-refresh', label: t('btn.refresh'), icon: 'refresh' },
        ];
      case 'shell':
        return [
          { id: 'sh-run', label: t('btn.runCommand'), icon: 'terminal', shortcut: 'Enter' },
          { id: 'sh-quick', label: t('sh.quick'), icon: 'list-flat' },
          { id: 'sh-repeat', label: t('btn.repeatLast'), icon: 'debug-rerun', shortcut: '.' },
          { id: 'sh-copy-output', label: t('menu.copyLastOutput'), icon: 'clippy' },
          { id: 'sh-clear', label: t('btn.clear'), icon: 'clear-all', shortcut: 'c' },
          { id: 'open-shell-tab', label: t('btn.openShellTab'), icon: 'terminal-tmux' },
        ];
      case 'forwards':
        return [
          { id: 'fw-add', label: t('btn.addForward'), icon: 'add', shortcut: 'f' },
          { id: 'rv-add', label: t('btn.addReverse'), icon: 'add', shortcut: 'v' },
          { id: 'fw-refresh', label: t('btn.refresh'), icon: 'refresh' },
          { id: 'fw-remove-all', label: t('btn.removeAll'), icon: 'trash', color: '#E06C75' },
        ];
      default: {
        const d = S.selectedDevice(s);
        if (!d) return [];
        return [
          { id: 'screenshot', label: t('btn.screenshot'), icon: 'device-camera', shortcut: 's' },
          { id: 'install', label: t('btn.installApk'), icon: 'package', shortcut: 'i' },
          { id: 'wifi-enable', label: t('btn.wifi'), icon: 'radio-tower', shortcut: 'w' },
          { id: 'open-shell-tab', label: t('btn.openShellTab'), icon: 'terminal' },
          { id: 'copy-serial', label: t('menu.copySerial', { serial: d.serial }), icon: 'clippy' },
          { id: 'reboot-menu', label: t('btn.reboot'), icon: 'debug-restart', color: '#E5C07B', shortcut: 'R' },
          ...(adb.isNetworkDevice(d) ? [{ id: 'disconnect', label: t('btn.disconnect'), icon: 'debug-disconnect', color: '#E06C75' }] : []),
        ];
      }
    }
  }

  // 존별 항목 + 탭 항목 + 전역 항목. 첫 항목은 우클릭 지점의 컨트롤 [X2].
  function itemsForZone(zone) {
    const specific = [];
    if (zone && zone.action) {
      const a = zone.action;
      const head = a.split(':')[0];
      const arg = a.includes(':') ? a.slice(a.indexOf(':') + 1) : null;
      switch (head) {
        case 'device': return dedupe([...deviceItems(arg), { type: 'separator' }, ...globalItems()]);
        case 'pk-row': { s.packages.sel = Number(arg); return { deferred: () => actions.packageMenu(zone.data && zone.data.name) }; }
        case 'fs-row': { s.files.sel = Number(arg); return { deferred: () => actions.fileMenu(Number(arg)) }; }
        case 'fw-row': { s.forwards.sel = Number(arg); return { deferred: () => actions.forwardRowMenu(Number(arg)) }; }
        case 'lc-line': { s.logcat.sel = Number(arg); s.logcat.follow = false; return { deferred: () => actions.logLineMenu(Number(arg)) }; }
        case 'sh-cmd': specific.push({ id: a, label: zone.label, icon: 'debug-rerun' }, { id: 'sh-copy:' + arg, label: t('menu.copyCommand'), icon: 'clippy' }); break;
        case 'tab': break;
        default:
          if (zone.label && !['lc-follow'].includes(a)) specific.push({ id: a, label: zone.label });
      }
    }
    const items = [...specific];
    if (specific.length) items.push({ type: 'separator' });
    const tabs = tabItems();
    if (tabs.length) items.push(...tabs, { type: 'separator' });
    items.push(...globalItems());
    return dedupe(items);
  }

  function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (it.type === 'separator') { if (out.length && out[out.length - 1].type !== 'separator') out.push(it); continue; }
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    while (out.length && out[out.length - 1].type === 'separator') out.pop();
    return out;
  }

  return { itemsForZone, globalItems, tabItems, deviceItems };
}

module.exports = { create };
