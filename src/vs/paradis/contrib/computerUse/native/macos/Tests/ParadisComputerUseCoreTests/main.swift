/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 補助アプリの純粋な部分（Sources/ParadisComputerUseCore）のテスト。
// XCTest の無い環境（コマンドラインツールだけ）でも回せるよう、swiftc で Core と一緒にビルドして実行する。
//   node build/paradis/computerUse/buildHelper.ts --test

import CoreGraphics
import Foundation

var failures = 0
var passes = 0

func check(_ condition: @autoclosure () -> Bool, _ name: String, file: String = #file, line: Int = #line) {
	if condition() {
		passes += 1
	} else {
		failures += 1
		print("FAIL: \(name) (\(file):\(line))")
	}
}

func jsonObject(_ data: Data) -> [String: Any] {
	return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] ?? [:]
}

// MARK: - 要求の読み取り

do {
	if case .success(let request) = paradisParseRequest(Data(#"{"id":3,"method":"status","params":{"a":1}}"#.utf8)) {
		check(request.id == 3 && request.method == "status" && request.params["a"] as? Int == 1, "parses a request")
	} else {
		check(false, "parses a request")
	}
	if case .failure(let failure) = paradisParseRequest(Data(#"{"id":1.5,"method":"status"}"#.utf8)) {
		check(failure.id == nil && failure.error.code == "invalid_request", "rejects a fractional id")
	} else {
		check(false, "rejects a fractional id")
	}
	if case .failure(let failure) = paradisParseRequest(Data(#"{"id":true,"method":"status"}"#.utf8)) {
		check(failure.error.code == "invalid_request", "rejects a boolean id")
	} else {
		check(false, "rejects a boolean id")
	}
	if case .failure(let failure) = paradisParseRequest(Data(#"{"id":2,"method":"status","params":[]}"#.utf8)) {
		check(failure.id == 2, "keeps the id when params are wrong")
	} else {
		check(false, "keeps the id when params are wrong")
	}
	if case .failure = paradisParseRequest(Data("not json".utf8)) {
		check(true, "rejects non-JSON")
	} else {
		check(false, "rejects non-JSON")
	}
}

// MARK: - 行の切り出し

do {
	var buffer = ParadisLineBuffer(maxLineBytes: 16)
	let first = (try? buffer.append(Data("ab\ncd".utf8))) ?? []
	let second = (try? buffer.append(Data("ef\n\ngh\n".utf8))) ?? []
	check(first.map { String(data: $0, encoding: .utf8)! } == ["ab"], "splits the first line")
	check(second.map { String(data: $0, encoding: .utf8)! } == ["cdef", "gh"], "joins a split line and skips empty lines")
	var small = ParadisLineBuffer(maxLineBytes: 4)
	var threw = false
	do {
		_ = try small.append(Data("12345".utf8))
	} catch {
		threw = true
	}
	check(threw, "stops at a line longer than the limit even before the newline")
}

// MARK: - トークン

do {
	let token = String(repeating: "a1", count: 32)
	check(paradisIsWellFormedToken(token), "accepts 64 lowercase hex characters")
	check(!paradisIsWellFormedToken(String(repeating: "A1", count: 32)), "rejects uppercase hex")
	check(!paradisIsWellFormedToken("abc"), "rejects a short token")
	check(paradisTokensEqual(token, token), "equal tokens compare equal")
	check(!paradisTokensEqual(token, String(repeating: "a1", count: 31) + "a2"), "different tokens compare different")
	check(!paradisTokensEqual(token, "a1"), "tokens of different length compare different")
}

// MARK: - 振り分け

final class FakeDesktop: ParadisDesktopBackend {
	var bundles: [Int32: String] = [100: "com.apple.finder", 300: "com.1password.1password", 400: "com.apple.systempreferences", 500: "ltd.paradis.paracode"]
	func bundleIdentifier(pid: Int32) -> String? {
		return bundles[pid]
	}
	var screenshotCalls: [(Int32, UInt32, Int)] = []
	var treeCalls: [(Int32, UInt32?, Int, Int)] = []
	var inputCalls: [String] = []

	func permissions() -> ParadisPermissionSnapshot {
		return ParadisPermissionSnapshot(accessibility: false, screenRecording: true)
	}
	func responsibility() -> (ParadisResponsibility, Int32?) {
		return (.selfProcess, 42)
	}
	func osVersion() -> String {
		return "14.5.0"
	}
	func listApps() -> [[String: Any]] {
		return [["pid": 100, "name": "Finder", "bundleId": "com.apple.finder", "active": false, "hidden": false]]
	}
	func listWindows(pid: Int32) throws -> [[String: Any]] {
		return [["windowId": 7, "index": 0]]
	}
	func screenshotWindow(pid: Int32, windowId: UInt32, maxLongEdge: Int) throws -> [String: Any] {
		screenshotCalls.append((pid, windowId, maxLongEdge))
		return ["width": 1]
	}
	var manualAccessibilityCalls: [Bool] = []
	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int, enableManualAccessibility: Bool) throws -> [String: Any] {
		treeCalls.append((pid, windowId, maxNodes, maxDepth))
		manualAccessibilityCalls.append(enableManualAccessibility)
		throw ParadisHelperError(code: "accessibility_not_granted", message: "no")
	}
	var optionCalls: [ParadisInputOptions] = []
	func perform(pid: Int32, action: ParadisInputAction, options: ParadisInputOptions) throws -> [String: Any] {
		optionCalls.append(options)
		switch action {
		case .activate(let windowId):
			inputCalls.append("activate \(pid) \(windowId.map(String.init) ?? "-")")
		case .click(let windowId, let target, let button, let clickCount, let modifiers):
			inputCalls.append("click \(pid) \(windowId) \(target) \(button.rawValue) \(clickCount) \(modifiers.rawValue)")
		case .drag(_, let from, let to):
			inputCalls.append("drag \(from) \(to)")
		case .scroll(_, let target, let direction, let pages):
			inputCalls.append("scroll \(target.map { "\($0)" } ?? "center") \(direction.rawValue) \(pages)")
		case .typeText(_, let units):
			inputCalls.append("type \(units.count)")
		case .pasteText(let text):
			inputCalls.append("paste \(text.count)")
		case .pressChord(let chord):
			inputCalls.append("chord \(chord.keyCode) \(chord.modifiers.rawValue)")
		case .setValue(let windowId, let target, let change):
			inputCalls.append("setValue \(windowId) \(target) \(change)")
		}
		return [:]
	}
}

let goodToken = String(repeating: "0f", count: 32)

func reply(_ outcome: ParadisHandlerOutcome) -> [String: Any]? {
	if case .reply(let data) = outcome {
		return jsonObject(data)
	}
	return nil
}

do {
	let handler = ParadisRequestHandler(backend: FakeDesktop(), expectedToken: goodToken, selfPid: 42)
	if case .replyAndTerminate(let data) = handler.handle(line: Data(#"{"id":1,"method":"status"}"#.utf8)) {
		check(data == nil && !handler.authenticated, "terminates without replying when the first request is not a handshake")
	} else {
		check(false, "terminates without replying when the first request is not a handshake")
	}
}

do {
	let handler = ParadisRequestHandler(backend: FakeDesktop(), expectedToken: goodToken, selfPid: 42)
	let bad = String(repeating: "0f", count: 31) + "0e"
	if case .replyAndTerminate(let data) = handler.handle(line: Data(#"{"id":1,"method":"handshake","params":{"token":"\#(bad)"}}"#.utf8)) {
		check(data == nil, "terminates without replying on a wrong token")
	} else {
		check(false, "terminates without replying on a wrong token")
	}
}

do {
	let handler = ParadisRequestHandler(backend: FakeDesktop(), expectedToken: goodToken, selfPid: 42)
	if case .replyAndTerminate = handler.handle(line: Data("garbage".utf8)) {
		check(true, "terminates on garbage before the handshake")
	} else {
		check(false, "terminates on garbage before the handshake")
	}
}

do {
	let desktop = FakeDesktop()
	let handler = ParadisRequestHandler(backend: desktop, expectedToken: goodToken, selfPid: 42)
	let hello = reply(handler.handle(line: Data(#"{"id":1,"method":"handshake","params":{"token":"\#(goodToken)"}}"#.utf8)))
	let result = hello?["result"] as? [String: Any]
	check(hello?["ok"] as? Bool == true && handler.authenticated, "accepts the right token")
	check(result?["protocolVersion"] as? Int == ParadisComputerUseVersion.protocolVersion, "reports the protocol version")
	check((result?["permissions"] as? [String: Any])?["accessibility"] as? String == "not-granted", "reports accessibility as not granted")
	check((result?["permissions"] as? [String: Any])?["screenRecording"] as? String == "granted", "reports screen recording as granted")
	check((result?["responsibility"] as? [String: Any])?["status"] as? String == "self", "reports the responsible process")

	let again = reply(handler.handle(line: Data(#"{"id":2,"method":"handshake","params":{"token":"\#(goodToken)"}}"#.utf8)))
	check(again?["ok"] as? Bool == false, "rejects a second handshake")

	let apps = reply(handler.handle(line: Data(#"{"id":3,"method":"listApps"}"#.utf8)))
	check(((apps?["result"] as? [String: Any])?["apps"] as? [[String: Any]])?.first?["bundleId"] as? String == "com.apple.finder", "lists apps")

	let noPid = reply(handler.handle(line: Data(#"{"id":4,"method":"listWindows","params":{}}"#.utf8)))
	check((noPid?["error"] as? [String: Any])?["code"] as? String == "invalid_argument", "requires a pid")

	let selfPid = reply(handler.handle(line: Data(#"{"id":5,"method":"listWindows","params":{"pid":42}}"#.utf8)))
	check((selfPid?["error"] as? [String: Any])?["code"] as? String == "app_blocked", "refuses to inspect itself")

	let noWindow = reply(handler.handle(line: Data(#"{"id":6,"method":"screenshotWindow","params":{"pid":100,"bundleId":"com.apple.finder"}}"#.utf8)))
	check((noWindow?["error"] as? [String: Any])?["code"] as? String == "invalid_argument", "screenshot requires a window id")

	let tooLarge = reply(handler.handle(line: Data(#"{"id":7,"method":"screenshotWindow","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"maxLongEdge":5000}}"#.utf8)))
	check((tooLarge?["error"] as? [String: Any])?["code"] as? String == "invalid_argument", "screenshot caps the long edge")

	_ = handler.handle(line: Data(#"{"id":8,"method":"screenshotWindow","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7}}"#.utf8))
	check(desktop.screenshotCalls.count == 1 && desktop.screenshotCalls[0].2 == paradisDefaultScreenshotLongEdge, "screenshot uses the default long edge")

	let tree = reply(handler.handle(line: Data(#"{"id":9,"method":"accessibilityTree","params":{"pid":100,"bundleId":"com.apple.finder"}}"#.utf8)))
	check((tree?["error"] as? [String: Any])?["code"] as? String == "accessibility_not_granted", "passes the backend error code through")
	check(desktop.treeCalls.first?.1 == nil && desktop.treeCalls.first?.2 == paradisDefaultAXMaxNodes, "tree uses the defaults")

	let unknown = reply(handler.handle(line: Data(#"{"id":10,"method":"setWallpaper","params":{}}"#.utf8)))
	check((unknown?["error"] as? [String: Any])?["code"] as? String == "unknown_method", "rejects unknown methods")

	if case .replyAndTerminate(let data) = handler.handle(line: Data(#"{"id":11,"method":"shutdown"}"#.utf8)) {
		check(data != nil, "replies to shutdown before terminating")
	} else {
		check(false, "replies to shutdown before terminating")
	}
}

// MARK: - 操作の命令の振り分け

do {
	let desktop = FakeDesktop()
	let handler = ParadisRequestHandler(backend: desktop, expectedToken: goodToken, selfPid: 42)
	_ = handler.handle(line: Data(#"{"id":1,"method":"handshake","params":{"token":"\#(goodToken)"}}"#.utf8))
	func code(_ json: String) -> String? {
		let result = reply(handler.handle(line: Data(json.utf8)))
		return result?["ok"] as? Bool == true ? "ok" : (result?["error"] as? [String: Any])?["code"] as? String
	}
	check(code(#"{"id":2,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":10,"y":20.5}}"#) == "ok", "clicks a point")
	check(code(#"{"id":3,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":4,"snapshotId":9,"button":"right","clickCount":2,"modifiers":["cmd","shift"]}}"#) == "ok", "right double clicks an element with modifiers")
	check(code(#"{"id":4,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","x":1,"y":1}}"#) == "invalid_argument", "click needs a window")
	check(code(#"{"id":5,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7}}"#) == "invalid_argument", "click needs a target")
	check(code(#"{"id":6,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":-1,"y":1}}"#) == "invalid_argument", "click refuses negative coordinates")
	check(code(#"{"id":7,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"modifiers":["fn"]}}"#) == "invalid_argument", "click refuses the Fn modifier")
	check(code(#"{"id":8,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"clickCount":4}}"#) == "invalid_argument", "click caps the click count")
	check(code(#"{"id":9,"method":"drag","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"from":{"x":1,"y":2},"to":{"elementIndex":3},"snapshotId":9}}"#) == "ok", "drags")
	check(code(#"{"id":10,"method":"scroll","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"direction":"down"}}"#) == "ok", "scrolls the window center")
	check(code(#"{"id":11,"method":"scroll","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"direction":"sideways"}}"#) == "invalid_argument", "scroll needs a direction")
	check(code(#"{"id":12,"method":"scroll","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"direction":"up","pages":50}}"#) == "invalid_argument", "scroll caps the pages")
	check(code(#"{"id":13,"method":"typeText","params":{"pid":100,"bundleId":"com.apple.finder","text":"a\nb"}}"#) == "ok", "types text")
	let long = String(repeating: "x", count: paradisMaxTypeTextLength + 1)
	check(code(#"{"id":14,"method":"typeText","params":{"pid":100,"bundleId":"com.apple.finder","text":"\#(long)"}}"#) == "invalid_argument", "type text is limited to 4,000 characters")
	check(code(#"{"id":15,"method":"pasteText","params":{"pid":100,"bundleId":"com.apple.finder","text":"\#(long)"}}"#) == "ok", "paste takes longer text")
	check(code(#"{"id":16,"method":"pressKey","params":{"pid":100,"bundleId":"com.apple.finder","key":"return"}}"#) == "ok", "presses a key")
	check(code(#"{"id":17,"method":"pressKey","params":{"pid":100,"bundleId":"com.apple.finder","key":"cmd"}}"#) == "invalid_argument", "press key refuses a lone modifier")
	check(code(#"{"id":18,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["cmd","s"]}}"#) == "ok", "presses a hotkey")
	check(code(#"{"id":19,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["cmd","space"]}}"#) == "key_blocked", "blocks Spotlight")
	check(code(#"{"id":20,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["cmd","option","escape"]}}"#) == "key_blocked", "blocks Force Quit")
	check(code(#"{"id":21,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["s"]}}"#) == "invalid_argument", "hotkey needs modifiers")
	check(code(#"{"id":22,"method":"activateApp","params":{"pid":100,"bundleId":"com.apple.finder"}}"#) == "ok", "activates an app")
	// 常に操作させないアプリ・Para Code・pid の使い回しは、補助アプリの側でも断る（レビュー M1）
	check(code(#"{"id":23,"method":"click","params":{"pid":300,"bundleId":"com.1password.1password","windowId":7,"x":1,"y":1}}"#) == "app_blocked", "blocks password managers in the helper")
	check(code(#"{"id":24,"method":"typeText","params":{"pid":400,"bundleId":"com.apple.systempreferences","text":"a"}}"#) == "app_blocked", "blocks System Settings in the helper")
	check(code(#"{"id":25,"method":"listWindows","params":{"pid":500,"bundleId":"ltd.paradis.paracode"}}"#) == "app_blocked", "blocks Para Code in the helper")
	handler.protectedPids = [100]
	check(code(#"{"id":26,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1}}"#) == "app_blocked", "blocks the Para Code main process by pid")
	handler.protectedPids = []
	check(code(#"{"id":27,"method":"click","params":{"pid":100,"bundleId":"com.apple.Notes","windowId":7,"x":1,"y":1}}"#) == "app_not_found", "refuses a pid that now belongs to another app")
	check(code(#"{"id":28,"method":"click","params":{"pid":100,"windowId":7,"x":1,"y":1}}"#) == "invalid_argument", "requires the bundle id")
	check(code(#"{"id":29,"method":"click","params":{"pid":999,"bundleId":"x.y","windowId":7,"x":1,"y":1}}"#) == "app_not_found", "refuses a pid without an app")
	check(code(#"{"id":30,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":1}}"#) == "stale_element", "element numbers need a snapshot id")
	check(code(#"{"id":31,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["cmd","v"]}}"#) == "key_blocked", "blocks paste shortcuts")
	check(code(#"{"id":32,"method":"hotkey","params":{"pid":100,"bundleId":"com.apple.finder","keys":["ctrl","f2"]}}"#) == "key_blocked", "blocks menu bar navigation")
	check(desktop.inputCalls == [
		"click 100 7 point(x: 10.0, y: 20.5) left 1 0",
		"click 100 7 element(4, snapshotId: 9) right 2 3",
		"drag point(x: 1.0, y: 2.0) element(3, snapshotId: 9)",
		"scroll center down 1.0",
		"type 3",
		"paste 4001",
		"chord 36 0",
		"chord 1 1",
		"activate 100 -",
	], "only valid requests reach the desktop")
}

// MARK: - 送り方の指定と値の変更の振り分け

do {
	let desktop = FakeDesktop()
	let handler = ParadisRequestHandler(backend: desktop, expectedToken: goodToken, selfPid: 42)
	_ = handler.handle(line: Data(#"{"id":1,"method":"handshake","params":{"token":"\#(goodToken)"}}"#.utf8))
	func code(_ json: String) -> String? {
		let result = reply(handler.handle(line: Data(json.utf8)))
		return result?["ok"] as? Bool == true ? "ok" : (result?["error"] as? [String: Any])?["code"] as? String
	}
	let owner = ##"{"id":"0123456789abcdef","name":"Checkout","mark":"C","color":"#d97757"}"##
	check(code(#"{"id":2,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1}}"#) == "ok", "a request without options keeps the old behavior")
	check(code(#"{"id":3,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"allowForeground":false,"cursor":\#(owner)}}"#) == "ok", "takes allowForeground and the cursor owner")
	check(code(#"{"id":4,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"allowForeground":"no"}}"#) == "invalid_argument", "allowForeground must be a boolean")
	check(code(#"{"id":40,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"activateFirst":1}}"#) == "invalid_argument", "activateFirst must be a boolean")
	check(code(#"{"id":5,"method":"click","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":1,"y":1,"cursor":{"id":"x","name":"a","mark":"","color":"red"}}}"#) == "ok", "a malformed cursor owner only hides the cursor")
	check(code(#"{"id":6,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"value":"hello"}}"#) == "ok", "sets a text value")
	check(code(#"{"id":7,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"x":3,"y":4,"value":42.5}}"#) == "ok", "sets a number at a point")
	check(code(#"{"id":8,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"value":true}}"#) == "ok", "sets a boolean")
	check(code(#"{"id":9,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"adjust":"increment","steps":3}}"#) == "ok", "increments")
	check(code(#"{"id":10,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"adjust":"decrement","value":1}}"#) == "invalid_argument", "takes either a value or an adjustment")
	check(code(#"{"id":11,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"adjust":"up"}}"#) == "invalid_argument", "knows only increment and decrement")
	check(code(#"{"id":12,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"adjust":"increment","steps":51}}"#) == "invalid_argument", "caps the steps")
	check(code(#"{"id":13,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","windowId":7,"elementIndex":2,"snapshotId":9,"value":"a\tb"}}"#) == "invalid_argument", "refuses tabs in a value")
	check(code(#"{"id":14,"method":"setValue","params":{"pid":100,"bundleId":"com.apple.finder","elementIndex":2,"snapshotId":9,"value":"a"}}"#) == "invalid_argument", "setValue needs a window")
	check(code(#"{"id":15,"method":"setValue","params":{"pid":300,"bundleId":"com.1password.1password","windowId":7,"elementIndex":2,"snapshotId":9,"value":"a"}}"#) == "app_blocked", "setValue refuses blocked apps")
	check(desktop.inputCalls == [
		"click 100 7 point(x: 1.0, y: 1.0) left 1 0",
		"click 100 7 point(x: 1.0, y: 1.0) left 1 0",
		"click 100 7 point(x: 1.0, y: 1.0) left 1 0",
		"setValue 7 element(2, snapshotId: 9) text(\"hello\")",
		"setValue 7 point(x: 3.0, y: 4.0) number(42.5)",
		"setValue 7 element(2, snapshotId: 9) boolean(true)",
		"setValue 7 element(2, snapshotId: 9) increment(3)",
	], "only valid setValue requests reach the desktop")
	check(desktop.optionCalls.map { $0.allowForeground } == [true, false, true, true, true, true, true], "allowForeground defaults to true")
	check(desktop.optionCalls[1].cursor == ParadisCursorOwnerSpec(id: "0123456789abcdef", name: "Checkout", mark: "C", color: 0xd97757), "reads the cursor owner")
	check(desktop.optionCalls.allSatisfy { !$0.activateFirst }, "activateFirst defaults to false")
	_ = code(#"{"id":41,"method":"pressKey","params":{"pid":100,"bundleId":"com.apple.finder","key":"return","activateFirst":true}}"#)
	check(desktop.optionCalls.last?.activateFirst == true, "reads activateFirst")
	_ = code(#"{"id":42,"method":"accessibilityTree","params":{"pid":100,"bundleId":"com.apple.finder"}}"#)
	_ = code(#"{"id":43,"method":"accessibilityTree","params":{"pid":100,"bundleId":"com.apple.finder","enableManualAccessibility":true}}"#)
	_ = code(#"{"id":44,"method":"accessibilityTree","params":{"pid":100,"bundleId":"com.apple.finder","enableManualAccessibility":1}}"#)
	check(desktop.manualAccessibilityCalls == [false, true, false], "sets AXManualAccessibility only when asked with true")
	check(desktop.optionCalls[0].cursor == nil && desktop.optionCalls[2].cursor == nil, "no cursor without a valid owner")
}

do {
	check(paradisParseCursorOwner(["id": "0123456789abcdef", "name": "a\u{202E}b\u{0007}c", "mark": "X", "color": "#10a37f"])?.name == "abc", "strips control and format characters from the cursor name")
	check(paradisParseCursorOwner(["id": "0123456789abcdef", "name": String(repeating: "x", count: 40), "mark": "", "color": "#10a37f"])?.name.count == 24, "cuts long cursor names")
	check(paradisParseCursorOwner(["id": "0123456789abcdef", "name": "Claude", "mark": "c", "color": "#10a37f"]) == nil, "refuses a lowercase mark")
	check(paradisParseCursorOwner(["id": "0123456789ABCDEF", "name": "Claude", "mark": "C", "color": "#10a37f"]) == nil, "refuses an uppercase id")
	check(paradisParseCursorOwner(["id": "0123456789abcdef", "name": "  ", "mark": "C", "color": "#10a37f"]) == nil, "refuses a blank name")
	check(paradisParseHexColor("#0969da") == 0x0969da && paradisParseHexColor("0969da") == nil && paradisParseHexColor("#09g9da") == nil, "reads #rrggbb colors")
}

// MARK: - 送り方の段の選び方

/** 段の代わり。何を返すかと、呼ばれた操作を覚える。 */
final class FakeRoute: ParadisInputRoute {
	let kind: ParadisInputRouteKind
	let requiresForeground: Bool
	var availability: ParadisRouteAvailability
	var outcome: () throws -> ParadisRouteOutcome
	var performed: [String] = []

	init(_ kind: ParadisInputRouteKind, requiresForeground: Bool = false, availability: ParadisRouteAvailability = .available, outcome: @escaping () throws -> ParadisRouteOutcome) {
		self.kind = kind
		self.requiresForeground = requiresForeground
		self.availability = availability
		self.outcome = outcome
	}

	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability {
		return availability
	}

	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		performed.append(action.name)
		return try outcome()
	}
}

func routeErrorCode(_ body: () throws -> Any) -> String? {
	do {
		_ = try body()
		return nil
	} catch let error as ParadisHelperError {
		return error.code
	} catch {
		return "other"
	}
}

do {
	let click = ParadisInputAction.click(windowId: 7, target: .element(3, snapshotId: 1), button: .left, clickCount: 1, modifiers: [])
	func foreground() -> FakeRoute {
		return FakeRoute(.foreground, requiresForeground: true) { .done(["clicked": true]) }
	}
	let background = ParadisUnavailableBackgroundRoute()

	// 1 段目で送れたら、そこで終わる
	let ax1 = FakeRoute(.accessibility) { .done(["clicked": true, "axAction": "AXPress"]) }
	let foreground1 = foreground()
	let viaAx = try? paradisRouteInput(click, pid: 100, routes: [ax1, background, foreground1], options: ParadisInputOptions())
	check(viaAx?["route"] as? String == "accessibility" && viaAx?["routeNotes"] == nil && foreground1.performed.isEmpty, "uses the accessibility route when it can")

	// 1 段目が譲ったら、2 段目（空）を飛ばして 3 段目
	let ax2 = FakeRoute(.accessibility) { .fellThrough("AXGroup does not accept AXPress") }
	let foreground2 = foreground()
	let viaForeground = try? paradisRouteInput(click, pid: 100, routes: [ax2, background, foreground2], options: ParadisInputOptions())
	check(viaForeground?["route"] as? String == "foreground" && foreground2.performed == ["click"], "falls through to the foreground route")
	check((viaForeground?["routeNotes"] as? [String]) == ["accessibility: AXGroup does not accept AXPress", "background: background input is not available in this version"], "says why the earlier routes were skipped")

	// 3 段目に来ても、前面に出してよいと言われていなければ何も送らない
	let ax3 = FakeRoute(.accessibility, availability: .unavailable("drag needs real input")) { .done([:]) }
	let foreground3 = foreground()
	check(routeErrorCode { try paradisRouteInput(click, pid: 100, routes: [ax3, background, foreground3], options: ParadisInputOptions(allowForeground: false)) } == "foreground_needs_approval", "asks before taking over the real pointer")
	check(ax3.performed.isEmpty && foreground3.performed.isEmpty, "sends nothing while approval is pending")

	// 1 段目で送れるなら、前面の承認は要らない
	let ax4 = FakeRoute(.accessibility) { .done([:]) }
	check((try? paradisRouteInput(click, pid: 100, routes: [ax4, background, foreground()], options: ParadisInputOptions(allowForeground: false)))?["route"] as? String == "accessibility", "the accessibility route needs no foreground approval")

	// 止める理由（利用者の打鍵など）は次の段へ譲らない
	let ax5 = FakeRoute(.accessibility) { throw ParadisHelperError(code: "user_active", message: "typing") }
	let foreground5 = foreground()
	check(routeErrorCode { try paradisRouteInput(click, pid: 100, routes: [ax5, background, foreground5], options: ParadisInputOptions()) } == "user_active" && foreground5.performed.isEmpty, "a refusal stops instead of falling through")

	// どの段でも送れない
	let unsupported = FakeRoute(.foreground, requiresForeground: true, availability: .unavailable("setting a value needs accessibility")) { .done([:]) }
	let setValue = ParadisInputAction.setValue(windowId: 7, target: .element(1, snapshotId: 1), change: .text("a"))
	check(routeErrorCode { try paradisRouteInput(setValue, pid: 100, routes: [FakeRoute(.accessibility) { .fellThrough("not settable") }, background, unsupported], options: ParadisInputOptions()) } == "input_unsupported", "reports when no route can send the action")

	// 2 段目の差し込み口: 使えるなら 3 段目より先に使う（前面の承認も要らない）
	let plugged = FakeRoute(.background) { .done(["clicked": true]) }
	let foreground6 = foreground()
	let viaBackground = try? paradisRouteInput(click, pid: 100, routes: [FakeRoute(.accessibility) { .fellThrough("no element") }, plugged, foreground6], options: ParadisInputOptions(allowForeground: false))
	check(viaBackground?["route"] as? String == "background" && foreground6.performed.isEmpty, "a background route plugs in before the foreground route")
	// 送信後の不明な結果で前面経路へ落ちると二重入力になる。
	let foregroundAfterPartial = foreground()
	let partial = FakeRoute(.background) { .done(["completed": false, "verified": NSNull(), "sentUnits": 1]) }
	let partialResult = try? paradisRouteInput(click, pid: 100, routes: [partial, foregroundAfterPartial], options: ParadisInputOptions())
	check(partialResult?["completed"] as? Bool == false && foregroundAfterPartial.performed.isEmpty, "partial background delivery is never replayed through foreground")
	let windowOptions = try? paradisParseInputOptions(["backgroundWindowId": 42])
	check(windowOptions?.backgroundWindowId == 42, "preserves the exact background keyboard window")
	for invalid: Any in [true, 0, -1, 1.5, UInt64(UInt32.max) + 1, "42"] {
		check((try? paradisParseInputOptions(["backgroundWindowId": invalid])) == nil, "rejects malformed window identifiers before routing")
	}
	check(background.availability(of: click, pid: 100) != .available && !background.requiresForeground, "the unavailable background fallback declines input")
}

// MARK: - 要求 ID ごとの中断

do {
	func line(_ id: Int, _ method: String, _ params: [String: Any] = [:]) -> Data {
		return try! JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
	}
	let queue = ParadisRequestQueue()
	_ = try? queue.append([line(1, "typeText"), line(2, "pressKey")], authenticated: true)
	_ = queue.next()
	_ = try? queue.append([line(3, "cancel", ["requestId": 2])], authenticated: true)
	check((try? queue.check()) != nil, "cancelling a queued request does not cancel the active request")
	queue.finish()
	_ = queue.next()
	do { try queue.check(); check(false, "queued cancellation must be remembered") }
	catch let error as ParadisHelperError { check(error.code == "cancelled", "queued request keeps the cancellation code") }
	catch { check(false, "expected cancellation") }
	queue.finish()
	_ = try? queue.append([line(4, "typeText")], authenticated: true)
	_ = queue.next()
	_ = try? queue.append([line(5, "cancel", ["requestId": 4]), line(6, "permissions")], authenticated: true)
	do { try queue.check(); check(false, "active cancellation must stop") }
	catch let error as ParadisHelperError { check(error.code == "cancelled", "active request keeps the cancellation code") }
	catch { check(false, "expected cancellation") }
	queue.finish()
	let next = queue.next().flatMap { try? paradisParseRequest($0).get() }
	check(next?.id == 6 && (try? queue.check()) != nil, "other requests remain queued and usable after cancellation")
	queue.finish()
	let data = paradisEncodeFailure(id: 7, error: ParadisHelperError(code: "user_active", message: "stopped", sent: 3))
	let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
	let payload = error?["error"] as? [String: Any]
	check(payload?["sent"] as? Int == 3 && payload?["code"] as? String == "user_active" && payload?["progress"] == nil, "sent input is not reported as confirmed progress")
}

// MARK: - 背面メニューと要求待ち上限

do {
	check(paradisBackgroundClickOpensMenu(roles: ["AXImage", "AXGroup", "AXGroup", "AXPopUpButton"]), "menu opening ancestor three levels above the image blocks background input")
	check(!paradisBackgroundClickOpensMenu(roles: ["AXStaticText", "AXButton"]), "plain button labels remain eligible for background input")
	let closed = paradisBackgroundMenuResult(opened: true, attempted: true, accepted: true, stillOpen: false)
	check(closed["menuClosed"] as? Bool == true && closed["menuCancelAttempted"] as? Bool == true, "reports attempted and observed closed separately")
	let remains = paradisBackgroundMenuResult(opened: true, attempted: true, accepted: true, stillOpen: true)
	check(remains["menuClosed"] as? Bool == false && remains["menuOpen"] as? Bool == true, "AXCancel success alone does not prove the menu closed")
	let unavailable = paradisBackgroundMenuResult(opened: true, attempted: false, accepted: false, stillOpen: true)
	check(unavailable["menuCancelAttempted"] as? Bool == false && (unavailable["note"] as? String)?.contains("no accessible menu") == true, "does not claim an unattempted cancellation failed")
	func request(_ id: Int) -> Data { try! JSONSerialization.data(withJSONObject: ["id": id, "method": "typeText", "params": [:]]) }
	let queue = ParadisRequestQueue()
	_ = try? queue.append([request(1)], authenticated: true)
	_ = queue.next()
	let replies = try? queue.append((2...130).map(request), authenticated: true)
	let overflow = replies?.first.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
	check(overflow?["id"] as? Int == 130 && (overflow?["error"] as? [String: Any])?["code"] as? String == "queue_full", "overflow is returned to the rejected request")
	check((try? queue.check()) != nil, "overflow does not stop a different active request")
	queue.finish()
	check(queue.next().flatMap { try? paradisParseRequest($0).get() }?.id == 2, "overflow preserves accepted request order")
}

// MARK: - 1 段目: クリックの代わりの AX の操作

do {
	let button = ParadisAXElementFacts(role: "AXButton", actions: ["AXPress"])
	let text = ParadisAXElementFacts(role: "AXStaticText")
	let group = ParadisAXElementFacts(role: "AXGroup")
	let field = ParadisAXElementFacts(role: "AXTextField", actions: ["AXShowMenu", "AXConfirm"], focusSettable: true)
	let row = ParadisAXElementFacts(role: "AXRow", actions: ["AXShowMenu"])
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [button], targetIsFrontmost: true) == .perform(action: "AXPress", depth: 0), "presses a button")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [text, button], targetIsFrontmost: true) == .perform(action: "AXPress", depth: 1), "presses the button around its label")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [text, group, group, group, button], targetIsFrontmost: true) == .none("no element near the target accepts AXPress"), "does not climb past three parents")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [row, button], targetIsFrontmost: true) == .none("AXRow does not accept AXPress"), "does not climb out of a row")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 2, modifiers: [], chain: [button], targetIsFrontmost: true) == .none("double and triple clicks need real input"), "double clicks need real input")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: .command, chain: [button], targetIsFrontmost: true) == .none("clicks with modifier keys need real input"), "modified clicks need real input")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [ParadisAXElementFacts(role: "AXButton", actions: ["AXPress"], enabled: false)], targetIsFrontmost: true) == .none("the element is disabled"), "leaves disabled buttons to real input")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [field], targetIsFrontmost: true) == .focus(depth: 0), "focuses a text field instead of clicking it")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [ParadisAXElementFacts(role: "AXTextField")], targetIsFrontmost: true) == .none("the text field does not accept focus through accessibility"), "falls through when focus cannot be set")
	check(paradisAccessibilityClickPlan(button: .right, clickCount: 1, modifiers: [], chain: [field], targetIsFrontmost: true) == .perform(action: "AXShowMenu", depth: 0), "opens the context menu of a field")
	check(paradisAccessibilityClickPlan(button: .right, clickCount: 1, modifiers: [], chain: [button], targetIsFrontmost: true) == .none("AXButton does not accept AXShowMenu"), "right clicks need AXShowMenu")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [], targetIsFrontmost: true) == .none("no accessibility element at the target"), "needs an element")
	check(paradisPressableRoles.isSuperset(of: ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXPopUpButton"]), "knows the usual pressable controls")

	// メニューを開く操作は、目的のアプリが前面のときだけ 1 段目で送る（レビュー 重大 2）
	let popUp = ParadisAXElementFacts(role: "AXPopUpButton", actions: ["AXShowMenu", "AXPress"])
	let menuButton = ParadisAXElementFacts(role: "AXMenuButton", actions: ["AXPress"])
	let background = "opening a menu in an app that is not in front would move the keyboard focus to the menu"
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [popUp], targetIsFrontmost: false) == .none(background), "does not open a pop-up menu in a background app")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [menuButton], targetIsFrontmost: false) == .none(background), "does not open a menu button in a background app")
	check(paradisAccessibilityClickPlan(button: .right, clickCount: 1, modifiers: [], chain: [field], targetIsFrontmost: false) == .none(background), "does not open a context menu in a background app")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [popUp], targetIsFrontmost: true) == .perform(action: "AXPress", depth: 0), "opens a pop-up menu when the app is in front")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [button], targetIsFrontmost: false) == .perform(action: "AXPress", depth: 0), "presses a plain button in a background app")
	check(paradisAccessibilityClickPlan(button: .left, clickCount: 1, modifiers: [], chain: [field], targetIsFrontmost: false) == .focus(depth: 0), "focuses a text field in a background app")
	check(paradisAXActionOpensMenu(action: "AXShowMenu", role: "AXTextField") && paradisAXActionOpensMenu(action: "AXPress", role: "AXPopUpButton") && !paradisAXActionOpensMenu(action: "AXPress", role: "AXButton"), "knows which actions open a menu")

	// 別の操作スペース・しまわれた・隠したアプリのウィンドウは 3 段目へ（レビュー 中 3）
	check(paradisAccessibilityWindowSkipReason(onScreen: true, minimized: false, appHidden: false) == nil, "operates a window on the current screen")
	check(paradisAccessibilityWindowSkipReason(onScreen: false, minimized: false, appHidden: false) == "the window is not on the current screen or Space", "leaves windows on other Spaces to the foreground route")
	check(paradisAccessibilityWindowSkipReason(onScreen: false, minimized: true, appHidden: false) == "the window is minimized", "leaves minimized windows to the foreground route")
	check(paradisAccessibilityWindowSkipReason(onScreen: false, minimized: false, appHidden: true) == "the app is hidden", "leaves hidden apps to the foreground route")

	// 座標で当たった要素が目的のウィンドウそのものなら、別のウィンドウとは書かない（実機の報告、2026-10-09）
	check(paradisHitElementSkipReason(hitIsTargetWindow: false, ownerIsTargetWindow: true) == nil, "uses an element of the target window")
	check(paradisHitElementSkipReason(hitIsTargetWindow: true, ownerIsTargetWindow: false) == "the point is on the window itself, not on a control", "says the point is on the window itself")
	check(paradisHitElementSkipReason(hitIsTargetWindow: false, ownerIsTargetWindow: false) == "the element at the point belongs to another window", "says another window only for another window")

	// 画面のロック中・ほかのユーザーへの切り替え中は止める（レビュー 中 6）
	check(paradisSessionFailure(onConsole: true, screenLocked: false) == nil, "runs on an unlocked console session")
	check(paradisSessionFailure(onConsole: true, screenLocked: true)?.code == "screen_locked", "stops while the screen is locked")
	check(paradisSessionFailure(onConsole: false, screenLocked: nil)?.code == "screen_locked", "stops while another user is on the console")
	check(paradisSessionFailure(onConsole: nil, screenLocked: nil) == nil, "does not stop on unreadable session values")

	// AXManualAccessibility は VS Code 系に立てず、10 分使わなければ戻す（レビュー 中 4）
	check(paradisManualAccessibilityExcluded(bundleId: "com.microsoft.VSCode", hasVSCodeProductJson: false) && paradisManualAccessibilityExcluded(bundleId: "com.todesktop.230313mzl4w4u92", hasVSCodeProductJson: false) && paradisManualAccessibilityExcluded(bundleId: nil, hasVSCodeProductJson: false), "never sets AXManualAccessibility on VS Code family apps")
	check(!paradisManualAccessibilityExcluded(bundleId: "com.tinyspeck.slackmacgap", hasVSCodeProductJson: false), "may set AXManualAccessibility on other Electron apps")
	check(paradisManualAccessibilityExcluded(bundleId: "co.posit.positron", hasVSCodeProductJson: true), "never sets AXManualAccessibility on a VS Code fork that is not in the list")

	// Electron のウィンドウには AX のツリーを作る前から閉じるボタンなどがあるので、ウェブの中身で見る（実機の報告、2026-10-09）
	struct FakeNode {
		let role: String
		let children: [FakeNode]
	}
	func needsManual(_ window: FakeNode?, maxNodes: Int = paradisWebAreaSearchMaxNodes) -> Bool {
		return paradisWindowNeedsManualAccessibility(window, children: { $0.children }, role: { $0.role }, maxNodes: maxNodes)
	}
	let buttons = [FakeNode(role: "AXButton", children: []), FakeNode(role: "AXButton", children: []), FakeNode(role: "AXButton", children: [])]
	let closedElectron = FakeNode(role: "AXWindow", children: buttons + [FakeNode(role: "AXGroup", children: [])])
	let emptyWebArea = FakeNode(role: "AXWindow", children: buttons + [FakeNode(role: "AXGroup", children: [FakeNode(role: "AXWebArea", children: [])])])
	let openElectron = FakeNode(role: "AXWindow", children: buttons + [FakeNode(role: "AXGroup", children: [FakeNode(role: "AXGroup", children: [FakeNode(role: "AXWebArea", children: [FakeNode(role: "AXStaticText", children: [])])])])])
	check(needsManual(closedElectron), "sets AXManualAccessibility when the window only has its title bar buttons")
	check(needsManual(emptyWebArea), "sets AXManualAccessibility when the web area is empty")
	check(!needsManual(openElectron), "leaves a window that already shows its web content")
	check(needsManual(nil), "sets AXManualAccessibility when there is no window")
	check(!needsManual(FakeNode(role: "AXWindow", children: Array(repeating: FakeNode(role: "AXButton", children: []), count: 20)), maxNodes: 5), "does not decide on a window larger than the search limit")

	// 立てたアプリを戻すか（レビュー 2 回目 中 2）: 同じプロセスで、支援技術が動いていないときだけ
	check(paradisSameProcess(recordedStart: 100.2, currentStart: 100.5) && !paradisSameProcess(recordedStart: 100, currentStart: 250) && !paradisSameProcess(recordedStart: 100, currentStart: nil), "tells a reused pid apart by the process start time")
	check(paradisManualAccessibilityRestoreDecision(recordedStart: 100, currentStart: 100, assistiveTechnologyRunning: false) == .restore, "restores the same process")
	check(paradisManualAccessibilityRestoreDecision(recordedStart: 100, currentStart: 250, assistiveTechnologyRunning: false) == .forget, "never writes to another app that reused the pid")
	check(paradisManualAccessibilityRestoreDecision(recordedStart: 100, currentStart: nil, assistiveTechnologyRunning: false) == .forget, "forgets an app that quit")
	check(paradisManualAccessibilityRestoreDecision(recordedStart: 100, currentStart: 100, assistiveTechnologyRunning: true) == .forget, "leaves it on while VoiceOver or Switch Control runs")
	let saved = try! JSONEncoder().encode([ParadisManualAccessibilityEntry(pid: 42, started: 1_700_000_000.5)])
	check(paradisDecodeManualAccessibilityEntries(saved) == [ParadisManualAccessibilityEntry(pid: 42, started: 1_700_000_000.5)], "reads the leftover record of a crashed helper")
	check(paradisDecodeManualAccessibilityEntries(Data("broken".utf8)).isEmpty && paradisDecodeManualAccessibilityEntries(nil).isEmpty, "treats a broken or missing record as empty")

	// 背面のアプリで開いているメニューは利用者のもの: 止めて、閉じない（レビュー 2 回目 中 1）
	let menuWindow = ParadisMenuWindowFacts(layer: 101, alpha: 1, width: 180, height: 120)
	check(paradisMenuOpenFailure(menuWindow: menuWindow, axMenuOpen: false, targetIsFrontmost: false) == ParadisHelperError(code: "menu_open", message: "a menu is open in the app (a window at layer 101, 180x120); the user may be using it, or it is a menu that could not be closed"), "stops while a menu window is open in a background app and says what it saw")
	check(paradisMenuOpenFailure(menuWindow: nil, axMenuOpen: true, targetIsFrontmost: false)?.message == "a menu is open in the app (an accessibility menu); the user may be using it, or it is a menu that could not be closed", "stops on an accessibility menu")
	check(paradisMenuOpenFailure(menuWindow: menuWindow, axMenuOpen: true, targetIsFrontmost: true) == nil, "lets the agent press items of a menu in the front app")
	check(paradisMenuOpenFailure(menuWindow: nil, axMenuOpen: false, targetIsFrontmost: false) == nil, "runs when no menu is open")

	// メニューのウィンドウは、層・透明でないこと・大きさで見分ける（レビュー 3 回目 2）
	check(paradisIsMenuWindow(menuWindow, menuLayer: 101), "counts a visible menu window")
	check(!paradisIsMenuWindow(ParadisMenuWindowFacts(layer: 101, alpha: 0, width: 180, height: 120), menuLayer: 101), "ignores a transparent window at the menu layer")
	check(!paradisIsMenuWindow(ParadisMenuWindowFacts(layer: 101, alpha: 1, width: 0, height: 120), menuLayer: 101) && !paradisIsMenuWindow(ParadisMenuWindowFacts(layer: 101, alpha: 1, width: 40, height: 0), menuLayer: 101), "ignores a window without a size")
	check(!paradisIsMenuWindow(ParadisMenuWindowFacts(layer: 3, alpha: 1, width: 180, height: 120), menuLayer: 101), "ignores windows at other layers")

	// 操作の後のメニュー（レビュー 3 回目 1）: 閉じられなければ黙って残さず伝え、操作の間の打鍵も伝える
	check(paradisMenuAfterAction(opened: false, closed: false, stillVisible: false, userTypedDuringAction: true) == ParadisMenuAfterAction(closed: false, stillOpen: false, note: nil), "says nothing when the action opened no menu")
	let closedMenu = paradisMenuAfterAction(opened: true, closed: true, stillVisible: false, userTypedDuringAction: false)
	check(closedMenu.closed && !closedMenu.stillOpen && closedMenu.note?.hasPrefix("A menu opened in the app while it was not in front, so Para Code closed it.") == true, "reports a menu it closed")
	let leftOpen = paradisMenuAfterAction(opened: true, closed: false, stillVisible: true, userTypedDuringAction: false)
	check(!leftOpen.closed && leftOpen.stillOpen && leftOpen.note?.contains("Tell the user that a menu is open in this app") == true, "asks the agent to tell the user about a menu it could not close")
	let cancelledButVisible = paradisMenuAfterAction(opened: true, closed: true, stillVisible: true, userTypedDuringAction: false)
	check(!cancelledButVisible.closed && cancelledButVisible.stillOpen, "does not claim a menu closed while its window is still on screen")
	check(paradisMenuAfterAction(opened: true, closed: true, stillVisible: false, userTypedDuringAction: true).note?.contains("The user typed while the menu was open") == true, "says the user typed while the menu was open")
	check(paradisUserTypedDuringAction(secondsSinceKeyboard: 0.4, actionSeconds: 1.1) && !paradisUserTypedDuringAction(secondsSinceKeyboard: 5, actionSeconds: 1.1) && !paradisUserTypedDuringAction(secondsSinceKeyboard: nil, actionSeconds: 1.1), "tells keys typed during the action from earlier ones")

	// 記録のファイルは補助アプリごと（レビュー 3 回目 3）
	check(paradisManualAccessibilityStateFileName(helperPid: 4321) == "manual-accessibility-4321.json", "names the record after the helper pid")
	check(paradisManualAccessibilityStateFileOwner("manual-accessibility-4321.json") == 4321 && paradisManualAccessibilityStateFileOwner("manual-accessibility.json") == 0, "reads the owner of a record file, including the old name")
	check(paradisManualAccessibilityStateFileOwner("helper.log") == nil && paradisManualAccessibilityStateFileOwner("manual-accessibility-x1.json") == nil && paradisManualAccessibilityStateFileOwner("manual-accessibility-.json") == nil, "ignores other files")
	check(paradisShouldRecoverStateFile(ownerPid: 99, selfPid: 42, ownerIsRunningHelper: false), "recovers the record of a helper that is gone")
	check(!paradisShouldRecoverStateFile(ownerPid: 99, selfPid: 42, ownerIsRunningHelper: true), "leaves the record of another running helper")
	check(!paradisShouldRecoverStateFile(ownerPid: 42, selfPid: 42, ownerIsRunningHelper: true), "leaves its own record")
	check(paradisShouldRecoverStateFile(ownerPid: 0, selfPid: 42, ownerIsRunningHelper: false), "recovers the record under the old name")
	check(paradisShouldCloseMenu(targetIsFrontmost: false, menuOpenBefore: false, menuOpenAfter: true), "closes a menu the action opened in a background app")
	check(!paradisShouldCloseMenu(targetIsFrontmost: false, menuOpenBefore: true, menuOpenAfter: true), "never closes a menu that was open before the action")
	check(!paradisShouldCloseMenu(targetIsFrontmost: true, menuOpenBefore: false, menuOpenAfter: true), "never closes a menu in the front app")
	check(!paradisShouldCloseMenu(targetIsFrontmost: false, menuOpenBefore: false, menuOpenAfter: false), "has nothing to close without a menu")
	let now = Date()
	check(paradisManualAccessibilityExpired(lastUsed: now.addingTimeInterval(-paradisManualAccessibilityIdleSeconds), now: now) && !paradisManualAccessibilityExpired(lastUsed: now.addingTimeInterval(-60), now: now), "restores AXManualAccessibility after ten idle minutes")

	let slider = ParadisAXElementFacts(role: "AXSlider", actions: ["AXIncrement", "AXDecrement"])
	check(paradisAccessibilityValuePlan(.increment(2), facts: slider, valueSettable: true, secret: false) == .perform(action: "AXIncrement", count: 2), "increments a slider")
	check(paradisAccessibilityValuePlan(.decrement(1), facts: slider, valueSettable: true, secret: false) == .perform(action: "AXDecrement", count: 1), "decrements a slider")
	check(paradisAccessibilityValuePlan(.number(80), facts: slider, valueSettable: true, secret: false) == .setValue, "sets a slider value")
	check(paradisAccessibilityValuePlan(.text("a"), facts: ParadisAXElementFacts(role: "AXStaticText"), valueSettable: false, secret: false) == .none("AXStaticText does not accept a new value through accessibility"), "refuses read-only values")
	check(paradisAccessibilityValuePlan(.increment(1), facts: ParadisAXElementFacts(role: "AXTextField"), valueSettable: true, secret: false) == .none("AXTextField does not accept AXIncrement"), "refuses increments on text fields")
	if case .none = paradisAccessibilityValuePlan(.text("hunter2"), facts: ParadisAXElementFacts(role: "AXTextField"), valueSettable: true, secret: true) {
		check(true, "never sets a password field through accessibility")
	} else {
		check(false, "never sets a password field through accessibility")
	}

	check(paradisAXPressCheck(role: "AXCheckBox", before: "0", after: "1") == ParadisAXCheck(verified: true, value: "1"), "a toggled checkbox is verified")
	check(paradisAXPressCheck(role: "AXCheckBox", before: "0", after: "0").verified == false, "an unchanged checkbox is not verified")
	check(paradisAXPressCheck(role: "AXRadioButton", before: "1", after: "1").verified == true, "a selected radio button stays selected")
	check(paradisAXPressCheck(role: "AXButton", before: nil, after: nil).verified == nil, "a plain button cannot be verified")
	check(paradisAXValueCheck(change: .text("hello"), before: "", after: "hello").verified == true, "verifies a text value")
	check(paradisAXValueCheck(change: .number(80), before: "50", after: "80").verified == true, "verifies a number value")
	check(paradisAXValueCheck(change: .number(150), before: "50", after: "100") == ParadisAXCheck(verified: false, value: "100"), "reports a clamped number")
	check(paradisAXValueCheck(change: .boolean(true), before: "0", after: "1").verified == true, "verifies a boolean value")
	check(paradisAXValueCheck(change: .increment(1), before: "50", after: "55").verified == true, "verifies an increment")
	check(paradisAXValueCheck(change: .decrement(1), before: "50", after: "55").verified == false, "notices a wrong direction")
	check(paradisAXValueCheck(change: .text("a"), before: "", after: nil).verified == nil, "cannot verify an unreadable value")
	check(paradisAXValueText(NSNumber(value: 55.0)) == "55" && paradisAXValueText(NSNumber(value: 0.25)) == "0.25" && paradisAXValueText(kCFBooleanTrue) == "1", "formats values for comparison")

	let before = ParadisFocusSnapshot(frontmostPid: 10, focusedApplicationPid: 10, focusedWindowId: 5)
	check(paradisFocusPreserved(before: before, after: before), "the same focus is preserved")
	check(!paradisFocusPreserved(before: before, after: ParadisFocusSnapshot(frontmostPid: 20, focusedApplicationPid: 10, focusedWindowId: 5)), "a new front app is a focus change")
	check(!paradisFocusPreserved(before: before, after: ParadisFocusSnapshot(frontmostPid: 10, focusedApplicationPid: 20, focusedWindowId: 5)), "a menu taking keyboard focus is a focus change")
	check(!paradisFocusPreserved(before: before, after: ParadisFocusSnapshot(frontmostPid: 10, focusedApplicationPid: 10, focusedWindowId: 6)), "a new key window is a focus change")
	check(paradisFocusPreserved(before: before, after: ParadisFocusSnapshot(frontmostPid: 10, focusedApplicationPid: nil, focusedWindowId: nil)), "unreadable values are not compared")

	// 1 段目は打鍵だけを見る。タップにキーが届く構成ならタップの値、届かなければ HID の値
	check(paradisPhysicalKeyboardAge(tapKeyboard: 5, hidKeyboard: 0.1, tapSawKeyboard: true, secondsSinceTapStarted: 10) == 5, "uses the tap once it has seen keys")
	check(paradisPhysicalKeyboardAge(tapKeyboard: nil, hidKeyboard: 0.2, tapSawKeyboard: false, secondsSinceTapStarted: 10) == 0.2, "uses the HID age until the tap sees keys")
	check(paradisPhysicalKeyboardAge(tapKeyboard: nil, hidKeyboard: 3, tapSawKeyboard: false, secondsSinceTapStarted: nil) == 3, "uses the HID age without a tap")
}

// MARK: - 独自のカーソルの軌跡

do {
	let start = CGPoint(x: 100, y: 100)
	let end = CGPoint(x: 500, y: 400)
	let glide = paradisPlanCursorGlide(from: start, to: end)
	check(glide.points.first == start && glide.points.last == end, "the glide starts and ends at the points")
	check(glide.durationMs == min(paradisCursorGlideMaxMs, 500 / paradisCursorGlidePointsPerMs), "the glide takes distance over speed, up to the cap")
	check(glide.points.dropFirst().dropLast().contains { point in
		// 始点と終点を結ぶ線より上（画面の座標で y が小さい側）を通る
		let lineY = Double(start.y) + (Double(point.x) - Double(start.x)) * 300 / 400
		return Double(point.y) < lineY - 1
	}, "the glide bows instead of moving in a straight line")
	check(paradisPlanCursorGlide(from: start, to: CGPoint(x: 103, y: 102)) == ParadisCursorGlide(points: [CGPoint(x: 103, y: 102)], durationMs: 0), "a short move snaps")
	check(paradisPlanCursorGlide(from: nil, to: end).durationMs == 0, "the first move only places the cursor")
	check(paradisCursorGlideDuration(distance: 50) == paradisCursorGlideMinMs, "short glides take the minimum time")
	check(paradisCursorEase(0) == 0 && paradisCursorEase(1) == 1 && paradisCursorEase(0.25) < 0.25, "the glide eases in and out")
}

// MARK: - 入力の決まり

do {
	func blocked(_ keys: [String]) -> Bool {
		guard let chord = try? paradisParseChord(keys) else {
			return false
		}
		return paradisBlockedChordReason(chord) != nil
	}
	let blockedChords: [[String]] = [
		["cmd", "space"], ["ctrl", "space"], ["cmd", "option", "space"], ["cmd", "tab"], ["cmd", "shift", "tab"], ["cmd", "`"],
		["cmd", "option", "esc"], ["ctrl", "cmd", "q"], ["cmd", "shift", "q"], ["cmd", "shift", "3"], ["cmd", "shift", "4"], ["cmd", "shift", "5"],
		["ctrl", "up"], ["ctrl", "left"], ["ctrl", "right"], ["ctrl", "down"], ["fn", "f"], ["globe", "e"],
		// レビュー M4: メニューバー・Dock・アクセシビリティ
		["ctrl", "f1"], ["ctrl", "f2"], ["ctrl", "f3"], ["ctrl", "f7"], ["ctrl", "f8"], ["ctrl", "shift", "f12"], ["cmd", "f5"], ["cmd", "option", "f5"],
		["cmd", "option", "d"], ["cmd", "option", "8"], ["ctrl", "option", "cmd", "8"], ["cmd", "option", "="], ["cmd", "option", "-"], ["ctrl", "option", "cmd", "."],
		// レビュー M5: 貼り付け
		["cmd", "v"], ["cmd", "shift", "v"], ["cmd", "option", "shift", "v"],
	]
	check(blockedChords.allSatisfy(blocked), "blocks the listed shortcuts")
	let allowedChords: [[String]] = [["cmd", "s"], ["cmd", "q"], ["cmd", "shift", "k"], ["option", "left"], ["cmd", "c"], ["shift", "tab"], ["cmd", "3"]]
	check(!allowedChords.contains(where: blocked), "allows ordinary shortcuts")
	check(paradisBlockedChordReason(ParadisKeyChord(keyCode: paradisKeyCodeV, modifiers: .command), allowPaste: true) == nil, "the paste command may send cmd-v")
	check(paradisBlockedChordReason(ParadisKeyChord(keyCode: 122, modifiers: []), allowPaste: false) == nil, "a plain function key is allowed")
	check((try? paradisParseChord(["cmd", "a", "b"])) == nil, "a chord has one key")
	check((try? paradisParseChord(["cmd", "nope"])) == nil, "unknown keys are refused")
	check(paradisKeyCode(named: "Enter") == 36 && paradisKeyCode(named: "ArrowUp") == 126 && paradisKeyCode(named: "backspace") == 51, "reads key aliases")

	check((try? paradisTypedUnits("a\r\nb")) == [.text("a"), .text("\n"), .text("b")], "keeps newlines as line breaks, never Return")
	check((try? paradisTypedUnits("user\tpassword")) == nil, "refuses tabs so a password never lands in the wrong field")
	check((try? paradisTypedUnits("\u{1B}[2J")) == nil, "refuses control characters")
	check((try? paradisTypedUnits("")) == nil, "refuses empty text")
	check((try? paradisTypedUnits("日本語👍🏽"))?.count == 4, "types one grapheme at a time")

	// レビュー M2: 自分の分を時刻で除かない。見張りが目印の無い入力だけを数える
	check(!paradisUserIsActive(secondsSincePhysicalInput: 5), "idle user")
	check(!paradisUserIsActive(secondsSincePhysicalInput: nil), "no physical input yet")
	check(paradisUserIsActive(secondsSincePhysicalInput: 0.3), "physical input within a second is the user, even right after our own input")
	check(paradisIsOurEvent(userData: paradisSyntheticEventMarker, sourcePid: 42, selfPid: 42), "marks our own events")
	check(!paradisIsOurEvent(userData: 0, sourcePid: 42, selfPid: 42) && !paradisIsOurEvent(userData: paradisSyntheticEventMarker, sourcePid: 7, selfPid: 42), "another process cannot borrow the marker")

	// レビュー N6・N7: タップと HID の合わせ方
	// タップにキーが届いたことが無ければ、キーボードは HID の値で見る（自分の入力で止まる側に倒れる）
	check(paradisPhysicalInputAge(tapKeyboard: nil, tapPointer: 9, hidKeyboard: 0.2, hidPointer: 5, tapSawKeyboard: false, secondsSinceTapStarted: 30) == 0.2, "uses the HID keyboard time until the tap has seen a key")
	check(paradisPhysicalInputAge(tapKeyboard: 4, tapPointer: 9, hidKeyboard: 0.2, hidPointer: 5, tapSawKeyboard: true, secondsSinceTapStarted: 30) == 4, "trusts the tap once it has seen keys")
	check(paradisPhysicalInputAge(tapKeyboard: 4, tapPointer: nil, hidKeyboard: 9, hidPointer: 0.3, tapSawKeyboard: true, secondsSinceTapStarted: 0.5) == 0.3, "also uses the HID pointer time right after the tap starts")
	check(paradisPhysicalInputAge(tapKeyboard: 4, tapPointer: nil, hidKeyboard: 9, hidPointer: 0.3, tapSawKeyboard: true, secondsSinceTapStarted: 5) == 4, "ignores the HID pointer time later")
	check(paradisPhysicalInputAge(tapKeyboard: nil, tapPointer: nil, hidKeyboard: 3, hidPointer: 0.7, tapSawKeyboard: false, secondsSinceTapStarted: nil) == 0.7, "uses HID only without a tap")

	// レビュー N5: 長い入力の確かめの間隔
	check(paradisNeedsFullFence(unitIndex: 3, secondsSinceLastFullFence: nil), "checks everything before the first unit")
	check(!paradisNeedsFullFence(unitIndex: 3, secondsSinceLastFullFence: 0.01), "skips the full check between batches")
	check(paradisNeedsFullFence(unitIndex: 10, secondsSinceLastFullFence: 0.01), "checks every ten units")
	check(paradisNeedsFullFence(unitIndex: 3, secondsSinceLastFullFence: 0.06), "checks every 50 ms")

	// レビュー N11: メニューの「ペースト」
	check(paradisIsPasteMenuItem(role: "AXMenuItem", commandCharacter: "V", commandModifiers: 0, title: "Paste"), "detects Edit > Paste")
	check(paradisIsPasteMenuItem(role: "AXMenuItem", commandCharacter: nil, commandModifiers: nil, title: "ペースト"), "detects a context menu paste")
	check(!paradisIsPasteMenuItem(role: "AXMenuItem", commandCharacter: "V", commandModifiers: 8, title: "View"), "a plain V shortcut is not paste")
	check(!paradisIsPasteMenuItem(role: "AXButton", commandCharacter: "V", commandModifiers: 0, title: "Paste"), "only menu items")

	check(paradisFenceFailure(targetPid: 5, frontmostPid: 5, ownerAtTarget: 5) == nil, "front window of the target passes")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: 9, ownerAtTarget: 5)?.code == "window_not_focused", "another app in front stops input")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: 5, ownerAtTarget: 9)?.code == "point_obscured", "a covering window stops input")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: nil, ownerAtTarget: nil)?.code == "window_not_focused", "unknown front app stops input")

	// WindowServer はナチュラルなスクロールがオンなら縦の符号を反転して届ける（実機の報告と計測、2026-10-09）
	let down = paradisScrollSteps(direction: .down, pages: 1, extent: 500, naturalScrolling: false)
	check(down.count == 5 && down.allSatisfy { $0.dx == 0 && $0.dy == -80 }, "scrolls a page down in steps")
	let naturalDown = paradisScrollSteps(direction: .down, pages: 1, extent: 500, naturalScrolling: true)
	check(naturalDown.count == 5 && naturalDown.allSatisfy { $0.dx == 0 && $0.dy == 80 }, "flips the vertical value with natural scrolling so down still goes down")
	check(paradisScrollSteps(direction: .up, pages: 0.1, extent: 100, naturalScrolling: true).first.map { $0.dy < 0 } == true && paradisScrollSteps(direction: .up, pages: 0.1, extent: 100, naturalScrolling: false).first.map { $0.dy > 0 } == true, "scrolls up with either setting")
	for natural in [false, true] {
		check(paradisScrollSteps(direction: .left, pages: 0.1, extent: 100, naturalScrolling: natural).first.map { $0.dx > 0 && $0.dy == 0 } == true, "scrolls left (natural \(natural))")
		check(paradisScrollSteps(direction: .right, pages: 0.1, extent: 100, naturalScrolling: natural).first.map { $0.dx < 0 && $0.dy == 0 } == true, "scrolls right (natural \(natural))")
	}
	check(paradisScrollSteps(direction: .up, pages: 10, extent: 5000, naturalScrolling: false).count == 100, "caps the scroll steps")
	check(paradisNaturalScrolling(preference: nil) && paradisNaturalScrolling(preference: true) && !paradisNaturalScrolling(preference: false) && !paradisNaturalScrolling(preference: NSNumber(value: 0)) && paradisNaturalScrolling(preference: "x"), "reads the natural scrolling setting with the OS default on")

	// 離すイベントに修飾キーを付けたまま HID へ送ると、OS の修飾キーの状態が残る（実機の報告、2026-10-09）
	let nonCoalesced = CGEventFlags.maskNonCoalesced
	check(paradisModifierEventFlags(chord: .maskCommand, systemBefore: nonCoalesced) == ParadisModifierEventFlags(press: .maskCommand, release: nonCoalesced), "presses with cmd and releases back to no modifier")
	check(paradisModifierEventFlags(chord: [.maskCommand, .maskShift], systemBefore: []).release == [], "releases every modifier of the chord")
	let heldShift = CGEventFlags(rawValue: CGEventFlags.maskShift.rawValue | 0x02 | CGEventFlags.maskAlphaShift.rawValue)
	check(paradisModifierEventFlags(chord: .maskCommand, systemBefore: heldShift).release == heldShift, "keeps a modifier the user holds and caps lock")
	let stuckCommand = CGEventFlags(rawValue: CGEventFlags.maskCommand.rawValue | 0x08 | nonCoalesced.rawValue)
	check(paradisModifierEventFlags(chord: .maskCommand, systemBefore: stuckCommand).release == nonCoalesced, "clears cmd and its left and right key bits after a cmd chord")
	check(paradisModifierEventFlags(chord: [], systemBefore: nonCoalesced) == ParadisModifierEventFlags(press: [], release: nonCoalesced), "a plain key keeps the state as it was")
	let path = paradisDragPath(from: (0, 0), to: (10, 20), steps: 2)
	check(path.count == 2 && path[0].x == 5 && path[0].y == 10 && path[1].x == 10 && path[1].y == 20, "interpolates the drag path")

	check(paradisClipboardRestorePlan(changeCountAfterOurWrite: 7, currentChangeCount: 7, savedIsConcealed: false, savedIsComplete: true) == .restore, "restores an untouched clipboard")
	check(paradisClipboardRestorePlan(changeCountAfterOurWrite: 7, currentChangeCount: 8, savedIsConcealed: false, savedIsComplete: true) == .keepOthers, "keeps a clipboard someone else changed")
	check(paradisClipboardRestorePlan(changeCountAfterOurWrite: 7, currentChangeCount: 7, savedIsConcealed: true, savedIsComplete: true) == .clear, "clears instead of restoring a concealed secret")
	check(paradisClipboardRestorePlan(changeCountAfterOurWrite: 7, currentChangeCount: 7, savedIsConcealed: false, savedIsComplete: false) == .restorePartial, "reports a partial restore")

	// レビュー M3: 認証・同意のダイアログと、目的のウィンドウに重なるパネル
	let target = CGRect(x: 100, y: 100, width: 400, height: 300)
	let dialog = ParadisScreenWindow(pid: 50, ownerName: "SecurityAgent", bundleId: "com.apple.SecurityAgent", layer: 1000, bounds: CGRect(x: 900, y: 900, width: 10, height: 10))
	let consent = ParadisScreenWindow(pid: 51, ownerName: "UserNotificationCenter", bundleId: nil, layer: 0, bounds: .zero)
	let panel = ParadisScreenWindow(pid: 52, ownerName: "Spotlight", bundleId: "com.apple.Spotlight", layer: 25, bounds: CGRect(x: 200, y: 150, width: 100, height: 50))
	let menuBar = ParadisScreenWindow(pid: 53, ownerName: "Window Server", bundleId: nil, layer: 24, bounds: CGRect(x: 0, y: 0, width: 2000, height: 1000))
	let ownMenu = ParadisScreenWindow(pid: 5, ownerName: "Notes", bundleId: "com.apple.Notes", layer: 101, bounds: target)
	let droppy = ParadisScreenWindow(pid: 54, ownerName: "Droppy", bundleId: "app.droppy", layer: 100, bounds: target)
	let passkey = ParadisScreenWindow(pid: 55, ownerName: "AuthenticationServicesAgent", bundleId: nil, layer: 3, bounds: .zero)
	check(paradisOverlayFailure(targetPid: 5, windows: [dialog])?.code == "system_dialog", "an authentication dialog anywhere stops input")
	check(paradisOverlayFailure(targetPid: 5, windows: [consent])?.code == "system_dialog", "a consent dialog stops input")
	check(paradisOverlayFailure(targetPid: 5, windows: [passkey])?.code == "system_dialog", "a passkey sheet stops input")
	// レビュー N4: 常駐の浮いたパネルが重なっているだけでは止めない
	check(paradisOverlayFailure(targetPid: 5, windows: [panel, droppy, menuBar, ownMenu]) == nil, "floating panels, the menu bar and the app's own menus do not stop input")
	check(paradisFocusFailure(targetPid: 5, focusedApplicationPid: 5, focusedElementPid: 5) == nil, "keys go to the focused app")
	check(paradisFocusFailure(targetPid: 5, focusedApplicationPid: 5, focusedElementPid: 52)?.code == "window_not_focused", "a panel holding the focused element stops keys")
	check(paradisFocusFailure(targetPid: 5, focusedApplicationPid: 9, focusedElementPid: 5) != nil && paradisFocusFailure(targetPid: 5, focusedApplicationPid: nil, focusedElementPid: nil) != nil, "keys need keyboard focus in the app")
}

// MARK: - 動いているアプリの引き方

do {
	// NSRunningApplication(processIdentifier:) は別のアプリの起動・終了の直後に一時的に nil を返す（実機、2026-10-09）
	let apps: [(pid: Int32, name: String)] = [(10, "Finder"), (20, "Notes")]
	check(paradisLookUpRunningApplication(pid: 20, direct: { _ in nil }, all: { apps }, pidOf: { $0.pid })?.name == "Notes", "finds the app in the list when the direct lookup misses")
	check(paradisLookUpRunningApplication(pid: 20, direct: { _ in (pid: Int32(20), name: "Direct") }, all: { apps }, pidOf: { $0.pid })?.name == "Direct", "uses the direct lookup first")
	check(paradisLookUpRunningApplication(pid: 30, direct: { _ in nil }, all: { apps }, pidOf: { $0.pid }) == nil, "an app that is not running is not found")
}

// MARK: - 引数

do {
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a", "--token-file", "/tmp/b"]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b"), "parses agent mode")
	check(paradisParseArguments(["--agent", "-psn_0_123", "--socket", "/tmp/a", "--token-file", "/tmp/b"]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b"), "ignores the process serial number")
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a"]) == .usage, "agent mode needs a token file")
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a", "--token-file", "/tmp/b", "--state-dir", "/tmp/c"]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b", stateDirectory: "/tmp/c"), "parses the state directory")
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a", "--token-file", "/tmp/b", "--state-dir", ""]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b", stateDirectory: nil), "ignores an empty state directory")
	check(paradisParseArguments([]) == .usage, "no arguments is usage")
	check(paradisParseArguments(["--permission-status"]) == .permissionStatus, "parses the permission status mode")
}

// MARK: - 接続相手の判断（レビュー H1）

do {
	let main = "ltd.paradis.paracode"
	let release = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.computeruse", teamIdentifier: "TEAM123")
	let peer = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "TEAM123")
	let parent = ParadisSigningIdentity(identifier: main, teamIdentifier: "TEAM123")
	let sharedEnvironment = ["HOME=/Users/example", "VSCODE_ESM_ENTRYPOINT=\(paradisSharedProcessEntryPoint)", "VSCODE_CRASH_REPORTER_PROCESS_TYPE=shared-process"]
	let sharedProcess = ParadisProcessArguments(executablePath: "/Applications/Para Code.app/Contents/Frameworks/Para Code Helper.app/Contents/MacOS/Para Code Helper", arguments: ["Para Code Helper", "--type=utility", "--utility-sub-type=node.mojom.NodeService"], environment: sharedEnvironment)
	let mainProcess = ParadisProcessArguments(executablePath: "/Applications/Para Code.app/Contents/MacOS/Para Code", arguments: ["/Applications/Para Code.app/Contents/MacOS/Para Code"], environment: ["HOME=/Users/example"])
	func facts(helper: ParadisSigningIdentity = release, peer: ParadisSigningIdentity? = peer, parent: ParadisSigningIdentity? = parent, peerBundle: String? = "ltd.paradis.paracode.helper", parentBundle: String? = main, peerArguments: ParadisProcessArguments? = sharedProcess, parentArguments: ParadisProcessArguments? = mainProcess, grandparent: Int32? = 1, sameUser: Bool = true) -> ParadisPeerFacts {
		return ParadisPeerFacts(helper: helper, peer: peer, parent: parent, peerBundleIdentifier: peerBundle, parentBundleIdentifier: parentBundle, peerArguments: peerArguments, parentArguments: parentArguments, parentParentPid: grandparent, sameUser: sameUser)
	}
	func environment(_ entryPoint: String, _ type: String) -> ParadisProcessArguments {
		return ParadisProcessArguments(executablePath: sharedProcess.executablePath, arguments: sharedProcess.arguments, environment: ["VSCODE_ESM_ENTRYPOINT=\(entryPoint)", "VSCODE_CRASH_REPORTER_PROCESS_TYPE=\(type)"])
	}
	func withArgument(_ process: ParadisProcessArguments, _ argument: String) -> ParadisProcessArguments {
		return ParadisProcessArguments(executablePath: process.executablePath, arguments: process.arguments + [argument], environment: process.environment)
	}
	func withEnvironment(_ process: ParadisProcessArguments, _ entry: String) -> ParadisProcessArguments {
		return ParadisProcessArguments(executablePath: process.executablePath, arguments: process.arguments, environment: process.environment + [entry])
	}
	check(paradisDecidePeer(facts(), mainBundleIdentifier: main) == .allow, "release: accepts the shared process of Para Code")
	check(paradisDecidePeer(facts(peer: nil), mainBundleIdentifier: main) != .allow, "release: rejects an unsigned peer")
	check(paradisDecidePeer(facts(peer: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "OTHER")), mainBundleIdentifier: main) != .allow, "release: rejects another team")
	check(paradisDecidePeer(facts(peer: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper.Plugin", teamIdentifier: "TEAM123")), mainBundleIdentifier: main) != .allow, "release: rejects the extension host helper")
	check(paradisDecidePeer(facts(peer: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper.Renderer", teamIdentifier: "TEAM123")), mainBundleIdentifier: main) != .allow, "release: rejects a renderer")
	check(paradisDecidePeer(facts(peerArguments: environment("vs/platform/terminal/node/ptyHostMain", "ptyHost")), mainBundleIdentifier: main) != .allow, "rejects the pty host")
	check(paradisDecidePeer(facts(peerArguments: environment("vs/workbench/api/node/extensionHostProcess", "extensionHost")), mainBundleIdentifier: main) != .allow, "rejects an extension host")
	check(paradisDecidePeer(facts(peerArguments: withEnvironment(sharedProcess, "VSCODE_ESM_ENTRYPOINT=\(paradisSharedProcessEntryPoint)")), mainBundleIdentifier: main) != .allow, "rejects a duplicated entry point")
	check(paradisDecidePeer(facts(peerArguments: ParadisProcessArguments(executablePath: sharedProcess.executablePath, arguments: ["Para Code Helper"], environment: sharedEnvironment)), mainBundleIdentifier: main) != .allow, "rejects a helper that is not a utility process")
	check(paradisDecidePeer(facts(peerArguments: withEnvironment(sharedProcess, "ELECTRON_RUN_AS_NODE=1")), mainBundleIdentifier: main) != .allow, "rejects a helper run as node")
	check(paradisDecidePeer(facts(parentArguments: withArgument(mainProcess, "--inspect=9229")), mainBundleIdentifier: main) != .allow, "rejects a main started with --inspect")
	check(paradisDecidePeer(facts(parentArguments: withArgument(mainProcess, "--inspect-sharedprocess=5879")), mainBundleIdentifier: main) != .allow, "rejects a main that inspects the shared process")
	check(paradisDecidePeer(facts(parentArguments: withArgument(mainProcess, "--remote-debugging-port=9222")), mainBundleIdentifier: main) != .allow, "rejects a main with remote debugging")
	check(paradisDecidePeer(facts(parentArguments: withArgument(mainProcess, "--js-flags=--allow-natives-syntax")), mainBundleIdentifier: main) != .allow, "rejects a main with js flags")
	check(paradisDecidePeer(facts(parentArguments: withArgument(mainProcess, "--extensionDevelopmentPath=/tmp/x")), mainBundleIdentifier: main) != .allow, "rejects an extension development host")
	check(paradisDecidePeer(facts(parentArguments: withEnvironment(mainProcess, "NODE_OPTIONS=--require /tmp/x.js")), mainBundleIdentifier: main) != .allow, "rejects a main with NODE_OPTIONS")
	check(paradisDecidePeer(facts(peerArguments: withArgument(sharedProcess, "--inspect=5879")), mainBundleIdentifier: main) != .allow, "rejects an inspected shared process")
	check(paradisDecidePeer(facts(parentArguments: nil), mainBundleIdentifier: main) != .allow, "rejects when the arguments cannot be read")
	check(paradisDecidePeer(facts(parent: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "TEAM123")), mainBundleIdentifier: main) != .allow, "release: rejects a peer whose parent is not the main process")
	check(paradisDecidePeer(facts(grandparent: 4242), mainBundleIdentifier: main) != .allow, "release: rejects a main process not started by launchd")
	check(paradisDecidePeer(facts(sameUser: false), mainBundleIdentifier: main) != .allow, "rejects another user")
	let adhoc = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.computeruse", teamIdentifier: nil)
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, grandparent: 900), mainBundleIdentifier: main) == .allow, "development: accepts the shared process of a local build")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: "com.github.Electron", grandparent: 900), mainBundleIdentifier: main) != .allow, "development: rejects a plain Electron parent")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, peerBundle: "ltd.paradis.paracode.helper.Plugin"), mainBundleIdentifier: main) != .allow, "development: rejects the extension host")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, peerArguments: environment("vs/platform/terminal/node/ptyHostMain", "ptyHost")), mainBundleIdentifier: main) != .allow, "development: rejects the pty host")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: "com.apple.Terminal"), mainBundleIdentifier: main) != .allow, "development: rejects a terminal as the parent")
}

do {
	// KERN_PROCARGS2 の形: argc・実行ファイル・詰め物・argv・環境変数
	var bytes: [UInt8] = [2, 0, 0, 0]
	bytes += Array("/bin/x".utf8) + [0, 0, 0]
	bytes += Array("x".utf8) + [0] + Array("--type=utility".utf8) + [0]
	bytes += Array("A=1".utf8) + [0] + Array("B=2".utf8) + [0, 0]
	let parsed = paradisParseProcessArguments(bytes)
	check(parsed == ParadisProcessArguments(executablePath: "/bin/x", arguments: ["x", "--type=utility"], environment: ["A=1", "B=2"]), "parses KERN_PROCARGS2")
	check(paradisParseProcessArguments([1, 0]) == nil, "rejects a short buffer")
	if let parsed {
		let duplicated = ParadisProcessArguments(executablePath: "", arguments: [], environment: ["A=1", "A=2"])
		check(parsed.environmentValue("A") == .some("1") && parsed.environmentValue("C") == .none && duplicated.environmentValue("A") == .some(.none), "reads environment values and refuses duplicates")
	}
}

// MARK: - 文字入力の確かめ（ベータの実機で文字が落ちた件）

do {
	check(paradisIsInputMethodActive(sourceType: "TISTypeKeyboardInputMode", sourceId: "com.apple.inputmethod.Kotoeri.RomajiTyping.Roman"), "Japanese input in its alphanumeric mode is an input method")
	check(paradisIsInputMethodActive(sourceType: nil, sourceId: "com.google.inputmethod.Japanese.base"), "a third-party input method is detected by its id")
	check(!paradisIsInputMethodActive(sourceType: "TISTypeKeyboardLayout", sourceId: "com.apple.keylayout.US"), "a plain keyboard layout is not an input method")
	check(!paradisIsInputMethodActive(sourceType: nil, sourceId: nil), "unknown sources are treated as keyboard layouts")

	let sent = "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789"
	// 実機で TextEdit に入った文字列（約 2 割が落ち、空白も消えた）
	let arrived = "abdefgiklmoprsuvwyzABCDEFGHIJLMNOQRSUWXY 0134689"
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: arrived, text: sent) == ParadisTypingCheck(verified: false, inserted: arrived.count), "reports dropped characters instead of claiming success")
	check(paradisTypingOutcome(before: "Hello ", selection: (6, 0), after: "Hello world", text: "world") == ParadisTypingCheck(verified: true, inserted: 5), "verifies text inserted at the caret")
	check(paradisTypingOutcome(before: "Hello there", selection: (6, 5), after: "Hello world", text: "world") == ParadisTypingCheck(verified: true, inserted: 5), "verifies text that replaced a selection")
	check(paradisTypingOutcome(before: "a", selection: (1, 0), after: "a\nb", text: "\r\nb") == ParadisTypingCheck(verified: true, inserted: 2), "treats typed newlines as line breaks")
	check(paradisTypingOutcome(before: "日本", selection: (2, 0), after: "日本語👍🏽", text: "語👍🏽") == ParadisTypingCheck(verified: true, inserted: 2), "counts characters, not UTF-16 units")
	check(paradisTypingOutcome(before: nil, selection: nil, after: "x", text: "x") == ParadisTypingCheck(verified: nil, inserted: nil), "cannot verify an unreadable field")
	check(paradisTypingOutcome(before: "ab", selection: nil, after: "abcd", text: "cd").verified == true, "without a selection, sees the text appear")
	check(paradisTypingOutcome(before: "ab", selection: nil, after: "abc", text: "cd").verified == false, "without a selection, text that never appears is a failure")
	// ベータ 3 のレビュー L1: 前からあった同じ文字列では成功にしない
	check(paradisTypingOutcome(before: "hello", selection: nil, after: "helloxyzab", text: "hello").verified == false, "text that was already there does not count")

	// ベータ 3 のレビュー M2: アプリの書き換えでは止めない。落ちたときだけ止める
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: "\u{201C}Hi\u{201D} \u{2014} it\u{2019}s", text: "\"Hi\" -- it's") == ParadisTypingCheck(verified: true, inserted: 11, rewritten: true), "smart quotes and dashes are fine")
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: "github.com", text: "gith").verified == true, "an inline completion is fine")
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: "(090) 1234-5678", text: "09012345678").verified == true, "a formatted phone number is fine")
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: "The", text: "teh") == ParadisTypingCheck(verified: false, inserted: 3, rewritten: true), "an autocorrected word is reported as rewritten, not dropped")
	check(paradisTypingOutcome(before: "", selection: (0, 0), after: "hlo", text: "hello") == ParadisTypingCheck(verified: false, inserted: 3), "dropped characters are still a failure")

	// ベータ 3 のレビュー H1: 変わらないだけでは「入っていない」と言わない
	check(paradisTypingOutcome(before: "abc", selection: (0, 3), after: "abc", text: "abc") == ParadisTypingCheck(verified: true, inserted: 3), "replacing a selection with the same text is a success")
	check(paradisTypingOutcome(before: "ab", selection: (2, 0), after: "ab", text: "cd").verified == nil, "an unchanged value is unconfirmed, never a failure")
	check(paradisAXReadbackStep(before: "ab", selection: (2, 0), latest: "ab", text: "cd") == nil, "keeps reading back while the value has not changed")
	check(paradisAXReadbackStep(before: "ab", selection: (2, 0), latest: nil, text: "cd") == nil, "keeps reading back while the value cannot be read")
	check(paradisAXReadbackStep(before: "ab", selection: (2, 0), latest: "abcd", text: "cd")?.verified == true, "stops reading back once the text is in")
	check(paradisAXWriteCertainlyDidNothing(error: -25205) && paradisAXWriteCertainlyDidNothing(error: -25201) && paradisAXWriteCertainlyDidNothing(error: -25208), "unsupported writes may fall back to another route")
	check(!paradisAXWriteCertainlyDidNothing(error: 0) && !paradisAXWriteCertainlyDidNothing(error: -25204) && !paradisAXWriteCertainlyDidNothing(error: -25200), "success, timeouts and general failures never fall back (the text may arrive later)")
}

// MARK: - 起動時の argv の外（レビュー N2）

do {
	check(paradisForbiddenArgvJsonEntries(Data(#"{ "locale": "ja", "enable-crash-reporter": true }"#.utf8)) == [], "a normal argv.json passes")
	check(paradisForbiddenArgvJsonEntries(Data("// comment\n{ \"remote-debugging-port\": 9222, \"js-flags\": \"--x\", }".utf8)) == ["js-flags", "remote-debugging-port"], "finds runtime switches in JSON with comments")
	check(paradisForbiddenArgvJsonEntries(Data(#"{ "enable-proposed-api": ["a.b"], "inspect-extensions": 9333 }"#.utf8)) == ["enable-proposed-api", "inspect-extensions"], "finds proposed APIs and inspect switches")
	check(paradisForbiddenArgvJsonEntries(Data("not json".utf8)) == nil, "an unreadable argv.json is reported")

	check(paradisSealProblem(added: [], altered: [], missing: ["/Applications/Para Code.app/Contents/Resources/app/out/x/react-devtools/_metadata/verified_contents.json"]) == nil, "tolerates Chromium rewriting _metadata")
	check(paradisSealProblem(added: [], altered: ["/Applications/Para Code.app/Contents/Resources/app/out/main.js"], missing: []) != nil, "refuses a modified file")
	check(paradisSealProblem(added: ["/Applications/Para Code.app/Contents/Resources/app/out/evil.js"], altered: [], missing: []) != nil, "refuses an added file")

	check(paradisInspectorProblem(listeningPorts: ["Para Code": [47286, 51234], "the shared process": [47286]]) == nil, "other listening ports are fine")
	check(paradisInspectorProblem(listeningPorts: ["Para Code": [9229]]) != nil, "an inspector on the default port is refused")
}

do {
	let failure = jsonObject(paradisEncodeFailure(id: 3, error: ParadisHelperError(code: "user_active", message: "x", progress: 12)))
	check((failure["error"] as? [String: Any])?["progress"] as? Int == 12, "reports progress with an error")
	check(ParadisPermissionSnapshot(accessibility: true, screenRecording: false, inputMonitoring: false).json["inputMonitoring"] as? String == "not-granted", "reports input monitoring")
}

// MARK: - 常に操作させないアプリ（レビュー M1・M8）

do {
	check(paradisBlockReason(bundleId: "org.keepassxc.keepassxc") == .passwordManager, "blocks KeePassXC")
	check(paradisBlockReason(bundleId: "COM.1PASSWORD.1PASSWORD") == .passwordManager, "matches case-insensitively")
	check(paradisBlockReason(bundleId: "com.apple.keychainaccess") == .keychain, "blocks Keychain Access")
	check(paradisBlockReason(bundleId: "me.proton.authenticator") == .authenticator, "blocks Proton Authenticator")
	check(paradisBlockReason(bundleId: "com.microsoft.azureauthenticator") == .authenticator && paradisBlockReason(bundleId: "com.example.SomeAuthenticator") == .authenticator, "blocks authenticator apps by name")
	check(paradisBlockReason(bundleId: "com.twofasapp.2fas") == .authenticator && paradisBlockReason(bundleId: "de.example.otpauth") == .authenticator, "blocks 2FAS and OTP Auth")
	check(paradisBlockReason(bundleId: "com.example.twofas") == .authenticator && paradisBlockReason(bundleId: "com.duosecurity.DuoMobile") == .authenticator && paradisBlockReason(bundleId: "com.yubico.yubioath") == .authenticator, "blocks twofas, Duo Mobile and Yubico")
	check(paradisBlockReason(bundleId: "ltd.paradis.paracode.helper") == .paraCode, "blocks Para Code helpers")
	check(paradisBlockReason(bundleId: "com.apple.systempreferences.legacyLoader.x86_64") == .system, "blocks System Settings panes")
	check(paradisBlockReason(bundleId: "com.apple.finder") == nil && paradisBlockReason(bundleId: "ltd.paradis.paracodex") == nil, "allows other apps")
}

do {
	check(paradisClassifyResponsibility(selfPid: 10, responsiblePid: 10) == .selfProcess, "responsible is self")
	check(paradisClassifyResponsibility(selfPid: 10, responsiblePid: 3) == .other, "responsible is another process")
	check(paradisClassifyResponsibility(selfPid: 10, responsiblePid: nil) == .unknown, "responsible is unknown without the API")
}

// MARK: - アクセシビリティの文字列

do {
	check(paradisIsSecureLike(role: "AXSecureTextField", subrole: nil, title: nil, label: nil, placeholder: nil), "secure text field is secret")
	check(paradisIsSecureLike(role: "AXTextField", subrole: nil, title: nil, label: nil, placeholder: "One-time code"), "one-time code is secret")
	check(paradisIsSecureLike(role: "AXTextField", subrole: nil, title: "Password", label: nil, placeholder: nil), "password title is secret")
	check(!paradisIsSecureLike(role: "AXTextField", subrole: nil, title: "Search", label: nil, placeholder: nil), "search field is not secret")

	check(paradisSanitizeText("a\nb\u{202E}c\t d") == "a b c d", "sanitizes control and bidi characters")
	check(paradisSanitizeText(String(repeating: "x", count: 10), maxLength: 4) == "xxxx\u{2026}", "truncates long text")

	let nodes = [
		ParadisAXNode(index: 0, depth: 0, role: "AXWindow", subrole: nil, title: "Doc", value: nil, label: nil, frame: CGRect(x: 0, y: 0, width: 100, height: 50), enabled: nil, focused: nil, actions: [], redacted: false),
		ParadisAXNode(index: 1, depth: 1, role: "AXTextField", subrole: nil, title: "Password", value: nil, label: nil, frame: nil, enabled: true, focused: true, actions: ["AXConfirm"], redacted: true),
		ParadisAXNode(index: 2, depth: 1, role: "AXButton", subrole: nil, title: "OK", value: nil, label: nil, frame: CGRect(x: 10.4, y: 20.6, width: 30, height: 12), enabled: false, focused: nil, actions: ["AXPress"], redacted: false),
	]
	let selectedCell = ParadisAXNode(index: 3, depth: 1, role: "AXCell", subrole: nil, title: "Desktop", value: nil, label: nil, frame: nil, enabled: nil, focused: false, selected: true, actions: [], redacted: false)
	check(paradisRenderAXTree([selectedCell], truncated: false) == "  [3] AXCell \"Desktop\" selected", "shows selection separately from focus")
	let text = paradisRenderAXTree(nodes, truncated: true)
	check(text == "[0] AXWindow \"Doc\" @0,0 100x50\n  [1] AXTextField \"Password\" value=<redacted> focused actions=AXConfirm\n  [2] AXButton \"OK\" @10,21 30x12 disabled actions=AXPress\n... (tree truncated)", "renders the tree")
}

do {
	let bounded = paradisBoundedSize(width: 3136, height: 1960, maxLongEdge: 1568)
	check(bounded.width == 1568 && bounded.height == 980, "bounds the long edge")
	let small = paradisBoundedSize(width: 800, height: 600, maxLongEdge: 1568)
	check(small.width == 800 && small.height == 600, "keeps a small image")
	let tall = paradisBoundedSize(width: 0, height: 5000, maxLongEdge: 1000)
	check(tall.width == 1 && tall.height == 1000, "keeps both edges at least 1")
}

// MARK: - 応答の形

do {
	let failure = jsonObject(paradisEncodeFailure(id: nil, error: ParadisHelperError(code: "x", message: "y")))
	check(failure["id"] is NSNull && failure["ok"] as? Bool == false, "encodes a failure without an id")
	let success = paradisEncodeSuccess(id: 1, result: ["path": "/a/b"])
	check(success.last == 0x0A, "ends each response with a newline")
	check(String(data: success, encoding: .utf8)?.contains("/a/b") == true, "does not escape slashes")
}

print("\(passes) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
