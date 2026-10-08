/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのカーソルの演出のために、入力の配送を待ってよいかを決める台帳（shared process）。
//
// electron-main は move のたびにカーソルが着くまで配送を待たせる（ホバーが「着いた瞬間」に効くように
// 見せるため）。ただし直後に押す move で待つと、位置を測ってから押すまでの間にページが動いたとき
// 古い座標を押す。待ってよいのはホバーそのものが目的の move（hover と mouse_action の move）だけで、
// それも 1 回のツール呼び出しで待つ合計を {@link PARADIS_CURSOR_WAIT_BUDGET_MS} に抑える。
//
// 入力はツールの中から（vendored の chrome-devtools-mcp なら CDP のゲートウェイ経由で）届くので、
// どのツールの入力かはペインのトークンで結び付ける。ツールを呼んでいないとき（エージェントが
// get_cdp_endpoint で自分の CDP クライアントを繋いでいるとき）の入力は、今までどおり待つ。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisCursorPacing, ParadisCursorStatus } from '../common/paradisCursorOverlay.js';

/** 1 回のツール呼び出し（run_steps なら手順の全部）で、カーソルの演出のために待ってよい合計（ms）。 */
export const PARADIS_CURSOR_WAIT_BUDGET_MS = 600;

interface IParadisCursorWaitBudget {
	remainingMs: number;
}

interface IParadisCursorPacingCall {
	/** ホバーが目的の move を送るツールか。そうでなければ move の直後に押す。 */
	readonly hover: boolean;
	readonly budget: IParadisCursorWaitBudget;
	/** この呼び出しで既に待ってよい move を 1 回送ったか（分割した move は最初の 1 歩だけ待つ）。 */
	waitedMove: boolean;
}

/** 1 回の配送への指示と、配送の後に待った時間を戻す口。 */
export interface IParadisCursorPacingTicket {
	readonly pacing: IParadisCursorPacing;
	settle(cursorWaitMs: number | undefined): void;
}

/** ホバーそのものが目的の move を送るツールか。 */
export function paradisIsCursorHoverTool(tool: string, args: unknown): boolean {
	if (tool === 'hover') {
		return true;
	}
	if (tool !== 'mouse_action') {
		return false;
	}
	return typeof args === 'object' && args !== null && (args as { action?: unknown }).action === 'move';
}

/**
 * 入力を伴わない道具の間にカーソルの名札へ出す状態（q.html Q275 A・Q297 の 1）。無ければ出さない。
 * click_by・fill_by などの結果（押せなかった・選んだ）は道具の中から出す（paradisBrowserActBy.ts）。
 */
export function paradisCursorStatusForTool(tool: string): ParadisCursorStatus | undefined {
	switch (tool) {
		case 'evaluate_script': return 'script';
		case 'wait_for':
		case 'wait_until': return 'waiting';
		case 'navigate_page': return 'loading';
		case 'take_snapshot':
		case 'get_text':
		case 'inspect_element':
		case 'list_console_messages':
		case 'get_console_message':
		case 'list_network_requests':
		case 'get_network_request': return 'reading';
		case 'scroll_to': return 'scroll';
		case 'upload_file': return 'upload';
		default: return undefined;
	}
}

export class ParadisCursorPacingLedger {

	/** ペインのトークン → いま走っているツールの呼び出し（入れ子の run_steps は積む）。 */
	private readonly calls = new Map<string, IParadisCursorPacingCall[]>();

	/**
	 * ツールの呼び出しを始める。戻り値を呼び出しの終わりに dispose する。
	 *
	 * 既にそのペインで呼び出しが走っていれば（run_steps の手順）、待ちの予算はそれと分け合う。
	 */
	begin(paneToken: string, tool: string, args: unknown): IDisposable {
		const stack = this.calls.get(paneToken) ?? [];
		const outer = stack.at(-1);
		const call: IParadisCursorPacingCall = {
			hover: paradisIsCursorHoverTool(tool, args),
			budget: outer?.budget ?? { remainingMs: PARADIS_CURSOR_WAIT_BUDGET_MS },
			waitedMove: false,
		};
		stack.push(call);
		this.calls.set(paneToken, stack);
		return toDisposable(() => {
			const current = this.calls.get(paneToken);
			if (!current) {
				return;
			}
			const index = current.lastIndexOf(call);
			if (index >= 0) {
				current.splice(index, 1);
			}
			if (current.length === 0) {
				this.calls.delete(paneToken);
			}
		});
	}

	/**
	 * この入力の配送への指示。move 以外と、ツールの呼び出しの外から来た入力には指示しない
	 * （main は今までどおり待つ）。
	 *
	 * 入力はペインで最後に始まった呼び出しのものとみなす。同じペインで 2 つの呼び出しが並走すると
	 * （hover と click など）取り違えることがあるが、変わるのはカーソルの演出の待ちだけ。
	 */
	ticketFor(paneToken: string, method: string, paramsJson: string): IParadisCursorPacingTicket | undefined {
		if (method !== 'Input.dispatchMouseEvent' || !paramsJson.includes('mouseMoved')) {
			return undefined;
		}
		const call = this.calls.get(paneToken)?.at(-1);
		if (!call) {
			return undefined;
		}
		let type: unknown;
		try {
			type = (JSON.parse(paramsJson) as { type?: unknown } | null)?.type;
		} catch {
			return undefined;
		}
		if (type !== 'mouseMoved') {
			return undefined;
		}
		if (!call.hover) {
			return { pacing: { pressFollows: true }, settle: () => { } };
		}
		const maxWaitMs = call.waitedMove ? 0 : call.budget.remainingMs;
		call.waitedMove = true;
		return {
			pacing: { maxWaitMs },
			settle: cursorWaitMs => {
				if (typeof cursorWaitMs === 'number' && cursorWaitMs > 0) {
					call.budget.remainingMs = Math.max(0, call.budget.remainingMs - cursorWaitMs);
				}
			},
		};
	}
}
