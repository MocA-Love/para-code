/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 操作の命令の実体（前面に出す・クリック・ドラッグ・スクロール・文字入力・貼り付け・キー）。設計書 6.3。
//
//  - どの命令も、アクセシビリティの許可が無ければ OS に触れる前に断る
//  - 送る直前と各イベントの間に「前面のアプリが目的の pid か」「的の点（キーなら一番手前の通常のウィンドウ）の
//    持ち主が目的の pid か」を確かめ、違えば止める（Para Code の承認ダイアログやターミナルへ入力が漏れないように）
//  - 利用者の物理的な入力が直前 1 秒以内にあれば送らない（Q101、`user_active`）
//  - 修飾キーはイベントのフラグで付け、修飾キーそのものの押下は送らない。ボタンを押したら、止めるときも必ず離す
//  - クリックとキーは HID のタップへ送る（`postToPid` では AppKit に届かないアプリがあるため。Orca と同じ）。
//    スクロールだけは目的のプロセスへ直接送る
//  - 貼り付けはクリップボードを退避して書き換え、⌘V の後に元へ戻す。戻す前にほかが書き換えていたら
//    （変更回数で判断）戻さずにそちらを優先する（Q100）

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/** 貼り付けた後、相手のアプリがクリップボードを読むのを待つ時間。 */
private let paradisPasteSettleMicroseconds: UInt32 = 400_000

extension ParadisDesktop {

	// MARK: - 前面に出す

