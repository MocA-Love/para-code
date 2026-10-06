/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 設定 `paradis.workspaceSwitch.agents` の過去の既定値（スキーマの default に出していた値）。
//
// 設定エディタの「settings.json で編集」は、その時点の既定値を丸ごと settings.json へ書き写す。
// 書き写された行は利用者が自分で決めたものではないので、同じ id のここの行と同じ行は、インストール済みの
// CLI から取ったモデル一覧を当てはめた今の既定の行に差し替える（paradisResolveAgentTemplates）。
//
// 既定のエージェント定義（PARADIS_DEFAULT_AGENT_COMMANDS）を変えたら、変える前の値を JSON に
// 直した形でここの末尾へ足す。足し忘れはテスト（paradisAgentModelCatalog.test.ts）が既定値の
// 指紋の変化で知らせる。各値は git の履歴から起こしたもので、書き換えない。

// allow-any-unicode-next-line
const LABEL_DEFAULT = '通常（確認あり）';
// allow-any-unicode-next-line
const LABEL_SKIP_ALL = '全許可';
// allow-any-unicode-next-line
const HINT_SKIP_ALL = '確認なしでコマンド実行・ファイル編集を行います';
// allow-any-unicode-next-line
const HINT_FULL_AUTO = 'sandbox内で自動実行し、失敗時のみ確認します';
// allow-any-unicode-next-line
const LABEL_BYPASS = '全バイパス';
// allow-any-unicode-next-line
const HINT_BYPASS = '承認もsandboxもすべて無効化します';
// allow-any-unicode-next-line
const HINT_FULL_AUTO_ON_REQUEST = 'sandbox内で自動実行し、必要なときだけ確認します';

