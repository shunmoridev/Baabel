/// <reference lib="webworker" />
import { execWasm, friendlyTrap } from './exec';
import { setLocale, type Locale } from '../i18n';

export type WorkerRequest = { wasm: Uint8Array; input: Uint8Array; locale: Locale };
export type WorkerMessage =
  | { type: 'out'; bytes: Uint8Array }
  | { type: 'done'; instantiateMs: number; runMs: number; ptr: number; tape: Uint8Array }
  | { type: 'error'; message: string };

const post = (m: WorkerMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  setLocale(e.data.locale);
  try {
    const r = await execWasm(e.data.wasm, e.data.input, (bytes) => post({ type: 'out', bytes }));
    post({ type: 'done', ...r });
  } catch (err) {
    post({ type: 'error', message: friendlyTrap(err) });
  }
};
