// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ITaskBoardPersisted } from '@engine/paradisTaskBoardEngine.js';
import { Store } from '../server/store.js';

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
});
