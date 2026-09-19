'use strict';
// lib/i18n.js — 호스트 언어를 따르는 문자열 조회 (API 1.11). 정본은 locale/en.json.

const CATALOGS = {
  en: require('../locale/en.json'),
  ko: require('../locale/ko.json'),
};
const FALLBACK = 'en';
const listeners = [];
let currentTag = FALLBACK;
let table = CATALOGS[FALLBACK];

function resolve(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return FALLBACK;
  const normalized = raw.replace(/_/g, '-').split('.')[0].toLowerCase();
  if (CATALOGS[normalized]) return normalized;
  const language = normalized.split('-')[0];
  return CATALOGS[language] ? language : FALLBACK;
}

function setLocale(tag) {
  const next = resolve(tag);
  if (next === currentTag) return false;
  currentTag = next;
  table = CATALOGS[next];
  for (const fn of listeners) { try { fn(next); } catch { /* ignore */ } }
  return true;
}

function t(key, args) {
  let value = table[key];
  if (value === undefined) value = CATALOGS[FALLBACK][key];
  if (value === undefined) return key;
  if (!args) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : whole);
}

function translations(key) {
  return Object.fromEntries(Object.entries(CATALOGS).map(([locale, catalog]) =>
    [locale, catalog[key] ?? CATALOGS[FALLBACK][key] ?? key]));
}

module.exports = {
  t, translations, setLocale, resolve,
  locale: () => currentTag,
  onChange: (fn) => { listeners.push(fn); },
  catalogs: CATALOGS,
};
