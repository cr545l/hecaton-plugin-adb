'use strict';
// lib/zones.js — 히트존 레지스트리 [P3][P5][P6]. 그리는 자리에서 등록하고 hover 판정을 즉시 돌려준다.

let zones = [];
let hoverRow = -1, hoverCol = -1;
let appliedCursor = 'default';
let appliedTooltip = '';
let cursorUnsupported = false;
let tooltipUnsupported = false;

function beginFrame() { zones = []; }

// opts: { label?, tip?, cursor?, data? } — label 은 컨텍스트 메뉴 첫 항목 [X2]
function add(row, colStart, colEnd, action, opts = {}) {
  zones.push({ row, colStart, colEnd, action, ...opts });
  return hoverRow === row && hoverCol >= colStart && hoverCol <= colEnd;
}

function addRect(rowStart, rowEnd, colStart, colEnd, action, opts = {}) {
  for (let r = rowStart; r <= rowEnd; r++) zones.push({ row: r, colStart, colEnd, action, ...opts });
  return hoverRow >= rowStart && hoverRow <= rowEnd && hoverCol >= colStart && hoverCol <= colEnd;
}

function hitTest(row, col) {
  for (const z of zones) {
    if (z.row === row && col >= z.colStart && col <= z.colEnd) return z;
  }
  return null;
}

function hoverPos() { return { row: hoverRow, col: hoverCol }; }
function isRowHover(row) { return hoverRow === row; }

// hover 존이 바뀌었을 때만 true — 호출자가 리렌더 여부를 결정한다
function setHover(row, col) {
  if (row === hoverRow && col === hoverCol) return false;
  const before = hitTest(hoverRow, hoverCol);
  hoverRow = row; hoverCol = col;
  const after = hitTest(row, col);
  return before !== after;
}

function clearHover() { hoverRow = -1; hoverCol = -1; }

function syncPointer() {
  const api = globalThis.hecaton;
  if (!api || !api.window) return;
  const z = hitTest(hoverRow, hoverCol);
  const wantCursor = z && z.action ? (z.cursor || 'pointer') : 'default';
  if (wantCursor !== appliedCursor && !cursorUnsupported) {
    appliedCursor = wantCursor;
    try { api.window.set_cursor({ cursor: wantCursor }).catch(() => { cursorUnsupported = true; }); }
    catch { cursorUnsupported = true; }
  }
  const wantTip = z && z.tip ? (typeof z.tip === 'function' ? z.tip() : z.tip) : '';
  if (wantTip !== appliedTooltip && !tooltipUnsupported) {
    appliedTooltip = wantTip;
    try { api.window.set_tooltip({ text: wantTip }).catch(() => { tooltipUnsupported = true; }); }
    catch { tooltipUnsupported = true; }
  }
}

function resetPointer() {
  const api = globalThis.hecaton;
  if (!api || !api.window) return;
  try { api.window.set_cursor({ cursor: 'default' }).catch(() => {}); } catch { /* ignore */ }
  try { api.window.set_tooltip({ text: '' }).catch(() => {}); } catch { /* ignore */ }
}

module.exports = { beginFrame, add, addRect, hitTest, setHover, clearHover, hoverPos, isRowHover, syncPointer, resetPointer };
