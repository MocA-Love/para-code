/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/**
 * スペースを離れる間、エディタのターミナルの layout を捨てておく (本家の `disableLayout`)。
 *
 * 離れるときは、生きたエディタ (`ParadisEditorScopeService.captureScope`) と残りのターミナル
 * (park) を 1 枚ずつエディタから外す。外すたびに空になったグループが消え、まだ外していない隣の
 * グループが全幅で layout される。左右に分けた右のターミナルは、外される直前に 40 列から 84 列に
 * なり、その大きさが pty へ届いて、離れている間ずっと 84 列のまま裏の TUI が描き直す。戻ると
 * 40 列に戻るので、通常バッファの TUI (Claude Code など) は 84 列で描いた分が崩れて残る。
 *
 * 離れている間も layout を捨て続ける。隠れたターミナルでも GPU の描画を外したときなどに、最後に
 * 受け取った寸法 (外す途中の全幅) で layout し直すことがあるため。layout を戻すのは、
 * - 離れる処理が終わった時点でまだエディタに残っているターミナル (外さなかった・切り替えが途中で失敗した)
 * - エディタに開き直されるとき (`SessionTerminalEditor.setInput` が開く前に戻す)
 * - park の台帳から取り出されるとき (`paradisTerminalEditorPark.ts`。取り出した端末はこれから開かれる)
 * の 3 つ。離れる処理の途中は戻さない (そのときのグループも全幅になっている途中なので)。
 * 止めたまま破棄されたターミナルは弱い参照なので残らない。
 */
const held = new WeakSet<ITerminalInstance>();
let leaving = 0;

/** 離れる処理の間の握り。 */
export interface IParadisTerminalLayoutHold {
	/**
	 * 離れる処理を終える。`stillInEditors` (外されずにまだエディタに残っているターミナル) の layout を戻し、
	 * そのうち見えているものがあったら true (止めていた間の layout を受けていないので測り直しが要る)。
	 */
	end(stillInEditors: Iterable<ITerminalInstance>): boolean;
}

/** 離れる処理の前に、外すかもしれないターミナルの layout を止める。 */
export function paradisHoldTerminalLayout(instances: Iterable<ITerminalInstance>): IParadisTerminalLayoutHold {
	leaving++;
	for (const instance of instances) {
		// 既に誰かが止めている (本家のパネルのグループの入れ替え中) ものは触らない。戻す責任を奪わないため。
		if (held.has(instance) || instance.isDisposed || instance.disableLayout) {
			continue;
		}
		instance.disableLayout = true;
		held.add(instance);
	}
	let ended = false;
	return {
		end: stillInEditors => {
			if (ended) {
				return false;
			}
			ended = true;
			leaving--;
			if (leaving > 0) {
				return false;
			}
			let releasedVisible = false;
			for (const instance of stillInEditors) {
				if (paradisReleaseTerminalLayout(instance) && instance.isVisible) {
					releasedVisible = true;
				}
			}
			return releasedVisible;
		}
	};
}

/** 止めていた layout を戻す。エディタに開き直す前に呼ぶと、開くときの layout がそのまま当たる。離れる処理の途中は戻さない。 */
export function paradisReleaseTerminalLayout(instance: ITerminalInstance | undefined): boolean {
	if (!instance || leaving > 0 || !held.has(instance)) {
		return false;
	}
	held.delete(instance);
	instance.disableLayout = false;
	return true;
}

/** layout を止めているか (テスト用)。 */
export function paradisIsTerminalLayoutHeld(instance: ITerminalInstance): boolean {
	return held.has(instance);
}
