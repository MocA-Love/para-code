/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisWaitForAgentFirstInput } from '../../common/paradisAgentChatFirstInput.js';

suite('Paradis agent chat first input', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	type Probe = { readonly foreground: 'agent' | 'shell' | 'unknown'; readonly bracketedPasteMode: boolean } | undefined;

	async function run(steps: readonly Probe[], timeoutMs = 10_000): Promise<{ ready: boolean; probes: number }> {
		let index = 0;
		const ready = await paradisWaitForAgentFirstInput(() => steps[Math.min(index++, steps.length - 1)], timeoutMs, async () => { });
		return { ready, probes: index };
	}

	test('最初の 1 文は、エージェントが前面に出て入力欄の準備（貼り付けのモード）ができてから送る。起動前のシェルでは諦めず、エージェントが終わった・ペインが消えた・時間切れなら送らない', async () => {
		const shell = { foreground: 'shell' as const, bracketedPasteMode: false };
		const booting = { foreground: 'agent' as const, bracketedPasteMode: false };
		const ready = { foreground: 'agent' as const, bracketedPasteMode: true };
		assert.deepStrictEqual([
			await run([shell, booting, booting, ready]),
			await run([booting, shell]),
			await run([booting, undefined]),
			await run([booting], 1000),
		], [
			{ ready: true, probes: 4 },
			{ ready: false, probes: 2 },
			{ ready: false, probes: 2 },
			{ ready: false, probes: 5 },
		]);
	});
});
