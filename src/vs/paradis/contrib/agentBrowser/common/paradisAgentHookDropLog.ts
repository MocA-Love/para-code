/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの hook を受け口で捨てたときの診断ログ。捨てた分岐（理由）・手元か接続先か・pid の有無などを
// 1 行にまとめ、ペインと理由の組ごとに数えて、初回と件数が 2 の累乗に達したときだけ出す。
// 診断専用で、hook を受け入れるか捨てるかの判定には一切関わらない。会話のパスやペインの token そのものは
// 出さない（transcript はファイル名の末尾数文字、ペインは呼び出し側のフィンガープリントだけ）。

/** pid を使わない判定（transcript だけで照合する fail-closed 側）に落ちたわけ。 */
export type ParadisHookIdentityLoss =
	/** hook に pid が無い（接続先の hook・旧スクリプト）。 */
	| 'no-pid'
	/** プロセス表が取れなかった。 */
	| 'no-snapshot'
	/** pid は来たが、プロセス表の控えにその pid が無かった。 */
	| 'pid-not-in-snapshot'
	/** pid は控えにあったが、Para Code 自身かその祖先に当たった（ペインの外）。 */
	| 'pid-outside-panes'
	/** pid の祖先にエージェントのプロセスが見つからなかった。 */
	| 'no-emitter'
	/** 分類の途中で例外が出た。 */
	| 'error';

/** 受け口で hook を断った（404 / 503）ときの、ペインの印の状態。 */
export type ParadisHookIngressCause =
	| 'no-token'
	| 'server-disposed'
	| 'authority-faulted'
	| 'faulted-pane'
	| 'exited-pane'
	| 'unknown-pane'
	/** まだ同期していないだけかもしれないペイン（503 を返し、notify スクリプトが控える）。 */
	| 'unsynced';

export type ParadisAgentHookDropReason =
	/** pid で辿った発信元が、生きている所有者の配下にいない。 */
	| 'origin-not-ancestor'
	/** pid を使わない判定で、所有者の transcript と違う transcript の hook だった。 */
	| 'origin-transcript-mismatch'
	/** 控えから流し直した hook が所有者の transcript と違った。 */
	| 'spool-origin-mismatch'
	/** 許可待ち・質問中のペインに、確かめられない送り主から hook が来た。 */
	| 'wait-caller-unverified'
	/** 受け口でペインの印が使えなかった。 */
	| `ingress-${ParadisHookIngressCause}`
	/** 受け付けた後、処理の途中でペインの印が使えなくなった。 */
	| `lease-lost-${ParadisHookIngressCause}`;

export interface IParadisAgentHookDropRecord {
	readonly reason: ParadisAgentHookDropReason;
	/** ペインの token のフィンガープリント（token そのものは渡さない）。 */
	readonly pane: string;
	readonly event: string;
	readonly side: 'local' | 'remote';
	/** hook の pid: 来た / 来なかった / 来たが接続先なので使わなかった。 */
	readonly pid: 'sent' | 'absent' | 'stripped';
	readonly status?: number;
	readonly identityLoss?: ParadisHookIdentityLoss;
	/** 所有者が pid で決まっているか、transcript だけで決まっているか。 */
	readonly ownerPinnedBy?: 'pid' | 'transcript';
	readonly transcriptPath?: string;
	readonly ownerTranscriptPath?: string;
	/** 所有者の記録を最後に更新してからの時間。 */
	readonly ownerIdleMs?: number;
	/** 使ったプロセス表の控えの古さ。 */
	readonly snapshotAgeMs?: number;
}

const MAX_EVENT_LENGTH = 40;
const TRANSCRIPT_TAIL_LENGTH = 6;
/** ペインと理由の組を覚える上限（知らない token が大量に来ても膨らませない）。 */
export const PARADIS_HOOK_DROP_MAX_COUNTER_KEYS = 2_048;
/** 知らない token をまとめて数えるときのペインのキー（token を毎回変えられても間引きを効かせる）。 */
export const PARADIS_HOOK_DROP_UNKNOWN_PANE = 'unknown';

/** 数えるときのペインのキー。知っているペインだけフィンガープリントで分け、知らないものは 1 つにまとめる。 */
export function paradisHookDropPaneKey(known: boolean, fingerprint: () => string): string {
	return known ? fingerprint() : PARADIS_HOOK_DROP_UNKNOWN_PANE;
}

