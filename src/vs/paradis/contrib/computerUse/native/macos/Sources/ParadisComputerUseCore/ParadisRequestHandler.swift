/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動の引数と、1 本の接続で受けた要求の振り分け。
//
// 読み取り（状態・許可の確認・アプリとウィンドウの一覧・単一ウィンドウのスクショ・アクセシビリティのツリー）と、
// 操作（前面に出す・クリック・ドラッグ・スクロール・文字入力・貼り付け・キー・ホットキー・値の変更）を受ける。
// 引数の形と、送らないキーの組み合わせはここで確かめ、OS に触れる前に断る。
// どのアプリを操作してよいか（承認）は shared process が決める。ただし常に操作させないアプリ・Para Code の main と
// shared process・補助アプリ自身は、ここでも断る（レビュー M1。shared process の判定と二重にする）。
// pid を取る命令は、shared process が解いたときの bundle id も受け取り、今のその pid の bundle id と比べる
// （pid の使い回しで別のアプリへ届かないように）。

import Foundation

// MARK: - 引数

enum ParadisHelperMode: Equatable {
	/** shared process から `open -n` で起動された。ソケットで 1 本だけ接続を受ける。 */
	case agent(socketPath: String, tokenFile: String)
	/** 許可の状態を標準出力へ 1 行の JSON で出して終わる（手元の確認用）。 */
	case permissionStatus
	case usage
}

func paradisParseArguments(_ arguments: [String]) -> ParadisHelperMode {
	guard let first = arguments.first else {
		return .usage
	}
	switch first {
	case "--agent":
		var socketPath: String?
		var tokenFile: String?
		var index = 1
		while index < arguments.count {
			let name = arguments[index]
			let value = index + 1 < arguments.count ? arguments[index + 1] : nil
			switch name {
			case "--socket":
				socketPath = value
				index += 2
			case "--token-file":
				tokenFile = value
				index += 2
			default:
				// LaunchServices が `-psn_...` を足すことがあるので、知らない引数は飛ばす
				index += 1
			}
		}
		guard let socketPath, !socketPath.isEmpty, let tokenFile, !tokenFile.isEmpty else {
			return .usage
		}
		return .agent(socketPath: socketPath, tokenFile: tokenFile)
	case "--permission-status":
		return .permissionStatus
	default:
		return .usage
	}
}

// MARK: - デスクトップへの問い合わせ（main 側が実装する）

struct ParadisPermissionSnapshot: Equatable {
	let accessibility: Bool
	let screenRecording: Bool
	/** 入力監視（聞くだけのイベントタップにキーが届くか。無くても止める側に倒すので必須ではない）。 */
	var inputMonitoring: Bool? = nil

	var json: [String: Any] {
		var result: [String: Any] = ["accessibility": accessibility ? "granted" : "not-granted", "screenRecording": screenRecording ? "granted" : "not-granted"]
		if let inputMonitoring {
			result["inputMonitoring"] = inputMonitoring ? "granted" : "not-granted"
		}
		return result
	}
}

/** クリックなどの的。ウィンドウ左上を原点とするポイントか、直前に読んだツリーの番号。 */
enum ParadisPointerTarget: Equatable {
	case point(x: Double, y: Double)
	/** 番号と、その番号を振ったツリーの id（ほかのペインが読み直した後の古い番号を使わないため）。 */
	case element(Int, snapshotId: Int)
}

enum ParadisMouseButton: String {
	case left, right
}

protocol ParadisDesktopBackend: AnyObject {
	/** 今その pid で動いているアプリの bundle id。無ければ nil。 */
	func bundleIdentifier(pid: Int32) -> String?
	func permissions() -> ParadisPermissionSnapshot
	func responsibility() -> (ParadisResponsibility, Int32?)
	func osVersion() -> String
	func listApps() -> [[String: Any]]
	func listWindows(pid: Int32) throws -> [[String: Any]]
	func screenshotWindow(pid: Int32, windowId: UInt32, maxLongEdge: Int) throws -> [String: Any]
	/** `enableManualAccessibility` は操作の許可があるときだけ true（Electron 製のアプリに AXManualAccessibility を立ててよい）。 */
	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int, enableManualAccessibility: Bool) throws -> [String: Any]
	/**
	 * 入力を送る（前面に出す・クリック・ドラッグ・スクロール・文字入力・貼り付け・キー・値の変更）。
	 * 送り方の段（ParadisInputRoute.swift）を順に試し、結果の `route` に送った段を書く。
	 */
	func perform(pid: Int32, action: ParadisInputAction, options: ParadisInputOptions) throws -> [String: Any]
}

// MARK: - 振り分け

