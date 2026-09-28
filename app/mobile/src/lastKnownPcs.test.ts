// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { deriveNotifyKey, generateIdentity, sealNotify, toBase64Url } from '@para/protocol';
import { LAST_KNOWN_MAX_NAME_LENGTH, LAST_KNOWN_MAX_SPACES, LastKnownPcWriter, buildLastKnownSnapshot, lastKnownSealKey, lastKnownLabelFor, lastKnownTotals, openLastKnownSnapshot, sealLastKnownSnapshot, type LastKnownPcStorage } from './lastKnownPcs.js';

function key(): Uint8Array {
	const mobile = generateIdentity();
	const pc = generateIdentity();
	return deriveNotifyKey(mobile.secretKey, pc.publicKey);
}

const source = {
	activeWs: 'w2',
	workspaces: [{ id: 'w1', name: 'repo' }, { id: 'w2', name: 'feature' }],
	terminals: [
		{ terminalKey: 't1', ws: 'w1', agent: true, agentStatus: 'permission', title: 'rm -rf secret' },
		{ terminalKey: 't2', ws: 'w1', agent: true, agentStatus: 'working', title: 'claude' },
		{ terminalKey: 't3', agent: true, agentStatus: 'review', title: 'no ws -> active' },
		{ terminalKey: 't4', ws: 'w1', title: 'zsh' },
		{ terminalKey: 't5', ws: 'w1', agent: true, agentStatus: 'working', title: 'archived' },
	],
};

describe('last known PC list (W2-25)', () => {
	test('keeps only space names and counts, never terminal titles', () => {
		const snapshot = buildLastKnownSnapshot('pc-1', source, terminalKey => terminalKey === 't5', 1_000);
		expect(snapshot).toEqual({
			pcId: 'pc-1',
			savedAt: 1_000,
			spaces: [
				{ name: 'repo', terminals: 4, waiting: 1, working: 1, review: 0, idle: 0 },
				{ name: 'feature', terminals: 1, waiting: 0, working: 0, review: 1, idle: 0 },
			],
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/secret|claude|zsh/);
		expect(lastKnownTotals(snapshot)).toEqual({ spaces: 2, agents: 3, waiting: 1, working: 1, review: 1, idle: 0 });
	});

	test('seals with the notify key and refuses other keys, other PCs and tampered data', () => {
		const k = key();
		const snapshot = buildLastKnownSnapshot('pc-1', source, () => false, 5_000);
		const sealed = sealLastKnownSnapshot(k, snapshot);
		expect(sealed).not.toContain('repo');
		expect(openLastKnownSnapshot(k, sealed, 'pc-1')).toEqual(snapshot);
		expect([
			openLastKnownSnapshot(key(), sealed, 'pc-1'),
			openLastKnownSnapshot(k, sealed, 'pc-2'),
			openLastKnownSnapshot(k, `${sealed.slice(0, -2)}AA`, 'pc-1'),
			openLastKnownSnapshot(k, toBase64Url(sealNotify(lastKnownSealKey(k), new TextEncoder().encode(JSON.stringify({ v: 1, purpose: 'other', ...snapshot })))), 'pc-1'),
			openLastKnownSnapshot(k, toBase64Url(sealNotify(lastKnownSealKey(k), new TextEncoder().encode(JSON.stringify({ v: 1, purpose: 'para.last-known-pc', pcId: 'pc-1', savedAt: 1, spaces: [{ name: 'x', terminals: -1, waiting: 0, working: 0, review: 0, idle: 0 }] })))), 'pc-1'),
			// 通知鍵そのもので封緘したもの（用途別の鍵を導いていない）は開けない
			openLastKnownSnapshot(k, toBase64Url(sealNotify(k, new TextEncoder().encode(JSON.stringify({ v: 1, purpose: 'para.last-known-pc', ...snapshot })))), 'pc-1'),
		]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('bounds the number of spaces and the name length', () => {
		const many = {
			activeWs: undefined,
			workspaces: Array.from({ length: LAST_KNOWN_MAX_SPACES + 5 }, (_, index) => ({ id: `w${index}`, name: 'n'.repeat(LAST_KNOWN_MAX_NAME_LENGTH + 10) })),
			terminals: [],
		};
		const snapshot = buildLastKnownSnapshot('pc', many, () => false, 1);
		expect([snapshot.spaces.length, snapshot.spaces[0]!.name.length]).toEqual([LAST_KNOWN_MAX_SPACES, LAST_KNOWN_MAX_NAME_LENGTH]);
	});

	test('labels the age like the rest of the app', () => {
		expect([lastKnownLabelFor('今'), lastKnownLabelFor('5分前'), lastKnownLabelFor('3時間前')])
			.toEqual(['最終確認 たった今', '最終確認 5分前', '最終確認 3時間前']);
	});

	test('the writer coalesces bursts, skips unchanged content and forgets on unpair', async () => {
		const writes: string[] = [];
		const removed: string[] = [];
		const storage: LastKnownPcStorage = {
			read: async () => null,
			write: async pcId => { writes.push(pcId); },
			remove: async pcId => { removed.push(pcId); },
		};
		const writer = new LastKnownPcWriter(storage, 1_000, 60_000);
		const k = key();
		const first = buildLastKnownSnapshot('pc-1', source, () => false, 1_000);
		writer.schedule(k, first);
		writer.schedule(k, { ...first, savedAt: 1_100 });
		await writer.flush();
		// 同じ中身・1分以内は書かない
		writer.schedule(k, { ...first, savedAt: 30_000 });
		await writer.flush();
		// 1分を過ぎたら時刻のために書き直す
		writer.schedule(k, { ...first, savedAt: 70_000 });
		await writer.flush();
		writer.schedule(k, { ...first, savedAt: 80_000, spaces: [] });
		await writer.forget('pc-1');
		await writer.flush();
		expect({ writes, removed }).toEqual({ writes: ['pc-1', 'pc-1'], removed: ['pc-1'] });
	});
});
