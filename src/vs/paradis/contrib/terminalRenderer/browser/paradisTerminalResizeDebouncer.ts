/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { TerminalResizeDebouncer } from '../../../../workbench/contrib/terminal/browser/terminalResizeDebouncer.js';

/**
 * ターミナルの大きさがまだ一度も測られていないか (xterm を DOM に開いたことが無いか)。
 *
 * ウィンドウの再読み込みの後、背面のタブや閉じたパネルのターミナルは開かれないまま再接続の
 * リプレイを受ける。リプレイの間は pty の大きさが上書き寸法として当たり、終わると本家
 * (`basePty.ts`) が上書きを外す。外したときの大きさは測っていない既定値 (80x30) や別の
 * ターミナルの大きさなので、そのまま pty へ送ると、裏で動く TUI が関係の無い大きさで描き直し、
 * タブを開くと元の大きさに戻る (再読み込みのたびに 84x29 → 80x30 → 84x29)。測っていない
 * 間は、本家が「実寸を一度も持っていない」ときにするのと同じく、リプレイの大きさのままにする。
 */
export function paradisIsTerminalSizeUnmeasured(xterm: { readonly raw: { readonly element: HTMLElement | undefined } } | undefined): boolean {
	return !xterm?.raw.element;
}

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
 *
 * `flush()` (見えるようになったときの `TerminalInstance.setVisible(true)`) もその場では渡さず、
 * 同じマイクロタスクで最後の大きさを即時として渡す。`setVisible(true)` は flush の直後に本当の
 * 大きさで `_resize()` を呼び、パネルの 2D グリッドは見える直前に古い寸法で layout するので、
 * その場で渡すと古い大きさと本当の大きさが 1ms 差で pty へ届き、TUI は最後の大きさが前と
 * 同じなので描き直さない (パネルを開き直すと 83x14 → 83x13 が届き、通常バッファの TUI の
 * 最下行が欠けたまま残った)。
 */
export class ParadisTerminalResizeDebouncer extends TerminalResizeDebouncer {
	private _pending: { cols: number; rows: number } | undefined;
	private _flushRequested = false;
	private _scheduled = false;

	override async resize(cols: number, rows: number, immediate: boolean): Promise<void> {
		if (immediate) {
			this._pending = undefined;
			this._flushRequested = false;
			return super.resize(cols, rows, true);
		}
		this._pending = { cols, rows };
		this._schedule();
	}

	override flush(): void {
		this._flushRequested = true;
		this._schedule();
	}

	private _schedule(): void {
		if (!this._scheduled) {
			this._scheduled = true;
			queueMicrotask(() => this._applyPending());
		}
	}

	private _applyPending(): void {
		this._scheduled = false;
		const pending = this._pending;
		const flush = this._flushRequested;
		this._pending = undefined;
		this._flushRequested = false;
		if (this._store.isDisposed) {
			return;
		}
		if (pending) {
			// flush の後は本家の flush と同じく、行と列を待たずに両方そのまま渡す。
			void super.resize(pending.cols, pending.rows, flush);
		} else if (flush) {
			super.flush();
		}
	}
}
