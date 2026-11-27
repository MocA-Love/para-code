/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { EMPTY_PARADIS_BOTS_SNAPSHOT, IParadisBotsSnapshot, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';
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
			new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true }),
		));
		const results = [await client.reportLaunch('launch-1', 'pane-live'), await client.reportLaunch('launch-2', 'pane-gone')];
		assert.deepStrictEqual({ results, calls }, {
			results: [true, false],
			calls: ['getSnapshot undefined', 'reportLaunch ["launch-1","pane-live"]', 'cancelLaunch ["launch-2"]'],
		});
	});

	test('設定をオフにしたら台帳の購読を外して一覧を空にし、オンに戻したら購読し直して取り直す', async () => {
		const changes = store.add(new Emitter<IParadisBotsSnapshot>());
		const log: string[] = [];
		const snapshot: IParadisBotsSnapshot = { revision: 5, readOnly: false, bots: [] };
		const channel: IChannel = {
			call: async <T>(command: string): Promise<T> => { log.push(command); return (command === 'getSnapshot' ? snapshot : undefined) as T; },
			listen: <T>(event: string) => (event === 'onDidChange' ? (listener: (value: T) => void) => {
				log.push('listen');
				const subscription = changes.event(value => listener(value as T));
				return { dispose: () => { log.push('unlisten'); subscription.dispose(); } };
			} : Event.None) as Event<T>,
		};
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: true });
		const client = store.add(new ParadisBotsClient({ getChannel: () => channel } as unknown as ISharedProcessService, new NullLogService(), {} as IParadisPaneTokenService, configuration));
		await Promise.resolve();
		const toggle = async (value: boolean) => {
			await configuration.setUserConfiguration(PARADIS_BOTS_ENABLED_SETTING, value);
			configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === PARADIS_BOTS_ENABLED_SETTING } as never);
			await Promise.resolve();
		};
		const on = client.snapshot.revision;
		await toggle(false);
		const off = client.snapshot.revision;
		changes.fire({ revision: 9, readOnly: false, bots: [] });
		const ignored = client.snapshot.revision;
		await toggle(true);
		assert.deepStrictEqual({ on, off, ignored, again: client.snapshot.revision, log }, {
			on: 5, off: 0, ignored: 0, again: 5,
			log: ['listen', 'getSnapshot', 'unlisten', 'listen', 'getSnapshot'],
		});
	});
});
