/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 操作の命令の実体（前面に出す・クリック・ドラッグ・スクロール・文字入力・貼り付け・キー）。設計書 6.3。
//
// `perform` が送り方の段（Core の ParadisInputRoute.swift、実体は ParadisInputRoutes.swift）を順に試す。このファイルの
// foreground* は 3 段目（前面に出して実カーソルとキーボードで送る）で、下の確かめはこの段のもの。1 段目（AX）の確かめは
// ParadisInputRoutes.swift にある。
//
//  - どの命令も、アクセシビリティの許可が無ければ OS に触れる前に断る
//  - 送る直前と各イベントの間に確かめる（フェンス）:
//    - 利用者の物理的な入力が直前 1 秒以内にあれば止める（Q101）。見張りはイベントタップで、補助アプリが送る
//      イベントには目印（eventSourceUserData）を付けて区別する。長い操作の途中でも止まる（レビュー M2）
//    - 前面のアプリが目的の pid か。マウスは、的の点でクリックを受ける要素（AX の当たり判定）と、点を覆う一番手前の
//      ウィンドウ（Dock と WindowServer の画面全体の層は除く。レビュー N3）の持ち主が目的の pid か。キーは、OS に聞いた
//      フォーカスのあるアプリと要素の持ち主が目的の pid か（重なるだけのパネルでは止めない。レビュー N4）
//    - 認証・同意のダイアログが出ていれば止める（レビュー M3）
//    - 長い入力では、利用者の入力は毎回、画面とフォーカスは 10 文字か 50 ms ごとに確かめる（レビュー N5）
//  - 修飾キーはイベントのフラグで付け、修飾キーそのものの押下は送らない。押したボタンとキーは、止めるときも必ず離す
//  - クリックとキーは HID のタップへ送る（`postToPid` では AppKit に届かないアプリがあるため。Orca と同じ）。
//    スクロールだけは目的のプロセスへ直接送る
//  - 貼り付け（Q100、レビュー M6）: クリップボードを退避し、空にしてから文字を入れて ⌘V を送る。貼り付け先の値に
//    文字が入ったのを確かめてから戻す。確かめられなければ 3 秒待ってから戻す。戻す前にほかが書き換えていたら
//    （変更回数で判断）戻さない。退避した中身がパスワードマネージャーの印（Concealed / Transient）付きなら、戻さずに空のままにする

import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

/** 貼り付けた文字が貼り付け先に入ったかを確かめる時間と、確かめられないときに戻すまで待つ時間。 */
private let paradisPasteVerifySeconds: TimeInterval = 1.5
private let paradisPasteUnverifiedDelaySeconds: TimeInterval = 3.0
/** パスワードマネージャーが「履歴に残さない」ために付ける型（nspasteboard.org の約束）。 */
private let paradisConcealedPasteboardTypes: Set<String> = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"]

extension ParadisDesktop {

	// MARK: - 段の振り分け

	/**
	 * 入力を送る。1 段目（AX）・2 段目（背面。今は空）・3 段目（前面。下の foreground* ）の順に試す（ParadisInputRoute.swift）。
	 * 独自のカーソルを出さない要求（設定でオフ）が来たら、出ているカーソルを消す。
	 */
	func perform(pid: Int32, action: ParadisInputAction, options: ParadisInputOptions) throws -> [String: Any] {
		try requireInputPermission()
		if options.cursor == nil {
			ParadisCursorOverlay.shared.hideAll()
		}
		paradisManualAccessibility.touch(pid)
		let routes: [ParadisInputRoute] = [ParadisAccessibilityRoute(desktop: self), backgroundRoute, ParadisForegroundRoute(desktop: self)]
		return try paradisRouteInput(action, pid: pid, routes: routes, options: options)
	}

	// MARK: - 前面に出す（3 段目）

