/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペースの切り替えが遅かったときにウィンドウのログへ出す 1 行を組み立てる。
 *
 * 段階ごとの時間は Sentry にしか送っていなかったので、Sentry が上限に達している間は遅かった回の
 * 中身を誰も読めなかった。renderer の `ILogService` は SSH のウィンドウでも手元のマシンの
 * ウィンドウのログ（`window<N>/renderer.log`）に書くので、接続先には何も足さずに手元で読める。
 *
 * **パス・ホスト名・スペース名は入れない。** 入れるのは数と時間と段階の名前だけ。
 */

import { IParadisFileIoSideSummary, ParadisFileIoSide } from './paradisFileIoWatch.js';

/** これより長くかかった切り替え（クリックしてから終わるまで）だけをログに出す。 */
export const PARADIS_SLOW_SWITCH_LOG_THRESHOLD_MS = 2_000;

export interface IParadisSlowSwitchSample {
	/** クリック（要求）から、前の切り替えを待って本体が始まるまで。 */
	readonly queuedMs: number;
	/** 本体の所要時間。 */
	readonly totalMs: number;
	readonly completed: boolean;
	readonly failed: boolean;
	readonly targetRemote: boolean;
	readonly sourceRemote: boolean | undefined;
	/** 段階ごとの所要時間（ms）。入れた順に出す。 */
	readonly phaseMs: Readonly<Record<string, number>>;
	readonly io: Readonly<Record<ParadisFileIoSide, IParadisFileIoSideSummary>>;
	readonly fileEvents: number;
	readonly configEvents: number;
	/** 切り替えの要求より前の、最後の削除からの経過（ms）。このウィンドウで削除していなければ undefined。 */
	readonly lastDeleteAgoMs: Readonly<Record<ParadisFileIoSide, number | undefined>>;
}

/** 締め切りの警告のときの、まだ終わっていない切り替えの様子。 */
export interface IParadisStuckSwitchSample {
	readonly elapsedMs: number;
	/** いま走っている段階と、その段階に入ってからの時間。段階の外（段階の間）なら undefined。 */
	readonly phase: string | undefined;
	readonly phaseElapsedMs: number | undefined;
	readonly phaseMs: Readonly<Record<string, number>>;
	readonly io: Readonly<Record<ParadisFileIoSide, IParadisFileIoSideSummary>>;
	readonly lastDeleteAgoMs: Readonly<Record<ParadisFileIoSide, number | undefined>>;
}

export function paradisShouldLogSlowSwitch(sample: Pick<IParadisSlowSwitchSample, 'queuedMs' | 'totalMs'>): boolean {
	return sample.queuedMs + sample.totalMs > PARADIS_SLOW_SWITCH_LOG_THRESHOLD_MS;
}

function ms(value: number): string {
	return `${Math.max(0, Math.round(value))}ms`;
}

function formatPhases(phaseMs: Readonly<Record<string, number>>): string {
	const entries = Object.entries(phaseMs).filter(([, value]) => Number.isFinite(value));
	return entries.length === 0 ? 'none' : entries.map(([name, value]) => `${name}=${Math.max(0, Math.round(value))}`).join(' ');
}

function formatIo(side: ParadisFileIoSide, io: IParadisFileIoSideSummary): string {
	const stat = io.minStatMs === undefined || io.maxStatMs === undefined ? 'none' : `${ms(io.minStatMs)}..${ms(io.maxStatMs)}`;
	return `${side} io: calls=${io.calls} failed=${io.failed} deletes=${io.deletes} inflight start=${io.inflightAtStart} peak=${io.maxInflight} now=${io.inflightNow} (deletes ${io.inflightDeletesNow}, oldest ${ms(io.oldestInflightMs)}) slowest=${ms(io.maxMs)} stat=${stat}`;
}

function formatLastDelete(lastDeleteAgoMs: Readonly<Record<ParadisFileIoSide, number | undefined>>): string {
	const parts = (['remote', 'local'] as const).map(side => `${side} ${lastDeleteAgoMs[side] === undefined ? 'none' : `${Math.round(lastDeleteAgoMs[side] / 1000)}s ago`}`);
	return `last delete: ${parts.join(', ')}`;
}

export function paradisFormatSlowSwitchLog(sample: IParadisSlowSwitchSample): string {
	const outcome = sample.completed ? 'completed' : sample.failed ? 'failed' : 'not completed';
	const where = `target ${sample.targetRemote ? 'remote' : 'local'}, source ${sample.sourceRemote === undefined ? 'none' : sample.sourceRemote ? 'remote' : 'local'}`;
	return [
		`[ParadisWorkspaceSwitch] Slow space switch: ${ms(sample.queuedMs + sample.totalMs)} (queued ${ms(sample.queuedMs)}, body ${ms(sample.totalMs)}, ${outcome}, ${where})`,
		`phases: ${formatPhases(sample.phaseMs)}`,
		formatIo('remote', sample.io.remote),
		formatIo('local', sample.io.local),
		`file events=${sample.fileEvents} config events=${sample.configEvents}`,
		formatLastDelete(sample.lastDeleteAgoMs),
	].join(' | ');
}

export function paradisFormatStuckSwitchLog(sample: IParadisStuckSwitchSample): string {
	const current = sample.phase === undefined ? 'between phases' : `in ${sample.phase} for ${ms(sample.phaseElapsedMs ?? 0)}`;
	return [
		`[ParadisWorkspaceSwitch] Space switch still running after ${ms(sample.elapsedMs)}: ${current}`,
		`finished phases: ${formatPhases(sample.phaseMs)}`,
		formatIo('remote', sample.io.remote),
		formatIo('local', sample.io.local),
		formatLastDelete(sample.lastDeleteAgoMs),
	].join(' | ');
}
