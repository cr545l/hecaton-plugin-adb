'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const adb = require(path.join(root, 'lib/adb'));
const logcat = require(path.join(root, 'lib/logcat'));
const text = require(path.join(root, 'lib/text'));
const config = require(path.join(root, 'lib/config'));

test('parseDevices handles usb, wifi-mdns, tcp and emulator serials with states', () => {
  const out = adb.parseDevices([
    'List of devices attached',
    'R3CX70BDDFT           device usb:1-2 product:q6qksx model:SM_F956N device:q6q transport_id:3',
    'adb-R3CX70BDDFT-cB8XvT._adb-tls-connect._tcp device product:q6qksx model:SM_F956N device:q6q transport_id:5',
    '192.168.0.12:5555     offline transport_id:7',
    'emulator-5554         unauthorized',
    '* daemon started successfully',
    '',
  ].join('\n'));
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((d) => d.kind), ['usb', 'wifi', 'tcp', 'emulator']);
  assert.equal(out[0].model, 'SM_F956N');
  assert.equal(out[0].displayName, 'SM F956N');
  assert.equal(out[0].transportId, '3');
  assert.equal(out[2].state, 'offline');
  assert.equal(out[3].state, 'unauthorized');
  assert.ok(adb.isNetworkDevice(out[1]));
  assert.ok(adb.isNetworkDevice(out[2]));
  assert.ok(!adb.isNetworkDevice(out[0]));
});

test('parseVersion reads bridge, version and install path', () => {
  const v = adb.parseVersion('Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\nInstalled as C:\\Sdk\\platform-tools\\adb.exe\nRunning on Windows');
  assert.equal(v.bridge, '1.0.41');
  assert.equal(v.version, '36.0.0-13206524');
  assert.equal(v.installed, 'C:\\Sdk\\platform-tools\\adb.exe');
});

test('parseDeviceInfo extracts marked getprop/battery/network output', () => {
  const stdout = [
    '@@manufacturer', 'samsung', '@@model', 'SM-F956N', '@@release', '15', '@@sdk', '35',
    '@@screen', 'Physical size: 1856x2160', '@@density', 'Physical density: 374',
    '@@battery', '  AC powered: false', '  USB powered: true', '  status: 2', '  level: 87', '  temperature: 291',
    '@@route', 'default via 192.168.0.1 dev wlan0 proto dhcp src 192.168.0.23 metric 100',
    '@@wlan', '24: wlan0    inet 192.168.0.23/24 brd 192.168.0.255 scope global wlan0',
    '@@uptime', '12345.67 45678.90', '@@mem', 'MemTotal:       11534336 kB', 'MemAvailable:    4194304 kB',
    '@@storage', '/dev/block/dm-59  230G  120G  110G  53% /data',
  ].join('\n');
  const info = adb.parseDeviceInfo(stdout);
  assert.equal(info.model, 'SM-F956N');
  assert.equal(info.release, '15');
  assert.equal(info.sdk, '35');
  assert.equal(info.screen, '1856x2160');
  assert.equal(info.density, '374');
  assert.equal(info.batteryLevel, 87);
  assert.equal(info.batteryStatus, 'charging');
  assert.equal(info.batteryTemp, 29.1);
  assert.equal(info.charging, true);
  assert.equal(info.ip, '192.168.0.23');
  assert.equal(info.uptimeSec, 12345);
  assert.equal(info.memTotalKb, 11534336);
  assert.equal(info.storage, '120G / 230G (53%)');
});

test('parsePackages strips prefix and sorts', () => {
  assert.deepEqual(adb.parsePackages('package:com.b\npackage:com.a\r\njunk\n'), ['com.a', 'com.b']);
});

test('parseLs handles toybox ls -lA output with dirs, links, spaces and denied entries', () => {
  const out = adb.parseLs([
    'total 48',
    'drwxrwx--- 2 root sdcard_rw 4096 2024-01-01 12:00 Alarms',
    '-rw-rw---- 1 root sdcard_rw 1234 2024-02-03 08:15 a b.txt',
    'lrwxrwxrwx 1 root root 21 2024-01-01 12:00 sdcard -> /storage/self/primary',
    'crw-rw-rw- 1 root root 1, 3 2024-01-01 12:00 null',
    'ls: ./secret: Permission denied',
  ].join('\n'));
  assert.equal(out[0].name, 'Alarms');
  assert.equal(out[0].type, 'dir');
  assert.equal(out[1].type, 'link');
  assert.equal(out[1].target, '/storage/self/primary');
  const file = out.find((e) => e.name === 'a b.txt');
  assert.equal(file.size, 1234);
  assert.equal(file.mtime, '2024-02-03 08:15');
  assert.ok(out.find((e) => e.name === 'null'));
  assert.equal(out.find((e) => e.name === 'secret').error, 'denied');
});

test('parseForwardList and parseMdns', () => {
  const f = adb.parseForwardList('R3CX70BDDFT tcp:8080 tcp:8080\nemulator-5554 tcp:9000 localabstract:chrome_devtools_remote\n');
  assert.equal(f.length, 2);
  assert.deepEqual(f[1], { serial: 'emulator-5554', local: 'tcp:9000', remote: 'localabstract:chrome_devtools_remote' });
  const m = adb.parseMdns('List of discovered mdns services\nadb-R3CX-cB8XvT\t_adb-tls-connect._tcp\t192.168.0.23:37123\nadb-R3CX-abc\t_adb-tls-pairing._tcp\t192.168.0.23:41111\n');
  assert.equal(m.length, 2);
  assert.equal(m[0].kind, 'connect');
  assert.equal(m[1].kind, 'pairing');
  assert.equal(m[1].address, '192.168.0.23:41111');
});

