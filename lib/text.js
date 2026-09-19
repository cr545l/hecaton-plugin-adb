'use strict';
// lib/text.js — 표시 폭 유틸 [R4]. 모든 패딩/절단은 String.length 가 아니라 표시 폭 기준.

const SGR_RE = /\x1b\[[0-9;]*m/g;

function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

function stripAnsi(text) {
  return String(text == null ? '' : text).replace(SGR_RE, '');
}

function stringWidth(text) {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

function padEnd(text, width) {
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}

function padStart(text, width) {
  return ' '.repeat(Math.max(0, width - stringWidth(text))) + text;
}

// SGR 은 보존하고 표시 폭만 센다. ellipsis 를 주면 넘칠 때 마지막 칸을 그 문자로 바꾼다.
function truncate(text, maxWidth, ellipsis) {
  const source = String(text == null ? '' : text);
  if (maxWidth <= 0) return '';
  if (stringWidth(source) <= maxWidth) return source;
  const mark = ellipsis || '';
  const budget = Math.max(0, maxWidth - stringWidth(mark));
  let out = '';
  let width = 0;
  let i = 0;
  while (i < source.length) {
    if (source[i] === '\x1b') {
      const m = source.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(source.codePointAt(i));
    const cw = charWidth(ch);
    if (width + cw > budget) break;
    out += ch;
    width += cw;
    i += ch.length;
  }
  return out + mark;
}

function fit(text, width, ellipsis) {
  return padEnd(truncate(text, width, ellipsis), width);
}

// 제어 문자를 화면에 안전한 형태로 바꾼다 (탭 → 공백, 그 외 제어문자 제거).
function sanitize(text) {
  return String(text == null ? '' : text).replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(1) + 'G';
  if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + 'M';
  if (v >= 1024) return (v / 1024).toFixed(1) + 'K';
  return String(v) + 'B';
}

module.exports = { charWidth, stripAnsi, stringWidth, padEnd, padStart, truncate, fit, sanitize, formatBytes };
