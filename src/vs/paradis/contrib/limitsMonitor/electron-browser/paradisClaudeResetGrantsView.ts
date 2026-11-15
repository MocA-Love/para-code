/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量パネルの Claude のカードの下端に出すリミットリセットの 1 行と一覧（Codex の「枠のリセット」と同じ場所・
// 同じ開き方）。見せるだけで、使うボタンは置かない（使うのは claude.ai の設定の「使用量」から）。
//  - 「リミットリセット: Fable ×2・全部 ×1」。束が 1 つなら開かずに「· 11/17 16:59 に期限」まで書く
//  - 束が 2 つ以上なら押すと種類・残り・期限の一覧を開く。いちばん早い期限が 7 日以内なら 1 行に
//    「· 次は○○に期限」を添え、黄色にする
//  - 券が 0・取れないアカウントでは何も出さない

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IParadisClaudeResetGrantsFacts, paradisClaudeResetGrantsFacts, PARADIS_CLAUDE_RESET_SOON_DAYS } from '../common/paradisClaudeResetGrants.js';
import { paradisFormatLimitsDateTime, paradisLimitsCalendarDayOffset, paradisLimitsExpiryWhen, paradisLimitsRelativeDayLabel } from '../common/paradisLimitsDates.js';
import { IParadisLimitsAccount, ParadisClaudeResetKind } from '../common/paradisLimitsMonitor.js';
import { IParadisLimitsPanelContext } from './paradisLimitsPanelContributions.js';

const $ = dom.$;

/** 1 行に並べる種類の短い名前。 */
function kindShortLabel(kind: ParadisClaudeResetKind): string {
	switch (kind) {
		case 'fiveHour': return localize('paradis.claudeResetGrants.kindFiveHour', "5時間");
		case 'weekly': return localize('paradis.claudeResetGrants.kindWeekly', "週");
		case 'fable': return localize('paradis.claudeResetGrants.kindFable', "Fable");
		case 'full': return localize('paradis.claudeResetGrants.kindFull', "全部");
	}
}

/** 一覧の行の種類の名前（「Fable リセット ×2」）。 */
function kindRowLabel(kind: ParadisClaudeResetKind, left: number): string {
	switch (kind) {
		case 'fiveHour': return localize('paradis.claudeResetGrants.rowFiveHour', "5時間リセット ×{0}", left);
		case 'weekly': return localize('paradis.claudeResetGrants.rowWeekly', "週リセット ×{0}", left);
		case 'fable': return localize('paradis.claudeResetGrants.rowFable', "Fable リセット ×{0}", left);
		case 'full': return localize('paradis.claudeResetGrants.rowFull', "全部リセット ×{0}", left);
	}
}

/**
 * カードの下の 1 行（モバイルの `claudeResetGrantsSummary` と同じ決まり）。
 * 「リミットリセット: Fable ×1 · 11/17 16:59 に期限」「リミットリセット: Fable ×2・全部 ×1」
 * 「リミットリセット: 5時間 ×1・Fable ×3 · 次は今日 21:00 に期限」。
 */
export function paradisClaudeResetGrantsSummaryText(facts: IParadisClaudeResetGrantsFacts, now: number): string {
	const kinds = facts.kinds.map(entry => localize('paradis.claudeResetGrants.kindCount', "{0} ×{1}", kindShortLabel(entry.kind), entry.count)).join(localize('paradis.claudeResetGrants.kindSeparator', "・"));
	if (facts.nextEndsAt !== undefined && !facts.listable) {
		return localize('paradis.claudeResetGrants.summaryOneWithExpiry', "リミットリセット: {0} · {1} に期限", kinds, paradisLimitsExpiryWhen(facts.nextEndsAt, now));
	}
	if (facts.nextEndsAt !== undefined && facts.soon) {
		return localize('paradis.claudeResetGrants.summaryNextExpiry', "リミットリセット: {0} · 次は{1} に期限", kinds, paradisLimitsExpiryWhen(facts.nextEndsAt, now));
	}
	return localize('paradis.claudeResetGrants.summary', "リミットリセット: {0}", kinds);
}

/**
 * Claude のカードの下端の列へ、リミットリセットの 1 行（と開いていれば一覧）を足す。切り替えのボタンより先に呼ぶ
 * （1 行は左に寄せ、ボタンは右に残る）。
 * @param open 一覧を開いているアカウントの ID（描き直しをまたいで呼び出し側が持つ）
 */
export function paradisRenderClaudeResetGrants(container: HTMLElement, store: DisposableStore, account: IParadisLimitsAccount, context: IParadisLimitsPanelContext, open: Set<string>): void {
	if (account.status !== 'ok' || !account.claudeResetGrants) {
		return;
	}
	const now = Date.now();
	const facts = paradisClaudeResetGrantsFacts(account.claudeResetGrants, now);
	if (facts.rows.length === 0) {
		return;
	}
	const text = paradisClaudeResetGrantsSummaryText(facts, now);
	if (!facts.listable) {
		const note = dom.append(container, $('span.plm-card-action-note.plm-card-actions-start'));
		note.classList.toggle('soon', facts.soon);
		note.textContent = text;
		return;
	}
	const isOpen = open.has(account.id);
	const toggle = dom.append(container, $('button.plm-card-action-link.plm-card-actions-start.paradis-focus-ring-inset')) as HTMLButtonElement;
	toggle.type = 'button';
	toggle.classList.toggle('soon', facts.soon);
	context.trackFocus(toggle, `claude-reset-grants:${account.id}`);
	toggle.setAttribute('aria-expanded', String(isOpen));
	dom.append(toggle, $('span')).textContent = text;
	toggle.appendChild($(`span${ThemeIcon.asCSSSelector(isOpen ? Codicon.chevronDown : Codicon.chevronRight)}`));
	store.add(dom.addDisposableListener(toggle, 'click', () => {
		if (open.has(account.id)) {
			open.delete(account.id);
		} else {
			open.add(account.id);
		}
		context.redraw();
	}));
	if (!isOpen) {
		return;
	}
	const list = dom.append(container, $('ol.plm-reset-expiries'));
	for (const row of facts.rows) {
		const item = dom.append(list, $('li.plm-reset-expiry'));
		dom.append(item, $('span.plm-reset-expiry-kind')).textContent = kindRowLabel(row.kind, row.left);
		const label = dom.append(item, $('span.plm-reset-expiry-label'));
		if (row.endsAt === undefined) {
			label.textContent = localize('paradis.claudeResetGrants.expiryUnknown', "期限は不明");
			continue;
		}
		label.textContent = localize('paradis.claudeResetGrants.expiryUntil', "{0} まで", paradisFormatLimitsDateTime(row.endsAt, now));
		const days = paradisLimitsCalendarDayOffset(row.endsAt, now);
		dom.append(item, $('span.plm-reset-expiry-when')).textContent = paradisLimitsRelativeDayLabel(days);
		item.classList.toggle('soon', days <= PARADIS_CLAUDE_RESET_SOON_DAYS);
	}
	dom.append(list, $('li.plm-reset-expiry.plm-card-action-note')).textContent = localize('paradis.claudeResetGrants.howToUse', "使うときは claude.ai の設定の「使用量」から");
}
