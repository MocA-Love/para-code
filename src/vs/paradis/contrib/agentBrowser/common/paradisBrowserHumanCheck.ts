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

import { PARADIS_MAIN_WAIT_MAX_SECONDS, PARADIS_SUBAGENT_WAIT_MAX_SECONDS } from './paradisSubagentToolCalls.js';

/** 人の確認の種類。page は Cloudflare の確認ページ（サイトの代わりに出る）、widget はページの中の Turnstile。 */
export type ParadisHumanCheckKind = 'page' | 'widget';

/** 確認の候補を見つけてから、まだ残っているかを確かめ直すまで待つ時間。 */
export const PARADIS_HUMAN_CHECK_GRACE_MS = 2_000;

/** 通知を出している間、タブを見直す間隔。 */
export const PARADIS_HUMAN_CHECK_POLL_MS = 5_000;

/** Cloudflare の確認の枠の origin。 */
export const PARADIS_HUMAN_CHECK_FRAME_ORIGIN = 'https://challenges.cloudflare.com';

/** 確認を見る道具（タブを操作・移動させるもの）。読むだけの道具では見ない。 */
export const PARADIS_HUMAN_CHECK_TOOLS: ReadonlySet<string> = new Set([
	'navigate_page', 'open_browser_tab', 'select_browser_tab', 'click', 'click_by', 'click_at', 'fill', 'fill_by', 'fill_form',
	'type_text', 'press_key', 'hover', 'drag', 'mouse_action', 'handle_dialog', 'wait_until', 'wait_for', 'run_steps', 'take_snapshot', 'take_screenshot',
]);

/**
 * ページの中（isolated world）で動かして、確認の様子を返す式。DOM を読むだけで、ページの見た目や動きは変えない。
 *
 * 初めて動かしたとき、その文書に「送信に当たる操作」を数える聞き手を置く（isolated world の中だけの値。ページの
 * スクリプトからは見えない）。数えるのは、form の submit、送信ボタン（`type=submit`・type の無い form の中の
 * button・`input[type=submit|image]`）や Turnstile と同じ form の中のボタンのクリック、form の中の入力欄
 * （textarea を除く）での Enter。入力欄へのフォーカスのクリック・Tab・fill は数えない。
 */
export const PARADIS_HUMAN_CHECK_PAGE_PROBE = `(() => {
	const state = window.__paradisHumanCheck || (window.__paradisHumanCheck = (() => {
		const counter = { submits: 0 };
		const turnstileForm = form => !!form && !!form.querySelector('input[name="cf-turnstile-response"]');
		const isSubmitControl = element => {
			if (element instanceof HTMLButtonElement) {
				return (element.type === 'submit' && !!element.form) || turnstileForm(element.form);
			}
			return element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image');
		};
		document.addEventListener('submit', () => { counter.submits++; }, true);
		document.addEventListener('click', event => {
			const target = event.target instanceof Element ? event.target.closest('button, input') : null;
			if (target && isSubmitControl(target)) { counter.submits++; }
		}, true);
		document.addEventListener('keydown', event => {
			const target = event.target;
			if (event.key === 'Enter' && target instanceof HTMLInputElement && !!target.form && !['button', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset'].includes(target.type)) { counter.submits++; }
		}, true);
		return counter;
	})());
	const page = Array.from(document.scripts).some(s => !s.src && s.textContent.includes('_cf_chl_opt'));
	const inputs = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]'));
	const unsolvedVisible = inputs.some(input => {
		if (input.value) { return false; }
		const box = input.parentElement;
		if (!box) { return false; }
		const rect = box.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && getComputedStyle(box).visibility !== 'hidden';
	});
	return { page, unsolvedVisible, submits: state.submits };
})()`;

/**
 * エージェントが wait_until の predicate に渡す式。{@link PARADIS_HUMAN_CHECK_PAGE_PROBE} と同じものを見て、
 * 確認ページも、通っていない Turnstile も無くなったら true。
 */
export const PARADIS_HUMAN_CHECK_WAIT_PREDICATE = `() => !Array.from(document.scripts).some(s => !s.src && s.textContent.includes('_cf_chl_opt')) && !Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]')).some(i => { const b = i.parentElement; const r = b && b.getBoundingClientRect(); return !i.value && !!r && r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden'; })`;

/**
 * 見た結果。`none` は確認が無い、`check` は確認があり、`unknown` は見られなかった（ページが時間内に答えない・
 * 読み込み中・失敗）。`unknown` のときは、知らせた状態も通知も変えない（まだ通っていないのに閉じないように）。
 * `submits` は、その文書で数えた送信に当たる操作の数。
 */
