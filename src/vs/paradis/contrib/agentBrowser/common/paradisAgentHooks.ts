/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI (Claude Code / Codex) の通知hook設置に関する共有定義。
// 自動設置 (node/paradisAgentHooksSetup.ts) と手動スニペットコピー
// (workspaceSwitch/electron-browser/paradisAgentStatus.contribution.ts) の両方から参照され、
// 生成されるhookコマンド・イベント一覧が両経路で常に一致することを保証する。

/**
 * ホームディレクトリ相対の notify スクリプト設置先 (POSIX)。
 * このパスが「当fork管理のhookである」ことを識別するマーカーを兼ねる
 * (~/.claude/settings.json / ~/.codex/hooks.json の冪等マージ時)。
 */
export const PARADIS_NOTIFY_HOOK_RELATIVE_PATH = '.para-code/hooks/notify.sh';

/**
 * hook登録イベント1件 (Claude Code の settings.json / Codex の hooks.json は同じ
 * `{ hooks: { EventName: [{ matcher?, hooks: [{ type, command }] }] } }` 構造)。
 */
export interface IParadisManagedHookEvent {
	readonly eventName: string;
	/** ツール系イベント (PostToolUse 等) に付ける matcher。 */
	readonly matcher?: string;
}

/**
 * ~/.claude/settings.json に登録するイベント一覧 (Superset の createClaudeSettingsJson と同方針)。
 * PreToolUse は登録しない (permission に正規化されるため、ツール実行のたびに誤通知になる)。
 */
export const PARADIS_CLAUDE_HOOK_EVENTS: readonly IParadisManagedHookEvent[] = [
	{ eventName: 'SessionStart' },
	{ eventName: 'SessionEnd' },
	{ eventName: 'UserPromptSubmit' },
	{ eventName: 'Stop' },
	{ eventName: 'PostToolUse', matcher: '*' },
	{ eventName: 'PermissionRequest', matcher: '*' },
	{ eventName: 'Notification' },
];

/** ~/.codex/hooks.json に登録するイベント一覧 (Superset の createCodexHooksJson と同じ)。 */
export const PARADIS_CODEX_HOOK_EVENTS: readonly IParadisManagedHookEvent[] = [
	{ eventName: 'SessionStart' },
	{ eventName: 'UserPromptSubmit' },
	{ eventName: 'Stop' },
];

/**
 * 設定ファイルに書き込むhookコマンド (sh 1行)。$HOME 参照で実行時解決するため
 * dev/製品ビルドで同一文字列になり、スクリプトが無い環境では即 true で無害。
 */
export function paradisManagedAgentHookCommand(): string {
	return `[ -x "$HOME/${PARADIS_NOTIFY_HOOK_RELATIVE_PATH}" ] && "$HOME/${PARADIS_NOTIFY_HOOK_RELATIVE_PATH}" || true`;
}

/** 1イベント分のhook定義オブジェクトを組み立てる (自動マージ・手動スニペットで共用)。 */
export function paradisManagedHookDefinition(event: IParadisManagedHookEvent): { readonly matcher?: string; readonly hooks: readonly { readonly type: string; readonly command: string }[] } {
	const entry = { type: 'command', command: paradisManagedAgentHookCommand() };
	return event.matcher !== undefined ? { matcher: event.matcher, hooks: [entry] } : { hooks: [entry] };
}
