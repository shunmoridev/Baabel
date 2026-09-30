export type Locale = 'ja' | 'en' | 'zh';

export type SpecItem = ['ok' | 'ng' | 'note', string];

export interface Spec {
  /** Short chips shown under the JavaScript editor. */
  summary: string[];
  intro: string;
  sections: Array<{ title: string; items: SpecItem[] }>;
}
