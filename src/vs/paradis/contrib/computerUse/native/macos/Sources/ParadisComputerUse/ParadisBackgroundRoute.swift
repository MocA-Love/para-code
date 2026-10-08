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
			guard let id = options.windowId else { return .fellThrough("background keys require an exact windowId") }
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
		if !keyboard, let hit, let role = paradisCopy(hit, kAXRoleAttribute) as? String, ["AXPopUpButton", "AXMenuButton", "AXMenuBarItem", "AXMenuItem"].contains(role) {
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
		let before = paradisFocusSnapshot()
		guard let originalPid = before.frontmostPid, before.focusedApplicationPid == originalPid,
			let originalWindow = before.focusedWindowId,
			let originalStarted = paradisProcessStart(originalPid),
			let previousPSN = transport.processSerialNumber(originalPid), let targetPSN = transport.processSerialNumber(pid) else {
			return .fellThrough("the original focus cannot be saved for background input")
		}
		let transaction = ParadisBackgroundTransaction(transport: transport, pid: pid, windowId: windowId, started: started, bounds: info.bounds,
			originalPid: originalPid, originalWindow: originalWindow, originalStarted: originalStarted, previousPSN: previousPSN, targetPSN: targetPSN)
		ParadisBackgroundCleanup.shared.install { transaction.finish() }
		defer { ParadisBackgroundCleanup.shared.run() }
		var result: [String: Any] = ["verified": NSNull()]
		var sent = 0
		do {
			try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: keyboard)
			try transaction.begin()
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
					sent += 1
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
					sent += 1
					usleep(16_000)
				}
				result["scrolled"] = true
			case .pressChord(let chord):
				if let reason = paradisBlockedChordReason(chord) { throw ParadisHelperError(code: "key_blocked", message: reason) }
				try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: true)
				try key(transaction, code: chord.keyCode, flags: paradisEventFlags(chord.modifiers))
				sent = 1
				result["pressed"] = true
			case .typeText(let text, let units):
				for unit in units {
					try revalidate(pid: pid, started: started, windowId: windowId, bounds: info.bounds, keyboard: true)
					if case .text(let character) = unit { try key(transaction, code: 0, flags: [], text: character) }
					sent += 1
					usleep(paradisInterCharacterMicroseconds)
				}
				usleep(80_000)
				let after = textTarget?.element.flatMap { paradisCopy($0, kAXValueAttribute) as? String }
				result = paradisTypeResult(method: .keys, check: paradisTypingOutcome(before: textTarget?.value, selection: textTarget?.selection, after: after, text: text), count: units.count)
			default: break
			}
		} catch {
			// フォーカスの変更を始めた後も次の段へ落とさない。二重クリック・二重入力を防ぐ。
			result["completed"] = false
			result["sentUnits"] = sent
			result["note"] = "Background input stopped; some input may have arrived. Read the target state before retrying. " + String(describing: error)
			if case .typeText = action { result["typed"] = sent; result["method"] = "keys"; result["verified"] = NSNull() }
		}
		transaction.finish()
		let preserved = transaction.restored && paradisFocusPreserved(before: before, after: paradisFocusSnapshot())
		result["focusPreserved"] = preserved
		if originalPid != pid, paradisAppMenuWindow(pid: pid) != nil || paradisOpenMenu(pid: pid) != nil {
			result["menuOpen"] = true
			result["note"] = "The target opened a menu that could not be closed. Stop and close that menu before continuing."
		}
		if !preserved { result["note"] = "Focus restoration could not be confirmed. " + (result["note"] as? String ?? "Read the target state before retrying.") }
		if !keyboard {
			result["point"] = paradisWindowPointJson(point, info.bounds)
			if let cursor = options.cursor { ParadisCursorOverlay.shared.ripple(cursor, at: point) }
		}
		return .done(result)
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

	private func fence(_ pid: Int32) throws {
		if ParadisBackgroundConnection.disconnected {
			throw ParadisHelperError(code: "cancelled", message: "the input connection closed")
		}
		if let failure = paradisCurrentSessionFailure() ?? desktop.keyboardActivityFailure() ?? paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows()) { throw failure }
		if paradisAppMenuWindow(pid: pid) != nil || paradisOpenMenu(pid: pid) != nil {
			throw ParadisHelperError(code: "menu_open", message: "close the target menu before background input")
		}
		// 修飾キーが押しっぱなしでも利用者の操作を優先する。
		let flags = CGEventSource.flagsState(.hidSystemState)
		if !flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty {
			throw ParadisHelperError(code: "user_active", message: "the user is holding a modifier key")
		}
	}

	private func revalidate(pid: Int32, started: Double, windowId: UInt32, bounds: CGRect, keyboard: Bool) throws {
		try desktop.requireInputPermission()
		try fence(pid)
		guard paradisProcessStart(pid) == started, let info = paradisWindowInfos(pid: pid).first(where: { $0.windowId == windowId }), info.onScreen, info.bounds == bounds, !paradisAppIsHidden(pid) else {
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

/** 操作中の解放と復元を一度だけ行い、終了処理の後には送信しない。 */
private final class ParadisBackgroundTransaction {
	private let lock = NSRecursiveLock()
	private let transport: ParadisBackgroundTransport
	private let pid: Int32
	private let windowId: UInt32
	private let started: Double
	private let bounds: CGRect
	private let originalPid: Int32
	private let originalWindow: UInt32
	private let originalStarted: Double
	private let previousPSN: [UInt32]
	private let targetPSN: [UInt32]
	private var pending: (CGEvent, CGPoint?, Int64)?
	private var borrowed = false
	private var closed = false
	private(set) var restored = false

	init(transport: ParadisBackgroundTransport, pid: Int32, windowId: UInt32, started: Double, bounds: CGRect, originalPid: Int32, originalWindow: UInt32, originalStarted: Double, previousPSN: [UInt32], targetPSN: [UInt32]) {
		self.transport = transport
		self.pid = pid
		self.windowId = windowId
		self.started = started
		self.bounds = bounds
		self.originalPid = originalPid
		self.originalWindow = originalWindow
		self.originalStarted = originalStarted
		self.previousPSN = previousPSN
		self.targetPSN = targetPSN
	}

	func begin() throws {
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		guard frontmost == originalPid, !ParadisBackgroundConnection.disconnected else { throw stopped() }
		lock.lock()
		defer { lock.unlock() }
		guard !closed, paradisProcessStart(originalPid) == originalStarted, paradisProcessStart(pid) == started else { throw stopped() }
		if pid == originalPid { return }
		borrowed = true
		guard transport.focus(previousPSN, windowId: originalWindow, focused: false), transport.focus(targetPSN, windowId: windowId, focused: true) else { throw stopped() }
	}

	func send(_ event: CGEvent, point: CGPoint?, group: Int64, release: CGEvent? = nil) throws {
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		guard frontmost == originalPid, !ParadisBackgroundConnection.disconnected else { throw stopped() }
		lock.lock()
		defer { lock.unlock() }
		guard !closed, paradisProcessStart(pid) == started else { throw stopped() }
		// CGEvent.location は画面座標、CGEventSetWindowLocation はウィンドウ左上からの座標。
		// macOS 27.0.1 の受信側 NSEvent で確認。解放も同じ相対座標を保持する。
		let localPoint = point.map { CGPoint(x: $0.x - bounds.minX, y: $0.y - bounds.minY) }
		if let release { pending = (release, localPoint, group) }
		transport.send(event, pid: pid, windowId: windowId, point: localPoint, group: group)
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
		// main キューへの問い合わせを lock の外で済ませ、SIGTERM の cleanup と待ち合わない。
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		lock.lock()
		defer { lock.unlock() }
		guard !closed else { return }
		closed = true
		release()
		guard borrowed else { restored = true; return }
		if paradisProcessStart(pid) == started, let menu = paradisOpenMenu(pid: pid) {
			AXUIElementPerformAction(menu, kAXCancelAction as CFString)
		}
		// 利用者が別アプリへ移った場合は、元のアプリへ引き戻さない。
		let system = AXUIElementCreateSystemWide()
		AXUIElementSetMessagingTimeout(system, 0.3)
		guard frontmost == originalPid || frontmost == pid,
			paradisProcessStart(originalPid) == originalStarted,
			paradisWindowInfos(pid: originalPid).contains(where: { $0.windowId == originalWindow && $0.onScreen }) else { return }
		if let focused = paradisElement(system, kAXFocusedApplicationAttribute) {
			var current: Int32 = 0
			guard AXUIElementGetPid(focused, &current) == .success, current == originalPid || current == pid else { return }
			if current == originalPid, let currentWindow = paradisElement(focused, kAXFocusedWindowAttribute).flatMap(paradisBackgroundWindowId), currentWindow != originalWindow { return }
		}
		let targetReleased = paradisProcessStart(pid) != started || transport.focus(targetPSN, windowId: windowId, focused: false)
		let originalRestored = transport.focus(previousPSN, windowId: originalWindow, focused: true)
		restored = targetReleased && originalRestored
	}

	private func stopped() -> ParadisHelperError { ParadisHelperError(code: "input_failed", message: "background transaction stopped") }
}
