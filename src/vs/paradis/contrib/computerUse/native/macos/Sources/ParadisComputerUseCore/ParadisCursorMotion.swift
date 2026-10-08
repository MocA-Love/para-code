/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 独自のカーソルの軌跡（OS に触れない部分）。
//
// 内蔵ブラウザのエージェントのカーソル（`agentBrowser/common/paradisCursorOverlay.ts` と、vendored の
// cursor-motion を使う `paradisCursorMotion.ts`）と同じ考え方で、先端が着く時刻を「距離 ÷ 2.2 pt/ms、90〜380 ms」に
// 合わせ、真っすぐではなく少し弧を描いて動かす。cursor-motion のコードは写していない（Swift で書いた別の簡単な計算）。

import CoreGraphics
import Foundation

/** 移動の最短・最長の時間（ms）と速さ（pt/ms）。内蔵ブラウザの `PARADIS_CURSOR_OVERLAY_TUNING` と同じ値。 */
let paradisCursorGlideMinMs = 90.0
let paradisCursorGlideMaxMs = 380.0
let paradisCursorGlidePointsPerMs = 2.2
/** この距離（pt）未満は動かさずに置く。 */
let paradisCursorSnapPoints = 6.0
/** 弧のふくらみ（距離に対する割合と上限、pt）。 */
private let paradisCursorBendRatio = 0.18
private let paradisCursorBendMax = 70.0

/** 1 回の移動。`points` は等しい時間おきの位置（始点と終点を含む）。`durationMs` が 0 なら置くだけ。 */
struct ParadisCursorGlide: Equatable {
	let points: [CGPoint]
	let durationMs: Double
}

/** 移動にかける時間（ms）。近ければ 0（置くだけ）。 */
func paradisCursorGlideDuration(distance: Double) -> Double {
	guard distance.isFinite, distance >= paradisCursorSnapPoints else {
		return 0
	}
	return min(paradisCursorGlideMaxMs, max(paradisCursorGlideMinMs, distance / paradisCursorGlidePointsPerMs))
}

/** 0..1 の時間を、出だしと着く前をゆっくりにした進み具合にする。 */
func paradisCursorEase(_ t: Double) -> Double {
	let clamped = min(1, max(0, t))
	return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - pow(-2 * clamped + 2, 3) / 2
}

/**
 * `from` から `to` への移動を計画する。`from` が無ければ（初めて出す）`to` に置く。
 * 弧は始点と終点の垂直二等分線の上に控えの点を置いた 2 次の Bézier で、画面の上側へふくらませる。
 */
func paradisPlanCursorGlide(from: CGPoint?, to: CGPoint, samples: Int = 24) -> ParadisCursorGlide {
	guard let from else {
		return ParadisCursorGlide(points: [to], durationMs: 0)
	}
	let dx = Double(to.x - from.x)
	let dy = Double(to.y - from.y)
	let distance = (dx * dx + dy * dy).squareRoot()
	let duration = paradisCursorGlideDuration(distance: distance)
	guard duration > 0 else {
		return ParadisCursorGlide(points: [to], durationMs: 0)
	}
	// 進む向きに垂直な単位ベクトル。画面の座標は下向きが正なので、y が負（上）を向く方を選ぶ
	var nx = -dy / distance
	var ny = dx / distance
	if ny > 0 || (ny == 0 && nx > 0) {
		nx = -nx
		ny = -ny
	}
	let bend = min(paradisCursorBendMax, distance * paradisCursorBendRatio)
	let control = CGPoint(x: Double(from.x) + dx / 2 + nx * bend, y: Double(from.y) + dy / 2 + ny * bend)
	let count = max(2, samples)
	let points = (0...count).map { index -> CGPoint in
		let t = paradisCursorEase(Double(index) / Double(count))
		let u = 1 - t
		let x = u * u * Double(from.x) + 2 * u * t * Double(control.x) + t * t * Double(to.x)
		let y = u * u * Double(from.y) + 2 * u * t * Double(control.y) + t * t * Double(to.y)
		return CGPoint(x: x, y: y)
	}
	// 丸めの誤差で終点がずれないよう、最後は必ず `to`
	return ParadisCursorGlide(points: Array(points.dropLast()) + [to], durationMs: duration)
}
