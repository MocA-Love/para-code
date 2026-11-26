/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, paradisParsePromptStandIn, paradisPromptStandInMessage } from '../../common/paradisBrowserViewPrompt.js';
import { IParadisPromptView, PARADIS_KEEP_PAGE_MAX_MS, ParadisPromptStandIn, paradisArmKeepPage, paradisAttachPromptStandIn, paradisDisarmKeepPage, paradisTakeKeepPage } from '../../electron-main/paradisBrowserViewDialogs.js';

type IpcListener = (event: { returnValue: unknown }, ...args: unknown[]) => void;
type MessageListener = (event: unknown, method: string, params: unknown) => void;

/** The parts of a browser view the prompt stand-in uses, driven by the test. */
class FakeView implements IParadisPromptView {
	readonly ipcListeners = new Map<string, IpcListener[]>();
	messageListeners: MessageListener[] = [];
	readonly commands: string[] = [];
	readonly onDidDetach = new Emitter<void>();
	destroyed = false;
	failEnable = false;

	readonly webContents = {
		ipc: {
			on: (channel: string, listener: IpcListener) => { this.ipcListeners.set(channel, [...this.ipcListeners.get(channel) ?? [], listener]); },
			removeListener: (channel: string, listener: IpcListener) => { this.ipcListeners.set(channel, (this.ipcListeners.get(channel) ?? []).filter(candidate => candidate !== listener)); },
		},
		debugger: {
			on: (_event: 'message', listener: MessageListener) => { this.messageListeners.push(listener); },
			removeListener: (_event: 'message', listener: MessageListener) => { this.messageListeners = this.messageListeners.filter(candidate => candidate !== listener); },
		},
		isDestroyed: () => this.destroyed,
	};

	readonly debugger = {
		sendCommandRaw: (method: string): Promise<unknown> => {
			this.commands.push(method);
			return this.failEnable ? Promise.reject(new Error('detached')) : Promise.resolve({});
		},
		onDidDetach: (listener: () => void) => this.onDidDetach.event(listener),
	};

	/** The preload sends one of the two synchronous IPCs. Returns the event whose `returnValue` the main process sets. */
	send(channel: string, ...args: unknown[]): { returnValue: unknown } {
		const event: { returnValue: unknown } = { returnValue: 'unset' };
		for (const listener of this.ipcListeners.get(channel) ?? []) {
			listener(event, ...args);
		}
		return event;
	}

	/** Chromium reports that a dialog of the page closed. */
	closed(result: boolean, userInput: string): void {
		for (const listener of this.messageListeners) {
			listener({}, 'Page.javascriptDialogClosed', { result, userInput });
		}
	}
}

