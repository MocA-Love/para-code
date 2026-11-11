/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの試験的な設定 6 件（paradis.agentBrowser.settleAfterAction・runStepsFlow・snapshotDiff・siteNotes・
// siteRecipes・reportBrowserState）が、使われたか・うまくいったかを Sentry で読めるようにする（q.html Q611）。
//
// shared process の para-browser の道具の呼び出しを数え、30 分ごとに `para.agentBrowser.usage` の 1 件にまとめる
// （paradisUsageTally.ts）。6 件の設定の値を `safe_set_*` に載せ、設定がオフでも道具の呼び出し・失敗・
// take_snapshot・run_steps の回数は数えるので、オンとオフを比べられる。
//
// 送るのは決まった語の回数・ミリ秒の合計・文字数の帯だけ。ページの中身・URL・メモや手順の文・道具の引数の値は
// 受け取りもしない（引数は鍵の有無だけを見る）。

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisUsageClock, ParadisUsageSender, ParadisUsageTally, paradisUsageBand, paradisUsageSwitch } from '../../sentry/common/paradisUsageTally.js';

/** まとめて送る間隔。 */
export const PARADIS_AGENT_BROWSER_USAGE_INTERVAL_MS = 30 * 60_000;

/** 差分を返した後にこの時間内に同じタブで `full: true` を取り直したら「取り直し」と数える。 */
export const PARADIS_SNAPSHOT_REFETCH_WINDOW_MS = 60_000;
/** 差分を返したタブを覚える数。 */
const MAX_DIFF_KEYS = 64;

/** 6 件の設定。 */
export interface IParadisAgentBrowserUsageSettings {
	readonly settle: boolean;
	readonly state: boolean;
	readonly snapshotDiff: boolean;
	readonly siteNotes: boolean;
	readonly siteRecipes: boolean;
	readonly runStepsFlow: boolean;
}

/**
 * 操作の後の待ち（settleAfterAction）の結末。`timeout` は待ちの上限で打ち切った。`stopped` は上限の前に
 * ページを読めなくなって（評価の失敗・取り消し）待つのをやめた。
 */
export type ParadisSettleOutcome = 'quiet' | 'timeout' | 'unresponsive' | 'dialog' | 'stopped';

/** 落ち着く前の最後の DOM の変化の種類（要素の増減・文字・class・style・ほかの属性）。 */
export type ParadisSettleChangeKind = 'elements' | 'text' | 'class' | 'style' | 'attribute';

/** 上限まで待っても落ち着かなかったとき、最後に読んだ時点で残っていた理由（いくつも立ちうる）。 */
export interface IParadisSettleBlocked {
	/** DOM が静かな時間に届いていなかった（最後の変化の種類）。 */
	readonly dom?: ParadisSettleChangeKind;
	/** 通信が落ち着いていなかった（終わっていない要求の数。0 なら終わった直後）。 */
	readonly network?: number;
	/** 読み込み中の印が見えていた。 */
	readonly busy?: boolean;
	/** 文書の読み込みが終わっていなかった（遷移の途中を含む）。 */
	readonly loading?: boolean;
}

/** take_snapshot を差分にする設定（snapshotDiff）で、何を返したか。 */
export type ParadisSnapshotDiffOutcome =
	/** 差分を返した。 */
	| 'diff'
	/** エージェントが `full: true` を渡した。 */
	| 'full_requested'
	/** 前回の控えが無い（最初の 1 回・期限切れ・移動の後など）。 */
	| 'full_no_baseline'
	/** 前回の本文が上限より長くて切って返していた。 */
	| 'full_truncated'
	/** 子プロセスか世代が替わり、uid が続かない。 */
	| 'full_child_changed'
	/** 差分が大きすぎた、または読めなかった。 */
	| 'full_too_large';

/** run_steps 1 回の結果（paradisBrowserRunSteps.ts・paradisBrowserRunStepsFlow.ts が終わったときに渡す）。 */
export interface IParadisRunStepsStats {
	/** 手順を 1 つも動かす前の検査で断った。 */
	readonly refused: boolean;
	readonly executed: number;
	readonly failed: number;
	/** 成り立たなかった expect の数。 */
	readonly expectFailed: number;
	/** 止まった理由。`none` は最後まで動いた。 */
	readonly stop: 'none' | 'failure' | 'step_limit' | 'time_limit' | 'cancelled';
}

/** run_steps の `report` を、例外を外へ出さずに呼ぶ。 */
export function paradisReportRunSteps(call: { report?(stats: IParadisRunStepsStats): void }, stats: IParadisRunStepsStats): void {
	try {
		call.report?.(stats);
	} catch {
		// 集計の失敗で run_steps の結果を変えない
	}
}

