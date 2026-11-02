/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IContextMenuDelegate, IContextMenuProvider } from '../../../../../base/browser/contextmenu.js';
import { Separator } from '../../../../../base/common/actions.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisTerminalResumeBanner, IParadisResumeBannerHost } from '../../browser/paradisTerminalResumeBannerView.js';
import { ParadisResumeAgent } from '../../../sessionResume/common/paradisSessionResume.js';
import { IParadisResumeLedgerEntry } from '../../common/paradisTerminalResumeBanner.js';

/** 押された操作を「何を・確認を省くか」の形で記録するホスト。 */
class RecordingHost implements IParadisResumeBannerHost {
	readonly onDidChange: Event<number> = Event.None;
	readonly calls: string[] = [];
	constructor(private readonly agent: ParadisResumeAgent) { }
	getOffer(): IParadisResumeLedgerEntry {
		return { agent: this.agent, sessionId: 'session-1', cwd: '/project', at: Date.now(), title: 'Fix the parser' };
	}
	resume(_instanceId: number, dangerouslyBypassPermissions?: boolean): void { this.calls.push(dangerouslyBypassPermissions ? 'resume:bypass' : 'resume'); }
	fork(_instanceId: number, dangerouslyBypassPermissions?: boolean): void { this.calls.push(dangerouslyBypassPermissions ? 'fork:bypass' : 'fork'); }
	copySessionId(): void { this.calls.push('copy'); }
	dismiss(): void { this.calls.push('dismiss'); }
}

class RecordingMenu implements IContextMenuProvider {
	delegate: IContextMenuDelegate | undefined;
	showContextMenu(delegate: IContextMenuDelegate): void { this.delegate = delegate; }
}

suite('paradisTerminalResumeBannerView', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 帯のボタンを順に押し、「…」のメニューの項目を順に選んだときの、ボタンの文言とホストへの呼び出し。 */
	function pressEverything(agent: ParadisResumeAgent) {
		const container = document.createElement('div');
		const host = new RecordingHost(agent);
		const menu = new RecordingMenu();
		const banner = createParadisTerminalResumeBanner(container, host, menu);
		try {
			banner.setInstance(1);
			const buttons = [...container.querySelectorAll<HTMLElement>('.paradis-terminal-resume-banner-actions > .monaco-text-button')];
			const more = buttons.pop()!;
			const labels = buttons.map(button => button.textContent);
			for (const button of buttons) {
				button.click();
			}
			const buttonCalls = host.calls.splice(0);
			more.click();
			const actions = menu.delegate?.getActions() ?? [];
			const menuItems = actions.map(action => action instanceof Separator ? '-' : action.label);
			for (const action of actions) {
				if (!(action instanceof Separator)) {
					void action.run();
				}
			}
			return { labels, buttonCalls, menuItems, menuCalls: host.calls };
		} finally {
			banner.dispose();
		}
	}

	test('the two buttons resume with and without permission checks, and the menu forks or copies the id', () => {
		assert.deepStrictEqual({
			claude: pressEverything('claude'),
			codex: pressEverything('codex'),
			opencode: pressEverything('opencode'),
		}, {
			claude: {
				labels: ['再開', '確認なしで再開'],
				buttonCalls: ['resume', 'resume:bypass'],
				menuItems: ['複製して新しい会話で再開（元の会話は残す）', '複製して新しい会話で再開・確認なし（--dangerously-skip-permissions）', '-', 'ID をコピー'],
				menuCalls: ['fork', 'fork:bypass', 'copy'],
			},
			codex: {
				labels: ['再開', '確認なしで再開'],
				buttonCalls: ['resume', 'resume:bypass'],
				menuItems: ['複製して新しい会話で再開（元の会話は残す）', '複製して新しい会話で再開・確認なし（--dangerously-bypass-approvals-and-sandbox）', '-', 'ID をコピー'],
				menuCalls: ['fork', 'fork:bypass', 'copy'],
			},
			// OpenCode の CLI には確認を省くフラグが無いので、確認なしの 2 つは出さない
			opencode: {
				labels: ['再開'],
				buttonCalls: ['resume'],
				menuItems: ['複製して新しい会話で再開（元の会話は残す）', '-', 'ID をコピー'],
				menuCalls: ['fork', 'copy'],
			},
		});
	});
});
