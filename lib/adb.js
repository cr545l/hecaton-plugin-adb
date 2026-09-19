'use strict';
// lib/adb.js — adb 명령 실행 계층과 출력 파서.
//
// 모든 실행은 호스트 process.exec / process.spawn 을 거친다 (인자는 배열로 — 셸 문자열 조립 금지).
// 파서는 순수 함수라 테스트에서 직접 검증한다.

const DEFAULT_TIMEOUT = 15000;
const LONG_TIMEOUT = 180000;

const state = {
  path: 'adb',            // 현재 사용하는 adb 실행 파일
  version: null,          // { bridge, version, installed }
  platform: null,         // 'windows' | 'macos' | 'linux' | ...
};

function api() { return globalThis.hecaton; }

function setPath(p) { if (p) state.path = p; }
function getPath() { return state.path; }

// ---------- 실행 ----------

function describeFailure(r) {
  if (!r) return 'no response';
  const err = (r.stderr || '').trim() || (r.stdout || '').trim() || r.error || ('exit ' + r.exit_code);
  return String(err).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
}

// 결과: { ok, code, stdout, stderr, error }. ok 는 호스트 실행 성공 && exit 0.
async function exec(args, opts = {}) {
  const program = opts.program || state.path;
  let r;
  try {
    r = await api().process.exec({ program, args, timeout_ms: opts.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: '', error: String(e && e.message || e), denied: isDenied(e) };
  }
  if (!r) return { ok: false, code: -1, stdout: '', stderr: '', error: 'no response' };
  if (r.ok === false && r.exit_code === undefined) {
    return { ok: false, code: -1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || r.error_code || 'exec failed', denied: isDenied(r) };
  }
  const code = Number.isInteger(r.exit_code) ? r.exit_code : (r.ok ? 0 : 1);
  const stdout = normalizeNewlines(r.stdout || '');
  const stderr = normalizeNewlines(r.stderr || '');
  const ok = code === 0;
  return { ok, code, stdout, stderr, error: ok ? null : describeFailure({ stdout, stderr, exit_code: code }) };
}

function isDenied(value) {
  if (!value) return false;
  const code = value.error_code || value.code || '';
  if (code === 'access_denied') return true;
  return /access[_ ]denied|permission denied/i.test(String(value.error || value.message || ''));
}

function normalizeNewlines(s) { return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }

function deviceArgs(serial, rest) { return serial ? ['-s', serial, ...rest] : rest; }

async function shell(serial, command, opts = {}) {
  return exec(deviceArgs(serial, ['shell', command]), opts);
}

// ---------- adb 탐색 ----------

async function envValue(name) {
  try {
    const r = await api().env.get({ name });
    return r && r.value ? String(r.value) : '';
  } catch { return ''; }
}

async function getPlatform() {
  if (state.platform) return state.platform;
  try {
    const r = await api().sys.get_platform();
    state.platform = String((r && (r.platform || r.os)) || '').toLowerCase();
  } catch { state.platform = ''; }
  if (!state.platform) {
    const os = await envValue('HECA_OS');
    state.platform = os.toLowerCase();
  }
  return state.platform;
}

function isWindows(platform) { return /win/.test(platform || ''); }

function joinPath(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
}

async function candidatePaths(preferred) {
  const platform = await getPlatform();
  const win = isWindows(platform);
  const exe = win ? 'adb.exe' : 'adb';
  const list = [];
  if (preferred) list.push(preferred);
  list.push('adb');
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const v = await envValue(name);
    if (v) list.push(joinPath(v, 'platform-tools', exe));
  }
  let home = '';
  try { home = ((await api().env.get_home()) || {}).path || ''; } catch { /* ignore */ }
  if (win) {
    const local = await envValue('LOCALAPPDATA');
    if (local) list.push(joinPath(local, 'Android', 'Sdk', 'platform-tools', exe));
    if (home) list.push(joinPath(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe));
  } else if (/darwin|mac/.test(platform)) {
    if (home) list.push(joinPath(home, 'Library', 'Android', 'sdk', 'platform-tools', exe));
    list.push('/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  } else {
    if (home) list.push(joinPath(home, 'Android', 'Sdk', 'platform-tools', exe));
    list.push('/usr/bin/adb', '/usr/local/bin/adb');
  }
  return Array.from(new Set(list));
}

function parseVersion(stdout) {
  const out = { bridge: '', version: '', installed: '' };
  for (const line of String(stdout || '').split('\n')) {
    let m;
    if ((m = line.match(/Android Debug Bridge version\s+(\S+)/i))) out.bridge = m[1];
    else if ((m = line.match(/^Version\s+(\S+)/i))) out.version = m[1];
    else if ((m = line.match(/^Installed as\s+(.+)$/i))) out.installed = m[1].trim();
  }
  return out;
}

// 후보를 차례로 `adb version` 으로 시험한다. 성공하면 state.path 를 확정.
async function probe(preferred) {
  const candidates = await candidatePaths(preferred);
  let lastError = null;
  let denied = false;
  for (const p of candidates) {
    const r = await exec(['version'], { program: p, timeout: 8000 });
    if (r.denied) { denied = true; lastError = r.error; break; }
    if (r.ok && /Android Debug Bridge/i.test(r.stdout)) {
      state.path = p;
      state.version = parseVersion(r.stdout);
      return { ok: true, path: p, version: state.version };
    }
    lastError = r.error;
  }
  return { ok: false, error: lastError, denied, tried: candidates };
}

// ---------- 단말 ----------

// `adb devices -l` 파서
function parseDevices(stdout) {
  const devices = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^List of devices/i.test(line) || /^\*/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const stateWord = parts[1];
    const dev = { serial, state: stateWord, product: '', model: '', device: '', transportId: '' };
    for (const kv of parts.slice(2)) {
      const idx = kv.indexOf(':');
      if (idx < 0) continue;
      const k = kv.slice(0, idx), v = kv.slice(idx + 1);
      if (k === 'product') dev.product = v;
      else if (k === 'model') dev.model = v;
      else if (k === 'device') dev.device = v;
      else if (k === 'transport_id') dev.transportId = v;
    }
    dev.kind = classifySerial(serial);
    dev.displayName = (dev.model || dev.product || serial).replace(/_/g, ' ');
    devices.push(dev);
  }
  return devices;
}

