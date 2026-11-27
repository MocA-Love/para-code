/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisMcpConfinedPanes } from '../../common/paradisMcpToolProvider.js';
import type { ParadisPeerKind } from '../../node/paradisCdpPeerResolver.js';
import { IParadisConfinedPaneShell, paradisCallerIsFromConfinedPane } from '../../node/paradisConfinedPaneCaller.js';

suite('paradisConfinedPaneCaller', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const panes: IParadisConfinedPaneShell[] = [
		{ token: 'pane-bot', shellPid: 50 },
		{ token: 'pane-user', shellPid: 90 },
		{ token: 'pane-bot-remote', shellPid: 70, remoteAuthority: 'ssh-remote+host' },
		{ token: 'pane-board', shellPid: 60 },
	];
	const confined: IParadisMcpConfinedPanes = { active: () => true, isConfined: async token => token === 'pane-bot' || token === 'pane-bot-remote' || token === 'pane-board' };

	/** `callerShell` は接続元の祖先にあるシェル（偽の照合は、それが並びにあれば子孫と答える）。 */
	async function check(claimed: string, callerShell: number | 'throw', sources: readonly IParadisMcpConfinedPanes[] = [confined]): Promise<{ readonly refused: boolean; readonly asked: readonly (readonly number[])[] }> {
		const asked: (readonly number[])[] = [];
		const refused = await paradisCallerIsFromConfinedPane(claimed, panes, sources, async (ancestorPids): Promise<ParadisPeerKind> => {
			asked.push(ancestorPids);
			if (callerShell === 'throw') {
				throw new Error('probe failed');
			}
			return ancestorPids.includes(callerShell) ? 'descendant' : 'unknown';
		});
		return { refused, asked };
	}

	test('ほかのペインのトークンを名乗っても、接続元が Bot のペインのシェルの子孫なら断る。Bot が自分のトークンで呼ぶ・確かめられない・制限するペインが無いときは断らない', async () => {
		assert.deepStrictEqual({
			// Bot のペインの中（シェル 50）から、利用者のペインのトークンを名乗った
			stolen: await check('pane-user', 50),
			// Bot が載せたタスクのペインの中（シェル 60）から名乗った
			stolenByBoardTask: await check('pane-user', 60),
			// 利用者のペインの中（シェル 90）から自分のトークンで呼んだ
			user: await check('pane-user', 90),
			// 接続元を確かめられなかった（今の動きのまま通す）
			probeFailed: await check('pane-user', 'throw'),
			// Bot が自分のトークンで呼んだ（Bot の制限はトークンで掛かる）。自分のシェルは照合に入れない
			ownToken: await check('pane-bot', 50),
			// Bot の機能がオフ（登録が無い）なら接続元を調べない
			disabled: await check('pane-user', 50, []),
		}, {
			stolen: { refused: true, asked: [[50, 60]] },
			stolenByBoardTask: { refused: true, asked: [[50, 60]] },
			user: { refused: false, asked: [[50, 60]] },
			probeFailed: { refused: false, asked: [[50, 60]] },
			ownToken: { refused: false, asked: [[60]] },
			disabled: { refused: false, asked: [] },
		});
	});
});
