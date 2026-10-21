/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 1 段目（AX）のスクロールの計算（OS に触れない部分。実体は ParadisAXScrolling.swift と ParadisInputRoutes.swift の `scroll`）。
//
//  - D1 スクロールバー: 軸の合うスクロールバーの `AXValue` を書く。中身の大きさが分かれば動かす量から値を出し、
//    分からなければ 1 ページを `AXValueIncrement`（無ければ範囲の 1/10）とみなす（概算）
//  - D2 見える位置へ寄せる: Chromium・Electron はウェブの中身のスクロールを AX の値で出さないので、端の外にある要素へ
//    `AXScrollToVisible` をかけて寄せる。動く量は概算（Cua Driver の `ax/reveal_scroll.rs` の選び方を Swift に写した。
//    出典と MIT の告知は THIRD_PARTY_NOTICES.md）

import CoreGraphics
import Foundation

/** スクロールで動かす距離（pt）。3 段目・2 段目のホイールの量と同じ式。 */
func paradisScrollDistance(pages: Double, extent: Double) -> Double {
	return max(1, pages * max(extent, 100) * 0.8)
}

/** 縦のスクロールか。 */
func paradisScrollIsVertical(_ direction: ParadisScrollDirection) -> Bool {
	return direction == .up || direction == .down
}

// MARK: - D1 スクロールバー

/** スクロールバーについて分かっていること。 */
struct ParadisScrollBarFacts: Equatable {
	let value: Double
	var minValue: Double = 0
	var maxValue: Double = 1
	/** `AXValueIncrement`。無ければ nil。 */
	var increment: Double? = nil
	/** スクロールする中身の、軸の向きの長さ（pt）。分からなければ nil。 */
	var contentLength: Double? = nil
	/** 見えている部分の、軸の向きの長さ（pt）。 */
	var viewportLength: Double? = nil
}

/** スクロールバーへ書く値。 */
struct ParadisScrollBarPlan: Equatable {
	let value: Double
	/** 中身の大きさが分からず、動かす量を見積もったか。 */
	let approximate: Bool
}

/**
 * スクロールバーへ書く新しい値。下・右は値を増やし、上・左は減らす。すでに端なら nil（動かせない）。
 * 中身と見えている部分の長さが分かれば `distance / (中身 - 見えている部分)` を範囲に掛け、分からなければ 1 ページを
 * `increment`（無ければ範囲の 1/10）とみなす。
 */
func paradisScrollBarPlan(_ facts: ParadisScrollBarFacts, direction: ParadisScrollDirection, distance: Double, pages: Double) -> ParadisScrollBarPlan? {
	let range = facts.maxValue - facts.minValue
	guard range > 0 else {
		return nil
	}
	let forward = direction == .down || direction == .right
	var delta: Double
	var approximate = false
	if let content = facts.contentLength, let viewport = facts.viewportLength, content > viewport + 1 {
		delta = distance / (content - viewport) * range
	} else {
		delta = max(pages, 0.1) * (facts.increment.flatMap { $0 > 0 ? $0 : nil } ?? range / 10)
		approximate = true
	}
	delta = min(delta, range)
	let next = min(facts.maxValue, max(facts.minValue, facts.value + (forward ? delta : -delta)))
	guard abs(next - facts.value) > range * 1e-6 else {
		return nil
	}
	return ParadisScrollBarPlan(value: next, approximate: approximate)
}

/** スクロールバーの値が求めた向きに動いたか。 */
func paradisScrollBarMoved(before: Double, after: Double?, direction: ParadisScrollDirection) -> Bool {
	guard let after else {
		return false
	}
	let forward = direction == .down || direction == .right
	return forward ? after > before + 1e-9 : after < before - 1e-9
}

/** ページ単位でスクロールさせる AX のアクションの名前（スクロールする領域に行う）。 */
func paradisScrollPageAction(_ direction: ParadisScrollDirection) -> String {
	switch direction {
	case .up: return "AXScrollUpByPage"
	case .down: return "AXScrollDownByPage"
	case .left: return "AXScrollLeftByPage"
	case .right: return "AXScrollRightByPage"
	}
}

/** スクロールバーの増減のアクション（下・右は AXIncrement）。 */
func paradisScrollBarStepAction(_ direction: ParadisScrollDirection) -> String {
	return direction == .down || direction == .right ? "AXIncrement" : "AXDecrement"
}

