/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import Foundation

/** サーバースレッドのイベント間で中断通知を読む。別の要求の処理はここでは始めない。 */
enum ParadisRequestCancellation {
	static var poll: (() throws -> Void)?
	static func check() throws { try poll?() }
	static func failure() -> ParadisHelperError? {
		do { try check(); return nil }
		catch let error as ParadisHelperError { return error }
		catch { return ParadisHelperError(code: "cancelled", message: "the input connection closed") }
	}
}