/** run_steps の引数で使われた書き方（値は見ず、鍵と参照の形だけを見る）。 */
export interface IParadisRunStepsFeatures {
	readonly forEach: boolean;
	readonly repeatUntil: boolean;
	readonly expect: boolean;
	readonly sleep: boolean;
	/** `$3.text`・`$item`・`$index` などの参照。 */
	readonly reference: boolean;
}

const REFERENCE = /\$(?:\d+\.(?:text|items)|item|index)\b/;

/** run_steps の引数から、使われた書き方を拾う（入れ子の steps も見る）。 */
export function paradisRunStepsFeatures(rawArgs: unknown): IParadisRunStepsFeatures {
	const found = { forEach: false, repeatUntil: false, expect: false, sleep: false, reference: false };
	const visitValue = (value: unknown, depth: number): void => {
		if (depth > 8 || found.reference) {
			return;
		}
		if (typeof value === 'string') {
			found.reference = REFERENCE.test(value);
		} else if (Array.isArray(value)) {
			value.forEach(item => visitValue(item, depth + 1));
		} else if (typeof value === 'object' && value !== null) {
			Object.values(value).forEach(item => visitValue(item, depth + 1));
		}
	};
	const visitSteps = (steps: unknown, depth: number): void => {
		if (!Array.isArray(steps) || depth > 4) {
			return;
		}
		for (const step of steps) {
			if (typeof step !== 'object' || step === null) {
				continue;
			}
			const record = step as Record<string, unknown>;
			found.forEach ||= Object.hasOwn(record, 'for_each');
			found.repeatUntil ||= Object.hasOwn(record, 'repeat_until');
			found.expect ||= Object.hasOwn(record, 'expect');
			found.sleep ||= Object.hasOwn(record, 'sleep_seconds') || Object.hasOwn(record, 'sleep_ms') || record.tool === 'sleep_seconds' || record.tool === 'sleep_ms';
			visitValue(record.args, 0);
			visitValue(record.for_each, 0);
			visitSteps(record.steps, depth + 1);
		}
	};
	if (typeof rawArgs === 'object' && rawArgs !== null) {
		visitSteps((rawArgs as Record<string, unknown>).steps, 0);
	}
	return found;
}

/** サイトメモ（siteNotes）の道具の結末。 */
export type ParadisSiteNoteOutcome =
	| 'ok'
	/** `text` が無い・空。 */
	| 'no_text'
	/** カード番号らしい数字を含む。 */
	| 'card_number'
	/** パスワードや鍵らしい文字を含む（`secret` は Sentry が値ごと消す語なので使わない）。 */
	| 'private_text'
	/** 1 つのサイトの上限に届いた。 */
	| 'store_full'
	/** このペインで開いていないサイト。 */
	| 'site_not_open'
	/** サイトが分からない。 */
	| 'no_site'
	/** どのリポジトリのペインか分からない。 */
	| 'no_space'
	/** ペインのタブを読めない。 */
	| 'no_tabs'
	/** 呼び出し元を確かめられない。 */
	| 'unverified'
	/** 消すメモが無い・`id` が無い。 */
	| 'missing'
	/** 保存などで例外。 */
	| 'error';

/** サイトの手順（siteRecipes）の道具の結末。 */
export type ParadisSiteRecipeOutcome =
	| 'ok'
	/** 動かした手順が途中で止まった。 */
	| 'failed'
	/** 保存の検査（形・名前・別の origin）で断った、または実行の前の引数の検査で断った。 */
	| 'invalid'
	| 'store_full'
	/** その名前の手順が無い。 */
	| 'missing'
	| 'site_not_open'
	| 'no_site'
	| 'no_space'
	| 'no_tabs'
	| 'unverified'
	| 'error';

/** 動かした手順を誰が保存したか。この起動の中でしか分からない（保存した人は手順に残っていない）。 */
export type ParadisRecipeRunner = 'same_pane' | 'other_pane' | 'unknown';

/** reportBrowserState で添えた文の中身。 */
export interface IParadisBrowserStateReport {
	readonly tabs: boolean;
	readonly newPage: boolean;
	readonly download: boolean;
	readonly dialog: boolean;
	readonly chars: number;
}

const SITE_NOTE_TOOLS = new Set(['write_site_note', 'list_site_notes', 'delete_site_note']);
const SITE_RECIPE_TOOLS = new Set(['save_recipe', 'run_recipe', 'list_recipes', 'delete_recipe']);

/**
 * 内蔵ブラウザの試験的な機能の回数を数える（shared process に 1 つ）。どのメソッドも例外を外へ出さない。
 */
export class ParadisAgentBrowserUsage implements IDisposable {

