/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 1 段目（AX）のスクロールの実体。計算は Core の ParadisAXScroll.swift。マウスもカーソルも動かさず、イベントも送らず、
// 前面にも出さない。
//  - D1: 当たった要素から上へたどって `AXScrollArea` を探し、軸の合うスクロールバーの `AXValue` を書く。書けなければ
//    領域のページのアクション、次にスクロールバーの増減のアクション。どれも値を読み戻して動いたかを確かめる
//  - D2: スクロールする入れ物の中で、端の外にある要素へ `AXScrollToVisible` をかけて寄せる（Cua Driver の reveal_scroll の
//    写し。Chromium は `overflow: auto` を `AXScrollArea` として出さないので、内側の要素から順に試す）

import ApplicationServices
import Foundation

/** AX でスクロールした結果。 */
struct ParadisAXScrollOutcome {
	let method: ParadisAXScrollMethod
	let role: String
	let approximate: Bool
	/** すでに端で、動かせなかった。 */
	var atEnd = false
	/** 動いた量（pt）。分からなければ nil。 */
	var moved: Double? = nil
}

/** 上へたどる要素の数の上限。 */
private let paradisScrollMaxAscent = 40
/** D2 でたどる子孫の数と深さの上限。 */
private let paradisRevealMaxNodes = 2_000
private let paradisRevealMaxDepth = 80
/** AX の書き込みの後、アプリが反映するのを待つ時間。 */
private let paradisScrollSettleMicroseconds: UInt32 = 150_000

private func paradisRole(_ element: AXUIElement) -> String? {
	return paradisCopy(element, kAXRoleAttribute) as? String
}

private func paradisNumber(_ element: AXUIElement, _ attribute: String) -> Double? {
	return (paradisCopy(element, attribute) as? NSNumber)?.doubleValue
}

private func paradisActions(_ element: AXUIElement) -> [String] {
	var names: CFArray?
	guard AXUIElementCopyActionNames(element, &names) == .success, let names = names as? [String] else {
		return []
	}
	return names
}

// MARK: - D1

/** 当たった要素から上へたどって、最初の `AXScrollArea`。ウィンドウで止める。 */
private func paradisEnclosingScrollArea(_ hit: AXUIElement) -> AXUIElement? {
	var current: AXUIElement? = hit
	for _ in 0..<paradisScrollMaxAscent {
		guard let element = current else {
			return nil
		}
		switch paradisRole(element) {
		case "AXScrollArea":
			return element
		case "AXWindow", "AXApplication", nil:
			return nil
		default:
			current = paradisElement(element, kAXParentAttribute)
		}
	}
	return nil
}

/** スクロールバーで動かす（D1）。スクロールバーが無い・動かせないなら nil（D2 へ）。 */
func paradisScrollWithScrollBar(hit: AXUIElement, direction: ParadisScrollDirection, distance: Double, pages: Double) -> ParadisAXScrollOutcome? {
	guard let area = paradisEnclosingScrollArea(hit) else {
		return nil
	}
	let vertical = paradisScrollIsVertical(direction)
	let role = "AXScrollArea"
	guard let bar = paradisElement(area, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar"), let value = paradisNumber(bar, kAXValueAttribute) else {
		// スクロールバーが無くても、領域がページのアクションを持つなら使う
		return paradisScrollByPageAction(area: area, bar: nil, direction: direction, pages: pages)
	}
	let areaFrame = paradisFrame(area)
	// 中身の長さ: スクロールバー以外の子の枠のうち、軸の向きに一番長いもの
	let content = paradisElements(area, kAXChildrenAttribute)
		.filter { paradisRole($0) != "AXScrollBar" }
		.compactMap { paradisFrame($0) }
		.map { Double(vertical ? $0.height : $0.width) }
		.max()
	let facts = ParadisScrollBarFacts(
		value: value,
		minValue: paradisNumber(bar, kAXMinValueAttribute) ?? 0,
		maxValue: paradisNumber(bar, kAXMaxValueAttribute) ?? 1,
		increment: paradisNumber(bar, "AXValueIncrement"),
		contentLength: content,
		viewportLength: areaFrame.map { Double(vertical ? $0.height : $0.width) }
	)
	guard let plan = paradisScrollBarPlan(facts, direction: direction, distance: distance, pages: pages) else {
		return ParadisAXScrollOutcome(method: .scrollBarValue, role: role, approximate: false, atEnd: true, moved: 0)
	}
	var settable = DarwinBoolean(false)
	if AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
		AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: plan.value)) == .success {
		usleep(paradisScrollSettleMicroseconds)
		if paradisScrollBarMoved(before: value, after: paradisNumber(bar, kAXValueAttribute), direction: direction) {
			return ParadisAXScrollOutcome(method: .scrollBarValue, role: role, approximate: plan.approximate)
		}
	}
	return paradisScrollByPageAction(area: area, bar: bar, direction: direction, pages: pages)
}

