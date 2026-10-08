/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import AppKit
import ApplicationServices
import Foundation

/** AX が扱えなかった入力を、指定ウィンドウへ配送する。実カーソル・クリップボードは使わない。 */
final class ParadisBackgroundRoute: ParadisInputRoute {
	let kind = ParadisInputRouteKind.background
	let requiresForeground = false
	private unowned let desktop: ParadisDesktop
	private let transport = ParadisBackgroundTransport()

	init(desktop: ParadisDesktop) { self.desktop = desktop }

	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability {
		guard transport.available else { return .unavailable("background delivery symbols are unavailable") }
		switch action {
		case .click(_, _, let button, _, _):
			return button == .left ? .available : .unavailable("context menus need foreground input")
		case .scroll, .pressChord:
			return .available
		case .typeText(let text, _):
			return text.contains("\n") || text.contains("\r") ? .unavailable("line breaks need accessibility or foreground paste") : .available
		case .activate, .drag, .pasteText, .setValue:
			return .unavailable("this action needs accessibility or foreground input")
		}
	}

	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		do { return try performBackground(action, pid: pid, options: options) }
		catch var error as ParadisHelperError {
			if error.sent == nil { error.sent = 0 }
			throw error
		}
	}

	private func performBackground(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		try desktop.requireInputPermission()
		try fence(pid)
		if case .typeText = action, paradisOnMain({ paradisInputMethodIsActive() }) {
			return .fellThrough("an input method is active; use accessibility or foreground paste")
		}
		let windowId: UInt32
		let pointer: ParadisPointerTarget?
		let keyboard: Bool
		switch action {
		case .click(let id, let target, _, _, _): (windowId, pointer, keyboard) = (id, target, false)
		case .scroll(let id, let target, _, _): (windowId, pointer, keyboard) = (id, target, false)
		case .typeText, .pressChord:
			guard let id = options.backgroundWindowId else { return .fellThrough("background keys require an exact windowId") }
			(windowId, pointer, keyboard) = (id, nil, true)
		default: return .fellThrough("unsupported background action")
		}
		guard let started = paradisProcessStart(pid) else { throw ParadisHelperError(code: "app_not_found", message: "the target exited") }
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 0.3)
		let windows = paradisElements(application, kAXWindowsAttribute)
		// 位置による代用はしない。同じ場所にある別のウィンドウへ送らない。
		guard let window = windows.first(where: { paradisBackgroundWindowId($0) == windowId }) else {
			return .fellThrough("the exact window is not accessible")
		}
		let info = try desktop.windowInfo(pid: pid, windowId: windowId)
		if let reason = paradisAccessibilityWindowSkipReason(onScreen: info.onScreen, minimized: (paradisCopy(window, kAXMinimizedAttribute) as? NSNumber)?.boolValue != false, appHidden: paradisAppIsHidden(pid)) {
			return .fellThrough(reason)
		}
		// キーは PID 宛てなので、同じプロセスの複数ウィンドウには送らない。
		if keyboard && (windows.count != 1 || paradisElement(application, kAXFocusedWindowAttribute).flatMap(paradisBackgroundWindowId) != windowId) {
			return .fellThrough("background keys need one unambiguous focused window")
		}
		let point = try resolvePoint(pid: pid, windowId: windowId, bounds: info.bounds, target: pointer)
		var hit: AXUIElement?
		AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit)
		if let hit, paradisIsPasteMenuElement(hit) { throw ParadisHelperError(code: "key_blocked", message: "use pasteText for pasting") }
		if !keyboard, let hit, paradisBackgroundClickOpensMenu(roles: paradisAXClickAncestors(hit).map { paradisCopy($0, kAXRoleAttribute) as? String ?? "AXUnknown" }) {
			return .fellThrough("menu controls need foreground input")
		}
		let textTarget = keyboard ? paradisFocusedTextTarget(pid: pid) : nil
		if keyboard, let element = paradisFocusedElement(pid: pid), paradisElementLooksSecret(element) {
			throw ParadisHelperError(code: "key_blocked", message: "background input does not target password fields")
		}
		if !keyboard, let cursor = options.cursor {
			let duration = min(0.5, ParadisCursorOverlay.shared.glide(cursor, to: point))
			let deadline = Date().addingTimeInterval(duration)
			while Date() < deadline { try fence(pid); usleep(10_000) }
		}
		try fence(pid)
		// 既に開いていたメニューはこの操作の後始末として閉じない。
		let menuWasOpen = paradisAppMenuWindow(pid: pid) != nil || paradisOpenMenu(pid: pid, near: hit) != nil
		if menuWasOpen { throw ParadisHelperError(code: "menu_open", message: "the target already has an open menu") }
		let before = paradisFocusSnapshot()
		guard let originalPid = before.frontmostPid else { return .fellThrough("the foreground app is unknown") }
		let transaction = ParadisBackgroundTransaction(transport: transport, pid: pid, windowId: windowId, started: started, bounds: info.bounds, originalPid: originalPid)
		ParadisBackgroundCleanup.shared.install { transaction.finish() }
		defer { ParadisBackgroundCleanup.shared.run() }
		var result: [String: Any] = ["verified": NSNull()]
		do {
			try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: keyboard)
			let group = Int64.random(in: 1...Int64.max)
			switch action {
			case .click(_, _, _, let count, let modifiers):
				guard let move = paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []) else { throw failed() }
				try transaction.send(move, point: point, group: group)
				usleep(20_000)
				for index in 1...count {
					try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: false)
					let flags = paradisEventFlags(modifiers)
					guard let down = paradisMouseEvent(.leftMouseDown, at: point, button: .left, flags: flags),
						let up = paradisMouseEvent(.leftMouseUp, at: point, button: .left, flags: flags) else { throw failed() }
					down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
					up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
					try transaction.send(down, point: point, group: group, release: up)
					usleep(25_000)
					transaction.release()
					usleep(60_000)
				}
				result["clicked"] = true
			case .scroll(_, _, let direction, let pages):
				let extent = direction == .up || direction == .down ? Double(info.bounds.height) : Double(info.bounds.width)
				for step in paradisScrollSteps(direction: direction, pages: pages, extent: extent) {
					try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: false)
					guard let event = CGEvent(scrollWheelEvent2Source: paradisEventSource(), units: .pixel, wheelCount: 2, wheel1: step.dy, wheel2: step.dx, wheel3: 0) else { throw failed() }
					event.location = point
					try transaction.send(event, point: point, group: group)
					usleep(16_000)
				}
				result["scrolled"] = true
			case .pressChord(let chord):
				if let reason = paradisBlockedChordReason(chord) { throw ParadisHelperError(code: "key_blocked", message: reason) }
				try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: true)
				try key(transaction, code: chord.keyCode, flags: paradisEventFlags(chord.modifiers))
				result["pressed"] = true
			case .typeText(let text, let units):
				var lastFullCheck = Date.distantPast
				for (index, unit) in units.enumerated() {
					try fastFence(pid)
					if paradisNeedsFullFence(unitIndex: index, secondsSinceLastFullFence: Date().timeIntervalSince(lastFullCheck)) {
						try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: true)
						lastFullCheck = Date()
					}
					if case .text(let character) = unit { try key(transaction, code: 0, flags: [], text: character) }
					usleep(paradisInterCharacterMicroseconds)
				}
				usleep(80_000)
				let after = textTarget?.element.flatMap { paradisCopy($0, kAXValueAttribute) as? String }
				result = paradisTypeResult(method: .keys, check: paradisTypingOutcome(before: textTarget?.value, selection: textTarget?.selection, after: after, text: text), count: units.count)
			default: break
			}
		} catch {
			var failure = (error as? ParadisHelperError) ?? ParadisHelperError(code: "input_failed", message: "background input failed")
			transaction.finish()
			failure.sent = transaction.sentUnits
			let menu = closeMenuAfterInput(pid: pid, started: started, near: hit, shouldCheck: originalPid != pid && !menuWasOpen && transaction.sentUnits > 0)
			if let note = menu["note"] as? String { failure.note = note }
			throw failure
		}
		transaction.finish()
		let menu = closeMenuAfterInput(pid: pid, started: started, near: hit, shouldCheck: originalPid != pid && !menuWasOpen && transaction.sentUnits > 0)
		result.merge(menu) { _, value in value }
		let preserved = paradisFocusPreserved(before: before, after: paradisFocusSnapshot())
		result["focusPreserved"] = preserved
		if !preserved { result["note"] = "The foreground focus changed during input. " + (result["note"] as? String ?? "Read the target state before retrying.") }
		if !keyboard {
			result["point"] = paradisWindowPointJson(point, info.bounds)
			if let cursor = options.cursor { ParadisCursorOverlay.shared.ripple(cursor, at: point) }
		}
		return .done(result)
	}

	/** 成功・中断のどちらでも呼ぶ。利用者のフォーカスは動かさず、操作が開いたメニューだけを閉じる。 */
	private func closeMenuAfterInput(pid: Int32, started: Double, near element: AXUIElement?, shouldCheck: Bool) -> [String: Any] {
		guard shouldCheck, paradisProcessStart(pid) == started else { return [:] }
		var menu: AXUIElement?
		var visible = false
		let appearanceDeadline = Date().addingTimeInterval(0.12)
		repeat {
			menu = paradisOpenMenu(pid: pid, near: element)
			visible = menu != nil || paradisAppMenuWindow(pid: pid) != nil
			if visible { break }
			usleep(20_000)
		} while Date() < appearanceDeadline
		guard visible else { return [:] }
		var attempted = false
		var accepted = false
		let closingDeadline = Date().addingTimeInterval(0.3)
		repeat {
			guard paradisProcessStart(pid) == started else { return paradisBackgroundMenuResult(opened: true, attempted: attempted, accepted: accepted, stillOpen: false) }
			if !attempted, let menu {
				attempted = true
				AXUIElementSetMessagingTimeout(menu, 0.2)
				accepted = AXUIElementPerformAction(menu, kAXCancelAction as CFString) == .success
			}
			usleep(20_000)
			menu = paradisOpenMenu(pid: pid, near: element)
			visible = menu != nil || paradisAppMenuWindow(pid: pid) != nil
		} while visible && Date() < closingDeadline
		return paradisBackgroundMenuResult(opened: true, attempted: attempted, accepted: accepted, stillOpen: visible)
	}

	private func key(_ transaction: ParadisBackgroundTransaction, code: UInt16, flags: CGEventFlags, text: String? = nil) throws {
		guard let down = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: code, keyDown: true),
			let up = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: code, keyDown: false) else { throw failed() }
		for event in [down, up] {
			event.flags = flags
			if let text { let units = Array(text.utf16); event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units) }
		}
		try transaction.send(down, point: nil, group: 0, release: up)
		usleep(paradisKeyHoldMicroseconds)
		transaction.release()
	}

	private func fastFence(_ pid: Int32) throws {
		if let failure = paradisCurrentSessionFailure() ?? desktop.keyboardActivityFailure() { throw failure }
		// 修飾キーが押しっぱなしでも利用者の操作を優先する。
		let flags = CGEventSource.flagsState(.hidSystemState)
		if !flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty {
			throw ParadisHelperError(code: "user_active", message: "the user is holding a modifier key")
		}
	}

	private func fence(_ pid: Int32, entries: [[String: Any]]? = nil) throws {
		try fastFence(pid)
		if let failure = paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows(entries: entries)) { throw failure }
		if paradisAppMenuWindow(pid: pid, entries: entries) != nil || paradisOpenMenu(pid: pid) != nil {
			throw ParadisHelperError(code: "menu_open", message: "close the target menu before background input")
		}
	}

	private func revalidate(pid: Int32, started: Double, windowId: UInt32, bounds: CGRect, keyboard: Bool) throws {
		let entries = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
		try fence(pid, entries: entries)
		guard paradisProcessStart(pid) == started, let info = paradisWindowInfos(pid: pid, entries: entries).first(where: { $0.windowId == windowId }), info.onScreen, info.bounds == bounds, !paradisAppIsHidden(pid) else {
			throw ParadisHelperError(code: "window_not_found", message: "the background target changed")
		}
		if keyboard {
			if let field = paradisFocusedElement(pid: pid), paradisElementLooksSecret(field) {
				throw ParadisHelperError(code: "key_blocked", message: "the focused field is protected")
			}
			let app = AXUIElementCreateApplication(pid)
			AXUIElementSetMessagingTimeout(app, 0.3)
			guard paradisElements(app, kAXWindowsAttribute).count == 1,
				paradisElement(app, kAXFocusedWindowAttribute).flatMap(paradisBackgroundWindowId) == windowId else {
				throw ParadisHelperError(code: "window_not_focused", message: "the exact keyboard target changed")
			}
		}
	}

	private func resolvePoint(pid: Int32, windowId: UInt32, bounds: CGRect, target: ParadisPointerTarget?) throws -> CGPoint {
		let point: CGPoint
		switch target {
		case .point(let x, let y): point = CGPoint(x: bounds.minX + x, y: bounds.minY + y)
		case .element(let index, let id):
			guard let snapshot = desktop.lastSnapshot, snapshot.id == id, snapshot.pid == pid, snapshot.windowId == windowId,
				index >= 0, index < snapshot.elements.count, let frame = paradisFrame(snapshot.elements[index]) else {
				throw ParadisHelperError(code: "stale_element", message: "read the target window again")
			}
			point = CGPoint(x: frame.midX, y: frame.midY)
		case nil: point = CGPoint(x: bounds.midX, y: bounds.midY)
		}
		guard bounds.contains(point) else { throw ParadisHelperError(code: "point_outside_window", message: "the point is outside the target window") }
		return point
	}

	private func failed() -> ParadisHelperError { ParadisHelperError(code: "input_failed", message: "could not create a background event") }
}

