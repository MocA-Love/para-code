/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期ヘルスビーコンの共有定義。electron-main(収集と送信)と electron-browser(ウィンドウ側の
// 自己申告)の両方から参照される。
//
// 狙いは「長時間動かすとメモリが膨らむ」を利用者全体の分布で見ること。2026-08-05 の実機調査
// (14時間稼働)では main プロセスの V8 old_space が強制GC後も 2.33GB 生存していた(他プロセスは
// 一桁小さい)。単一の指標としてはこれが最も早く異変を捉えられるので、必ず含める。
//
// Sentry 側では `avg(measurements.main.v8.old_space_used)` を `para.uptime_bucket` で割れば、
// 稼働時間に対する増え方が全ユーザー分で見える。プロセス種別ごとの working set も同時に送るので、
// 「main が悪いのか、renderer が悪いのか、拡張ホストが悪いのか」を最初の1クエリで切り分けられる。
//
// 送ってよいのは数値と、ここで定義した固定の列挙値だけ。パス・リポジトリ名・拡張ID・ウィンドウ
// タイトルのような識別につながるものは絶対に載せない(CLAUDE.md の公開情報ルール)。

import { Event } from '../../../../base/common/event.js';

/** electron-main ⇔ electron-browser のヘルス申告用IPCチャネル名。 */
export const PARADIS_HEALTH_BEACON_CHANNEL = 'paradisHealthBeacon';

/** Sentry のトランザクション名。`para.` 始まりは tracesSampler が100%拾う(paradisSentryMain.ts)。 */
export const PARADIS_HEALTH_BEACON_SPAN_NAME = 'para.health.snapshot';

/**
 * 送信スキーマの版。指標を足し引きしたら必ず上げる。
 * Sentry 側のクエリは古い版のイベントも拾ってしまうので、これが無いと
 * 「指標が消えた期間」と「値が0の期間」を区別できない。
 */
export const PARADIS_HEALTH_BEACON_SCHEMA_VERSION = '1';

/** 起動直後は初期化のピークが乗るので、落ち着いてから最初の1本を送る。 */
export const PARADIS_HEALTH_BEACON_FIRST_DELAY_MS = 10 * 60 * 1000;

/** 以後の送信間隔。 */
export const PARADIS_HEALTH_BEACON_INTERVAL_MS = 60 * 60 * 1000;

/** 収集要求を出してからウィンドウの申告を待つ時間。取り逃しても前回値で送る。 */
export const PARADIS_HEALTH_BEACON_REPORT_WAIT_MS = 1_000;

/** これより古い申告は「そのウィンドウは応答していない」とみなして集計から外す。 */
export const PARADIS_HEALTH_BEACON_REPORT_MAX_AGE_MS = 3 * PARADIS_HEALTH_BEACON_INTERVAL_MS;

/** 何をきっかけに送ったか。shutdown は「そのセッションの最終形」なので分けて見たい。 */
export type ParadisHealthBeaconReason = 'startup' | 'interval' | 'shutdown';

/**
 * ウィンドウ(renderer)が自分について申告する値。
 * サンドボックス化された renderer では node の `v8` モジュールが使えないため、
 * JSヒープは `performance.memory`(Chromiumが粗く丸めた値)で代用する。傾向を見るには足りる。
 */
export interface IParadisHealthWindowReport {
	readonly windowId: number;
	readonly jsHeapUsed: number;
	readonly jsHeapTotal: number;
	readonly jsHeapLimit: number;
	/** process.getProcessMemoryInfo() のバイト換算。 */
	readonly privateMemory: number;
	readonly residentMemory: number;
	/** 生きているDOM要素数。レンダラー肥大の粗い指標。 */
	readonly domElements: number;
	readonly terminals: number;
	readonly editors: number;
}

/** app.getAppMetrics() 1件ぶん。Electron依存の型を common へ持ち込まないための最小形。 */
export interface IParadisHealthProcessSample {
	readonly kind: 'browser' | 'renderer' | 'gpu' | 'utility' | 'other';
	/** utility の役割(正規化済み)。{@link paradisNormalizeHealthRole} が返す値のみ。 */
	readonly role: string;
	/** working set (バイト)。 */
	readonly memory: number;
	/** CPU使用率(%)。マルチコアでは100を超え得る。 */
	readonly cpu: number;
}

/** main プロセスの V8 統計(node:v8 由来)。 */
export interface IParadisHealthV8Stats {
	readonly heapUsed: number;
	readonly heapTotal: number;
	readonly heapLimit: number;
	readonly external: number;
	readonly malloced: number;
	readonly nativeContexts: number;
	/** 参照が残ったまま切り離されたコンテキスト数。0以外が続くなら典型的なリーク。 */
	readonly detachedContexts: number;
	readonly oldSpaceSize: number;
	readonly oldSpaceUsed: number;
	readonly largeObjectUsed: number;
}

export interface IParadisHealthSnapshot {
	readonly reason: ParadisHealthBeaconReason;
	readonly uptimeMs: number;
	readonly mainV8: IParadisHealthV8Stats;
	readonly mainRss: number;
	readonly mainArrayBuffers: number;
	readonly processes: readonly IParadisHealthProcessSample[];
	readonly windows: readonly IParadisHealthWindowReport[];
	readonly windowCount: number;
	readonly browserViewCount: number;
	readonly hostMemoryTotal: number;
	readonly hostMemoryFree: number;
}

/**
 * ProxyChannel でそのままチャネル化できるよう、公開メソッドはasyncのみ。
 * イベントは `onDid*` 命名で ProxyChannel がそのまま転送する。
 */
export interface IParadisHealthBeaconMainService {
	/** main が収集したいタイミングで発火する。ウィンドウはこれを受けて reportWindow を呼ぶ。 */
	readonly onDidRequestReport: Event<void>;
	reportWindow(report: IParadisHealthWindowReport): Promise<void>;
}

/** Sentry の measurement 1件。単位は Sentry の MeasurementUnit に合わせる。 */
export interface IParadisHealthMeasurement {
	readonly value: number;
	readonly unit: 'byte' | 'ratio' | 'hour' | 'none';
}

/**
 * utility プロセスの名前を、集計に使える固定の役割名へ正規化する。
 *
 * 生の名前をそのまま送らないのは、拡張機能が起動した utility の名前など、こちらが把握していない
 * 文字列が混ざり得るため。許可リストに無いものは 'other' に畳む。
 */
export function paradisNormalizeHealthRole(rawName: string | undefined): string {
	const normalized = (rawName ?? '').toLowerCase();
	if (normalized.includes('extension')) {
		return 'extension_host';
	}
	if (normalized.includes('shared')) {
		return 'shared_process';
	}
	if (normalized.includes('pty')) {
		return 'pty_host';
	}
	if (normalized.includes('watcher')) {
		return 'file_watcher';
	}
	if (normalized.includes('network')) {
		return 'network';
	}
	if (normalized.includes('audio')) {
		return 'audio';
	}
	return 'other';
}

/** 稼働時間のバケット。「長時間で悪化するのか」を全ユーザー横断で見るための主軸。 */
export function paradisBucketUptimeHours(hours: number): string {
	if (!Number.isFinite(hours) || hours < 1) {
		return '<1h';
	}
	if (hours < 4) {
		return '1-4h';
	}
	if (hours < 12) {
		return '4-12h';
	}
	if (hours < 24) {
		return '12-24h';
	}
	return '>24h';
}

/** 個数のバケット。生の数をタグにすると濃度が上がりすぎるので畳む。 */
export function paradisBucketCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) {
		return '0';
	}
	if (count <= 2) {
		return '1-2';
	}
	if (count <= 5) {
		return '3-5';
	}
	if (count <= 10) {
		return '6-10';
	}
	if (count <= 20) {
		return '11-20';
	}
	if (count <= 50) {
		return '21-50';
	}
	return '>50';
}

