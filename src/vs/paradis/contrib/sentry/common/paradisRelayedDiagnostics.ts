/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Sentry の SDK を持たない pty host（手元でも SSH 先でも）で出た
// 明示の報告（`reportParadisDiagnosticError`）を、種類ごとの件数だけ数えて溜め、窓が取りに来たら
// 渡す。送るのは窓（手元の renderer）で、SSH 先からは直接送らない。
//
// 経路は常駐の引き継ぎの記録（`ptyDaemon/common/paradisPtyHandover.ts`）と同じで、記録の省略可能な
// 欄 `failures` に載る。取ると消えるので、同じ pty host を見ている窓が何枚あっても二重には送らない。
//
// 溜めるのは feature・operation・例外の型名・errno・件数だけ。例外のメッセージ・スタック・呼び出し
// 側の追加情報は溜めない（パスやコマンドが入り得る）。受け取る窓の側でも同じ検査をもう一度かける。
// SSH 先は別の機械なので、そこから来た値を信じ切らない。

import { ParadisDiagnosticSafeData, ParadisDiagnosticSeverity, configureParadisDiagnosticReporter, paradisSafeErrorExtra, paradisSafeErrorName } from './paradisSentryDiagnostics.js';

/** 1種類ぶんの記録。 */
export interface IParadisRelayedFailure {
	readonly feature: string;
	readonly operation: string;
	/** `paradisSafeErrorName` の結果（例外の型名など。内容は含まない）。 */
	readonly errorName: string;
	/** Node の errno（`ENOENT` 等）。無ければ省く。 */
	readonly errno?: string;
	readonly severity: ParadisDiagnosticSeverity;
	readonly count: number;
}

/** 溜める種類の上限。窓が来ないまま溢れた分は捨てて、捨てた数だけ数える。 */
const MAX_KINDS = 30;
/** 1種類の件数の上限。届いた値がこれを超えていても、ここで止める。 */
const MAX_COUNT = 1_000_000;
const LABEL = /^[a-z0-9][a-z0-9:._-]{0,63}$/i;
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,49}$/;
const ERRNO = /^E[A-Z0-9_]{1,30}$/;
const SEVERITIES: ReadonlySet<string> = new Set<ParadisDiagnosticSeverity>(['info', 'warning', 'error']);

/** feature・operation はコードの固定の語のはず。そうでなければ中身を捨てて `other` にする。 */
function label(value: unknown): string {
	return typeof value === 'string' && LABEL.test(value) ? value : 'other';
}

interface IMutableFailure {
	readonly feature: string;
	readonly operation: string;
	readonly errorName: string;
	readonly errno: string | undefined;
	readonly severity: ParadisDiagnosticSeverity;
	count: number;
}

const pending = new Map<string, IMutableFailure>();
let dropped = 0;

/** このプロセスの明示の報告を、Sentry へ送る代わりにここへ溜める。SDK を持たないプロセスで1回だけ呼ぶ。 */
export function paradisRelayDiagnosticsFromThisProcess(): void {
	configureParadisDiagnosticReporter((_scope, feature, operation, error, _safeExtra, severity) => paradisRecordRelayedFailure(feature, operation, error, severity));
}

/** 1件数える。テストと、報告の経路を通さずに数えたい呼び出し元のために export する。 */
export function paradisRecordRelayedFailure(feature: string, operation: string, error: unknown, severity: ParadisDiagnosticSeverity = 'error'): void {
	const safeFeature = label(feature);
	const safeOperation = label(operation);
	const errorName = paradisSafeErrorName(error);
	const errno = paradisSafeErrorExtra(error).safe_errno;
	const key = [safeFeature, safeOperation, errorName, errno ?? '', severity].join('\u0000');
	const existing = pending.get(key);
	if (existing) {
		existing.count = Math.min(existing.count + 1, MAX_COUNT);
		return;
	}
	if (pending.size >= MAX_KINDS) {
		dropped++;
		return;
	}
	pending.set(key, { feature: safeFeature, operation: safeOperation, errorName, errno, severity, count: 1 });
}

/** 溜まっているものがあるか。 */
export function paradisHasRelayedFailures(): boolean {
	return pending.size > 0 || dropped > 0;
}

/** 溜まった分を渡して空にする。溢れて捨てた分は `relay.overflow` の1種類として渡す。 */
export function paradisTakeRelayedFailures(): IParadisRelayedFailure[] {
	const failures: IParadisRelayedFailure[] = [...pending.values()].map(failure => ({
		feature: failure.feature,
		operation: failure.operation,
		errorName: failure.errorName,
		...(failure.errno !== undefined ? { errno: failure.errno } : {}),
		severity: failure.severity,
		count: failure.count,
	}));
	if (dropped > 0) {
		failures.push({ feature: 'relay', operation: 'overflow', errorName: 'none', severity: 'warning', count: dropped });
	}
	pending.clear();
	dropped = 0;
	return failures;
}

/** 窓が Sentry へ送る1件ぶん。 */
export interface IParadisRelayedFailureReport {
	readonly feature: string;
	readonly operation: string;
	/** 型名と errno だけを持つ代わりの例外。送る経路はこれから内容の無いタグと追加情報を作る。 */
	readonly error: Error;
	readonly severity: ParadisDiagnosticSeverity;
	readonly data: ParadisDiagnosticSafeData;
}

function relayedError(name: string, code: string | undefined): Error {
	const error = new Error('');
	error.name = name;
	// フレームは窓のもので、失敗した場所のものではない。種類だけを残す。
	error.stack = '';
	if (code !== undefined) {
		Object.assign(error, { code });
	}
	return error;
}

/**
 * 受け取った記録を、窓が送る形に直す。形の合わないものは黙って捨てる（古い・新しい版や、
 * 壊れた返事が来ても窓は落ちない）。
 */
export function paradisRelayedFailureReports(
	failures: unknown,
	context: { readonly remote: boolean; readonly hostOs: string },
): IParadisRelayedFailureReport[] {
	if (!Array.isArray(failures)) {
		return [];
	}
	const reports: IParadisRelayedFailureReport[] = [];
	for (const failure of failures.slice(0, MAX_KINDS + 1)) {
		if (typeof failure !== 'object' || failure === null) {
			continue;
		}
		const value = failure as Partial<Record<keyof IParadisRelayedFailure, unknown>>;
		const count = typeof value.count === 'number' && Number.isInteger(value.count) && value.count > 0 ? Math.min(value.count, MAX_COUNT) : undefined;
		if (count === undefined) {
			continue;
		}
		const errorName = typeof value.errorName === 'string' && ERROR_NAME.test(value.errorName) ? value.errorName : 'unknown';
		const errno = typeof value.errno === 'string' && ERRNO.test(value.errno) ? value.errno : undefined;
		const severity = typeof value.severity === 'string' && SEVERITIES.has(value.severity) ? value.severity as ParadisDiagnosticSeverity : 'warning';
		reports.push({
			feature: label(value.feature),
			operation: label(value.operation),
			error: relayedError(errorName, errno),
			severity,
			data: {
				safe_count: count,
				safe_remote: context.remote,
				safe_host_os: label(context.hostOs),
			},
		});
	}
	return reports;
}
