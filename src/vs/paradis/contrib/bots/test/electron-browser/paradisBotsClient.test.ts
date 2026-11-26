/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { EMPTY_PARADIS_BOTS_SNAPSHOT } from '../../common/paradisBotsApi.js';
import { ParadisBotsClient } from '../../electron-browser/paradisBotsService.js';

suite('Paradis bots client', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('起動の報告: このウィンドウの生きたペインのトークンだけを知らせ、ほかは番号を捨てる', async () => {
		const calls: string[] = [];
		const channel: IChannel = {
			call: async <T>(command: string, args?: unknown): Promise<T> => {
				calls.push(`${command} ${JSON.stringify(args)}`);
				return (command === 'reportLaunch' ? true : command === 'getSnapshot' ? EMPTY_PARADIS_BOTS_SNAPSHOT : undefined) as T;
			},
			listen: <T>() => Event.None as Event<T>,
		};
		const live = new Map([['pane-live', 7]]);
		const client = store.add(new ParadisBotsClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			new NullLogService(),
			{ getInstanceForToken: (token: string) => live.get(token) } as unknown as IParadisPaneTokenService,
		));
		const results = [await client.reportLaunch('launch-1', 'pane-live'), await client.reportLaunch('launch-2', 'pane-gone')];
		assert.deepStrictEqual({ results, calls }, {
			results: [true, false],
			calls: ['getSnapshot undefined', 'reportLaunch ["launch-1","pane-live"]', 'cancelLaunch ["launch-2"]'],
		});
	});
});
