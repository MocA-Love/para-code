/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 操作の命令の実体（前面に出す・クリック・ドラッグ・スクロール・文字入力・貼り付け・キー）。設計書 6.3。
//
//  - どの命令も、アクセシビリティの許可が無ければ OS に触れる前に断る
//  - 送る直前と各イベントの間に確かめる（フェンス）:
//    - 利用者の物理的な入力が直前 1 秒以内にあれば止める（Q101）。見張りはイベントタップで、補助アプリが送る
//      イベントには目印（eventSourceUserData）を付けて区別する。長い操作の途中でも止まる（レビュー M2）
//    - 前面のアプリが目的の pid か。マウスは的の点の一番手前のウィンドウ（透明なものも含む）の持ち主、
//      キーは OS に聞いたフォーカスのあるアプリと一番手前の通常のウィンドウの持ち主も見る
//    - 認証・同意のダイアログが出ていれば止める。キーは、目的のウィンドウに重なるほかのプロセスのパネルがあっても止める（レビュー M3）
//  - 修飾キーはイベントのフラグで付け、修飾キーそのものの押下は送らない。押したボタンとキーは、止めるときも必ず離す
//  - クリックとキーは HID のタップへ送る（`postToPid` では AppKit に届かないアプリがあるため。Orca と同じ）。
//    スクロールだけは目的のプロセスへ直接送る
//  - 貼り付け（Q100、レビュー M6）: クリップボードを退避し、空にしてから文字を入れて ⌘V を送る。貼り付け先の値に
//    文字が入ったのを確かめてから戻す。確かめられなければ 3 秒待ってから戻す。戻す前にほかが書き換えていたら
//    （変更回数で判断）戻さない。退避した中身がパスワードマネージャーの印（Concealed / Transient）付きなら、戻さずに空のままにする

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/** 貼り付けた文字が貼り付け先に入ったかを確かめる時間と、確かめられないときに戻すまで待つ時間。 */
private let paradisPasteVerifySeconds: TimeInterval = 1.5
private let paradisPasteUnverifiedDelaySeconds: TimeInterval = 3.0
/** パスワードマネージャーが「履歴に残さない」ために付ける型（nspasteboard.org の約束）。 */
private let paradisConcealedPasteboardTypes: Set<String> = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"]

extension ParadisDesktop {

	// MARK: - 前面に出す