	func foregroundActivate(pid: Int32, windowId: UInt32?) throws -> [String: Any] {
		try requireInputPermission()
		if let failure = paradisCurrentSessionFailure() ?? userActivityFailure() ?? paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows()) {
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

	func foregroundClick(pid: Int32, windowId: UInt32, target: ParadisPointerTarget, button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers, cursor: ParadisCursorOwnerSpec?) throws -> [String: Any] {
		try requireInputPermission()
		let (point, window) = try resolvePoint(pid: pid, windowId: windowId, target: target)
		try pointerFence(pid: pid, point: point)
		// メニューの「ペースト」は、⌘V と同じく利用者のクリップボードを貼るので押さない（レビュー N11）
		if paradisPasteMenuItemAt(point) {
			throw ParadisHelperError(code: "key_blocked", message: "Paste menu items are never clicked; use pasteText")
		}
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
			paradisPressedInput.pressMouse(upType: upType, point: point, button: cgButton)
			usleep(25_000)
			// 押したボタンは、確かめに失敗しても必ず離す
			let failure = pointerFenceFailure(pid: pid, point: point)
			let up = paradisMouseEvent(upType, at: point, button: cgButton, flags: flags)
			up?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
			try post(up)
			paradisPressedInput.releaseMouse()
			if let failure {
				throw failure
			}
			// 実カーソルが動くので、独自のカーソルは名前の札と波紋だけをそこに合わせる
			if let cursor {
				ParadisCursorOverlay.shared.followPointer(cursor, at: point, click: true)
			}
			usleep(60_000)
		}
		return ["clicked": true, "point": paradisWindowPointJson(point, window)]
	}

	func foregroundDrag(pid: Int32, windowId: UInt32, from: ParadisPointerTarget, to: ParadisPointerTarget, cursor: ParadisCursorOwnerSpec?) throws -> [String: Any] {
		try requireInputPermission()
		let (start, window) = try resolvePoint(pid: pid, windowId: windowId, target: from)
		let (end, _) = try resolvePoint(pid: pid, windowId: windowId, target: to)
		try pointerFence(pid: pid, point: start)
		try post(paradisMouseEvent(.mouseMoved, at: start, button: .left, flags: []))
		usleep(40_000)
		try pointerFence(pid: pid, point: start)
		try post(paradisMouseEvent(.leftMouseDown, at: start, button: .left, flags: []))
		paradisPressedInput.pressMouse(upType: .leftMouseUp, point: start, button: .left)
		var current = start
		// 途中で止めても、イベントを作れずに抜けても、押したボタンは必ず離す（レビュー L7）
		defer {
			usleep(30_000)
			try? post(paradisMouseEvent(.leftMouseUp, at: current, button: .left, flags: []))
			paradisPressedInput.releaseMouse()
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
			paradisPressedInput.pressMouse(upType: .leftMouseUp, point: point, button: .left)
			if let cursor {
				ParadisCursorOverlay.shared.followPointer(cursor, at: point, click: false)
			}
		}
		return ["dragged": true, "from": paradisWindowPointJson(start, window), "to": paradisWindowPointJson(end, window)]
	}