function finite(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + finite(value), 0);
}

function max(values: readonly number[]): number {
	return values.reduce((highest, value) => Math.max(highest, finite(value)), 0);
}

/** Sentry でグルーピングに使うタグ。値は必ず低濃度の固定文字列にする。 */
export function paradisBuildHealthTags(snapshot: IParadisHealthSnapshot): Record<string, string> {
	const terminals = sum(snapshot.windows.map(window => window.terminals));
	return {
		'para.health.v': PARADIS_HEALTH_BEACON_SCHEMA_VERSION,
		'para.health.reason': snapshot.reason,
		'para.uptime_bucket': paradisBucketUptimeHours(snapshot.uptimeMs / 3_600_000),
		'para.terminals_bucket': paradisBucketCount(terminals),
		'para.browser_views_bucket': paradisBucketCount(snapshot.browserViewCount),
		'para.windows_bucket': paradisBucketCount(snapshot.windowCount),
	};
}

/**
 * Sentry の measurements。`avg()` / `p95()` で全ユーザー分を集計できる形にする。
 *
 * バイト値をそのまま送るのは、Sentry 側で単位変換して表示してくれるため。
 * 端末の総メモリも一緒に送るので、8GB機と64GB機を混ぜて平均する事故を後から避けられる。
 */
