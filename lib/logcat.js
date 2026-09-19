'use strict';
// lib/logcat.js — `adb logcat -v threadtime` 스트리밍 세션과 필터.
//
// process.spawn 으로 띄우고 process_output 청크를 줄 단위로 조립한다. 청크는 줄 중간에서 끊길 수 있어
// 마지막 조각을 다음 청크와 잇는다. 버퍼는 링(최대 capacity)이고 필터 결과는 캐시한다.

const adb = require('./adb');

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const LEVEL_INDEX = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

// "09-20 08:12:33.123  1234  5678 I ActivityManager: Start proc ..."
const LINE_RE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?):\s?(.*)$/;

function parseLine(line) {
  const m = line.match(LINE_RE);
  if (!m) {
    if (/^-{5,} beginning of/.test(line)) return { raw: line, ts: '', pid: null, tid: null, level: 'S', tag: '', msg: line, marker: true };
    return { raw: line, ts: '', pid: null, tid: null, level: 'V', tag: '', msg: line, unparsed: true };
  }
  return { raw: line, ts: m[1], pid: Number(m[2]), tid: Number(m[3]), level: m[4], tag: m[5].trim(), msg: m[6] };
}

function create({ onChange, capacity = 5000 } = {}) {
  const session = {
    serial: null,
    processId: null,
    running: false,
    lines: [],
    dropped: 0,
    partial: '',
    error: null,
    exitInfo: null,
    counts: { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, S: 0 },
    filter: { minLevel: 'V', text: '', tag: '', pid: null, excludeTags: new Set(), pkgName: '' },
    _visible: null,
    _visibleKey: '',
  };

  function notify(kind) { if (onChange) onChange(kind); }

  function invalidate() { session._visible = null; }

  function resetBuffer() {
    session.lines = [];
    session.dropped = 0;
    session.partial = '';
    session.counts = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, S: 0 };
    invalidate();
  }

  async function start(serial, opts = {}) {
    await stop();
    resetBuffer();
    session.serial = serial;
    session.error = null;
    session.exitInfo = null;
    const args = ['-s', serial, 'logcat', '-v', 'threadtime'];
    if (opts.buffers) for (const b of opts.buffers) args.push('-b', b);
    if (opts.pid) args.push('--pid=' + opts.pid);
    const r = await adb.spawn(args);
    if (!r.ok) {
      session.error = r.error;
      session.running = false;
      notify('error');
      return false;
    }
    session.processId = r.processId;
    session.running = true;
    notify('start');
    return true;
  }

  async function stop() {
    if (session.processId) {
      const id = session.processId;
      session.processId = null;
      session.running = false;
      await adb.kill(id);
      notify('stop');
    }
  }

  function push(text) {
    const data = session.partial + String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = data.split('\n');
    session.partial = parts.pop();
    let added = 0;
    for (const line of parts) {
      if (!line) continue;
      const entry = parseLine(line);
      session.lines.push(entry);
      session.counts[entry.level] = (session.counts[entry.level] || 0) + 1;
      added++;
    }
    if (session.lines.length > capacity) {
      const extra = session.lines.length - capacity;
      session.lines.splice(0, extra);
      session.dropped += extra;
    }
    if (added) { invalidate(); notify('data'); }
    return added;
  }

  // 호스트 이벤트 라우팅 — 다른 프로세스의 이벤트는 무시
  function handleOutput(p) {
    if (!p || !session.processId || p.process_id !== session.processId) return false;
    if (p.stream === 'stderr') {
      const text = String(p.data || '').trim();
      if (text) session.error = text.split('\n').pop();
      notify('error');
      return true;
    }
    push(p.data || '');
    return true;
  }

  function handleExited(p) {
    if (!p || !session.processId || p.process_id !== session.processId) return false;
    session.processId = null;
    session.running = false;
    session.exitInfo = p;
    if (session.partial) { push('\n'); }
    notify('exit');
    return true;
  }

  function setFilter(patch) {
    Object.assign(session.filter, patch);
    invalidate();
    notify('filter');
  }

  function toggleExcludeTag(tag) {
    if (session.filter.excludeTags.has(tag)) session.filter.excludeTags.delete(tag);
    else session.filter.excludeTags.add(tag);
    invalidate();
    notify('filter');
  }

  function clearFilters() {
    session.filter = { minLevel: session.filter.minLevel, text: '', tag: '', pid: null, excludeTags: new Set(), pkgName: '' };
    invalidate();
    notify('filter');
  }

  function hasFilter() {
    const f = session.filter;
    return !!(f.text || f.tag || f.pid || f.excludeTags.size || f.minLevel !== 'V');
  }

  function matches(entry) {
    const f = session.filter;
    if (entry.marker) return f.minLevel === 'V' && !f.text && !f.tag && !f.pid;
    if (LEVEL_INDEX[entry.level] < LEVEL_INDEX[f.minLevel]) return false;
    if (f.pid && entry.pid !== f.pid) return false;
    if (f.tag && entry.tag.toLowerCase() !== f.tag.toLowerCase()) return false;
    if (f.excludeTags.size && f.excludeTags.has(entry.tag)) return false;
    if (f.text) {
      const needle = f.text.toLowerCase();
      if (entry.raw.toLowerCase().indexOf(needle) < 0) return false;
    }
    return true;
  }

  function visible() {
    if (session._visible) return session._visible;
    session._visible = hasFilter() ? session.lines.filter(matches) : session.lines;
    return session._visible;
  }

  function toText(entries) {
    return (entries || session.lines).map((e) => e.raw).join('\n') + '\n';
  }

  return {
    session, start, stop, push, handleOutput, handleExited,
    setFilter, toggleExcludeTag, clearFilters, hasFilter, visible, toText, resetBuffer,
    isRunning: () => session.running,
  };
}

module.exports = { create, parseLine, LEVELS, LEVEL_INDEX };
