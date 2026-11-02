/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ワークツリーの削除コマンド（paradisCreateWorktree.contribution.ts）が使う、画面に依らない部品。

import { localize } from '../../../../nls.js';
import { ParadisScopeRetirementPreparation } from './paradisEditorScope.js';

/**
 * 削除を実行中のワークツリー（状態キー）の台帳。削除は git に最長 10 分かかるので、その間にもう一度
 * 押されると、2 回目が同じ準備を使って進み、git と残骸の削除が同じフォルダーを同時に消したり、
 * 片方の後片付けがもう片方の準備を解いたりする。実行中の 2 回目は受け付けない。
 */
export class ParadisWorktreeRemovalGuard {
	private readonly running = new Set<string>();

	/** 始められたら、終わったときに呼ぶ関数を返す。同じキーが実行中なら undefined。 */
	tryBegin(stateKey: string): (() => void) | undefined {
		if (this.running.has(stateKey)) {
			return undefined;
		}
		this.running.add(stateKey);
		return () => this.running.delete(stateKey);
	}
}

/**
 * スペースの退役の準備が止まったときに出す通知の文言。利用者が保存の確認で［キャンセル］を選んだ
 * ときは、本人が止めたのが分かっているので何も出さない（undefined）。
 */
export function paradisRemoveWorktreePrepareMessage(result: ParadisScopeRetirementPreparation, worktreeName: string): string | undefined {
	if (result !== 'failed') {
		return undefined;
	}
	// allow-any-unicode-next-line
	return localize('paradis.workspaceSwitch.removeWorktreePrepareDeclined', "ワークツリー「{0}」の削除を中止しました。このスペースの未保存のエディタを保存できなかったか、閉じられませんでした。保存するか変更を破棄してから、もう一度削除してください。", worktreeName);
}
