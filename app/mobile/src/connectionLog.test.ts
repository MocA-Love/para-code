// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { CONNECTION_LOG_LIMIT, ConnectionLogBook, describeConnectionEntry, formatConnectionReport, parseConnectionLog, redactConnectionDetail, type ConnectionLogStorage } from './connectionLog.js';

function memoryStorage(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const writes: string[] = [];
	const storage: ConnectionLogStorage = {
		read: async pcId => files.get(pcId) ?? null,
		write: async (pcId, text) => { writes.push(pcId); files.set(pcId, text); },
		remove: async pcId => { files.delete(pcId); },
	};
	return { storage, files, writes };
}

describe('connection log (W2-22)', () => {
	test('redacts URLs, tokens, hex, addresses and emails from error text', () => {
		expect(redactConnectionDetail('failed wss://relay.example/device/abc?role=mobile  token AbCdEfGhIjKlMnOpQrStUvWxYz0123 key 0123456789abcdef at 192.168.1.20:443 mail a.b@example.com'))
			.toBe('failed <url> token <id> key <hex> at <ip> mail <email>');
		expect(redactConnectionDetail('x'.repeat(500)).length).toBeLessThanOrEqual(160);
	});

	test('keeps the last 200 entries per PC and coalesces writes', async () => {
		const { storage, files, writes } = memoryStorage();
		let now = 0;
		const book = new ConnectionLogBook(storage, () => ++now, 10_000);
		for (let i = 0; i < CONNECTION_LOG_LIMIT + 20; i++) {
			book.append('pc-1', { kind: 'closed', code: 1006 });
		}
		book.append('pc-2', { kind: 'network-change' });
		await book.flush();
		expect({ writes: writes.sort(), first: book.list('pc-1')[0]!.at, length: book.list('pc-1').length }).toEqual({ writes: ['pc-1', 'pc-2'], first: 21, length: CONNECTION_LOG_LIMIT });
		expect(parseConnectionLog(files.get('pc-1') ?? null).length).toBe(CONNECTION_LOG_LIMIT);
		await book.forget('pc-2');
		expect(files.has('pc-2')).toBe(false);
	});

	test('loads stored entries before the ones appended during startup and drops malformed items', async () => {
		const stored = JSON.stringify([
			{ kind: 'online', at: 1 },
			{ kind: 'unknown-kind', at: 2 },
			{ kind: 'closed', code: 4401, at: 3, detail: 'see https://relay.example/x' },
			'garbage',
		]);
		const { storage } = memoryStorage({ 'pc-1': stored });
		const book = new ConnectionLogBook(storage, () => 10, 10_000);
		book.append('pc-1', { kind: 'connecting', attempt: 0 });
		await book.load('pc-1');
		expect(book.list('pc-1')).toEqual([
			{ kind: 'online', at: 1 },
			{ kind: 'closed', code: 4401, at: 3, detail: 'see <url>' },
			{ kind: 'connecting', attempt: 0, at: 10 },
		]);
	});

	test('describes entries and builds a report without PC names', () => {
		expect([
			describeConnectionEntry({ kind: 'closed', code: 1006, at: 0 }),
			describeConnectionEntry({ kind: 'reconnect-scheduled', delayMs: 2_500, attempt: 2, at: 0 }),
			describeConnectionEntry({ kind: 'auth-rejected', code: 4404, at: 0 }),
		]).toEqual([
			'切断されました（コード 1006: 経路の異常（応答なしで切れた））',
			'2.5 秒後に再接続します',
			'リレーがこの端末の資格を拒みました（コード 4404: リレーに登録が無い）。PC とペアリングし直す必要があります',
		]);
		const report = formatConnectionReport({
			appVersion: '0.10.0',
			generatedAt: new Date(2026, 8, 29, 3, 4, 5).getTime(),
			diagnostics: [{ label: 'リレー', status: '正常', detail: '届いています（HTTP 404）' }],
			pcs: [{ summary: 'オフライン', entries: [{ kind: 'online', at: new Date(2026, 8, 29, 1, 2, 3).getTime() }] }],
		});
		expect(report.split('\n')).toEqual([
			'Para Code Mobile 接続の記録',
			'アプリ 0.10.0 / 作成 9/29 03:04:05',
			'',
			'## 診断',
			'- [正常] リレー: 届いています（HTTP 404）',
			'',
			'## PC 1（オフライン）',
			'9/29 01:02:03 つながりました（暗号の握手が完了）',
		]);
	});
});
