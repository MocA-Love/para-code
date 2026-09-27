/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 入力（クリック・キー・文字）の決まり（設計書 6.3）。OS に触れない純粋な判断だけをここに置き、テストで確かめる。
//
//  - 送らないキーの組み合わせ（Spotlight・アプリの切替・強制終了・画面ロック・画面収録・操作スペースの切替・ログアウト・Fn）
//  - 修飾キーはイベントのフラグで付ける（押しっぱなしのイベントは作らない）。ここでは組み合わせを表すだけ
//  - 文字入力は 4,000 文字まで。改行は Return、タブは Tab のキーとして送る
//  - 利用者の物理的な入力が直前 1 秒以内にあれば送らない（Q101）

import Foundation

// MARK: - 修飾キーとキー

struct ParadisModifiers: OptionSet, Equatable {
	let rawValue: Int
	static let command = ParadisModifiers(rawValue: 1 << 0)
	static let shift = ParadisModifiers(rawValue: 1 << 1)
	static let option = ParadisModifiers(rawValue: 1 << 2)
	static let control = ParadisModifiers(rawValue: 1 << 3)
	/** Fn / 地球儀キー。組み合わせは常に送らない。 */
	static let function = ParadisModifiers(rawValue: 1 << 4)
}

/** 修飾キーの名前を読む。修飾キーでなければ nil。 */
func paradisModifier(named name: String) -> ParadisModifiers? {
	switch name.lowercased() {
	case "cmd", "command", "meta", "super":
		return .command
	case "shift":
		return .shift
	case "alt", "option", "opt":
		return .option
	case "ctrl", "control":
		return .control
	case "fn", "globe", "function":
		return .function
	default:
		return nil
	}
}

/** US 配列の仮想キーコード（Carbon の kVK_*）。 */
private let paradisKeyCodes: [String: UInt16] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
	"y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
	",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "escape": 53,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
	"home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
]

private let paradisKeyAliases: [String: String] = [
	"enter": "return", "esc": "escape", "backspace": "delete", "del": "forwarddelete", " ": "space",
	"arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down", "page_up": "pageup", "page_down": "pagedown",
]

/** キーの名前を仮想キーコードにする。知らない名前は nil。 */
func paradisKeyCode(named name: String) -> UInt16? {
	let lower = name.lowercased()
	let canonical = paradisKeyAliases[lower] ?? lower
	return paradisKeyCodes[canonical]
}

let paradisKeyCodeReturn: UInt16 = 36
let paradisKeyCodeTab: UInt16 = 48
let paradisKeyCodeSpace: UInt16 = 49
let paradisKeyCodeEscape: UInt16 = 53
let paradisKeyCodeGrave: UInt16 = 50
let paradisKeyCodeV: UInt16 = 9
private let paradisKeyCodeQ: UInt16 = 12
private let paradisArrowKeyCodes: Set<UInt16> = [123, 124, 125, 126]
private let paradisScreenshotKeyCodes: Set<UInt16> = [20, 21, 23, 22] // 3 4 5 6

/** 1 回で押すキーの組み合わせ。 */
struct ParadisKeyChord: Equatable {
	let keyCode: UInt16
	let modifiers: ParadisModifiers
}

/**
 * `["cmd", "shift", "k"]` のような並びを読む。修飾キー以外がちょうど 1 つあること。
 * 知らない名前は invalid_argument。
 */
func paradisParseChord(_ keys: [String]) throws -> ParadisKeyChord {
	var modifiers: ParadisModifiers = []
	var keyCode: UInt16?
	for name in keys {
		if let modifier = paradisModifier(named: name) {
			modifiers.insert(modifier)
			continue
		}
		guard let code = paradisKeyCode(named: name) else {
			throw ParadisHelperError.invalidArgument("unknown key \"\(paradisSanitizeText(name, maxLength: 20))\"")
		}
		guard keyCode == nil else {
			throw ParadisHelperError.invalidArgument("a hotkey takes modifiers and exactly one other key")
		}
		keyCode = code
	}
	guard let keyCode else {
		throw ParadisHelperError.invalidArgument("a hotkey needs one key besides the modifiers")
	}
	return ParadisKeyChord(keyCode: keyCode, modifiers: modifiers)
}

/**
 * 送らない組み合わせなら理由を返す（設計書 6.3）。任意のアプリの起動・アプリの切替・画面の外への操作に
 * つながるものは、承認したアプリの中の操作という前提を崩すため。
 */
func paradisBlockedChordReason(_ chord: ParadisKeyChord) -> String? {
	let m = chord.modifiers
	let key = chord.keyCode
	if m.contains(.function) {
		return "Fn / Globe key combinations are never sent"
	}
	if key == paradisKeyCodeSpace && (m.contains(.command) || m.contains(.control)) {
		return "Spotlight and input source shortcuts are never sent"
	}
	if m.contains(.command) && (key == paradisKeyCodeTab || key == paradisKeyCodeGrave) {
		return "app and window switching shortcuts are never sent"
	}
	if m.contains(.command) && m.contains(.option) && key == paradisKeyCodeEscape {
		return "Force Quit is never sent"
	}
	if key == paradisKeyCodeQ && m.contains(.command) && (m.contains(.control) || m.contains(.shift)) {
		return "lock screen and log out shortcuts are never sent"
	}
	if m.contains(.command) && m.contains(.shift) && paradisScreenshotKeyCodes.contains(key) {
		return "screenshot shortcuts are never sent"
	}
	if m.contains(.control) && paradisArrowKeyCodes.contains(key) {
		return "Mission Control and Space switching shortcuts are never sent"
	}
	return nil
}