	func activateApp(pid: Int32, windowId: UInt32?) throws -> [String: Any] {
		try requireInputPermission()
		if let failure = userActivityFailure() ?? paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows(), targetBounds: nil) {
			throw failure
		}
		try requireRunningApp(pid)
		paradisOnMain {
			_ = NSRunningApplication(processIdentifier: pid)?.unhide()
		}
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 1.0)
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
		try pointerFence(pid: pid, point: point)
		try post(paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []))
		usleep(40_000)
		let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = button == .left
			? (.leftMouseDown, .leftMouseUp, .left)
			: (.rightMouseDown, .rightMouseUp, .right)
		let flags = paradisEventFlags(modifiers)
		for click in 1...clickCount {
			try pointerFence(pid: pid, point: point)
			let down = paradisMouseEvent(downType, at: point, button: cgButton, flags: flags)
			down?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
			try post(down)
			usleep(25_000)
			// 押したボタンは、確かめに失敗しても必ず離す
			let failure = pointerFenceFailure(pid: pid, point: point)
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
		try pointerFence(pid: pid, point: start)
		try post(paradisMouseEvent(.mouseMoved, at: start, button: .left, flags: []))
		usleep(40_000)
		try pointerFence(pid: pid, point: start)
		try post(paradisMouseEvent(.leftMouseDown, at: start, button: .left, flags: []))
		var current = start
		// 途中で止めても、イベントを作れずに抜けても、押したボタンは必ず離す（レビュー L7）
		defer {
			usleep(30_000)
			try? post(paradisMouseEvent(.leftMouseUp, at: current, button: .left, flags: []))
		}
		for step in paradisDragPath(from: (Double(start.x), Double(start.y)), to: (Double(end.x), Double(end.y)), steps: 12) {
			usleep(16_000)
			let point = CGPoint(x: step.x, y: step.y)
			if let failure = pointerFenceFailure(pid: pid, point: point) {
				let reached = paradisWindowPointJson(current, window)
				throw ParadisHelperError(code: failure.code, message: "\(failure.message); the drag stopped at x=\(reached["x"] ?? 0), y=\(reached["y"] ?? 0) and the button was released")
			}
			try post(paradisMouseEvent(.leftMouseDragged, at: point, button: .left, flags: []))
			current = point
		}
		return ["dragged": true, "from": paradisWindowPointJson(start, window), "to": paradisWindowPointJson(end, window)]
	}

	func scroll(pid: Int32, windowId: UInt32, target: ParadisPointerTarget?, direction: ParadisScrollDirection, pages: Double) throws -> [String: Any] {
		try requireInputPermission()
		let window = try windowInfo(pid: pid, windowId: windowId)
		let point = try target.map { try resolvePoint(pid: pid, windowId: windowId, target: $0).0 } ?? CGPoint(x: window.bounds.midX, y: window.bounds.midY)
		try pointerFence(pid: pid, point: point)
		try post(paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []))
		usleep(30_000)
		let extent = direction == .up || direction == .down ? Double(window.bounds.height) : Double(window.bounds.width)
		for step in paradisScrollSteps(direction: direction, pages: pages, extent: extent) {
			try pointerFence(pid: pid, point: point)
			guard let event = CGEvent(scrollWheelEvent2Source: paradisEventSource(), units: .pixel, wheelCount: 2, wheel1: step.dy, wheel2: step.dx, wheel3: 0) else {
				throw ParadisHelperError(code: "input_failed", message: "the scroll event could not be created")
			}
			event.location = point
			event.setIntegerValueField(.eventSourceUserData, value: paradisSyntheticEventMarker)
			event.postToPid(pid)
			usleep(16_000)
		}
		return ["scrolled": true, "point": paradisWindowPointJson(point, window.bounds)]
	}

	// MARK: - キーボード

	func typeText(pid: Int32, units: [ParadisTypedUnit]) throws -> [String: Any] {
		try requireInputPermission()
		for (typed, unit) in units.enumerated() {
			do {
				try keyFence(pid: pid)
			} catch let failure as ParadisHelperError {
				throw ParadisHelperError(code: failure.code, message: "\(failure.message); stopped after typing \(typed) of \(units.count) characters")
			}
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
		try sendChord(pid: pid, chord: chord, allowPaste: false)
		return ["pressed": true]
	}

	func pasteText(pid: Int32, text: String) throws -> [String: Any] {
		try requireInputPermission()
		// クリップボードに触る前に確かめる（送れないなら書き換えもしない）
		try keyFence(pid: pid)
		let pasteboard = NSPasteboard.general
		let saved = paradisOnMain { paradisSavePasteboard(pasteboard) }
		let before = paradisFocusedValue(pid: pid)
		let ourChangeCount = paradisOnMain { () -> Int in
			pasteboard.clearContents()
			pasteboard.setString(text, forType: .string)
			return pasteboard.changeCount
		}
		var pasteFailure: Error?
		var verified = false
		let pastedAt = Date()
		do {
			try sendChord(pid: pid, chord: ParadisKeyChord(keyCode: paradisKeyCodeV, modifiers: .command), allowPaste: true)
			// 貼り付け先の値に文字が入るのを待つ。確かめられないとき（値を読めない欄など）は長めに待ってから戻す
			while Date().timeIntervalSince(pastedAt) < paradisPasteVerifySeconds {
				usleep(100_000)
				if paradisPasteLanded(before: before, after: paradisFocusedValue(pid: pid), text: text) {
					verified = true
					break
				}
			}
			if !verified {
				let remaining = paradisPasteUnverifiedDelaySeconds - Date().timeIntervalSince(pastedAt)
				if remaining > 0 {
					usleep(UInt32(remaining * 1_000_000))
				}
			}
		} catch {
			pasteFailure = error
		}
		let plan = paradisOnMain { () -> ParadisClipboardPlan in
			let plan = paradisClipboardRestorePlan(changeCountAfterOurWrite: ourChangeCount, currentChangeCount: pasteboard.changeCount, savedIsConcealed: saved.concealed, savedIsComplete: saved.complete)
			switch plan {
			case .restore, .restorePartial:
				paradisRestorePasteboard(pasteboard, saved.items)
			case .clear:
				pasteboard.clearContents()
			case .keepOthers:
				break
			}
			return plan
		}
		if let pasteFailure {
			throw pasteFailure
		}
		return ["pasted": true, "pasteVerified": verified, "clipboardRestored": plan == .restore, "clipboard": plan.rawValue]
	}

	private func sendChord(pid: Int32, chord: ParadisKeyChord, allowPaste: Bool) throws {
		// 送らない組み合わせは要求の振り分けで断っているが、ここでももう一度見る
		if let reason = paradisBlockedChordReason(chord, allowPaste: allowPaste) {
			throw ParadisHelperError(code: "key_blocked", message: reason)
		}
		let flags = paradisEventFlags(chord.modifiers)
		try keyFence(pid: pid)
		let down = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: chord.keyCode, keyDown: true)
		down?.flags = flags
		try post(down)
		usleep(20_000)
		// 押したキーは、確かめに失敗しても必ず離す
		let failure = keyFenceFailure(pid: pid)
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
		inputMonitor.ensureStarted()
	}

	private func userActivityFailure() -> ParadisHelperError? {
		if paradisUserIsActive(secondsSincePhysicalInput: inputMonitor.secondsSincePhysicalInput()) {
			return ParadisHelperError(code: "user_active", message: "the user is using the keyboard or mouse")
		}
		return nil
	}

	private func pointerFence(pid: Int32, point: CGPoint) throws {
		if let failure = pointerFenceFailure(pid: pid, point: point) {
			throw failure
		}
	}

	private func pointerFenceFailure(pid: Int32, point: CGPoint) -> ParadisHelperError? {
		if let failure = userActivityFailure() {
			return failure
		}
		let windows = paradisScreenWindows()
		if let failure = paradisOverlayFailure(targetPid: pid, windows: windows, targetBounds: nil) {
			return failure
		}
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		// 透明なウィンドウもクリックを受けうるので、点を覆うものは全部持ち主の候補にする（レビュー L8）
		let owner = windows.first(where: { $0.layer >= 0 && $0.bounds.contains(point) })?.pid
		return paradisFenceFailure(targetPid: pid, frontmostPid: frontmost, ownerAtTarget: owner)
	}

	private func keyFence(pid: Int32) throws {
		if let failure = keyFenceFailure(pid: pid) {
			throw failure
		}
	}

	private func keyFenceFailure(pid: Int32) -> ParadisHelperError? {
		if let failure = userActivityFailure() {
			return failure
		}
		let windows = paradisScreenWindows()
		let targetBounds = windows.first(where: { $0.pid == pid && $0.layer == 0 })?.bounds
		if let failure = paradisOverlayFailure(targetPid: pid, windows: windows, targetBounds: targetBounds ?? .null) {
			return failure
		}
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		if let failure = paradisFenceFailure(targetPid: pid, frontmostPid: frontmost, ownerAtTarget: windows.first(where: { $0.layer == 0 })?.pid) {
			return failure
		}
		// キーの行き先は OS に直接聞く（NSWorkspace の値は通知で更新されるので遅れうる）
		return paradisFocusFailure(targetPid: pid, focusedPid: paradisFocusedApplicationPid())
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
		case .element(let index, let snapshotId):
			guard let snapshot = lastSnapshot, snapshot.id == snapshotId, snapshot.pid == pid, snapshot.windowId == windowId, index < snapshot.elements.count,
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
		event.setIntegerValueField(.eventSourceUserData, value: paradisSyntheticEventMarker)
		event.post(tap: .cghidEventTap)
	}
}

