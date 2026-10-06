/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { PARADIS_RESUME_LEDGER_TTL_MS, paradisCodexThreadIdFromTitle, paradisParseResumeLedger, paradisRestoredShellWasRestarted, paradisResumeCommandLine, paradisResumeLedgerKey, paradisResumeNeedsFolderChange, paradisChangeDirectoryBeforeResume, ParadisChangeDirectoryOutcome, paradisResumeTitleFromTab, paradisSerializeResumeLedger } from '../../common/paradisTerminalResumeBanner.js';

suite('paradisTerminalResumeBanner', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds resume and CLI fork commands only for ids that cannot be read as options', () => {
		assert.deepStrictEqual({
			claudeResume: paradisResumeCommandLine('claude', 'a1b2c3d4-0000-4000-8000-000000000001', 'resume'),
			claudeFork: paradisResumeCommandLine('claude', 'a1b2c3d4-0000-4000-8000-000000000001', 'fork'),
			codexResume: paradisResumeCommandLine('codex', '0199aaaa-0000-7000-8000-000000000002', 'resume'),
			codexFork: paradisResumeCommandLine('codex', '0199aaaa-0000-7000-8000-000000000002', 'fork'),
			option: paradisResumeCommandLine('claude', '--dangerously-skip-permissions', 'resume'),
			shell: paradisResumeCommandLine('codex', 'abc; rm -rf ~', 'fork'),
		}, {
			claudeResume: 'claude --permission-mode manual --resume a1b2c3d4-0000-4000-8000-000000000001',
			claudeFork: 'claude --permission-mode manual --resume a1b2c3d4-0000-4000-8000-000000000001 --fork-session',
			codexResume: 'codex resume 0199aaaa-0000-7000-8000-000000000002',
			codexFork: 'codex fork 0199aaaa-0000-7000-8000-000000000002',
			option: undefined,
			shell: undefined,
		});
	});

	test('round-trips the ledger keyed by a token hash and drops broken, expired and unsafe rows', () => {
		const now = 1_800_000_000_000;
		const kept = { agent: 'claude' as const, sessionId: 'session-1', cwd: '/Users/example/repo', title: 'Fix login', at: now - 1000 };
		const raw = JSON.stringify([
			{ token: 'token-a', ...kept },
			{ token: 'token-b', agent: 'codex', sessionId: 'session-2', at: now - PARADIS_RESUME_LEDGER_TTL_MS - 1 },
			{ token: 'token-c', agent: 'gemini', sessionId: 'session-3', at: now },
			{ token: 'token-d', agent: 'codex', sessionId: '-x', at: now },
			'garbage',
		]);
		// 前の版はトークンをそのままキーにしていた。読んだ時点でハッシュへ置き換え、書き出しにも残さない。
		const parsed = paradisParseResumeLedger(raw, now);
		const key = paradisResumeLedgerKey('token-a');
		const serialized = paradisSerializeResumeLedger(parsed);
		assert.deepStrictEqual({
			parsed: [...parsed],
			roundTrip: [...paradisParseResumeLedger(serialized, now)],
			tokenWritten: serialized.includes('token-a'),
			keyShape: /^[0-9a-f]{40}$/.test(key),
			broken: paradisParseResumeLedger('{not json', now).size,
		}, {
			parsed: [[key, kept]],
			roundTrip: [[key, kept]],
			tokenWritten: false,
			keyShape: true,
			broken: 0,
		});
	});

	test('reads the conversation name and the Codex thread id from the tab title', () => {
		assert.deepStrictEqual({
			claudeWorking: paradisResumeTitleFromTab('⠐ Fix the login check'),
			claudeIdle: paradisResumeTitleFromTab('✳ Fix the login check'),
			shell: paradisResumeTitleFromTab('zsh'),
			agentName: paradisResumeTitleFromTab('Claude Code'),
			codexThread: paradisResumeTitleFromTab('codex | 0199aaaa-0000-7000-8000-000000000002'),
			threadId: paradisCodexThreadIdFromTitle('codex | 0199aaaa-0000-7000-8000-000000000002'),
			notThread: paradisCodexThreadIdFromTitle('codex'),
		}, {
			claudeWorking: 'Fix the login check',
			claudeIdle: 'Fix the login check',
			shell: undefined,
			agentName: undefined,
			codexThread: undefined,
			threadId: '0199aaaa-0000-7000-8000-000000000002',
			notThread: undefined,
		});
	});

	test('treats only a shell that was started again as having lost its agent', () => {
		assert.deepStrictEqual({
			restarted: paradisRestoredShellWasRestarted(100, 200, false),
			reloaded: paradisRestoredShellWasRestarted(100, 100, false),
			adoptedByDaemon: paradisRestoredShellWasRestarted(100, 200, true),
			unknownPrevious: paradisRestoredShellWasRestarted(undefined, 200, false),
			notReady: paradisRestoredShellWasRestarted(100, undefined, false),
		}, {
			restarted: true,
			reloaded: false,
			adoptedByDaemon: false,
			unknownPrevious: false,
			notReady: false,
		});
	});

	// 違うフォルダで `claude --resume` すると会話がそのフォルダのプロジェクトへ複製される。
	// 今のフォルダが分からないときは、移ってから再開する側へ倒す。
	test('decides whether the tab has to move to the conversation folder before resuming', () => {
		assert.deepStrictEqual({
			same: paradisResumeNeedsFolderChange('/Users/example/app', '/Users/example/app'),
			trailingSlash: paradisResumeNeedsFolderChange('/Users/example/app/', '/Users/example/app'),
			elsewhere: paradisResumeNeedsFolderChange('/Users/example/app', '/Users/example/other'),
			unknownNow: paradisResumeNeedsFolderChange('/Users/example/app', undefined),
			notRecorded: paradisResumeNeedsFolderChange(undefined, '/Users/example/other'),
			root: paradisResumeNeedsFolderChange('/', '/'),
			windowsCase: paradisResumeNeedsFolderChange('C:\\Users\\Example\\App', 'c:/users/example/app/'),
			caseMatters: paradisResumeNeedsFolderChange('/Users/example/App', '/Users/example/app'),
		}, {
			same: false,
			trailingSlash: false,
			elsewhere: true,
			unknownNow: true,
			notRecorded: false,
			root: false,
			windowsCase: false,
			caseMatters: true,
		});
	});

	// `cd` の最中に打った文字は、シェルが次のプロンプトで読むまで入力欄に出てこない。終了だけ見て
	// 再開コマンドを送ると、先打ちの文字とつながって Enter を押していないのに実行された（実機で 2/2）。
	test('resumes only after the next prompt is ready and nothing was typed while moving', () => runWithFakedTimers({}, async () => {
		const run = async (script: 'normal' | 'typed' | 'typedAfterPrompt' | 'failed' | 'noPrompt' | 'pendingInput' | 'sameChunk') => {
			const onCommandFinished = new Emitter<{ readonly exitCode: number | undefined }>();
			const onPromptInputStarted = new Emitter<void>();
			const onInput = new Emitter<string>();
			const log: string[] = [];
			let promptText = '';
			try {
				const outcome = paradisChangeDirectoryBeforeResume({
					onCommandFinished: onCommandFinished.event,
					onPromptInputStarted: onPromptInputStarted.event,
					onInput: onInput.event,
					send: async text => {
						log.push(`send:${text}`);
						onInput.fire(`${text}\r`);
						// 端末の自動応答（カーソル位置の報告など）は打った文字ではない。
						onInput.fire('\x1b[12;1R');
						if (script === 'typed') {
							onInput.fire('echo typed');
						}
						if (script === 'sameChunk') {
							// 終了と次のプロンプトの入力開始が同じかたまりで届く。
							onCommandFinished.fire({ exitCode: 0 });
							onPromptInputStarted.fire();
							return;
						}
						setTimeout(() => {
							onCommandFinished.fire({ exitCode: script === 'failed' ? 1 : 0 });
							if (script !== 'noPrompt' && script !== 'failed') {
								setTimeout(() => {
									onPromptInputStarted.fire();
									log.push('prompt');
									if (script === 'typedAfterPrompt') {
										onInput.fire('l');
									}
									if (script === 'pendingInput') {
										promptText = 'ls';
									}
								}, 30);
							}
						}, 20);
					},
					isAtEmptyPrompt: () => promptText.length === 0,
					confirmFolder: async () => true,
				}, `cd '/Users/example/app'`, { finishMs: 5_000, promptMs: 2_000, settleMs: 250 });
				const result: ParadisChangeDirectoryOutcome = await outcome;
				log.push(`outcome:${result}`);
				return log;
			} finally {
				onCommandFinished.dispose();
				onPromptInputStarted.dispose();
				onInput.dispose();
			}
		};

		assert.deepStrictEqual({
			normal: await run('normal'),
			sameChunk: await run('sameChunk'),
			typed: await run('typed'),
			typedAfterPrompt: await run('typedAfterPrompt'),
			pendingInput: await run('pendingInput'),
			failed: await run('failed'),
			noPrompt: await run('noPrompt'),
		}, {
			// 次のプロンプトが入力を待ち始めてから結果が出る（その前に再開コマンドを送らない）。
			normal: [`send:cd '/Users/example/app'`, 'prompt', 'outcome:moved'],
			sameChunk: [`send:cd '/Users/example/app'`, 'outcome:moved'],
			typed: [`send:cd '/Users/example/app'`, 'prompt', 'outcome:typed'],
			typedAfterPrompt: [`send:cd '/Users/example/app'`, 'prompt', 'outcome:typed'],
			pendingInput: [`send:cd '/Users/example/app'`, 'prompt', 'outcome:typed'],
			failed: [`send:cd '/Users/example/app'`, 'outcome:failed'],
			noPrompt: [`send:cd '/Users/example/app'`, 'outcome:not-ready'],
		});
	}));
});
