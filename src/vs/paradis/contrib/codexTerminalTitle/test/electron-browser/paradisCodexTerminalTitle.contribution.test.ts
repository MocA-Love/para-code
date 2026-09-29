/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, strictEqual } from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { addTerminalTitleToTuiSection, classifyTrackableCodexCommand, createCodexTerminalTitle, ICodexTrackableCommand, isCodexTuiCommand, PARADIS_CODEX_TERMINAL_TITLE_MARKER, paradisUpdateCodexTerminalTitleConfig, removeParadisTerminalTitleFromTuiSection, resolveWritableCodexHome, writeCodexAccountHomes } from '../../electron-browser/paradisCodexTerminalTitle.contribution.js';

suite('ParadisCodexTerminalTitle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('writeCodexAccountHomes', () => {
		const home = (homePath: string, overrides: { isDefault?: boolean; signedIn?: boolean } = {}) => ({ homePath, label: homePath, isDefault: false, signedIn: true, ...overrides });

		test('keeps writing the other homes after one fails, and reports that not every home was written', async () => {
			const attempted: string[] = [];
			const allWritten = await writeCodexAccountHomes([
				home('/h/.codex', { isDefault: true }),
				home('/h/.codex-2'),
				home('/h/.codex-3'),
				home('/h/.codex-4', { signedIn: false }),
				home('/h/.codex-5'),
			], async uri => {
				attempted.push(uri.path);
				return uri.path !== '/h/.codex-3';
			});
			// false tells the caller not to record the home set, so the next account state retries it.
			deepStrictEqual({ attempted, allWritten }, { attempted: ['/h/.codex-2', '/h/.codex-3', '/h/.codex-5'], allWritten: false });
		});

		test('reports success when every home was written, which lets the caller stop retrying', async () => {
			strictEqual(await writeCodexAccountHomes([home('/h/.codex-2'), home('/h/.codex-3')], async () => true), true);
		});
	});

	suite('isCodexTuiCommand', () => {
		for (const command of [
			'codex',
			'/opt/homebrew/bin/codex',
			'codex.cmd',
			'"C:\\tools\\codex.cmd" resume',
			'codex "fix the terminal title"',
			'codex resume',
			'codex resume --last',
			'codex --model gpt-5 resume 019f4d58-4ce0-7f50-89a8-d2bbec6b2743',
			'codex --dangerously-bypass-approvals-and-sandbox',
		]) {
			test(`accepts ${command}`, () => strictEqual(isCodexTuiCommand(command), true));
		}

		for (const command of [
			'codex exec "fix it"',
			'codex app-server',
			'codex review',
			'env codex',
			'my-codex',
			'codex && echo spoofed',
			'codex | tee output',
			'codex "unterminated',
		]) {
			test(`rejects ${command}`, () => strictEqual(isCodexTuiCommand(command), false));
		}
	});

	suite('classifyTrackableCodexCommand', () => {
		function command(overrides: Partial<ICodexTrackableCommand> = {}): ICodexTrackableCommand {
			return { command: 'codex', commandLineConfidence: 'high', isTrusted: true, wasReplayed: false, cwd: '/workspace', ...overrides };
		}

		test('tracks a command line the shell vouched for', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command()), { invocation: 'start', cwd: '/workspace' });
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume' })), { invocation: 'resume', cwd: '/workspace' });
		});

		// A prompt that suppresses VS Code's shell integration (powerlevel10k unsets the flag that
		// enables it) leaves every command untrusted at 'medium', recovered from the screen buffer.
		// Refusing that left the feature dead for those users.
		test('tracks a command line recovered from the buffer', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command({ commandLineConfidence: 'medium', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
		});

		// The buffer contains autosuggestion ghost text, so `codex` under a `codex resume --last`
		// suggestion is recovered whole. Honouring that resume would waive the cwd check and put
		// another directory's thread on this tab.
		test('never grants resume to a command line the shell did not vouch for', () => {
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume --last', commandLineConfidence: 'medium', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
			// 'high' without the nonce is any OSC 633;E, so it is spoofable and gets the same treatment.
			deepStrictEqual(classifyTrackableCodexCommand(command({ command: 'codex resume --last', isTrusted: false })), { invocation: 'start', cwd: '/workspace' });
		});

		test('refuses a bare buffer guess', () => {
			strictEqual(classifyTrackableCodexCommand(command({ commandLineConfidence: 'low', isTrusted: false })), undefined);
			// An empty command line is what the buffer yields before anything is recovered.
			strictEqual(classifyTrackableCodexCommand(command({ command: '', commandLineConfidence: 'medium', isTrusted: false })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ command: '', commandLineConfidence: 'low', isTrusted: false })), undefined);
		});

		test('refuses replayed commands and non-absolute directories', () => {
			strictEqual(classifyTrackableCodexCommand(command({ wasReplayed: true })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ cwd: 'relative/path' })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ cwd: undefined })), undefined);
		});

		test('refuses commands that do not start the Codex TUI', () => {
			strictEqual(classifyTrackableCodexCommand(command({ command: 'codex exec "fix it"' })), undefined);
			strictEqual(classifyTrackableCodexCommand(command({ command: 'codex && echo spoofed' })), undefined);
		});
	});

	suite('createCodexTerminalTitle', () => {
		test('uses the first meaningful line and removes markdown decoration', () => {
			strictEqual(createCodexTerminalTitle('\n## Fix terminal title\nMore detail'), 'Fix terminal title');
		});

		test('truncates long titles', () => {
			strictEqual(createCodexTerminalTitle('1234567890123456789012345678901234567890'), '123456789012345678901234567890123456…');
		});

		test('removes terminal controls and bidirectional formatting', () => {
			strictEqual(createCodexTerminalTitle('Fix\u001b[31m title\u202e'), 'Fix title');
		});
	});

	suite('resolveWritableCodexHome', () => {
		const localHome = URI.file('/Users/example');
		const remoteAuthority = 'ssh-remote+box';
		const resolvedRemoteHome = URI.from({ scheme: Schemas.vscodeRemote, authority: remoteAuthority, path: '/home/example' });

		test('uses the raw home unchanged on a local window', () => {
			strictEqual(resolveWritableCodexHome(undefined, localHome)?.toString(), localHome.toString());
		});

		test('uses the remote home once it resolves to the connected host', () => {
			const result = resolveWritableCodexHome(remoteAuthority, resolvedRemoteHome);
			strictEqual(result?.toString(), resolvedRemoteHome.toString());
		});

		// userHome() が未解決の間に黙って手元へフォールバックした値をそのまま使うと、
		// 手元の ~/.codex/config.toml を書き換えてしまう (2026-08-19 のインシデント)。
		test('refuses to write when the remote window has not resolved its host yet', () => {
			strictEqual(resolveWritableCodexHome(remoteAuthority, localHome), undefined);
		});

		test('refuses a home that resolved to a different remote host', () => {
			const otherHost = URI.from({ scheme: Schemas.vscodeRemote, authority: 'ssh-remote+other', path: '/home/example' });
			strictEqual(resolveWritableCodexHome(remoteAuthority, otherHost), undefined);
		});
	});

	suite('addTerminalTitleToTuiSection', () => {
		const title = `terminal_title = ["app-name", "thread-title"] ${PARADIS_CODEX_TERMINAL_TITLE_MARKER}`;
		test('adds the key only where it is absent and keeps config.toml valid TOML', () => {
			deepStrictEqual({
				empty: addTerminalTitleToTuiSection(''),
				missing: addTerminalTitleToTuiSection('model = "x"\n'),
				// 利用者が決めた値（`/title` など）は上書きしない
				existingKey: addTerminalTitleToTuiSection('[tui]\nterminal_title = ["spinner"]\nx = 1\n'),
				existingQuotedKey: addTerminalTitleToTuiSection('[tui]\n"terminal_title" = []\n'),
				missingKey: addTerminalTitleToTuiSection('[tui]\nx = 1\n'),
				// `[tui]` が最後の行で改行が無い
				headerAtEnd: addTerminalTitleToTuiSection('model = "x"\n[tui]'),
				spacedHeader: addTerminalTitleToTuiSection('[ tui ] # comment\nx = 1\n'),
				// 最上位の dotted key や inline table で tui を定義済み（[tui] を足すと二重定義になる）
				dottedKey: addTerminalTitleToTuiSection('tui.notifications = true\n[profiles.a]\nmodel = "x"\n'),
				inlineTable: addTerminalTitleToTuiSection('tui = { notifications = true }\n'),
				// 他の表の下の dotted key は tui の定義ではない
				nestedDotted: addTerminalTitleToTuiSection('[profiles.a]\ntui.x = 1\n'),
				// 字下げした次の表の見出しを [tui] の中身と取り違えない
				indentedNextTable: addTerminalTitleToTuiSection('[tui]\nx = 1\n  [profiles.a]\nterminal_title = "keep"\n'),
			}, {
				empty: `[tui]\n${title}\n`,
				missing: `model = "x"\n\n[tui]\n${title}\n`,
				existingKey: '[tui]\nterminal_title = ["spinner"]\nx = 1\n',
				existingQuotedKey: '[tui]\n"terminal_title" = []\n',
				missingKey: `[tui]\n${title}\nx = 1\n`,
				headerAtEnd: `model = "x"\n[tui]\n${title}\n`,
				spacedHeader: `[ tui ] # comment\n${title}\nx = 1\n`,
				dottedKey: 'tui.notifications = true\n[profiles.a]\nmodel = "x"\n',
				inlineTable: 'tui = { notifications = true }\n',
				nestedDotted: `[profiles.a]\ntui.x = 1\n\n[tui]\n${title}\n`,
				indentedNextTable: `[tui]\n${title}\nx = 1\n  [profiles.a]\nterminal_title = "keep"\n`,
			});
		});
	});

	suite('removeParadisTerminalTitleFromTuiSection', () => {
		const title = `terminal_title = ["app-name", "thread-title"] ${PARADIS_CODEX_TERMINAL_TITLE_MARKER}`;
		test('removes only the value Para Code wrote', () => {
			deepStrictEqual({
				owned: removeParadisTerminalTitleFromTuiSection(`model = "x"\n\n[tui]\n${title}\nx = 1\n`),
				ownedLastLine: removeParadisTerminalTitleFromTuiSection(`[tui]\n${title}`),
				// 目印の無い同じ値は、利用者が書いたもの（または目印を付ける前の Para Code）とみなして残す
				sameValueWithoutMarker: removeParadisTerminalTitleFromTuiSection('[tui]\nterminal_title = ["app-name", "thread-title"]\n'),
				// 目印が残っていても値を変えていれば利用者のもの
				editedValue: removeParadisTerminalTitleFromTuiSection(`[tui]\nterminal_title = ["spinner"] ${PARADIS_CODEX_TERMINAL_TITLE_MARKER}\n`),
				// [tui] の外にある同じ行は tui の設定ではない
				otherTable: removeParadisTerminalTitleFromTuiSection(`[tui]\nx = 1\n[profiles.a]\n${title}\n`),
			}, {
				owned: 'model = "x"\n\n[tui]\nx = 1\n',
				ownedLastLine: '[tui]\n',
				sameValueWithoutMarker: '[tui]\nterminal_title = ["app-name", "thread-title"]\n',
				editedValue: `[tui]\nterminal_title = ["spinner"] ${PARADIS_CODEX_TERMINAL_TITLE_MARKER}\n`,
				otherTable: `[tui]\nx = 1\n[profiles.a]\n${title}\n`,
			});
		});

		test('turning the setting on and off again round-trips a config without [tui]', () => {
			const config = 'model = "x"\n';
			// 見出しは残る（利用者が書いた見出しかもしれないため）。空の表は正しい TOML
			strictEqual(removeParadisTerminalTitleFromTuiSection(addTerminalTitleToTuiSection(config)), 'model = "x"\n\n[tui]\n');
		});
	});

	suite('paradisUpdateCodexTerminalTitleConfig', () => {
		const home = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/home/example/.codex' });
		const configFile = joinPath(home, 'config.toml');
		const title = `terminal_title = ["app-name", "thread-title"] ${PARADIS_CODEX_TERMINAL_TITLE_MARKER}`;

		function createFileService(disposables: DisposableStore): FileService {
			const fileService = disposables.add(new FileService(new NullLogService()));
			disposables.add(fileService.registerProvider('vscode-remote', disposables.add(new InMemoryFileSystemProvider())));
			return fileService;
		}

		async function read(fileService: FileService): Promise<string | undefined> {
			return await fileService.exists(configFile) ? (await fileService.readFile(configFile)).value.toString() : undefined;
		}

		test('does not create the Codex home when it does not exist', async () => {
			const disposables = new DisposableStore();
			try {
				const fileService = createFileService(disposables);
				const result = await paradisUpdateCodexTerminalTitleConfig(fileService, home, true, async () => undefined);
				deepStrictEqual({ result, homeExists: await fileService.exists(home) }, { result: 'no-home', homeExists: false });
			} finally {
				disposables.dispose();
			}
		});

		test('writes where absent, keeps a user value, and removes only its own value when turned off', async () => {
			const disposables = new DisposableStore();
			try {
				const fileService = createFileService(disposables);
				await fileService.createFolder(home);
				const backups: string[] = [];
				const backup = async (file: URI) => { backups.push(file.path); };
				const created = await paradisUpdateCodexTerminalTitleConfig(fileService, home, true, backup);
				const afterCreate = await read(fileService);
				const again = await paradisUpdateCodexTerminalTitleConfig(fileService, home, true, backup);
				const removed = await paradisUpdateCodexTerminalTitleConfig(fileService, home, false, backup);
				const afterRemove = await read(fileService);
				await fileService.writeFile(configFile, VSBuffer.fromString('[tui]\nterminal_title = ["spinner"]\n'));
				const userValueOn = await paradisUpdateCodexTerminalTitleConfig(fileService, home, true, backup);
				const userValueOff = await paradisUpdateCodexTerminalTitleConfig(fileService, home, false, backup);
				deepStrictEqual({ created, afterCreate, again, removed, afterRemove, userValueOn, userValueOff, userValue: await read(fileService), backups }, {
					created: 'written',
					afterCreate: `[tui]\n${title}\n`,
					again: 'unchanged',
					removed: 'written',
					afterRemove: '[tui]\n',
					userValueOn: 'unchanged',
					userValueOff: 'unchanged',
					userValue: '[tui]\nterminal_title = ["spinner"]\n',
					// 新しく作ったときは控えるものが無い
					backups: [configFile.path],
				});
			} finally {
				disposables.dispose();
			}
		});

		test('re-reads and keeps a concurrent write made while it was updating', async () => {
			const disposables = new DisposableStore();
			try {
				const fileService = createFileService(disposables);
				await fileService.createFolder(home);
				await fileService.writeFile(configFile, VSBuffer.fromString('model = "x"\n'));
				let concurrentWrites = 0;
				// 控えを取っている間に、Codex の trust 書き込みが同じファイルへ書いたことにする
				const result = await paradisUpdateCodexTerminalTitleConfig(fileService, home, true, async () => {
					if (concurrentWrites++ === 0) {
						await fileService.writeFile(configFile, VSBuffer.fromString('model = "x"\n\n[projects."/work"]\ntrust_level = "trusted"\n'));
					}
				});
				deepStrictEqual({ result, concurrentWrites, config: await read(fileService) }, {
					result: 'written',
					concurrentWrites: 2,
					config: `model = "x"\n\n[projects."/work"]\ntrust_level = "trusted"\n\n[tui]\n${title}\n`,
				});
			} finally {
				disposables.dispose();
			}
		});
	});
});
