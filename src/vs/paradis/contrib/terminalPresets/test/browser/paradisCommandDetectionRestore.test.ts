/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal } from '@xterm/xterm';
import assert from 'assert';
import { importAMDNodeModule } from '../../../../../amdX.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ISerializedCommandDetectionCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { CommandDetectionCapability } from '../../../../../platform/terminal/common/capabilities/commandDetectionCapability.js';
import { TestXtermLogger } from '../../../../../platform/terminal/test/common/terminalTestHelpers.js';
import { writeP } from '../../../../../workbench/contrib/terminal/browser/terminalTestHelpers.js';

/**
 * 接続し直したターミナルが、切り離す前に実行中だったコマンドを覚えているか（シェル統合の状態の
 * 保存と復元。再生される画面には OSC 633 が含まれない）。
 */
suite('paradis command detection restore', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createTerminal(): Promise<{ xterm: Terminal; capability: CommandDetectionCapability }> {
		const TerminalCtor = (await importAMDNodeModule<typeof import('@xterm/xterm')>('@xterm/xterm', 'lib/xterm.js')).Terminal;
		const xterm = store.add(new TerminalCtor({ allowProposedApi: true, cols: 80, logger: TestXtermLogger }));
		const capability = store.add(new CommandDetectionCapability(xterm, new NullLogService()));
		return { xterm, capability };
	}

	/** 切り離す前のターミナルでプロンプトを出し、`command` を入力する（`execute` なら実行まで進める）。 */
	async function serializeAfterTyping(command: string, execute: boolean, commandLineFromShell = true): Promise<ISerializedCommandDetectionCapability> {
		const { xterm, capability } = await createTerminal();
		capability.handlePromptStart();
		await writeP(xterm, '$ ');
		capability.handleCommandStart();
		await writeP(xterm, command);
		if (execute) {
			if (commandLineFromShell) {
				capability.setCommandLine(command, true);
			}
			capability.handleCommandExecuted();
			await writeP(xterm, '\r\n');
		}
		return capability.serialize();
	}

	/** 再生された画面（シェル統合の印は無い）に状態を戻す。 */
	async function restore(serialized: ISerializedCommandDetectionCapability, screen: string): Promise<{ xterm: Terminal; capability: CommandDetectionCapability }> {
		const restored = await createTerminal();
		await writeP(restored.xterm, screen);
		restored.capability.deserialize(serialized);
		return restored;
	}

	test('keeps a running command across serialize and deserialize, and finishes it with the next D', async () => {
		const { capability } = await restore(await serializeAfterTyping('sleep 1000', true), '$ sleep 1000\r\n');
		const afterRestore = { executing: capability.executingCommand, trusted: capability.executingCommandObject?.isTrusted };
		capability.handleCommandFinished(0);
		assert.deepStrictEqual({
			afterRestore,
			afterFinish: { executing: capability.executingCommand, finished: capability.commands.map(command => [command.command, command.exitCode]) },
		}, {
			afterRestore: { executing: 'sleep 1000', trusted: true },
			afterFinish: { executing: undefined, finished: [['sleep 1000', 0]] },
		});
	});

	test('keeps a running command that did not come from OSC 633;E untrusted', async () => {
		const { capability } = await restore(await serializeAfterTyping('sleep 1000', true, false), '$ sleep 1000\r\n');
		assert.deepStrictEqual(
			{ executing: capability.executingCommand, trusted: capability.executingCommandObject?.isTrusted },
			{ executing: 'sleep 1000', trusted: false },
		);
	});

	test('does not mark a command that was only typed at the prompt as running', async () => {
		const { capability } = await restore(await serializeAfterTyping('sleep 1000', false), '$ sleep 1000');
		assert.strictEqual(capability.executingCommand, undefined);
	});
});