test('normalizeHost and shellQuote', () => {
  assert.equal(adb.normalizeHost('192.168.0.5', 5555), '192.168.0.5:5555');
  assert.equal(adb.normalizeHost(' 192.168.0.5:4444 ', 5555), '192.168.0.5:4444');
  assert.equal(adb.normalizeHost('', 5555), '');
  assert.equal(adb.shellQuote("it's"), "'it'\\''s'");
});

test('logcat parseLine parses threadtime and markers', () => {
  const e = logcat.parseLine('09-20 08:12:33.123  1234  5678 W ActivityManager: Start proc 123:com.example/u0a1');
  assert.equal(e.level, 'W');
  assert.equal(e.pid, 1234);
  assert.equal(e.tid, 5678);
  assert.equal(e.tag, 'ActivityManager');
  assert.equal(e.msg, 'Start proc 123:com.example/u0a1');
  const m = logcat.parseLine('--------- beginning of main');
  assert.equal(m.marker, true);
  const u = logcat.parseLine('garbage line');
  assert.equal(u.unparsed, true);
});

test('logcat session assembles chunks, applies filters and caps buffer', () => {
  const changes = [];
  const lc = logcat.create({ onChange: (k) => changes.push(k), capacity: 5 });
  lc.session.processId = 'p1';
  lc.handleOutput({ process_id: 'p1', stream: 'stdout', data: '09-20 08:12:33.123  1  2 I TagA: hello\r\n09-20 08:12:33.124  1  2 E TagB: wor' });
  assert.equal(lc.session.lines.length, 1);
  lc.handleOutput({ process_id: 'p1', stream: 'stdout', data: 'ld\n09-20 08:12:33.125  9  9 D TagA: dbg\n' });
  assert.equal(lc.session.lines.length, 3);
  assert.equal(lc.session.lines[1].msg, 'world');
  assert.equal(lc.handleOutput({ process_id: 'other', stream: 'stdout', data: 'x\n' }), false);
  lc.setFilter({ minLevel: 'I' });
  assert.deepEqual(lc.visible().map((e) => e.tag), ['TagA', 'TagB']);
  lc.setFilter({ minLevel: 'V', text: 'WORLD' });
  assert.equal(lc.visible().length, 1);
  lc.clearFilters();
  lc.toggleExcludeTag('TagA');
  assert.equal(lc.visible().length, 1);
  lc.clearFilters();
  lc.setFilter({ pid: 9 });
  assert.equal(lc.visible()[0].msg, 'dbg');
  lc.clearFilters();
  for (let i = 0; i < 10; i++) lc.push('09-20 08:12:34.000  1  2 V T: line' + i + '\n');
  assert.equal(lc.session.lines.length, 5);
  assert.equal(lc.session.dropped, 8);
  assert.equal(lc.session.counts.V, 10);
  assert.ok(changes.includes('data') && changes.includes('filter'));
  assert.equal(lc.handleExited({ process_id: 'p1', exit_code: 0 }), true);
  assert.equal(lc.session.running, false);
});

test('text width helpers treat CJK as double width and keep ANSI', () => {
  assert.equal(text.stringWidth('한글ab'), 6);
  assert.equal(text.stringWidth('\x1b[1m한\x1b[0m'), 2);
  assert.equal(text.truncate('한글abc', 4, '…'), '한…');
  assert.equal(text.fit('ab', 4), 'ab  ');
  assert.equal(text.sanitize('a\tb\x07c'), 'a    bc');
  assert.equal(text.formatBytes(2048), '2.0K');
});

test('config.sanitize rejects wrong versions and bad fields', () => {
  assert.equal(config.sanitize({ version: 99, adbPath: 'x' }).adbPath, '');
  const ok = config.sanitize({ version: config.VERSION, adbPath: 'C:/adb.exe', minLevel: 'Z', recentHosts: ['a', 1], filesPath: 'relative', logcatBuffers: ['main', 'bogus'] });
  assert.equal(ok.adbPath, 'C:/adb.exe');
  assert.equal(ok.minLevel, 'V');
  assert.deepEqual(ok.recentHosts, ['a']);
  assert.equal(ok.filesPath, '/sdcard');
  assert.deepEqual(ok.logcatBuffers, ['main']);
});

test('every t() key used in source exists in en.json and ko.json keys match', () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
  const ko = JSON.parse(fs.readFileSync(path.join(root, 'locale/ko.json'), 'utf8'));
  const enKeys = new Set(Object.keys(en));
  const koKeys = new Set(Object.keys(ko));
  for (const k of enKeys) assert.ok(koKeys.has(k), 'ko.json missing ' + k);
  for (const k of koKeys) assert.ok(enKeys.has(k), 'ko.json has extra key ' + k);
  const files = ['main.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => 'lib/' + f)];
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?:setStatus|fail|op)\('([a-z]+\.[A-Za-z]+)'/g)) used.add(m[1]);
  }
  const missing = Array.from(used).filter((k) => !k.endsWith('.') && !enKeys.has(k));
  assert.deepEqual(missing, [], 'missing en keys: ' + missing.join(', '));
  // 동적 접두사 키
  for (const l of ['V', 'D', 'I', 'W', 'E', 'F']) assert.ok(enKeys.has('level.' + l));
  for (const m of ['system', 'recovery', 'bootloader', 'fastboot', 'sideload', 'poweroff']) assert.ok(enKeys.has('reboot.' + m));
  for (const k of ['usb', 'tcp', 'wifi', 'emulator']) assert.ok(enKeys.has('ov.kind.' + k));
});
