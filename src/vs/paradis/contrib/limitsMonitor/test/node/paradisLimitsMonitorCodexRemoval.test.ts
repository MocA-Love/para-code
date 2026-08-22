/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisLimitsMonitorService } from '../../node/paradisLimitsMonitorChannel.js';

suite('ParadisLimitsMonitorService Codex home removal', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-limits-removal-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createService(): ParadisLimitsMonitorService {
		return new ParadisLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);
	}

	function makeCodexHome(name: string, options: { readonly authJson?: boolean } = {}): string {
		const home = join(root, name);
		mkdirSync(home, { recursive: true });
		if (options.authJson !== false) {
			writeFileSync(join(home, 'auth.json'), '{}');
		}
		return home;
	}

	test('validates and removes a duplicate Codex home', async () => {
		const home = makeCodexHome('.codex-2');
		const service = createService();

		const target = await service.validateCodexHomeRemoval(home);
		assert.strictEqual(target.homePath, home);

		await service.removeCodexHome(home);
		assert.strictEqual(existsSync(home), false);
	});

	test('refuses to validate the default ~/.codex home (no index)', async () => {
		const home = makeCodexHome('.codex');
		const service = createService();

		await assert.rejects(service.validateCodexHomeRemoval(home), /not removable/);
		assert.strictEqual(existsSync(home), true);
	});

	test('refuses an index below 2', async () => {
		const home = makeCodexHome('.codex-1');
		const service = createService();

		await assert.rejects(service.validateCodexHomeRemoval(home), /not removable/);
	});

	test('refuses a home without auth.json', async () => {
		const home = makeCodexHome('.codex-2', { authJson: false });
		const service = createService();

		await assert.rejects(service.validateCodexHomeRemoval(home), /not removable/);
	});

	test('refuses a symlink standing in for the home directory', async () => {
		const real = makeCodexHome('.codex-real');
		const link = join(root, '.codex-2');
		symlinkSync(real, link, 'dir');
		const service = createService();

		await assert.rejects(service.validateCodexHomeRemoval(link), /not removable/);
		// the symlink itself, and what it points at, must both survive
		assert.strictEqual(existsSync(real), true);
	});

	test('refuses a path outside the home directory', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'paradis-limits-outside-'));
		try {
			mkdirSync(join(outside, '.codex-2'));
			writeFileSync(join(outside, '.codex-2', 'auth.json'), '{}');
			const service = createService();

			await assert.rejects(service.validateCodexHomeRemoval(join(outside, '.codex-2')), /not removable/);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test('rejects malformed input before touching the filesystem', async () => {
		const service = createService();

		await assert.rejects(service.validateCodexHomeRemoval(''), /invalid Codex home path/);
		await assert.rejects(service.validateCodexHomeRemoval('relative/.codex-2'), /invalid Codex home path/);
		await assert.rejects(service.validateCodexHomeRemoval('a'.repeat(5000)), /invalid Codex home path/);
	});

	test('removeCodexHome deletes permanently rather than leaving a trace behind', async () => {
		const home = makeCodexHome('.codex-3');
		mkdirSync(join(home, 'sessions'), { recursive: true });
		writeFileSync(join(home, 'sessions', 'log.jsonl'), 'line\n');
		const service = createService();

		await service.removeCodexHome(home);

		assert.strictEqual(existsSync(home), false);
		// a later validation must not find it either (discoverCodexHomes no longer lists it)
		await assert.rejects(service.validateCodexHomeRemoval(home), /not removable/);
	});
});
