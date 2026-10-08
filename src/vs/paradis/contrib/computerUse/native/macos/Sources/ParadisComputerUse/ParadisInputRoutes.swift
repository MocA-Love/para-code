/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 入力の送り方の段の実体（段の並びと選び方は Core の ParadisInputRoute.swift）。
//
//  - 1 段目 `ParadisAccessibilityRoute`: AX の操作。マウスもカーソルも動かさず、前面に出さない
//  - 2 段目 `paradisMakeBackgroundRoute()`: 背面への入力の差し込み口。今は Core の空の実装（常に使えない）を返す
//  - 3 段目 `ParadisForegroundRoute`: 今までの経路（ParadisInput.swift の foreground*）
//
// 1 段目で確かめること（3 段目と違い、前面のアプリが目的の pid であることは求めない）:
//  - 目的のウィンドウがあって、今の画面に出ていて（別の操作スペースでない）、しまわれておらず、アプリを隠していない
//    （どれかに当たれば 3 段目へ譲る）
//  - 画面のロック中・ほかのユーザーへの切り替え中でない
//  - メニューを開く操作（AXShowMenu、ポップアップ・メニューボタンの AXPress）は、目的のアプリが前面のときだけ。背面で
//    メニューが開いてしまったら（フォーカスが変わったら）AXCancel で閉じる
//  - 利用者が打鍵中でない（直前 1 秒の物理的なキー入力。マウスの動きでは止めない）
//  - 認証・同意のダイアログが出ていない
//  - 操作の前後で、前面のアプリ・キーボードのフォーカスのあるアプリ・その手前のウィンドウが変わらなかったか（結果の
//    `focusPreserved`。変わっても元へは戻さない。右クリックのメニューは開いている間フォーカスを取る）

import AppKit
import ApplicationServices
import Foundation

/**
 * 2 段目（背面への入力）の実装を返す。今は常に使えない空の実装。
 * 実装をはめ込むときは、`ParadisInputRoute` に準拠したクラスをこのフォルダに新しく作り、ここから返す。
 */
func paradisMakeBackgroundRoute() -> ParadisInputRoute {
	return ParadisUnavailableBackgroundRoute()
}

// MARK: - 3 段目

/** 今までの経路（前面に出し、実カーソルを動かして HID のタップへ送る）。 */
final class ParadisForegroundRoute: ParadisInputRoute {
	let kind = ParadisInputRouteKind.foreground
	let requiresForeground = true
	private unowned let desktop: ParadisDesktop

	init(desktop: ParadisDesktop) {
		self.desktop = desktop
	}

	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability {
		if case .setValue = action {
			return .unavailable("setting a value needs accessibility; click the element and type instead")
		}
		return .available
	}

	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		if options.activateFirst {
			// 承認ダイアログのボタンを押した直後（Para Code が前面で、そのクリックが直前の入力に入る）。入力が止むのを
			// 待って目的のアプリを前面に出す。前面に出すこと自体が求めた操作なら、それで終わり
			let windowId: UInt32?
			switch action {
			case .activate(let id): windowId = id
			case .click(let id, _, _, _, _), .drag(let id, _, _), .scroll(let id, _, _, _), .setValue(let id, _, _): windowId = id
			case .typeText, .pasteText, .pressChord: windowId = nil
			}
			try desktop.prepareForeground(pid: pid, windowId: windowId)
			if case .activate = action {
				let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
				return .done(["frontmost": frontmost == pid])
			}
		}
		switch action {
		case .activate(let windowId):
			return .done(try desktop.foregroundActivate(pid: pid, windowId: windowId))
		case .click(let windowId, let target, let button, let clickCount, let modifiers):
			return .done(try desktop.foregroundClick(pid: pid, windowId: windowId, target: target, button: button, clickCount: clickCount, modifiers: modifiers, cursor: options.cursor))
		case .drag(let windowId, let from, let to):
			return .done(try desktop.foregroundDrag(pid: pid, windowId: windowId, from: from, to: to, cursor: options.cursor))
		case .scroll(let windowId, let target, let direction, let pages):
			return .done(try desktop.foregroundScroll(pid: pid, windowId: windowId, target: target, direction: direction, pages: pages, cursor: options.cursor))
		case .typeText(let text, let units):
			return .done(try desktop.foregroundTypeText(pid: pid, text: text, units: units))
		case .pasteText(let text):
			return .done(try desktop.foregroundPasteText(pid: pid, text: text))
		case .pressChord(let chord):
			return .done(try desktop.foregroundPressChord(pid: pid, chord: chord))
		case .setValue:
			return .fellThrough("setting a value needs accessibility")
		}
	}
}

