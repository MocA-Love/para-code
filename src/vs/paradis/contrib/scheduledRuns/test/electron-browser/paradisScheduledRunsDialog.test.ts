/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Event as BaseEvent } from '../../../../../base/common/event.js';
import { language } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisScheduledRunDefinition, IParadisScheduledRunsState } from '../../common/paradisScheduledRuns.js';
import { IParadisScheduledRunsClient } from '../../electron-browser/paradisScheduledRunsClient.js';
import { paradisFormatScheduledTime, ParadisScheduledRunsDialog } from '../../electron-browser/paradisScheduledRunsDialog.js';
import { IParadisDialogService } from '../../../confirmDialog/browser/paradisDialogService.js';
import { paradisOpenAnotherModal } from '../../../paradisSettings/test/browser/paradisModalTestUtils.js';

/** 定期実行のダイアログを開く。`spaceKey` は今いるスペース（`activeStateKey`）。`confirm` は「キャンセル」の確かめの答え。 */
async function openDialog(root: HTMLElement, state: IParadisScheduledRunsState, spaceKey?: string, confirm: () => boolean = () => true): Promise<ParadisScheduledRunsDialog> {
	const dialog = new ParadisScheduledRunsDialog(
		upcastPartial<ILayoutService>({ activeContainer: root }),
		upcastPartial<IParadisScheduledRunsClient>({ onDidChange: BaseEvent.None, getState: async () => state }),
		upcastPartial<IParadisWorkspaceSwitchService>({ repositories: [{ id: 'repo', name: 'repo', uri: URI.parse('file:///repo') }] as never, activeStateKey: spaceKey }),
		upcastPartial<IParadisWorktreeService>({ getDetectedWorktrees: () => [] }),
		upcastPartial<IParadisAgentModelCatalogService>({
			onDidChange: BaseEvent.None,
			refresh: () => { },
			isFixedBySettings: () => false,
			getAgentTemplates: () => [{ id: 'claude', label: 'Claude', command: 'claude' }],
		}),
		upcastPartial<IParadisDialogService>({ confirm: async () => ({ confirmed: confirm() }) }),
		upcastPartial<ICommandService>({}),
		upcastPartial<ISharedProcessService>({}),
		upcastPartial<IConfigurationService>({ getValue: () => undefined }),
		new NullLogService(),
		upcastPartial<IWorkspaceTrustManagementService>({}),
		upcastPartial<IContextViewService>({}),
	);
	await timeout(0);
	return dialog;
}

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
		const open = () => openDialog(root, state);
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
			await timeout(0);
			editRun('Morning');
			const afterReopen = form();
			buttonByText('キャンセル').click();
			await timeout(0);
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

	test('keeps the new-run form per space, so a draft from one space does not come back in another', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const state: IParadisScheduledRunsState = { definitions: [], runs: [], nextRuns: {} };
		const buttonByText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
		const prompt = () => root.querySelector<HTMLTextAreaElement>('.psr-form textarea')!;
		try {
			const inA = await openDialog(root, state, 'space-a');
			buttonByText('新規作成').click();
			prompt().value = 'Typed in space A';
			prompt().dispatchEvent(new Event('input', { bubbles: true }));
			paradisOpenAnotherModal().dispose();
			inA.dispose();

			const inB = await openDialog(root, state, 'space-b');
			buttonByText('新規作成').click();
			const inSpaceB = prompt().value;
			buttonByText('キャンセル').click();
			await timeout(0);
			inB.dispose();

			const backInA = await openDialog(root, state, 'space-a');
			buttonByText('新規作成').click();
			const inSpaceA = prompt().value;
			buttonByText('キャンセル').click();
			await timeout(0);
			backInA.dispose();
			assert.deepStrictEqual({ inSpaceB, inSpaceA, leftOpen: root.children.length }, { inSpaceB: '', inSpaceA: 'Typed in space A', leftOpen: 0 });
		} finally {
			root.remove();
		}
	});

	test('keeps the typed edit as a draft when another run in the list or New is clicked while editing', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const definition = (id: string, name: string): IParadisScheduledRunDefinition => ({
			id, name, enabled: false, schedule: '0 9 * * 1-5',
			target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
			agentId: 'claude', prompt: `Saved prompt of ${name}`, dailyLimit: 3, createdAt: 0, updatedAt: 0,
		});
		const state: IParadisScheduledRunsState = { definitions: [definition('a', 'Morning'), definition('b', 'Evening')], runs: [], nextRuns: {} };
		const buttonByText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
		const selectRun = (name: string) => [...root.querySelectorAll<HTMLButtonElement>('.psr-nav-item')].find(item => item.textContent?.includes(name))!.click();
		const prompt = () => root.querySelector<HTMLTextAreaElement>('.psr-form textarea')!;
		const type = (value: string) => {
			prompt().value = value;
			prompt().dispatchEvent(new Event('input', { bubbles: true }));
		};
		try {
			const dialog = await openDialog(root, state);
			selectRun('Morning');
			buttonByText('編集').click();
			type('Typed before picking another run');
			selectRun('Evening');
			selectRun('Morning');
			buttonByText('編集').click();
			const afterNavClick = prompt().value;
			type('Typed before New');
			buttonByText('新規作成').click();
			const newForm = prompt().value;
			buttonByText('キャンセル').click();
			await timeout(0);
			selectRun('Morning');
			buttonByText('編集').click();
			const afterNew = prompt().value;
			buttonByText('キャンセル').click();
			await timeout(0);
			dialog.dispose();
			assert.deepStrictEqual({ afterNavClick, newForm, afterNew, leftOpen: root.children.length }, {
				afterNavClick: 'Typed before picking another run',
				newForm: '',
				afterNew: 'Typed before New',
				leftOpen: 0,
			});
		} finally {
			root.remove();
		}
	});

	test('Escape keeps the typed edit as a draft and marks the run in the list, Cancel asks before throwing the input away', async () => {
		const root = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(root);
		const definition = (id: string, name: string): IParadisScheduledRunDefinition => ({
			id, name, enabled: false, schedule: '0 9 * * 1-5',
			target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
			agentId: 'claude', prompt: `Saved prompt of ${name}`, dailyLimit: 3, createdAt: 0, updatedAt: 0,
		});
		const state: IParadisScheduledRunsState = { definitions: [definition('c', 'Noon'), definition('d', 'Night')], runs: [], nextRuns: {} };
		const answers: boolean[] = [];
		const buttonByText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
		const navItems = () => [...root.querySelectorAll<HTMLButtonElement>('.psr-nav-item')];
		const prompt = () => root.querySelector<HTMLTextAreaElement>('.psr-form textarea');
		const type = (value: string) => {
			prompt()!.value = value;
			prompt()!.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const list = () => navItems().map(item => ({ name: item.querySelector('.psr-nav-name')?.textContent, draft: !!item.querySelector('.paradis-chip'), current: item.getAttribute('aria-current') }));
		try {
			const dialog = await openDialog(root, state, undefined, () => answers.shift() ?? true);
			navItems()[0].click();
			buttonByText('編集').click();
			type('Typed before Escape');
			prompt()!.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));
			const afterEscape = { editing: prompt() !== null, list: list() };
			buttonByText('編集').click();
			const restored = prompt()!.value;
			answers.push(false);
			buttonByText('キャンセル').click();
			await timeout(0);
			const afterDeclined = prompt()?.value;
			answers.push(true);
			buttonByText('キャンセル').click();
			await timeout(0);
			const afterConfirmed = { editing: prompt() !== null, list: list() };
			dialog.dispose();
			assert.deepStrictEqual({ afterEscape, restored, afterDeclined, afterConfirmed }, {
				afterEscape: {
					editing: false,
					list: [{ name: 'Noon', draft: true, current: 'true' }, { name: 'Night', draft: false, current: null }],
				},
				restored: 'Typed before Escape',
				afterDeclined: 'Typed before Escape',
				afterConfirmed: {
					editing: false,
					list: [{ name: 'Noon', draft: false, current: 'true' }, { name: 'Night', draft: false, current: null }],
				},
			});
		} finally {
			root.remove();
		}
	});

	test('writes the weekday, and the year only when it is not this year', () => {
		const now = new Date(2026, 2, 5, 10, 30).getTime();
		const at = (year: number, month: number, day: number) => new Date(year, month - 1, day, 9, 0).getTime();
		const expected = (year: number | undefined, month: number, day: number) => `${safeIntl.DateTimeFormat(language, { ...(year ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', weekday: 'short' }).value.format(new Date(year ?? 2026, month - 1, day))} 9:00`;
		assert.deepStrictEqual(
			[paradisFormatScheduledTime(at(2026, 3, 5), now), paradisFormatScheduledTime(at(2026, 2, 26), now), paradisFormatScheduledTime(at(2025, 12, 25), now)],
			['今日 9:00', expected(undefined, 2, 26), expected(2025, 12, 25)],
		);
	});
});