function classifySerial(serial) {
  if (/^emulator-\d+$/.test(serial)) return 'emulator';
  if (/^adb-.*_adb-tls-connect\._tcp/.test(serial)) return 'wifi';
  if (/^\[?[0-9a-fA-F.:]+\]?:\d+$/.test(serial) || /^[\w.-]+:\d+$/.test(serial)) return 'tcp';
  return 'usb';
}

function isNetworkDevice(dev) { return dev && (dev.kind === 'tcp' || dev.kind === 'wifi'); }

async function listDevices() {
  const r = await exec(['devices', '-l'], { timeout: 10000 });
  if (!r.ok) return { ok: false, error: r.error, devices: [], raw: r };
  return { ok: true, devices: parseDevices(r.stdout), serverStarted: /daemon started successfully/i.test(r.stdout + r.stderr) };
}

// ---------- 단말 정보 ----------

const INFO_SCRIPT = [
  ['manufacturer', 'getprop ro.product.manufacturer'],
  ['brand', 'getprop ro.product.brand'],
  ['model', 'getprop ro.product.model'],
  ['device', 'getprop ro.product.device'],
  ['release', 'getprop ro.build.version.release'],
  ['sdk', 'getprop ro.build.version.sdk'],
  ['security', 'getprop ro.build.version.security_patch'],
  ['build', 'getprop ro.build.display.id'],
  ['serialno', 'getprop ro.serialno'],
  ['abi', 'getprop ro.product.cpu.abi'],
  ['screen', 'wm size 2>/dev/null'],
  ['density', 'wm density 2>/dev/null'],
  ['battery', 'dumpsys battery 2>/dev/null | grep -E "level|status|temperature|AC powered|USB powered"'],
  ['route', 'ip route 2>/dev/null'],
  ['wlan', 'ip -o -4 addr show 2>/dev/null | grep -E "wlan|eth"'],
  ['uptime', 'cat /proc/uptime 2>/dev/null'],
  ['mem', 'grep -E "MemTotal|MemAvailable" /proc/meminfo 2>/dev/null'],
  ['storage', 'df -h /data 2>/dev/null | tail -n 1'],
];

