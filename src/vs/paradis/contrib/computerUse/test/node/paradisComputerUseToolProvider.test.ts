/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMcpOwningWindowRequest, IParadisMcpToolCallContext, ParadisMcpCallerKind, ParadisMcpOwningWindowResult } from '../../../agentBrowser/common/paradisMcpToolProvider.js';
import { IParadisComputerUseApprovalPrompt, ParadisComputerUseApprovalOutcome, ParadisComputerUseAvailability } from '../../common/paradisComputerUse.js';
import { ParadisComputerUseGrantLedger } from '../../node/paradisComputerUseGrantLedger.js';
import { IParadisComputerUseHelper, IParadisComputerUseHelperStatus, ParadisComputerUseHelperError } from '../../node/paradisComputerUseHelperClient.js';
import { PARADIS_COMPUTER_USE_TOOLS, ParadisComputerUseToolProvider } from '../../node/paradisComputerUseToolProvider.js';

interface IResult {
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	isError?: boolean;
}

const FINDER = { pid: 100, name: 'Finder', bundleId: 'com.apple.finder', active: false, hidden: false };
const NOTES = { pid: 200, name: 'Notes', bundleId: 'com.apple.Notes', active: true, hidden: false };

const INPUT_METHODS = new Set(['activateApp', 'click', 'drag', 'scroll', 'typeText', 'pasteText', 'pressKey', 'hotkey']);

/** 補助アプリの代わり。 */
class FakeHelper implements IParadisComputerUseHelper {
	availability: ParadisComputerUseAvailability = 'ok';
	readonly detail = undefined;
	readonly lastStatus: IParadisComputerUseHelperStatus = { protocolVersion: 1, helperVersion: '0.1.0', pid: 9, permissions: { accessibility: true, screenRecording: true }, responsibility: 'self' };
	apps: object[] = [FINDER, NOTES, { pid: 300, name: '1Password', bundleId: 'com.1password.1password', active: false, hidden: false }, { pid: 400, name: 'Para Code', bundleId: 'ltd.paradis.paracode', active: false, hidden: false }, { pid: 500, name: 'System Settings', bundleId: 'com.apple.systempreferences', active: false, hidden: false }, { pid: 600, name: 'NoId', active: false, hidden: false }];
	permissions = { accessibility: 'granted', screenRecording: 'granted' };
	readonly calls: string[] = [];
	/** 入力の命令と、渡した引数。 */
	readonly inputs: { method: string; params: Record<string, unknown> }[] = [];
	failTree: string | undefined;
	/** 入力の命令の答え（既定は成功）。 */
	onInput: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true });

	async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push(params.pid !== undefined ? `${method}:${params.pid}${params.windowId !== undefined ? `/${params.windowId}` : ''}` : method);
		if (INPUT_METHODS.has(method)) {
			this.inputs.push({ method, params });
			return this.onInput(method, params);
		}
		switch (method) {
			case 'listApps':
				return { apps: this.apps };
			case 'permissions':
				return this.permissions;
			case 'listWindows':
				return { windows: [{ windowId: 71, index: 0, title: 'Hidden', bounds: { x: 0, y: 0, width: 10, height: 10 }, onScreen: false }, { windowId: 72, index: 1, title: 'Desktop', bounds: { x: 5, y: 6, width: 800, height: 600 }, onScreen: true }] };
			case 'accessibilityTree':
				if (this.failTree) {
					throw new ParadisComputerUseHelperError(this.failTree, 'no');
				}
				return { text: '[0] AXWindow "Desktop"', nodeCount: 1, truncated: false };
			case 'screenshotWindow':
				return { mimeType: 'image/png', data: 'UE5H', width: 1600, height: 1200, scale: 2 };
		}
		throw new ParadisComputerUseHelperError('unknown_method', method);
	}
}

function createContext(caller: ParadisMcpCallerKind, answers: ParadisComputerUseApprovalOutcome[], onAsk?: () => void) {
	const prompts: { method: string; token: unknown; prompt: IParadisComputerUseApprovalPrompt; timeoutMs: number | undefined }[] = [];
	const context: IParadisMcpToolCallContext = {
		async callOwningWindow<T>(request: IParadisMcpOwningWindowRequest): Promise<ParadisMcpOwningWindowResult<T>> {
			prompts.push({ method: request.method, token: request.args[0], prompt: request.args[1] as IParadisComputerUseApprovalPrompt, timeoutMs: request.timeoutMs });
			onAsk?.();
			const outcome = answers.shift() ?? 'cancelled';
			return { ok: true, value: { outcome } as T };
		},
		getPaneAgentStatus: () => undefined,
		getUnconfirmedRelease: () => undefined,
		hasAgentHookHistory: () => false,
		classifyCaller: async () => caller,
	};
	return { context, prompts };
}

