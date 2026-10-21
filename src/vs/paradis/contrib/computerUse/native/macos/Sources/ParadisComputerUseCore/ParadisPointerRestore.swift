/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 3 段目（前面。実カーソルを HID のタップで動かす）のクリック・ドラッグの後に、実カーソルを操作の前の位置へ戻すか
// （OS に触れない部分）。利用者がその間にマウスを動かしていたら戻さない（利用者の操作を奪わない）。

import CoreGraphics
import Foundation

/** こちらが最後に送った位置と今の位置が、この距離（pt）より離れていれば、利用者が動かしたとみなす。 */
let paradisPointerMovedTolerance: CGFloat = 1

/**
 * 実カーソルを戻す先。戻さないなら nil。
 *  - `saved`: 操作の前の位置（読めなければ nil）
 *  - `current`: 操作の後の今の位置（読めなければ nil）
 *  - `lastSent`: こちらが最後にカーソルを動かした位置
 *  - `physicalPointerSinceStart`: 操作を始めてから物理的なマウスの入力を見たか（見張りが無ければ nil）
 */
func paradisPointerRestoreTarget(saved: CGPoint?, current: CGPoint?, lastSent: CGPoint, physicalPointerSinceStart: Bool?) -> CGPoint? {
	guard let saved, let current, physicalPointerSinceStart != true else {
		return nil
	}
	// 今の位置がこちらの送った位置でなければ、利用者（か別のアプリ）が動かした
	guard hypot(current.x - lastSent.x, current.y - lastSent.y) <= paradisPointerMovedTolerance else {
		return nil
	}
	// もともと同じ場所なら戻す必要が無い
	guard hypot(saved.x - lastSent.x, saved.y - lastSent.y) > 0.5 else {
		return nil
	}
	return saved
}

