/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { AgentHostTerminalService } from '../../browser/agentHostTerminalService.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../browser/terminal.js';
import { ITerminalProfileProvider, ITerminalProfileService } from '../../common/terminal.js';

suite('Paradis Agent Host terminal creation scope', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards the contributed profile creation lease to the terminal service', async () => {
		let provider: ITerminalProfileProvider | undefined;
		let received: ICreateTerminalOptions | undefined;
		const disposable: IDisposable = { dispose() { } };
		const instance = {
			onDisposed: Event.None,
		} as Partial<ITerminalInstance> as ITerminalInstance;
		const terminalService = {
			createTerminal: async (options: ICreateTerminalOptions) => {
				received = options;
				return instance;
			},
		} as Partial<ITerminalService> as ITerminalService;
		const terminalProfileService = {
			registerTerminalProfileProvider: (_extensionIdentifier: string, _id: string, value: ITerminalProfileProvider) => {
				provider = value;
				return disposable;
			},
			registerInternalContributedProfile: () => disposable,
		} as Partial<ITerminalProfileService> as ITerminalProfileService;
		const service = new AgentHostTerminalService(
			terminalService,
			{} as ConstructorParameters<typeof AgentHostTerminalService>[1],
			terminalProfileService,
			{} as ConstructorParameters<typeof AgentHostTerminalService>[3],
		);
		const connection = { clientId: 'client' } as IAgentConnection;
		const entryRegistration = service.registerEntry({ name: 'host', address: 'host', getConnection: () => connection });

		try {
			assert.ok(provider);
			await provider.createContributedTerminalProfile({ paradisTerminalCreationScopeLease: 'scope:A' });
			assert.strictEqual(received?.paradisTerminalCreationScopeLease, 'scope:A');
		} finally {
			entryRegistration.dispose();
			service.dispose();
		}
	});
});