// MARK: - 1 段目

/** AX の読み戻しを待つ時間。 */
private let paradisAXSettleMicroseconds: UInt32 = 120_000

final class ParadisAccessibilityRoute: ParadisInputRoute {
	let kind = ParadisInputRouteKind.accessibility
	let requiresForeground = false
	private unowned let desktop: ParadisDesktop

	init(desktop: ParadisDesktop) {
		self.desktop = desktop
	}

	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability {
		switch action {
		case .click(_, _, _, let clickCount, let modifiers):
			if !modifiers.isEmpty {
				return .unavailable("clicks with modifier keys need real input")
			}
			return clickCount == 1 ? .available : .unavailable("double and triple clicks need real input")
		case .setValue, .typeText:
			return .available
		case .activate:
			return .unavailable("bringing an app forward changes the user's focus")
		case .drag, .scroll, .pasteText, .pressChord:
			return .unavailable("\(action.name) needs real input")
		}
	}

	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		switch action {
		case .click(let windowId, let target, let button, let clickCount, let modifiers):
			return try click(pid: pid, windowId: windowId, target: target, button: button, clickCount: clickCount, modifiers: modifiers, cursor: options.cursor)
		case .setValue(let windowId, let target, let change):
			return try setValue(pid: pid, windowId: windowId, target: target, change: change, cursor: options.cursor)
		case .typeText(let text, let units):
			return try typeText(pid: pid, text: text, count: units.count, cursor: options.cursor)
		default:
			return .fellThrough("\(action.name) needs real input")
		}
	}

	// MARK: クリック

	private func click(pid: Int32, windowId: UInt32, target: ParadisPointerTarget, button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers, cursor: ParadisCursorOwnerSpec?) throws -> ParadisRouteOutcome {
		let window: ParadisAXTargetWindow
		switch try targetWindow(pid: pid, windowId: windowId) {
		case .success(let found):
			window = found
		case .failure(let reason):
			return .fellThrough(reason.message)
		}
		try fence(pid: pid)
		let hit: AXUIElement
		switch try resolveElement(pid: pid, window: window, target: target) {
		case .success(let element):
			hit = element
		case .failure(let reason):
			return .fellThrough(reason.message)
		}
		var chain: [AXUIElement] = [hit]
		while chain.count < paradisAXClickChainLimit, let parent = paradisElement(chain[chain.count - 1], kAXParentAttribute), !paradisIsWindow(parent) {
			chain.append(parent)
		}
		let targetIsFrontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier } == pid
		let plan = paradisAccessibilityClickPlan(button: button, clickCount: clickCount, modifiers: modifiers, chain: chain.map(paradisAXFacts), targetIsFrontmost: targetIsFrontmost)
		let element: AXUIElement
		let actionName: String
		switch plan {
		case .none(let reason):
			return .fellThrough(reason)
		case .perform(let action, let depth):
			element = chain[depth]
			actionName = action
		case .focus(let depth):
			element = chain[depth]
			actionName = "AXFocused"
		}
		// メニューの「ペースト」は、⌘V と同じく利用者のクリップボードを貼るので押さない（レビュー N11）
		if paradisIsPasteMenuElement(element) {
			throw ParadisHelperError(code: "key_blocked", message: "Paste menu items are never clicked; use pasteText")
		}
		let center = paradisFrame(element).map { CGPoint(x: $0.midX, y: $0.midY) }
		try glideCursor(cursor, to: center, pid: pid)
		let role = paradisCopy(element, kAXRoleAttribute) as? String ?? "AXUnknown"
		let before = paradisAXValueText(paradisCopy(element, kAXValueAttribute))
		let focusBefore = paradisFocusSnapshot()
		var verified: Bool?
		// 「何もしていないと言い切れない」失敗（締め切りなど）。送ったかもしれないので次の段へは譲らず、確かめられないと返す
		var uncertainError: AXError?
		if actionName == "AXFocused" {
			let error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
			if error != .success && paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
				return .fellThrough("the text field refused focus (AXError \(error.rawValue))")
			}
			uncertainError = error == .success ? nil : error
			usleep(paradisAXSettleMicroseconds)
			// 本物のクリックと同じく、選択せずにキャレットを置く（全体が選ばれたまま次の文字入力で消えないように）。置くのは末尾
			if let value = paradisCopy(element, kAXValueAttribute) as? String {
				var range = CFRange(location: value.utf16.count, length: 0)
				if let caret = AXValueCreate(.cfRange, &range) {
					AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, caret)
				}
			}
			let focused = paradisElement(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute)
			verified = focused.map { CFEqual($0, element) }
		} else {
			let error = AXUIElementPerformAction(element, actionName as CFString)
			if error != .success && paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
				return .fellThrough("the element refused \(actionName) (AXError \(error.rawValue))")
			}
			uncertainError = error == .success ? nil : error
			usleep(paradisAXSettleMicroseconds)
			verified = actionName == "AXPress" && uncertainError == nil ? paradisAXPressCheck(role: role, before: before, after: paradisAXValueText(paradisCopy(element, kAXValueAttribute))).verified : nil
		}
		if uncertainError != nil {
			verified = nil
		}
		let focusPreserved = paradisFocusPreserved(before: focusBefore, after: paradisFocusSnapshot())
		// 背面のアプリでメニューが開いてしまったら（押したボタンがメニューを出したなど）、利用者の打鍵が項目を選ばないよう閉じる
		let menuClosed = !focusPreserved && !targetIsFrontmost && paradisCloseOpenMenu(pid: pid)
		if let cursor, let center {
			ParadisCursorOverlay.shared.ripple(cursor, at: center)
		}
		var result: [String: Any] = [
			"clicked": true,
			"axAction": actionName,
			"element": paradisElementJson(element, role: role),
			"verified": verified.map { $0 as Any } ?? NSNull(),
			"focusPreserved": focusPreserved,
		]
		if let center {
			result["point"] = paradisWindowPointJson(center, window.bounds)
		}
		if let uncertainError {
			result["axError"] = Int(uncertainError.rawValue)
		}
		if menuClosed {
			result["menuClosed"] = true
			result["note"] = "A menu opened in the app while it was not in front, so Para Code closed it. Bring the app forward with computer_activate_app to use the menu."
		} else if !focusPreserved {
			result["note"] = targetIsFrontmost && actionName == "AXShowMenu"
				? "The context menu took the keyboard focus while it is open."
				: "The user's focus changed during the action (the app may have brought a window forward)."
		}
		if uncertainError != nil {
			let note = "The app did not confirm the action in time; it may or may not have happened. Read the state before trying again."
			result["note"] = [result["note"] as? String, note].compactMap { $0 }.joined(separator: " ")
		}
		return .done(result)
	}

	// MARK: 値

	private func setValue(pid: Int32, windowId: UInt32, target: ParadisPointerTarget, change: ParadisValueChange, cursor: ParadisCursorOwnerSpec?) throws -> ParadisRouteOutcome {
		let window: ParadisAXTargetWindow
		switch try targetWindow(pid: pid, windowId: windowId) {
		case .success(let found):
			window = found
		case .failure(let reason):
			return .fellThrough(reason.message)
		}
		try fence(pid: pid)
		let hit: AXUIElement
		switch try resolveElement(pid: pid, window: window, target: target) {
		case .success(let element):
			hit = element
		case .failure(let reason):
			return .fellThrough(reason.message)
		}
		// スライダーのつまみ（AXValueIndicator）に当たったときなどのため、親も 1 つ見る
		var candidates: [AXUIElement] = [hit]
		if let parent = paradisElement(hit, kAXParentAttribute), !paradisIsWindow(parent) {
			candidates.append(parent)
		}
		var picked: (AXUIElement, ParadisAXValuePlan)?
		var reasons: [String] = []
		for candidate in candidates {
			var settable = DarwinBoolean(false)
			let valueSettable = AXUIElementIsAttributeSettable(candidate, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
			let plan = paradisAccessibilityValuePlan(change, facts: paradisAXFacts(candidate), valueSettable: valueSettable, secret: paradisElementLooksSecret(candidate))
			if case .none(let reason) = plan {
				reasons.append(reason)
				continue
			}
			picked = (candidate, plan)
			break
		}
		guard let (element, plan) = picked else {
			return .fellThrough(reasons.first ?? "the element does not accept a new value")
		}
		let center = paradisFrame(element).map { CGPoint(x: $0.midX, y: $0.midY) }
		try glideCursor(cursor, to: center, pid: pid)
		let role = paradisCopy(element, kAXRoleAttribute) as? String ?? "AXUnknown"
		let before = paradisAXValueText(paradisCopy(element, kAXValueAttribute))
		let focusBefore = paradisFocusSnapshot()
		var actionName = "AXValue"
		var performed = 0
		var uncertainError: AXError?
		switch plan {
		case .setValue:
			let value: CFTypeRef
			switch change {
			case .text(let text):
				value = paradisNormalizeTypedText(text) as CFString
			case .number(let number):
				value = NSNumber(value: number)
			case .boolean(let flag):
				value = NSNumber(value: flag ? 1 : 0)
			case .increment, .decrement:
				return .fellThrough("internal: no value to write")
			}
			let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value)
			if error != .success && paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
				return .fellThrough("the element refused the new value (AXError \(error.rawValue))")
			}
			if error != .success {
				uncertainError = error
			}
			performed = 1
		case .perform(let action, let count):
			actionName = action
			for index in 0..<count {
				let error = AXUIElementPerformAction(element, action as CFString)
				if error != .success {
					if index == 0 && paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
						return .fellThrough("the element refused \(action) (AXError \(error.rawValue))")
					}
					if !paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
						uncertainError = error
					}
					break
				}
				performed += 1
				// 増減は 1 回ごとにアプリが値を動かすので、少し間を置く
				usleep(20_000)
			}
		case .none(let reason):
			return .fellThrough(reason)
		}
		// 読み戻す。アプリが非同期に反映することがあるので、確かめられるまで最長 1 秒読み直す
		let deadline = Date().addingTimeInterval(paradisAXReadbackLimitSeconds)
		var check = ParadisAXCheck(verified: nil, value: nil)
		repeat {
			usleep(paradisAXReadbackIntervalMicroseconds)
			check = paradisAXValueCheck(change: change, before: before, after: paradisAXValueText(paradisCopy(element, kAXValueAttribute)))
		} while check.verified != true && Date() < deadline
		let focusPreserved = paradisFocusPreserved(before: focusBefore, after: paradisFocusSnapshot())
		if let cursor, let center {
			ParadisCursorOverlay.shared.ripple(cursor, at: center)
		}
		var result: [String: Any] = [
			"set": true,
			"axAction": actionName,
			"element": paradisElementJson(element, role: role),
			"verified": check.verified.map { $0 as Any } ?? NSNull(),
			"focusPreserved": focusPreserved,
		]
		if case .perform = plan {
			result["steps"] = performed
		}
		if let uncertainError {
			result["axError"] = Int(uncertainError.rawValue)
		}
		if let value = check.value {
			result["value"] = paradisSanitizeText(value, maxLength: 200)
		}
		if !focusPreserved {
			result["note"] = "The user's focus changed during the action (the app may have brought a window forward)."
		}
		return .done(result)
	}

	// MARK: 文字

	/** フォーカスのある欄の選択範囲を AX で置き換える（既存の経路。前面に出さずに入れる）。 */
	private func typeText(pid: Int32, text: String, count: Int, cursor: ParadisCursorOwnerSpec?) throws -> ParadisRouteOutcome {
		try fence(pid: pid)
		guard let field = paradisFocusedElement(pid: pid) else {
			return .fellThrough("the app has no focused element")
		}
		guard let window = paradisElement(field, kAXWindowAttribute), let windowId = paradisAXWindowNumber(window) else {
			return .fellThrough("the window with the focused field could not be found")
		}
		let onScreen = paradisWindowInfos(pid: pid).first(where: { $0.windowId == windowId })?.onScreen ?? false
		let minimized = (paradisCopy(window, kAXMinimizedAttribute) as? NSNumber)?.boolValue == true
		if let reason = paradisAccessibilityWindowSkipReason(onScreen: onScreen, minimized: minimized, appHidden: paradisAppIsHidden(pid)) {
			return .fellThrough(reason)
		}
		let center = paradisFrame(field).map { CGPoint(x: $0.midX, y: $0.midY) }
		try glideCursor(cursor, to: center, pid: pid)
		let focusBefore = paradisFocusSnapshot()
		guard case .finished(let check) = paradisInsertViaAccessibility(pid: pid, text: paradisNormalizeTypedText(text)) else {
			return .fellThrough("the focused field does not accept text through accessibility")
		}
		var result = paradisTypeResult(method: .accessibility, check: check, count: count)
		let focusPreserved = paradisFocusPreserved(before: focusBefore, after: paradisFocusSnapshot())
		result["focusPreserved"] = focusPreserved
		if !focusPreserved {
			result["note"] = "The user's focus changed while typing (the app may have brought a window forward)."
		}
		return .done(result)
	}

	// MARK: 確かめ

	/** 利用者が打鍵中でないか、認証・同意のダイアログが出ていないか。前面のアプリは問わない。 */
	private func fence(pid: Int32) throws {
		if let failure = paradisCurrentSessionFailure() ?? desktop.keyboardActivityFailure() ?? paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows()) {
			throw failure
		}
	}

	/** 目的のウィンドウ（無ければ 3 段目と同じく断る。AX で引けない・しまわれているなら 3 段目へ譲る）。 */
	private func targetWindow(pid: Int32, windowId: UInt32) throws -> Result<ParadisAXTargetWindow, ParadisAXRouteSkip> {
		let info = try desktop.windowInfo(pid: pid, windowId: windowId)
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 1.0)
		guard let window = try? desktop.paradisPickWindow(paradisElements(application, kAXWindowsAttribute), application: application, windowId: windowId, pid: pid) else {
			return .failure(ParadisAXRouteSkip("the window is not in the accessibility tree"))
		}
		let minimized = (paradisCopy(window, kAXMinimizedAttribute) as? NSNumber)?.boolValue == true
		if let reason = paradisAccessibilityWindowSkipReason(onScreen: info.onScreen, minimized: minimized, appHidden: paradisAppIsHidden(pid)) {
			return .failure(ParadisAXRouteSkip(reason))
		}
		return .success(ParadisAXTargetWindow(windowId: windowId, element: window, bounds: info.bounds, application: application))
	}

	/**
	 * 的の要素。番号なら直前に読んだツリーの要素そのもの、座標ならアプリに聞いた当たり判定（ほかのアプリのウィンドウが
	 * 重なっていても、目的のアプリの要素が返る）。当たった要素が目的のウィンドウのものでなければ譲る。
	 */
	private func resolveElement(pid: Int32, window: ParadisAXTargetWindow, target: ParadisPointerTarget) throws -> Result<AXUIElement, ParadisAXRouteSkip> {
		switch target {
		case .element(let index, let snapshotId):
			guard let snapshot = desktop.lastSnapshot, snapshot.id == snapshotId, snapshot.pid == pid, snapshot.windowId == window.windowId, index < snapshot.elements.count else {
				throw ParadisHelperError(code: "stale_element", message: "element \(index) is not in the latest accessibility tree of this window; read the window again")
			}
			return .success(snapshot.elements[index])
		case .point(let x, let y):
			let point = CGPoint(x: window.bounds.minX + CGFloat(x), y: window.bounds.minY + CGFloat(y))
			guard window.bounds.contains(point) else {
				throw ParadisHelperError(code: "point_outside_window", message: "the point is outside the window")
			}
			var element: AXUIElement?
			guard AXUIElementCopyElementAtPosition(window.application, Float(point.x), Float(point.y), &element) == .success, let element else {
				return .failure(ParadisAXRouteSkip("no accessibility element at the point"))
			}
			guard let owner = paradisElement(element, kAXWindowAttribute), CFEqual(owner, window.element) else {
				return .failure(ParadisAXRouteSkip("the element at the point belongs to another window"))
			}
			return .success(element)
		}
	}

	/** 独自のカーソルを要素へ動かし、着くまで待つ。待つ間に利用者が打ち始めたら止める。 */
	private func glideCursor(_ cursor: ParadisCursorOwnerSpec?, to point: CGPoint?, pid: Int32) throws {
		guard let cursor, let point else {
			return
		}
		let wait = ParadisCursorOverlay.shared.glide(cursor, to: point)
		if wait > 0 {
			usleep(UInt32(min(wait, 0.5) * 1_000_000))
			try fence(pid: pid)
		}
	}
}

