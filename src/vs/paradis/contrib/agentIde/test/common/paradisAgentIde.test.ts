/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE,
	PARADIS_AGENT_IDE_ACTION_TOOLS,
	PARADIS_AGENT_IDE_MAX_WAIT_SECONDS,
	PARADIS_AGENT_IDE_TOOLS,
	ParadisAgentStopWatcher,
	paradisAgentIdeActionScope,
	paradisAgentIdeActionsAllowed,
	paradisAgentIdeKeySequence,
	paradisAgentIdeMessagePrefix,
	paradisAgentIdeScreenShowsPrompt,
	paradisAgentIdeSanitizeInput,
	paradisAgentIdeStatusLabel,
	paradisAgentIdeTailLines,
	paradisAgentIdeUntrustedTitle,
	paradisParseAgentIdeCall,
} from '../../common/paradisAgentIde.js';
import { PARADIS_AGENT_IDE_SKILL_CONTENT, paradisAgentIdeGuide } from '../../common/paradisAgentIdeGuide.js';
import { paradisAgentChoiceMenu } from '../../common/paradisAgentChoiceMenu.js';
import { paradisAgentStartupScreenState } from '../../common/paradisAgentStartupScreen.js';

// codex-cli 0.158.0 / 0.160.0 の選択画面（Orca、MIT License、Copyright (c) 2026 Lovecast Inc. の
// src/main/runtime/__fixtures__ の録画を 120x40 で描いた画面の末尾）。キーの案内の行は、このソースを
// 表示した画面で判定が当たらないよう単語を連ねて組み立てる。
const words = (...parts: string[]) => parts.join(' ');
const MIDDLE_DOT = '\u00b7';
const CODEX_PLAN_MENU = [
	'\u2022 Proposed Plan',
	'  1. Append One line added. beneath the existing # scratch heading in notes.md, using this text as the default since',
	'     none was specified.',
	'  2. Check the diff confirms exactly one added line and no other changes.',
	'',
	'  Worked for 12s \u2022 1:45 AM',
	'',
	'  Implement this plan?',
	'',
	'\u203a 1. Yes, implement this plan          Switch to Default and start coding',
	'  2. Yes, clear context and implement  Start a fresh thread (current context: 2% used)',
	'  3. No, stay in Plan mode             Continue planning with the model',
	'',
	`  ${words('enter', 'select', MIDDLE_DOT, 'esc', 'back')}`,
	'',
].join('\n');
const CODEX_UPDATE_NOTICE = [
	'\u203a Ask Codex to do anything',
	'',
	'  Update available \u00b7 0.158.0 \u2192 0.159.0',
	'  Release notes: https://github.com/openai/codex/releases/latest',
	'',
	'\u203a 1. Update now (runs `npm install -g @openai/codex`)',
	'  2. Skip',
	'  3. Skip until next version',
	'',
	`  ${words('enter', 'continue', MIDDLE_DOT, 'esc', 'skip')}`,
].join('\n');
const CODEX_MODEL_NOTICE = [
	'  1. Unrelated numbered line in the scrollback',
	'  Meet GPT-6 Sol',
	'  Our latest Sol is more intelligent and more efficient so your usage limits go further.',
	'',
	'\u203a 1. Try new model',
	'  2. Use existing model',
	'',
	`  ${words('enter/esc', 'confirm', MIDDLE_DOT, 'ctrl+c', 'quit')}`,
].join('\n');
const CODEX_MODEL_RETIRED = [
	'  GPT-5.4 on Amazon Bedrock is no longer offered in Codex',
	'  Codex now uses GPT-6 Sol on Amazon Bedrock in place of GPT-5.4 on Amazon Bedrock.',
	'',
	`  ${words('enter/esc', 'continue', MIDDLE_DOT, 'ctrl+c', 'quit')}`,
].join('\n');
const CODEX_HOOKS_REVIEW = [
	'  Hooks need review',
	'  8 hooks are new or changed.',
	'',
	'\u203a 1. Review hooks',
	'  2. Trust all and continue',
	'  3. Continue without trusting (hooks won\'t run)',
	'',
	`  ${words('enter', 'confirm', MIDDLE_DOT, 'esc', 'skip')}`,
].join('\n');