	func activateApp(pid: Int32, windowId: UInt32?) throws -> [String: Any] {
		try requireInputPermission()
		try requireUserIdle()
		try requireRunningApp(pid)
		paradisOnMain {
			_ = NSRunningApplication(processIdentifier: pid)?.unhide()
		}
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 2.0)
		AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
		if let windowId {
			let windows = paradisElements(application, kAXWindowsAttribute)
			let window = try paradisPickWindow(windows, application: application, windowId: windowId, pid: pid)
			AXUIElementPerformAction(window, kAXRaiseAction as CFString)
			AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		}
		paradisOnMain {
			_ = NSRunningApplication(processIdentifier: pid)?.activate(options: [])
		}
		usleep(250_000)
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		return ["frontmost": frontmost == pid]
	}

	// MARK: - マウス

	func click(pid: Int32, windowId: UInt32, target: ParadisPointerTarget, button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers) throws -> [String: Any] {
		try requireInputPermission()
		let (point, window) = try resolvePoint(pid: pid, windowId: windowId, target: target)
		try fence(pid: pid, point: point)
		try post(paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []))
		usleep(40_000)
		let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = button == .left
			? (.leftMouseDown, .leftMouseUp, .left)
			: (.rightMouseDown, .rightMouseUp, .right)
		let flags = paradisEventFlags(modifiers)
		for click in 1...clickCount {
			try fence(pid: pid, point: point)
			let down = paradisMouseEvent(downType, at: point, button: cgButton, flags: flags)
			down?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
			try post(down)
			usleep(25_000)
			// 押したボタンは、確かめに失敗しても必ず離す
			let failure = fenceFailure(pid: pid, point: point)
			let up = paradisMouseEvent(upType, at: point, button: cgButton, flags: flags)
			up?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
			try post(up)
			if let failure {
				throw failure
			}
			usleep(60_000)
		}
		return ["clicked": true, "point": paradisWindowPointJson(point, window)]
	}

	func drag(pid: Int32, windowId: UInt32, from: ParadisPointerTarget, to: ParadisPointerTarget) throws -> [String: Any] {
		try requireInputPermission()
		let (start, window) = try resolvePoint(pid: pid, windowId: windowId, target: from)
		let (end, _) = try resolvePoint(pid: pid, windowId: windowId, target: to)
		try fence(pid: pid, point: start)
		try post(paradisMouseEvent(.mouseMoved, at: start, button: .left, flags: []))
		usleep(40_000)
		try fence(pid: pid, point: start)
		try post(paradisMouseEvent(.leftMouseDown, at: start, button: .left, flags: []))
		var current = start
		var failure: ParadisHelperError?
		for step in paradisDragPath(from: (Double(start.x), Double(start.y)), to: (Double(end.x), Double(end.y)), steps: 12) {
			usleep(16_000)
			let point = CGPoint(x: step.x, y: step.y)
			if let problem = fenceFailure(pid: pid, point: point) {
				failure = problem
				break
			}
			try post(paradisMouseEvent(.leftMouseDragged, at: point, button: .left, flags: []))
			current = point
		}
		usleep(30_000)
		// 途中で止めても、押したボタンは離す
		try post(paradisMouseEvent(.leftMouseUp, at: current, button: .left, flags: []))
		if let failure {
			throw failure
		}
		return ["dragged": true, "from": paradisWindowPointJson(start, window), "to": paradisWindowPointJson(end, window)]
	}

	func scroll(pid: Int32, windowId: UInt32, target: ParadisPointerTarget?, direction: ParadisScrollDirection, pages: Double) throws -> [String: Any] {
		try requireInputPermission()
		let window = try windowInfo(pid: pid, windowId: windowId)
		let point = try target.map { try resolvePoint(pid: pid, windowId: windowId, target: $0).0 } ?? CGPoint(x: window.bounds.midX, y: window.bounds.midY)
		try fence(pid: pid, point: point)
		try post(paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []))
		usleep(30_000)
		let extent = direction == .up || direction == .down ? Double(window.bounds.height) : Double(window.bounds.width)
		for step in paradisScrollSteps(direction: direction, pages: pages, extent: extent) {
			try fence(pid: pid, point: point)
			guard let event = CGEvent(scrollWheelEvent2Source: paradisEventSource(), units: .pixel, wheelCount: 2, wheel1: step.dy, wheel2: step.dx, wheel3: 0) else {
				throw ParadisHelperError(code: "input_failed", message: "the scroll event could not be created")
			}
			event.location = point
			event.postToPid(pid)
			lastSyntheticEventAt = Date()
			usleep(16_000)
		}
		return ["scrolled": true, "point": paradisWindowPointJson(point, window.bounds)]
	}

	// MARK: - キーボード

	func typeText(pid: Int32, units: [ParadisTypedUnit]) throws -> [String: Any] {
		try requireInputPermission()
		for unit in units {
			try fence(pid: pid, point: nil)
			switch unit {
			case .text(let text):
				let utf16 = Array(text.utf16)
				for keyDown in [true, false] {
					let event = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: 0, keyDown: keyDown)
					event?.flags = []
					event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
					try post(event)
				}
			case .key(let keyCode):
				for keyDown in [true, false] {
					let event = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: keyCode, keyDown: keyDown)
					event?.flags = []
					try post(event)
				}
			}
			usleep(8_000)
		}
		return ["typed": units.count]
	}

	func pressChord(pid: Int32, chord: ParadisKeyChord) throws -> [String: Any] {
		try requireInputPermission()
		try sendChord(pid: pid, chord: chord)
		return ["pressed": true]
	}

	func pasteText(pid: Int32, text: String) throws -> [String: Any] {
		try requireInputPermission()
		// クリップボードに触る前に確かめる（送れないなら書き換えもしない）
		try fence(pid: pid, point: nil)
		let pasteboard = NSPasteboard.general
		let saved = paradisOnMain { paradisSavePasteboard(pasteboard) }
		let ourChangeCount = paradisOnMain { () -> Int in
			pasteboard.clearContents()
			pasteboard.setString(text, forType: .string)
			return pasteboard.changeCount
		}
		var pasteFailure: Error?
		do {
			try sendChord(pid: pid, chord: ParadisKeyChord(keyCode: paradisKeyCodeV, modifiers: .command))
			usleep(paradisPasteSettleMicroseconds)
		} catch {
			pasteFailure = error
		}
		let restored = paradisOnMain { () -> Bool in
			guard paradisShouldRestoreClipboard(changeCountAfterOurWrite: ourChangeCount, currentChangeCount: pasteboard.changeCount) else {
				return false
			}
			paradisRestorePasteboard(pasteboard, saved)
			return true
		}
		if let pasteFailure {
			throw pasteFailure
		}
		return ["pasted": true, "clipboardRestored": restored]
	}

	private func sendChord(pid: Int32, chord: ParadisKeyChord) throws {
		// 送らない組み合わせは要求の振り分けで断っているが、ここでももう一度見る
		if let reason = paradisBlockedChordReason(chord) {
			throw ParadisHelperError(code: "key_blocked", message: reason)
		}
		let flags = paradisEventFlags(chord.modifiers)
		try fence(pid: pid, point: nil)
		let down = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: chord.keyCode, keyDown: true)
		down?.flags = flags
		try post(down)
		usleep(20_000)
		// 押したキーは、確かめに失敗しても必ず離す
		let failure = fenceFailure(pid: pid, point: nil)
		let up = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: chord.keyCode, keyDown: false)
		up?.flags = flags
		try post(up)
		if let failure {
			throw failure
		}
	}

	// MARK: - 確かめ

	private func requireInputPermission() throws {
		guard AXIsProcessTrusted() else {
			throw ParadisHelperError(code: "accessibility_not_granted", message: "Accessibility permission is not granted to Para Code Computer Use")
		}
	}

	private func requireUserIdle() throws {
		let ours = lastSyntheticEventAt.map { Date().timeIntervalSince($0) }
		if paradisUserIsActive(secondsSinceLastInput: paradisSecondsSinceLastInput(), secondsSinceOurLastEvent: ours) {
			throw ParadisHelperError(code: "user_active", message: "the user is using the keyboard or mouse")
		}
	}

	private func fence(pid: Int32, point: CGPoint?) throws {
		if let failure = fenceFailure(pid: pid, point: point) {
			throw failure
		}
	}

	private func fenceFailure(pid: Int32, point: CGPoint?) -> ParadisHelperError? {
		do {
			try requireUserIdle()
		} catch let error as ParadisHelperError {
			return error
		} catch {
			return ParadisHelperError(code: "user_active", message: String(describing: error))
		}
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		let owner = point.map { paradisWindowOwner(at: $0) } ?? paradisKeyWindowOwner()
		return paradisFenceFailure(targetPid: pid, frontmostPid: frontmost, ownerAtTarget: owner)
	}

	private func windowInfo(pid: Int32, windowId: UInt32) throws -> ParadisWindowInfo {
		guard let info = paradisWindowInfos(pid: pid).first(where: { $0.windowId == windowId }) else {
			throw ParadisHelperError(code: "window_not_found", message: "the application has no window \(windowId)")
		}
		return info
	}

	/** 的を画面の座標にする。ウィンドウの外は断る。 */
	private func resolvePoint(pid: Int32, windowId: UInt32, target: ParadisPointerTarget) throws -> (CGPoint, CGRect) {
		let bounds = try windowInfo(pid: pid, windowId: windowId).bounds
		let point: CGPoint
		switch target {
		case .point(let x, let y):
			point = CGPoint(x: bounds.minX + CGFloat(x), y: bounds.minY + CGFloat(y))
		case .element(let index):
			guard let snapshot = lastSnapshot, snapshot.pid == pid, snapshot.windowId == windowId, index < snapshot.elements.count,
				let frame = paradisFrame(snapshot.elements[index]), frame.width > 0, frame.height > 0
			else {
				throw ParadisHelperError(code: "stale_element", message: "element \(index) is not in the latest accessibility tree of this window; read the window again")
			}
			point = CGPoint(x: frame.midX, y: frame.midY)
		}
		guard bounds.contains(point) else {
			throw ParadisHelperError(code: "point_outside_window", message: "the point is outside the window")
		}
		return (point, bounds)
	}

	private func post(_ event: CGEvent?) throws {
		guard let event else {
			throw ParadisHelperError(code: "input_failed", message: "the input event could not be created")
		}
		event.post(tap: .cghidEventTap)
		lastSyntheticEventAt = Date()
	}
}

