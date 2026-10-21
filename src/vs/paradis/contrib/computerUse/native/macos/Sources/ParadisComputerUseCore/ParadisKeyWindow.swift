/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 段目（背面）のキーの前に、目的のウィンドウをそのアプリのキーウィンドウにする手順（OS に触れない部分。実体は
// ParadisBackgroundRoute.swift と ParadisBackgroundTransport.swift）。
//
//  - E1: 対象のプロセスだけへイベントの記録（`SLPSPostEventRecordTo`）を送る。今のキーウィンドウへ「フォーカスを外す」、
//    目的のウィンドウへ「フォーカスを当てる」、続けて「キーにする」の 2 つ。利用者の前面のアプリには何も届かず、
//    アプリは前面に出ない。記録の作り方と順番は Cua Driver の `input/skylight.rs`（`post_window_key_records`）の写し
//    （出典と MIT の告知は THIRD_PARTY_NOTICES.md）
//  - E2（E1 で確かめられなかったとき）: アプリの `AXFocusedWindow` を書く
// どちらも、送った後に「アプリのフォーカスのあるウィンドウ」と「フォーカスのある要素が属するウィンドウ」の両方を
// 読み直し、どちらも目的のウィンドウでなければキーを送らない（同じアプリの別のウィンドウへ入らないように）。
// 終わったら、同じ手でキーウィンドウを元へ戻す。

import Foundation

/** イベントの記録の大きさ（バイト）。 */
let paradisEventRecordLength = 0xF8

/** フォーカスを当てる・外す記録。目的のウィンドウの番号を 0x3c〜0x3f に、向きを 0x8a に書く（1 が当てる、2 が外す）。 */
func paradisFocusRecord(windowId: UInt32, focus: Bool) -> [UInt8] {
	var record = [UInt8](repeating: 0, count: paradisEventRecordLength)
	record[0x04] = 0xF8
	record[0x08] = 0x0D
	paradisWriteWindowId(&record, windowId)
	record[0x8A] = focus ? 0x01 : 0x02
	return record
}

/** キーウィンドウにする記録（`kind` は 1 と 2 の 2 つを続けて送る）。 */
func paradisMakeKeyRecord(windowId: UInt32, kind: UInt8) -> [UInt8] {
	var record = [UInt8](repeating: 0, count: paradisEventRecordLength)
	record[0x04] = 0xF8
	record[0x08] = kind
	record[0x3A] = 0x10
	paradisWriteWindowId(&record, windowId)
	for index in 0x20..<0x30 {
		record[index] = 0xFF
	}
	return record
}

private func paradisWriteWindowId(_ record: inout [UInt8], _ windowId: UInt32) {
	for byte in 0..<4 {
		record[0x3C + byte] = UInt8((windowId >> (8 * UInt32(byte))) & 0xFF)
	}
}

/** アプリのキーボードのフォーカスがどこにあるか（AX で読んだもの）。 */
struct ParadisKeyFocus: Equatable {
	/** アプリの `AXFocusedWindow` の番号。 */
	let window: UInt32?
	/** アプリの `AXFocusedUIElement` が属するウィンドウの番号。 */
	let elementWindow: UInt32?

	/** キーが `target` へ行くと言い切れるか（両方が目的のウィンドウ）。 */
	func routes(to target: UInt32) -> Bool {
		return window == target && elementWindow == target
	}
}

/** 目的のウィンドウがどうやってキーウィンドウになったか。 */
enum ParadisKeyPrime: String, Equatable {
	case alreadyKey
	case keyRecords
	case axFocusedWindow
}

/** E1 の記録を送り直す回数の上限（WindowServer は非同期に届けるので、2 回目で前の処理中だったアプリを拾う）。 */
let paradisKeyRecordAttempts = 2

/**
 * 目的のウィンドウをアプリのキーウィンドウにし、キーを送る前に確かめる。`focus` は読み直し、`keyRecords` は E1 の記録を
 * 送って落ち着くのを待つ、`axFocus` は E2。どれも送った後に読み直し、目的のウィンドウと確かめられたときだけ返す。
 * 確かめられなければ `window_not_key`（キーは送らない）。
 */
func paradisPrimeWindowKey(target: UInt32, focus: () -> ParadisKeyFocus, keyRecords: () -> Bool, axFocus: () -> Bool) -> Result<ParadisKeyPrime, ParadisHelperError> {
	if focus().routes(to: target) {
		return .success(.alreadyKey)
	}
	for _ in 0..<paradisKeyRecordAttempts {
		if keyRecords() && focus().routes(to: target) {
			return .success(.keyRecords)
		}
	}
	if axFocus() && focus().routes(to: target) {
		return .success(.axFocusedWindow)
	}
	let now = focus()
	let describe: (UInt32?) -> String = { $0.map(String.init) ?? "none" }
	return .failure(ParadisHelperError(code: "window_not_key", message: "window \(target) could not be confirmed as the app's key window (its focused window is \(describe(now.window)), its focused element is in window \(describe(now.elementWindow))), so no keys were sent"))
}

/**
 * 終わった後にキーを戻すウィンドウ。ふつうは前のキーウィンドウ。それがもう画面に無ければ、前に画面に出ていた
 * ウィンドウのうち一番手前のもの（目的のウィンドウは除く）。どちらも無ければ nil（戻さない）。
 */
func paradisKeyRestoreTarget(target: UInt32, previous: UInt32?, orderBefore: [UInt32], onScreenNow: [UInt32]) -> UInt32? {
	let present: (UInt32) -> Bool = { $0 != target && onScreenNow.contains($0) }
	if let previous, present(previous) {
		return previous
	}
	return orderBefore.first(where: present)
}
