/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisScheduledRunDefinition, IParadisScheduledRunsState } from '../../common/paradisScheduledRuns.js';
import { IParadisScheduledRunsClient } from '../../electron-browser/paradisScheduledRunsClient.js';
import { ParadisScheduledRunsDialog } from '../../electron-browser/paradisScheduledRunsDialog.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

suite('ParadisScheduledRunsDialog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the edit form per scheduled run when another modal closes the dialog, restores it on the next edit, and drops it on Cancel', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const definition = (id: string, name: string): IParadisScheduledRunDefinition => ({
			id, name, enabled: false, schedule: '0 9 * * 1-5',
			target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
			agentId: 'claude', prompt: `Saved prompt of ${name}`, dailyLimit: 3, createdAt: 0, updatedAt: 0,
		});
		const state: IParadisScheduledRunsState = { definitions: [definition('a', 'Morning'), definition('b', 'Evening')], runs: [], nextRuns: {} };
		const open = async () => {
			const dialog = new ParadisScheduledRunsDialog(
				upcastPartial<ILayoutService>({ activeContainer: root }),
				upcastPartial<IParadisScheduledRunsClient>({ onDidChange: BaseEvent.None, getState: async () => state }),
				upcastPartial<IParadisWorkspaceSwitchService>({ repositories: [{ id: 'repo', name: 'repo', uri: URI.parse('file:///repo') }] as never }),
				upcastPartial<IParadisWorktreeService>({ getDetectedWorktrees: () => [] }),
				upcastPartial<IParadisAgentModelCatalogService>({
					onDidChange: BaseEvent.None,
					refresh: () => { },
					isFixedBySettings: () => false,
					getAgentTemplates: () => [{ id: 'claude', label: 'Claude', command: 'claude' }],
				}),
				upcastPartial<IDialogService>({}),
				upcastPartial<ICommandService>({}),
				upcastPartial<ISharedProcessService>({}),
				upcastPartial<IConfigurationService>({}),
				new NullLogService(),
			);
			await timeout(0);
			return dialog;
		};
		const buttonByText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
		const editRun = (name: string) => {
			[...root.querySelectorAll<HTMLButtonElement>('.psr-nav-item')].find(item => item.textContent?.includes(name))!.click();
			buttonByText('編集').click();
		};
		const prompt = () => root.querySelector<HTMLTextAreaElement>('.psr-form textarea')!;
		const form = () => ({ prompt: prompt().value, note: (root.querySelector('.psr-form')?.textContent ?? '').includes('保存する前に閉じた編集を戻しました') });
		try {
			const first = await open();
			editRun('Morning');
			prompt().value = 'Typed but not saved';
			prompt().dispatchEvent(new Event('input', { bubbles: true }));
			const other = paradisOpenAnotherModal();
			const closedByOther = root.children.length === 0;
			other.dispose();

			const second = await open();
			editRun('Evening');
			const forOtherRun = form();
			buttonByText('キャンセル').click();
			editRun('Morning');
			const afterReopen = form();
			buttonByText('キャンセル').click();
			second.dispose();

			const third = await open();
			editRun('Morning');
			const afterCancel = form();
			// Closing without typing anything keeps no draft
			third.dispose();
			const fourth = await open();
			editRun('Morning');
			const afterUntouchedClose = form();
			fourth.dispose();
			first.dispose();
			assert.deepStrictEqual({ closedByOther, forOtherRun, afterReopen, afterCancel, afterUntouchedClose, leftOpen: root.children.length }, {
				closedByOther: true,
				forOtherRun: { prompt: 'Saved prompt of Evening', note: false },
				afterReopen: { prompt: 'Typed but not saved', note: true },
				afterCancel: { prompt: 'Saved prompt of Morning', note: false },
				afterUntouchedClose: { prompt: 'Saved prompt of Morning', note: false },
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});
});
