// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	applyReportedPcName,
	loadPairedPcs,
	nextFallbackPcName,
	parseScopedKeys,
	sanitizePcName,
	savePairedPcs,
	scopedKeysFor,
	withScopedKeys,
	FALLBACK_PC_NAME,
	LEGACY_CREDENTIALS_KEY,
	PCS_KEY,
	type PairedPc,
} from './pcs.js';
import type { KeyStore } from './store.js';

class MemoryKeyStore implements KeyStore {
	readonly map = new Map<string, string>();
	async getItem(k: string) { return this.map.get(k) ?? null; }
	async setItem(k: string, v: string) { this.map.set(k, v); }
	async deleteItem(k: string) { this.map.delete(k); }
}

function pc(id: string, name: string, renamed = false): PairedPc {
	return {
		id,
		name,
		renamed,
		addedAt: 1,
		creds: {
			relayUrl: 'wss://relay.example',
			deviceId: id,
			mobileId: 'AAAAAAAAAAAAAAAAAAAAAA',
			mobileToken: 'token',
			pcPublicKey: new Uint8Array(32).fill(7),
		},
	};
}

describe('paired PC ledger', () => {
	it('saves and reloads the ledger unchanged', async () => {
		const keyStore = new MemoryKeyStore();
		await savePairedPcs(keyStore, [pc('a', 'MacBook'), pc('b', 'Studio', true)]);
		const loaded = await loadPairedPcs(keyStore);
		expect(loaded.migratedFromSinglePc).toBe(false);
		expect(loaded.pcs.map(entry => [entry.id, entry.name, entry.renamed, entry.creds.deviceId, [...entry.creds.pcPublicKey].length])).toEqual([
			['a', 'MacBook', false, 'a', 32],
			['b', 'Studio', true, 'b', 32],
		]);
	});

	it('migrates the single-PC credentials of older versions into the ledger', async () => {
		const keyStore = new MemoryKeyStore();
		keyStore.map.set(LEGACY_CREDENTIALS_KEY, JSON.stringify({
			relayUrl: 'wss://relay.example',
			deviceId: 'legacy-device',
			mobileId: 'AAAAAAAAAAAAAAAAAAAAAA',
			mobileToken: 'token',
			pcPublicKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
		}));
		const loaded = await loadPairedPcs(keyStore);
		expect(loaded.migratedFromSinglePc).toBe(true);
		expect(loaded.pcs.map(entry => [entry.id, entry.name])).toEqual([['legacy-device', FALLBACK_PC_NAME]]);
	});

	it('returns nothing when neither the ledger nor legacy credentials exist', async () => {
		expect(await loadPairedPcs(new MemoryKeyStore())).toEqual({ pcs: [], migratedFromSinglePc: false, dropped: 0 });
	});

	it('skips broken entries instead of failing the whole ledger', async () => {
		const keyStore = new MemoryKeyStore();
		keyStore.map.set(PCS_KEY, JSON.stringify([{ id: 'broken' }, { ...pc('ok', 'Fine'), pcPublicKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc', relayUrl: 'wss://r', deviceId: 'ok', mobileId: 'm', mobileToken: 't' }]));
		const loaded = await loadPairedPcs(keyStore);
		expect(loaded.pcs.map(entry => entry.id)).toEqual(['ok']);
		// 落とした件数を呼び出し側へ伝える（そのまま保存し直すと健全なぶんまで消える）。
		expect(loaded.dropped).toBe(1);
	});
});

describe('PC names', () => {
	it('numbers the fallback name so several unnamed PCs stay distinguishable', () => {
		expect(nextFallbackPcName([])).toBe(FALLBACK_PC_NAME);
		expect(nextFallbackPcName([pc('a', FALLBACK_PC_NAME)])).toBe(`${FALLBACK_PC_NAME} 2`);
		expect(nextFallbackPcName([pc('a', FALLBACK_PC_NAME), pc('b', `${FALLBACK_PC_NAME} 2`)])).toBe(`${FALLBACK_PC_NAME} 3`);
	});

	it('keeps only what can be shown, and never lets a name masquerade as another PC', () => {
		expect(sanitizePcName('  MacBook Pro  ')).toBe('MacBook Pro');
		// 制御文字・ゼロ幅・双方向制御文字（表示を偽装できる）は落とす。
		expect(sanitizePcName('Mac\u202eBook\u200b')).toBe('MacBook');
		expect(sanitizePcName('a\nb')).toBe('ab');
		expect(sanitizePcName('x'.repeat(200))?.length).toBe(64);
		// PCが送ってくるとは限らない形も受け取る。
		expect(sanitizePcName(123)).toBeUndefined();
		expect(sanitizePcName(undefined)).toBeUndefined();
		expect(sanitizePcName('\u200b\u200b')).toBeUndefined();
	});

	it('adopts the name reported by the PC, but never overwrites one the user picked', () => {
		const pcs = [pc('a', 'Para Code'), pc('b', 'My Studio', true)];
		expect(applyReportedPcName(pcs, 'a', 'MacBook Pro')[0]?.name).toBe('MacBook Pro');
		expect(applyReportedPcName(pcs, 'b', 'mac-studio.local')).toBe(pcs);
		expect(applyReportedPcName(pcs, 'a', '   ')).toBe(pcs);
		expect(applyReportedPcName(pcs, 'unknown', 'X')).toBe(pcs);
		// 文字列でない値を送ってくるPCがあっても落ちない。
		expect(applyReportedPcName(pcs, 'a', 123)).toBe(pcs);
	});
});

describe('per-PC local marks', () => {
	it('reads the single-PC array format as marks of the PC in use at the time', () => {
		expect(parseScopedKeys(JSON.stringify(['t1', 't2']), 'pc-a')).toEqual({ 'pc-a': ['t1', 't2'] });
		// 引き継ぎ先が分からない（1台もペアリングが残っていない）ときは捨てる。
		expect(parseScopedKeys(JSON.stringify(['t1']), undefined)).toEqual({});
	});

	it('survives a `__proto__` device id instead of losing the whole record', () => {
		const record = parseScopedKeys(JSON.stringify({ __proto__: ['t1'], 'pc-a': ['t2'] }), undefined);
		expect([...scopedKeysFor(record, 'pc-a')]).toEqual(['t2']);
		const next = withScopedKeys(record, '__proto__', new Set(['t9']));
		expect([...scopedKeysFor(next, '__proto__')]).toEqual(['t9']);
		expect([...scopedKeysFor(next, 'pc-a')]).toEqual(['t2']);
	});

	it('reads and writes the per-PC record', () => {
		const record = parseScopedKeys(JSON.stringify({ 'pc-a': ['t1'], 'pc-b': ['t2', 't3'], bad: 5 }), undefined);
		expect(record).toEqual({ 'pc-a': ['t1'], 'pc-b': ['t2', 't3'] });
		expect([...scopedKeysFor(record, 'pc-b')]).toEqual(['t2', 't3']);
		expect([...scopedKeysFor(record, 'missing')]).toEqual([]);
		expect(withScopedKeys(record, 'pc-a', new Set(['t9']))).toEqual({ 'pc-a': ['t9'], 'pc-b': ['t2', 't3'] });
		// 空になったPCは記録ごと消す（解除したPCの痕跡を残さない）。
		expect(withScopedKeys(record, 'pc-a', new Set())).toEqual({ 'pc-b': ['t2', 't3'] });
	});

	it('falls back to an empty record for missing or broken storage', () => {
		expect(parseScopedKeys(null, 'pc-a')).toEqual({});
		expect(parseScopedKeys('not json', 'pc-a')).toEqual({});
	});
});
