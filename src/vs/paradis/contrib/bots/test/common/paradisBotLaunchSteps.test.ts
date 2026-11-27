/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisBotLaunchedTerminal, paradisBotTabTitle, paradisRunBotLaunch } from '../../common/paradisBotLaunchSteps.js';

suite('Paradis bot launch steps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 起動の手順を記録する。`report` が報告の答え、`token` がペインのトークン、`sendFails` はコマンドの送信の失敗。 */
	async function run(report: boolean, token: string | null = 'pane-1', sendFails = false) {
		const steps: string[] = [];
		const outcome = await paradisRunBotLaunch({
			reportLaunch: async (launchId, paneToken) => {
				steps.push(`report ${launchId} ${paneToken}`);
				return report;
			},
			cancelLaunch: async launchId => {
				steps.push(`cancel ${launchId}`);
			},
			launchAgent: async (beforeCommand: (terminal: IParadisBotLaunchedTerminal) => Promise<boolean>) => {
				steps.push('terminal created');
				const terminal = { instanceId: 7, paneToken: token ?? undefined };
				if (!await beforeCommand(terminal)) {
					steps.push('terminal closed');
					throw new Error('cancelled');
				}
				if (sendFails) {
					throw new Error('send failed');
				}
				steps.push('command sent');
				return terminal;
			},
			nameTab: instanceId => steps.push(`name tab ${instanceId}`),
		}, 'launch-1');
		return { outcome, steps };
	}

	test('ペインの報告とタブ名は、エージェントのコマンドを送る前', async () => {
		assert.deepStrictEqual(await Promise.all([run(true), run(false), run(true, null), run(true, 'pane-1', true)]), [
			{ outcome: { ok: true, instanceId: 7 }, steps: ['terminal created', 'report launch-1 pane-1', 'name tab 7', 'command sent'] },
			// 結び付けを断られたら、コマンドを送らずに閉じる（番号は報告で使い切っている）
			{ outcome: { ok: false, reason: 'refused' }, steps: ['terminal created', 'report launch-1 pane-1', 'terminal closed'] },
			{ outcome: { ok: false, reason: 'failed' }, steps: ['terminal created', 'terminal closed', 'cancel launch-1'] },
			{ outcome: { ok: false, reason: 'failed' }, steps: ['terminal created', 'report launch-1 pane-1', 'name tab 7'] },
		]);
	});

	test('タブ名の雛形は Bot の名前で、雛形の変数として読まれない', () => {
		assert.deepStrictEqual(['リリース係', 'a ${process} b'].map(paradisBotTabTitle), ['リリース係', 'a $ {process} b']);
	});
});
