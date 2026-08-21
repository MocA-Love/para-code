/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';

// Claude Code / Codex のハーネスは、スラッシュコマンド実行やバックグラウンドタスク完了通知等を
// 「ユーザーロールの合成メッセージ」として transcript / state DB に書き込む。エージェントセッション
// 一覧のタイトルはその先頭メッセージ（要約）をそのまま流用しているため、これらの内部XMLラッパーが
// 生文字列のまま画面に出てしまう。ここではセッション一覧に出す直前でその変換・除去を行う。
// 判定対象タグは src/vs/paradis/contrib/mobileRelay/node/paradisMobileAgentChat.ts の
// pushClaudeUserText、および src/vs/paradis/contrib/sessionResume/node/paradisSessionResumeChannel.ts の
// isInjectedCodexContext と揃えてある。

const DISCARDABLE_PREFIX_PATTERN = /^<(local-command-stdout|local-command-stderr|local-command-caveat|environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS)[>\s]/;
const INTERRUPTED_PATTERN = /^\[Request interrupted by user( for tool use)?\]$/;
const TASK_NOTIFICATION_SUMMARY_PATTERN = /<summary>([\s\S]*?)<\/summary>/;
const COMMAND_NAME_PATTERN = /<command-name>([^<\n]*)<\/command-name>/;
const COMMAND_ARGS_PATTERN = /<command-args>([^<\n]*)<\/command-args>/;
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const SIMPLE_TAG_PATTERN = /<\/?[a-zA-Z][\w-]*>/g;

/**
 * Turns a raw agent-session summary (Claude Code / Codex CLI's own "title" for a
 * session, taken verbatim from its first user-role message) into something safe to
 * show as a session-list title. Returns `undefined` when the raw text carries no
 * user-meaningful content (harness-injected context, local-command echoes, an
 * interrupted-tool marker), so callers should fall back to their own default title.
 */
export function paradisHumanizeAgentSessionTitle(raw: string | undefined): string | undefined {
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (DISCARDABLE_PREFIX_PATTERN.test(trimmed)
		|| trimmed.startsWith('# AGENTS.md instructions for')
		|| INTERRUPTED_PATTERN.test(trimmed)) {
		return undefined;
	}

	if (trimmed.startsWith('<task-notification>')) {
		const summary = TASK_NOTIFICATION_SUMMARY_PATTERN.exec(trimmed)?.[1]?.trim();
		return summary && summary.length > 0
			? summary
			: localize('paradisAgentSessionTitle.backgroundTaskCompleted', "Background task completed");
	}

	const commandName = COMMAND_NAME_PATTERN.exec(trimmed)?.[1]?.trim();
	if (commandName) {
		const commandArgs = COMMAND_ARGS_PATTERN.exec(trimmed)?.[1]?.trim();
		return commandArgs ? `${commandName} ${commandArgs}` : commandName;
	}

	const withoutReminders = trimmed.replace(SYSTEM_REMINDER_PATTERN, '').trim();
	const withoutTags = withoutReminders.replace(SIMPLE_TAG_PATTERN, ' ').replace(/\s+/g, ' ').trim();
	return withoutTags.length > 0 ? withoutTags : undefined;
}