/** 領域のページのアクション、次にスクロールバーの増減のアクション。値が動いたと確かめられたものだけ返す。 */
private func paradisScrollByPageAction(area: AXUIElement, bar: AXUIElement?, direction: ParadisScrollDirection, pages: Double) -> ParadisAXScrollOutcome? {
	let before = bar.flatMap { paradisNumber($0, kAXValueAttribute) }
	func moved() -> Bool? {
		guard let bar, let before else {
			return nil
		}
		return paradisScrollBarMoved(before: before, after: paradisNumber(bar, kAXValueAttribute), direction: direction)
	}
	let pageAction = paradisScrollPageAction(direction)
	if paradisActions(area).contains(pageAction) {
		var performed = 0
		for _ in 0..<paradisScrollPageCount(pages: pages) {
			guard AXUIElementPerformAction(area, pageAction as CFString) == .success else {
				break
			}
			performed += 1
			usleep(20_000)
		}
		usleep(paradisScrollSettleMicroseconds)
		// 読み戻せるスクロールバーが無いときは、アクションが通ったことだけを頼りにする（概算）
		if performed > 0, moved() ?? true {
			return ParadisAXScrollOutcome(method: .pageAction, role: "AXScrollArea", approximate: bar == nil)
		}
	}
	guard let bar else {
		return nil
	}
	let stepAction = paradisScrollBarStepAction(direction)
	guard paradisActions(bar).contains(stepAction) else {
		return nil
	}
	for _ in 0..<min(50, paradisScrollPageCount(pages: pages) * 5) {
		guard AXUIElementPerformAction(bar, stepAction as CFString) == .success else {
			break
		}
		usleep(10_000)
	}
	usleep(paradisScrollSettleMicroseconds)
	return moved() == true ? ParadisAXScrollOutcome(method: .scrollBarStep, role: "AXScrollArea", approximate: true) : nil
}

// MARK: - D2

/**
 * 端の外にある要素を見える位置へ寄せて動かす（D2）。当たった要素から上へ、端の外へ中身がはみ出している要素を内側から
 * 順に試し、最後にスクロールする役割の入れ物（`AXScrollArea`・`AXWebArea`）を試す。最初に動いたもので終わる。
 * 動く量は概算。どれも動かなければ nil。
 */
func paradisScrollByRevealing(hit: AXUIElement, windowBounds: CGRect, direction: ParadisScrollDirection, distance: Double) -> ParadisAXScrollOutcome? {
	for (container, role) in paradisRevealCandidates(hit, direction: direction) {
		if let outcome = paradisReveal(in: container, role: role, windowBounds: windowBounds, direction: direction, distance: distance) {
			return outcome
		}
	}
	return nil
}

/** 試す入れ物を内側から順に。スクロールする役割の入れ物が見つからなければ空。 */
private func paradisRevealCandidates(_ hit: AXUIElement, direction: ParadisScrollDirection) -> [(AXUIElement, String)] {
	var candidates: [(AXUIElement, String)] = []
	var current: AXUIElement? = hit
	for _ in 0..<paradisScrollMaxAscent {
		guard let element = current, let role = paradisRole(element) else {
			return []
		}
		if paradisScrollContainerRoles.contains(role) {
			candidates.append((element, role))
			return candidates
		}
		if role == "AXWindow" || role == "AXApplication" {
			return []
		}
		if paradisClipsPastEdge(element, direction: direction) {
			candidates.append((element, role))
		}
		current = paradisElement(element, kAXParentAttribute)
	}
	return []
}