enum ParadisHandlerOutcome {
	/** 応答を返して次の要求を待つ。 */
	case reply(Data)
	/** 応答を返して（あれば）終わる。認証の失敗と shutdown。 */
	case replyAndTerminate(Data?)
}

/** スクショの長辺の既定と上限（設計書 3.4: 1568 px 以下）。 */
let paradisDefaultScreenshotLongEdge = 1568
let paradisMaxScreenshotLongEdge = 1568
/** ツリーの既定と上限。 */
let paradisDefaultAXMaxNodes = 400
let paradisMaxAXMaxNodes = 2_000
let paradisDefaultAXMaxDepth = 30
let paradisMaxAXMaxDepth = 60

final class ParadisRequestHandler {
	private let backend: ParadisDesktopBackend
	private let expectedToken: String
	private let selfPid: Int32
	private(set) var authenticated = false
	/** 的にしてはいけない pid（接続相手の shared process と、その親の Para Code の main）。受け入れた後に入れる。 */
	var protectedPids: Set<Int32> = []

	init(backend: ParadisDesktopBackend, expectedToken: String, selfPid: Int32) {
		self.backend = backend
		self.expectedToken = expectedToken
		self.selfPid = selfPid
	}

	func handle(line: Data) -> ParadisHandlerOutcome {
		let request: ParadisRequest
		switch paradisParseRequest(line) {
		case .success(let parsed):
			request = parsed
		case .failure(let failure):
			// 認証の前に読めない要求が来たら、相手は Para Code ではない。答えずに終わる
			if !authenticated {
				return .replyAndTerminate(nil)
			}
			return .reply(paradisEncodeFailure(id: failure.id, error: failure.error))
		}
		if !authenticated {
			return handshake(request)
		}
		do {
			switch request.method {
			case "handshake":
				throw ParadisHelperError(code: "invalid_request", message: "handshake was already done")
			case "shutdown":
				return .replyAndTerminate(paradisEncodeSuccess(id: request.id, result: ["ok": true]))
			default:
				return .reply(paradisEncodeSuccess(id: request.id, result: try dispatch(request)))
			}
		} catch let error as ParadisHelperError {
			return .reply(paradisEncodeFailure(id: request.id, error: error))
		} catch {
			return .reply(paradisEncodeFailure(id: request.id, error: ParadisHelperError(code: "internal_error", message: String(describing: error))))
		}
	}

	private func handshake(_ request: ParadisRequest) -> ParadisHandlerOutcome {
		guard request.method == "handshake", let token = request.params["token"] as? String, paradisTokensEqual(token, expectedToken) else {
			// トークンが違う相手とは話さない。何も返さずに終わる（試行を重ねさせない）
			return .replyAndTerminate(nil)
		}
		authenticated = true
		return .reply(paradisEncodeSuccess(id: request.id, result: statusResult()))
	}