	private readonly tally: ParadisUsageTally;
	/** 差分を返したタブ（子プロセスの台帳のキー）と、その時刻。 */
	private readonly lastDiffAt = new Map<string, number>();
	private readonly now: () => number;

	constructor(
		settings: () => IParadisAgentBrowserUsageSettings,
		send?: ParadisUsageSender,
		clock?: IParadisUsageClock,
	) {
		this.now = clock !== undefined ? () => clock.now() : () => Date.now();
		this.tally = new ParadisUsageTally({
			feature: 'agentBrowser',
			operation: 'usage',
			intervalMs: PARADIS_AGENT_BROWSER_USAGE_INTERVAL_MS,
			settings: () => {
				const value = settings();
				return {
					settle: paradisUsageSwitch(value.settle),
					state: paradisUsageSwitch(value.state),
					snapshot_diff: paradisUsageSwitch(value.snapshotDiff),
					site_notes: paradisUsageSwitch(value.siteNotes),
					site_recipes: paradisUsageSwitch(value.siteRecipes),
					steps_flow: paradisUsageSwitch(value.runStepsFlow),
				};
			},
			send,
			clock,
		});
	}

	/** エージェントが呼んだ道具（run_steps の中の手順は数えない）。設定に関わらず数える（オンとオフの比べの母数）。 */
	noteCall(failed: boolean): void {
		this.tally.add('calls');
		if (failed) {
			this.tally.add('call_failures');
		}
	}

	/** 道具の引数の検査で断った（手順を動かす前）。`args` は鍵の有無だけを見る。 */
	noteArgumentRefusal(tool: string, args: unknown): void {
		this.tally.add('arg_refused');
		if (SITE_NOTE_TOOLS.has(tool)) {
			this.tally.add('note_arg_refused');
			if (typeof args === 'object' && args !== null && Object.hasOwn(args, 'note')) {
				// `text` の代わりに `note` を渡した（調べた記録で書き込みの失敗の 44/57）
				this.tally.add('note_arg_note');
			}
		} else if (SITE_RECIPE_TOOLS.has(tool)) {
			this.tally.add('recipe_arg_refused');
		} else if (tool === 'run_steps') {
			this.tally.add('steps_arg_refused');
		}
	}

	/** 観測（settle・state）を添える道具の呼び出し。`observe` と待ちの上限はエージェントが渡したもの。 */
	noteObserved(observe: 'changes' | 'none' | 'snapshot', settleMs: number, settle: boolean): void {
		this.tally.add('observe_calls');
		if (observe === 'none') {
			this.tally.add('observe_none');
		} else if (observe === 'snapshot') {
			this.tally.add('observe_snapshot');
		}
		if (settle && observe !== 'none' && settleMs === 0) {
			this.tally.add('settle_zero');
		}
	}

	/**
	 * 操作の後の待ちが終わった。
	 * @param blocked 上限で打ち切ったときに残っていた理由。立っている理由をそれぞれ 1 回ずつ数える（重なりうるので、
	 * 理由の数の和は `settle_timeout` を超えうる）。
	 */
	noteSettle(outcome: ParadisSettleOutcome, waitedMs: number, blocked?: IParadisSettleBlocked): void {
		const waited = Math.max(0, Math.round(waitedMs));
		this.tally.add(`settle_${outcome}`);
		this.tally.add('settle_wait_ms', waited);
		this.tally.add(`settle_${outcome}_ms`, waited);
		this.tally.add(`settle_wait_${paradisUsageBand(waited, [500, 2_000])}`);
		if (outcome === 'timeout' && blocked !== undefined) {
			if (blocked.dom !== undefined) {
				this.tally.add('settle_timeout_dom');
				// アニメーション（style の繰り返し）がまだ上限を作っているかを分けて見る
				if (blocked.dom === 'style') {
					this.tally.add('settle_timeout_dom_style');
				}
			}
			if (blocked.network !== undefined) {
				this.tally.add('settle_timeout_network');
			}
			if (blocked.busy) {
				this.tally.add('settle_timeout_busy');
			}
			if (blocked.loading) {
				this.tally.add('settle_timeout_loading');
			}
		}
	}

	/** run_steps が終わった（`flow` は手順書の経路を通ったか）。 */
	noteRunSteps(flow: boolean, features: IParadisRunStepsFeatures, stats: IParadisRunStepsStats): void {
		this.tally.add('steps_calls');
		if (flow) {
			this.tally.add('steps_flow_calls');
		}
		if (features.forEach) {
			this.tally.add('steps_used_for_each');
		}
		if (features.repeatUntil) {
			this.tally.add('steps_used_repeat_until');
		}
		if (features.expect) {
			this.tally.add('steps_used_expect');
		}
		if (features.sleep) {
			this.tally.add('steps_used_sleep');
		}
		if (features.reference) {
			this.tally.add('steps_used_reference');
		}
		if (stats.refused) {
			this.tally.add('steps_refused');
			return;
		}
		this.tally.add('steps_executed', stats.executed);
		this.tally.add(stats.failed === 0 && stats.stop === 'none' ? 'steps_ok' : stats.stop === 'none' ? 'steps_partial' : `steps_stop_${stats.stop}`);
		if (stats.expectFailed > 0) {
			this.tally.add('steps_expect_failed');
		}
	}

