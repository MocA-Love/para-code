/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 許可待ち（permission）のペインで、許可の確認が画面から消えてエージェントが作業を続けているのを見つける。
//
// Codex は許可の確認（PermissionRequest hook）の後、許可したツールが終わる（PostToolUse）まで hook を出さない。
// ターミナルのキー（ボードのターミナル欄の Enter など）で答えると、許可したツールが動いている間ずっと許可待ちのまま
// 残っていた（長く返らない MCP のツールや長いコマンドで目立つ）。画面を見て、確認が消え、作業中の表示が出ているのを
// 続けて確かめたら、その許可は答え終えたとみなす。判断だけをここに置き、画面の読み取りと知らせ先は呼び出し側が持つ。
//
// 解く承認は、確認が画面に出ていたのを見たもの（中継が表に出している承認の中身が、確認の画面に見えていたもの）だけ。
// 表に出ている承認をまだ画面で見ていないうち（別の承認が続けて届き、描かれていないだけかもしれない）は、ペインも解かない。

import { paradisApprovalScreenPiece } from '../../mobileRelay/common/paradisAgentApprovalOptions.js';
import { paradisPromptRegionShows, paradisScreenShowsAgentPrompt, paradisScreenShowsPermissionPrompt } from './paradisAgentTuiInput.js';

/** 許可待ちになってから、確認の画面が描かれるのを待つ時間（hook は画面の描画より先に届く）。 */
export const PARADIS_APPROVAL_SETTLE_GRACE_MS = 3_000;
/** 「確認が無く作業中」を何回続けて見たら解くか（見るのは状態の取り直しのたび。約 2 秒ごと）。 */
const SETTLE_CONFIRMATIONS = 2;
/** 作業中の表示を探す範囲（下端からの行数）。 */
const WORKING_REGION_LINES = 8;
/** 1 つのペインで覚えておく、画面で見た承認の数の上限。 */
const MAX_SEEN_APPROVALS = 20;

/**
 * 画面の下端に、エージェントが作業中の表示が出ているか。Codex は `• Working (3s • esc to interrupt)`、Claude Code は
 * `✻ Thinking… (12s · esc to interrupt)`。確認の画面（Codex の質問の `esc to interrupt` を含む）が出ていれば false。
 */
export function paradisScreenShowsAgentWorking(screen: string): boolean {
	if (paradisScreenShowsAgentPrompt(screen)) {
		return false;
	}
	const lines = screen.split('\n');
	while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
		lines.pop();
	}
	return lines.slice(-WORKING_REGION_LINES).join('').replace(/\s+/g, '').toLowerCase().includes('esctointerrupt');
}

/** 許可待ちのペイン 1 つの様子。 */
export interface IParadisApprovalSettlePane {
	readonly token: string;
	/** 許可待ちになった時刻（状態の changedAt）。 */
	readonly since: number;
	/** 見えている範囲の画面。ターミナルが見つからなければ undefined。 */
	readonly screen: string | undefined;
	/** 中継が今表に出している承認（無ければ undefined）。 */
	readonly approval?: { readonly id: string; readonly detail?: string };
}

/** 解くペイン。 */
export interface IParadisApprovalSettlement {
	readonly token: string;
	/** 解く許可待ち（見ていた changedAt）。この後に付け直された許可待ちは解かない。 */
	readonly since: number;
	/** 確認が画面に出ていたのを見た承認。 */
	readonly interactionIds: readonly string[];
}

/**
 * 許可待ちのペインを見続け、確認が画面から消えて作業中になったペインを返す。同じ許可待ち（`since` が同じ）は 1 度だけ返す。
 * 別の許可要求が届いて許可待ちが付け直される（`since` が変わる）と、数え直す。
 */
export class ParadisApprovalScreenSettle {

	private readonly watching = new Map<string, { since: number; count: number; settled: boolean; readonly seen: Set<string> }>();

	constructor(private readonly now: () => number = Date.now) { }