/** 1 段目が譲る理由。 */
private struct ParadisAXRouteSkip: Error {
	let message: String
	init(_ message: String) {
		self.message = message
	}
}

private struct ParadisAXTargetWindow {
	let windowId: UInt32
	let element: AXUIElement
	let bounds: CGRect
	let application: AXUIElement
}

/** アプリを隠しているか（⌘H）。 */
private func paradisAppIsHidden(_ pid: Int32) -> Bool {
	return paradisOnMain { NSRunningApplication(processIdentifier: pid)?.isHidden ?? false }
}

/**
 * 目的のアプリで開いているメニューを閉じる（`AXCancel`）。キーボードのフォーカスのある要素から親をたどって
 * `AXMenu` を探す。閉じたら true。
 */
private func paradisCloseOpenMenu(pid: Int32) -> Bool {
	let application = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(application, 0.5)
	var element = paradisElement(application, kAXFocusedUIElementAttribute)
	for _ in 0..<4 {
		guard let current = element else {
			break
		}
		if (paradisCopy(current, kAXRoleAttribute) as? String) == "AXMenu" {
			return AXUIElementPerformAction(current, kAXCancelAction as CFString) == .success
		}
		element = paradisElement(current, kAXParentAttribute)
	}
	return false
}

private func paradisIsWindow(_ element: AXUIElement) -> Bool {
	return (paradisCopy(element, kAXRoleAttribute) as? String) == "AXWindow"
}

