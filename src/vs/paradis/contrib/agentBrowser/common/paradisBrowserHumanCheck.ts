/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの操作中に、人の確認（Cloudflare の確認ページ・Turnstile）が出たことを見分ける純粋な部分。
// 見分けたら、道具の結果で「人が通すまで待つ」とエージェントに伝え、ユーザーには通知を出す。
// 確認を自動で解く・すり抜ける処理は持たない（押さない・待つだけ）。
//
// 見分け方（誤検知を少なくする）:
// - 前提: タブの中に `https://challenges.cloudflare.com` のフレームがある（main が framesInSubtree で見る。
//   ページの中の関数を動かすのはこのときだけ）
// - 確認ページ: そのうえで、ページの script の中身に `_cf_chl_opt`（Cloudflare の確認ページだけが置く設定）がある
// - ページに埋め込まれた Turnstile: そのうえで、`input[name="cf-turnstile-response"]` が見えている枠の中にあり、
//   値が空（まだ通っていない）
// - どちらも、少し待って（{@link PARADIS_HUMAN_CHECK_GRACE_MS}）まだ残っているときだけ「人の確認が要る」とする。
//   ほとんどの確認は人が触らなくても数秒で通るので、通る途中を知らせない
// 地域で変わる文言（「Just a moment...」など）は見ない。

/** 人の確認の種類。page は Cloudflare の確認ページ（サイトの代わりに出る）、widget はページの中の Turnstile。 */
export type ParadisHumanCheckKind = 'page' | 'widget';

/** 確認の候補を見つけてから、まだ残っているかを確かめ直すまで待つ時間。 */
export const PARADIS_HUMAN_CHECK_GRACE_MS = 2_000;

/** Cloudflare の確認の枠の origin。 */
export const PARADIS_HUMAN_CHECK_FRAME_ORIGIN = 'https://challenges.cloudflare.com';

/** 確認を見る道具（タブを操作・移動させるもの）。読むだけの道具では見ない。 */
export const PARADIS_HUMAN_CHECK_TOOLS: ReadonlySet<string> = new Set([
	'navigate_page', 'open_browser_tab', 'select_browser_tab', 'click', 'click_by', 'click_at', 'fill', 'fill_by', 'fill_form',
	'type_text', 'press_key', 'hover', 'drag', 'mouse_action', 'handle_dialog', 'wait_until', 'wait_for', 'run_steps', 'take_snapshot', 'take_screenshot',
]);

/** ページの中（isolated world）で動かして、確認の様子を返す式。DOM だけを読み、何も変えない。 */
export const PARADIS_HUMAN_CHECK_PAGE_PROBE = `(() => {
	const page = Array.from(document.scripts).some(s => !s.src && s.textContent.includes('_cf_chl_opt'));
	const inputs = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]'));
	const unsolvedVisible = inputs.some(input => {
		if (input.value) { return false; }
		const box = input.parentElement;
		if (!box) { return false; }
		const rect = box.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && getComputedStyle(box).visibility !== 'hidden';
	});
	return { page, unsolvedVisible };
})()`;

/**
 * エージェントが wait_until の predicate に渡す式。{@link PARADIS_HUMAN_CHECK_PAGE_PROBE} と同じものを見て、
 * 確認ページも、通っていない Turnstile も無くなったら true。
 */
export const PARADIS_HUMAN_CHECK_WAIT_PREDICATE = `() => !Array.from(document.scripts).some(s => !s.src && s.textContent.includes('_cf_chl_opt')) && !Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]')).some(i => { const b = i.parentElement; const r = b && b.getBoundingClientRect(); return !i.value && !!r && r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden'; })`;

/** {@link PARADIS_HUMAN_CHECK_PAGE_PROBE} の戻り値から種類を決める。形が違えば undefined。 */
export function paradisClassifyHumanCheckProbe(value: unknown): ParadisHumanCheckKind | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const probe = value as { page?: unknown; unsolvedVisible?: unknown };
	if (probe.page === true) {
		return 'page';
	}
	return probe.unsolvedVisible === true ? 'widget' : undefined;
}

/** 種類を main から受け取ったときの検証。 */
export function paradisParseHumanCheckKind(value: unknown): ParadisHumanCheckKind | undefined {
	return value === 'page' || value === 'widget' ? value : undefined;
}

/** 確認が出たときに道具の結果へ足す文（エージェント向け、英語）。 */
export function paradisHumanCheckNotice(kind: ParadisHumanCheckKind, tabId: string | undefined): string {
	const where = tabId !== undefined ? `The tab ${JSON.stringify(tabId)}` : 'This tab';
	const what = kind === 'page'
		? 'shows a Cloudflare check page ("Verify you are human") instead of the site'
		: 'has a Cloudflare Turnstile check ("Verify you are human") that has not passed';
	return `PARA_BROWSER_HUMAN_CHECK: ${where} ${what}. A person has to pass it: do not click it, solve it or try to get around it, and do not reload the page in a loop. Para Code has shown the user a notification for this tab. Tell the user that the tab needs them to complete the check, then wait: call wait_until${tabId !== undefined ? ` with tab_id ${JSON.stringify(tabId)},` : ''} predicate ${JSON.stringify(PARADIS_HUMAN_CHECK_WAIT_PREDICATE)} and timeout_seconds 100, and call it again if it times out. Continue the task after it returns.`;
}

/** 確認が通ったときに 1 回だけ足す文。 */
export function paradisHumanCheckPassedNotice(tabId: string | undefined): string {
	return `PARA_BROWSER_HUMAN_CHECK_PASSED: The Cloudflare check on ${tabId !== undefined ? `the tab ${JSON.stringify(tabId)}` : 'this tab'} has passed. You can continue.`;
}

/** 変化（伝える必要があるとき）。 */
export type ParadisHumanCheckTransition =
	| { readonly type: 'appeared'; readonly kind: ParadisHumanCheckKind }
	| { readonly type: 'passed' };

/** 覚えておくタブの数の上限。 */
const MAX_TABS = 256;

/**
 * タブごとに、最後に伝えた確認の様子を覚える。同じ様子が続く間は何も足さない（エージェント自身の wait_until が
 * 毎回同じ文を受け取らないように）。キーは「ペイン\nタブ」。
 */
export class ParadisHumanCheckTracker {
	private readonly reported = new Map<string, ParadisHumanCheckKind>();

	observe(key: string, kind: ParadisHumanCheckKind | undefined): ParadisHumanCheckTransition | undefined {
		const previous = this.reported.get(key);
		if (kind === undefined) {
			if (previous === undefined) {
				return undefined;
			}
			this.reported.delete(key);
			return { type: 'passed' };
		}
		if (previous === kind) {
			return undefined;
		}
		this.reported.delete(key);
		this.reported.set(key, kind);
		while (this.reported.size > MAX_TABS) {
			const oldest = this.reported.keys().next();
			if (oldest.done) {
				break;
			}
			this.reported.delete(oldest.value);
		}
		return { type: 'appeared', kind };
	}

	/** そのタブで確認を伝えたまま（まだ通っていない）か。 */
	has(key: string): boolean {
		return this.reported.has(key);
	}

	/** そのペインのタブを忘れる（エージェントがつながり直したとき）。 */
	forget(pane: string): void {
		for (const key of [...this.reported.keys()]) {
			if (key.startsWith(`${pane}\n`)) {
				this.reported.delete(key);
			}
		}
	}
}