// MARK: - 小道具

private func paradisEventSource() -> CGEventSource? {
	// 利用者のキーボードの修飾キーの状態を混ぜないよう、自分だけの状態で作る
	return CGEventSource(stateID: .privateState)
}

private func paradisMouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, flags: CGEventFlags) -> CGEvent? {
	let event = CGEvent(mouseEventSource: paradisEventSource(), mouseType: type, mouseCursorPosition: point, mouseButton: button)
	event?.flags = flags
	return event
}

private func paradisEventFlags(_ modifiers: ParadisModifiers) -> CGEventFlags {
	var flags: CGEventFlags = []
	if modifiers.contains(.command) {
		flags.insert(.maskCommand)
	}
	if modifiers.contains(.shift) {
		flags.insert(.maskShift)
	}
	if modifiers.contains(.option) {
		flags.insert(.maskAlternate)
	}
	if modifiers.contains(.control) {
		flags.insert(.maskControl)
	}
	return flags
}

/** 物理的な入力（キー・修飾キー・マウスのボタン・移動・スクロール）の、最後からの秒数。 */
private func paradisSecondsSinceLastInput() -> Double {
	let types: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel]
	return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
}

/** 画面に出ているウィンドウを手前から順に。 */
private func paradisOnScreenWindows() -> [[String: Any]] {
	return (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}

/** その点で一番手前にあるウィンドウの持ち主（メニューバーや通知も含めて見る）。 */
private func paradisWindowOwner(at point: CGPoint) -> Int32? {
	for entry in paradisOnScreenWindows() {
		guard let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue, layer >= 0,
			(entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
			let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsDictionary), bounds.contains(point)
		else {
			continue
		}
		return (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
	}
	return nil
}

/** キーの届く、一番手前の通常のウィンドウ（layer 0）の持ち主。 */
private func paradisKeyWindowOwner() -> Int32? {
	for entry in paradisOnScreenWindows() where (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
		return (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
	}
	return nil
}

private func paradisWindowPointJson(_ point: CGPoint, _ window: CGRect) -> [String: Any] {
	return ["x": Double(point.x - window.minX), "y": Double(point.y - window.minY)]
}

/** クリップボードの全部の項目と型を写す。 */
private func paradisSavePasteboard(_ pasteboard: NSPasteboard) -> [[(NSPasteboard.PasteboardType, Data)]] {
	return (pasteboard.pasteboardItems ?? []).map { item in
		item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
	}
}

private func paradisRestorePasteboard(_ pasteboard: NSPasteboard, _ saved: [[(NSPasteboard.PasteboardType, Data)]]) {
	pasteboard.clearContents()
	let items = saved.map { entries -> NSPasteboardItem in
		let item = NSPasteboardItem()
		for (type, data) in entries {
			item.setData(data, forType: type)
		}
		return item
	}
	if !items.isEmpty {
		pasteboard.writeObjects(items)
	}
}