/** 同じプロセスへ押下の解放を送り、終了処理の後には送信しない。フォーカスには触れない。 */
private final class ParadisBackgroundTransaction {
	private let lock = NSRecursiveLock()
	private let transport: ParadisBackgroundTransport
	private let pid: Int32
	private let windowId: UInt32
	private let started: Double
	private let bounds: CGRect
	private let originalPid: Int32
	private var pending: (CGEvent, CGPoint?, Int64)?
	private var closed = false
	private(set) var sentUnits = 0

	init(transport: ParadisBackgroundTransport, pid: Int32, windowId: UInt32, started: Double, bounds: CGRect, originalPid: Int32) {
		self.transport = transport
		self.pid = pid
		self.windowId = windowId
		self.started = started
		self.bounds = bounds
		self.originalPid = originalPid
	}

	func send(_ event: CGEvent, point: CGPoint?, group: Int64, release: CGEvent? = nil) throws {
		try ParadisRequestCancellation.check()
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		guard frontmost == originalPid else { throw ParadisHelperError(code: "focus_changed", message: "the foreground app changed during background input") }
		lock.lock()
		defer { lock.unlock() }
		guard !closed, paradisProcessStart(pid) == started else { throw ParadisHelperError(code: "app_not_found", message: "the background target exited") }
		// CGEvent.location は画面座標、CGEventSetWindowLocation はウィンドウ左上からの座標。
		let localPoint = point.map { CGPoint(x: $0.x - bounds.minX, y: $0.y - bounds.minY) }
		if let release { pending = (release, localPoint, group) }
		transport.send(event, pid: pid, windowId: windowId, point: localPoint, group: group)
		if event.type == .keyDown || event.type == .leftMouseDown || event.type == .scrollWheel { sentUnits += 1 }
	}

	func release() {
		lock.lock()
		defer { lock.unlock() }
		if let (event, point, group) = pending, paradisProcessStart(pid) == started {
			transport.send(event, pid: pid, windowId: windowId, point: point, group: group)
		}
		pending = nil
	}

	func finish() {
		lock.lock()
		defer { lock.unlock() }
		guard !closed else { return }
		closed = true
		release()
	}
}
