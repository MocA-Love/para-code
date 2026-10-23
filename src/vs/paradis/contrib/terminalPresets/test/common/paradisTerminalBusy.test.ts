/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisTerminalBusySignals, paradisIsTerminalBusy } from '../../common/paradisTerminalPresets.js';

suite('paradisIsTerminalBusy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const idle: IParadisTerminalBusySignals = { alternateBuffer: false, commandStateLive: true, executingCommand: false, agentPane: false, hasChildProcesses: false };

	test('decides from shell integration while it is live, and falls back to child processes and agent hooks otherwise', () => {
		const cases: Record<string, Partial<IParadisTerminalBusySignals>> = {
			liveIdle: {},
			// powerlevel10k の gitstatusd のような常駐の子プロセスだけでは忙しくしない
			liveIdleWithResidentChild: { hasChildProcesses: true },
			// エージェントが終わった後のシェル（hook の印は残る）は空き
			liveIdleAfterAgentExited: { agentPane: true },
			liveExecuting: { executingCommand: true },
			alternateBuffer: { alternateBuffer: true },
			// 接続し直した直後：戻ったコマンドがあっても子プロセスがいなければ終わっている
			reattachedRestoredCommandFinished: { commandStateLive: false, executingCommand: true },
			reattachedWithChild: { commandStateLive: false, hasChildProcesses: true },
			reattachedAgentPane: { commandStateLive: false, agentPane: true },
			reattachedIdle: { commandStateLive: false },
		};
		const actual = Object.fromEntries(Object.entries(cases).map(([name, signals]) => [name, paradisIsTerminalBusy({ ...idle, ...signals })]));
		assert.deepStrictEqual(actual, {
			liveIdle: false,
			liveIdleWithResidentChild: false,
			liveIdleAfterAgentExited: false,
			liveExecuting: true,
			alternateBuffer: true,
			reattachedRestoredCommandFinished: false,
			reattachedWithChild: true,
			reattachedAgentPane: true,
			reattachedIdle: false,
		});
	});
});
