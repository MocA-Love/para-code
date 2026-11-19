/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisResumeSession, paradisAgentResumeCommandLine } from '../../../sessionResume/common/paradisSessionResume.js';
import { PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY } from '../../common/paradisAgentApprovalOptions.js';
import { ParadisMobileCapability, PARADIS_MOBILE_PC_CAPABILITIES } from '../../common/paradisMobileCompat.js';
import { IParadisTerminalCommandEvidence, PARADIS_AGENT_RESUME_CAPABILITY, PARADIS_AGENT_SESSION_KEY_PATTERN, paradisAgentSessionKey, paradisAntigravityConversationLeftPane, paradisAntigravityPaneHoldsConversation, paradisLiveSessionTerminalKeys, paradisMobileAgentSessionMatches, paradisMobileAgentSessionView, PARADIS_RESUME_STALE_START_MS, paradisRecordResumeRequest, paradisResumedSessionOfCommand, paradisResumeRequestVerdict } from '../../common/paradisMobileAgentResume.js';

suite('paradisMobileAgentResume (W2-29)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const session: IParadisResumeSession = {
		catalogId: 'catalog-1', id: '0f7c1d2e-session', agent: 'claude', title: 'ログイン画面の\n修正', preview: '最初の依頼',
		latestMessage: { role: 'assistant', text: '直しました。テストも通っています' },
		cwd: '/Users/example/projects/demo', spaceStateKey: 'repo-1', spaceName: 'demo', currentSpace: false,
		createdAt: 1_760_000_000_000, updatedAt: 1_760_000_100_000, archived: false, gitBranch: 'fix/login',
	};

	test('advertises the capabilities of lane L3 under the names the feature files use', () => {
		assert.deepStrictEqual({
			approval: PARADIS_AGENT_APPROVAL_OPTIONS_CAPABILITY === ParadisMobileCapability.AgentApprovalOptions,
			resume: PARADIS_AGENT_RESUME_CAPABILITY === ParadisMobileCapability.AgentResume,
			advertised: [ParadisMobileCapability.AgentApprovalOptions, ParadisMobileCapability.AgentHistoryPage, ParadisMobileCapability.AgentResume].every(name => PARADIS_MOBILE_PC_CAPABILITIES.includes(name)),
		}, { approval: true, resume: true, advertised: true });
	});

	test('makes a stable fingerprint per agent and session that the phone cannot turn back into the id', () => {
		const key = paradisAgentSessionKey('claude', '0f7c1d2e-session');
		assert.deepStrictEqual({
			stable: key === paradisAgentSessionKey('claude', '0f7c1d2e-session'),
			shape: PARADIS_AGENT_SESSION_KEY_PATTERN.test(key),
			perAgent: key !== paradisAgentSessionKey('codex', '0f7c1d2e-session'),
			containsId: key.includes('0f7c1d2e'),
		}, { stable: true, shape: true, perAgent: true, containsId: false });
	});

	test('sends only what the list needs to the phone (no session id, path or catalog id)', () => {
		const view = paradisMobileAgentSessionView(session, 'terminal-key-1');
		assert.deepStrictEqual(view, {
			key: paradisAgentSessionKey('claude', '0f7c1d2e-session'),
			agent: 'claude',
			title: 'ログイン画面の 修正',
			preview: '直しました。テストも通っています',
			previewRole: 'assistant',
			updatedAt: 1_760_000_100_000,
			createdAt: 1_760_000_000_000,
			branch: 'fix/login',
			terminalKey: 'terminal-key-1',
		});
		assert.strictEqual(JSON.stringify(view).includes('/Users/example'), false);
	});

	test('filters by every word in the title, the last message or the branch', () => {
		const view = paradisMobileAgentSessionView(session, undefined);
		assert.deepStrictEqual({
			none: paradisMobileAgentSessionMatches(view, undefined),
			title: paradisMobileAgentSessionMatches(view, 'ログイン'),
			both: paradisMobileAgentSessionMatches(view, 'ログイン テスト'),
			branch: paradisMobileAgentSessionMatches(view, 'FIX/LOGIN'),
			miss: paradisMobileAgentSessionMatches(view, 'ログイン 決済'),
		}, { none: true, title: true, both: true, branch: true, miss: false });
	});

	test('recognizes a terminal that is resuming a session from its running command line (M6)', () => {
		assert.deepStrictEqual({
			claude: paradisResumedSessionOfCommand('claude --resume 0f7c1d2e-session'),
			claudeShort: paradisResumedSessionOfCommand(`claude -r '0f7c1d2e-session' --model opus`),
			claudeEquals: paradisResumedSessionOfCommand('claude --resume=0f7c1d2e-session'),
			codex: paradisResumedSessionOfCommand('codex resume 019a-thread'),
			// Para Code が打つ再開（確認ありの権限を明示した形）も、同じ会話として読む
			codexWithPermissions: paradisResumedSessionOfCommand(paradisAgentResumeCommandLine('codex', '019a-thread', 'resume') ?? ''),
			codexForkWithPermissions: paradisResumedSessionOfCommand(paradisAgentResumeCommandLine('codex', '019a-thread', 'fork') ?? ''),
			fork: paradisResumedSessionOfCommand('claude --resume 0f7c1d2e-session --fork-session'),
			picker: paradisResumedSessionOfCommand('claude --resume --model opus'),
			fresh: paradisResumedSessionOfCommand('claude'),
			other: paradisResumedSessionOfCommand('npm test'),
			antigravity: paradisResumedSessionOfCommand(paradisAgentResumeCommandLine('antigravity', '11111111-1111-4111-8111-111111111111', 'resume') ?? ''),
			antigravityEquals: paradisResumedSessionOfCommand(`agy --model gemini-3.8-flash-high --conversation='11111111-1111-4111-8111-111111111111'`),
			antigravityNew: paradisResumedSessionOfCommand('agy -i "hello"'),
			antigravityPrint: paradisResumedSessionOfCommand('agy -p hi --conversation 11111111-1111-4111-8111-111111111111'),
		}, {
			claude: { agent: 'claude', sessionId: '0f7c1d2e-session' },
			claudeShort: { agent: 'claude', sessionId: '0f7c1d2e-session' },
			claudeEquals: { agent: 'claude', sessionId: '0f7c1d2e-session' },
			codex: { agent: 'codex', sessionId: '019a-thread' },
			codexWithPermissions: { agent: 'codex', sessionId: '019a-thread' },
			codexForkWithPermissions: undefined,
			fork: undefined,
			picker: undefined,
			fresh: undefined,
			other: undefined,
			antigravity: { agent: 'antigravity', sessionId: '11111111-1111-4111-8111-111111111111' },
			antigravityEquals: { agent: 'antigravity', sessionId: '11111111-1111-4111-8111-111111111111' },
			antigravityNew: undefined,
			antigravityPrint: undefined,
		});
	});

	test('keeps the resume ledger to the latest 500 requests within three days and replaces the same id', () => {
		const now = 10 * 24 * 60 * 60 * 1000;
		let ledger = Array.from({ length: 500 }, (_, index) => ({ id: `r${index}`, at: now - 1000 + index, status: 'resumed' as const }));
		ledger = [{ id: 'old', at: now - 4 * 24 * 60 * 60 * 1000, status: 'resumed' as const }, ...ledger];
		const next = paradisRecordResumeRequest(ledger, { id: 'r499', at: now, status: 'failed' }, now);
		const added = paradisRecordResumeRequest(next, { id: 'new', at: now, status: 'started' }, now);
		assert.deepStrictEqual({
			length: added.length,
			hasOld: added.some(entry => entry.id === 'old'),
			first: added[0]?.id,
			replaced: added.filter(entry => entry.id === 'r499').map(entry => entry.status),
			last: added.at(-1)?.id,
		}, { length: 500, hasOld: false, first: 'r1', replaced: ['failed'], last: 'new' });
	});

	// 再開の途中で落ちて「始めた」が残った依頼は、しばらくしたらやり直せる。それまではエラーで断る（スマホは duplicate を
	// 受けると預かりを消すので、duplicate は返さない）
	test('runs a request again only when it never reached a terminal, and refuses one still in progress without saying duplicate', () => {
		const now = 1_000_000_000;
		const stale = now - PARADIS_RESUME_STALE_START_MS;
		assert.deepStrictEqual({
			none: paradisResumeRequestVerdict(undefined, now),
			failed: paradisResumeRequestVerdict({ id: 'r', at: now, status: 'failed' }, now),
			failedAfterTerminal: paradisResumeRequestVerdict({ id: 'r', at: stale, status: 'failed', terminalKey: 't' }, now),
			startedJustNow: paradisResumeRequestVerdict({ id: 'r', at: stale + 1, status: 'started' }, now),
			startedLongAgo: paradisResumeRequestVerdict({ id: 'r', at: stale, status: 'started' }, now),
			startedWithTerminal: paradisResumeRequestVerdict({ id: 'r', at: now, status: 'started', terminalKey: 't' }, now),
			resumed: paradisResumeRequestVerdict({ id: 'r', at: stale, status: 'resumed' }, now),
		}, {
			none: 'run',
			failed: 'run',
			failedAfterTerminal: 'duplicate',
			startedJustNow: 'pending',
			startedLongAgo: 'run',
			startedWithTerminal: 'duplicate',
			resumed: 'duplicate',
		});
	});

	test('finds the terminal that already runs a conversation, from the pane hooks or from the running command', () => {
		const conversation = '00000000-0000-4000-8000-00000000a6f1';
		const key = paradisAgentSessionKey('antigravity', conversation);
		const live = (sources: { readonly hookPane?: string; readonly command?: string; readonly paneClosed?: boolean; readonly finishedAt?: number; readonly noShellIntegration?: boolean }) => paradisLiveSessionTerminalKeys({
			paneSessions: [{ token: 'pane-claude', agent: 'claude', sessionId: 'claude-1' }],
			antigravityPaneSessions: sources.hookPane !== undefined ? [{ token: sources.hookPane, sessionId: conversation, lastHookAt: 1000 }] : [],
			terminalKeyOfPane: token => sources.paneClosed === true && token !== 'pane-claude' ? undefined : `terminal-of-${token}`,
			commandEvidenceOfPane: () => sources.noShellIntegration === true ? undefined : { finished: sources.finishedAt !== undefined ? [{ at: sources.finishedAt, exitCode: 0 }] : [], executing: sources.command },
			executing: sources.command !== undefined ? [{ commandLine: sources.command, terminalKey: () => 'terminal-of-command' }] : [],
		}).get(key);
		assert.deepStrictEqual({
			// 素の `agy` で始めたペイン: 実行中のコマンドに会話の ID は無く、hook の報告だけが手がかり
			plainAgy: live({ hookPane: 'pane-agy', command: 'agy' }),
			// `agy --conversation` で始めた直後（hook が届く前）
			resumedBeforeHooks: live({ command: `agy --conversation ${conversation}` }),
			// 両方ある（hook が報告したペインを使う）
			resumedWithHooks: live({ hookPane: 'pane-agy', command: `agy --conversation ${conversation}` }),
			// ターミナルを閉じた・最後の hook より後にコマンドが終わった（agy は終わりを hook で知らせない）
			closedPane: live({ hookPane: 'pane-agy', paneClosed: true }),
			finishedAfterLastHook: live({ hookPane: 'pane-agy', finishedAt: 2000 }),
			// 最後の hook より前に終わったコマンドしか無い・シェル統合が無い: 動いている扱い
			finishedBeforeLastHook: live({ hookPane: 'pane-agy', finishedAt: 500 }),
			noShellIntegration: live({ hookPane: 'pane-agy', noShellIntegration: true }),
			otherCommand: live({ command: 'ls' }),
			otherKindsStay: paradisLiveSessionTerminalKeys({ paneSessions: [{ token: 'pane-claude', agent: 'claude', sessionId: 'claude-1' }], antigravityPaneSessions: [], terminalKeyOfPane: token => `terminal-of-${token}`, commandEvidenceOfPane: () => ({ finished: [{ at: 9999, exitCode: 0 }], executing: undefined }), executing: [] }).get(paradisAgentSessionKey('claude', 'claude-1')),
		}, {
			plainAgy: 'terminal-of-pane-agy',
			resumedBeforeHooks: 'terminal-of-command',
			resumedWithHooks: 'terminal-of-pane-agy',
			closedPane: undefined,
			finishedAfterLastHook: undefined,
			finishedBeforeLastHook: 'terminal-of-pane-agy',
			noShellIntegration: 'terminal-of-pane-agy',
			otherCommand: undefined,
			otherKindsStay: 'terminal-of-pane-claude',
		});
	});

	test('treats an Antigravity CLI conversation as gone from its pane only when a command finished after its last hook', () => {
		const conversation = '00000000-0000-4000-8000-00000000a6f1';
		const other = '00000000-0000-4000-8000-00000000a6f2';
		const evidence = (finished: readonly (number | readonly [number, number])[], executing?: string): IParadisTerminalCommandEvidence => ({
			finished: finished.map(entry => typeof entry === 'number' ? { at: entry, exitCode: 0 } : { at: entry[0], exitCode: entry[1] }),
			executing,
		});
		const hooked = { token: 'pane', sessionId: conversation, lastHookAt: 1000 };
		const restored = { token: 'pane', sessionId: conversation, restoredAt: 5000 };
		assert.deepStrictEqual({
			// agy が動いている: 最後の hook より後に終わったコマンドは無い
			running: paradisAntigravityConversationLeftPane(hooked, evidence([200, 900], 'agy')),
			// 再読み込みの後。保存したときにコマンドの文字列が空で、実行中のコマンドが戻らなかった（プロンプトの状態は入力待ちに戻る）
			reloadedWithoutCommandLine: paradisAntigravityConversationLeftPane(hooked, evidence([200, 900])),
			// agy を終えてプロンプトに戻った・その後に別のコマンドが動いている
			backAtPrompt: paradisAntigravityConversationLeftPane(hooked, evidence([900, 1500])),
			otherCommandRunning: paradisAntigravityConversationLeftPane(hooked, evidence([1500], 'sleep 600')),
			// Ctrl+Z で止めただけ（裏で生きている）。その後に別のコマンドが終わっても動いている扱い
			suspended: paradisAntigravityConversationLeftPane(hooked, evidence([[1500, 148]])),
			suspendedThenOther: paradisAntigravityConversationLeftPane(hooked, evidence([[1500, 146], 1600])),
			// 同じペインで agy を始め直した: 素の agy・`-c` は同じ会話を開き直したかもしれない。別の会話を名指ししたら終わった扱い
			restartedPlain: paradisAntigravityConversationLeftPane(hooked, evidence([1500], 'agy')),
			restartedContinue: paradisAntigravityConversationLeftPane(hooked, evidence([1500], 'agy -c')),
			restartedSame: paradisAntigravityConversationLeftPane(hooked, evidence([1500], `agy --conversation ${conversation}`)),
			restartedOther: paradisAntigravityConversationLeftPane(hooked, evidence([1500], `agy --conversation ${other}`)),
			// PC の再起動の後（控えを読み戻しただけ）: 戻したコマンドは古い時刻のまま。新しくコマンドが終わるまで動いている扱い
			restoredOldCommands: paradisAntigravityConversationLeftPane(restored, evidence([200, 900])),
			restoredThenCommandFinished: paradisAntigravityConversationLeftPane(restored, evidence([900, 6000])),
			// 引き継いだ控えに保存してあった hook の時刻は実際より古いことがあるので、読み戻した時刻から見る
			restoredWithSavedHookTime: paradisAntigravityConversationLeftPane({ ...restored, lastHookAt: 1000 }, evidence([1500])),
			// 同時刻に終わったコマンドは「後」に数えない。止めただけの終了コードは 145〜150
			finishedAtSameTime: paradisAntigravityConversationLeftPane(hooked, evidence([1000])),
			exitCodes: [144, 145, 150, 151].map(exitCode => paradisAntigravityConversationLeftPane(hooked, evidence([[1500, exitCode]]))),
			// 時刻が無い・シェル統合が無い
			noTime: paradisAntigravityConversationLeftPane({ token: 'pane', sessionId: conversation }, evidence([9000])),
			noShellIntegration: paradisAntigravityConversationLeftPane(hooked, undefined),
		}, {
			running: false,
			reloadedWithoutCommandLine: false,
			backAtPrompt: true,
			otherCommandRunning: true,
			suspended: false,
			suspendedThenOther: false,
			restartedPlain: false,
			restartedContinue: false,
			restartedSame: false,
			restartedOther: true,
			restoredOldCommands: false,
			restoredThenCommandFinished: true,
			restoredWithSavedHookTime: false,
			finishedAtSameTime: false,
			exitCodes: [true, false, false, true],
			noTime: false,
			noShellIntegration: false,
		});
	});

	test('types into an Antigravity CLI pane only while its front agy is known to hold the recorded conversation', () => {
		const conversation = '00000000-0000-4000-8000-00000000a6f1';
		const hooked = { token: 'pane', sessionId: conversation, lastHookAt: 1000 };
		const finished = (...at: number[]) => at.map(time => ({ at: time, exitCode: 0 }));
		assert.deepStrictEqual({
			running: paradisAntigravityPaneHoldsConversation(hooked, { finished: finished(900), executing: 'agy' }),
			// agy を終えて始め直した直後（新しい会話の hook は最初の発言まで来ない）: 前の会話宛ての文を打たない
			restartedPlain: paradisAntigravityPaneHoldsConversation(hooked, { finished: finished(1500), executing: 'agy' }),
			restartedSame: paradisAntigravityPaneHoldsConversation(hooked, { finished: finished(1500), executing: `agy --conversation ${conversation}` }),
			restartedOther: paradisAntigravityPaneHoldsConversation(hooked, { finished: finished(1500), executing: 'agy --conversation 00000000-0000-4000-8000-00000000a6f2' }),
			// 再起動の後（控えを読み戻しただけ）: 保存に hook の時刻があれば、それより後に終わったコマンドが無い間は打つ
			// （agy が動き続けている）。agy が終わっていれば、終わったコマンドの時刻で止まる。保存に時刻が無ければ打たない
			restoredWithSavedHookTime: paradisAntigravityPaneHoldsConversation({ token: 'pane', sessionId: conversation, restoredAt: 5000, lastHookAt: 1000 }, { finished: finished(900), executing: 'agy' }),
			restoredAfterAgyEnded: paradisAntigravityPaneHoldsConversation({ token: 'pane', sessionId: conversation, restoredAt: 5000, lastHookAt: 1000 }, { finished: finished(1500), executing: 'agy' }),
			restoredWithoutShellIntegration: paradisAntigravityPaneHoldsConversation({ token: 'pane', sessionId: conversation, restoredAt: 5000, lastHookAt: 1000 }, undefined),
			restoredFromOldFile: paradisAntigravityPaneHoldsConversation({ token: 'pane', sessionId: conversation, restoredAt: 5000 }, { finished: [], executing: 'agy' }),
			finishedAtSameTime: paradisAntigravityPaneHoldsConversation(hooked, { finished: finished(1000), executing: 'agy' }),
			noRecord: paradisAntigravityPaneHoldsConversation(undefined, { finished: [], executing: 'agy' }),
			noShellIntegration: paradisAntigravityPaneHoldsConversation(hooked, undefined),
		}, {
			running: true,
			restartedPlain: false,
			restartedSame: true,
			restartedOther: false,
			restoredWithSavedHookTime: true,
			restoredAfterAgyEnded: false,
			restoredWithoutShellIntegration: false,
			restoredFromOldFile: false,
			finishedAtSameTime: true,
			noRecord: false,
			noShellIntegration: false,
		});
	});
});