// MARK: - 文字入力

/** 1 回の type_text の最大文字数。 */
let paradisMaxTypeTextLength = 4_000
/** 1 回の paste_text の最大文字数（貼り付けは 1 回の ⌘V なので長めに許す）。 */
let paradisMaxPasteTextLength = 20_000

enum ParadisTypedUnit: Equatable {
	/** 1 文字（書記素）をそのまま打つ。 */
	case text(String)
	/** キーとして押す（改行・タブ）。 */
	case key(UInt16)
}

/** 文字列を打つ単位に分ける。制御文字（改行とタブ以外）は断る。 */
func paradisTypedUnits(_ text: String) throws -> [ParadisTypedUnit] {
	guard !text.isEmpty else {
		throw ParadisHelperError.invalidArgument("\"text\" must not be empty")
	}
	guard text.count <= paradisMaxTypeTextLength else {
		throw ParadisHelperError.invalidArgument("\"text\" is longer than \(paradisMaxTypeTextLength) characters; use pasteText for long text")
	}
	var units: [ParadisTypedUnit] = []
	for character in text {
		switch character {
		case "\n", "\r\n", "\r":
			units.append(.key(paradisKeyCodeReturn))
		case "\t":
			units.append(.key(paradisKeyCodeTab))
		default:
			let isControl = character.unicodeScalars.contains { scalar in
				scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .lineSeparator || scalar.properties.generalCategory == .paragraphSeparator
			}
			if isControl {
				throw ParadisHelperError.invalidArgument("\"text\" contains a control character")
			}
			units.append(.text(String(character)))
		}
	}
	return units
}

// MARK: - 利用者の操作（Q101）

/** 直前にこの時間以内の物理的な入力があれば、合成入力を送らない。 */
let paradisUserActivityWindow: Double = 1.0

/**
 * 利用者が操作中か。`secondsSinceLastInput` は OS が数えた最後の入力からの秒数、
 * `secondsSinceOurLastEvent` はこの補助アプリが最後に送った合成入力からの秒数（まだ送っていなければ nil）。
 * 合成入力も OS の数に入ることがあるので、最後の入力が自分の送ったもの以前なら利用者の入力とみなさない。
 */
func paradisUserIsActive(secondsSinceLastInput: Double, secondsSinceOurLastEvent: Double?, margin: Double = 0.05) -> Bool {
	guard secondsSinceLastInput < paradisUserActivityWindow else {
		return false
	}
	if let ours = secondsSinceOurLastEvent, secondsSinceLastInput + margin >= ours {
		return false
	}
	return true
}

// MARK: - 前面の確認（フェンス）

/**
 * 送ってよいか。前面のアプリが目的の pid で、その点（無ければキーの届く一番手前の通常のウィンドウ）の
 * 持ち主も目的の pid であること。違えば理由の code を返す。
 */
func paradisFenceFailure(targetPid: Int32, frontmostPid: Int32?, ownerAtTarget: Int32?) -> ParadisHelperError? {
	guard frontmostPid == targetPid else {
		return ParadisHelperError(code: "window_not_focused", message: "the application is not in front; bring it forward with activateApp first")
	}
	guard ownerAtTarget == targetPid else {
		return ParadisHelperError(code: "point_obscured", message: "another window covers the target")
	}
	return nil
}

// MARK: - スクロールとドラッグ

enum ParadisScrollDirection: String {
	case up, down, left, right
}

/** 1 回のスクロールのイベントで動かす量（ピクセル）。 */
private let paradisScrollStepPixels = 80.0

/**
 * スクロールのイベントの並び（ピクセル、正は上・左へ戻す向き）。`extent` はウィンドウの高さか幅（ポイント）。
 * 1 ページはその 8 割。
 */
func paradisScrollSteps(direction: ParadisScrollDirection, pages: Double, extent: Double) -> [(dx: Int32, dy: Int32)] {
	let total = max(1, pages * max(extent, 100) * 0.8)
	let count = min(100, max(1, Int((total / paradisScrollStepPixels).rounded(.up))))
	let step = Int32((total / Double(count)).rounded())
	switch direction {
	case .up:
		return Array(repeating: (0, step), count: count)
	case .down:
		return Array(repeating: (0, -step), count: count)
	case .left:
		return Array(repeating: (step, 0), count: count)
	case .right:
		return Array(repeating: (-step, 0), count: count)
	}
}

/** ドラッグの途中の点（始点を除き終点を含む）。 */
func paradisDragPath(from: (x: Double, y: Double), to: (x: Double, y: Double), steps: Int) -> [(x: Double, y: Double)] {
	let count = max(1, steps)
	return (1...count).map { index in
		let t = Double(index) / Double(count)
		return (from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
	}
}

// MARK: - 貼り付け（Q100）

/**
 * 貼った後にクリップボードを元へ戻すか。自分が書いた後の変更回数から変わっていれば、
 * ほかのアプリか利用者が書き換えたので、そちらを優先して戻さない。
 */
func paradisShouldRestoreClipboard(changeCountAfterOurWrite: Int, currentChangeCount: Int) -> Bool {
	return changeCountAfterOurWrite == currentChangeCount
}
