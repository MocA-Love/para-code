/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotHomeFileConflict, paradisBotPermissionOptions, paradisBotSettingsAgents, paradisBotSettingsChange, paradisBotSettingsRebase, paradisBotHomeFileDiff, paradisBotMemorySnapshotCount, paradisBotRoleOverflow, paradisBotUndoTidyLines } from '../../common/paradisBotSettingsModel.js';

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

	test('台帳がほかで変わったら、手を付けていない欄だけ合わせ、書き換えていた欄は残して挙げる', () => {
		const base = { name: 'リリース係', agent: 'claude' as const, permissionId: undefined };
		const bot = { name: '出荷係', agent: 'codex' as const, permissionId: 'auto' };
		assert.deepStrictEqual([
			paradisBotSettingsRebase(base, { ...base, role: 'r' }, bot),
			paradisBotSettingsRebase(base, { ...base, name: '自分の名前', role: 'r' }, bot),
			paradisBotSettingsRebase(base, { ...base, name: '出荷係', role: 'r' }, bot),
			paradisBotSettingsRebase(base, { ...base, name: '自分の名前', role: 'r' }, base).changedElsewhere,
		], [
			{ base: bot, draft: { ...bot, role: 'r' }, changedElsewhere: [] },
			{ base: bot, draft: { ...bot, name: '自分の名前', role: 'r' }, changedElsewhere: ['name'] },
			{ base: bot, draft: { ...bot, role: 'r' }, changedElsewhere: [] },
			[],
		]);
	});

	test('開いた後に書き換わった記憶の差分と、役割の上限を超えた文字数', () => {
		assert.deepStrictEqual([
			paradisBotHomeFileDiff('# Memory\n- a\n- b', '# Memory\n- b\n- c'),
			paradisBotRoleOverflow('x'.repeat(4000)),
			paradisBotRoleOverflow('x'.repeat(4003)),
			paradisBotRoleOverflow(undefined),
		], [
			[{ kind: 'same', text: '# Memory' }, { kind: 'removed', text: '- a' }, { kind: 'same', text: '- b' }, { kind: 'added', text: '- c' }],
			0,
			3,
			0,
		]);
	});

	test('写しの件数の文と、取り消しの結果の行', () => {
		assert.deepStrictEqual([
			paradisBotMemorySnapshotCount({ takenAt: 1, files: 4, total: 4, partial: false }),
			paradisBotMemorySnapshotCount({ takenAt: 1, files: 200, total: 250, partial: true }),
			paradisBotUndoTidyLines({ restored: ['MEMORY.md', 'memory/a.md'], added: [], takenAt: 5, skipped: [] }, at => `t${at}`),
		], [
			'4 件',
			'250 件中 200 件だけ写しました',
			[{ text: 't5 の写しに戻しました（2 件）。', attention: false }],
		]);
	});
});
