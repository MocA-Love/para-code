/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IParadisMobileBotsFeed } from '../../../mobileRelay/node/paradisMobileBotsFeed.js';
import { ParadisMobileTerminalRegistry } from '../../../mobileRelay/node/paradisMobileTerminalRegistry.js';
import { IParadisBotSummary, IParadisBotsSnapshot, PARADIS_BOTS_ENABLED_SETTING } from '../../common/paradisBotsApi.js';
import { ParadisBotsMobileFeed } from '../../node/paradisBotsMobileFeed.js';
import { paradisBotPaneTokenHash } from '../../node/paradisBotPanes.js';

const BOT: IParadisBotSummary = {
	id: 'bot-1', name: 'リリース係', folder: 'release', agent: 'claude', paused: false, pinned: true, faceColor: 'blue', faceShape: 'drop',
	createdAt: 1, updatedAt: 1, needsYou: 1, openItems: 3, openSuggestions: 2, activity: 'idle', lastActivityAt: 9,
};

suite('Paradis bots mobile feed', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(enabled: boolean) {
		const disposables = store.add(new DisposableStore());
		const changed = disposables.add(new Emitter<IParadisBotsSnapshot>());
		const configuration = new TestConfigurationService({ [PARADIS_BOTS_ENABLED_SETTING]: enabled });
		const published: (IParadisMobileBotsFeed | undefined)[] = [];
		const feed = disposables.add(new ParadisBotsMobileFeed({
			onDidChange: changed.event,
			getSnapshot: () => ({ revision: 1, readOnly: false, bots: [BOT] }),
			paneHashesOf: botId => botId === 'bot-1' ? [paradisBotPaneTokenHash('pane-token-1')] : [],
		}, configuration, value => { published.push(value); }));
		return { feed, configuration, published, disposables };
	}

	test('設定がオフなら一覧を置かず、オンなら送ってよい欄だけを置き、捨てたら外す', () => {
		const { configuration, published, disposables } = setup(false);
		configuration.setUserConfiguration(PARADIS_BOTS_ENABLED_SETTING, true);
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === PARADIS_BOTS_ENABLED_SETTING } as unknown as IConfigurationChangeEvent);
		const on = published[1]!;
		disposables.dispose();
		assert.deepStrictEqual([
			published[0],
			on.bots,
			[on.botOfToken('pane-token-1'), on.botOfToken('other')],
			published.at(-1),
		], [
			undefined,
			[{ id: 'bot-1', name: 'リリース係', agent: 'claude', faceColor: 'blue', faceShape: 'drop', paused: false, pinned: true, needsYou: 1, openItems: 3, openSuggestions: 2, activity: 'idle', lastActivityAt: 9 }],
			['bot-1', undefined],
			undefined,
		]);
	});

	test('State: Bot のペインのターミナルにだけ botId を付け、同じ一覧では revision を進めない', () => {
		const { published } = setup(true);
		const registry = new ParadisMobileTerminalRegistry('epoch');
		registry.syncWindow(1, 'session', 1, {
			activeWs: undefined, workspaces: [], terminals: [
				{ terminalKey: 'k1', id: 1, title: 'claude', agent: true, agentToken: 'pane-token-1' },
				{ terminalKey: 'k2', id: 2, title: 'zsh' },
			],
		});
		const first = registry.setBots(published[0]);
		const revision = registry.desktopState().revision;
		const again = registry.setBots({ ...published[0]! });
		const state = registry.desktopState();
		const removed = registry.setBots(undefined);
		assert.deepStrictEqual([first, again, state.revision === revision, state.terminals.map(terminal => terminal.botId), state.bots?.map(bot => bot.id), removed, registry.desktopState().bots], [
			true, false, true, ['bot-1', undefined], ['bot-1'], true, undefined,
		]);
	});
});
