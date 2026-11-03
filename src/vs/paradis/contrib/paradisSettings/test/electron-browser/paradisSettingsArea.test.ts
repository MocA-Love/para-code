/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisHubAreaId } from '../../../paradisHub/electron-browser/paradisHub.js';
import { paradisSettingsSectionTarget } from '../../electron-browser/paradisSettingsDialog.contribution.js';
import { paradisRowsGroupedInOrder, paradisSettingsActionKind } from '../../electron-browser/paradisSettingsDialog.js';

suite('ParadisSettingsArea', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the area that now holds an old section id, and keeps the other ids in the settings area', () => {
		assert.deepStrictEqual([
			'psd-sec-usage',
			'psd-sec-notif',
			'psd-sec-menubar',
			undefined,
		].map(paradisSettingsSectionTarget), [
			{ area: ParadisHubAreaId.Usage, section: 'settings' },
			{ area: ParadisHubAreaId.Notifications },
			{ area: ParadisHubAreaId.Settings, section: 'psd-sec-menubar' },
			{ area: ParadisHubAreaId.Settings, section: undefined },
		]);
	});

	// 本家のダイアログだけを出すボタンは器を開いたまま、器の中の領域はそこへ移り、器より下に出るものは閉じてから開く
	test('keeps the hub open for the commands that only show a workbench dialog', () => {
		assert.deepStrictEqual([
			'paradis.agentHooks.showCodexHookStatus',
			'paradis.agentIde.installSkills',
			'paradis.computerUse.showStatus',
			'paradis.sessionIndex.delete',
			'paradis.browserExtensions.manage',
			'paradis.notifications.openSettings',
			'paradis.editor.showLayoutPresets',
			'paradis.terminal.configurePresets',
			'paradis.agentBrowser.openBindingDialog',
		].map(paradisSettingsActionKind), [
			{ kind: 'keepOpen' },
			{ kind: 'keepOpen' },
			{ kind: 'keepOpen' },
			{ kind: 'keepOpen' },
			{ kind: 'area', area: ParadisHubAreaId.Extensions },
			{ kind: 'area', area: ParadisHubAreaId.Notifications, section: 'pns-sec-desktop' },
			{ kind: 'close' },
			{ kind: 'close' },
			{ kind: 'close' },
		]);
	});

	// タイトルバーとステータスバーの節は、ほかの節の行を集めるので小見出しが入り混じる。小見出しごとにまとめる
	test('groups the rows of a section by their subheading in the order the subheadings first appear', () => {
		const rows = [
			{ name: 'agent list', group: 'title bar' },
			{ name: 'ai cost', group: 'status bar' },
			{ name: 'limits', group: 'title bar' },
			{ name: 'github', group: 'status bar' },
			{ name: 'bell', group: 'title bar' },
		];
		assert.deepStrictEqual(paradisRowsGroupedInOrder(rows).map(row => row.name), ['agent list', 'limits', 'bell', 'ai cost', 'github']);
	});
});