function buildInfoScript() {
  return INFO_SCRIPT.map(([k, cmd]) => 'echo "@@' + k + '"; ' + cmd).join('; ');
}

// "@@key" 마커로 구분된 출력을 {key: text} 로
function parseMarked(stdout) {
  const out = {};
  let key = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^@@(\w+)\s*$/);
    if (m) { key = m[1]; out[key] = ''; continue; }
    if (key) out[key] += (out[key] ? '\n' : '') + line;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

function parseDeviceInfo(stdout) {
  const raw = parseMarked(stdout);
  const info = {
    manufacturer: raw.manufacturer || '', brand: raw.brand || '', model: raw.model || '', device: raw.device || '',
    release: raw.release || '', sdk: raw.sdk || '', security: raw.security || '', build: raw.build || '',
    serialno: raw.serialno || '', abi: raw.abi || '',
    screen: '', density: '', batteryLevel: null, batteryStatus: '', batteryTemp: null, charging: false,
    ip: '', uptimeSec: null, memTotalKb: null, memAvailKb: null, storage: '',
  };
  let m;
  if ((m = (raw.screen || '').match(/(\d+x\d+)/))) info.screen = m[1];
  if ((m = (raw.density || '').match(/(\d+)/))) info.density = m[1];
  const battery = raw.battery || '';
  if ((m = battery.match(/level:\s*(\d+)/))) info.batteryLevel = Number(m[1]);
  if ((m = battery.match(/status:\s*(\d+)/))) info.batteryStatus = ({ 2: 'charging', 3: 'discharging', 4: 'not_charging', 5: 'full' })[m[1]] || 'unknown';
  if ((m = battery.match(/temperature:\s*(\d+)/))) info.batteryTemp = Number(m[1]) / 10;
  info.charging = /(AC|USB) powered:\s*true/.test(battery) || info.batteryStatus === 'charging';
  if ((m = (raw.wlan || '').match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/))) info.ip = m[1];
  if (!info.ip && (m = (raw.route || '').match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/))) info.ip = m[1];
  if ((m = (raw.uptime || '').match(/^([\d.]+)/))) info.uptimeSec = Math.floor(Number(m[1]));
  if ((m = (raw.mem || '').match(/MemTotal:\s*(\d+)/))) info.memTotalKb = Number(m[1]);
  if ((m = (raw.mem || '').match(/MemAvailable:\s*(\d+)/))) info.memAvailKb = Number(m[1]);
  if (raw.storage) {
    const cols = raw.storage.trim().split(/\s+/);
    if (cols.length >= 5) info.storage = cols[2] + ' / ' + cols[1] + ' (' + cols[4] + ')';
  }
  return info;
}

async function deviceInfo(serial) {
  const r = await shell(serial, buildInfoScript(), { timeout: 20000 });
  if (!r.ok && !r.stdout) return { ok: false, error: r.error };
  return { ok: true, info: parseDeviceInfo(r.stdout) };
}

// ---------- 패키지 ----------

