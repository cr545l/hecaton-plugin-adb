'use strict';
// lib/widgets.js — 문자열 생성 + 존 등록을 한 함수에서 [W0]. 반환 { text, width }.

const { ansi, theme } = require('./ansi');
const { stringWidth, padEnd, truncate, fit } = require('./text');
const zones = require('./zones');
const { t } = require('./i18n');

// [W1] 버튼 `[ Label ]` — tone: default|success|error|accent, active: 켜진 토글 표시
function button(row, col, label, action, opts = {}) {
  const text = '[ ' + label + ' ]';
  const w = stringWidth(text);
  const hot = zones.add(row, col, col + w - 1, action, { label: opts.menuLabel || label, tip: opts.tip, data: opts.data });
  const toneColor = opts.tone === 'success' ? theme.success : opts.tone === 'error' ? theme.error
    : opts.tone === 'accent' ? theme.accent : opts.tone === 'warn' ? theme.warn : '';
  let s;
  if (opts.disabled) s = theme.dim + text + ansi.reset;
  else if (hot) s = theme.hoverBg + ansi.bold + toneColor + text + ansi.reset;
  else if (opts.active) s = ansi.bold + (toneColor || theme.accent) + text + ansi.reset;
  else if (toneColor) s = toneColor + text + ansi.reset;
  else s = theme.dim + '[ ' + ansi.reset + label + theme.dim + ' ]' + ansi.reset;
  return { text: s, width: w };
}

// [W2] 세그먼트 `[ A │ B ]`
function segmented(row, colStart, options, selectedIdx, actionPrefix, opts = {}) {
  let out = theme.dim + '[' + ansi.reset;
  let col = colStart + 1;
  for (let i = 0; i < options.length; i++) {
    const label = ' ' + options[i] + ' ';
    const w = stringWidth(label);
    const hot = zones.add(row, col, col + w - 1, actionPrefix + ':' + i, { label: t('widget.switchTo', { value: options[i] }), tip: opts.tip });
    if (i === selectedIdx) out += theme.accent + ansi.bold + label + ansi.reset;
    else if (hot) out += theme.hoverBg + label + ansi.reset;
    else out += theme.dim + label + ansi.reset;
    col += w;
    if (i < options.length - 1) { out += theme.dim + '│' + ansi.reset; col += 1; }
  }
  out += theme.dim + ']' + ansi.reset;
  return { text: out, width: col + 1 - colStart };
}

// [W8] 드롭다운 `Label: value ▾` — 클릭 시 앱이 menu.show 를 띄운다
function dropdown(row, col, label, value, action, opts = {}) {
  const display = (label ? label + ': ' : '') + value + ' ▾';
  const w = stringWidth(display);
  const hot = zones.add(row, col, col + w - 1, action, { label: opts.menuLabel || (label ? t('widget.change', { label }) : t('widget.changeValue')), tip: opts.tip });
  const bg = hot ? theme.hoverBg : '';
  const s = bg + (label ? theme.dim + label + ': ' + ansi.reset + bg : '') + ansi.bold + value + ansi.reset + bg + ' ' + theme.accent + '▾' + ansi.reset;
  return { text: s, width: w };
}

// [W18] 배지 `[OK]`
function badge(text, tone) {
  const c = tone === 'success' ? theme.success : tone === 'warn' ? theme.warn : tone === 'error' ? theme.error
    : tone === 'accent' ? theme.accent : theme.dim;
  return c + '[' + text + ']' + ansi.reset;
}

// [W19] 게이지
function gauge(percent, width, invertThreshold) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round(p / 100 * width);
  const good = invertThreshold ? p >= 50 : p <= 50;
  const mid = invertThreshold ? p >= 20 : p <= 80;
  const color = good ? theme.success : mid ? theme.warn : theme.error;
  return color + '█'.repeat(filled) + theme.dim + '░'.repeat(Math.max(0, width - filled)) + ansi.reset;
}

const SPIN = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇'];
function spinner() { return SPIN[Math.floor(Date.now() / 120) % SPIN.length]; }

// [W29] 섹션 헤더 `Title ─────`
function sectionHeader(title, width) {
  const head = ansi.bold + title + ansi.reset + ' ';
  const used = stringWidth(title) + 1;
  return head + theme.dim + '─'.repeat(Math.max(0, width - used)) + ansi.reset;
}

// [W17] 필드 행
function fieldRow(label, labelWidth, value, opts = {}) {
  const v = (value === null || value === undefined || value === '')
    ? theme.dim + '—' + ansi.reset
    : (opts.valueColor || '') + value + ansi.reset;
  return theme.dim + padEnd(label, labelWidth) + ansi.reset + ' ' + v;
}

// [W31] 탭 바 — 액션 'tab:<id>'
function tabBar(row, colStart, tabs, activeId, maxWidth) {
  let out = '', col = colStart;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const label = ' ' + tab.label + ' ';
    const w = stringWidth(label);
    if (maxWidth && col + w - colStart > maxWidth) break;
    const hot = zones.add(row, col, col + w - 1, 'tab:' + tab.id, { label: t('widget.goToTab', { name: tab.label }), tip: tab.tip });
    if (tab.id === activeId) out += theme.accent + ansi.bold + label + ansi.reset;
    else if (hot) out += theme.hoverBg + label + ansi.reset;
    else out += theme.dim + label + ansi.reset;
    col += w;
    if (i < tabs.length - 1) { out += theme.dim + '│' + ansi.reset; col += 1; }
  }
  return { text: out, width: col - colStart };
}

// [W36][K1] 힌트 바 — 각 힌트가 클릭 존. 폭을 넘치면 뒤쪽을 자른다.
function hintBar(row, colStart, hints, maxWidth) {
  let out = '', col = colStart;
  for (const h of hints) {
    const text = '[' + h.key + '] ' + h.label;
    const w = stringWidth(text);
    if (maxWidth && col + w - colStart > maxWidth) break;
    const hot = zones.add(row, col, col + w - 1, h.action, { label: h.label, tip: h.tip, data: h.data });
    if (hot) out += theme.hoverBg + ansi.bold + text + ansi.reset;
    else out += theme.accent + '[' + h.key + ']' + ansi.reset + ' ' + theme.dim + h.label + ansi.reset;
    out += '  ';
    col += w + 2;
  }
  return { text: out, width: col - colStart };
}

// 버튼 여러 개를 폭 안에서 줄바꿈해 배치. 반환: 사용한 행 수. draw(row, text) 로 행을 넘긴다.
function buttonFlow(startRow, colStart, maxWidth, buttons, draw, maxRows) {
  let row = startRow, col = colStart, line = '';
  let used = 0;
  const flush = () => { if (line) { draw(row, line); row++; used++; line = ''; col = colStart; } };
  for (const b of buttons) {
    const probeWidth = stringWidth('[ ' + b.label + ' ]');
    if (col > colStart && col + probeWidth - colStart > maxWidth) {
      flush();
      if (maxRows && used >= maxRows) return used;
    }
    const r = button(row, col, b.label, b.action, b);
    line += r.text + ' ';
    col += r.width + 1;
  }
  flush();
  return used;
}

module.exports = { button, segmented, dropdown, badge, gauge, spinner, sectionHeader, fieldRow, tabBar, hintBar, buttonFlow, fit, truncate };
