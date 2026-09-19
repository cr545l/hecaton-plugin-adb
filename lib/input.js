'use strict';
// lib/input.js — 입력 정규화 [P1][P2][K4]. 모든 마우스 좌표는 1-based 셀.
//   handlers.onMove(row, col) / onClick(row, col, button, mods) / onRelease(row, col, button)
//   handlers.onScroll(deltaY, deltaX, mods)  양수 = 아래/오른쪽
//   handlers.onKey(name, raw)

let handlers = {};
let preciseMouseSeen = false;

function init(h) { handlers = h; }

function handleHostMouseEvent(p) {
  preciseMouseSeen = true;
  const row = (Number.isFinite(p.cell_y) ? Math.floor(p.cell_y) : 0) + 1;
  const col = (Number.isFinite(p.cell_x) ? Math.floor(p.cell_x) : 0) + 1;
  const mods = { ctrl: !!p.ctrl, shift: !!p.shift, alt: !!p.alt };
  if (p.type === 'motion') handlers.onMove && handlers.onMove(row, col);
  else if (p.type === 'press') handlers.onClick && handlers.onClick(row, col, p.button || 0, mods);
  else if (p.type === 'release') handlers.onRelease && handlers.onRelease(row, col, p.button || 0);
  else if (p.type === 'scroll') handlers.onScroll && handlers.onScroll(-(p.scroll_delta_y || 0), -(p.scroll_delta_x || 0), mods);
}

const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function handleStdin(data) {
  const str = data.toString();
  if (/\x1b\[</.test(str)) {
    if (!preciseMouseSeen) {
      let m;
      SGR_RE.lastIndex = 0;
      while ((m = SGR_RE.exec(str)) !== null) {
        const cb = parseInt(m[1], 10);
        const col = parseInt(m[2], 10);
        const row = parseInt(m[3], 10);
        const pressed = m[4] === 'M';
        const btn = cb & 3;
        const mods = { shift: !!(cb & 4), alt: !!(cb & 8), ctrl: !!(cb & 16) };
        const motion = !!(cb & 32);
        const wheel = !!(cb & 64);
        if (wheel) {
          const down = (cb & 1) !== 0;
          if (mods.shift) handlers.onScroll && handlers.onScroll(0, down ? 3 : -3, mods);
          else handlers.onScroll && handlers.onScroll(down ? 3 : -3, 0, mods);
        } else if (motion) {
          handlers.onMove && handlers.onMove(row, col);
        } else if (pressed) {
          handlers.onClick && handlers.onClick(row, col, btn, mods);
        } else {
          handlers.onRelease && handlers.onRelease(row, col, btn);
        }
      }
    }
    // 마우스 바이트가 섞인 청크에 키가 함께 올 수 있다 — 마우스 시퀀스를 제거한 나머지만 키로
    const rest = str.replace(SGR_RE, '');
    if (rest) handleKeyData(rest);
    return;
  }
  handleKeyData(str);
}

const ARROW = { A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End' };
const TILDE = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown',
  15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10', 23: 'F11', 24: 'F12' };
const FUNCTION = { P: 'F1', Q: 'F2', R: 'F3', S: 'F4' };

function handleKeyData(str) {
  if (!str) return;
  if (str === '\x1b[Z') { emitKey('Shift+Tab', str); return; }
  if (/^\x1b[^\x00-\x1f\x7f]$/u.test(str)) { emitKey('Alt+' + str.slice(1), str); return; }
  const esc = str.match(/^\x1b(\[|O)([0-9;]*)(.)$/);
  if (esc) {
    const params = esc[2].split(';');
    let mod = 0;
    if (params.length >= 2) mod = (parseInt(params[params.length - 1], 10) || 1) - 1;
    const mods = [];
    if (mod & 4) mods.push('Ctrl');
    if (mod & 1) mods.push('Shift');
    if (mod & 2) mods.push('Alt');
    let name = null;
    if (esc[3] === '~' && TILDE[params[0]]) name = TILDE[params[0]];
    else if (ARROW[esc[3]]) name = ARROW[esc[3]];
    else if (FUNCTION[esc[3]]) name = FUNCTION[esc[3]];
    if (name) emitKey(mods.length ? mods.join('+') + '+' + name : name, str);
    else emitKey('__unknown__', str);
    return;
  }
  if (str === '\x1b') { emitKey('Escape', str); return; }
  if (Array.from(str).length === 1) {
    const code = str.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) { emitKey('Enter', str); return; }
    if (code === 0x09) { emitKey('Tab', str); return; }
    if (code === 0x20) { emitKey('Space', str); return; }
    if (code === 0x7f || code === 0x08) { emitKey('Backspace', str); return; }
    if (code >= 0x01 && code <= 0x1a) { emitKey('Ctrl+' + String.fromCharCode(code + 0x40), str); return; }
    emitKey(str, str);
    return;
  }
  emitKey('__paste__', str);
}

function emitKey(name, raw) { handlers.onKey && handlers.onKey(name, raw); }

module.exports = { init, handleStdin, handleHostMouseEvent };
