/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { TerminalResizeDebouncer } from '../../../../workbench/contrib/terminal/browser/terminalResizeDebouncer.js';

/**
 * 同じタスクの中で続けて来たリサイズを、最後の 1 回にまとめてから本家の {@link TerminalResizeDebouncer} へ渡す。
 *
 * エディタの右の列を上下に割ると、grid は右の列をいったん外してから枝として入れ直す
 * (`GridView.addView` の `removeChild` → `addChild`)。その間に左のペインは全幅で layout され、
 * 同じ同期処理の中で元の幅に戻る。本家はバッファが短い (200 行未満) と即座に xterm と pty の
 * 大きさを変えるので、途中の大きさが pty まで届き、xterm も途中の幅で折り返し直す。TUI は
 * SIGWINCH を受けても大きさが前と同じなので描き直さず、崩れた画面がそのまま残る。
 *
 * ここでは、明示の即時 (`immediate: true`) 以外のリサイズをマイクロタスクまで待たせ、最後の
 * 大きさだけを本家へ渡す。サッシュの移動のように別のタスクで来る変更は、これまでどおり届く。
 */
export class ParadisTerminalResizeDebouncer extends TerminalResizeDebouncer {
	private _pending: { cols: number; rows: number } | undefined;

	override async resize(cols: number, rows: number, immediate: boolean): Promise<void> {
		if (immediate) {
			this._pending = undefined;
			return super.resize(cols, rows, true);
		}
		const scheduled = this._pending !== undefined;
		this._pending = { cols, rows };
		if (!scheduled) {
			queueMicrotask(() => this._applyPending());
		}
	}

	override flush(): void {
		this._applyPending();
		super.flush();
	}

	private _applyPending(): void {
		const pending = this._pending;
		this._pending = undefined;
		if (pending && !this._store.isDisposed) {
			void super.resize(pending.cols, pending.rows, false);
		}
	}
}
