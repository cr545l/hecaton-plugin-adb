'use strict';
// lib/screen.js — 프레임 빌더 + 렌더 코얼레싱 [R1][R2][R3]

const { ansi } = require('./ansi');
const { fit } = require('./text');

let renderFn = null;
let renderPending = false;
let needsFullClear = true;
let lastRows = 0, lastCols = 0;
let writer = (s) => process.stdout.write(s);

function init(fn, customWriter) { renderFn = fn; if (customWriter) writer = customWriter; }
function setWriter(fn) { writer = fn; }
function write(s) { writer(s); }

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setImmediate(() => {
    renderPending = false;
    if (renderFn) {
      try { renderFn(); } catch (e) { process.stderr.write('render error: ' + (e && e.stack || e) + '\n'); }
    }
  });
}

function invalidate() { needsFullClear = true; }

function beginFrame(cols, rows) {
  if (cols !== lastCols || rows !== lastRows) {
    needsFullClear = true;
    lastCols = cols; lastRows = rows;
  }
  const out = [ansi.hideCursor];
  if (needsFullClear) out.push(ansi.clear);
  const drawn = new Set();
  return {
    cols, rows, out,
    row(rowNo, text) {
      if (rowNo < 1 || rowNo > rows) return;
      drawn.add(rowNo);
      out.push(ansi.moveTo(rowNo, 1) + ansi.reset + fit(text, cols) + ansi.reset);
    },
    // 그리지 않은 행은 빈 줄로 덮어 이전 프레임 잔상을 없앤다 [R3]
    finish() {
      for (let r = 1; r <= rows; r++) {
        if (!drawn.has(r)) out.push(ansi.moveTo(r, 1) + ansi.reset + ' '.repeat(cols));
      }
    },
  };
}

function commit(frame) {
  needsFullClear = false;
  frame.finish();
  writer(frame.out.join(''));
}

module.exports = { init, setWriter, write, scheduleRender, invalidate, beginFrame, commit };