function parsePackages(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^package:(\S+)$/);
    if (m) out.push(m[1]);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function listPackages(serial, { thirdPartyOnly = true } = {}) {
  const args = ['pm', 'list', 'packages'];
  if (thirdPartyOnly) args.push('-3');
  const r = await shell(serial, args.join(' '), { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.error, packages: [] };
  return { ok: true, packages: parsePackages(r.stdout) };
}

async function packageInfo(serial, pkg) {
  const script = 'dumpsys package ' + pkg + ' 2>/dev/null | grep -E "versionName|versionCode|firstInstallTime|lastUpdateTime|targetSdk|minSdk|codePath|dataDir|userId=" | head -n 12; echo "@@path"; pm path ' + pkg + ' 2>/dev/null';
  const r = await shell(serial, script, { timeout: 20000 });
  if (!r.ok && !r.stdout) return { ok: false, error: r.error };
  return { ok: true, text: r.stdout.trim() };
}

async function pmPath(serial, pkg) {
  const r = await shell(serial, 'pm path ' + pkg, { timeout: 10000 });
  if (!r.ok) return { ok: false, error: r.error };
  const paths = parsePackages(r.stdout);
  return { ok: paths.length > 0, paths, error: paths.length ? null : 'no path' };
}

async function pidof(serial, pkg) {
  const r = await shell(serial, 'pidof ' + pkg + ' 2>/dev/null || (ps -A 2>/dev/null | grep -w ' + pkg + ' | awk \'{print $2}\')', { timeout: 10000 });
  const m = (r.stdout || '').trim().match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const forceStop = (serial, pkg) => shell(serial, 'am force-stop ' + pkg);
const clearData = (serial, pkg) => shell(serial, 'pm clear ' + pkg, { timeout: 30000 });
const launchPackage = (serial, pkg) => shell(serial, 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1', { timeout: 20000 });
const uninstall = (serial, pkg, keepData) => exec(deviceArgs(serial, keepData ? ['uninstall', '-k', pkg] : ['uninstall', pkg]), { timeout: 60000 });
const install = (serial, localPath, { reinstall = true, grant = false } = {}) => {
  const args = ['install'];
  if (reinstall) args.push('-r');
  if (grant) args.push('-g');
  args.push(localPath);
  return exec(deviceArgs(serial, args), { timeout: LONG_TIMEOUT });
};

// ---------- 파일 ----------

// toybox `ls -lA` 파서. 예:
//   drwxrwx--- 2 root sdcard_rw 4096 2024-01-01 12:00 Alarms
//   -rw-rw---- 1 root sdcard_rw 1234 2024-01-01 12:00 a b.txt
//   lrwxrwxrwx 1 root root 21 2024-01-01 12:00 sdcard -> /storage/self/primary
function parseLs(stdout) {
  const entries = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^total\s+\d+/.test(line)) continue;
    const m = line.match(/^([\-dlcbps?])([rwxsStT\-]{9})[.+@]?\s+(\d+)\s+(\S+)\s+(\S+)\s+(?:(\d+)\s+|(\d+),\s*(\d+)\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s+[+-]\d{4})?)\s+(.+)$/);
    if (!m) {
      const denied = line.match(/^ls: (.+?): Permission denied/);
      if (denied) entries.push({ name: denied[1].split('/').pop(), type: 'file', size: null, mtime: '', error: 'denied' });
      continue;
    }
    const typeChar = m[1];
    let name = m[11];
    let target = null;
    if (typeChar === 'l') {
      const arrow = name.indexOf(' -> ');
      if (arrow >= 0) { target = name.slice(arrow + 4); name = name.slice(0, arrow); }
    }
    const type = typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'link' : 'file';
    entries.push({
      name, type, target,
      perms: typeChar + m[2],
      owner: m[4], group: m[5],
      size: m[6] !== undefined ? Number(m[6]) : null,
      mtime: m[9] + ' ' + m[10].slice(0, 5),
    });
  }
  entries.sort((a, b) => {
    const da = a.type !== 'file', db = b.type !== 'file';
    if (da !== db) return da ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

async function ls(serial, path) {
  // 끝에 / 를 붙여 심볼릭 링크(/sdcard 등)는 링크 자체가 아니라 내용을 나열하게 한다
  const target = path.endsWith('/') ? path : path + '/';
  const r = await shell(serial, 'ls -lA ' + shellQuote(target), { timeout: 20000 });
  if (!r.ok && !r.stdout) return { ok: false, error: r.error, entries: [] };
  return { ok: true, entries: parseLs(r.stdout), warning: r.ok ? null : r.error };
}

const pull = (serial, remote, local) => exec(deviceArgs(serial, ['pull', remote, local]), { timeout: LONG_TIMEOUT });
const push = (serial, local, remote) => exec(deviceArgs(serial, ['push', local, remote]), { timeout: LONG_TIMEOUT });
const rm = (serial, remote, recursive) => shell(serial, 'rm ' + (recursive ? '-rf ' : '-f ') + shellQuote(remote), { timeout: 60000 });
const mkdir = (serial, remote) => shell(serial, 'mkdir -p ' + shellQuote(remote));

async function screenshot(serial, localPath) {
  const remote = '/sdcard/hecaton_adb_screenshot.png';
  const cap = await shell(serial, 'screencap -p ' + remote, { timeout: 30000 });
  if (!cap.ok) return cap;
  const got = await pull(serial, remote, localPath);
  await rm(serial, remote, false);
  return got;
}

// ---------- 포워딩 ----------

// `adb forward --list`: "SERIAL tcp:8080 tcp:8080"
// `adb reverse --list`: "(reverse) tcp:8081 tcp:8081" 또는 "host-1 tcp:8081 tcp:8081"
function parseForwardList(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    out.push({ serial: parts[0], local: parts[1], remote: parts[2] });
  }
  return out;
}

async function listForwards(serial) {
  const r = await exec(deviceArgs(serial, ['forward', '--list']), { timeout: 10000 });
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  const items = parseForwardList(r.stdout).filter((f) => !serial || f.serial === serial);
  return { ok: true, items };
}

async function listReverses(serial) {
  const r = await exec(deviceArgs(serial, ['reverse', '--list']), { timeout: 10000 });
  if (!r.ok) return { ok: false, error: r.error, items: [] };
  return { ok: true, items: parseForwardList(r.stdout) };
}

const addForward = (serial, local, remote) => exec(deviceArgs(serial, ['forward', local, remote]));
const removeForward = (serial, local) => exec(deviceArgs(serial, ['forward', '--remove', local]));
const removeAllForwards = (serial) => exec(deviceArgs(serial, ['forward', '--remove-all']));
const addReverse = (serial, remote, local) => exec(deviceArgs(serial, ['reverse', remote, local]));
const removeReverse = (serial, remote) => exec(deviceArgs(serial, ['reverse', '--remove', remote]));
const removeAllReverses = (serial) => exec(deviceArgs(serial, ['reverse', '--remove-all']));

// ---------- 연결 / 서버 ----------

function normalizeHost(input, defaultPort) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/:\d+$/.test(s)) return s;
  return defaultPort ? s + ':' + defaultPort : s;
}

