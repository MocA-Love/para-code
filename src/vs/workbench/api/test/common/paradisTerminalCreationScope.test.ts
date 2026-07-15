/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICreateContributedTerminalProfileOptions } from '../../../../platform/terminal/common/terminal.js';
import { ExtHostTerminal } from '../../common/extHostTerminalService.js';
import { MainThreadTerminalServiceShape, TerminalLaunchConfig } from '../../common/extHost.protocol.js';

suite('Paradis extension terminal creation scope propagation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('propagates a contributed profile scope lease into the main-thread launch config', async () => {
		const launchConfigs: TerminalLaunchConfig[] = [];
		const proxy = {
			$createTerminal: async (_id: string, config: TerminalLaunchConfig) => { launchConfigs.push(config); },
		} as Partial<MainThreadTerminalServiceShape> as MainThreadTerminalServiceShape;
		const terminal = new ExtHostTerminal(proxy, 'terminal-id', {}, 'test');
		const contributedOptions: ICreateContributedTerminalProfileOptions = {
			paradisTerminalCreationScopeLease: 'scope:A',
		};

		try {
			await terminal.create({}, contributedOptions);
			assert.strictEqual(launchConfigs[0].paradisTerminalCreationScopeLease, 'scope:A');
		} finally {
			terminal.dispose();
		}
	});
});