/** 子のどれかが、その要素の端の外にあるか、端に寄せた細い枠か。 */
private func paradisClipsPastEdge(_ element: AXUIElement, direction: ParadisScrollDirection) -> Bool {
	guard let frame = paradisFrame(element), paradisRealSize(frame) else {
		return false
	}
	return paradisElements(element, kAXChildrenAttribute).contains { child in
		paradisFrame(child).map { paradisPastEdge(frame: frame, direction: direction, rect: $0) } ?? false
	}
}

private func paradisReveal(in container: AXUIElement, role: String, windowBounds: CGRect, direction: ParadisScrollDirection, distance: Double) -> ParadisAXScrollOutcome? {
	guard let frame = paradisFrame(container) else {
		return nil
	}
	let viewport = frame.intersection(windowBounds)
	guard !viewport.isNull, viewport.width > 0, viewport.height > 0 else {
		return nil
	}
	// 子孫を文書の順にたどり、枠のある要素を集める。見えている部分より手前に丸ごとある枝には目的の要素が無い
	var elements: [AXUIElement] = []
	var nodes: [(rect: CGRect, leaf: Bool)] = []
	var stack: [(AXUIElement, Int)] = paradisElements(container, kAXChildrenAttribute).reversed().map { ($0, 1) }
	var visited = 0
	while let item = stack.popLast(), visited < paradisRevealMaxNodes {
		let (element, depth) = item
		visited += 1
		let rect = paradisFrame(element)
		let behind = rect.map { rect -> Bool in
			switch direction {
			case .down: return rect.maxY < viewport.minY
			case .up: return rect.minY > viewport.maxY
			case .right: return rect.maxX < viewport.minX
			case .left: return rect.minX > viewport.maxX
			}
		} ?? false
		var leaf = true
		if !behind && depth < paradisRevealMaxDepth {
			let children = paradisElements(element, kAXChildrenAttribute)
			leaf = children.isEmpty
			stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
		}
		if let rect, !behind {
			elements.append(element)
			nodes.append((rect, leaf))
		}
	}
	// 端の外の本物の枠を先に、無ければ Chromium の端に寄せた細い枠
	let real = nodes.map { paradisRealSize($0.rect) ? $0.rect : CGRect.zero }
	if let index = paradisPickRevealTarget(viewport: viewport, direction: direction, distance: distance, candidates: real) {
		let before = nodes[index].rect
		guard AXUIElementPerformAction(elements[index], "AXScrollToVisible" as CFString) == .success else {
			return nil
		}
		usleep(paradisScrollSettleMicroseconds)
		let after = paradisFrame(elements[index]) ?? before
		let moved = paradisRevealMoved(before: before, after: after, direction: direction)
		return moved > 0.5 ? ParadisAXScrollOutcome(method: .revealElement, role: role, approximate: true, moved: moved) : nil
	}
	guard let pick = paradisPickClamped(viewport: viewport, direction: direction, distance: distance, nodes: nodes) else {
		return nil
	}
	// 細い枠の要素は、見える大きさで出たか、前から見えていた要素が動いた（か消えた）なら動いたとみなす
	let reference = nodes.firstIndex { $0.leaf && paradisRealSize($0.rect) && viewport.contains($0.rect) }
	let referenceBefore = reference.map { nodes[$0].rect }
	guard AXUIElementPerformAction(elements[pick.index], "AXScrollToVisible" as CFString) == .success else {
		return nil
	}
	usleep(paradisScrollSettleMicroseconds)
	let after = paradisFrame(elements[pick.index])
	let referenceAfter = reference.flatMap { paradisFrame(elements[$0]) }
	let shown = after.map { paradisRealSize($0) && $0.intersects(viewport) } ?? false
	guard paradisContentMoved(before: referenceBefore, after: referenceAfter) == true || shown, let after, paradisRealSize(after) else {
		return nil
	}
	return ParadisAXScrollOutcome(method: .revealElement, role: role, approximate: true, moved: paradisClampedRevealMoved(viewport: viewport, after: after, direction: direction, pick: pick))
}
