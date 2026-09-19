'use strict';
// lib/ansi.js — ANSI 헬퍼 + 시맨틱 컬러 토큰 [C1][C2]. UI 크롬은 16색만, 트루컬러는 hover 배경만.

const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  ESC, CSI,
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  italic: CSI + '3m',
  underline: CSI + '4m',
  inverse: CSI + '7m',
  noBoldDim: CSI + '22m',
  noItalic: CSI + '23m',
  noUnderline: CSI + '24m',
  noInverse: CSI + '27m',
  moveTo: (row, col) => CSI + row + ';' + col + 'H',
  fg: {
    black: CSI + '30m', red: CSI + '31m', green: CSI + '32m', yellow: CSI + '33m',
    blue: CSI + '34m', magenta: CSI + '35m', cyan: CSI + '36m', white: CSI + '37m',
    default: CSI + '39m', brightBlack: CSI + '90m', brightRed: CSI + '91m',
    brightGreen: CSI + '92m', brightYellow: CSI + '93m', brightBlue: CSI + '94m',
    brightMagenta: CSI + '95m', brightCyan: CSI + '96m', brightWhite: CSI + '97m',
  },
  bg: { default: CSI + '49m' },
};

const theme = {
  accent: ansi.fg.cyan,
  title: ansi.bold + ansi.fg.green,
  dim: ansi.dim,
  success: ansi.fg.green,
  warn: ansi.fg.yellow,
  error: ansi.fg.red,
  info: ansi.fg.blue,
  hoverBg: CSI + '48;2;58;58;70m',
  selBg: ansi.inverse,
  link: ansi.underline + ansi.fg.cyan,
  dangerHex: '#E06C75',
  warnHex: '#E5C07B',
  accentHex: '#3DDC84',
};

// logcat 레벨별 색 — 색 + 레벨 문자 이중 채널 [W18]
const levelColor = {
  V: ansi.fg.brightBlack,
  D: ansi.fg.blue,
  I: ansi.fg.green,
  W: ansi.fg.yellow,
  E: ansi.fg.red,
  F: ansi.bold + ansi.fg.red,
  S: ansi.fg.magenta,
};

function styleText(text, o = {}) {
  let open = '', close = '';
  if (o.bold) open += ansi.bold;
  if (o.dim) open += ansi.dim;
  if (o.bold || o.dim) close = ansi.noBoldDim + close;
  if (o.italic) { open += ansi.italic; close = ansi.noItalic + close; }
  if (o.underline) { open += ansi.underline; close = ansi.noUnderline + close; }
  if (o.inverse) { open += ansi.inverse; close = ansi.noInverse + close; }
  if (o.fg) { open += o.fg; close = CSI + '39m' + close; }
  return open + text + close;
}

module.exports = { ansi, theme, levelColor, styleText };