/** 古い順。値は settings.json に書き写されたときの JSON と同じ形。 */
export const PARADIS_PAST_DEFAULT_AGENT_COMMANDS: readonly (readonly object[])[] = [
	// 2026-07-05〜2026-07-19（モデル選択が無かった頃）
	[
		{ id: 'claude', label: 'Claude Code', command: 'claude {prompt}' },
		{ id: 'codex', label: 'Codex', command: 'codex {prompt}' },
		{ id: 'gemini', label: 'Gemini CLI', command: 'gemini -i {prompt}' },
	],
	// 2026-07-20〜2026-07-24（Opus 4.8）
	[
		{
			id: 'claude',
			label: 'Claude Code',
			command: 'claude {prompt}',
			models: [
				{ id: 'fable', label: 'fable (Fable 5)', flag: '--model fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'opus', label: 'opus (Opus 4.8)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5)', flag: '--model sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
				{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'skip-permissions', label: LABEL_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: HINT_SKIP_ALL },
			],
		},
		{
			id: 'codex',
			label: 'Codex',
			command: 'codex {prompt}',
			models: [
				{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.4', flag: '--model gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
				{ id: 'ultra', flag: '--effort ultra' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'full-auto', label: 'full-auto', flag: '--full-auto', hint: HINT_FULL_AUTO },
				{ id: 'bypass', label: LABEL_BYPASS, flag: '--dangerously-bypass-approvals-and-sandbox', danger: true, hint: HINT_BYPASS },
			],
		},
		{
			id: 'gemini',
			label: 'Gemini CLI',
			command: 'gemini -i {prompt}',
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'yolo', label: LABEL_SKIP_ALL, flag: '--yolo', danger: true, hint: HINT_SKIP_ALL },
			],
		},
	],
	// 2026-07-25〜2026-09-28（Opus 5。gpt-5.4 と --effort / --full-auto を含む）
	[
		{
			id: 'claude',
			label: 'Claude Code',
			command: 'claude {prompt}',
			models: [
				{ id: 'fable', label: 'fable (Fable 5)', flag: '--model fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'opus', label: 'opus (Opus 5)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5)', flag: '--model sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
				{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'skip-permissions', label: LABEL_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: HINT_SKIP_ALL },
			],
		},
		{
			id: 'codex',
			label: 'Codex',
			command: 'codex {prompt}',
			models: [
				{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.4', flag: '--model gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
				{ id: 'ultra', flag: '--effort ultra' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'full-auto', label: 'full-auto', flag: '--full-auto', hint: HINT_FULL_AUTO },
				{ id: 'bypass', label: LABEL_BYPASS, flag: '--dangerously-bypass-approvals-and-sandbox', danger: true, hint: HINT_BYPASS },
			],
		},
		{
			id: 'gemini',
			label: 'Gemini CLI',
			command: 'gemini -i {prompt}',
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'yolo', label: LABEL_SKIP_ALL, flag: '--yolo', danger: true, hint: HINT_SKIP_ALL },
			],
		},
	],
	// 2026-09-28〜2026-09-29（Claude Code 2.1.283 の Opus 5.5・Sonnet 5。Codex 0.155.1 の gpt-6-astra）
	[
		{
			id: 'claude',
			label: 'Claude Code',
			command: 'claude {prompt}',
			models: [
				{ id: 'fable', label: 'fable (Fable 5.1)', flag: '--model fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'opus', label: 'opus (Opus 5.5)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5)', flag: '--model sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
				{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'skip-permissions', label: LABEL_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: HINT_SKIP_ALL },
			],
		},
		{
			id: 'codex',
			label: 'Codex',
			command: 'codex {prompt}',
			models: [
				{ id: 'gpt-6-astra', flag: '--model gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
				{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '-c model_reasoning_effort=low' },
				{ id: 'medium', flag: '-c model_reasoning_effort=medium' },
				{ id: 'high', flag: '-c model_reasoning_effort=high' },
				{ id: 'xhigh', flag: '-c model_reasoning_effort=xhigh' },
				{ id: 'max', flag: '-c model_reasoning_effort=max' },
				{ id: 'ultra', flag: '-c model_reasoning_effort=ultra' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'full-auto', label: 'full-auto', flag: '--sandbox workspace-write --ask-for-approval on-request', hint: HINT_FULL_AUTO_ON_REQUEST },
				{ id: 'bypass', label: LABEL_BYPASS, flag: '--dangerously-bypass-approvals-and-sandbox', danger: true, hint: HINT_BYPASS },
			],
		},
		{
			id: 'gemini',
			label: 'Gemini CLI',
			command: 'gemini -i {prompt}',
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'yolo', label: LABEL_SKIP_ALL, flag: '--yolo', danger: true, hint: HINT_SKIP_ALL },
			],
		},
	],
	// 2026-09-29〜2026-09-30（Claude Code 2.1.284 の Sonnet 5.5。Codex 0.155.1 の gpt-6-astra）
	[
		{
			id: 'claude',
			label: 'Claude Code',
			command: 'claude {prompt}',
			models: [
				{ id: 'fable', label: 'fable (Fable 5.1)', flag: '--model fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'opus', label: 'opus (Opus 5.5)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5.5)', flag: '--model sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
				{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'skip-permissions', label: LABEL_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: HINT_SKIP_ALL },
			],
		},
		{
			id: 'codex',
			label: 'Codex',
			command: 'codex {prompt}',
			models: [
				{ id: 'gpt-6-astra', flag: '--model gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
				{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '-c model_reasoning_effort=low' },
				{ id: 'medium', flag: '-c model_reasoning_effort=medium' },
				{ id: 'high', flag: '-c model_reasoning_effort=high' },
				{ id: 'xhigh', flag: '-c model_reasoning_effort=xhigh' },
				{ id: 'max', flag: '-c model_reasoning_effort=max' },
				{ id: 'ultra', flag: '-c model_reasoning_effort=ultra' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'full-auto', label: 'full-auto', flag: '--sandbox workspace-write --ask-for-approval on-request', hint: HINT_FULL_AUTO_ON_REQUEST },
				{ id: 'bypass', label: LABEL_BYPASS, flag: '--dangerously-bypass-approvals-and-sandbox', danger: true, hint: HINT_BYPASS },
			],
		},
		{
			id: 'gemini',
			label: 'Gemini CLI',
			command: 'gemini -i {prompt}',
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'yolo', label: LABEL_SKIP_ALL, flag: '--yolo', danger: true, hint: HINT_SKIP_ALL },
			],
		},
	],
	// 2026-09-30〜2026-10-06（Claude Code 2.1.285 の `--permission-mode default`。codex-cli 0.159.2 の gpt-6.1-sol）
	[
		{
			id: 'claude',
			label: 'Claude Code',
			command: 'claude {prompt}',
			models: [
				{ id: 'fable', label: 'fable (Fable 5.1)', flag: '--model fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
				{ id: 'opus', label: 'opus (Opus 5.5)', flag: '--model opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5.5)', flag: '--model sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', flag: '--model haiku', efforts: [] },
				{ id: 'opusplan', label: 'opusplan', flag: '--model opusplan', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '--effort low' },
				{ id: 'medium', flag: '--effort medium' },
				{ id: 'high', flag: '--effort high' },
				{ id: 'xhigh', flag: '--effort xhigh' },
				{ id: 'max', flag: '--effort max' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '--permission-mode default' },
				{ id: 'skip-permissions', label: LABEL_SKIP_ALL, flag: '--dangerously-skip-permissions', danger: true, hint: HINT_SKIP_ALL },
			],
		},
		{
			id: 'codex',
			label: 'Codex',
			command: 'codex {prompt}',
			models: [
				{ id: 'gpt-6.1-sol', flag: '--model gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
				{ id: 'gpt-6-astra', flag: '--model gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-6-sol', flag: '--model gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-6-luna', flag: '--model gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-sol', flag: '--model gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
				{ id: 'gpt-5.6-terra', flag: '--model gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
				{ id: 'gpt-5.6-luna', flag: '--model gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
				{ id: 'gpt-5.5', flag: '--model gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
			],
			efforts: [
				{ id: 'low', flag: '-c model_reasoning_effort=low' },
				{ id: 'medium', flag: '-c model_reasoning_effort=medium' },
				{ id: 'high', flag: '-c model_reasoning_effort=high' },
				{ id: 'xhigh', flag: '-c model_reasoning_effort=xhigh' },
				{ id: 'max', flag: '-c model_reasoning_effort=max' },
				{ id: 'ultra', flag: '-c model_reasoning_effort=ultra' },
			],
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'full-auto', label: 'full-auto', flag: '--sandbox workspace-write --ask-for-approval on-request', hint: HINT_FULL_AUTO_ON_REQUEST },
				{ id: 'bypass', label: LABEL_BYPASS, flag: '--dangerously-bypass-approvals-and-sandbox', danger: true, hint: HINT_BYPASS },
			],
		},
		{
			id: 'gemini',
			label: 'Gemini CLI',
			command: 'gemini -i {prompt}',
			permissions: [
				{ id: 'default', label: LABEL_DEFAULT, flag: '' },
				{ id: 'yolo', label: LABEL_SKIP_ALL, flag: '--yolo', danger: true, hint: HINT_SKIP_ALL },
			],
		},
	],
];