// MARK: - 利用者の入力の見張り（Q101、レビュー M2）

/**
 * 目印の無いキー・マウスのイベントを見て、最後の物理的な入力の時刻を覚える。セッションのイベントタップ
 * （聞くだけ）を main の run loop に置く。作れなかったときは OS のハードウェアの入力の数で代える
 * （自分の合成入力も数えうるので、止まる側に倒れる）。
 */
final class ParadisInputMonitor {
	private let lock = NSLock()
	private var lastPhysicalInput: Date?
	private var tap: CFMachPort?

	/** 見張りを始める（アクセシビリティの許可の後に呼ぶ）。 */
	func ensureStarted() {
		lock.lock()
		let running = tap != nil
		lock.unlock()
		if running {
			return
		}
		let created: CFMachPort? = paradisOnMain {
			let userInfo = Unmanaged.passUnretained(self).toOpaque()
			let mask = paradisWatchedEventTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
			let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: paradisInputTapCallback, userInfo: userInfo)
			guard let port else {
				return nil
			}
			let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
			CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
			CGEvent.tapEnable(tap: port, enable: true)
			return port
		}
		lock.lock()
		tap = created
		lock.unlock()
		if created == nil {
			fputs("[paradis-computer-use] input monitor unavailable; using the HID idle time\n", stderr)
		}
	}

	func record() {
		lock.lock()
		lastPhysicalInput = Date()
		lock.unlock()
	}

	func reenable() {
		lock.lock()
		let port = tap
		lock.unlock()
		if let port {
			CGEvent.tapEnable(tap: port, enable: true)
		}
	}

	/** 最後の物理的な入力からの秒数。まだ無ければ nil。 */
	func secondsSincePhysicalInput() -> Double? {
		lock.lock()
		let running = tap != nil
		let last = lastPhysicalInput
		lock.unlock()
		if running {
			return last.map { Date().timeIntervalSince($0) }
		}
		return paradisWatchedEventTypes.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
	}
}