async function connect(host) {
  const r = await exec(['connect', host], { timeout: 20000 });
  // adb connect 는 실패해도 exit 0 을 돌려주는 경우가 있다 — 본문으로 판정한다
  const text = (r.stdout + '\n' + r.stderr).trim();
  const failed = /cannot connect|failed to|unable to|refused|timed out|No route/i.test(text);
  return { ok: r.ok && !failed, text, error: failed ? text.split('\n').pop() : r.error };
}

async function disconnect(serial) {
  const r = await exec(serial ? ['disconnect', serial] : ['disconnect'], { timeout: 10000 });
  return { ok: r.ok, text: (r.stdout + r.stderr).trim(), error: r.error };
}

async function pair(host, code) {
  const r = await exec(['pair', host, code], { timeout: 30000 });
  const text = (r.stdout + '\n' + r.stderr).trim();
  const failed = /failed|unable|error|refused|timed out/i.test(text) && !/Successfully paired/i.test(text);
  return { ok: r.ok && !failed, text, error: failed ? text.split('\n').pop() : r.error };
}

const tcpip = (serial, port) => exec(deviceArgs(serial, ['tcpip', String(port)]), { timeout: 15000 });
const usbMode = (serial) => exec(deviceArgs(serial, ['usb']), { timeout: 15000 });
const killServer = () => exec(['kill-server'], { timeout: 15000 });
const startServer = () => exec(['start-server'], { timeout: 30000 });
const reboot = (serial, mode) => exec(deviceArgs(serial, mode && mode !== 'system' ? ['reboot', mode] : ['reboot']), { timeout: 15000 });
const logcatClear = (serial) => exec(deviceArgs(serial, ['logcat', '-c']), { timeout: 10000 });
const remount = (serial) => exec(deviceArgs(serial, ['remount']), { timeout: 20000 });
const root = (serial) => exec(deviceArgs(serial, ['root']), { timeout: 20000 });
const unroot = (serial) => exec(deviceArgs(serial, ['unroot']), { timeout: 20000 });
const inputText = (serial, text) => shell(serial, 'input text ' + shellQuote(String(text).replace(/ /g, '%s')));
const keyevent = (serial, key) => shell(serial, 'input keyevent ' + key);

