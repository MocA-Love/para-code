/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 試験的な機能が「使われたか・うまくいったか」を、呼び出しごとではなく一定時間ごとの 1 件にまとめて Sentry へ送る。
//
// 1 件は `para.<feature>.<operation>` の時間の無い transaction（{@link recordParadisUsageSpan}）で、回数は
// `safe_<名前>` の数値の span attribute、設定は `safe_set_<名前>` の `on` / `off` の文字列に載せる。数値を
// 別々の属性にするのは、Discover で `sum(tags[safe_x,number])` を設定ごとに集計できるようにするため
// （`a=1,b=2` の 1 本の文字列は足し合わせられない）。custom measurement（1 件 10 個まで）は使わない。
//
// 窓の途中で設定が変わったら、先にそれまでの分を送る（オンとオフの回数が 1 件に混ざると比べられない）。
// 何も数えていない窓は送らない。送るのは決まった語と回数・ミリ秒だけ。

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { isParadisSentryScrubbedWord, ParadisSpanAttributes, recordParadisUsageSpan } from './paradisSentryDiagnostics.js';

/** 設定の値。真偽は `on` / `off` で送る（Discover で文字列として絞り込めるように）。数値の設定（分など）はそのまま。 */
export type ParadisUsageSettingValue = 'on' | 'off' | number;

/** 送り先。既定は {@link recordParadisUsageSpan}。テストでは記録するだけの偽物を渡す。 */
export type ParadisUsageSender = (feature: string, operation: string, attributes: ParadisSpanAttributes) => void;

/** タイマーの差し替え口（テスト用）。 */
export interface IParadisUsageClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultClock: IParadisUsageClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		// 送る前に終わってもよい（集計のためにプロセスを残さない）
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 回数・設定の名前の形。小文字・数字・`_` だけ。 */
const NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** 真偽の設定を送る値にする。 */
export function paradisUsageSwitch(value: boolean): 'on' | 'off' {
	return value ? 'on' : 'off';
}

/**
 * 回数を帯の名前にする。`limits` は昇順の上限で、`value` 以上の最初の上限の帯（`le_<上限>`）、どれも越えたら
 * `gt_<最後の上限>`。例: `paradisUsageBand(350, [200, 400, 600])` は `le_400`。
 */
export function paradisUsageBand(value: number, limits: readonly number[]): string {
	for (const limit of limits) {
		if (value <= limit) {
			return `le_${limit}`;
		}
	}
	return `gt_${limits[limits.length - 1]}`;
}

/** 名前が送れる形で、Sentry が値を消す語を含まないか。テストが全部の名前をこれで確かめる。 */
export function isParadisUsageNameSendable(name: string): boolean {
	return NAME.test(name) && !isParadisSentryScrubbedWord(`safe_${name}`);
}

export interface IParadisUsageTallyOptions {
	/** transaction の名前の `para.<feature>.<operation>`。 */
	readonly feature: string;
	readonly operation: string;
	/** 最初に数えてから送るまでの時間。 */
	readonly intervalMs: number;
	/** 今の設定（`safe_set_<名前>` になる）。数えるたびに読み、前と違えば先に送る。 */
	readonly settings: () => Readonly<Record<string, ParadisUsageSettingValue>>;
	readonly send?: ParadisUsageSender;
	readonly clock?: IParadisUsageClock;
}

/**
 * 回数を数え、{@link IParadisUsageTallyOptions.intervalMs} ごとに 1 件の span にまとめて送る。
 * 名前が送れる形でない回数は `safe_dropped_names` に数えるだけで送らない（作り間違いを Sentry で気づけるように）。
 */
export class ParadisUsageTally implements IDisposable {

	private counts = new Map<string, number>();
	private windowSettings: string | undefined;
	private windowSettingValues: Readonly<Record<string, ParadisUsageSettingValue>> = {};
	private windowStartedAt: number | undefined;
	private timer: unknown;
	private droppedNames = 0;
	private disposed = false;

	private readonly send: ParadisUsageSender;
	private readonly clock: IParadisUsageClock;

	constructor(private readonly options: IParadisUsageTallyOptions) {
		this.send = options.send ?? recordParadisUsageSpan;
		this.clock = options.clock ?? defaultClock;
	}

	/** `name` を `by` だけ数える（`safe_` は付けずに渡す）。 */
	add(name: string, by: number = 1): void {
		if (this.disposed || !Number.isFinite(by) || by <= 0) {
			return;
		}
		try {
			this.beginWindow();
			if (!isParadisUsageNameSendable(name)) {
				this.droppedNames++;
				return;
			}
			this.counts.set(name, (this.counts.get(name) ?? 0) + Math.round(by));
		} catch {
			// 集計の失敗で、見ている処理を変えない
		}
	}

	/** たまった分を 1 件にして送る（何も無ければ送らない）。 */
	flush(): void {
		if (this.timer !== undefined) {
			this.clock.clearTimeout(this.timer);
			this.timer = undefined;
		}
		const counts = this.counts;
		const dropped = this.droppedNames;
		const startedAt = this.windowStartedAt;
		const settings = this.windowSettingValues;
		this.counts = new Map();
		this.droppedNames = 0;
		this.windowStartedAt = undefined;
		this.windowSettings = undefined;
		this.windowSettingValues = {};
		if (counts.size === 0 && dropped === 0) {
			return;
		}
		const attributes: ParadisSpanAttributes = {};
		for (const [name, value] of Object.entries(settings)) {
			if (isParadisUsageNameSendable(`set_${name}`)) {
				attributes[`safe_set_${name}`] = value;
			}
		}
		for (const [name, count] of counts) {
			attributes[`safe_${name}`] = count;
		}
		if (dropped > 0) {
			attributes.safe_dropped_names = dropped;
		}
		attributes.safe_window_ms = startedAt === undefined ? 0 : Math.max(0, Math.round(this.clock.now() - startedAt));
		try {
			this.send(this.options.feature, this.options.operation, attributes);
		} catch {
			// 送れなくても見ている処理を変えない
		}
	}

	/** 残りを送って止める。 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.flush();
		this.disposed = true;
	}

	/** 今の設定を読み、窓を始める。設定が窓の途中で変わっていたら、先にそれまでの分を送る。 */
	private beginWindow(): void {
		const values = this.options.settings();
		const key = JSON.stringify(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
		if (this.windowSettings !== undefined && this.windowSettings !== key) {
			this.flush();
		}
		if (this.windowSettings === undefined) {
			this.windowSettings = key;
			this.windowSettingValues = { ...values };
			this.windowStartedAt = this.clock.now();
			this.timer = this.clock.setTimeout(() => {
				this.timer = undefined;
				this.flush();
			}, this.options.intervalMs);
		}
	}
}