/** ページのアクションを行う回数（1 から 10）。 */
func paradisScrollPageCount(pages: Double) -> Int {
	return min(10, max(1, Int(pages.rounded())))
}

// MARK: - D2 見える位置へ寄せる（Cua Driver の reveal_scroll の写し）

/** スクロールする入れ物の役割。 */
let paradisScrollContainerRoles: Set<String> = ["AXScrollArea", "AXWebArea"]

/**
 * 寄せる要素を選ぶ。下なら、下端が「見えている部分の下端 + distance」にいちばん近く、見えている部分より下にある要素。
 * 上・左・右も同じ。軸の向きに見えている部分より大きい要素（入れ物）は選ばない。無ければ nil。
 */
func paradisPickRevealTarget(viewport: CGRect, direction: ParadisScrollDirection, distance: Double, candidates: [CGRect]) -> Int? {
	var best: (index: Int, gap: Double)?
	for (index, rect) in candidates.enumerated() {
		let edge: Double
		let goal: Double
		let beyond: Bool
		let fits: Bool
		switch direction {
		case .down:
			(edge, goal, beyond, fits) = (Double(rect.maxY), Double(viewport.maxY) + distance, rect.maxY > viewport.maxY + 1, rect.height <= viewport.height)
		case .up:
			(edge, goal, beyond, fits) = (Double(rect.minY), Double(viewport.minY) - distance, rect.minY < viewport.minY - 1, rect.height <= viewport.height)
		case .right:
			(edge, goal, beyond, fits) = (Double(rect.maxX), Double(viewport.maxX) + distance, rect.maxX > viewport.maxX + 1, rect.width <= viewport.width)
		case .left:
			(edge, goal, beyond, fits) = (Double(rect.minX), Double(viewport.minX) - distance, rect.minX < viewport.minX - 1, rect.width <= viewport.width)
		}
		guard beyond && fits else {
			continue
		}
		let gap = abs(edge - goal)
		if best == nil || gap < best!.gap {
			best = (index, gap)
		}
	}
	return best?.index
}

/** 端に寄せられた要素のうち選んだもの。 */
struct ParadisClampedPick: Equatable {
	let index: Int
	/** 端から何行目か（1 が最初）。 */
	let rows: Int
	/** 見えている葉から測った行の間隔。 */
	let pitch: Double
}

/** 大きさのある枠か（Chromium は見えない要素を 1 pt の細い枠で出す）。 */
func paradisRealSize(_ rect: CGRect) -> Bool {
	return rect.width > 1.5 && rect.height > 1.5
}

/**
 * Chromium は見えていない要素を見えている部分の端に寄せた 1 pt の細い枠で出し、AXScrollToVisible はその要素を真ん中へ
 * 寄せる。端の外に本物の枠が無いときは、端に寄った葉を文書の順に数え、k 番目を寄せると「見えている部分の半分 +
 * (k - 0.5) 行」動くとみなして k を選ぶ。`nodes` は文書の順の（枠, 葉か）。端に寄った葉が無ければ nil。
 */
func paradisPickClamped(viewport: CGRect, direction: ParadisScrollDirection, distance: Double, nodes: [(rect: CGRect, leaf: Bool)]) -> ParadisClampedPick? {
	let vertical = paradisScrollIsVertical(direction)
	func sliver(_ rect: CGRect) -> Bool {
		return vertical ? rect.height <= 1.5 : rect.width <= 1.5
	}
	func atEdge(_ rect: CGRect) -> Bool {
		switch direction {
		case .down: return rect.minY >= viewport.maxY - 2.5
		case .up: return rect.minY <= viewport.minY + 1.5
		case .right: return rect.minX >= viewport.maxX - 2.5
		case .left: return rect.minX <= viewport.minX + 1.5
		}
	}
	var clamped = nodes.enumerated().filter { $0.element.leaf && sliver($0.element.rect) && atEdge($0.element.rect) }.map { $0.offset }
	guard !clamped.isEmpty else {
		return nil
	}
	if direction == .up || direction == .left {
		clamped.reverse()
	}
	// 行の間隔: 見えている葉の始まりの差の中央値
	var starts = nodes.filter { $0.leaf && !sliver($0.rect) && viewport.contains($0.rect) }.map { Double(vertical ? $0.rect.minY : $0.rect.minX) }.sorted()
	var unique: [Double] = []
	for start in starts where unique.last.map({ abs(start - $0) >= 2 }) ?? true {
		unique.append(start)
	}
	starts = unique
	let gaps = zip(starts.dropFirst(), starts).map { $0 - $1 }.sorted()
	let pitch = max(8, gaps.isEmpty ? 40 : gaps[gaps.count / 2])
	let half = Double(vertical ? viewport.height : viewport.width) / 2
	let rows = min(clamped.count, max(1, Int(((distance - half) / pitch + 0.5).rounded())))
	return ParadisClampedPick(index: clamped[rows - 1], rows: rows, pitch: pitch)
}

