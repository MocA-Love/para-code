/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// NOTE: main-process only, and importing this module has a side effect: it wraps
// `protocol.registerSchemesAsPrivileged` (see below). Importing it from a process without Electron's
// `protocol` API (utility/shared process) would throw at import time, not at first call.

import { app, protocol } from 'electron';
import type * as SentryMain from '@sentry/electron/main';
import { ParadisPrivilegedSchemeRecorder } from '../common/paradisPrivilegedSchemes.js';
import { PARADIS_SENTRY_DESKTOP_DSN, PARADIS_SENTRY_ENVIRONMENT, paradisSentryRelease } from '../common/paradisSentryConfiguration.js';
import { configureParadisDiagnosticReporter, configureParadisDiagnosticTagSetter, ParadisDiagnosticSeverity, toParadisSentrySafeError } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';
import { registerParadisProcessGoneDiagnostics } from './paradisProcessGoneDiagnostics.js';

let sentry: typeof SentryMain | undefined;

type ParadisCustomScheme = Parameters<typeof protocol.registerSchemesAsPrivileged>[0][number];

/**
 * Keeps every privileged scheme registration alive, no matter who registers last.
 *
 * `protocol.registerSchemesAsPrivileged()` rebuilds the Chromium command-line switches
 * (`--secure-schemes`, `--cors-schemes`, `--fetch-schemes`, …) from the schemes of whichever call
 * ran last, so a later caller silently strips the privileges an earlier caller registered.
 * `@sentry/electron` registers its own `sentry-ipc` scheme from inside `Sentry.init()`, and because
 * our init is deferred behind a dynamic import (see below) it always runs *after* `src/main.ts` has
 * registered `vscode-file` and `vscode-webview`. The renderer then launched with
 * `--secure-schemes=sentry-ipc` only: the workbench stopped being a secure context, `crypto.subtle`
 * became undefined and every webview failed to mount (paracode-68/69).
 *
 * The wrapper is installed at module evaluation — `src/main.ts` imports this file, and ESM
 * evaluates imports before the importing module's body, so it is in place before the first
 * registration. Every call then re-registers the accumulated set, which also covers registrations
 * made after Sentry's, and does not depend on Sentry's own overwrite-guarding proxy.
 */
const originalRegisterSchemesAsPrivileged = protocol.registerSchemesAsPrivileged;
const privilegedSchemeRecorder = new ParadisPrivilegedSchemeRecorder<ParadisCustomScheme>(
	// `call` is required here: the recorder replaces a method on Electron's `protocol` object.
	schemes => originalRegisterSchemesAsPrivileged.call(protocol, schemes),
);
protocol.registerSchemesAsPrivileged = function paradisRecordingRegisterSchemesAsPrivileged(customSchemes: ParadisCustomScheme[]): void {
	privilegedSchemeRecorder.add(customSchemes);
};

/** パッケージ版へのCIスモークは VSCODE_DEV を立てないため、実ユーザーと同じ環境に混ざるのを防ぐ。 */
function isTruthyEnv(value: string | undefined): boolean {
	return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

export function initializeParadisSentryMain(commit: string | undefined, onUnavailable: () => void): void {
	if (sentry) {
		return;
	}

	// Sentry の準備を待たずに登録する。ここで落ちるのは起動直後が多く、待つとその分を取りこぼす。
	registerParadisProcessGoneDiagnostics();

	// '@sentry/electron/main' MUST be loaded with a dynamic import: the packaged main
	// bundle keeps npm dependencies external (they live in node_modules.asar), and the
	// bundle's own static imports are resolved by Node's default ESM resolver BEFORE any
	// code runs — i.e. before bootstrap-esm registers the node_modules.asar loader hook.
	// A static import therefore crashes packaged builds at link time with
	// ERR_MODULE_NOT_FOUND (this bricked the paracode-68 release). By the time this
	// dynamic import executes, the loader hook is registered and resolves the package
	// from the archive.
	import('@sentry/electron/main').then(Sentry => {
		Sentry.init({
			dsn: PARADIS_SENTRY_DESKTOP_DSN,
			// パッケージ版に対する CI のスモークテストは VSCODE_DEV を立てないため、
			// これが無いと自動テストのクラッシュが実ユーザーと同じ production に混ざる。
			// CI=false を明示するツールがあるので truthy 判定にはしない。
			environment: process.env['VSCODE_DEV'] || isTruthyEnv(process.env['CI']) || isTruthyEnv(process.env['GITHUB_ACTIONS'])
				? 'local'
				: PARADIS_SENTRY_ENVIRONMENT,
			release: paradisSentryRelease(app.getVersion(), commit),
			dist: `${process.platform}-${process.arch}`,
			sendDefaultPii: false,
			attachScreenshot: false,
			includeLocalVariables: false,
			enableLogs: false,
			tracesSampler: context => context.name.startsWith('para.') ? 1 : 0,
			beforeBreadcrumb: breadcrumb => paradisPrepareSentryBreadcrumb(breadcrumb),
			beforeSend: event => paradisPrepareSentryEvent(event, 'main'),
			beforeSendTransaction: event => paradisPrepareSentryTransaction(event, 'main'),
		});

		Sentry.setTags({
			'para.scope': 'unknown',
			'process.type': 'main',
			'device.arch': process.arch,
			'os.name': process.platform,
		});
		configureParadisDiagnosticTagSetter((key, value) => Sentry.setTag(key, value));
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
			captureParadisMainException(scope, feature, operation, error, safeExtra, severity);
		});
		sentry = Sentry;
	}).catch(error => {
		console.error('[Para Code] Failed to initialize Sentry; using the existing crash reporter fallback.', error);
		onUnavailable();
	});
}