/** 件数が 1 か 2 の累乗のときだけ出す。 */
export function paradisShouldEmitHookDropLog(count: number): boolean {
	return Number.isSafeInteger(count) && count >= 1 && count <= 0x4000_0000 && (count & (count - 1)) === 0;
}

/** transcript のファイル名（拡張子を除く）の末尾数文字。ディレクトリやユーザー名は出さない。 */
export function paradisHookTranscriptTail(transcriptPath: string | undefined): string {
	if (transcriptPath === undefined || transcriptPath.length === 0) {
		return '-';
	}
	const basename = transcriptPath.split(/[\\/]/).pop() ?? '';
	const stem = basename.replace(/\.jsonl?$/i, '').replace(/[^A-Za-z0-9_-]/g, '');
	return stem.length === 0 ? '?' : `~${stem.slice(-TRANSCRIPT_TAIL_LENGTH)}`;
}

/** イベント名をログに出せる形へ縮める（受け口の検査より前に読むので、長さも文字も信用しない）。 */
export function paradisSanitizeHookEventForLog(event: string | null | undefined): string {
	if (event === null || event === undefined || event.length === 0) {
		return '-';
	}
	return event.slice(0, MAX_EVENT_LENGTH).replace(/[^A-Za-z0-9_-]/g, '?');
}

/** 診断ログの 1 行（`[ParadisAgentBrowser] ` の後ろ）を作る。 */
export function paradisFormatHookDropLog(record: IParadisAgentHookDropRecord, paneCount: number, reasonTotal: number): string {
	const parts = [
		'agent-hook dropped',
		`reason=${record.reason}`,
		`pane=${record.pane}`,
		`event=${paradisSanitizeHookEventForLog(record.event)}`,
		`side=${record.side}`,
		`pid=${record.pid}`,
	];
	if (record.status !== undefined) {
		parts.push(`status=${record.status}`);
	}
	if (record.identityLoss !== undefined) {
		parts.push(`identity=${record.identityLoss}`);
	}
	if (record.snapshotAgeMs !== undefined) {
		parts.push(`snapshotAge=${Math.max(0, Math.round(record.snapshotAgeMs))}ms`);
	}
	if (record.ownerPinnedBy !== undefined) {
		parts.push(`owner=${record.ownerPinnedBy}`);
	}
	if (record.transcriptPath !== undefined || record.ownerTranscriptPath !== undefined) {
		parts.push(`tx=${paradisHookTranscriptTail(record.transcriptPath)}`, `ownerTx=${paradisHookTranscriptTail(record.ownerTranscriptPath)}`);
	}
	if (record.ownerIdleMs !== undefined) {
		parts.push(`ownerIdle=${Math.max(0, Math.round(record.ownerIdleMs / 1000))}s`);
	}
	parts.push(`n=${paneCount}`, `total=${reasonTotal}`);
	return parts.join(' ');
}

export interface IParadisHookDropCount {
	/** このペイン・この理由で捨てた累計。 */
	readonly paneCount: number;
	/** この理由で捨てた累計（全ペイン）。 */
	readonly reasonTotal: number;
	/** ログに出すか（ペイン・理由の組ごとに初回と 2 の累乗）。 */
	readonly emit: boolean;
}

/** ペイン・理由ごとの累計。 */
export class ParadisAgentHookDropCounter {
	private readonly perPane = new Map<string, number>();
	private readonly perReason = new Map<ParadisAgentHookDropReason, number>();

	note(pane: string, reason: ParadisAgentHookDropReason): IParadisHookDropCount {
		const key = `${pane}|${reason}`;
		const paneCount = (this.perPane.get(key) ?? 0) + 1;
		this.perPane.delete(key);
		if (this.perPane.size >= PARADIS_HOOK_DROP_MAX_COUNTER_KEYS) {
			const oldest = this.perPane.keys().next();
			if (!oldest.done) {
				this.perPane.delete(oldest.value);
			}
		}
		this.perPane.set(key, paneCount);
		const reasonTotal = (this.perReason.get(reason) ?? 0) + 1;
		this.perReason.set(reason, reasonTotal);
		return { paneCount, reasonTotal, emit: paradisShouldEmitHookDropLog(paneCount) };
	}
}
