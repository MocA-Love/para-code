/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
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

/** 押すボタンの位置（undefined は Esc / 閉じる）と、押すまでにかかる時間（ms）。 */
interface IAnswer {
	readonly button: number | undefined;
	readonly afterMs: number;
}

function createService(answers: IAnswer[]) {
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
			if (prompt.token?.isCancellationRequested || answer.button === undefined) {
				return { result: undefined };
			}
			return { result: await prompt.buttons![answer.button].run({ checkboxChecked: undefined }) };
		},
	} as unknown as IDialogService;
	const bindingModel = {
		getPanes: () => [{ token: 'pane-token', title: 'cla\u202eude \u001b[31m' }],
	} as unknown as IParadisAgentBrowserBindingModel;
	const paneTokenService = { getInstanceForToken: () => 7 } as unknown as IParadisPaneTokenService;
	const terminalScopeService = { getStateKeyForInstance: () => 'repo-1' } as unknown as IParadisTerminalScopeService;
	const workspaceSwitchService = { repositories: [{ id: 'repo-1', name: 'app' }] } as unknown as IParadisWorkspaceSwitchService;
	const worktreeService = { getWorktrees: () => [] } as unknown as IParadisWorktreeService;
	const service = new ParadisAgentBrowserTabsService(
		{} as IBrowserViewWorkbenchService,
		{} as IEditorService,
		{} as IEditorGroupsService,
		bindingModel,
		paneTokenService,
		terminalScopeService,
		{} as IParadisBrowserScopeService,
		workspaceSwitchService,
		worktreeService,
		{} as IParadisAuxiliaryWindowScopeService,
		dialogService,
		{} as IQuickInputService,
		new NullLogService(),
	);
	return { service, shown };
}

const request: IParadisAgentApprovalRequest = {
	messageTemplate: pane => `${pane} wants the page`,
	detail: ['detail'],
	approveLabel: 'Share',
};

suite('ParadisAgentBrowserTabsService approval', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('puts Deny first (the default focus), has no separate cancel button, and names the pane safely', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { service, shown } = createService([{ button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		const choice = await service.askApproval('pane-token', request, cts.token);
		assert.deepStrictEqual(
			[choice, shown.map(prompt => [prompt.message, prompt.labels, prompt.hasCancelButton])],
			['approve', [['\u300ccla ude [31m\u300d\uff08\u30bf\u30fc\u30df\u30ca\u30eb 7\u30fb\u30b9\u30da\u30fc\u30b9\u300capp\u300d\uff09 wants the page', ['\u62d2\u5426(&&D)', 'Share'], false]]],
		);
	}));

	test('asks again when approval comes right after the dialog appears', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { service, shown } = createService([{ button: 1, afterMs: 100 }, { button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		const choice = await service.askApproval('pane-token', request, cts.token);
		assert.deepStrictEqual([choice, shown.length, shown[0].detail === 'detail', shown[1].detail?.endsWith('detail')], ['approve', 2, true, true]);
	}));

	test('treats Deny, Escape and cancellation as a refusal', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const denied = createService([{ button: 0, afterMs: 1500 }]);
		const escaped = createService([{ button: undefined, afterMs: 1500 }]);
		const cancelled = createService([{ button: 1, afterMs: 1500 }]);
		store.add(denied.service);
		store.add(escaped.service);
		store.add(cancelled.service);
		const cts = store.add(new CancellationTokenSource());
		const live = store.add(new CancellationTokenSource());
		const pending = cancelled.service.askApproval('pane-token', request, cts.token);
		cts.cancel();
		assert.deepStrictEqual([
			await denied.service.askApproval('pane-token', request, live.token),
			await escaped.service.askApproval('pane-token', request, live.token),
			await pending,
		], [undefined, undefined, undefined]);
	}));
});