	/** run_steps の中の手順の引数を断った。`observe`・`settle_seconds` を書いて断られた回数は別に数える。 */
	noteStepRefusal(stepArgs: Record<string, unknown>): void {
		this.tally.add('steps_step_refused');
		if (Object.hasOwn(stepArgs, 'observe') || Object.hasOwn(stepArgs, 'settle_seconds')) {
			this.tally.add('steps_step_observe_refused');
		}
	}

	/** エージェントの take_snapshot（設定に関わらず数える）。 */
	noteSnapshotCall(): void {
		this.tally.add('snap_calls');
	}

	/** 差分の設定が有効なときに take_snapshot で何を返したか。`key` は子プロセスの台帳のキー（送らない）。 */
	noteSnapshotOutcome(key: string, outcome: ParadisSnapshotDiffOutcome): void {
		this.tally.add(`snap_${outcome}`);
		const now = this.now();
		if (outcome === 'diff') {
			this.lastDiffAt.delete(key);
			this.lastDiffAt.set(key, now);
			while (this.lastDiffAt.size > MAX_DIFF_KEYS) {
				const oldest = this.lastDiffAt.keys().next();
				if (oldest.done) {
					break;
				}
				this.lastDiffAt.delete(oldest.value);
			}
			return;
		}
		const diffAt = this.lastDiffAt.get(key);
		this.lastDiffAt.delete(key);
		if (outcome === 'full_requested' && diffAt !== undefined && now - diffAt <= PARADIS_SNAPSHOT_REFETCH_WINDOW_MS) {
			this.tally.add('snap_refetch_after_diff');
		}
	}

	/** サイトメモの道具の結末。`chars` は保存したメモの文字数（書いたときだけ）。 */
	noteSiteNote(tool: 'write' | 'list' | 'delete', outcome: ParadisSiteNoteOutcome, chars?: number): void {
		this.tally.add(`note_${tool}_${outcome}`);
		if (tool === 'write' && outcome === 'ok' && chars !== undefined) {
			this.tally.add(`note_len_${paradisUsageBand(chars, [200, 400, 600])}`);
		}
	}

	/** サイトを初めて使った結果に、メモか手順の名前を添えた。`chars` は添えた文の長さ。 */
	noteSiteHint(kind: 'notes' | 'recipes', chars: number): void {
		if (kind === 'notes') {
			this.tally.add('note_hint_shown');
			this.tally.add('note_hint_chars', chars);
			this.tally.add(`note_hint_${paradisUsageBand(chars, [2_000, 5_000])}`);
		} else {
			this.tally.add('recipe_hint_shown');
		}
	}

	/** サイトの手順の道具の結末。`runner` は run_recipe のときだけ。 */
	noteSiteRecipe(tool: 'save' | 'run' | 'list' | 'delete', outcome: ParadisSiteRecipeOutcome, runner?: ParadisRecipeRunner): void {
		this.tally.add(`recipe_${tool}_${outcome}`);
		if (tool === 'run' && runner !== undefined && (outcome === 'ok' || outcome === 'failed')) {
			this.tally.add(`recipe_run_${runner}_${outcome}`);
		}
	}

	/** reportBrowserState の文を添えた。`failed` は失敗した道具の結果に添えたか。 */
	noteBrowserState(report: IParadisBrowserStateReport, failed: boolean): void {
		this.tally.add('state_added');
		if (failed) {
			this.tally.add('state_on_failure');
		}
		if (report.newPage) {
			this.tally.add('state_new_page');
		}
		if (report.download) {
			this.tally.add('state_download');
		}
		if (report.dialog) {
			this.tally.add('state_dialog');
		}
		if (report.tabs && !report.newPage && !report.download && !report.dialog) {
			this.tally.add('state_tabs_only');
		}
		this.tally.add('state_chars', report.chars);
		this.tally.add(`state_len_${paradisUsageBand(report.chars, [500, 1_500])}`);
	}

	/** 前回と同じなので添えなかった。 */
	noteBrowserStateUnchanged(): void {
		this.tally.add('state_unchanged');
	}

	flush(): void {
		this.tally.flush();
	}

	dispose(): void {
		this.lastDiffAt.clear();
		this.tally.dispose();
	}
}
