/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotHomeFileConflict, paradisBotPermissionOptions, paradisBotSettingsAgents, paradisBotSettingsChange } from '../../common/paradisBotSettingsModel.js';

const BOT = { id: 'b', name: 'リリース係', agent: 'claude' as const, permissionId: undefined };
const SAME = { name: 'リリース係', agent: 'claude' as const, permissionId: undefined, role: '# リリース係\n' };

suite('Paradis bots settings', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('変更を update_bot と同じ形にし、エージェント・権限・役割だけ確かめる', () => {
		assert.deepStrictEqual([
			paradisBotSettingsChange(BOT, '# リリース係\n', SAME),
			paradisBotSettingsChange(BOT, '# リリース係\n', { ...SAME, name: ' 出荷係 ' }),
			paradisBotSettingsChange(BOT, '# リリース係\n', { ...SAME, permissionId: 'skip-permissions' }),
			paradisBotSettingsChange(BOT, '# リリース係\n', { ...SAME, role: '# 新しい役割\n' }),
			// エージェントを変えて、今の権限がそのエージェントに無ければ既定へ戻す
			paradisBotSettingsChange({ ...BOT, permissionId: 'skip-permissions' }, undefined, { ...SAME, agent: 'codex', permissionId: 'skip-permissions', role: undefined }),
			// 役割を読めていないときは役割を変えない
			paradisBotSettingsChange(BOT, undefined, { ...SAME, role: undefined }),
		], [
			undefined,
			{ botId: 'b', patch: { name: '出荷係' }, needsConfirmation: false },
			{ botId: 'b', patch: { permissionId: 'skip-permissions' }, needsConfirmation: true },
			{ botId: 'b', patch: {}, role: '# 新しい役割\n', needsConfirmation: true },
			{ botId: 'b', patch: { agent: 'codex', permissionId: null }, needsConfirmation: true },
			undefined,
		]);
	});

	test('選べるエージェントと権限、ファイルの書き換わりの判定', () => {
		assert.deepStrictEqual([
			paradisBotSettingsAgents('claude'),
			paradisBotSettingsAgents('opencode'),
			paradisBotPermissionOptions('claude').map(option => option.id),
			paradisBotHomeFileConflict('a', 'a'),
			paradisBotHomeFileConflict(undefined, ''),
			paradisBotHomeFileConflict('a', 'b'),
		], [['claude', 'codex'], ['claude', 'codex', 'opencode'], ['default', 'skip-permissions'], false, false, true]);
	});
});
