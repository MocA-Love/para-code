/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisModelSwitchTerminal, ParadisAgentModelSwitchGuard } from '../../electron-browser/paradisAgentModelSwitchGuard.js';

interface ISentText { readonly text: string; readonly execute: boolean; readonly bracketed: boolean | undefined }

class FakeTerminal implements IParadisModelSwitchTerminal {
	readonly instanceId = 1;
	private readonly dataEmitter: Emitter<string>;
	readonly onData: Event<string>;
	readonly sent: ISentText[] = [];
	constructor(dataEmitter: Emitter<string>) {
		this.dataEmitter = dataEmitter;
		this.onData = this.dataEmitter.event;
	}
	async sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean): Promise<void> {
		this.sent.push({ text, execute: shouldExecute, bracketed: bracketedPasteMode });
	}
	emitData(data: string): void {
		this.dataEmitter.fire(data);
	}
}

async function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitUntil timed out');
		}
		await new Promise<void>(resolve => setTimeout(resolve, 1));
	}
}

suite('ParadisAgentModelSwitchGuard', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const noDelay = () => Promise.resolve();
	const DIALOG = '\x1b[1mSwitch model?\x1b[0m';

	function createTerminal(): FakeTerminal {
		return new FakeTerminal(store.add(new Emitter<string>()));
	}

	function createGuard(timing: { watchMs: number; graceMs: number }): ParadisAgentModelSwitchGuard {
		return store.add(new ParadisAgentModelSwitchGuard(new NullLogService(), timing));
	}

	test('clears leftover input, splits paste and enter, and auto-confirms the dialog', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 1_000 });
		const done = guard.execute(terminal, '/model claude-sonnet-5', async () => true, noDelay);
		// 貼り付け（execute=false）と Enter が分離されて届くのを待ってからダイアログを描画する
		await waitUntil(() => terminal.sent.length === 3);
		terminal.emitData(DIALOG);
		await done;
		assert.deepStrictEqual(terminal.sent, [
			{ text: '\u0015', execute: false, bracketed: undefined },
			{ text: '/model claude-sonnet-5', execute: false, bracketed: true },
			{ text: '\r', execute: false, bracketed: false },
			{ text: '\r', execute: false, bracketed: undefined },
		]);
	});

	test('resolves as success when no dialog appears within the grace period', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 5 });
		await guard.execute(terminal, '/effort high', async () => true, noDelay);
		// ダイアログなし → 自動確定の Enter は送られない（クリア・貼り付け・Enter の3件のみ）
		assert.strictEqual(terminal.sent.length, 3);
	});

	test('still auto-confirms a dialog that appears after the grace resolution', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 5 });
		await guard.execute(terminal, '/model claude-opus-4-8', async () => true, noDelay);
		assert.strictEqual(terminal.sent.length, 3);
		terminal.emitData(DIALOG);
		await waitUntil(() => terminal.sent.length === 4);
		assert.deepStrictEqual(terminal.sent[3], { text: '\r', execute: false, bracketed: undefined });
	});

	test('rejects without submitting when the session changes before enter', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 1_000 });
		let validations = 0;
		await assert.rejects(
			guard.execute(terminal, '/model claude-sonnet-5', async () => ++validations === 1, noDelay),
			/session changed before submission/);
		// クリアと貼り付けまでで止まり、Enter は送られない
		assert.deepStrictEqual(terminal.sent.map(s => s.text), ['\u0015', '/model claude-sonnet-5']);
	});

	test('rejects a non-switch command without touching the terminal', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 1_000 });
		await assert.rejects(guard.execute(terminal, '/help', async () => true, noDelay), /Unsupported/);
		await assert.rejects(guard.execute(terminal, '/model', async () => true, noDelay), /Unsupported/);
		assert.strictEqual(terminal.sent.length, 0);
	});

	test('maybeArm confirms a dialog only for switch commands', async () => {
		const terminal = createTerminal();
		const guard = createGuard({ watchMs: 1_000, graceMs: 1_000 });
		guard.maybeArm(terminal, 'hello world');
		terminal.emitData(DIALOG);
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		assert.strictEqual(terminal.sent.length, 0);
		guard.maybeArm(terminal, '/model claude-sonnet-5');
		terminal.emitData(DIALOG);
		await waitUntil(() => terminal.sent.length === 1);
		assert.deepStrictEqual(terminal.sent[0], { text: '\r', execute: false, bracketed: undefined });
	});
});