/**
 * `rect`（`frame` の要素の子）が、`frame` の端の外にあるか、その端に寄せた細い枠か（Chromium が `overflow: auto` の中の
 * 見えない部分をこう出す）。
 */
func paradisPastEdge(frame: CGRect, direction: ParadisScrollDirection, rect: CGRect) -> Bool {
	switch direction {
	case .down: return rect.maxY > frame.maxY + 1 || (rect.height <= 1.5 && rect.minY >= frame.maxY - 2.5)
	case .up: return rect.minY < frame.minY - 1 || (rect.height <= 1.5 && rect.minY <= frame.minY + 1.5)
	case .right: return rect.maxX > frame.maxX + 1 || (rect.width <= 1.5 && rect.minX >= frame.maxX - 2.5)
	case .left: return rect.minX < frame.minX - 1 || (rect.width <= 1.5 && rect.minX <= frame.minX + 1.5)
	}
}

/**
 * 寄せた後に中身が動いたか。前に見えていた要素で判断する（動いた、または見えなくなった＝細い枠になった・消えた）。
 * そういう要素が無ければ nil。
 */
func paradisContentMoved(before: CGRect?, after: CGRect?) -> Bool? {
	guard let before else {
		return nil
	}
	guard let after, paradisRealSize(after) else {
		return true
	}
	return abs(after.minX - before.minX) > 0.5 || abs(after.minY - before.minY) > 0.5
}

/** 本物の枠の要素を寄せた後、求めた向きに何 pt 動いたか。 */
func paradisRevealMoved(before: CGRect, after: CGRect, direction: ParadisScrollDirection) -> Double {
	switch direction {
	case .down: return Double(before.minY - after.minY)
	case .up: return Double(after.minY - before.minY)
	case .right: return Double(before.minX - after.minX)
	case .left: return Double(after.minX - before.minX)
	}
}

/** 端に寄った細い枠の要素を寄せた後の、動いた量の見積もり（少なくとも 1）。 */
func paradisClampedRevealMoved(viewport: CGRect, after: CGRect, direction: ParadisScrollDirection, pick: ParadisClampedPick) -> Double {
	let past = Double(pick.rows - 1) * pick.pitch
	let moved: Double
	switch direction {
	case .down: moved = Double(viewport.maxY) + past - Double(after.minY)
	case .up: moved = Double(after.maxY) - (Double(viewport.minY) - past)
	case .right: moved = Double(viewport.maxX) + past - Double(after.minX)
	case .left: moved = Double(after.maxX) - (Double(viewport.minX) - past)
	}
	return max(1, moved)
}

/** AX でスクロールした手（結果の `routeNotes` に書く）。 */
enum ParadisAXScrollMethod: String {
	case scrollBarValue
	case pageAction
	case scrollBarStep
	case revealElement
}

/** 結果の `routeNotes` に書く 1 行。 */
func paradisAXScrollNote(_ method: ParadisAXScrollMethod, role: String, approximate: Bool) -> String {
	let how: String
	switch method {
	case .scrollBarValue: how = "set the value of the scroll bar of the \(role)"
	case .pageAction: how = "performed the page scroll action of the \(role)"
	case .scrollBarStep: how = "stepped the scroll bar of the \(role)"
	case .revealElement: how = "revealed an element past the edge of the \(role) (AXScrollToVisible)"
	}
	return "accessibility: scrolled without the pointer; \(how)" + (approximate ? "; the distance is approximate" : "")
}
