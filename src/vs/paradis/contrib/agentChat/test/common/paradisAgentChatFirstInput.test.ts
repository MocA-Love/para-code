/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentFirstInputProbe, paradisAgentReadyForFirstInput, paradisWaitForAgentFirstInput } from '../../common/paradisAgentChatFirstInput.js';

suite('Paradis agent chat first input', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	type Probe = IParadisAgentFirstInputProbe | undefined;

	async function run(steps: readonly Probe[], timeoutMs = 10_000): Promise<{ ready: boolean; probes: number }> {
		let index = 0;
		const ready = await paradisWaitForAgentFirstInput(() => steps[Math.min(index++, steps.length - 1)], timeoutMs, async () => { });
		return { ready, probes: index };
	}

	test('最初の 1 文は、入力欄が空で見えていて選択画面が無いと確かに分かってから送る。信頼の確認・更新の案内の選択画面や、入力欄が分からない間は送らずに待ち、時間切れなら送らない', async () => {
		const shell: Probe = { foreground: 'shell', composer: 'unknown', choiceMenu: false };
		const booting: Probe = { foreground: 'agent', composer: 'unknown', choiceMenu: false };
		const trust: Probe = { foreground: 'agent', composer: 'unknown', choiceMenu: true };
		// 選択画面の行に入力欄の印が紛れても、選択画面があれば送らない
		const trustWithMarker: Probe = { foreground: 'agent', composer: 'empty', choiceMenu: true };
		const ready: Probe = { foreground: 'agent', composer: 'empty', choiceMenu: false };
		const typed: Probe = { foreground: 'agent', composer: 'text', choiceMenu: false };
		assert.deepStrictEqual([
			paradisAgentReadyForFirstInput(ready!),
			paradisAgentReadyForFirstInput(trust!),
			paradisAgentReadyForFirstInput(trustWithMarker!),
			paradisAgentReadyForFirstInput(typed!),
			await run([shell, booting, trust, ready]),
			await run([trust], 1000),
			await run([booting, shell]),
			await run([booting, undefined]),
		], [
			true, false, false, false,
			{ ready: true, probes: 4 },
			{ ready: false, probes: 5 },
			{ ready: false, probes: 2 },
			{ ready: false, probes: 2 },
		]);
	});
});