	/** 許可待ちのペインの今の一覧を渡す（一覧に無いペインは忘れる）。解くペインを返す。 */
	update(panes: readonly IParadisApprovalSettlePane[]): readonly IParadisApprovalSettlement[] {
		const now = this.now();
		const settle: IParadisApprovalSettlement[] = [];
		const present = new Set<string>();
		for (const pane of panes) {
			present.add(pane.token);
			let entry = this.watching.get(pane.token);
			if (entry === undefined) {
				entry = { since: pane.since, count: 0, settled: false, seen: new Set() };
				this.watching.set(pane.token, entry);
			} else if (entry.since !== pane.since) {
				// 付け直された許可待ち。画面で見た承認は、解くまで持ち越す（前の確認も画面から消えているはず）
				entry.since = pane.since;
				entry.count = 0;
				entry.settled = false;
			}
			const screen = pane.screen;
			if (screen !== undefined && pane.approval !== undefined && entry.seen.size < MAX_SEEN_APPROVALS && paradisScreenShowsPermissionPrompt(screen)) {
				// 表の承認の中身が、出ている確認の画面に見えている（別の承認の確認ではない）
				const piece = paradisApprovalScreenPiece(pane.approval.detail, 'codex');
				if (piece !== undefined && paradisPromptRegionShows(screen, piece)) {
					entry.seen.add(pane.approval.id);
				}
			}
			if (entry.settled) {
				continue;
			}
			// 表に出ている承認が、まだ画面で確認を見ていないもの（続けて届いて描かれていないだけかもしれない）なら数えない。
			// 解いた後は hook がもう来ないので、ここで解くと許可待ちを見逃す
			const frontUnseen = pane.approval !== undefined && !entry.seen.has(pane.approval.id);
			if (frontUnseen || now - pane.since < PARADIS_APPROVAL_SETTLE_GRACE_MS || screen === undefined || !paradisScreenShowsAgentWorking(screen)) {
				entry.count = 0;
				continue;
			}
			entry.count++;
			if (entry.count >= SETTLE_CONFIRMATIONS) {
				entry.settled = true;
				settle.push({ token: pane.token, since: pane.since, interactionIds: [...entry.seen] });
				entry.seen.clear();
			}
		}
		for (const token of [...this.watching.keys()]) {
			if (!present.has(token)) {
				this.watching.delete(token);
			}
		}
		return settle;
	}
}

/** 解いたことを伝える先（テストで差し替える）。 */
export interface IParadisApprovalSettleTargets {
	/** 中継の承認に答えた印を付ける。印を付け終えた後に、まだ答えていない承認が残っていれば true。 */
	settleApprovals(token: string, interactionIds: readonly string[]): Promise<boolean>;
	/** ペインの許可待ちを作業中へ戻す（`since` の許可待ちのときだけ）。 */
	settlePane(token: string, since: number): Promise<unknown>;
	/** 伝えられなかったとき。 */
	onError(what: 'approvals' | 'pane', error: unknown): void;
}

/**
 * 解いたことを伝える。先に中継の承認へ印を付け終え、その後にペインを戻す（承認が残ったままペインだけ戻すと、残った承認が
 * 次の作業中の知らせを許可待ちへ書き戻す）。印を付けた後にまだ答えていない承認が残っている（画面で見ていない次の承認が
 * 続けて届き、描かれるのを待っている）か、中継へ伝えられなかったときは、ペインを戻さない。戻すと hook はもう来ないので、
 * 次の承認の許可待ちを見逃す。
 */
export async function paradisNotifyApprovalSettlement(settlement: IParadisApprovalSettlement, targets: IParadisApprovalSettleTargets): Promise<void> {
	let remaining: boolean;
	try {
		remaining = await targets.settleApprovals(settlement.token, settlement.interactionIds);
	} catch (error) {
		targets.onError('approvals', error);
		return;
	}
	if (remaining) {
		return;
	}
	try {
		await targets.settlePane(settlement.token, settlement.since);
	} catch (error) {
		targets.onError('pane', error);
	}
}
