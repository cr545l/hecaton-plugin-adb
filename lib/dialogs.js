'use strict';
// lib/dialogs.js — 다이얼로그 상관관계 관리자 [D1][D2][D3]
// dialog.show 결과는 dialog_resolved 로 오고 인스턴스 ID 가 없다 → 열기 전 태그·스냅샷을 기록한다.

const { t } = require('./i18n');

let pending = null;   // { tag, snapshot, onResolve }

async function open(tag, spec, onResolve, snapshot = null) {
  if (pending) return false;
  const buttons = (spec.buttons || []).map((b) => ({ ...b, id: tag + ':' + b.id }));
  pending = { tag, snapshot, onResolve };
  try {
    const r = await hecaton.dialog.show({ ...spec, buttons });
    if (r && r.ok === false) { pending = null; return false; }
    return true;
  } catch {
    pending = null;
    return false;
  }
}

function handleResolved(params) {
  if (!pending) return false;
  const p = pending;
  pending = null;
  const rawId = (params && (params.button_id || params.id)) || '';
  const prefix = p.tag + ':';
  const shortId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
  try { p.onResolve && p.onResolve(shortId, params && params.value, p.snapshot, params || {}); }
  catch (e) { process.stderr.write('dialog callback error: ' + (e && e.stack || e) + '\n'); }
  return true;
}

function isOpen() { return pending !== null; }
function cancelPending() { pending = null; }

// [D3] 파괴적 확인 — 기본 버튼은 항상 취소, 파괴 버튼은 style:'danger'
function confirmDanger(tag, title, message, confirmLabel, onConfirm, snapshot) {
  return open(tag, {
    type: 'message', title, message,
    buttons: [
      { id: 'confirm', label: confirmLabel, style: 'danger' },
      { id: 'cancel', label: t('dialog.cancel'), default: true },
    ],
  }, (btn, _v, snap) => { if (btn === 'confirm') onConfirm(snap); }, snapshot);
}

function confirm(tag, title, message, confirmLabel, onConfirm, snapshot) {
  return open(tag, {
    type: 'message', title, message,
    buttons: [
      { id: 'confirm', label: confirmLabel, default: true, style: 'success' },
      { id: 'cancel', label: t('dialog.cancel') },
    ],
  }, (btn, _v, snap) => { if (btn === 'confirm') onConfirm(snap); }, snapshot);
}

// 단발 텍스트 입력 [W14]. onSubmit(value, snapshot) 은 OK 일 때만 호출.
function input(tag, title, message, defaultValue, onSubmit, snapshot, okLabel) {
  return open(tag, {
    type: 'input', title, message,
    default_value: defaultValue || '',
    defaultValue: defaultValue || '',
    buttons: [
      { id: 'ok', label: okLabel || t('dialog.ok'), default: true, style: 'success' },
      { id: 'cancel', label: t('dialog.cancel') },
    ],
  }, (btn, value, snap) => { if (btn === 'ok') onSubmit(value == null ? '' : String(value), snap); }, snapshot);
}

function message(tag, title, text, onClose) {
  return open(tag, {
    type: 'message', title, message: text,
    buttons: [{ id: 'ok', label: t('dialog.ok'), default: true }],
  }, () => { if (onClose) onClose(); });
}

// 선택 다이얼로그 — onPick(index, item)
function select(tag, title, text, items, onPick, snapshot) {
  return open(tag, {
    type: 'select', title, message: text, items,
    buttons: [
      { id: 'ok', label: t('dialog.ok'), default: true },
      { id: 'cancel', label: t('dialog.cancel') },
    ],
  }, (btn, _v, snap, raw) => {
    if (btn !== 'ok') return;
    const idx = Number.isInteger(raw.selected_index) ? raw.selected_index : items.indexOf(raw.selected_item);
    if (idx >= 0) onPick(idx, items[idx], snap);
  }, snapshot);
}

module.exports = { open, handleResolved, isOpen, cancelPending, confirmDanger, confirm, input, message, select };