suite('paradisBrowserViewDialogs (window.prompt and beforeunload of the built-in browser)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the text of the stand-in confirm carries the message and the default value, and an ordinary confirm is not taken for one', () => {
		const shown = paradisPromptStandInMessage('Your "name"?\nPlease', 'gu"est\\', 'OK answers with the default value.');
		assert.deepStrictEqual({
			shown,
			parsed: paradisParsePromptStandIn(shown),
			empty: paradisParsePromptStandIn(paradisPromptStandInMessage('', '', 'hint')),
			ordinary: [paradisParsePromptStandIn('Delete the draft?'), paradisParsePromptStandIn('x\n\n[prompt() default: unquoted] hint'), paradisParsePromptStandIn('x\n\n[prompt() default: "a"] hint\nmore')],
		}, {
			shown: 'Your "name"?\nPlease\n\n[prompt() default: "gu\\"est\\\\"] OK answers with the default value.',
			parsed: { message: 'Your "name"?\nPlease', defaultPrompt: 'gu"est\\' },
			empty: { message: '', defaultPrompt: '' },
			ordinary: [undefined, undefined, undefined],
		});
	});

	test('a prompt returns the text a CDP client accepted the stand-in confirm with, the default value for a plain OK, and null for Cancel', () => {
		const view = new FakeView();
		store.add(view.onDidDetach);
		store.add(paradisAttachPromptStandIn(view));
		const run = (answer: { result: boolean; userInput: string } | undefined, accepted: boolean) => {
			const begin = view.send(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, 'Your name?', 'guest');
			// the page is blocked until this IPC is answered, so the answer must not wait for anything
			const answeredAtOnce = typeof begin.returnValue === 'string' && begin.returnValue !== 'unset';
			if (answer) {
				view.closed(answer.result, answer.userInput);
			}
			const end = view.send(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, accepted);
			return { answeredAtOnce, shown: paradisParsePromptStandIn(String(begin.returnValue)), result: end.returnValue };
		};
		const expected = { message: 'Your name?', defaultPrompt: 'guest' };
		assert.deepStrictEqual({
			// handle_dialog accept with promptText
			withText: run({ result: true, userInput: 'Ada' }, true),
			// a person presses OK, or handle_dialog accept without a text
			plainOk: run({ result: true, userInput: '' }, true),
			cancel: run({ result: false, userInput: '' }, false),
			// the Page domain is enabled once, not at every prompt
			commands: view.commands,
			endWithoutBegin: view.send(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, true).returnValue,
		}, {
			withText: { answeredAtOnce: true, shown: expected, result: 'Ada' },
			plainOk: { answeredAtOnce: true, shown: expected, result: 'guest' },
			cancel: { answeredAtOnce: true, shown: expected, result: null },
			commands: ['Page.enable'],
			endWithoutBegin: null,
		});
	});

	test('the result waits a moment for the closing event, falls back to the default value, and the Page domain is enabled again after a detach', async () => {
		const view = new FakeView();
		store.add(view.onDidDetach);
		const attached = paradisAttachPromptStandIn(view, 20);
		view.send(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, 'Name?', 'guest');
		// the page reports the confirm as accepted before the event arrived
		const late = view.send(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, true);
		const whileWaiting = late.returnValue;
		view.closed(true, 'late text');
		// the event never arrives (the debugger could not be attached)
		view.onDidDetach.fire();
		view.failEnable = true;
		const begin = view.send(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, 'Name?', 'fallback');
		const never = view.send(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, true);
		await timeout(60);
		// a waiting prompt returns when the view goes away
		view.send(PARADIS_BROWSER_VIEW_PROMPT_BEGIN_CHANNEL, 'Name?', 'x');
		const pending = view.send(PARADIS_BROWSER_VIEW_PROMPT_END_CHANNEL, true);
		attached.dispose();
		assert.deepStrictEqual({
			whileWaiting, late: late.returnValue, shownWithoutPageDomain: typeof begin.returnValue, never: never.returnValue, afterDispose: pending.returnValue,
			commands: view.commands,
			listenersLeft: [...view.ipcListeners.values()].flat().length + view.messageListeners.length,
		}, {
			whileWaiting: 'unset', late: 'late text', shownWithoutPageDomain: 'string', never: 'fallback', afterDispose: null,
			commands: ['Page.enable', 'Page.enable', 'Page.enable'],
			listenersLeft: 0,
		});
	});

	test('one closing event answers one prompt: a later prompt does not reuse it', () => {
		const standIn = new ParadisPromptStandIn('hint', 5);
		const results: (string | null)[] = [];
		standIn.dialogClosed({ result: true, userInput: 'stale, before any prompt' });
		standIn.begin('first', 'one');
		standIn.dialogClosed({ result: true, userInput: 'answer' });
		standIn.dialogClosed({ result: true, userInput: 'another dialog of the page' });
		standIn.end(true, value => results.push(value));
		standIn.begin('second', 'two');
		standIn.dialogClosed({ result: true, userInput: '' });
		standIn.end(true, value => results.push(value));
		assert.deepStrictEqual(results, ['answer', 'two']);
	});

	test('keeping the page on beforeunload works for one navigation only and for a limited time', () => {
		const tab = {};
		const other = {};
		const neverArmed = paradisTakeKeepPage(tab, 0);
		paradisArmKeepPage(tab, 1_000, 0);
		const otherTab = paradisTakeKeepPage(other, 10);
		const first = paradisTakeKeepPage(tab, 10);
		const second = paradisTakeKeepPage(tab, 20);
		const kept = paradisDisarmKeepPage(tab);
		paradisArmKeepPage(tab, 1_000, 0);
		const expired = paradisTakeKeepPage(tab, 1_001);
		const unusedDisarm = paradisDisarmKeepPage(tab);
		// a caller cannot arm it for longer than the limit
		paradisArmKeepPage(tab, Number.MAX_SAFE_INTEGER, 0);
		const pastLimit = paradisTakeKeepPage(tab, PARADIS_KEEP_PAGE_MAX_MS + 1);
		paradisArmKeepPage(tab, 1_000, 0);
		paradisDisarmKeepPage(tab);
		const afterDisarm = paradisTakeKeepPage(tab, 10);
		assert.deepStrictEqual({ neverArmed, otherTab, first, second, kept, expired, unusedDisarm, pastLimit, afterDisarm }, {
			neverArmed: false, otherTab: false, first: true, second: false, kept: true, expired: false, unusedDisarm: false, pastLimit: false, afterDisarm: false,
		});
	});
});