	func foregroundScroll(pid: Int32, windowId: UInt32, target: ParadisPointerTarget?, direction: ParadisScrollDirection, pages: Double, cursor: ParadisCursorOwnerSpec?) throws -> [String: Any] {
		try requireInputPermission()
		let window = try windowInfo(pid: pid, windowId: windowId)
		let point = try target.map { try resolvePoint(pid: pid, windowId: windowId, target: $0).0 } ?? CGPoint(x: window.bounds.midX, y: window.bounds.midY)
		try pointerFence(pid: pid, point: point)
		try post(paradisMouseEvent(.mouseMoved, at: point, button: .left, flags: []))
		if let cursor {
			ParadisCursorOverlay.shared.followPointer(cursor, at: point, click: false)
		}
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

	/**
	 * 文字を入れる（ベータの実機で、1 文字ずつのキーでは約 2 割の文字と空白が落ち、それでも全部入ったと返していた）。
	 *  1. フォーカスのある欄が選択範囲の置き換え（`AXSelectedText`）を受け付けるなら、AX で入れる。キーも IME も通らない。
	 *     書き込みが起きていないと言い切れる失敗のときだけ次の経路へ落ちる。それ以外は最長 1 秒読み直し、変わらなければ
	 *     「確かめられない」で止める（遅れて入る・非同期に反映するアプリで二重に入れないため。ベータ 3 のレビュー H1）
	 *  2. 入力ソースが IME のとき、または改行を含むときは貼り付け（改行はどの経路でも改行の文字で、Return は押さない）
	 *  3. それ以外はキーを送る。1 つのイベントの元を使い回し、押すと離すの間と文字の間に間を置く
	 * どの経路でも、入れる前にフォーカスのあった同じ要素を読み戻して、入ったかを返す（読めなければ確かめられない）。
	 */
	func foregroundTypeText(pid: Int32, text: String, units: [ParadisTypedUnit]) throws -> [String: Any] {
		try requireInputPermission()
		try keyFence(pid: pid)
		let normalized = paradisNormalizeTypedText(text)
		if case .finished(let check) = paradisInsertViaAccessibility(pid: pid, text: normalized) {
			return paradisTypeResult(method: .accessibility, check: check, count: units.count)
		}
		if normalized.contains("\n") || paradisOnMain({ paradisInputMethodIsActive() }) {
			let (pasted, check) = try pasteAndCheck(pid: pid, text: normalized)
			var result = paradisTypeResult(method: .paste, check: check, count: units.count)
			result["clipboard"] = pasted.rawValue
			result["clipboardRestored"] = pasted == .restore
			return result
		}
		let target = paradisFocusedTextTarget(pid: pid)
		var lastFullFence: Date?
		for (typed, unit) in units.enumerated() {
			let full = paradisNeedsFullFence(unitIndex: typed, secondsSinceLastFullFence: lastFullFence.map { Date().timeIntervalSince($0) })
			if let failure = keyFenceFailure(pid: pid, full: full) {
				throw ParadisHelperError(code: failure.code, message: "\(failure.message); stopped after typing \(typed) of \(units.count) characters", progress: typed)
			}
			if full {
				lastFullFence = Date()
			}
			if case .text(let character) = unit {
				let utf16 = Array(character.utf16)
				try postKey(virtualKey: 0) { event in
					event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
				}
			}
			usleep(paradisInterCharacterMicroseconds)
		}
		usleep(80_000)
		// 入れる前にフォーカスのあった同じ要素を読み戻す（その時点のフォーカスではなく）
		let after = target.element.flatMap { paradisCopy($0, kAXValueAttribute) as? String }
		return paradisTypeResult(method: .keys, check: paradisTypingOutcome(before: target.value, selection: target.selection, after: after, text: normalized), count: units.count)
	}

	/** 1 つのキーを押して離す。押すと離すの間に間を置く（間が無いと落とすアプリがある）。 */
	private func postKey(virtualKey: UInt16, configure: (CGEvent) -> Void) throws {
		for keyDown in [true, false] {
			let event = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: virtualKey, keyDown: keyDown)
			event?.flags = []
			if let event {
				configure(event)
			}
			try post(event)
			if keyDown {
				usleep(paradisKeyHoldMicroseconds)
			}
		}
	}

	func foregroundPressChord(pid: Int32, chord: ParadisKeyChord) throws -> [String: Any] {
		try requireInputPermission()
		try sendChord(pid: pid, chord: chord, allowPaste: false)
		return ["pressed": true]
	}

	func foregroundPasteText(pid: Int32, text: String) throws -> [String: Any] {
		try requireInputPermission()
		let (plan, check) = try pasteAndCheck(pid: pid, text: paradisNormalizeTypedText(text))
		var result: [String: Any] = ["pasted": true, "pasteVerified": check.verified.map { $0 as Any } ?? NSNull(), "clipboardRestored": plan == .restore, "clipboard": plan.rawValue]
		if check.rewritten {
			result["rewritten"] = true
		}
		return result
	}

