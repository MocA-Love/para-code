/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisCodexHookTrustStatus } from '../../common/paradisCodexHookTrust.js';
import { paradisCodexHookStateText, paradisCodexHookStatusMarkdown } from '../../browser/paradisCodexHookStatusTable.js';

suite('ParadisCodexHookStatusTable', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const status = (pending: number, managedCount: number, supported = true): IParadisCodexHookTrustStatus => ({
		codexHome: '/home/u/.codex',
		hooksPath: '/home/u/.codex/hooks.json',
		supported,
		managedCount,
		pending: Array.from({ length: pending }, (_, index) => ({ key: `k${index}`, eventName: index === 0 ? 'SessionStart' : 'Stop', trustStatus: 'untrusted', currentHash: 'h' })),
	});

	test('describes each home without its path and builds one table row per place', () => {
		const markdown = paradisCodexHookStatusMarkdown([
			{ place: 'この PC', path: '/home/u/.codex/hooks.json', state: paradisCodexHookStateText(status(2, 2)) },
			{ place: '接続先', path: '/home/u/.codex/hooks.json', state: paradisCodexHookStateText(status(0, 2)) },
			{ place: '経路', path: '', state: 'a|b' },
		]);
		assert.deepStrictEqual({ markdown, none: paradisCodexHookStateText(status(0, 0)), unknown: paradisCodexHookStateText(status(0, 0, false)).startsWith('信頼の状態を読めませんでした') }, {
			markdown: [
				'| 場所 | hooks.json | 状態 |',
				'| --- | --- | --- |',
				'| この PC | /home/u/.codex/hooks.json | 2 件中 2 件が未信頼（SessionStart, Stop） |',
				'| 接続先 | /home/u/.codex/hooks.json | 2 件すべて信頼済み |',
				'| 経路 |  | a\\|b |',
			].join('\n'),
			none: 'Para Code の hook はありません',
			unknown: true,
		});
	});
});