function text(result: unknown): string {
	return (result as IResult).content.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('\n');
}

suite('ParadisComputerUseToolProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: { enabled?: boolean; blockSystemSurfaces?: boolean } = {}) {
		const helper = new FakeHelper();
		const ledger = new ParadisComputerUseGrantLedger();
		const state = { enabled: options.enabled ?? true };
		const blockOptions = options.blockSystemSurfaces === undefined ? undefined : { blockSystemSurfaces: options.blockSystemSurfaces };
		const provider = new ParadisComputerUseToolProvider(helper, ledger, { enabled: () => state.enabled, blockOptions, settleMs: 0 }, undefined);
		return { helper, ledger, state, provider };
	}

	test('shows the tools only while the setting is on and the helper is ready', () => {
		const { helper, state, provider } = setup();
		const shown = provider.listTools().map(tool => tool.name);
		const readOnly = provider.listTools().filter(tool => (tool.annotations as { readOnlyHint?: boolean }).readOnlyHint === true).map(tool => tool.name);
		helper.availability = 'launch-failed';
		const failed = provider.listTools().length;
		helper.availability = 'ok';
		state.enabled = false;
		assert.deepStrictEqual({ shown, readOnly, failed, off: provider.listTools().length, instructions: provider.instructions() }, {
			shown: ['computer_status', 'computer_list_apps', 'computer_list_windows', 'computer_get_app_state', 'computer_activate_app', 'computer_click', 'computer_drag', 'computer_scroll', 'computer_type_text', 'computer_paste_text', 'computer_press_key', 'computer_hotkey'],
			readOnly: ['computer_status', 'computer_list_apps', 'computer_list_windows', 'computer_get_app_state'],
			failed: 0,
			off: 0,
			instructions: undefined,
		});
	});

	test('refuses SSH panes, unverified callers, a disabled setting and an unavailable helper before touching the helper', async () => {
		const { helper, state, provider } = setup();
		const tunnel = await provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('tunnel', []).context);
		const unverified = await provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('unverified', []).context);
		const noContext = await provider.callTool('pane-a', 'computer_list_apps', {});
		state.enabled = false;
		const disabled = await provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('pane', []).context);
		state.enabled = true;
		helper.availability = 'misattributed';
		const misattributed = await provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('pane', []).context);
		assert.deepStrictEqual({
			texts: [tunnel, unverified, noContext, disabled, misattributed].map(result => ({ error: (result as IResult).isError, text: text(result).split('.')[0] })),
			calls: helper.calls,
			other: await provider.callTool('pane-a', 'mobile_tap', {}),
		}, {
			texts: [
				{ error: true, text: 'Computer Use is not available to panes connected over SSH' },
				{ error: true, text: 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so Computer Use is not available for it' },
				{ error: true, text: 'Para Code could not confirm that this request comes from a process inside your own terminal pane, so Computer Use is not available for it' },
				{ error: true, text: 'Computer Use is turned off in Para Code settings' },
				{ error: true, text: 'macOS attributes the Computer Use helper\'s permissions to another app on this Mac, so Para Code keeps Computer Use off' },
			],
			calls: [],
			other: undefined,
		});
	});

	test('lists apps with the fixed block list and this pane\'s access', async () => {
		const { ledger, provider } = setup();
		ledger.set('pane-a', 'com.apple.Notes', 'read');
		ledger.set('pane-b', 'com.apple.finder', 'denied');
		const result = await provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('pane', []).context);
		const apps = JSON.parse(text(result)).apps.map((app: { name: string; blocked?: string; access: string }) => [app.name, app.blocked ?? '', app.access]);
		const systemAllowed = setup({ blockSystemSurfaces: false });
		const withoutSystem = JSON.parse(text(await systemAllowed.provider.callTool('pane-a', 'computer_list_apps', {}, undefined, createContext('pane', []).context))).apps
			.filter((app: { blocked?: string }) => app.blocked).map((app: { name: string }) => app.name);
		assert.deepStrictEqual({ apps, withoutSystem }, {
			apps: [
				['Finder', '', 'none'],
				['Notes', '', 'read'],
				['1Password', 'password-manager', 'none'],
				['Para Code', 'para-code', 'none'],
				// Q97 の回答 A で常に断る
				['System Settings', 'system', 'none'],
				['NoId', 'no-bundle-id', 'none'],
			],
			withoutSystem: ['1Password', 'Para Code', 'NoId'],
		});
	});

	test('asks once per pane and app, then reads without asking again', async () => {
		const { helper, ledger, provider } = setup();
		const { context, prompts } = createContext('pane', ['read']);
		const first = await provider.callTool('pane-a', 'computer_list_windows', { app: 'com.apple.finder' }, undefined, context);
		const second = await provider.callTool('pane-a', 'computer_list_windows', { app: 'Finder' }, undefined, context);
		assert.deepStrictEqual({
			prompts,
			firstError: (first as IResult).isError,
			windows: JSON.parse(text(second)).windows.map((window: { windowId: number }) => window.windowId),
			grants: ledger.listForPane('pane-a'),
			calls: helper.calls,
		}, {
			prompts: [{ method: 'requestAccess', token: 'pane-a', prompt: { appName: 'Finder', bundleId: 'com.apple.finder', requested: 'read', upgrade: false, offerOperate: true }, timeoutMs: 120_000 }],
			firstError: undefined,
			windows: [71, 72],
			grants: [{ bundleId: 'com.apple.finder', grant: 'read' }],
			calls: ['listApps', 'listApps', 'listWindows:100', 'listApps', 'listWindows:100'],
		});
	});

	test('remembers a denial for the pane and never asks about blocked apps', async () => {
		const { ledger, provider } = setup();
		const { context, prompts } = createContext('pane', ['denied']);
		const denied = await provider.callTool('pane-a', 'computer_list_windows', { app: 'com.apple.finder' }, undefined, context);
		const again = await provider.callTool('pane-a', 'computer_list_windows', { app: 'com.apple.finder' }, undefined, context);
		const blocked = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'com.1password.1password' }, undefined, context);
		const self = await provider.callTool('pane-a', 'computer_list_windows', { app: 'pid:400' }, undefined, context);
		assert.deepStrictEqual({
			prompts: prompts.length,
			errors: [denied, again, blocked, self].map(result => (result as IResult).isError),
			blocked: text(blocked),
			self: text(self),
			grants: ledger.listForPane('pane-a'),
		}, {
			prompts: 1,
			errors: [true, true, true, true],
			blocked: '1Password (com.1password.1password) is a password manager. Computer Use never reads or operates password managers.',
			self: 'Para Code (ltd.paradis.paracode) is Para Code itself. Computer Use never reads or operates Para Code.',
			grants: [{ bundleId: 'com.apple.finder', grant: 'denied' }],
		});
	});

	test('does not remember answers that are not decisions, and refuses when the app restarts during the dialog', async () => {
		const { helper, ledger, provider } = setup();
		const { context, prompts } = createContext('pane', ['busy', 'recentlyDenied', 'unanswered', 'paneUnresolved', 'read'], () => {
			if (prompts.length === 5) {
				helper.apps = [{ ...FINDER, pid: 101 }];
			}
		});
		const results: string[] = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			results.push(text(await provider.callTool('pane-a', 'computer_list_windows', { app: 'com.apple.finder' }, undefined, context)).split('.')[0]);
		}
		assert.deepStrictEqual({ results, prompts: prompts.length, calls: helper.calls.filter(call => call.startsWith('listWindows')) }, {
			results: [
				'Another request from this terminal pane is waiting for the user',
				'The user declined a request for this app a short while ago, so Para Code turned this one down without asking',
				'Para Code could not get a clear answer: the dialog was answered right after it appeared or with a keyboard shortcut',
				'Para Code could not find the window of this terminal pane, so it could not ask the user',
				'Finder quit or restarted while the user was answering',
			],
			prompts: 5,
			calls: [],
		});
		// 承認そのものは記録したので、起動し直したアプリ（同じ bundle id）は聞かずに読める
		assert.deepStrictEqual(ledger.listForPane('pane-a'), [{ bundleId: 'com.apple.finder', grant: 'read' }]);
	});

	test('reads the frontmost visible window as a tree and a screenshot', async () => {
		const { helper, ledger, provider } = setup();
		ledger.set('pane-a', 'com.apple.Notes', 'read');
		const result = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'Notes' }, undefined, createContext('pane', []).context) as IResult;
		assert.deepStrictEqual({
			header: JSON.parse((result.content[0] as { text: string }).text),
			tree: (result.content[1] as { text: string }).text,
			image: result.content[2],
			calls: helper.calls,
		}, {
			header: { app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 200 }, window: { windowId: 72, index: 1, title: 'Desktop', bounds: { x: 5, y: 6, width: 800, height: 600 } }, scale: 2 },
			tree: '[0] AXWindow "Desktop"',
			image: { type: 'image', data: 'UE5H', mimeType: 'image/png' },
			calls: ['listApps', 'listWindows:200', 'permissions', 'accessibilityTree:200/72', 'screenshotWindow:200/72'],
		});
	});

	test('explains missing permissions without asking for Para Code itself, and validates the window', async () => {
		const { helper, ledger, provider } = setup();
		ledger.set('pane-a', 'com.apple.Notes', 'read');
		const context = createContext('pane', []).context;
		helper.permissions = { accessibility: 'granted', screenRecording: 'not-granted' };
		const treeOnly = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'Notes', windowIndex: 0 }, undefined, context) as IResult;
		helper.permissions = { accessibility: 'not-granted', screenRecording: 'not-granted' };
		const nothing = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'Notes' }, undefined, context);
		const unknownWindow = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'Notes', windowId: 99 }, undefined, context);
		const badIndex = await provider.callTool('pane-a', 'computer_get_app_state', { app: 'Notes', windowIndex: -1 }, undefined, context);
		assert.deepStrictEqual({
			treeOnly: { parts: treeOnly.content.map(part => part.type), notes: JSON.parse((treeOnly.content[0] as { text: string }).text).notes, window: JSON.parse((treeOnly.content[0] as { text: string }).text).window.windowId },
			nothing: (nothing as IResult).isError && text(nothing).includes('Do not ask them to allow Para Code itself'),
			unknownWindow: text(unknownWindow),
			badIndex: text(badIndex),
		}, {
			treeOnly: { parts: ['text', 'text'], notes: ['Screen Recording is not granted to "Para Code Computer Use", so there is no screenshot.'], window: 71 },
			nothing: true,
			unknownWindow: 'There is no such window. Call computer_list_windows to see the windows of this app.',
			badIndex: '"windowIndex" must be an integer from 0 to 10000.',
		});
	});

	test('asks for pid when two running apps share a name, and refuses apps without a bundle id', async () => {
		const { helper, provider } = setup();
		helper.apps = [FINDER, { ...FINDER, pid: 101 }, { pid: 600, name: 'NoId', active: false, hidden: false }];
		const context = createContext('pane', []).context;
		assert.deepStrictEqual({
			ambiguous: text(await provider.callTool('pane-a', 'computer_list_windows', { app: 'Finder' }, undefined, context)),
			noBundle: text(await provider.callTool('pane-a', 'computer_list_windows', { app: 'NoId' }, undefined, context)),
			missing: text(await provider.callTool('pane-a', 'computer_list_windows', { app: 'Safari' }, undefined, context)),
			empty: text(await provider.callTool('pane-a', 'computer_list_windows', {}, undefined, context)),
		}, {
			ambiguous: 'More than one running app matches "Finder". Pass pid:<number> from computer_list_apps instead.',
			noBundle: 'NoId has no bundle id, so Computer Use cannot ask the user about it.',
			missing: 'No running app matches "Safari". Call computer_list_apps to see the running apps.',
			empty: '"app" must be a bundle id, an exact app name or pid:<number> from computer_list_apps.',
		});
	});

	test('reports status with the permissions and this pane\'s decisions', async () => {
		const { helper, ledger, provider } = setup();
		helper.permissions = { accessibility: 'granted', screenRecording: 'not-granted' };
		ledger.set('pane-a', 'com.apple.finder', 'read');
		const status = JSON.parse(text(await provider.callTool('pane-a', 'computer_status', {}, undefined, createContext('pane', []).context)));
		assert.deepStrictEqual(status, {
			available: true,
			helperVersion: '0.1.0',
			permissions: { accessibility: 'granted', screenRecording: 'not-granted' },
			howToGrant: 'Ask the user to open System Settings > Privacy & Security and allow "Para Code Computer Use" under Accessibility and Screen Recording. Do not ask them to allow Para Code itself.',
			thisPane: [{ bundleId: 'com.apple.finder', access: 'read' }],
		});
	});

	test('keeps the tool list in sync with the handler', () => {
		assert.strictEqual(PARADIS_COMPUTER_USE_TOOLS.length, 12);
	});

	test('asks to operate on first use, then clicks in the chosen window without asking again', async () => {
		const { helper, ledger, provider } = setup();
		const { context, prompts } = createContext('pane', ['operate']);
		const first = await provider.callTool('pane-a', 'computer_click', { app: 'Notes', elementIndex: 3, button: 'right', clickCount: 2, modifiers: ['cmd'], includeState: false }, undefined, context) as IResult;
		const second = await provider.callTool('pane-a', 'computer_type_text', { app: 'Notes', text: 'hello', includeState: false }, undefined, context) as IResult;
		assert.deepStrictEqual({
			prompts: prompts.map(entry => entry.prompt),
			first: JSON.parse((first.content[0] as { text: string }).text),
			secondError: second.isError,
			inputs: helper.inputs,
			grants: ledger.listForPane('pane-a'),
		}, {
			prompts: [{ appName: 'Notes', bundleId: 'com.apple.Notes', requested: 'operate', upgrade: false, offerOperate: true }],
			first: { app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 200 }, action: 'click', ok: true },
			secondError: undefined,
			inputs: [
				{ method: 'click', params: { elementIndex: 3, button: 'right', clickCount: 2, modifiers: ['cmd'], pid: 200, windowId: 72 } },
				{ method: 'typeText', params: { text: 'hello', pid: 200 } },
			],
			grants: [{ bundleId: 'com.apple.Notes', grant: 'operate' }],
		});
	});

	test('never sends input to an app the user allowed only to read', async () => {
		const { helper, ledger, provider } = setup();
		// 初回の操作の求めに「読み取りのみ」
		const readOnly = createContext('pane', ['read']);
		const refused = await provider.callTool('pane-a', 'computer_press_key', { app: 'Notes', key: 'return' }, undefined, readOnly.context);
		const again = await provider.callTool('pane-a', 'computer_hotkey', { app: 'Notes', keys: ['cmd', 's'] }, undefined, readOnly.context);
		const read = await provider.callTool('pane-a', 'computer_list_windows', { app: 'Notes' }, undefined, readOnly.context) as IResult;
		// 読み取りを許可済みのアプリへの操作は格上げを聞き、断られたら読み取りだけ残す
		ledger.set('pane-b', 'com.apple.finder', 'read');
		const upgrade = createContext('pane', ['denied']);
		const declined = await provider.callTool('pane-b', 'computer_click', { app: 'Finder', x: 5, y: 5 }, undefined, upgrade.context);
		const afterDecline = await provider.callTool('pane-b', 'computer_scroll', { app: 'Finder', direction: 'down' }, undefined, upgrade.context);
		assert.deepStrictEqual({
			refused: text(refused).split('.')[0],
			again: text(again).split('.')[0],
			readError: read.isError,
			readOnlyPrompts: readOnly.prompts.map(entry => entry.prompt.requested),
			upgradePrompts: upgrade.prompts.map(entry => ({ requested: entry.prompt.requested, upgrade: entry.prompt.upgrade })),
			declined: text(declined).split('.')[0],
			afterDecline: text(afterDecline).split('.')[0],
			grants: [...ledger.listForPane('pane-a'), ...ledger.listForPane('pane-b')],
			inputs: helper.inputs,
		}, {
			refused: 'The user allowed this terminal pane only to read Notes, so Para Code does not send it any input',
			again: 'The user allowed this terminal pane only to read Notes, so Para Code does not send it any input',
			readError: undefined,
			readOnlyPrompts: ['operate'],
			upgradePrompts: [{ requested: 'operate', upgrade: true }],
			declined: 'The user allowed this terminal pane only to read Finder, so Para Code does not send it any input',
			afterDecline: 'The user allowed this terminal pane only to read Finder, so Para Code does not send it any input',
			grants: [{ bundleId: 'com.apple.Notes', grant: 'read' }, { bundleId: 'com.apple.finder', grant: 'read' }],
			inputs: [],
		});
	});

	test('refuses malformed input before asking the user and explains helper refusals', async () => {
		const { helper, ledger, provider } = setup();
		const { context, prompts } = createContext('pane', []);
		const noTarget = await provider.callTool('pane-a', 'computer_click', { app: 'Notes' }, undefined, context);
		const noText = await provider.callTool('pane-a', 'computer_type_text', { app: 'Notes', text: '' }, undefined, context);
		ledger.set('pane-a', 'com.apple.Notes', 'operate');
		const codes = ['user_active', 'window_not_focused', 'point_obscured', 'stale_element', 'key_blocked', 'accessibility_not_granted'];
		const messages: string[] = [];
		for (const code of codes) {
			helper.onInput = async () => { throw new ParadisComputerUseHelperError(code, 'Spotlight shortcuts are never sent'); };
			messages.push(text(await provider.callTool('pane-a', 'computer_hotkey', { app: 'Notes', keys: ['cmd', 'space'], includeState: false }, undefined, context)).split('.')[0]);
		}
		assert.deepStrictEqual({ noTarget: text(noTarget), noText: text(noText), prompts: prompts.length, messages }, {
			noTarget: 'Give "elementIndex" from computer_get_app_state, or "x" and "y".',
			noText: '"text" must be a non-empty string.',
			prompts: 0,
			messages: [
				'The user is using the keyboard or mouse right now, so Para Code did not send input',
				'The app is not in front (or another app took focus), so Para Code stopped before sending input',
				'Another window covers that point, so Para Code did not send input there',
				'That element number is not from the latest accessibility tree of this window',
				'Para Code never sends this shortcut (Spotlight shortcuts are never sent)',
				'macOS has not granted Accessibility to "Para Code Computer Use"',
			],
		});
	});

	test('sends input from all panes one at a time', async () => {
		const { helper, ledger, provider } = setup();
		ledger.set('pane-a', 'com.apple.Notes', 'operate');
		ledger.set('pane-b', 'com.apple.finder', 'operate');
		const events: string[] = [];
		let release: () => void = () => { };
		const firstHeld = new Promise<void>(resolve => release = resolve);
		helper.onInput = async method => {
			events.push(`start ${method}`);
			if (method === 'click') {
				await firstHeld;
			}
			events.push(`end ${method}`);
			return { ok: true };
		};
		const context = createContext('pane', []).context;
		const first = provider.callTool('pane-a', 'computer_click', { app: 'Notes', x: 1, y: 1, includeState: false }, undefined, context);
		const second = provider.callTool('pane-b', 'computer_press_key', { app: 'Finder', key: 'escape', includeState: false }, undefined, context);
		await new Promise(resolve => setTimeout(resolve, 20));
		const whileHeld = [...events];
		release();
		await Promise.all([first, second]);
		assert.deepStrictEqual({ whileHeld, events }, {
			whileHeld: ['start click'],
			events: ['start click', 'end click', 'start pressKey', 'end pressKey'],
		});
	});

	test('returns the window state after an action and says when the clipboard was not restored', async () => {
		const { helper, ledger, provider } = setup();
		ledger.set('pane-a', 'com.apple.Notes', 'operate');
		helper.onInput = async () => ({ pasted: true, clipboardRestored: false });
		const result = await provider.callTool('pane-a', 'computer_paste_text', { app: 'Notes', text: '日本語' }, undefined, createContext('pane', []).context) as IResult;
		assert.deepStrictEqual({
			summary: JSON.parse((result.content[0] as { text: string }).text),
			parts: result.content.map(part => part.type),
			calls: helper.calls,
		}, {
			summary: { app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 200 }, action: 'paste_text', pasted: true, clipboardRestored: false, note: 'Something else changed the clipboard while pasting, so the user\'s previous clipboard was not put back.' },
			parts: ['text', 'text', 'text', 'image'],
			calls: ['listApps', 'listWindows:200', 'pasteText:200', 'permissions', 'accessibilityTree:200/72', 'screenshotWindow:200/72'],
		});
	});
});