suite('paradisAgentIde (common)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('settings fall back to the safe side', () => {
		assert.deepStrictEqual(
			[paradisAgentIdeActionsAllowed(true), paradisAgentIdeActionsAllowed('true'), paradisAgentIdeActionsAllowed(undefined), paradisAgentIdeActionScope('window'), paradisAgentIdeActionScope('everything'), paradisAgentIdeActionScope(undefined)],
			[true, false, false, 'window', 'space', 'space'],
		);
	});

	test('action tools are annotated as destructive and the others as read-only', () => {
		const annotations = PARADIS_AGENT_IDE_TOOLS.map(tool => ({ name: tool.name, readOnly: (tool.annotations as { readOnlyHint: boolean }).readOnlyHint, destructive: (tool.annotations as { destructiveHint: boolean }).destructiveHint }));
		assert.deepStrictEqual({
			count: annotations.length,
			actionsDestructive: annotations.filter(tool => PARADIS_AGENT_IDE_ACTION_TOOLS.has(tool.name)).every(tool => tool.destructive && !tool.readOnly),
			othersReadOnly: annotations.filter(tool => !PARADIS_AGENT_IDE_ACTION_TOOLS.has(tool.name)).every(tool => tool.readOnly && !tool.destructive),
		}, { count: 12, actionsDestructive: true, othersReadOnly: true });
	});

	test('send_terminal_input requires an explicit press_enter', () => {
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: 'yes' }),
			paradisParseAgentIdeCall('send_terminal_input', { terminal: 't_1', text: 'hi', press_enter: true }),
		].map(result => result.kind === 'error' ? 'error' : result), [
			'error',
			'error',
			{ kind: 'input', terminal: 't_1', text: 'hi', pressEnter: true },
		]);
	});

	test('control characters are removed from sent text but newlines stay', () => {
		assert.deepStrictEqual(
			paradisAgentIdeSanitizeInput('a\x1b[201~b\r\nc\td\x07\u009b'),
			'a[201~b\nc    d',
		);
	});

	test('wait arguments are validated and clamped', () => {
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'agent_stopped', timeout_seconds: 9999 }),
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'agent_stopped' }),
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'text' }).kind,
			paradisParseAgentIdeCall('wait_for_terminal', { terminal: 't_1', until: 'done' }).kind,
		], [
			{ kind: 'wait', terminal: 't_1', until: 'agent_stopped', timeoutSeconds: PARADIS_AGENT_IDE_MAX_WAIT_SECONDS },
			{ kind: 'wait', terminal: 't_1', until: 'agent_stopped', timeoutSeconds: 50 },
			'error',
			'error',
		]);
	});

	test('reading defaults to the visible screen; create_space does not run setup unless asked; no permission ids', () => {
		const launch = paradisParseAgentIdeCall('launch_agent', { agent: 'claude', permission: 'skipAll' });
		assert.deepStrictEqual([
			paradisParseAgentIdeCall('list_terminals', {}),
			paradisParseAgentIdeCall('read_terminal', { terminal: 't_1' }),
			paradisParseAgentIdeCall('read_terminal', { terminal: 't_1', scrollback_lines: 9999 }),
			paradisParseAgentIdeCall('create_space', { prompt: 'x' }),
			launch.kind === 'window' && Object.keys(launch.request).some(key => key.startsWith('permission')),
		], [
			{ kind: 'window', action: false, request: { op: 'listTerminals' } },
			{ kind: 'window', action: false, request: { op: 'readTerminal', terminal: 't_1', scrollbackLines: 0 } },
			{ kind: 'window', action: false, request: { op: 'readTerminal', terminal: 't_1', scrollbackLines: 500 } },
			{ kind: 'window', action: true, request: { op: 'createSpace', prompt: 'x', runSetup: false } },
			false,
		]);
	});

	test('stop watcher: waits for the start, then for the end, and never calls silence "stopped"', () => {
		const watcher = new ParadisAgentStopWatcher(1000);
		const idleWatcher = new ParadisAgentStopWatcher(1000);
		const launchedWatcher = new ParadisAgentStopWatcher(1000, 90_000);
		assert.deepStrictEqual({
			busy: [watcher.observe('finished', 500, 1500), watcher.observe('working', 1600, 2000), watcher.observe('finished', 2500, 2600)],
			idle: [idleWatcher.observe('idle', undefined, 3000), idleWatcher.observe('idle', undefined, 6000)],
			launched: launchedWatcher.observe('idle', undefined, 30_000),
			needsHuman: new ParadisAgentStopWatcher(1000).observe('asking_question', 500, 1000),
			needsChoice: new ParadisAgentStopWatcher(1000).observe('waiting_for_choice', 1500, 2000),
		}, { busy: ['waiting', 'waiting', 'stopped'], idle: ['waiting', 'no_agent_status'], launched: 'waiting', needsHuman: 'needs_input', needsChoice: 'needs_choice' });
	});

	test('stop watcher: an agent launched without a prompt is ready once its input box shows', () => {
		const idleLaunch = new ParadisAgentStopWatcher(1000, 90_000, true);
		const promptedLaunch = new ParadisAgentStopWatcher(1000, 90_000);
		assert.deepStrictEqual({
			idle: [idleLaunch.observe('idle', undefined, 2000), idleLaunch.observe('idle', undefined, 3000, 'ready')],
			prompted: promptedLaunch.observe('idle', undefined, 3000, 'ready'),
			trust: new ParadisAgentStopWatcher(1000, 90_000, true).observe('waiting_for_permission', undefined, 2000, 'trust_dialog'),
		}, { idle: ['waiting', 'ready'], prompted: 'waiting', trust: 'needs_input' });
	});

	test('startup screen: the trust dialogs and empty input boxes of the installed CLIs, and nothing else', () => {
		// 選択肢の文言はこのソースを表示した画面で判定が当たらないよう、単語を連ねて組み立てる（words は上の共通のもの）
		const rule = '\u2500'.repeat(40);
		const claudeYes = words('Yes,', 'I', 'trust', 'this', 'folder');
		const claudeNo = words('No,', 'exit');
		const claudeHeader = '\u2502 Accessing workspace:\n\u2502 Quick safety check: Is this a project you created or one you\n\u2502 trust? (Like your own code)\n';
		const codexHeader = '> You are in /tmp/x\n  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.\n';
		const codex159Header = '  Folder access\n  /tmp/x\n\n  Trust this folder? Codex can read, edit, and run files here,\n  subject to your permission settings.\n';
		const screens = {
			// Claude Code 2.1.283（折り返しと枠線をまたぐ。番号無しで、断る側にカーソル）
			claudeTrust: `${claudeHeader}\u2502 \u276f ${claudeNo}\n\u2502   ${claudeYes}`,
			// カーソルを承諾側へ動かした後、番号付きの版
			claudeTrustMoved: `${claudeHeader}\u2502   1. ${claudeNo}\n\n\u2502 \u276f 2. ${claudeYes}`,
			// codex-cli 0.155.1
			codexTrust: `${codexHeader}\u203a 1. ${words('Yes,', 'continue')}\n  2. ${words('No,', 'quit')}`,
			// codex-cli 0.159.2（本文は折り返す。既定で開く側にカーソル）
			codex159Trust: `${codex159Header}\n\u203a 1. ${words('Trust', 'and', 'continue')}\n  2. Quit\n\n  enter continue \u00b7 esc quit`,
			codex159Restricted: `  Folder access\n  /tmp/x\n\n  Config, hooks, and exec policies from untrusted folders stay disabled.\n  Trusted project folders can still contribute settings.\n\n  1. ${words('Open', 'restricted')}\n\u203a 2. ${words('Back', 'to', 'Agent', 'Command', 'Center')}`,
			codex159ReadyUnderTrust: `${codex159Header}\n\u203a Ask Codex to do anything`,
			codex159MentionOnly: `${codex159Header}The dialog offers "${words('Trust', 'and', 'continue')}" and "Quit".`,
			claudeReady: '\u256d\u2500\u256e\n\u2502 \u276f \u2502\n\u2570\u2500\u256f\n  ? for shortcuts',
			// 2.1.283 を auto mode（既定）で起動した実機の画面の末尾（入力欄の下が権限モードの表示になる）
			claudeReadyAutoMode: `${rule}\n\u276f \n${rule}\n  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents`,
			claudeReadyPlaceholder: `${rule}\n\u276f Try "fix lint errors"\n${rule}\n  \u23f8 plan mode on (shift+tab to cycle)`,
			// モードの表示だけで入力欄が見えない（作業中の出力が流れている等）なら当てない
			claudeModeOnly: '\u23fa Working on it\n  \u23f5\u23f5 auto mode on (shift+tab to cycle)',
			// 入力欄に文字が入っているなら当てない
			claudeModeTyped: `${rule}\n\u276f fix the bug\n${rule}\n  \u23f5\u23f5 accept edits on (shift+tab to cycle)`,
			// 信頼の確認の見出しが出ている間は、準備完了と言わない
			claudeModeUnderTrust: `${claudeHeader}${rule}\n\u276f \n${rule}\n  \u23f5\u23f5 auto mode on (shift+tab to cycle)`,
			codexReady: '\u203a Ask Codex to do anything\n\n  100% context left',
			// 0.160.0 の更新の案内は入力欄の案内の下に出る。案内が出ている間は準備完了と言わない
			codexUpdateNotice: CODEX_UPDATE_NOTICE,
			// 選択肢を選んだ後の行（カーソル付き）が入力欄より下にあるなら、入力欄が最後の入力欄ではない
			codexComposerNotLast: '\u203a Ask Codex to do anything\n\n\u203a 1. Something else',
			codexHooksReview: `\u203a Ask Codex to do anything\n${CODEX_HOOKS_REVIEW}`,
			// 見出しと選択肢の文言が画面にあっても、選択肢の形（隣り合う2行・カーソル）でなければ当てない
			mentionOnly: `${claudeHeader}The dialog offers "${claudeYes}" and "${claudeNo}".`,
			noCursor: `${claudeHeader}  ${claudeNo}\n  ${claudeYes}`,
			notAdjacent: `${claudeHeader}\u276f ${claudeNo}\nsomething else\n  ${claudeYes}`,
			headerMissing: `\u276f ${claudeNo}\n  ${claudeYes}`,
			codexQuestionOnly: codexHeader,
			// 画面の末尾 30 行より上にあるものは見ない
			scrolledAway: `? for shortcuts${'\n'.repeat(40)}$ `,
			empty: '',
		};
		assert.deepStrictEqual(Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, paradisAgentStartupScreenState(screen) ?? null])), {
			claudeTrust: 'trust_dialog',
			claudeTrustMoved: 'trust_dialog',
			codexTrust: 'trust_dialog',
			codex159Trust: 'trust_dialog',
			codex159Restricted: 'trust_dialog',
			codex159ReadyUnderTrust: null,
			codex159MentionOnly: null,
			claudeReady: 'ready',
			claudeReadyAutoMode: 'ready',
			claudeReadyPlaceholder: 'ready',
			claudeModeOnly: null,
			claudeModeTyped: null,
			claudeModeUnderTrust: null,
			codexReady: 'ready',
			codexUpdateNotice: null,
			codexComposerNotLast: null,
			codexHooksReview: null,
			mentionOnly: null,
			noCursor: null,
			notAdjacent: null,
			headerMissing: null,
			codexQuestionOnly: null,
			scrolledAway: null,
			empty: null,
		});
	});

	test('choice menus: Codex menus that own the keyboard are read with their options, only while the key row ends the screen', () => {
		const answered = CODEX_PLAN_MENU.replace(/\n\s*enter select.*$/s, '\n\u203a Ask Codex to do anything\n\n  ? for shortcuts');
		const mentioned = `${CODEX_PLAN_MENU}\n\u203a Ask Codex to do anything`;
		assert.deepStrictEqual({
			plan: paradisAgentChoiceMenu(CODEX_PLAN_MENU),
			update: paradisAgentChoiceMenu(CODEX_UPDATE_NOTICE),
			model: paradisAgentChoiceMenu(CODEX_MODEL_NOTICE),
			retired: paradisAgentChoiceMenu(CODEX_MODEL_RETIRED)?.options,
			hooks: paradisAgentChoiceMenu(CODEX_HOOKS_REVIEW)?.kind,
			answered: paradisAgentChoiceMenu(answered) ?? null,
			mentioned: paradisAgentChoiceMenu(mentioned) ?? null,
			// Claude Code の確認画面は従来どおり PROMPT_PATTERNS で見る（選択画面としては読まない）
			claude: paradisAgentChoiceMenu('Do you want to proceed?\n\u276f 1. Yes\n  2. No\n\nEsc to cancel') ?? null,
			blocksEnter: [CODEX_PLAN_MENU, CODEX_UPDATE_NOTICE, CODEX_MODEL_RETIRED, answered].map(screen => paradisAgentIdeScreenShowsPrompt(screen)),
		}, {
			plan: {
				kind: 'plan_implement',
				title: 'Implement this plan?',
				options: ['Yes, implement this plan - Switch to Default and start coding', 'Yes, clear context and implement - Start a fresh thread (current context: 2% used)', 'No, stay in Plan mode - Continue planning with the model'],
				selected: 0,
				enterWould: 'Enter would pick the highlighted choice, by default "Yes, implement this plan", and Codex would leave Plan mode and start changing files',
			},
			update: {
				kind: 'update',
				title: 'Update available \u00b7 0.158.0 \u2192 0.159.0',
				options: ['Update now (runs `npm install -g @openai/codex`)', 'Skip', 'Skip until next version'],
				selected: 0,
				enterWould: 'Enter would pick the highlighted choice, by default "Update now", which installs a new Codex version and exits',
			},
			model: {
				kind: 'model_switch',
				options: ['Try new model', 'Use existing model'],
				selected: 0,
				enterWould: 'Enter would confirm the highlighted choice and switch the model Codex uses',
			},
			retired: [],
			hooks: 'hooks_review',
			answered: null,
			mentioned: null,
			claude: null,
			blocksEnter: [true, true, true, false],
		});
	});

	test('prompt detection ignores the text that was just typed, across wrapping and box borders', () => {
		const screen = '\u256d\u2500\u2500\u2500\u256e\n\u2502 > Reply (y/n) \u2502\n\u2502 when done   \u2502\n\u2570\u2500\u2500\u2500\u256f';
		assert.deepStrictEqual([
			paradisAgentIdeScreenShowsPrompt(screen),
			paradisAgentIdeScreenShowsPrompt(screen, 'Reply (y/n) when done'),
			paradisAgentIdeScreenShowsPrompt(`${screen}\nDo you want to overwrite foo.ts?`, 'Reply (y/n) when done'),
		], [true, false, true]);
	});

	test('status labels, key sequences, tail lines, titles and the agent marker', () => {
		assert.deepStrictEqual({
			labels: [paradisAgentIdeStatusLabel('working'), paradisAgentIdeStatusLabel('permission'), paradisAgentIdeStatusLabel('question'), paradisAgentIdeStatusLabel('review'), paradisAgentIdeStatusLabel(undefined)],
			keys: [paradisAgentIdeKeySequence('up', false), paradisAgentIdeKeySequence('up', true), paradisAgentIdeKeySequence('ctrl_c', false)],
			tail: paradisAgentIdeTailLines(['a', 'b  ', 'c', '', '  '], 2),
			title: paradisAgentIdeUntrustedTitle(`x\x1b]0;evil\x07${'y'.repeat(100)}`).length,
			marker: paradisAgentIdeMessagePrefix('t_abc').includes('not typed by the user'),
		}, {
			labels: ['working', 'waiting_for_permission', 'asking_question', 'finished', 'idle'],
			keys: ['\x1b[A', '\x1bOA', '\x03'],
			tail: 'b\nc',
			title: 83,
			marker: true,
		});
	});

	test('guide and messages point at the real settings, and the skill points at the guide tool', () => {
		const guide = paradisAgentIdeGuide({ actionsEnabled: false, actionScope: 'space', readOtherSpaces: false, shellCommands: false });
		assert.deepStrictEqual({
			off: guide.includes('Actions are OFF') && guide.includes('paradis.agentIde.allowActions'),
			on: paradisAgentIdeGuide({ actionsEnabled: true, actionScope: 'window', readOtherSpaces: true, shellCommands: false }).includes('every terminal in this window'),
			message: PARADIS_AGENT_IDE_ACTIONS_DISABLED_MESSAGE.includes('paradis.agentIde.allowActions'),
			skill: PARADIS_AGENT_IDE_SKILL_CONTENT.startsWith('---\nname: para-code\n') && PARADIS_AGENT_IDE_SKILL_CONTENT.includes('read_para_code_guide'),
		}, { off: true, on: true, message: true, skill: true });
	});
});
