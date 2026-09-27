/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動の引数と、1 本の接続で受けた要求の振り分け。
//
// 今の版で受ける命令は読み取りだけ（状態・許可の確認・アプリとウィンドウの一覧・単一ウィンドウのスクショ・
// アクセシビリティのツリー）。クリックや文字入力はまだ無い。

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

	var json: [String: Any] {
		return ["accessibility": accessibility ? "granted" : "not-granted", "screenRecording": screenRecording ? "granted" : "not-granted"]
	}
}

protocol ParadisDesktopBackend: AnyObject {
	func permissions() -> ParadisPermissionSnapshot
	func responsibility() -> (ParadisResponsibility, Int32?)
	func osVersion() -> String
	func listApps() -> [[String: Any]]
	func listWindows(pid: Int32) throws -> [[String: Any]]
	func screenshotWindow(pid: Int32, windowId: UInt32, maxLongEdge: Int) throws -> [String: Any]
	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int) throws -> [String: Any]
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
		case "accessibilityTree":
			let maxNodes = try optionalIntParam(params, "maxNodes", minimum: 1, maximum: paradisMaxAXMaxNodes) ?? paradisDefaultAXMaxNodes
			let maxDepth = try optionalIntParam(params, "maxDepth", minimum: 1, maximum: paradisMaxAXMaxDepth) ?? paradisDefaultAXMaxDepth
			return try backend.accessibilityTree(pid: try pidParam(params), windowId: try windowIdParam(params, required: false), maxNodes: maxNodes, maxDepth: maxDepth)
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
		guard let pid = paradisExactInt(params["pid"]), pid > 0, pid <= Int(Int32.max) else {
			throw ParadisHelperError.invalidArgument("\"pid\" must be a positive integer")
		}
		// 自分自身は読ませない（補助アプリのウィンドウは無いが、念のため）
		guard pid != Int(selfPid) else {
			throw ParadisHelperError(code: "app_blocked", message: "the Computer Use helper cannot be inspected")
		}
		return Int32(pid)
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