	/**
	 * クリップボードに文字を入れて ⌘V を送り、クリップボードを戻す（Q100、レビュー M6）。入れる前にフォーカスのあった
	 * 同じ要素を読み戻して、入ったかを確かめる（ベータ 3 のレビュー L1）。確かめられないときは長めに待ってから戻す。
	 */
	private func pasteAndCheck(pid: Int32, text: String) throws -> (ParadisClipboardPlan, ParadisTypingCheck) {
		// クリップボードに触る前に確かめる（送れないなら書き換えもしない）
		try keyFence(pid: pid)
		let pasteboard = NSPasteboard.general
		let saved = paradisOnMain { paradisSavePasteboard(pasteboard) }
		let target = paradisFocusedTextTarget(pid: pid)
		let ourChangeCount = paradisOnMain { () -> Int in
			pasteboard.clearContents()
			// クリップボードの履歴を取るアプリに、エージェントの貼る文字を残させない（レビュー N10）
			let item = NSPasteboardItem()
			item.setString(text, forType: .string)
			for marker in paradisConcealedPasteboardTypes {
				item.setData(Data(), forType: NSPasteboard.PasteboardType(marker))
			}
			pasteboard.writeObjects([item])
			return pasteboard.changeCount
		}
		var pasteFailure: Error?
		var check = ParadisTypingCheck(verified: nil, inserted: nil)
		let pastedAt = Date()
		do {
			try sendChord(pid: pid, chord: ParadisKeyChord(keyCode: paradisKeyCodeV, modifiers: .command), allowPaste: true)
			// 貼り付け先の値が変わるのを待つ。確かめられないとき（値を読めない欄など）は長めに待ってから戻す
			while Date().timeIntervalSince(pastedAt) < paradisPasteVerifySeconds {
				usleep(100_000)
				let after = target.element.flatMap { paradisCopy($0, kAXValueAttribute) as? String }
				check = paradisTypingOutcome(before: target.value, selection: target.selection, after: after, text: text)
				if check.verified != nil {
					break
				}
			}
			if check.verified == nil {
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
		return (plan, check)
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
		paradisPressedInput.pressKey(chord.keyCode, flags: flags)
		usleep(20_000)
		// 押したキーは、確かめに失敗しても必ず離す
		let failure = keyFenceFailure(pid: pid, full: true)
		let up = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: chord.keyCode, keyDown: false)
		up?.flags = flags
		try post(up)
		paradisPressedInput.releaseKey()
		if let failure {
			throw failure
		}
	}

	// MARK: - 確かめ

	func requireInputPermission() throws {
		guard AXIsProcessTrusted() else {
			throw ParadisHelperError(code: "accessibility_not_granted", message: "Accessibility permission is not granted to Para Code Computer Use")
		}
		inputMonitor.ensureStarted()
	}

	func userActivityFailure() -> ParadisHelperError? {
		if paradisUserIsActive(secondsSincePhysicalInput: inputMonitor.secondsSincePhysicalInput()) {
			return ParadisHelperError(code: "user_active", message: "the user is using the keyboard or mouse")
		}
		return nil
	}

	/**
	 * 承認の直後の送り直し（`activateFirst`）: 利用者の物理的な入力が止むのを最長 3 秒待ってから、目的のアプリを前面に出す。
	 * 承認ダイアログのボタンを押した直後は Para Code が前面で、そのクリックが直前 1 秒の入力に入るため。
	 * 待っても止まなければ `user_active` で止める（前面には出さない）。
	 */
	func prepareForeground(pid: Int32, windowId: UInt32?) throws {
		let deadline = Date().addingTimeInterval(paradisActivateFirstWaitSeconds)
		while let failure = userActivityFailure() {
			if Date() >= deadline {
				throw failure
			}
			usleep(100_000)
		}
		_ = try foregroundActivate(pid: pid, windowId: windowId)
		// 前面になったと OS が知らせるまで少し待つ（前面でなければ、続く確かめが window_not_focused で止める）
		let shown = Date().addingTimeInterval(1.0)
		while paradisOnMain({ NSWorkspace.shared.frontmostApplication?.processIdentifier }) != pid && Date() < shown {
			usleep(50_000)
		}
	}

	/** 利用者が打鍵中か（1 段目の確かめ。マウスの動きでは止めない）。 */
	func keyboardActivityFailure() -> ParadisHelperError? {
		if paradisUserIsActive(secondsSincePhysicalInput: inputMonitor.secondsSincePhysicalKeyboardInput()) {
			return ParadisHelperError(code: "user_active", message: "the user is typing")
		}
		return nil
	}

	private func pointerFence(pid: Int32, point: CGPoint) throws {
		if let failure = pointerFenceFailure(pid: pid, point: point) {
			throw failure
		}
	}

	private func pointerFenceFailure(pid: Int32, point: CGPoint) -> ParadisHelperError? {
		if let failure = paradisCurrentSessionFailure() ?? userActivityFailure() {
			return failure
		}
		let windows = paradisScreenWindows()
		if let failure = paradisOverlayFailure(targetPid: pid, windows: windows) {
			return failure
		}
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		// 点を覆う一番手前のウィンドウ。透明なものも含める（レビュー L8）が、Dock と WindowServer の層は除く。
		// macOS 27 の Dock は画面全体を覆う layer 20 のウィンドウを出し、共有の状態も alpha も普通のウィンドウと
		// 変わらないので、ウィンドウの属性では入力を受けるか見分けられない（レビュー N3）。その分は AX の当たり判定で見る
		// 補助アプリ自身のウィンドウ（独自のカーソルの、クリックが素通りするパネル）も除く
		let selfPid = getpid()
		let covering = windows.first(where: { $0.layer >= 0 && $0.bounds.contains(point) && $0.pid != selfPid && !paradisIsSystemShell($0) })?.pid
		if let failure = paradisFenceFailure(targetPid: pid, frontmostPid: frontmost, ownerAtTarget: covering) {
			return failure
		}
		// その点でクリックを受ける要素の持ち主（Dock のバーやメニューバーの常駐アプリの上ならそちらになる）
		return paradisFenceFailure(targetPid: pid, frontmostPid: frontmost, ownerAtTarget: paradisHitTestPid(point))
	}

	private func keyFence(pid: Int32) throws {
		if let failure = keyFenceFailure(pid: pid, full: true) {
			throw failure
		}
	}

	/** `full` が false なら利用者の入力だけを見る（長い文字入力で、画面とフォーカスはまとめて確かめる。レビュー N5）。 */
	private func keyFenceFailure(pid: Int32, full: Bool) -> ParadisHelperError? {
		if let failure = paradisCurrentSessionFailure() ?? userActivityFailure() {
			return failure
		}
		guard full else {
			return nil
		}
		if let failure = paradisOverlayFailure(targetPid: pid, windows: paradisScreenWindows()) {
			return failure
		}
		let frontmost = paradisOnMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
		if frontmost != pid {
			return ParadisHelperError(code: "window_not_focused", message: "the application is not in front; bring it forward with activateApp first")
		}
		// キーの行き先は OS に直接聞く（NSWorkspace の値は通知で更新されるので遅れうる）。重なるだけのパネルでは止めない（レビュー N4）
		let (applicationPid, elementPid) = paradisFocusedPids()
		return paradisFocusFailure(targetPid: pid, focusedApplicationPid: applicationPid, focusedElementPid: elementPid)
	}

	func windowInfo(pid: Int32, windowId: UInt32) throws -> ParadisWindowInfo {
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

// MARK: - 利用者の入力の見張り（Q101、レビュー M2・N6・N7）

/**
 * 目印の無いキー・マウスのイベントを見て、最後の物理的な入力の時刻を覚える。セッションのイベントタップ
 * （聞くだけ）を main の run loop に置く。キーボードとマウスを分けて覚え、`paradisPhysicalInputAge` で OS の
 * HID の数と合わせて判断する（タップにキーが届かない構成でも、利用者のキー入力を見逃さないため）。
 */
final class ParadisInputMonitor {
	private let lock = NSLock()
	private var lastKeyboard: Date?
	private var lastPointer: Date?
	private var sawKeyboard = false
	private var startedAt: Date?
	private var tap: CFMachPort?
	private var attempted = false

	/** 見張りを始める（アクセシビリティの許可が要る。無ければ何もしない）。 */
	func ensureStarted() {
		lock.lock()
		let skip = tap != nil || attempted
		attempted = attempted || AXIsProcessTrusted()
		lock.unlock()
		guard !skip, AXIsProcessTrusted() else {
			return
		}
		let created: CFMachPort? = paradisOnMain {
			let userInfo = Unmanaged.passUnretained(self).toOpaque()
			let mask = (paradisKeyboardEventTypes + paradisPointerEventTypes).reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
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
		startedAt = created == nil ? nil : Date()
		lock.unlock()
		if created == nil {
			fputs("[paradis-computer-use] input monitor unavailable; using the HID idle time\n", stderr)
		}
	}

	func record(type: CGEventType, ours: Bool) {
		let keyboard = paradisKeyboardEventTypes.contains(type)
		lock.lock()
		if keyboard {
			// 自分の送ったキーでも、届いたならキーボードのイベントがこのタップに届く構成だと分かる
			sawKeyboard = true
		}
		if !ours {
			if keyboard {
				lastKeyboard = Date()
			} else {
				lastPointer = Date()
			}
		}
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

	/** 最後の物理的なキー入力からの秒数（マウスは数えない）。まだ無ければ nil。 */
	func secondsSincePhysicalKeyboardInput() -> Double? {
		lock.lock()
		let started = startedAt
		let keyboard = lastKeyboard
		let saw = sawKeyboard
		lock.unlock()
		let now = Date()
		return paradisPhysicalKeyboardAge(
			tapKeyboard: keyboard.map { now.timeIntervalSince($0) },
			hidKeyboard: paradisKeyboardEventTypes.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min(),
			tapSawKeyboard: saw,
			secondsSinceTapStarted: started.map { now.timeIntervalSince($0) }
		)
	}

	/** 最後の物理的な入力からの秒数。まだ無ければ nil。 */
	func secondsSincePhysicalInput() -> Double? {
		lock.lock()
		let started = startedAt
		let keyboard = lastKeyboard
		let pointer = lastPointer
		let saw = sawKeyboard
		lock.unlock()
		let now = Date()
		func hid(_ types: [CGEventType]) -> Double? {
			return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min()
		}
		return paradisPhysicalInputAge(
			tapKeyboard: keyboard.map { now.timeIntervalSince($0) },
			tapPointer: pointer.map { now.timeIntervalSince($0) },
			hidKeyboard: hid(paradisKeyboardEventTypes),
			hidPointer: hid(paradisPointerEventTypes),
			tapSawKeyboard: saw,
			secondsSinceTapStarted: started.map { now.timeIntervalSince($0) }
		)
	}
}

private let paradisKeyboardEventTypes: [CGEventType] = [.keyDown, .flagsChanged]
private let paradisPointerEventTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel]

private let paradisInputTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
	guard let userInfo else {
		return Unmanaged.passUnretained(event)
	}
	let monitor = Unmanaged<ParadisInputMonitor>.fromOpaque(userInfo).takeUnretainedValue()
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
		monitor.reenable()
	} else {
		let ours = paradisIsOurEvent(userData: event.getIntegerValueField(.eventSourceUserData), sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID), selfPid: getpid())
		monitor.record(type: type, ours: ours)
	}
	return Unmanaged.passUnretained(event)
}

// MARK: - 押したままのボタンとキー（レビュー N5）

/**
 * 押して、まだ離していないボタンとキー。締め切りで SIGTERM を受けたときに離してから終わるため。
 */
final class ParadisPressedInput {
	private let lock = NSLock()
	private var mouse: (upType: CGEventType, point: CGPoint, button: CGMouseButton)?
	private var key: (code: UInt16, flags: CGEventFlags)?