	private func dispatch(_ request: ParadisRequest) throws -> Any {
		let params = request.params
		switch request.method {
		case "status":
			return statusResult()
		case "permissions":
			return backend.permissions().json
		case "listApps":
			return ["apps": backend.listApps()]
		case "listWindows":
			return ["windows": try backend.listWindows(pid: try pidParam(params))]
		case "screenshotWindow":
			let longEdge = try optionalIntParam(params, "maxLongEdge", minimum: 64, maximum: paradisMaxScreenshotLongEdge) ?? paradisDefaultScreenshotLongEdge
			return try backend.screenshotWindow(pid: try pidParam(params), windowId: try windowIdParam(params, required: true)!, maxLongEdge: longEdge)
		case "activateApp":
			return try backend.perform(pid: try pidParam(params), action: .activate(windowId: try windowIdParam(params, required: false)), options: try paradisParseInputOptions(params))
		case "click":
			let button = try enumParam(params, "button", ParadisMouseButton.init(rawValue:)) ?? .left
			let clickCount = try optionalIntParam(params, "clickCount", minimum: 1, maximum: 3) ?? 1
			let pid = try pidParam(params)
			let action = ParadisInputAction.click(windowId: try windowIdParam(params, required: true)!, target: try targetParam(params, snapshot: params), button: button, clickCount: clickCount, modifiers: try modifiersParam(params))
			return try backend.perform(pid: pid, action: action, options: try paradisParseInputOptions(params))
		case "drag":
			guard let from = params["from"] as? [String: Any], let to = params["to"] as? [String: Any] else {
				throw ParadisHelperError.invalidArgument("\"from\" and \"to\" must be objects with elementIndex or x and y")
			}
			let pid = try pidParam(params)
			let action = ParadisInputAction.drag(windowId: try windowIdParam(params, required: true)!, from: try targetParam(from, snapshot: params), to: try targetParam(to, snapshot: params))
			return try backend.perform(pid: pid, action: action, options: try paradisParseInputOptions(params))
		case "scroll":
			guard let direction = try enumParam(params, "direction", ParadisScrollDirection.init(rawValue:)) else {
				throw ParadisHelperError.invalidArgument("\"direction\" must be up, down, left or right")
			}
			let pages = try optionalNumberParam(params, "pages", minimum: 0.1, maximum: 10) ?? 1
			let target = params["elementIndex"] != nil || params["x"] != nil || params["y"] != nil ? try targetParam(params, snapshot: params) : nil
			let pid = try pidParam(params)
			let action = ParadisInputAction.scroll(windowId: try windowIdParam(params, required: true)!, target: target, direction: direction, pages: pages)
			return try backend.perform(pid: pid, action: action, options: try paradisParseInputOptions(params))
		case "typeText":
			guard let text = params["text"] as? String else {
				throw ParadisHelperError.invalidArgument("\"text\" must be a string")
			}
			return try backend.perform(pid: try pidParam(params), action: .typeText(text: text, units: try paradisTypedUnits(text)), options: try paradisParseInputOptions(params))
		case "pasteText":
			guard let text = params["text"] as? String, !text.isEmpty else {
				throw ParadisHelperError.invalidArgument("\"text\" must be a non-empty string")
			}
			guard text.count <= paradisMaxPasteTextLength else {
				throw ParadisHelperError.invalidArgument("\"text\" is longer than \(paradisMaxPasteTextLength) characters")
			}
			return try backend.perform(pid: try pidParam(params), action: .pasteText(text: text), options: try paradisParseInputOptions(params))
		case "pressKey":
			guard let key = params["key"] as? String, paradisModifier(named: key) == nil, let keyCode = paradisKeyCode(named: key) else {
				throw ParadisHelperError.invalidArgument("\"key\" must be one key name such as return, escape, tab, up or a")
			}
			return try backend.perform(pid: try pidParam(params), action: .pressChord(try allowedChord(ParadisKeyChord(keyCode: keyCode, modifiers: []))), options: try paradisParseInputOptions(params))
		case "hotkey":
			guard let keys = params["keys"] as? [String], keys.count >= 2, keys.count <= 5 else {
				throw ParadisHelperError.invalidArgument("\"keys\" must list one to four modifiers and one key, such as [\"cmd\", \"s\"]")
			}
			let chord = try paradisParseChord(keys)
			guard !chord.modifiers.isEmpty else {
				throw ParadisHelperError.invalidArgument("a hotkey needs at least one modifier; use pressKey for a single key")
			}
			return try backend.perform(pid: try pidParam(params), action: .pressChord(try allowedChord(chord)), options: try paradisParseInputOptions(params))
		case "setValue":
			let pid = try pidParam(params)
			let action = ParadisInputAction.setValue(windowId: try windowIdParam(params, required: true)!, target: try targetParam(params, snapshot: params), change: try paradisParseValueChange(params))
			return try backend.perform(pid: pid, action: action, options: try paradisParseInputOptions(params))
		case "accessibilityTree":
			let maxNodes = try optionalIntParam(params, "maxNodes", minimum: 1, maximum: paradisMaxAXMaxNodes) ?? paradisDefaultAXMaxNodes
			let maxDepth = try optionalIntParam(params, "maxDepth", minimum: 1, maximum: paradisMaxAXMaxDepth) ?? paradisDefaultAXMaxDepth
			let enableManualAccessibility = (params["enableManualAccessibility"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
			return try backend.accessibilityTree(pid: try pidParam(params), windowId: try windowIdParam(params, required: false), maxNodes: maxNodes, maxDepth: maxDepth, enableManualAccessibility: enableManualAccessibility)
		default:
			throw ParadisHelperError(code: "unknown_method", message: "unknown method: \(request.method)")
		}
	}

	private func statusResult() -> [String: Any] {
		let (responsibility, responsiblePid) = backend.responsibility()
		var responsibilityJson: [String: Any] = ["status": responsibility.rawValue]
		if let responsiblePid {
			responsibilityJson["pid"] = Int(responsiblePid)
		}
		return [
			"protocolVersion": ParadisComputerUseVersion.protocolVersion,
			"helperVersion": ParadisComputerUseVersion.helperVersion,
			"pid": Int(selfPid),
			"osVersion": backend.osVersion(),
			"permissions": backend.permissions().json,
			"responsibility": responsibilityJson,
		]
	}

	private func pidParam(_ params: [String: Any]) throws -> Int32 {
		guard let rawPid = paradisExactInt(params["pid"]), rawPid > 0, rawPid <= Int(Int32.max) else {
			throw ParadisHelperError.invalidArgument("\"pid\" must be a positive integer")
		}
		let pid = Int32(rawPid)
		// 自分自身と、Para Code の main・shared process は的にしない
		guard pid != selfPid, !protectedPids.contains(pid) else {
			throw ParadisHelperError(code: "app_blocked", message: "Computer Use never reads or operates Para Code")
		}
		guard let expected = params["bundleId"] as? String, !expected.isEmpty else {
			throw ParadisHelperError.invalidArgument("\"bundleId\" is required")
		}
		guard let current = backend.bundleIdentifier(pid: pid) else {
			throw ParadisHelperError(code: "app_not_found", message: "no application with a bundle id has pid \(pid)")
		}
		guard current.lowercased() == expected.lowercased() else {
			throw ParadisHelperError(code: "app_not_found", message: "pid \(pid) now belongs to another application")
		}
		if let reason = paradisBlockReason(bundleId: current) {
			throw ParadisHelperError(code: "app_blocked", message: "Computer Use never reads or operates this application (\(reason.rawValue))")
		}
		return pid
	}

	private func windowIdParam(_ params: [String: Any], required: Bool) throws -> UInt32? {
		guard let raw = params["windowId"] else {
			if required {
				throw ParadisHelperError.invalidArgument("\"windowId\" is required")
			}
			return nil
		}
		guard let windowId = paradisExactInt(raw), windowId > 0, windowId <= Int(UInt32.max) else {
			throw ParadisHelperError.invalidArgument("\"windowId\" must be a positive integer")
		}
		return UInt32(windowId)
	}

	private func allowedChord(_ chord: ParadisKeyChord) throws -> ParadisKeyChord {
		if let reason = paradisBlockedChordReason(chord) {
			throw ParadisHelperError(code: "key_blocked", message: reason)
		}
		return chord
	}

	private func targetParam(_ params: [String: Any], snapshot: [String: Any]) throws -> ParadisPointerTarget {
		if let raw = params["elementIndex"] {
			guard let index = paradisExactInt(raw), index >= 0, index < paradisMaxAXMaxNodes else {
				throw ParadisHelperError.invalidArgument("\"elementIndex\" must be an element number from the last accessibility tree")
			}
			guard let snapshotId = paradisExactInt(snapshot["snapshotId"]), snapshotId > 0 else {
				throw ParadisHelperError(code: "stale_element", message: "element numbers need the snapshot id of the accessibility tree they came from")
			}
			return .element(index, snapshotId: snapshotId)
		}
		guard let x = paradisFiniteNumber(params["x"]), let y = paradisFiniteNumber(params["y"]), x >= 0, y >= 0, x <= 100_000, y <= 100_000 else {
			throw ParadisHelperError.invalidArgument("give either \"elementIndex\" or \"x\" and \"y\" in points from the window's top-left corner")
		}
		return .point(x: x, y: y)
	}

	private func modifiersParam(_ params: [String: Any]) throws -> ParadisModifiers {
		guard let raw = params["modifiers"] else {
			return []
		}
		guard let names = raw as? [String], names.count <= 4 else {
			throw ParadisHelperError.invalidArgument("\"modifiers\" must be a list such as [\"cmd\", \"shift\"]")
		}
		var modifiers: ParadisModifiers = []
		for name in names {
			guard let modifier = paradisModifier(named: name), modifier != .function else {
				throw ParadisHelperError.invalidArgument("unknown modifier \"\(paradisSanitizeText(name, maxLength: 20))\"")
			}
			modifiers.insert(modifier)
		}
		return modifiers
	}

	private func enumParam<T>(_ params: [String: Any], _ name: String, _ make: (String) -> T?) throws -> T? {
		guard let raw = params[name] else {
			return nil
		}
		guard let text = raw as? String, let value = make(text) else {
			throw ParadisHelperError.invalidArgument("\"\(name)\" has an unknown value")
		}
		return value
	}

	private func optionalNumberParam(_ params: [String: Any], _ name: String, minimum: Double, maximum: Double) throws -> Double? {
		guard let raw = params[name] else {
			return nil
		}
		guard let value = paradisFiniteNumber(raw), value >= minimum, value <= maximum else {
			throw ParadisHelperError.invalidArgument("\"\(name)\" must be a number from \(minimum) to \(maximum)")
		}
		return value
	}

	private func optionalIntParam(_ params: [String: Any], _ name: String, minimum: Int, maximum: Int) throws -> Int? {
		guard let raw = params[name] else {
			return nil
		}
		guard let value = paradisExactInt(raw), value >= minimum, value <= maximum else {
			throw ParadisHelperError.invalidArgument("\"\(name)\" must be an integer from \(minimum) to \(maximum)")
		}
		return value
	}
}