export function paradisBuildHealthMeasurements(snapshot: IParadisHealthSnapshot): Record<string, IParadisHealthMeasurement> {
	const byKind = (kind: IParadisHealthProcessSample['kind']): readonly IParadisHealthProcessSample[] =>
		snapshot.processes.filter(process => process.kind === kind);
	const byRole = (role: string): readonly IParadisHealthProcessSample[] =>
		snapshot.processes.filter(process => process.role === role);

	const renderers = byKind('renderer');
	const utilities = byKind('utility');
	const oldSpaceSize = finite(snapshot.mainV8.oldSpaceSize);

	const byteValue = (value: number): IParadisHealthMeasurement => ({ value: finite(value), unit: 'byte' });
	const countValue = (value: number): IParadisHealthMeasurement => ({ value: finite(value), unit: 'none' });

	const measurements: Record<string, IParadisHealthMeasurement> = {
		// main プロセス。今回のリークはこの3本(特に old_space_used)で捉えられる。
		'main.v8.old_space_used': byteValue(snapshot.mainV8.oldSpaceUsed),
		'main.v8.old_space_size': byteValue(oldSpaceSize),
		'main.v8.old_space_live_ratio': {
			value: oldSpaceSize > 0 ? Math.min(1, finite(snapshot.mainV8.oldSpaceUsed) / oldSpaceSize) : 0,
			unit: 'ratio',
		},
		'main.v8.heap_used': byteValue(snapshot.mainV8.heapUsed),
		'main.v8.heap_total': byteValue(snapshot.mainV8.heapTotal),
		'main.v8.heap_limit': byteValue(snapshot.mainV8.heapLimit),
		'main.v8.large_object_used': byteValue(snapshot.mainV8.largeObjectUsed),
		'main.v8.external': byteValue(snapshot.mainV8.external),
		'main.v8.malloced': byteValue(snapshot.mainV8.malloced),
		'main.v8.native_contexts': countValue(snapshot.mainV8.nativeContexts),
		'main.v8.detached_contexts': countValue(snapshot.mainV8.detachedContexts),
		'main.rss': byteValue(snapshot.mainRss),
		'main.array_buffers': byteValue(snapshot.mainArrayBuffers),

		// プロセス種別ごとの working set。どのプロセスがネックかの切り分け。
		'app.memory_total': byteValue(sum(snapshot.processes.map(process => process.memory))),
		'app.cpu_total': countValue(sum(snapshot.processes.map(process => process.cpu))),
		'app.process_count': countValue(snapshot.processes.length),
		'renderer.memory_total': byteValue(sum(renderers.map(process => process.memory))),
		'renderer.memory_max': byteValue(max(renderers.map(process => process.memory))),
		'renderer.count': countValue(renderers.length),
		'gpu.memory': byteValue(sum(byKind('gpu').map(process => process.memory))),
		'utility.memory_total': byteValue(sum(utilities.map(process => process.memory))),
		'utility.count': countValue(utilities.length),
		'extension_host.memory': byteValue(sum(byRole('extension_host').map(process => process.memory))),
		'shared_process.memory': byteValue(sum(byRole('shared_process').map(process => process.memory))),
		'pty_host.memory': byteValue(sum(byRole('pty_host').map(process => process.memory))),
		'file_watcher.memory': byteValue(sum(byRole('file_watcher').map(process => process.memory))),

		// ウィンドウ側の自己申告。renderer の JS ヒープと構成の重さ。
		'window.count': countValue(snapshot.windowCount),
		'window.reported': countValue(snapshot.windows.length),
		'window.js_heap_total': byteValue(sum(snapshot.windows.map(window => window.jsHeapUsed))),
		'window.js_heap_max': byteValue(max(snapshot.windows.map(window => window.jsHeapUsed))),
		'window.private_memory_total': byteValue(sum(snapshot.windows.map(window => window.privateMemory))),
		'window.dom_elements_max': countValue(max(snapshot.windows.map(window => window.domElements))),
		'terminal.count': countValue(sum(snapshot.windows.map(window => window.terminals))),
		'editor.count': countValue(sum(snapshot.windows.map(window => window.editors))),
		'browser_view.count': countValue(snapshot.browserViewCount),

		// 正規化用。端末差を無視して平均すると解釈を誤る。
		'host.memory_total': byteValue(snapshot.hostMemoryTotal),
		'host.memory_free': byteValue(snapshot.hostMemoryFree),
		'uptime': { value: finite(snapshot.uptimeMs / 3_600_000), unit: 'hour' },
	};

	return measurements;
}

/**
 * 1イベントを個別に開いたときに読む用の内訳。
 * `para.` で始まる context はサニタイザが残す(paradisSentryCommon.ts)。
 */
export function paradisBuildHealthContext(snapshot: IParadisHealthSnapshot): Record<string, unknown> {
	return {
		reason: snapshot.reason,
		uptime_hours: Math.round(snapshot.uptimeMs / 360_000) / 10,
		process_count: snapshot.processes.length,
		window_count: snapshot.windowCount,
		reported_window_count: snapshot.windows.length,
		browser_view_count: snapshot.browserViewCount,
		// 上位10件だけ。役割と数値しか含まないので識別にはつながらない。
		top_processes: [...snapshot.processes]
			.sort((left, right) => right.memory - left.memory)
			.slice(0, 10)
			.map(process => ({ kind: process.kind, role: process.role, memory: process.memory, cpu: Math.round(process.cpu) })),
	};
}
