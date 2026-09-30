// Minimal i18n: ja is the source catalog; en and zh must provide every key
// (enforced by the Messages type).

import { ja, jaSpec } from './ja';
import { en, enSpec } from './en';
import { zh, zhSpec } from './zh';
import type { Locale, Spec } from './types';

export type { Locale, Spec } from './types';
export type Messages = Record<keyof typeof ja, string>;
export type MessageKey = keyof typeof ja;

export const LOCALES: Array<{ id: Locale; label: string; htmlLang: string }> = [
  { id: 'ja', label: '日本語', htmlLang: 'ja' },
  { id: 'en', label: 'English', htmlLang: 'en' },
  { id: 'zh', label: '简体中文', htmlLang: 'zh-CN' },
];

const catalogs: Record<Locale, Messages> = { ja, en, zh };
const specs: Record<Locale, Spec> = { ja: jaSpec, en: enSpec, zh: zhSpec };

let current: Locale = 'ja';

export function setLocale(l: Locale) {
  current = l;
}

export function getLocale(): Locale {
  return current;
}

export function detectLocale(langs: readonly string[]): Locale {
  for (const l of langs) {
    const tag = l.toLowerCase();
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const msg = catalogs[current][key] ?? ja[key] ?? key;
  return msg.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function spec(): Spec {
  return specs[current];
}