// `adb mdns services` — Android 11+ 무선 디버깅 단말 탐색
function parseMdns(stdout) {
  const out = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^List of discovered/i.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, service, addr] = parts;
    out.push({ name, service, address: addr, kind: /tls-pairing/.test(service) ? 'pairing' : /tls-connect/.test(service) ? 'connect' : 'adb' });
  }
  return out;
}

async function mdnsServices() {
  const r = await exec(['mdns', 'services'], { timeout: 10000 });
  if (!r.ok) return { ok: false, error: r.error, services: [] };
  return { ok: true, services: parseMdns(r.stdout) };
}

// 무선 디버깅 원클릭: IP 확인 → tcpip 5555 → connect ip:5555
async function enableWifi(serial, port = 5555, knownIp) {
  let ip = knownIp;
  if (!ip) {
    const r = await shell(serial, 'ip route 2>/dev/null; ip -o -4 addr show 2>/dev/null | grep -E "wlan|eth"', { timeout: 10000 });
    let m = (r.stdout || '').match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/) || (r.stdout || '').match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) ip = m[1];
  }
  if (!ip) return { ok: false, step: 'ip', error: 'no wifi ip' };
  const t = await tcpip(serial, port);
  if (!t.ok) return { ok: false, step: 'tcpip', error: t.error };
  await new Promise((res) => setTimeout(res, 1500));
  const c = await connect(ip + ':' + port);
  return { ok: c.ok, step: 'connect', host: ip + ':' + port, error: c.error, text: c.text };
}

// ---------- 스트리밍 (logcat 등) ----------

async function spawn(args) {
  try {
    const r = await api().process.spawn({ program: state.path, args });
    if (r && r.ok !== false && r.process_id) return { ok: true, processId: r.process_id };
    return { ok: false, error: (r && (r.error || r.error_code)) || 'spawn failed' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function kill(processId) {
  try { await api().process.kill({ process_id: processId }); } catch { /* ignore */ }
}

module.exports = {
  state, setPath, getPath, exec, shell, shellQuote, probe, parseVersion, candidatePaths, getPlatform, isWindows,
  parseDevices, classifySerial, isNetworkDevice, listDevices,
  buildInfoScript, parseMarked, parseDeviceInfo, deviceInfo,
  parsePackages, listPackages, packageInfo, pmPath, pidof, forceStop, clearData, launchPackage, uninstall, install,
  parseLs, ls, pull, push, rm, mkdir, screenshot,
  parseForwardList, listForwards, listReverses, addForward, removeForward, removeAllForwards, addReverse, removeReverse, removeAllReverses,
  normalizeHost, connect, disconnect, pair, tcpip, usbMode, killServer, startServer, reboot, logcatClear, remount, root, unroot, inputText, keyevent,
  parseMdns, mdnsServices, enableWifi,
  spawn, kill, isDenied,
};
