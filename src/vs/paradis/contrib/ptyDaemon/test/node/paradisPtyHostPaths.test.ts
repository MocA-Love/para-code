/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 置き場所の決め方。**この機能の要約がここに出る**ので、性質を明示的に固定しておく。

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisPtyHostPaths } from '../../common/paradisPtyHostPaths.js';
import { paradisPtyDaemonPaths } from '../../common/paradisPtyDaemonPaths.js';

suite('ParadisPtyHostPaths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ビルドが違っても同じ場所。プロファイルが違えば別の場所', () => {
		const home = { stateDir: '/Users/example/Library/Application Support/Para Code', platform: 'darwin' as const };
		const other = { stateDir: '/Users/example/Library/Application Support/Para Code Insiders', platform: 'darwin' as const };

		// 同じ入力からは必ず同じ結果（3者が別々に計算するため）。
		const again = paradisPtyHostPaths(home);

		assert.deepStrictEqual(
			{
				stable: paradisPtyHostPaths(home).socketPath === again.socketPath,
				// **ここが本題。** 名前を決める材料は「置き場所」と「protocol の版」だけで、ビルドは
				// 入り込まない（そもそも引数に無い）。だから更新をまたいで同じ常駐に会える。
				// 版が名前に入っているので、互換を壊すときだけ新旧が分かれる。
				keyedByProtocol: again.socketPath.includes('-v1.') && again.ledgerFile.endsWith('v1.json'),
				separateProfiles: paradisPtyHostPaths(other).socketPath !== again.socketPath,
				// 前の常駐とは別の場所。混ざると状態パネルが互いを別ビルドとして並べてしまう。
				separateFromOldDaemon: !again.ledgerDir.endsWith('ptyDaemon'),
				withinLimit: again.socketPathTooLong,
			},
			{ stable: true, keyedByProtocol: true, separateProfiles: true, separateFromOldDaemon: true, withinLimit: false },
		);
	});

	test('前の常駐とはソケットも台帳も重ならない', () => {
		const stateDir = '/Users/example/Library/Application Support/Para Code';
		const now = paradisPtyHostPaths({ stateDir, platform: 'darwin' });
		const before = paradisPtyDaemonPaths({ userDataPath: stateDir, buildId: '1.132.0-abcdef', platform: 'darwin' });

		assert.deepStrictEqual(
			{ sameSocket: now.socketPath === before.socketPath, sameLedger: now.ledgerFile === before.ledgerFile },
			{ sameSocket: false, sameLedger: false },
		);
	});

	test('収まらない長さは黙って切り詰めずに申告する', () => {
		const deep = paradisPtyHostPaths({ stateDir: '/' + 'x'.repeat(120), platform: 'darwin' });

		// 握り潰すと bind が失敗し、症状は「毎回ターミナルが作り直される」になって辿れない。
		assert.deepStrictEqual({ tooLong: deep.socketPathTooLong }, { tooLong: true });
	});
});