private let paradisWatchedEventTypes: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel]

private let paradisInputTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
	guard let userInfo else {
		return Unmanaged.passUnretained(event)
	}
	let monitor = Unmanaged<ParadisInputMonitor>.fromOpaque(userInfo).takeUnretainedValue()
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
		monitor.reenable()
	} else if !paradisIsOurEvent(userData: event.getIntegerValueField(.eventSourceUserData)) {
		monitor.record()
	}
	return Unmanaged.passUnretained(event)
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

/** 画面に出ているウィンドウを手前から順に（持ち主の bundle id 付き）。 */
private func paradisScreenWindows() -> [ParadisScreenWindow] {
	let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
	let owners = Set(list.compactMap { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value })
	let bundleIds: [Int32: String] = paradisOnMain {
		var result: [Int32: String] = [:]
		for pid in owners {
			if let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier {
				result[pid] = id
			}
		}
		return result
	}
	return list.compactMap { entry in
		guard let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue,
			let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
		else {
			return nil
		}
		return ParadisScreenWindow(pid: pid, ownerName: entry[kCGWindowOwnerName as String] as? String ?? "", bundleId: bundleIds[pid], layer: layer, bounds: bounds)
	}
}

/** OS に聞いた、キーボードのフォーカスのあるアプリの pid。 */
private func paradisFocusedApplicationPid() -> Int32? {
	guard let application = paradisElement(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute) else {
		return nil
	}
	var pid: pid_t = 0
	return AXUIElementGetPid(application, &pid) == .success ? pid : nil
}

/** 目的のアプリのフォーカスのある要素の値（貼り付けが入ったかを見るため）。読めなければ nil。 */
private func paradisFocusedValue(pid: Int32) -> String? {
	let application = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(application, 0.5)
	guard let element = paradisElement(application, kAXFocusedUIElementAttribute) else {
		return nil
	}
	return paradisCopy(element, kAXValueAttribute) as? String
}

private func paradisWindowPointJson(_ point: CGPoint, _ window: CGRect) -> [String: Double] {
	return ["x": Double(point.x - window.minX), "y": Double(point.y - window.minY)]
}

/** 退避したクリップボード。 */
private struct ParadisSavedPasteboard {
	let items: [[(NSPasteboard.PasteboardType, Data)]]
	/** パスワードマネージャーの印が付いていた。 */
	let concealed: Bool
	/** 全部の型を写せた（ファイルの約束など、写せない型があれば false）。 */
	let complete: Bool
}

private func paradisSavePasteboard(_ pasteboard: NSPasteboard) -> ParadisSavedPasteboard {
	var concealed = false
	var complete = true
	let items = (pasteboard.pasteboardItems ?? []).map { item -> [(NSPasteboard.PasteboardType, Data)] in
		item.types.compactMap { type in
			if paradisConcealedPasteboardTypes.contains(type.rawValue) {
				concealed = true
			}
			guard let data = item.data(forType: type) else {
				complete = false
				return nil
			}
			return (type, data)
		}
	}
	return ParadisSavedPasteboard(items: items, concealed: concealed, complete: complete)
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
