/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ITerminalInstance, ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { paradisRegisterTerminalCreationScopeProvider } from '../../../contrib/terminal/browser/paradisTerminalCreationScope.js';
import { MainThreadTerminalService } from '../../browser/mainThreadTerminalService.js';
import { TerminalLaunchConfig } from '../../common/extHost.protocol.js';

suite('Paradis MainThreadTerminalService creation scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('captures direct extension creation at RPC entry and preserves a contributed lease', async () => {
		let activeStateKey = 'scope:B';
		const registration = paradisRegisterTerminalCreationScopeProvider(() => activeStateKey);
		const received: Array<Parameters<ITerminalService['createTerminal']>[0]> = [];
		const instance = {
			instanceId: 1,
			onDisposed: Event.None,
		} as Partial<ITerminalInstance> as ITerminalInstance;
		const service = Object.create(MainThreadTerminalService.prototype) as MainThreadTerminalService;
		const internals = service as unknown as {
			_terminalService: Pick<ITerminalService, 'createTerminal'>;
			_extHostTerminals: Map<string, Promise<ITerminalInstance>>;
			_register<T extends IDisposable>(value: T): T;
		};
		internals._terminalService = {
			createTerminal: async options => {
				received.push(options);
				return instance;
			},
		};
		internals._extHostTerminals = new Map();
		internals._register = value => value;

		try {
			const directConfig: TerminalLaunchConfig = {};
			const direct = service.$createTerminal('direct', directConfig);
			activeStateKey = 'scope:C';
			await direct;
			await service.$createTerminal('contributed', { paradisTerminalCreationScopeLease: 'scope:A' });

			assert.strictEqual(received[0]?.paradisTerminalCreationScopeLease, 'scope:B');
			assert.strictEqual(received[1]?.paradisTerminalCreationScopeLease, 'scope:A');
		} finally {
			registration.dispose();
		}
	});
});
