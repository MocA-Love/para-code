/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 引き継ぎの出来事を pty ホストの中で数える。窓が取りに来たら渡して、数え直す。
//
// **このプロセスに1つ。** 数える側（引き取り・手を離す・戻ってくる）はあちこちに散っているが、
// どれも同じ pty ホストの中で起きる。置き場所を1つにして、ここだけが可変であることを明示する。
//
// 取りに来る窓が居ないこともある（SSH 先で誰も繋いでいない）。引き取りの記録だけは件数に上限を
// 置き、古いものから捨てる。数え上げは数なので膨らまない。

import { IParadisPtyAdoptionRun, IParadisPtyHandoverReport, IParadisPtyReattachCounts } from '../common/paradisPtyHandover.js';
import { PARADIS_PTY_PROTOCOL_VERSION } from '../common/paradisPtyProtocol.js';
import { ParadisPtyRebuildReason } from '../common/paradisPtyReattachPlan.js';
import { paradisTakeRelayedFailures } from '../../sentry/common/paradisRelayedDiagnostics.js';

/** 窓が取りに来ないまま溜める引き取りの記録の上限。 */
const MAX_ADOPTION_RUNS = 20;

interface IMutableReattachCounts {
	unchanged: number;
	tail: number;
	rebuild: number;
	handedOff: number;
	gone: number;
	failed: number;
	tailChars: number;
	rebuildChars: number;
	maxRebuildMs: number;
	rebuildReasons: Partial<Record<ParadisPtyRebuildReason, number>>;
}

function emptyReattach(): IMutableReattachCounts {
	return { unchanged: 0, tail: 0, rebuild: 0, handedOff: 0, gone: 0, failed: 0, tailChars: 0, rebuildChars: 0, maxRebuildMs: 0, rebuildReasons: {} };
}

let adoptions: IParadisPtyAdoptionRun[] = [];
let letGo = 0;
let letGoFailed = 0;
let reattach = emptyReattach();
let spared = 0;
let finishedWhileAway = 0;

/** 戻ってきたときの埋め直し方。 */
export type ParadisPtyReattachOutcomeKind = 'unchanged' | 'tail' | 'rebuild' | 'handed-off' | 'gone' | 'failed';

export function paradisRecordAdoptionRun(run: IParadisPtyAdoptionRun): void {
	adoptions.push(run);
	if (adoptions.length > MAX_ADOPTION_RUNS) {
		adoptions = adoptions.slice(adoptions.length - MAX_ADOPTION_RUNS);
	}
}

export function paradisRecordLetGo(succeeded: boolean): void {
	if (succeeded) {
		letGo++;
	} else {
		letGoFailed++;
	}
}

export function paradisRecordReattach(kind: ParadisPtyReattachOutcomeKind, detail?: { readonly chars?: number; readonly durationMs?: number; readonly reason?: ParadisPtyRebuildReason }): void {
	switch (kind) {
		case 'unchanged':
			reattach.unchanged++;
			break;
		case 'tail':
			reattach.tail++;
			reattach.tailChars += detail?.chars ?? 0;
			break;
		case 'rebuild':
			reattach.rebuild++;
			reattach.rebuildChars += detail?.chars ?? 0;
			reattach.maxRebuildMs = Math.max(reattach.maxRebuildMs, Math.round(detail?.durationMs ?? 0));
			if (detail?.reason) {
				reattach.rebuildReasons[detail.reason] = (reattach.rebuildReasons[detail.reason] ?? 0) + 1;
			}
			break;
		case 'handed-off':
			reattach.handedOff++;
			break;
		case 'gone':
			reattach.gone++;
			break;
		case 'failed':
			reattach.failed++;
			break;
	}
}

export function paradisRecordSpared(): void {
	spared++;
}

export function paradisRecordFinishedWhileAway(): void {
	finishedWhileAway++;
}

/**
 * 前回からの分を渡して数え直す。
 *
 * @param current いまの様子（常駐に繋がっているか、別の pty ホストが握っている本数）。数え上げとは
 * 別に、渡す時点の値をそのまま載せる。
 */
export function paradisTakePtyHandoverReport(current: { readonly daemon: boolean; readonly foreignHeld: number }): IParadisPtyHandoverReport {
	const counts: IParadisPtyReattachCounts = { ...reattach, rebuildReasons: { ...reattach.rebuildReasons } };
	const failures = paradisTakeRelayedFailures();
	const report: IParadisPtyHandoverReport = {
		protocolVersion: PARADIS_PTY_PROTOCOL_VERSION,
		platform: process.platform,
		daemon: current.daemon,
		foreignHeld: current.foreignHeld,
		adoptions,
		letGo,
		letGoFailed,
		reattach: counts,
		spared,
		finishedWhileAway,
		...(failures.length > 0 ? { failures } : {}),
	};
	adoptions = [];
	letGo = 0;
	letGoFailed = 0;
	reattach = emptyReattach();
	spared = 0;
	finishedWhileAway = 0;
	return report;
}
