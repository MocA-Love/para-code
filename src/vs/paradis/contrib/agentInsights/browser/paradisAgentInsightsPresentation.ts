/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { escapeMarkdownSyntaxTokens, MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import {
	IParadisAgentPaneSubagent,
	IParadisAgentScopePane,
	PARADIS_PROMPT_CACHE_TTL_1H,
	ParadisAgentPaneSubagentStatus,
	paradisFormatPromptCacheRemaining,
	paradisIsActiveSubagent,
} from '../common/paradisAgentInsights.js';

/** ホバーに並べるサブエージェントの上限（ペインごと）。超えた分は件数だけ出す。 */
const HOVER_SUBAGENT_LIMIT = 8;

export function paradisSubagentStatusLabel(status: ParadisAgentPaneSubagentStatus): string {
	switch (status) {
		case 'running': return localize('paradis.agentInsights.subagent.running', "実行中");
		case 'idle': return localize('paradis.agentInsights.subagent.idle', "待機中");
		case 'completed': return localize('paradis.agentInsights.subagent.completed', "完了");
		case 'failed': return localize('paradis.agentInsights.subagent.failed', "失敗");
		case 'interrupted': return localize('paradis.agentInsights.subagent.interrupted', "中断");
		case 'unknown': return localize('paradis.agentInsights.subagent.unknown', "状態不明");
	}
}

function subagentIcon(subagent: IParadisAgentPaneSubagent): string {
	switch (subagent.status) {
		case 'running': return '$(sync)';
		case 'idle': return '$(circle-outline)';
		case 'completed': return '$(check)';
		case 'failed': return '$(error)';
		case 'interrupted': return '$(debug-stop)';
		case 'unknown': return '$(question)';
	}
}

/** 経過時間（`1:24`、1時間以上は `1:02:03`）。動いているものは今までの、終わったものは掛かった時間。 */
function subagentElapsed(subagent: IParadisAgentPaneSubagent, now: number): string {
	const end = paradisIsActiveSubagent(subagent) ? now : subagent.updatedAt;
	return paradisFormatPromptCacheRemaining(Math.max(0, end - subagent.startedAt));
}

function paneHeading(pane: IParadisAgentScopePane): string {
	return pane.title
		? localize('paradis.agentInsights.paneHeading', "{0} · {1}", pane.insight.agent, pane.title)
		: pane.insight.agent;
}

/**
 * スペース一覧のエージェントのドットに乗せるホバー。今まで出していた状態の内訳（`summary`）の下に、
 * ペインごとのサブエージェント一覧を足す。サブエージェントが1つも無ければ undefined を返し、
 * 呼び出し側は従来どおり内訳の文字列だけを出す（常時表示はしない、Q22 案C）。
 */
export function paradisScopeSubagentsHoverMarkdown(summary: string, panes: readonly IParadisAgentScopePane[], now: number): MarkdownString | undefined {
	const withSubagents = panes.filter(pane => pane.insight.subagents.length > 0);
	if (withSubagents.length === 0) {
		return undefined;
	}
	const markdown = new MarkdownString(undefined, { supportThemeIcons: true });
	if (summary) {
		markdown.appendText(summary);
		markdown.appendMarkdown('\n\n');
	}
	markdown.appendMarkdown(`**${escapeMarkdownSyntaxTokens(localize('paradis.agentInsights.subagentsHeading', "サブエージェント"))}**`);
	for (const pane of withSubagents) {
		markdown.appendMarkdown(`\n\n${escapeMarkdownSyntaxTokens(paneHeading(pane))}`);
		const shown = pane.insight.subagents.slice(0, HOVER_SUBAGENT_LIMIT);
		for (const subagent of shown) {
			const role = subagent.role === 'teammate'
				? localize('paradis.agentInsights.teammate', "チームメイト")
				: localize('paradis.agentInsights.subagent', "サブエージェント");
			const indent = '  '.repeat(Math.max(0, (subagent.depth ?? 1) - 1));
			const line = localize('paradis.agentInsights.subagentLine', "{0}{1} · {2} · {3}", indent, subagent.label, paradisSubagentStatusLabel(subagent.status), subagentElapsed(subagent, now));
			markdown.appendMarkdown(`\n- ${subagentIcon(subagent)} ${escapeMarkdownSyntaxTokens(line)} _${escapeMarkdownSyntaxTokens(role)}_`);
		}
		const rest = pane.insight.subagents.length - shown.length;
		if (rest > 0) {
			markdown.appendMarkdown(`\n- ${escapeMarkdownSyntaxTokens(localize('paradis.agentInsights.subagentsMore', "ほか {0} 件", rest))}`);
		}
	}
	return markdown;
}

/** 有効期限の長さの表示（「5 分」「1 時間」）。 */
export function paradisPromptCacheTtlLabel(ttlMs: number): string {
	return ttlMs >= PARADIS_PROMPT_CACHE_TTL_1H
		? localize('paradis.agentInsights.ttl1h', "1 時間")
		: localize('paradis.agentInsights.ttlMinutes', "{0} 分", Math.round(ttlMs / 60000));
}

/** 残り時間のツールチップ（1ペイン分）。ここでだけ「キャッシュ」という言葉で意味を説明する。 */
export function paradisPromptCacheTooltip(remainingMs: number, ttlMs: number): string {
	return localize(
		'paradis.agentInsights.promptCacheTooltip',
		"Claude のプロンプトキャッシュ残り {0}（有効期限 {1}）。切れると次の依頼は割高になります。",
		paradisFormatPromptCacheRemaining(remainingMs),
		paradisPromptCacheTtlLabel(ttlMs),
	);
}
