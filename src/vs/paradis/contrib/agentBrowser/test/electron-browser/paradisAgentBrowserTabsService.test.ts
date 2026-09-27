/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentApprovalRequest, ParadisAgentBrowserTabsService } from '../../electron-browser/paradisAgentBrowserTabsService.js';

interface IShownPrompt {
	readonly message: string;
	readonly detail: string | undefined;
	readonly labels: string[];
	readonly hasCancelButton: boolean;
}

/** The button the fake user presses (undefined = Escape / close), how long they take, and whether they use Cmd+D. */
interface IAnswer {
	readonly button: number | undefined;
	readonly afterMs: number;
	readonly viaCommandD?: boolean;
}

interface IFakeBinding {
	pageId: string | undefined;
	unbinds: number;
	resolveBind?: (bound: boolean) => void;
}

function createService(answers: IAnswer[], binding: IFakeBinding = { pageId: undefined, unbinds: 0 }) {
	const shown: IShownPrompt[] = [];
	const dialogService = {
		prompt: async (prompt: IPrompt<unknown>) => {
			shown.push({
				message: prompt.message,
				detail: typeof prompt.detail === 'string' ? prompt.detail : undefined,
				labels: (prompt.buttons ?? []).map(button => button.label),
				hasCancelButton: prompt.cancelButton !== undefined,
			});
			const answer = answers.shift() ?? { button: undefined, afterMs: 0 };
			await timeout(answer.afterMs);
			if (answer.viaCommandD) {
				mainWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true }));
			}
			if (prompt.token?.isCancellationRequested || answer.button === undefined) {
				return { result: undefined };
			}
			return { result: await prompt.buttons![answer.button].run({ checkboxChecked: undefined }) };
		},
	} as unknown as IDialogService;
	const bindingModel = {
		getPanes: () => [{ token: 'pane-token', title: 'cla\u202eude \u001b[31m' }],
		getBindingForToken: () => binding.pageId === undefined ? undefined : { pageId: binding.pageId },
		bindPageToPane: () => new Promise<boolean>(resolve => binding.resolveBind = resolve),
		unbindToken: async () => { binding.unbinds++; binding.pageId = undefined; },
	} as unknown as IParadisAgentBrowserBindingModel;
	const paneTokenService = { getInstanceForToken: () => 7 } as unknown as IParadisPaneTokenService;
	const terminalScopeService = { getStateKeyForInstance: () => 'repo-1' } as unknown as IParadisTerminalScopeService;
	const browserScopeService = { resolveScope: () => ({ kind: 'managed' }) } as unknown as IParadisBrowserScopeService;
	const workspaceSwitchService = { repositories: [{ id: 'repo-1', name: 'app' }] } as unknown as IParadisWorkspaceSwitchService;
	const worktreeService = { getWorktrees: () => [] } as unknown as IParadisWorktreeService;
	const service = new ParadisAgentBrowserTabsService(
		{} as IBrowserViewWorkbenchService,
		{} as IEditorService,
		{} as IEditorGroupsService,
		bindingModel,
		paneTokenService,
		terminalScopeService,
		browserScopeService,
		workspaceSwitchService,
		worktreeService,
		{} as IParadisAuxiliaryWindowScopeService,
		dialogService,
		{} as IQuickInputService,
		new NullLogService(),
	);
	return { service, shown, binding };
}

const request: IParadisAgentApprovalRequest = {
	messageTemplate: pane => `${pane} wants the page`,
	detail: ['detail'],
	approveLabel: 'Share',
};

const fakedTimers = { useFakeTimers: true, maxTaskCount: 100_000 };

suite('ParadisAgentBrowserTabsService approval', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('puts Deny first (the default focus), has no separate cancel button, and names the pane safely', () => runWithFakedTimers(fakedTimers, async () => {
		const { service, shown } = createService([{ button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		const outcome = await service.askApproval('pane-token', request, cts.token);
		assert.deepStrictEqual(
			[outcome, shown.map(prompt => [prompt.message, prompt.labels, prompt.hasCancelButton])],
			['approve', [['\u300ccla ude [31m\u300d\uff08\u30bf\u30fc\u30df\u30ca\u30eb 7\u30fb\u30b9\u30da\u30fc\u30b9\u300capp\u300d\uff09 wants the page', ['\u62d2\u5426', 'Share'], false]]],
		);
	}));

	test('asks again when approval comes right after the dialog appears, and gives up after three fast answers', () => runWithFakedTimers(fakedTimers, async () => {
		const slow = createService([{ button: 1, afterMs: 100 }, { button: 1, afterMs: 1500 }]);
		const fast = createService([{ button: 1, afterMs: 100 }, { button: 1, afterMs: 100 }, { button: 1, afterMs: 100 }]);
		store.add(slow.service);
		store.add(fast.service);
		const cts = store.add(new CancellationTokenSource());
		assert.deepStrictEqual([
			await slow.service.askApproval('pane-token', request, cts.token),
			slow.shown.length,
			slow.shown[1].detail?.endsWith('detail'),
			await fast.service.askApproval('pane-token', request, cts.token),
			fast.shown.length,
		], ['approve', 2, true, 'unanswered', 3]);
	}));

	test('treats Deny and Escape as a refusal, and refuses the same pane for a while afterwards', () => runWithFakedTimers(fakedTimers, async () => {
		const denied = createService([{ button: 0, afterMs: 1500 }, { button: 1, afterMs: 1500 }]);
		const escaped = createService([{ button: undefined, afterMs: 1500 }]);
		store.add(denied.service);
		store.add(escaped.service);
		const cts = store.add(new CancellationTokenSource());
		assert.deepStrictEqual([
			await denied.service.askApproval('pane-token', request, cts.token),
			await denied.service.askApproval('pane-token', request, cts.token),
			denied.shown.length,
			await escaped.service.askApproval('pane-token', request, cts.token),
		], ['denied', 'recentlyDenied', 1, 'denied']);
	}));

	test('reports cancellation, and refuses a second request from a pane that is still waiting', () => runWithFakedTimers(fakedTimers, async () => {
		const { service } = createService([{ button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		const live = store.add(new CancellationTokenSource());
		const pending = service.askApproval('pane-token', request, cts.token);
		const second = await service.askApproval('pane-token', request, live.token);
		cts.cancel();
		assert.deepStrictEqual([second, await pending], ['busy', 'cancelled']);
	}));

	(isMacintosh ? test : test.skip)('asks again when the approval was chosen with Cmd+D', () => runWithFakedTimers(fakedTimers, async () => {
		const { service, shown } = createService([{ button: 1, afterMs: 1500, viaCommandD: true }, { button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		assert.deepStrictEqual([await service.askApproval('pane-token', request, cts.token), shown.length], ['approve', 2]);
	}));

	test('withdraws a share that completes after the deadline', () => runWithFakedTimers(fakedTimers, async () => {
		const { service, binding } = createService([]);
		store.add(service);
		const input = { id: 'view-1', resolve: async () => ({ id: 'view-1' }) } as unknown as BrowserEditorInput;
		const cts = store.add(new CancellationTokenSource());
		const result = service.bindTabWithin('pane-token', input, cts.token);
		await timeout(0);
		cts.cancel();
		const bound = await result;
		binding.pageId = 'view-1';
		binding.resolveBind?.(true);
		await timeout(0);
		assert.deepStrictEqual([bound, binding.unbinds, binding.pageId], [undefined, 1, undefined]);
	}));
});