	func pressMouse(upType: CGEventType, point: CGPoint, button: CGMouseButton) {
		lock.lock()
		mouse = (upType, point, button)
		lock.unlock()
	}

	func releaseMouse() {
		lock.lock()
		mouse = nil
		lock.unlock()
	}

	func pressKey(_ code: UInt16, flags: CGEventFlags) {
		lock.lock()
		key = (code, flags)
		lock.unlock()
	}

	func releaseKey() {
		lock.lock()
		key = nil
		lock.unlock()
	}

	/** 押したままのものを全部離す。 */
	func releaseAll() {
		lock.lock()
		let pendingMouse = mouse
		let pendingKey = key
		mouse = nil
		key = nil
		lock.unlock()
		if let pendingMouse, let event = paradisMouseEvent(pendingMouse.upType, at: pendingMouse.point, button: pendingMouse.button, flags: []) {
			event.setIntegerValueField(.eventSourceUserData, value: paradisSyntheticEventMarker)
			event.post(tap: .cghidEventTap)
		}
		if let pendingKey, let event = CGEvent(keyboardEventSource: paradisEventSource(), virtualKey: pendingKey.code, keyDown: false) {
			event.flags = pendingKey.flags
			event.setIntegerValueField(.eventSourceUserData, value: paradisSyntheticEventMarker)
			event.post(tap: .cghidEventTap)
		}
	}
}

let paradisPressedInput = ParadisPressedInput()

// MARK: - 小道具

/**
 * イベントの元。利用者のキーボードの修飾キーの状態を混ぜないよう、自分だけの状態で作り、全部のイベントで使い回す
 * （イベントごとに作ると、押すと離すが別々の状態から出ることになる）。
 */
private let paradisSharedEventSource = CGEventSource(stateID: .privateState)

func paradisEventSource() -> CGEventSource? {
	return paradisSharedEventSource
}

/** キーを押してから離すまでと、文字と文字の間。 */
private let paradisKeyHoldMicroseconds: UInt32 = 12_000
private let paradisInterCharacterMicroseconds: UInt32 = 20_000

/** 文字入力の結果。 */
func paradisTypeResult(method: ParadisTypeMethod, check: ParadisTypingCheck, count: Int) -> [String: Any] {
	var result: [String: Any] = ["typed": count, "method": method.rawValue, "verified": check.verified.map { $0 as Any } ?? NSNull()]
	if let inserted = check.inserted {
		result["inserted"] = inserted
	}
	if check.rewritten {
		result["rewritten"] = true
	}
	return result
}

/** 目的のアプリのフォーカスのある要素。 */
func paradisFocusedElement(pid: Int32) -> AXUIElement? {
	let application = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(application, 0.5)
	return paradisElement(application, kAXFocusedUIElementAttribute)
}

/** 入れる前にフォーカスのあった欄と、その値と選択範囲（UTF-16）。パスワード欄らしければ読まない。 */
struct ParadisTextTarget {
	let element: AXUIElement?
	let value: String?
	let selection: (location: Int, length: Int)?
}

func paradisFocusedTextTarget(pid: Int32) -> ParadisTextTarget {
	guard let element = paradisFocusedElement(pid: pid), !paradisElementLooksSecret(element) else {
		return ParadisTextTarget(element: nil, value: nil, selection: nil)
	}
	return ParadisTextTarget(element: element, value: paradisCopy(element, kAXValueAttribute) as? String, selection: paradisSelectedRange(element))
}

func paradisSelectedRange(_ element: AXUIElement) -> (location: Int, length: Int)? {
	guard let value = paradisCopy(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else {
		return nil
	}
	var range = CFRange(location: 0, length: 0)
	guard AXValueGetValue(value as! AXValue, .cfRange, &range) else {
		return nil
	}
	return (range.location, range.length)
}

func paradisElementLooksSecret(_ element: AXUIElement) -> Bool {
	return paradisIsSecureLike(
		role: paradisCopy(element, kAXRoleAttribute) as? String ?? "",
		subrole: paradisCopy(element, kAXSubroleAttribute) as? String,
		title: paradisCopy(element, kAXTitleAttribute) as? String,
		label: paradisCopy(element, kAXDescriptionAttribute) as? String,
		placeholder: paradisCopy(element, kAXPlaceholderValueAttribute) as? String
	)
}

/** AX で入れた結果。 */
enum ParadisAXInsert {
	/** 書き込みが起きていないと言い切れる。貼り付けかキーで入れてよい。 */
	case fallBack
	/** 書き込んだ（か、書き込んだかもしれない）。入れ直してはいけない。 */
	case finished(ParadisTypingCheck)
}

/**
 * フォーカスのある欄の選択範囲を、AX で文字列に置き換える（ベータ 3 のレビュー H1）。
 * 入れ直してよいのは、欄が置き換えを受け付けない・値や選択範囲を読めない（書く前にやめる）・書き込みが起きていないと
 * 言い切れる失敗のときだけ。成功・締め切り・一般の失敗のときは最長 1 秒読み直し、変わらなければ「確かめられない」。
 */
func paradisInsertViaAccessibility(pid: Int32, text: String) -> ParadisAXInsert {
	guard let element = paradisFocusedElement(pid: pid), !paradisElementLooksSecret(element) else {
		return .fallBack
	}
	var settable = DarwinBoolean(false)
	guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue,
		let before = paradisCopy(element, kAXValueAttribute) as? String, let selection = paradisSelectedRange(element)
	else {
		return .fallBack
	}
	let error = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
	if error != .success && paradisAXWriteCertainlyDidNothing(error: error.rawValue) {
		return .fallBack
	}
	let deadline = Date().addingTimeInterval(paradisAXReadbackLimitSeconds)
	var check: ParadisTypingCheck?
	var latest: String?
	repeat {
		usleep(paradisAXReadbackIntervalMicroseconds)
		latest = paradisCopy(element, kAXValueAttribute) as? String
		check = paradisAXReadbackStep(before: before, selection: selection, latest: latest, text: text)
	} while check == nil && Date() < deadline
	guard let result = check else {
		return .finished(ParadisTypingCheck(verified: nil, inserted: nil))
	}
	// 入れた文字列の直後にキャレットが無ければ直す。直せなければ、次の塊がずれて入りうるので「確かめられない」にする（レビュー L4）
	if result.verified == true, let latest {
		let caret = latest.utf16.count - (before.utf16.count - (selection.location + selection.length))
		if let now = paradisSelectedRange(element), now.location != caret || now.length != 0 {
			var range = CFRange(location: caret, length: 0)
			let moved = AXValueCreate(.cfRange, &range).map { AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, $0) == .success } ?? false
			if !moved {
				return .finished(ParadisTypingCheck(verified: nil, inserted: result.inserted, rewritten: result.rewritten))
			}
		}
	}
	return .finished(result)
}

/** 今の入力ソースが IME か（main スレッドで呼ぶ）。 */
private func paradisInputMethodIsActive() -> Bool {
	guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
		return false
	}
	func property(_ key: CFString) -> String? {
		guard let pointer = TISGetInputSourceProperty(source, key) else {
			return nil
		}
		return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
	}
	return paradisIsInputMethodActive(sourceType: property(kTISPropertyInputSourceType), sourceId: property(kTISPropertyInputSourceID))
}

func paradisMouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, flags: CGEventFlags) -> CGEvent? {
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

/** 承認の直後の送り直しで、利用者の入力が止むのを待つ上限。 */
private let paradisActivateFirstWaitSeconds: TimeInterval = 3

/**
 * 画面のロック中・ほかのユーザーへの切り替え中なら止める（公開の `CGSessionCopyCurrentDictionary` だけで見る。
 * `CGSSessionScreenIsLocked` はこの辞書のキーで、API の呼び出しは公開のもの）。
 */
func paradisCurrentSessionFailure() -> ParadisHelperError? {
	guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
		return nil
	}
	return paradisSessionFailure(onConsole: (session[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue, screenLocked: (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue)
}

/** 画面のウィンドウの一覧を使い回す時間（長い入力で毎回引き直さない。レビュー N5）。 */
private let paradisScreenWindowCacheSeconds: TimeInterval = 0.05
private var paradisScreenWindowCache: (at: Date, windows: [ParadisScreenWindow])?

/** 画面に出ているウィンドウを手前から順に（持ち主の bundle id 付き）。 */
func paradisScreenWindows() -> [ParadisScreenWindow] {
	if let cache = paradisScreenWindowCache, Date().timeIntervalSince(cache.at) < paradisScreenWindowCacheSeconds {
		return cache.windows
	}
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
	let windows: [ParadisScreenWindow] = list.compactMap { entry in
		guard let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
			let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue,
			let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
		else {
			return nil
		}
		return ParadisScreenWindow(pid: pid, ownerName: entry[kCGWindowOwnerName as String] as? String ?? "", bundleId: bundleIds[pid], layer: layer, bounds: bounds)
	}
	paradisScreenWindowCache = (Date(), windows)
	return windows
}

/**
 * 画面全体の層を出すだけのシステムの部品（Dock と WindowServer）か。名前ではなく bundle id と実行ファイルの場所で見る
 * （名前は誰でも名乗れる）。ここで除いた分のクリックの行き先は AX の当たり判定で確かめる。
 */
private func paradisIsSystemShell(_ window: ParadisScreenWindow) -> Bool {
	if window.bundleId == "com.apple.dock" {
		return true
	}
	guard window.bundleId == nil else {
		return false
	}
	var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
	guard proc_pidpath(window.pid, &buffer, UInt32(buffer.count)) > 0 else {
		return false
	}
	let path = String(cString: buffer)
	return path.hasPrefix("/System/Library/PrivateFrameworks/SkyLight.framework/") && (path as NSString).lastPathComponent == "WindowServer"
}

/** その点でクリックを受ける要素の持ち主（AX の当たり判定）。分からなければ nil（止める）。 */
private func paradisHitTestPid(_ point: CGPoint) -> Int32? {
	return paradisHitTestElement(point).flatMap { element in
		var pid: pid_t = 0
		return AXUIElementGetPid(element, &pid) == .success ? pid : nil
	}
}

private func paradisHitTestElement(_ point: CGPoint) -> AXUIElement? {
	var element: AXUIElement?
	guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success else {
		return nil
	}
	return element
}

/** その点の要素がメニューの「ペースト」か。 */
private func paradisPasteMenuItemAt(_ point: CGPoint) -> Bool {
	guard let element = paradisHitTestElement(point) else {
		return false
	}
	return paradisIsPasteMenuElement(element)
}

/** その要素がメニューの「ペースト」か（1 段目の AXPress でも押さない）。 */
func paradisIsPasteMenuElement(_ element: AXUIElement) -> Bool {
	return paradisIsPasteMenuItem(
		role: paradisCopy(element, kAXRoleAttribute) as? String,
		commandCharacter: paradisCopy(element, kAXMenuItemCmdCharAttribute) as? String,
		commandModifiers: (paradisCopy(element, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue,
		title: paradisCopy(element, kAXTitleAttribute) as? String
	)
}

/** OS に聞いた、キーボードのフォーカスのあるアプリと要素の持ち主の pid。 */
private func paradisFocusedPids() -> (application: Int32?, element: Int32?) {
	let systemWide = AXUIElementCreateSystemWide()
	func pid(of element: AXUIElement?) -> Int32? {
		guard let element else {
			return nil
		}
		var pid: pid_t = 0
		return AXUIElementGetPid(element, &pid) == .success ? pid : nil
	}
	return (pid(of: paradisElement(systemWide, kAXFocusedApplicationAttribute)), pid(of: paradisElement(systemWide, kAXFocusedUIElementAttribute)))
}


func paradisWindowPointJson(_ point: CGPoint, _ window: CGRect) -> [String: Double] {
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
