/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import Foundation

/** 要求の順番を保ちながら、処理中・待機中の要求 ID だけを中断する。 */
final class ParadisRequestQueue {
	private var pending: [(Data, Int?)] = []
	private var cancelled: Set<Int> = []
	private var activeId: Int?

	func append(_ lines: [Data], authenticated: Bool) throws -> [Data] {
		var replies: [Data] = []
		for line in lines {
			let parsed = try? paradisParseRequest(line).get()
			if authenticated, let request = parsed, request.method == "cancel" {
				guard let id = paradisExactInt(request.params["requestId"]) else {
					replies.append(paradisEncodeFailure(id: request.id, error: .invalidArgument("requestId must be an integer")))
					continue
				}
				if activeId == id || pending.contains(where: { $0.1 == id }) { cancelled.insert(id) }
				replies.append(paradisEncodeSuccess(id: request.id, result: ["cancelRequested": true]))
			} else {
				guard pending.count < 128 else {
					replies.append(paradisEncodeFailure(id: parsed?.id, error: ParadisHelperError(code: "queue_full", message: "too many queued requests", sent: parsed?.method == "typeText" ? 0 : nil)))
					continue
				}
				pending.append((line, parsed?.id))
			}
		}
		return replies
	}

	func next() -> Data? {
		guard !pending.isEmpty else { return nil }
		let (line, id) = pending.removeFirst()
		activeId = id
		return line
	}

	func check() throws {
		if let activeId, cancelled.contains(activeId) {
			throw ParadisHelperError(code: "cancelled", message: "this request was cancelled")
		}
	}

	func finish() {
		if let activeId { cancelled.remove(activeId) }
		activeId = nil
	}
}
