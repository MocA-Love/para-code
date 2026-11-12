// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardPersisted } from '@engine/paradisTaskBoardEngine.js';
import { Store, StoreBusyError, storeOwner } from '../server/store.js';

describe('Store', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

	test('a closed store keeps the last state even if the old engine asks to save again', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-store-'));
		dirs.push(dir);
		const store = new Store(dir);
		const state = (n: number) => ({ version: 1, tasks: [], marker: n }) as unknown as ITaskBoardPersisted;
		store.scheduleSave(() => state(1));
		await store.close();
		store.scheduleSave(() => state(2));
		await store.flush();
		expect(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).marker).toBe(1);
	});
	test('a ledger that is not valid JSON is moved aside, but one that cannot be read is left in place and the error is raised', async () => {
		const broken = mkdtempSync(path.join(os.tmpdir(), 'tb-store-'));
		const unreadable = mkdtempSync(path.join(os.tmpdir(), 'tb-store-'));
		dirs.push(broken, unreadable);
		writeFileSync(path.join(broken, 'state.json'), '{"version":');
		// 読めない台帳（ディレクトリにして EISDIR を起こす。権限で作ると root では読めてしまう）
		mkdirSync(path.join(unreadable, 'state.json'));
		const fromBroken = await new Store(broken).loadState();
		const fromUnreadable = await new Store(unreadable).loadState().then(() => 'loaded', (err: NodeJS.ErrnoException) => err.code);
		expect({
			fromBroken,
			brokenFiles: readdirSync(broken).map(name => name.replace(/\d+$/, '')),
			fromUnreadable,
			unreadableFiles: readdirSync(unreadable),
		}).toEqual({ fromBroken: undefined, brokenFiles: ['state.json.broken-'], fromUnreadable: 'EISDIR', unreadableFiles: ['state.json'] });
	});
	test('only one board opens a ledger: a live owner refuses, a dead owner is taken over, and closing lets go', async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), 'tb-store-'));
		dirs.push(dir);
		// 生きている別のボード（親のプロセスを持ち主に見立てる）
		writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.ppid, mode: 'standalone', at: 1 }));
		const refused = await new Store(dir).lock('embedded').then(() => false, err => err instanceof StoreBusyError);
		// 終わったボードの印は引き継ぐ
		writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 999_999_999, mode: 'standalone', at: 1 }));
		const store = new Store(dir);
		await store.lock('embedded');
		const mine = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')).pid === process.pid;
		const seenByOthers = await storeOwner(dir);
		await store.close();
		expect({ refused, mine, seenByOthers, released: existsSync(path.join(dir, 'owner.json')) }).toEqual({ refused: true, mine: true, seenByOthers: undefined, released: false });
	});
});