export type ParadisHumanCheckObservation =
	| { readonly state: 'none' }
	| { readonly state: 'check'; readonly kind: ParadisHumanCheckKind; readonly submits: number }
	| { readonly state: 'unknown' };

/** {@link PARADIS_HUMAN_CHECK_PAGE_PROBE} の戻り値を読む。形が違えば unknown。 */
export function paradisClassifyHumanCheckProbe(value: unknown): ParadisHumanCheckObservation {
	if (typeof value !== 'object' || value === null) {
		return { state: 'unknown' };
	}
	const probe = value as { page?: unknown; unsolvedVisible?: unknown; submits?: unknown };
	const submits = typeof probe.submits === 'number' && Number.isFinite(probe.submits) ? probe.submits : 0;
	if (probe.page === true) {
		return { state: 'check', kind: 'page', submits };
	}
	return probe.unsolvedVisible === true ? { state: 'check', kind: 'widget', submits } : { state: 'none' };
}

/** main から受け取った {@link ParadisHumanCheckObservation} の検証。形が違えば unknown。 */
export function paradisParseHumanCheckObservation(value: unknown): ParadisHumanCheckObservation {
	if (typeof value !== 'object' || value === null) {
		return { state: 'unknown' };
	}
	const v = value as { state?: unknown; kind?: unknown; submits?: unknown };
	if (v.state === 'none') {
		return { state: 'none' };
	}
	if (v.state === 'check' && (v.kind === 'page' || v.kind === 'widget')) {
		return { state: 'check', kind: v.kind, submits: typeof v.submits === 'number' && Number.isFinite(v.submits) ? v.submits : 0 };
	}
	return { state: 'unknown' };
}

/** 種類を受け取ったときの検証（renderer への通知）。 */
export function paradisParseHumanCheckKind(value: unknown): ParadisHumanCheckKind | undefined {
	return value === 'page' || value === 'widget' ? value : undefined;
}

/** 道具の結果に足す文の種類。 */
export type ParadisHumanCheckNoticeKind = 'page' | 'widget' | 'widgetBlocked' | 'passed';


function waitInstruction(tabId: string | undefined, fromSubagent: boolean): string {
	const seconds = fromSubagent ? PARADIS_SUBAGENT_WAIT_MAX_SECONDS : PARADIS_MAIN_WAIT_MAX_SECONDS;
	return `wait: call wait_until${tabId !== undefined ? ` with tab_id ${JSON.stringify(tabId)},` : ''} predicate ${JSON.stringify(PARADIS_HUMAN_CHECK_WAIT_PREDICATE)} and timeout_seconds ${seconds}, and call it again if it times out. Continue the task after it returns.`;
}

/**
 * 道具の結果に足す文（エージェント向け、英語）。`fromSubagent` は、この呼び出しが Claude Code のサブエージェントの中から来たと
 * 確かめられたとき（待つ道具を長い上限で呼ぶよう案内する。paradisSubagentToolCalls.ts）。
 */
export function paradisHumanCheckNotice(kind: ParadisHumanCheckNoticeKind, tabId: string | undefined, fromSubagent = false): string {
	const tab = tabId !== undefined ? `the tab ${JSON.stringify(tabId)}` : 'this tab';
	switch (kind) {
		case 'page':
			return `PARA_BROWSER_HUMAN_CHECK: ${tab} shows a Cloudflare check page ("Verify you are human") instead of the site. A person has to pass it: do not click it, solve it or try to get around it, and do not reload the page in a loop. Para Code has shown the user a notification for this tab. Tell the user that the tab needs them to complete the check, then ${waitInstruction(tabId, fromSubagent)}`;
		case 'widget':
			return `PARA_BROWSER_HUMAN_CHECK: ${tab} has a Cloudflare Turnstile check ("Verify you are human") inside the page that has not passed yet. It is usually part of a form and often passes by itself: you can keep filling in the form, but do not click the check, solve it or try to get around it. If it still has not passed when you are about to send the form, or the form cannot be sent because of it, ask the user to complete the check in the tab, then ${waitInstruction(tabId, fromSubagent)}`;
		case 'widgetBlocked':
			return `PARA_BROWSER_HUMAN_CHECK: The Cloudflare Turnstile check on ${tab} still has not passed after your last action. Para Code has shown the user a notification for this tab. Ask the user to complete the check, then ${waitInstruction(tabId, fromSubagent)}`;
		case 'passed':
			return `PARA_BROWSER_HUMAN_CHECK_PASSED: The Cloudflare check on ${tab} has passed. You can continue.`;
	}
}

