/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { FocusMode, INativeHostService } from '../../../../../platform/native/common/native.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisBrowserScopeService, IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../../browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserBindingModel } from '../../electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentApprovalRequest, ParadisAgentBrowserTabsService, ParadisApprovalDeadline } from '../../electron-browser/paradisAgentBrowserTabsService.js';

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
	/** 同じペインへ current のほかに共有しているページ。 */
	more?: string[];
	unbinds: number;
	unboundPages?: string[];
	/** upstream が共有用に開き直したタブ（共有が成立したとき、こちらの ID が返る）。 */
	replacementPageId?: string;
	resolveBind?: (bound: boolean) => void;
	sharingAtBind?: string;
}

function createService(answers: IAnswer[], binding: IFakeBinding = { pageId: undefined, unbinds: 0 }, onSetAudience: (args: unknown) => void = () => { }) {
	const shown: IShownPrompt[] = [];
	const attention: { targetWindowId: number | undefined; mode: FocusMode | undefined }[] = [];
	const onDidFocusWindow = new Emitter<number>();
	const onDidBlurWindow = new Emitter<number>();
	const nativeHostService = {
		onDidFocusMainOrAuxiliaryWindow: onDidFocusWindow.event,
		onDidBlurMainOrAuxiliaryWindow: onDidBlurWindow.event,
		focusWindow: async (options?: { targetWindowId?: number; mode?: FocusMode }) => { attention.push({ targetWindowId: options?.targetWindowId, mode: options?.mode }); },
	} as unknown as INativeHostService;
	const dialogService = {
		prompt: async (prompt: IPrompt<unknown>) => {
			shown.push({
				message: prompt.message,
				detail: typeof prompt.detail === 'string' ? prompt.detail : undefined,
				labels: (prompt.buttons ?? []).map(button => button.label),
				hasCancelButton: prompt.cancelButton !== undefined,
			});
			const answer = answers.shift() ?? { button: undefined, afterMs: 0 };
			// 本物のダイアログと同じく、印のクラスを付けた要素を画面に出しておく（表示されたかの判定に使われる）
			const element = mainWindow.document.createElement('div');
			const custom = prompt.custom;
			element.classList.add(...(typeof custom === 'object' ? custom.classes ?? [] : []));
			mainWindow.document.body.appendChild(element);
			await timeout(answer.afterMs);
			element.remove();
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
		onDidChange: Event.None,
		getPanes: () => [{ token: 'pane-token', title: 'cla\u202eude \u001b[31m' }],
		getBindingForToken: () => binding.pageId === undefined ? undefined : { pageId: binding.pageId },
		getBindingsForToken: () => [...(binding.pageId === undefined ? [] : [binding.pageId]), ...(binding.more ?? [])].map(pageId => ({ pageId })),
		sharePageWithPane: (model: { id: string; sharingState?: string }) => {
			binding.sharingAtBind = model.sharingState;
			return new Promise<string | undefined>(resolve => binding.resolveBind = bound => resolve(bound ? binding.replacementPageId ?? model.id : undefined));
		},
		// そのページの共有だけを外す（current を外したら、残りの先頭を current にする）
		unbindPageFromToken: async (pageId: string) => {
			binding.unbinds++;
			binding.unboundPages = [...(binding.unboundPages ?? []), pageId];
			if (binding.pageId === pageId) {
				binding.pageId = binding.more?.shift();
			} else {
				binding.more = binding.more?.filter(candidate => candidate !== pageId);
			}
		},
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
		{ getChannel: () => ({ call: async (_command: string, args: unknown) => onSetAudience(args), listen: () => Event.None }) } as unknown as IMainProcessService,
		nativeHostService,
	);
	return { service, shown, binding, attention, onDidFocusWindow, onDidBlurWindow };
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

	test('a denial with a cooldown key only refuses that key for that pane', () => runWithFakedTimers(fakedTimers, async () => {
		const { service, shown } = createService([{ button: 0, afterMs: 1500 }, { button: 1, afterMs: 1500 }, { button: 1, afterMs: 1500 }]);
		store.add(service);
		const cts = store.add(new CancellationTokenSource());
		const device = (id: string): IParadisAgentApprovalRequest => ({ ...request, cooldownKey: `mobile-device:${id}` });
		assert.deepStrictEqual([
			await service.askApproval('pane-token', device('iphone'), cts.token),
			await service.askApproval('pane-token', device('iphone'), cts.token),
			await service.askApproval('pane-token', device('pixel'), cts.token),
			await service.askApproval('pane-token', request, cts.token),
			shown.length,
		], ['denied', 'recentlyDenied', 'approve', 'approve', 3]);
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

	test('asks for attention (without taking focus) once per request, only when no Para Code window has native focus', () => runWithFakedTimers(fakedTimers, async () => {
		const { service, shown, attention, onDidFocusWindow, onDidBlurWindow } = createService([
			{ button: 1, afterMs: 1500 },
			{ button: 1, afterMs: 100 }, { button: 1, afterMs: 1500 },
			{ button: 1, afterMs: 1500 },
		]);
		store.add(service);
		store.add(onDidFocusWindow);
		store.add(onDidBlurWindow);
		const cts = store.add(new CancellationTokenSource());
		const ownWindow = mainWindow.vscodeWindowId;
		// 1: no focus event yet (unknown) -> no attention
		const unknown = await service.askApproval('pane-token', request, cts.token);
		// 2: another app is in front -> one attention for the request, even though it is asked twice
		onDidFocusWindow.fire(ownWindow);
		onDidBlurWindow.fire(ownWindow);
		const away = await service.askApproval('pane-token', request, cts.token);
		const afterAway = attention.length;
		// 3: our window is frontmost (e.g. the user is in the embedded browser) -> no attention,
		//    whatever order a switch between two windows arrives in
		onDidFocusWindow.fire(ownWindow);
		onDidBlurWindow.fire(ownWindow + 1000);
		const front = await service.askApproval('pane-token', request, cts.token);
		assert.deepStrictEqual([unknown, away, front, shown.length, afterAway, attention], [
			'approve', 'approve', 'approve', 4, 1,
			[{ targetWindowId: ownWindow, mode: FocusMode.Notify }],
		]);
	}));

	test('refuses the same pane for a while after shown dialogs were left unanswered twice in a row, not counting cancellations by the agent', () => runWithFakedTimers(fakedTimers, async () => {
		const fast = { button: 1, afterMs: 100 };
		const { service, shown } = createService([{ button: 1, afterMs: 60_000 }, { button: 1, afterMs: 60_000 }, fast, fast, fast]);
		store.add(service);
		// 締め切りまで放置された（1回目）
		const expiring = store.add(new ParadisApprovalDeadline(undefined, 30_000));
		const expired = await service.askApproval('pane-token', request, expiring.token);
		// エージェント側で中断された（数えない）
		const interrupted = store.add(new CancellationTokenSource());
		const pending = service.askApproval('pane-token', request, interrupted.token);
		await timeout(200);
		interrupted.cancel();
		const cancelled = await pending;
		// 速押しが続いて答えが得られなかった（2回目）
		const live = store.add(new CancellationTokenSource());
		assert.deepStrictEqual([
			expired,
			cancelled,
			await service.askApproval('pane-token', request, live.token),
			await service.askApproval('pane-token', request, live.token),
			shown.length,
		], ['cancelled', 'cancelled', 'unanswered', 'recentlyDenied', 5]);
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

	// 共有は付け替えではなく追加なので、締め切り後に成立した共有を外すときも、そのペインのほかの共有は残す
	test('withdrawing a share that completes after the deadline keeps the pane\'s other shared pages', () => runWithFakedTimers(fakedTimers, async () => {
		const binding: IFakeBinding = { pageId: undefined, more: [], unbinds: 0 };
		const { service } = createService([], binding);
		store.add(service);
		const input = { id: 'view-late', resolve: async () => ({ id: 'view-late' }) } as unknown as BrowserEditorInput;
		const cts = store.add(new CancellationTokenSource());
		const result = service.bindTabWithin('pane-token', input, cts.token);
		await timeout(0);
		cts.cancel();
		const bound = await result;
		// 遅れて成立した共有が current になり、前から共有していたページは 2 枚目以降に残っている
		binding.pageId = 'view-late';
		binding.more = ['view-earlier'];
		binding.resolveBind?.(true);
		await timeout(0);
		assert.deepStrictEqual({ bound, unboundPages: binding.unboundPages, current: binding.pageId, more: binding.more }, {
			bound: undefined,
			unboundPages: ['view-late'],
			current: 'view-earlier',
			more: [],
		});
	}));

	// ネットワークの制限で upstream が共有用のタブを開き直したら、締め切り後に外すのはそのタブ
	test('withdraws the replacement tab upstream opened for a share that completes after the deadline', () => runWithFakedTimers(fakedTimers, async () => {
		const binding: IFakeBinding = { pageId: undefined, more: [], unbinds: 0, replacementPageId: 'view-replacement' };
		const { service } = createService([], binding);
		store.add(service);
		const input = { id: 'view-1', resolve: async () => ({ id: 'view-1' }) } as unknown as BrowserEditorInput;
		const cts = store.add(new CancellationTokenSource());
		const result = service.bindTabWithin('pane-token', input, cts.token);
		await timeout(0);
		cts.cancel();
		await result;
		binding.pageId = 'view-replacement';
		binding.resolveBind?.(true);
		await timeout(0);
		assert.deepStrictEqual({ unboundPages: binding.unboundPages, current: binding.pageId }, { unboundPages: ['view-replacement'], current: undefined });
	}));

	// 前からこのペインへ共有していたページを選び直して締め切りを過ぎても、その共有は外さない
	test('keeps a page that was already shared with the pane when a share of it completes after the deadline', () => runWithFakedTimers(fakedTimers, async () => {
		const binding: IFakeBinding = { pageId: 'view-current', more: ['view-1'], unbinds: 0 };
		const { service } = createService([], binding);
		store.add(service);
		const input = { id: 'view-1', resolve: async () => ({ id: 'view-1' }) } as unknown as BrowserEditorInput;
		const cts = store.add(new CancellationTokenSource());
		const result = service.bindTabWithin('pane-token', input, cts.token);
		await timeout(0);
		cts.cancel();
		await result;
		binding.pageId = 'view-1';
		binding.more = ['view-current'];
		binding.resolveBind?.(true);
		await timeout(0);
		assert.deepStrictEqual({ unbinds: binding.unbinds, current: binding.pageId, more: binding.more }, { unbinds: 0, current: 'view-1', more: ['view-current'] });
	}));

	test('marks an approved page as shared before binding, so the upstream share confirmation does not appear again', () => runWithFakedTimers(fakedTimers, async () => {
		const onDidChangeSharingState = new Emitter<string>();
		const model = {
			id: 'view-1',
			sharingState: 'available',
			isDirectlyShareable: true,
			onDidChangeSharingState: onDidChangeSharingState.event,
		};
		const audienceCalls: unknown[] = [];
		const { service, binding } = createService([], { pageId: undefined, unbinds: 0 }, args => {
			audienceCalls.push(args);
			model.sharingState = 'shared';
			onDidChangeSharingState.fire('shared');
		});
		store.add(service);
		store.add(onDidChangeSharingState);
		const input = { id: 'view-1', resolve: async () => model } as unknown as BrowserEditorInput;
		const bound = service.bindTab('pane-token', input);
		await timeout(0);
		binding.resolveBind?.(true);
		assert.deepStrictEqual([await bound, audienceCalls, binding.sharingAtBind], [true, [['view-1', { type: 'agent' }, true]], 'shared']);
	}));
});

suite('ParadisAgentBrowserTabsService approved profile tabs', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const TOKEN = 'pane-token';

	function setup() {
		const disposables = store.add(new DisposableStore());
		const bindingChanges = disposables.add(new Emitter<void>());
		const state = { bound: undefined as string | undefined, more: [] as string[], binds: [] as string[], grants: [] as string[], revokes: [] as string[] };
		const views = new Map<string, BrowserEditorInput>();
		const sharing = new Map<string, Emitter<BrowserViewSharingState>>();
		const tab = (id: string) => {
			const emitter = disposables.add(new Emitter<BrowserViewSharingState>());
			sharing.set(id, emitter);
			const model = { id, sharingState: BrowserViewSharingState.Shared, isDirectlyShareable: true, onDidChangeSharingState: emitter.event } as unknown as IBrowserViewModel;
			const input = { id, url: `https://${id}.example`, title: id, getName: () => id, onWillDispose: Event.None, onDidResolveModel: Event.None, resolve: async () => model } as unknown as BrowserEditorInput;
			views.set(id, input);
			return input;
		};
		const bindingModel = {
			onDidChange: bindingChanges.event,
			getBindingForToken: (token: string) => token === TOKEN && state.bound !== undefined ? { token, pageId: state.bound } : undefined,
			getBindingsForToken: (token: string) => token === TOKEN ? [...(state.bound !== undefined ? [state.bound] : []), ...state.more].map(pageId => ({ token, pageId })) : [],
			// 共有は追加: 前の current は 2 枚目以降に残る
			sharePageWithPane: async (model: IBrowserViewModel, token: string) => {
				state.binds.push(model.id);
				if (token === TOKEN) {
					if (state.bound !== undefined && state.bound !== model.id) {
						state.more = [state.bound, ...state.more.filter(pageId => pageId !== model.id)];
					}
					state.bound = model.id;
				}
				return model.id;
			},
			grantAgentTab: async (model: IBrowserViewModel) => {
				state.grants.push(model.id);
				return true;
			},
			revokeAgentTab: async (_token: string, viewId: string) => {
				state.revokes.push(viewId);
			},
		} as unknown as IParadisAgentBrowserBindingModel;
		const service = disposables.add(new ParadisAgentBrowserTabsService(
			{ getKnownBrowserViews: () => views } as unknown as IBrowserViewWorkbenchService,
			{} as IEditorService,
			{} as IEditorGroupsService,
			bindingModel,
			{} as IParadisPaneTokenService,
			{} as IParadisTerminalScopeService,
			{ resolveScope: () => ({ kind: 'managed' }) } as unknown as IParadisBrowserScopeService,
			{ isSwitching: false } as unknown as IParadisWorkspaceSwitchService,
			{} as IParadisWorktreeService,
			{} as IParadisAuxiliaryWindowScopeService,
			{} as IDialogService,
			{} as IQuickInputService,
			new NullLogService(),
			{ getChannel: () => ({ call: async () => undefined, listen: () => Event.None }) } as unknown as IMainProcessService,
			{ onDidFocusMainOrAuxiliaryWindow: Event.None, onDidBlurMainOrAuxiliaryWindow: Event.None } as unknown as INativeHostService,
		));
		// 共有先が変わったと binding model が知らせる（実物は 100ms まとめてから届く）
		const bind = (pageId: string | undefined) => {
			state.bound = pageId;
			bindingChanges.fire();
		};
		const listed = () => {
			const result = service.listTabs(TOKEN);
			return result.ok ? result.tabs.map(entry => entry.tabId).sort() : [];
		};
		return { service, state, tab, bind, listed, sharing, views, disposables };
	}

	// 共有を止めてから binding model の通知が届くまでの間に選び直されても、承認なしでは共有し直さない（M22）
	test('an approved profile tab stopped by the user cannot be re-selected before the change notification arrives', async () => {
		const { service, state, tab, bind } = setup();
		service.registerAgentTab(TOKEN, tab('approved'), { approvedProfile: true });
		bind('approved');
		// ユーザーが共有を止めた。通知はまだ届いていない
		state.bound = undefined;
		const selected = await service.selectTab(TOKEN, 'approved');
		assert.deepStrictEqual({ selected, binds: state.binds, opened: service.isOpenedBy(TOKEN, 'approved') }, {
			selected: { ok: false, reason: 'unknownTab' },
			binds: [],
			opened: false,
		});
	});

	// エージェントが別のタブへ移った後は、承認済みのタブの共有先は変わらない。「ブラウザページの共有を解除」や
	// 共有ボタンで止めても共有先の変化は起きないので、止めた経路から直接外す
	test('an approved profile tab the agent moved away from is dropped when the user unshares it or turns its sharing off', async () => {
		const { service, state, tab, bind, listed, sharing } = setup();
		service.registerAgentTab(TOKEN, tab('approved'), { approvedProfile: true });
		service.registerAgentTab(TOKEN, tab('toggled'), { approvedProfile: true });
		service.registerAgentTab(TOKEN, tab('own'));
		bind('approved');
		const movedToOwn = await service.selectTab(TOKEN, 'own');
		const afterAgentMove = listed();
		// エージェント自身のタブは、共有を止められても自分のタブのまま
		service.revokeApprovedProfileTab('own');
		// 「ブラウザページの共有を解除」（自分のタブを選んでもユーザーの共有は残っているので、共有も外れる）
		service.revokeApprovedProfileTab('approved');
		state.bound = undefined;
		// upstream の共有ボタンで止めた（共有の状態の変化で気づく）
		await timeout(0);
		sharing.get('toggled')!.fire(BrowserViewSharingState.Available);
		const reselected = await service.selectTab(TOKEN, 'approved');
		assert.deepStrictEqual({ movedToOwn: movedToOwn.ok, afterAgentMove, afterRevoke: listed(), reselected, binds: state.binds, grants: state.grants }, {
			movedToOwn: true,
			afterAgentMove: ['approved', 'own', 'toggled'],
			afterRevoke: ['own'],
			reselected: { ok: false, reason: 'unknownTab' },
			// 自分のタブは共有を付け替えずに許可を張る（ユーザーの共有はそのまま）
			binds: [],
			grants: ['own'],
		});
	});

	test('selecting an own tab grants it without moving the user\'s share, and the user turning its sharing off revokes the grant', async () => {
		const { service, state, tab, bind, sharing } = setup();
		tab('user-page');
		bind('user-page');
		service.registerAgentTab(TOKEN, tab('own'));
		const selected = await service.selectTab(TOKEN, 'own');
		await timeout(0);
		sharing.get('own')!.fire(BrowserViewSharingState.Available);
		assert.deepStrictEqual({ selected: selected.ok && selected.bound, shared: state.bound, binds: state.binds, grants: state.grants, revokes: state.revokes }, {
			selected: true,
			shared: 'user-page',
			binds: [],
			grants: ['own'],
			revokes: ['own'],
		});
	});

	// 1 つのペインへ複数のページを共有できる。list_browser_tabs には全部が載り、2 枚目以降も共有し直さずに選べる
	test('lists every page shared with the pane and selects a second shared page without sharing it again', async () => {
		const { service, state, tab, bind } = setup();
		tab('page-a');
		tab('page-b');
		bind('page-a');
		state.more = [];
		// ユーザーがもう 1 枚共有した（page-a は 2 枚目以降に残る）
		state.bound = 'page-b';
		state.more = ['page-a'];
		const listed = service.listTabs(TOKEN);
		const selected = await service.selectTab(TOKEN, 'page-a');
		assert.deepStrictEqual({
			tabs: listed.ok ? listed.tabs.map(entry => [entry.tabId, entry.active, entry.url]) : [],
			selected: selected.ok && selected.bound,
			binds: state.binds,
		}, {
			tabs: [['page-b', true, 'https://page-b.example'], ['page-a', true, 'https://page-a.example']],
			selected: true,
			binds: [],
		});
	});

	test('keeps watching the sharing state after the tab\'s model is recreated', async () => {
		const { service, listed, views, disposables } = setup();
		const resolved = disposables.add(new Emitter<IBrowserViewModel>());
		const firstSharing = disposables.add(new Emitter<BrowserViewSharingState>());
		const secondSharing = disposables.add(new Emitter<BrowserViewSharingState>());
		const model = (onDidChangeSharingState: Event<BrowserViewSharingState>) => ({ id: 'replaced', sharingState: BrowserViewSharingState.Shared, onDidChangeSharingState }) as unknown as IBrowserViewModel;
		const input = { id: 'replaced', url: 'https://replaced.example', title: 'replaced', getName: () => 'replaced', onWillDispose: Event.None, onDidResolveModel: resolved.event, resolve: async () => model(firstSharing.event) } as unknown as BrowserEditorInput;
		views.set('replaced', input);
		service.registerAgentTab(TOKEN, input, { approvedProfile: true });
		await timeout(0);
		resolved.fire(model(secondSharing.event));
		// 古いモデルの知らせはもう届かない。新しいモデルで共有が止まったら外れる
		firstSharing.fire(BrowserViewSharingState.Available);
		const afterOldModel = listed();
		secondSharing.fire(BrowserViewSharingState.Available);
		assert.deepStrictEqual({ afterOldModel, afterNewModel: listed() }, { afterOldModel: ['replaced'], afterNewModel: [] });
	});
});
