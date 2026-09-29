/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { URI } from '../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { paradisOriginalBackupUri, paradisRollingBackupUri, paradisWriteRollingBackupUri } from '../../common/paradisRollingFileBackupUri.js';

suite('paradisRollingFileBackupUri', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** SSH の接続先を模す。`links` はリンク → 実体、`symlinks` は symlink になっているパス。 */
	function fakeFileService(existing: readonly string[], links: Record<string, string>, symlinks: readonly string[] = []) {
		const copies: string[] = [];
		const service: Pick<IFileService, 'exists' | 'copy' | 'realpath' | 'stat'> = {
			exists: async resource => existing.includes(resource.path),
			realpath: async resource => URI.file(links[resource.path] ?? resource.path),
			stat: async resource => ({ isSymbolicLink: symlinks.includes(resource.path) }) as Awaited<ReturnType<IFileService['stat']>>,
			copy: async (source, target) => { copies.push(`${source.path} -> ${target.path}`); return undefined as unknown as Awaited<ReturnType<IFileService['copy']>>; },
		};
		return { service, copies };
	}

	test('copies the real file behind a symlinked config, skips a missing one, and refuses a symlinked backup', async () => {
		const settings = URI.file('/home/u/.claude/settings.json');
		const linked = fakeFileService([settings.path], { [settings.path]: '/home/u/dotfiles/claude-settings.json' });
		const linkedResult = await paradisWriteRollingBackupUri(linked.service, settings);

		const missing = fakeFileService([], {});
		const missingResult = await paradisWriteRollingBackupUri(missing.service, settings);

		const errors: unknown[] = [];
		const trap = fakeFileService([settings.path, paradisRollingBackupUri(settings).path], {}, [paradisRollingBackupUri(settings).path]);
		const trapResult = await paradisWriteRollingBackupUri(trap.service, settings, error => errors.push(error));

		const original = fakeFileService([settings.path], {});
		await paradisWriteRollingBackupUri(original.service, settings, undefined, { keepOriginal: true });
		const kept = fakeFileService([settings.path, paradisOriginalBackupUri(settings).path], {});
		await paradisWriteRollingBackupUri(kept.service, settings, undefined, { keepOriginal: true });

		assert.deepStrictEqual({
			original: original.copies,
			kept: kept.copies,
			linked: { result: linkedResult, copies: linked.copies },
			missing: { result: missingResult, copies: missing.copies },
			trap: { result: trapResult, copies: trap.copies, errors: errors.length },
		}, {
			original: ['/home/u/.claude/settings.json -> /home/u/.claude/settings.json.paradis.orig.bak', '/home/u/.claude/settings.json -> /home/u/.claude/settings.json.paradis.bak'],
			kept: ['/home/u/.claude/settings.json -> /home/u/.claude/settings.json.paradis.bak'],
			linked: { result: true, copies: ['/home/u/dotfiles/claude-settings.json -> /home/u/.claude/settings.json.paradis.bak'] },
			missing: { result: false, copies: [] },
			trap: { result: false, copies: [], errors: 1 },
		});
	});
});