/** {@link ParadisHumanCheckTracker.observe} の答え。 */
export interface IParadisHumanCheckUpdate {
	/** 道具の結果に足す文。 */
	readonly notice?: ParadisHumanCheckNoticeKind;
	/** ユーザーへ出す通知（出す種類）。 */
	readonly notify?: ParadisHumanCheckKind;
	/** 出していた通知を閉じる。 */
	readonly close?: boolean;
}

interface IParadisHumanCheckState {
	/** 今出ている確認（通ったのを見回りで見つけたときは undefined で、次の道具の結果に「通った」を足す）。 */
	readonly kind: ParadisHumanCheckKind | undefined;
	/** ユーザーへ通知を出しているか。 */
	readonly notified: boolean;
	/** 最後に見たときの、送信に当たる操作の数（増えたら、確認が残ったまま送ろうとした）。 */
	readonly submits: number;
}

/** 覚えておくタブの数の上限。 */
const MAX_TABS = 256;

/**
 * タブごとに、伝えた確認の様子を覚える。キーは「ペイン\nタブ」。
 * - 確認ページ: 出たらエージェントに「待つ」と伝え、ユーザーに通知する
 * - ページの中の Turnstile: 出たらエージェントには「入力は続けてよい、送る前に人に頼む」とだけ伝える。残ったまま
 *   送信に当たる操作（ページの中で数えたもの。{@link PARADIS_HUMAN_CHECK_PAGE_PROBE}）が増えたら、そこで初めて
 *   ユーザーに通知し、エージェントに人に頼むよう伝える
 * - 同じ様子が続く間は何も足さない（エージェント自身の wait_until が毎回同じ文を受け取らないように）
 * - 通ったら 1 回だけ「通った」を足し、通知を閉じる
 */
export class ParadisHumanCheckTracker {
	private readonly states = new Map<string, IParadisHumanCheckState>();

	observe(key: string, observation: ParadisHumanCheckObservation): IParadisHumanCheckUpdate {
		if (observation.state === 'unknown') {
			return {};
		}
		const previous = this.states.get(key);
		if (observation.state === 'none') {
			if (previous === undefined) {
				return {};
			}
			this.states.delete(key);
			return { notice: 'passed', close: previous.notified };
		}
		const { kind, submits } = observation;
		if (previous?.kind === kind) {
			if (kind === 'widget' && !previous.notified && submits > previous.submits) {
				this.set(key, { kind, notified: true, submits });
				return { notice: 'widgetBlocked', notify: 'widget' };
			}
			this.set(key, { ...previous, submits });
			return {};
		}
		const notify = kind === 'page';
		this.set(key, { kind, notified: notify, submits });
		return { notice: kind, ...(notify ? { notify: kind } : {}), ...(previous?.notified && !notify ? { close: true } : {}) };
	}

	/** 通知を出している間の見回りで、確認が通ったのを見つけた。通知を出していたら true（閉じる）。 */
	markPassed(key: string): boolean {
		const previous = this.states.get(key);
		if (previous?.kind === undefined) {
			return false;
		}
		this.set(key, { kind: undefined, notified: false, submits: 0 });
		return previous.notified;
	}

	/** そのタブで確認を伝えたまま（まだ通っていない）か。 */
	has(key: string): boolean {
		return this.states.get(key)?.kind !== undefined;
	}

	/** そのタブだけを忘れる（共有が外れた）。 */
	forgetTab(key: string): void {
		this.states.delete(key);
	}

	/** ユーザーへ通知を出しているか。 */
	isNotified(key: string): boolean {
		return this.states.get(key)?.notified === true;
	}

	/** そのペインのタブを忘れる（エージェントがつながり直した・ペインが終わった）。通知を出していたタブを返す。 */
	forget(pane: string): string[] {
		const notifiedTabs: string[] = [];
		for (const [key, state] of [...this.states]) {
			if (key.startsWith(`${pane}\n`)) {
				if (state.notified) {
					notifiedTabs.push(key.slice(pane.length + 1));
				}
				this.states.delete(key);
			}
		}
		return notifiedTabs;
	}

	private set(key: string, state: IParadisHumanCheckState): void {
		this.states.delete(key);
		this.states.set(key, state);
		while (this.states.size > MAX_TABS) {
			const oldest = this.states.keys().next();
			if (oldest.done) {
				break;
			}
			this.states.delete(oldest.value);
		}
	}
}