/** ウィンドウの要素の CGWindowID（非公開の対応表が引けなければ nil）。 */
private func paradisAXWindowNumber(_ window: AXUIElement) -> UInt32? {
	guard let lookup = paradisAXWindowIdFunction() else {
		return nil
	}
	var windowId: CGWindowID = 0
	return lookup(window, &windowId) == .success ? windowId : nil
}

/** クリックの代わりの操作を選ぶための、要素の役割・操作・使えるか。 */
private func paradisAXFacts(_ element: AXUIElement) -> ParadisAXElementFacts {
	let values = paradisCopyMultiple(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXEnabledAttribute])
	var actions: CFArray?
	let names = AXUIElementCopyActionNames(element, &actions) == .success ? (actions as? [String] ?? []) : []
	var settable = DarwinBoolean(false)
	let focusSettable = AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable) == .success && settable.boolValue
	return ParadisAXElementFacts(
		role: values[kAXRoleAttribute] as? String ?? "AXUnknown",
		subrole: values[kAXSubroleAttribute] as? String,
		actions: names,
		enabled: (values[kAXEnabledAttribute] as? NSNumber)?.boolValue,
		focusSettable: focusSettable
	)
}

/** 結果に添える要素の説明（役割と、パスワード欄でなければ名前）。 */
private func paradisElementJson(_ element: AXUIElement, role: String) -> [String: Any] {
	var json: [String: Any] = ["role": role]
	if !paradisElementLooksSecret(element), let title = (paradisCopy(element, kAXTitleAttribute) as? String) ?? (paradisCopy(element, kAXDescriptionAttribute) as? String), !title.isEmpty {
		json["title"] = paradisSanitizeText(title, maxLength: 80)
	}
	return json
}

/** 前面のアプリ・キーボードのフォーカスのあるアプリ・そのアプリの手前のウィンドウ。 */
func paradisFocusSnapshot() -> ParadisFocusSnapshot {
	let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
	let systemWide = AXUIElementCreateSystemWide()
	// 最初の問い合わせが空で返ることがある（手元の macOS 27 で確かめた）ので 1 回だけ聞き直す
	let application = paradisElement(systemWide, kAXFocusedApplicationAttribute) ?? paradisElement(systemWide, kAXFocusedApplicationAttribute)
	var pid: pid_t = 0
	let applicationPid = application.flatMap { AXUIElementGetPid($0, &pid) == .success ? pid : nil }
	let window = application.flatMap { paradisElement($0, kAXFocusedWindowAttribute) }
	return ParadisFocusSnapshot(frontmostPid: frontmost, focusedApplicationPid: applicationPid, focusedWindowId: window.flatMap(paradisAXWindowNumber))
}