/**
 * 数値だけのスナップショットを `para.` トランザクションとして送る（定期ヘルスビーコン用）。
 *
 * 例外ではないので captureException とは経路を分ける。`tracesSampler` が `para.` 始まりを100%
 * 拾い、`beforeSendTransaction`（paradisPrepareSentryTransaction）がサニタイズして通す。
 * measurements は Sentry 側で `avg()` / `p95()` の対象になるため、全ユーザー分の分布が取れる。
 */
export function captureParadisMainMeasurementSnapshot(
	name: string,
	tags: Record<string, string>,
	measurements: Record<string, { readonly value: number; readonly unit: 'byte' | 'ratio' | 'hour' | 'none' }>,
	context: Record<string, unknown>,
): void {
	if (!sentry) {
		return;
	}
	const Sentry = sentry;
	Sentry.withScope(scope => {
		scope.setTags(tags);
		scope.setContext('para.health', context);
		// measurement は**1トランザクション10個まで**で、超えた分は取り込み時に黙って捨てられる。
		// context へ回した分は1イベントを開けば読めるが、`avg()` や「ブラウザ枚数とヒープの関係」の
		// ような**横断集計ができない**（context は Discover の集計対象外）。
		// span attribute は `contexts.trace.data` に載り、spans データセットで
		// `tags[<key>,number]` として集計できる（切替計装で到達実績あり）ので、数値はこちらへも出す。
		// 狙いは「10個枠に入れなかったものを集計可能な場所へ逃がす」こと。ただし context には
		// measurement と同じ量（`process_count` / `uptime_hours`）も入っているので、
		// **一部は意図的に重複する**。丸めが違うだけの同じ指標が2つの名前で並ぶ点に注意。
		const overflowAttributes = new Map<`safe_${string}`, number>();
		for (const [key, value] of Object.entries(context)) {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				continue;
			}
			// 順位つきの内訳は集計に載せない。1位が main の回と renderer の回が混ざるので
			// `avg(safe_top1_memory)` は別プロセスの平均になり、意味のある数字にならない。
			// 対になる役割名は文字列でここを通らないため、後から解釈することもできない。
			if (/^safe_top\d+_/.test(key)) {
				continue;
			}
			const attributeKey: `safe_${string}` = key.startsWith('safe_') ? key as `safe_${string}` : `safe_${key}`;
			// `foo` と `safe_foo` が同居すると導出後に衝突する。今の context に衝突は無いが、
			// 将来キーが増えたときに黙って1本消えるほうが厄介なので、先勝ちで固定する。
			if (overflowAttributes.has(attributeKey)) {
				continue;
			}
			overflowAttributes.set(attributeKey, value);
		}
		Sentry.startSpan({
			name,
			op: 'para.health',
			attributes: {
				'para.scope': 'owned',
				'para.feature': 'healthBeacon',
				'para.operation': 'snapshot',
				...Object.fromEntries(overflowAttributes),
			},
		}, () => {
			for (const [key, measurement] of Object.entries(measurements)) {
				Sentry.setMeasurement(key, measurement.value, measurement.unit);
			}
		});
	});
}

/**
 * 送信キューを吐き切るまで待つ。終了時の1本は「そのセッションの最終形」で最も価値が高いのに、
 * 待たないとプロセス終了に間に合わず落ちる。
 */
export async function flushParadisMainSentry(timeoutMs: number): Promise<void> {
	if (!sentry) {
		return;
	}
	try {
		await sentry.flush(timeoutMs);
	} catch {
		/* 送れなくても終了は止めない */
	}
}

export function captureParadisMainException(
	scope: 'owned' | 'patched',
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
	severity?: ParadisDiagnosticSeverity,
): string {
	if (!sentry) {
		return '';
	}
	const Sentry = sentry;
	return Sentry.withScope(sentryScope => {
		sentryScope.setTags({
			'para.scope': scope,
			'para.feature': feature,
			'para.operation': operation,
		});
		if (safeExtra) {
			sentryScope.setExtras(safeExtra);
		}
		if (severity) {
			sentryScope.setLevel(severity);
		}
		Sentry.addBreadcrumb({ category: `para.${feature}`, message: operation, data: safeExtra });
		return Sentry.captureException(toParadisSentrySafeError(feature, operation, error));
	});
}
