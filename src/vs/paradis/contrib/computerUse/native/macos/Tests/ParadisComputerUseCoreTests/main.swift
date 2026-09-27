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
	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int) throws -> [String: Any] {
		treeCalls.append((pid, windowId, maxNodes, maxDepth))
		throw ParadisHelperError(code: "accessibility_not_granted", message: "no")
	}
	func activateApp(pid: Int32, windowId: UInt32?) throws -> [String: Any] {
		inputCalls.append("activate \(pid) \(windowId.map(String.init) ?? "-")")
		return [:]
	}
	func click(pid: Int32, windowId: UInt32, target: ParadisPointerTarget, button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers) throws -> [String: Any] {
		inputCalls.append("click \(pid) \(windowId) \(target) \(button.rawValue) \(clickCount) \(modifiers.rawValue)")
		return [:]
	}
	func drag(pid: Int32, windowId: UInt32, from: ParadisPointerTarget, to: ParadisPointerTarget) throws -> [String: Any] {
		inputCalls.append("drag \(from) \(to)")
		return [:]
	}
	func scroll(pid: Int32, windowId: UInt32, target: ParadisPointerTarget?, direction: ParadisScrollDirection, pages: Double) throws -> [String: Any] {
		inputCalls.append("scroll \(target.map { "\($0)" } ?? "center") \(direction.rawValue) \(pages)")
		return [:]
	}
	func typeText(pid: Int32, units: [ParadisTypedUnit]) throws -> [String: Any] {
		inputCalls.append("type \(units.count)")
		return [:]
	}
	func pasteText(pid: Int32, text: String) throws -> [String: Any] {
		inputCalls.append("paste \(text.count)")
		return [:]
	}
	func pressChord(pid: Int32, chord: ParadisKeyChord) throws -> [String: Any] {
		inputCalls.append("chord \(chord.keyCode) \(chord.modifiers.rawValue)")
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

	let noWindow = reply(handler.handle(line: Data(#"{"id":6,"method":"screenshotWindow","params":{"pid":100}}"#.utf8)))
	check((noWindow?["error"] as? [String: Any])?["code"] as? String == "invalid_argument", "screenshot requires a window id")

	let tooLarge = reply(handler.handle(line: Data(#"{"id":7,"method":"screenshotWindow","params":{"pid":100,"windowId":7,"maxLongEdge":5000}}"#.utf8)))
	check((tooLarge?["error"] as? [String: Any])?["code"] as? String == "invalid_argument", "screenshot caps the long edge")

	_ = handler.handle(line: Data(#"{"id":8,"method":"screenshotWindow","params":{"pid":100,"windowId":7}}"#.utf8))
	check(desktop.screenshotCalls.count == 1 && desktop.screenshotCalls[0].2 == paradisDefaultScreenshotLongEdge, "screenshot uses the default long edge")

	let tree = reply(handler.handle(line: Data(#"{"id":9,"method":"accessibilityTree","params":{"pid":100}}"#.utf8)))
	check((tree?["error"] as? [String: Any])?["code"] as? String == "accessibility_not_granted", "passes the backend error code through")
	check(desktop.treeCalls.first?.1 == nil && desktop.treeCalls.first?.2 == paradisDefaultAXMaxNodes, "tree uses the defaults")

	let unknown = reply(handler.handle(line: Data(#"{"id":10,"method":"setValue","params":{}}"#.utf8)))
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
	check(code(#"{"id":2,"method":"click","params":{"pid":100,"windowId":7,"x":10,"y":20.5}}"#) == "ok", "clicks a point")
	check(code(#"{"id":3,"method":"click","params":{"pid":100,"windowId":7,"elementIndex":4,"button":"right","clickCount":2,"modifiers":["cmd","shift"]}}"#) == "ok", "right double clicks an element with modifiers")
	check(code(#"{"id":4,"method":"click","params":{"pid":100,"x":1,"y":1}}"#) == "invalid_argument", "click needs a window")
	check(code(#"{"id":5,"method":"click","params":{"pid":100,"windowId":7}}"#) == "invalid_argument", "click needs a target")
	check(code(#"{"id":6,"method":"click","params":{"pid":100,"windowId":7,"x":-1,"y":1}}"#) == "invalid_argument", "click refuses negative coordinates")
	check(code(#"{"id":7,"method":"click","params":{"pid":100,"windowId":7,"x":1,"y":1,"modifiers":["fn"]}}"#) == "invalid_argument", "click refuses the Fn modifier")
	check(code(#"{"id":8,"method":"click","params":{"pid":100,"windowId":7,"x":1,"y":1,"clickCount":4}}"#) == "invalid_argument", "click caps the click count")
	check(code(#"{"id":9,"method":"drag","params":{"pid":100,"windowId":7,"from":{"x":1,"y":2},"to":{"elementIndex":3}}}"#) == "ok", "drags")
	check(code(#"{"id":10,"method":"scroll","params":{"pid":100,"windowId":7,"direction":"down"}}"#) == "ok", "scrolls the window center")
	check(code(#"{"id":11,"method":"scroll","params":{"pid":100,"windowId":7,"direction":"sideways"}}"#) == "invalid_argument", "scroll needs a direction")
	check(code(#"{"id":12,"method":"scroll","params":{"pid":100,"windowId":7,"direction":"up","pages":50}}"#) == "invalid_argument", "scroll caps the pages")
	check(code(#"{"id":13,"method":"typeText","params":{"pid":100,"text":"a\nb"}}"#) == "ok", "types text")
	let long = String(repeating: "x", count: paradisMaxTypeTextLength + 1)
	check(code(#"{"id":14,"method":"typeText","params":{"pid":100,"text":"\#(long)"}}"#) == "invalid_argument", "type text is limited to 4,000 characters")
	check(code(#"{"id":15,"method":"pasteText","params":{"pid":100,"text":"\#(long)"}}"#) == "ok", "paste takes longer text")
	check(code(#"{"id":16,"method":"pressKey","params":{"pid":100,"key":"return"}}"#) == "ok", "presses a key")
	check(code(#"{"id":17,"method":"pressKey","params":{"pid":100,"key":"cmd"}}"#) == "invalid_argument", "press key refuses a lone modifier")
	check(code(#"{"id":18,"method":"hotkey","params":{"pid":100,"keys":["cmd","s"]}}"#) == "ok", "presses a hotkey")
	check(code(#"{"id":19,"method":"hotkey","params":{"pid":100,"keys":["cmd","space"]}}"#) == "key_blocked", "blocks Spotlight")
	check(code(#"{"id":20,"method":"hotkey","params":{"pid":100,"keys":["cmd","option","escape"]}}"#) == "key_blocked", "blocks Force Quit")
	check(code(#"{"id":21,"method":"hotkey","params":{"pid":100,"keys":["s"]}}"#) == "invalid_argument", "hotkey needs modifiers")
	check(code(#"{"id":22,"method":"activateApp","params":{"pid":100}}"#) == "ok", "activates an app")
	check(desktop.inputCalls == [
		"click 100 7 point(x: 10.0, y: 20.5) left 1 0",
		"click 100 7 element(4) right 2 3",
		"drag point(x: 1.0, y: 2.0) element(3)",
		"scroll center down 1.0",
		"type 3",
		"paste 4001",
		"chord 36 0",
		"chord 1 1",
		"activate 100 -",
	], "only valid requests reach the desktop")
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
	]
	check(blockedChords.allSatisfy(blocked), "blocks the listed shortcuts")
	let allowedChords: [[String]] = [["cmd", "s"], ["cmd", "q"], ["cmd", "shift", "k"], ["option", "left"], ["cmd", "c"], ["shift", "tab"], ["cmd", "3"]]
	check(!allowedChords.contains(where: blocked), "allows ordinary shortcuts")
	check((try? paradisParseChord(["cmd", "a", "b"])) == nil, "a chord has one key")
	check((try? paradisParseChord(["cmd", "nope"])) == nil, "unknown keys are refused")
	check(paradisKeyCode(named: "Enter") == 36 && paradisKeyCode(named: "ArrowUp") == 126 && paradisKeyCode(named: "backspace") == 51, "reads key aliases")

	check((try? paradisTypedUnits("a\r\nb\tc")) == [.text("a"), .key(paradisKeyCodeReturn), .text("b"), .key(paradisKeyCodeTab), .text("c")], "turns newlines and tabs into keys")
	check((try? paradisTypedUnits("\u{1B}[2J")) == nil, "refuses control characters")
	check((try? paradisTypedUnits("")) == nil, "refuses empty text")
	check((try? paradisTypedUnits("日本語👍🏽"))?.count == 4, "types one grapheme at a time")

	check(!paradisUserIsActive(secondsSinceLastInput: 5, secondsSinceOurLastEvent: nil), "idle user")
	check(paradisUserIsActive(secondsSinceLastInput: 0.3, secondsSinceOurLastEvent: nil), "recent input with no synthetic input is the user")
	check(!paradisUserIsActive(secondsSinceLastInput: 0.3, secondsSinceOurLastEvent: 0.3), "our own input is not the user")
	check(paradisUserIsActive(secondsSinceLastInput: 0.1, secondsSinceOurLastEvent: 0.6), "input after ours is the user")

	check(paradisFenceFailure(targetPid: 5, frontmostPid: 5, ownerAtTarget: 5) == nil, "front window of the target passes")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: 9, ownerAtTarget: 5)?.code == "window_not_focused", "another app in front stops input")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: 5, ownerAtTarget: 9)?.code == "point_obscured", "a covering window stops input")
	check(paradisFenceFailure(targetPid: 5, frontmostPid: nil, ownerAtTarget: nil)?.code == "window_not_focused", "unknown front app stops input")

	let down = paradisScrollSteps(direction: .down, pages: 1, extent: 500)
	check(down.count == 5 && down.allSatisfy { $0.dx == 0 && $0.dy == -80 }, "scrolls a page down in steps")
	check(paradisScrollSteps(direction: .left, pages: 0.1, extent: 100).first.map { $0.dx > 0 && $0.dy == 0 } == true, "scrolls left")
	check(paradisScrollSteps(direction: .up, pages: 10, extent: 5000).count == 100, "caps the scroll steps")
	let path = paradisDragPath(from: (0, 0), to: (10, 20), steps: 2)
	check(path.count == 2 && path[0].x == 5 && path[0].y == 10 && path[1].x == 10 && path[1].y == 20, "interpolates the drag path")

	check(paradisShouldRestoreClipboard(changeCountAfterOurWrite: 7, currentChangeCount: 7), "restores an untouched clipboard")
	check(!paradisShouldRestoreClipboard(changeCountAfterOurWrite: 7, currentChangeCount: 8), "keeps a clipboard someone else changed")
}

// MARK: - 引数

do {
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a", "--token-file", "/tmp/b"]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b"), "parses agent mode")
	check(paradisParseArguments(["--agent", "-psn_0_123", "--socket", "/tmp/a", "--token-file", "/tmp/b"]) == .agent(socketPath: "/tmp/a", tokenFile: "/tmp/b"), "ignores the process serial number")
	check(paradisParseArguments(["--agent", "--socket", "/tmp/a"]) == .usage, "agent mode needs a token file")
	check(paradisParseArguments([]) == .usage, "no arguments is usage")
	check(paradisParseArguments(["--permission-status"]) == .permissionStatus, "parses the permission status mode")
}

// MARK: - 接続相手の判断

do {
	let main = "ltd.paradis.paracode"
	let release = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.computeruse", teamIdentifier: "TEAM123")
	let peer = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "TEAM123")
	let parent = ParadisSigningIdentity(identifier: main, teamIdentifier: "TEAM123")
	func facts(helper: ParadisSigningIdentity = release, peer: ParadisSigningIdentity? = peer, parent: ParadisSigningIdentity? = parent, parentBundle: String? = main, grandparent: Int32? = 1, sameUser: Bool = true) -> ParadisPeerFacts {
		return ParadisPeerFacts(helper: helper, peer: peer, parent: parent, parentBundleIdentifier: parentBundle, parentParentPid: grandparent, sameUser: sameUser)
	}
	check(paradisDecidePeer(facts(), mainBundleIdentifier: main) == .allow, "release: accepts the shared process of Para Code")
	check(paradisDecidePeer(facts(peer: nil), mainBundleIdentifier: main) != .allow, "release: rejects an unsigned peer")
	check(paradisDecidePeer(facts(peer: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "OTHER")), mainBundleIdentifier: main) != .allow, "release: rejects another team")
	check(paradisDecidePeer(facts(peer: ParadisSigningIdentity(identifier: "com.example.tool", teamIdentifier: "TEAM123")), mainBundleIdentifier: main) != .allow, "release: rejects a non-helper process of the same team")
	check(paradisDecidePeer(facts(parent: ParadisSigningIdentity(identifier: "ltd.paradis.paracode.helper", teamIdentifier: "TEAM123")), mainBundleIdentifier: main) != .allow, "release: rejects a peer whose parent is not the main process")
	check(paradisDecidePeer(facts(grandparent: 4242), mainBundleIdentifier: main) != .allow, "release: rejects a main process not started by launchd")
	check(paradisDecidePeer(facts(sameUser: false), mainBundleIdentifier: main) != .allow, "rejects another user")
	let adhoc = ParadisSigningIdentity(identifier: "ltd.paradis.paracode.computeruse", teamIdentifier: nil)
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: "com.github.Electron", grandparent: 900), mainBundleIdentifier: main) == .allow, "development: accepts Electron as the parent")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: main, grandparent: 900), mainBundleIdentifier: main) == .allow, "development: accepts a local Para Code build")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: "com.apple.Terminal"), mainBundleIdentifier: main) != .allow, "development: rejects a terminal as the parent")
	check(paradisDecidePeer(facts(helper: adhoc, peer: nil, parent: nil, parentBundle: nil), mainBundleIdentifier: main) != .allow, "development: rejects a parent that is not an application")
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
