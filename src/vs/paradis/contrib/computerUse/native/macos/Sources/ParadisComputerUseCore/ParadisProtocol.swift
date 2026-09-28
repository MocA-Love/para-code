/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の補助アプリと shared process の間の約束（1 行 1 JSON）。
//
// 要求: {"id": <整数>, "method": "<名前>", "params": {...}}
// 応答: {"id": <整数>, "ok": true, "result": {...}} か {"id": <整数>, "ok": false, "error": {"code": "...", "message": "..."}}
//
// 最初の要求は必ず handshake で、params.token に起動時に渡したトークンを入れる。
// 版を上げるときは TS 側の PARADIS_COMPUTER_USE_PROTOCOL_VERSION（common/paradisComputerUse.ts）も同じ値にする。
// build/paradis/computerUse/buildHelper.test.ts が2つの値の一致を確かめる。

import Foundation

enum ParadisComputerUseVersion {
	/** shared process との約束の版。handshake で突き合わせる。 */
	static let protocolVersion = 5
	/** 補助アプリ自身の版（報告用）。 */
	static let helperVersion = "0.5.0"
}

/** 補助アプリが返す失敗。code は TS 側がそのまま読む英字の識別子。 */
struct ParadisHelperError: Error, Equatable {
	let code: String
	let message: String
	/** 長い入力を途中で止めたとき、送り終えた単位の数（文字入力なら文字数）。 */
	var progress: Int? = nil

	static func invalidArgument(_ message: String) -> ParadisHelperError {
		return ParadisHelperError(code: "invalid_argument", message: message)
	}
}

/** 読み取った要求 1 件。 */
struct ParadisRequest {
	let id: Int
	let method: String
	let params: [String: Any]
}

/** 1 行を要求として読む。読めなければ理由を返す（id が読めたときはそれも）。 */
func paradisParseRequest(_ line: Data) -> Result<ParadisRequest, ParadisRequestParseFailure> {
	guard let object = try? JSONSerialization.jsonObject(with: line, options: []) else {
		return .failure(ParadisRequestParseFailure(id: nil, error: ParadisHelperError(code: "invalid_request", message: "request is not valid JSON")))
	}
	guard let dictionary = object as? [String: Any] else {
		return .failure(ParadisRequestParseFailure(id: nil, error: ParadisHelperError(code: "invalid_request", message: "request must be a JSON object")))
	}
	guard let id = paradisExactInt(dictionary["id"]) else {
		return .failure(ParadisRequestParseFailure(id: nil, error: ParadisHelperError(code: "invalid_request", message: "request id must be an integer")))
	}
	guard let method = dictionary["method"] as? String, !method.isEmpty else {
		return .failure(ParadisRequestParseFailure(id: id, error: ParadisHelperError(code: "invalid_request", message: "request method must be a string")))
	}
	let params: [String: Any]
	if let raw = dictionary["params"] {
		guard let dictionaryParams = raw as? [String: Any] else {
			return .failure(ParadisRequestParseFailure(id: id, error: ParadisHelperError(code: "invalid_request", message: "request params must be an object")))
		}
		params = dictionaryParams
	} else {
		params = [:]
	}
	return .success(ParadisRequest(id: id, method: method, params: params))
}

struct ParadisRequestParseFailure: Error {
	let id: Int?
	let error: ParadisHelperError
}

/** 成功の応答を 1 行にする（末尾に改行を付ける）。 */
func paradisEncodeSuccess(id: Int, result: Any) -> Data {
	return paradisEncodeLine(["id": id, "ok": true, "result": result])
}

/** 失敗の応答を 1 行にする。id が読めなかった要求には null を返す。 */
func paradisEncodeFailure(id: Int?, error: ParadisHelperError) -> Data {
	let idValue: Any = id.map { $0 as Any } ?? NSNull()
	var errorJson: [String: Any] = ["code": error.code, "message": error.message]
	if let progress = error.progress {
		errorJson["progress"] = progress
	}
	return paradisEncodeLine(["id": idValue, "ok": false, "error": errorJson])
}

private func paradisEncodeLine(_ object: [String: Any]) -> Data {
	let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
	guard JSONSerialization.isValidJSONObject(object), var data = try? JSONSerialization.data(withJSONObject: object, options: options) else {
		// 結果に JSON にできない値が混ざったとき。呼び出し側の誤りなので中身は返さない
		let fallback: [String: Any] = ["id": object["id"] ?? NSNull(), "ok": false, "error": ["code": "internal_error", "message": "result could not be encoded"]]
		var data = (try? JSONSerialization.data(withJSONObject: fallback, options: options)) ?? Data()
		data.append(0x0A)
		return data
	}
	data.append(0x0A)
	return data
}

/** JSON の数を、小数や真偽値でない整数としてだけ読む。 */
func paradisExactInt(_ value: Any?) -> Int? {
	guard let number = value as? NSNumber else {
		return nil
	}
	// JSONSerialization は true/false も NSNumber で返すので、真偽値を除く
	if CFGetTypeID(number) == CFBooleanGetTypeID() {
		return nil
	}
	let double = number.doubleValue
	guard double.isFinite, double == double.rounded(), abs(double) <= 9_007_199_254_740_991 else {
		return nil
	}
	return Int(double)
}

/** JSON の数を有限の実数として読む（真偽値は除く）。 */
func paradisFiniteNumber(_ value: Any?) -> Double? {
	guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
		return nil
	}
	let double = number.doubleValue
	return double.isFinite ? double : nil
}

// MARK: - 行の切り出し

/** 受け取ったバイト列を改行で切る。1 行が上限を超えたら読むのをやめる（相手を切る）。 */
struct ParadisLineBuffer {
	enum Failure: Error, Equatable {
		case lineTooLong
	}

	private var pending = Data()
	let maxLineBytes: Int

	init(maxLineBytes: Int) {
		self.maxLineBytes = maxLineBytes
	}

	/** 足した結果そろった行を返す。空の行は飛ばす。 */
	mutating func append(_ chunk: Data) throws -> [Data] {
		pending.append(chunk)
		var lines: [Data] = []
		while let newline = pending.firstIndex(of: 0x0A) {
			let line = pending[pending.startIndex..<newline]
			pending.removeSubrange(pending.startIndex...newline)
			if line.count > maxLineBytes {
				throw Failure.lineTooLong
			}
			if !line.isEmpty {
				lines.append(Data(line))
			}
		}
		if pending.count > maxLineBytes {
			throw Failure.lineTooLong
		}
		return lines
	}
}

// MARK: - トークン

/** 256 bit の乱数を 16 進 64 文字にしたものか。 */
func paradisIsWellFormedToken(_ token: String) -> Bool {
	guard token.utf8.count == 64 else {
		return false
	}
	return token.utf8.allSatisfy { byte in
		(byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)
	}
}

/** 長さ以外の情報を時間で漏らさないように比べる。 */
func paradisTokensEqual(_ left: String, _ right: String) -> Bool {
	let a = Array(left.utf8)
	let b = Array(right.utf8)
	guard a.count == b.count else {
		return false
	}
	var difference: UInt8 = 0
	for index in 0..<a.count {
		difference |= a[index] ^ b[index]
	}
	return difference == 0
}
