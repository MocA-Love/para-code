// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { agentDisplayName, agentLeavesPromptAfterResume, agentQueuedSendNeedsConfirm, launchAgentShortName, agentHasModelControl, agentHasPanel, agentHasPcDraft, agentInterruptsViaApi, agentShortName, isAgentKind } from './agentKind.js';

/**
 * 種類への問いを、記述の引きに替える前の判定（`agent === 'claude'` などの照合）と同じ結果に固定する。
 * 期待値は記述から導かず、替える前のコードが返していた値をそのまま書く。
 */
const INPUTS: readonly (string | undefined)[] = ['claude', 'codex', 'opencode', 'antigravity', undefined, '', 'gemini', 'constructor', 'Claude'];

describe('agentKind', () => {
	test('知っている種類は 4 つだけで、型に無い値・空文字・undefined は種類ではない', () => {
		expect(INPUTS.map(agent => isAgentKind(agent))).toEqual([true, true, true, true, false, false, false, false, false]);
	});

	test('画面に出す名前', () => {
		expect(INPUTS.map(agent => agentDisplayName(agent))).toEqual(['Claude Code', 'Codex', 'OpenCode', 'Antigravity CLI', undefined, undefined, undefined, undefined, undefined]);
	});

	test('短い名前', () => {
		expect(INPUTS.map(agent => agentShortName(agent))).toEqual(['Claude', 'Codex', 'OpenCode', 'Antigravity', undefined, undefined, undefined, undefined, undefined]);
	});

	test('起動の知らせの名前は claude だけ Claude、ほかは型に無い値も Codex', () => {
		expect(['claude', 'codex', 'opencode', 'antigravity', '', 'gemini', 'constructor'].map(agent => launchAgentShortName(agent))).toEqual(['Claude', 'Codex', 'Codex', 'Codex', 'Codex', 'Codex', 'Codex']);
	});

	test('中断を API へ頼むのは OpenCode だけ', () => {
		expect(INPUTS.map(agent => agentInterruptsViaApi(agent))).toEqual([false, false, true, false, false, false, false, false, false]);
	});

	test('モデルの変更・PC で開いている画面・PC の下書きは Claude Code だけ', () => {
		const claudeOnly = [true, false, false, false, false, false, false, false, false];
		expect(INPUTS.map(agent => agentHasModelControl(agent))).toEqual(claudeOnly);
		expect(INPUTS.map(agent => agentHasPanel(agent))).toEqual(claudeOnly);
		expect(INPUTS.map(agent => agentHasPcDraft(agent))).toEqual(claudeOnly);
	});

	test('預かった送信を確認なしで送ってよいのは Claude Code・Codex・OpenCode だけで、知らない種類は確かめる', () => {
		expect(INPUTS.map(agent => agentQueuedSendNeedsConfirm(agent))).toEqual([false, false, false, true, false, true, true, true, true]);
	});

	test('再開の後に PC が文を渡さないのは Antigravity CLI だけ', () => {
		expect(INPUTS.map(agent => agentLeavesPromptAfterResume(agent))).toEqual([false, false, false, true, false, false, false, false, false]);
	});
});
