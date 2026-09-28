/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 入力（クリック・キー・文字）の決まり（設計書 6.3）。OS に触れない純粋な判断だけをここに置き、テストで確かめる。
//
//  - 送らないキーの組み合わせ（Spotlight・アプリの切替・強制終了・画面ロック・画面収録・操作スペースの切替・ログアウト・Fn、
//    メニューバー・Dock へのキーボード操作、アクセシビリティの切り替え、貼り付け）
//  - 修飾キーはイベントのフラグで付ける（押しっぱなしのイベントは作らない）。ここでは組み合わせを表すだけ
//  - 文字入力は 4,000 文字まで。改行は Return、タブは Tab のキーとして送る
//  - 利用者の物理的な入力が直前 1 秒以内にあれば送らない（Q101）。長い操作の途中も確かめる
//  - キーの前に、認証・同意のダイアログや、目的のウィンドウに重なるほかのプロセスのパネルが無いことを確かめる

import CoreGraphics
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
/** F1〜F12。 */
private let paradisFunctionKeyCodes: Set<UInt16> = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
private let paradisKeyCodeF5: UInt16 = 96
private let paradisKeyCodeD: UInt16 = 2
private let paradisKeyCode8: UInt16 = 28
/** = - , .（ズームとコントラストのショートカット）。 */
private let paradisZoomKeyCodes: Set<UInt16> = [24, 27, 43, 47]

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
 * 送らない組み合わせなら理由を返す（設計書 6.3、レビュー M4・M5）。任意のアプリの起動・アプリの切替・
 * メニューバーや Dock へのキーボード操作・アクセシビリティの切り替えなど、承認したアプリの中の操作という
 * 前提を崩すもの。⌘V の仲間は、利用者のクリップボード（パスワードなど）を承認済みのアプリへ貼って読めるので、
 * 貼り付けの命令（pasteText）の中でだけ使う（`allowPaste`）。
 */
func paradisBlockedChordReason(_ chord: ParadisKeyChord, allowPaste: Bool = false) -> String? {
	let m = chord.modifiers
	let key = chord.keyCode
	if !allowPaste && key == paradisKeyCodeV && m.contains(.command) {
		return "paste shortcuts are never sent; use pasteText"
	}
	if m.contains(.control) && paradisFunctionKeyCodes.contains(key) {
		return "keyboard navigation to the menu bar, Dock and other system areas is never sent"
	}
	if m.contains(.command) && key == paradisKeyCodeF5 {
		return "VoiceOver and accessibility shortcuts are never sent"
	}
	if m.contains(.command) && m.contains(.option) && key == paradisKeyCodeD {
		return "Dock shortcuts are never sent"
	}
	if m.contains(.command) && m.contains(.option) && (key == paradisKeyCode8 || paradisZoomKeyCodes.contains(key)) {
		return "zoom, color and contrast accessibility shortcuts are never sent"
	}
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
	/** 1 文字（書記素）をそのまま打つ。改行は改行の文字（`\n`）で、Return は押さない。 */
	case text(String)
}

/**
 * 文字列を打つ単位に分ける。改行はどの経路でも改行の文字として入れる（送信は `pressKey` の return で行う、と
 * 利用者と合意している）。タブは断る: キーでは次の欄へ移り、AX と貼り付けでは欄にタブ文字が入るので、
 * `ユーザー名\tパスワード` のような文字列でパスワードが普通の欄に文字として入りうるため（ベータ 3 のレビュー M1）。
 */
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
			units.append(.text("\n"))
		case "\t":
			throw ParadisHelperError.invalidArgument("\"text\" must not contain tabs; press tab with pressKey to move between fields")
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
 * 補助アプリが送るイベントに付ける目印（`eventSourceUserData`）。入力の見張り（イベントタップ）は、
 * この目印の無いイベントを利用者の物理的な入力とみなす。自分の分を時刻で除く判定はしない
 * （連続した入力の間に利用者の入力を見逃すため。レビュー M2）。
 */
let paradisSyntheticEventMarker: Int64 = 0x5041_5241_4355 // "PARACU"

/** そのイベントが補助アプリの送ったものか（目印と、送り元のプロセスが自分であること。レビュー N8）。 */
func paradisIsOurEvent(userData: Int64, sourcePid: Int64, selfPid: Int32) -> Bool {
	return userData == paradisSyntheticEventMarker && sourcePid == Int64(selfPid)
}

/**
 * 利用者の最後の物理的な入力からの秒数を、見張り（イベントタップ）と OS の HID の数から決める（レビュー N6・N7）。
 *  - キーボード: タップにキーのイベントが一度でも届いた（自分の送ったものを含む）なら、タップの値。まだなら
 *    HID の値（タップにキーが届かない構成＝入力監視の許可が無いなどで、利用者のキー入力を見逃さないため）。
 *    HID の値は自分の合成入力を含みうるので、止まる側に倒れる
 *  - マウス: タップを作ってから 1 秒の間は、作る前の入力を見るため HID の値も合わせる
 *  - タップが無ければ、どちらも HID の値
 */
func paradisPhysicalInputAge(tapKeyboard: Double?, tapPointer: Double?, hidKeyboard: Double?, hidPointer: Double?, tapSawKeyboard: Bool, secondsSinceTapStarted: Double?) -> Double? {
	func minimum(_ values: Double?...) -> Double? {
		return values.compactMap { $0 }.min()
	}
	guard let tapAge = secondsSinceTapStarted else {
		return minimum(hidKeyboard, hidPointer)
	}
	let keyboard = tapSawKeyboard ? tapKeyboard : hidKeyboard
	let pointer = tapAge < paradisUserActivityWindow ? minimum(tapPointer, hidPointer) : tapPointer
	return minimum(keyboard, pointer)
}

/**
 * 利用者が操作中か。`secondsSincePhysicalInput` は、目印の無い最後の入力からの秒数（見張りが無ければ、
 * OS が数えたハードウェアの入力からの秒数）。自分の合成入力は含めない。
 */
func paradisUserIsActive(secondsSincePhysicalInput: Double?) -> Bool {
	guard let seconds = secondsSincePhysicalInput else {
		return false
	}
	return seconds < paradisUserActivityWindow
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

// MARK: - キーの前の確かめ（レビュー M3）

/** 画面に出ているウィンドウ 1 つ。 */
struct ParadisScreenWindow {
	let pid: Int32
	let ownerName: String
	let bundleId: String?
	let layer: Int
	let bounds: CGRect
}

/**
 * 認証・同意・ロックの画面を出すプロセスの bundle id と名前。出ている間は入力を送らない。名前でも見るのは
 * 止める側だけ（名前を偽っても止まるだけで、通るようにはならない）。
 * 【要確認】AuthenticationServicesAgent 以降（レビュー N14）の名前と bundle id の実在。
 */
let paradisSensitiveOverlayBundleIds: Set<String> = [
	"com.apple.SecurityAgent", "com.apple.LocalAuthentication.UIAgent", "com.apple.UserNotificationCenter",
	"com.apple.coreservices.uiagent", "com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "com.apple.universalaccessAuthWarn",
	"com.apple.AuthenticationServicesCore.AuthenticationServicesAgent", "com.apple.AuthKitUI.AKAuthorizationRemoteViewService",
	"com.apple.PassKit.PaymentAuthorizationUIExtension", "com.apple.BluetoothUIServer", "com.apple.CoreLocationAgent",
]
let paradisSensitiveOverlayOwnerNames: Set<String> = [
	"SecurityAgent", "coreautha", "UserNotificationCenter", "CoreServicesUIAgent", "loginwindow", "ScreenSaverEngine", "universalAccessAuthWarn",
	"AuthenticationServicesAgent", "AuthKitUIService", "PassKitUIService", "BluetoothUIServer", "CoreLocationAgent",
]

/**
 * 認証・同意の画面がどこかに出ていれば止める（レビュー M3）。重なるだけのほかのパネル（常駐の浮いたウィンドウなど）では
 * 止めない。キーの行き先は、OS に聞いたフォーカスのある要素で確かめる（レビュー N4）。
 */
func paradisOverlayFailure(targetPid: Int32, windows: [ParadisScreenWindow]) -> ParadisHelperError? {
	for window in windows where window.pid != targetPid {
		if paradisSensitiveOverlayOwnerNames.contains(window.ownerName) || window.bundleId.map({ paradisSensitiveOverlayBundleIds.contains($0) }) == true {
			return ParadisHelperError(code: "system_dialog", message: "an authentication or permission dialog is on screen")
		}
	}
	return nil
}

/**
 * キーの行き先が目的の pid か。OS に聞いたフォーカスのあるアプリと、フォーカスのある要素の持ち主の両方が
 * 目的の pid であること（要素はほかのプロセスのパネルがキーを取っているときに違う pid になる）。
 */
func paradisFocusFailure(targetPid: Int32, focusedApplicationPid: Int32?, focusedElementPid: Int32?) -> ParadisHelperError? {
	guard focusedApplicationPid == targetPid, focusedElementPid == targetPid else {
		return ParadisHelperError(code: "window_not_focused", message: "keyboard focus is not in the application")
	}
	return nil
}

/** 長い入力で、画面とフォーカスの確かめを行う間隔（利用者の入力は毎回見る。レビュー N5）。 */
let paradisFullFenceEveryUnits = 10
let paradisFullFenceEverySeconds: Double = 0.05

/** その単位の前に、画面とフォーカスを確かめ直すか。 */
func paradisNeedsFullFence(unitIndex: Int, secondsSinceLastFullFence: Double?) -> Bool {
	guard let elapsed = secondsSinceLastFullFence else {
		return true
	}
	return unitIndex % paradisFullFenceEveryUnits == 0 || elapsed >= paradisFullFenceEverySeconds
}

/**
 * クリックの的がメニューの「ペースト」か（レビュー N11）。⌘V を断っても、メニューや右クリックの「ペースト」を
 * クリックすれば利用者のクリップボードを貼れるので、これも断る。キーの割り当てが V で ⌘ を含む項目と、よくある名前。
 */
func paradisIsPasteMenuItem(role: String?, commandCharacter: String?, commandModifiers: Int?, title: String?) -> Bool {
	guard role == "AXMenuItem" else {
		return false
	}
	// AXMenuItemCmdModifiers は ⌘ を「付けない」ときに 8（kAXMenuItemModifierNoCommand）を立てる
	if commandCharacter?.uppercased() == "V", (commandModifiers ?? 0) & 8 == 0 {
		return true
	}
	let names = ["paste", "ペースト", "貼り付け", "貼付け"]
	let lower = (title ?? "").lowercased()
	return names.contains { lower.hasPrefix($0) }
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

/** 貼り付けの後、クリップボードをどうするか。 */
enum ParadisClipboardPlan: String {
	/** 元の中身へ戻す。 */
	case restore = "restored"
	/** 戻すが、写せなかった型がある。 */
	case restorePartial = "restored-partially"
	/** ほかのアプリか利用者が書き換えたので、そちらを残す。 */
	case keepOthers = "changed-by-others"
	/** 元の中身がパスワードマネージャーの印付きだったので、戻さずに空にする（遅れて貼られても秘密が出ないように）。 */
	case clear = "cleared"
}

/**
 * 貼った後のクリップボードの扱い（Q100、レビュー M6）。自分が書いた後に変更回数が変わっていれば、
 * ほかのアプリか利用者が書き換えたのでそちらを優先する。
 */
func paradisClipboardRestorePlan(changeCountAfterOurWrite: Int, currentChangeCount: Int, savedIsConcealed: Bool, savedIsComplete: Bool) -> ParadisClipboardPlan {
	guard changeCountAfterOurWrite == currentChangeCount else {
		return .keepOthers
	}
	if savedIsConcealed {
		return .clear
	}
	return savedIsComplete ? .restore : .restorePartial
}

// MARK: - 文字入力の確かめ（ベータの実機で文字が落ちた件）

/** 文字入力をどの経路で入れたか。 */
enum ParadisTypeMethod: String {
	/** フォーカスのある欄の選択範囲を AX で置き換えた（キーも IME も通らない）。 */
	case accessibility
	/** クリップボード経由で貼り付けた（IME が有効なとき）。 */
	case paste
	/** 1 文字ずつキーのイベントを送った。 */
	case keys
}

/**
 * 今の入力ソースが IME（日本語入力など）か。IME はキーのイベントを取り込んで変換するので、英数字でも
 * 1 文字ずつのキーでは文字が落ちたり変わったりしうる。そのときは貼り付けに寄せる。
 * `sourceType` は `kTISPropertyInputSourceType` の値、`sourceId` は `kTISPropertyInputSourceID` の値。
 */
func paradisIsInputMethodActive(sourceType: String?, sourceId: String?) -> Bool {
	if let sourceType, sourceType != "TISTypeKeyboardLayout" {
		return true
	}
	return sourceId?.lowercased().contains(".inputmethod.") == true
}

/** 入れた後に読み戻した結果。`verified` が nil なら確かめられなかった。 */
struct ParadisTypingCheck: Equatable {
	let verified: Bool?
	/** 実際に増えた文字数（読み戻せたときだけ）。 */
	let inserted: Int?
	/** アプリが書き換えた（スマート引用符・自動修正・補完・整形など）。`verified` が true でも付く。 */
	var rewritten: Bool = false
}

/** 改行を `\n` にそろえる（AX と貼り付けへ渡す前にも、比べる前にもかける。ベータ 3 のレビュー L2）。 */
func paradisNormalizeTypedText(_ text: String) -> String {
	return text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
}

/**
 * アプリが自動で書き換えうる違いを畳む（スマート引用符・ダッシュ・省略記号・空白・大文字小文字・
 * 数字の整形の区切り）。比べるためだけに使う。
 */
func paradisLooseText(_ text: String) -> String {
	var result = ""
	for scalar in text.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars {
		switch scalar {
		case "\u{201C}", "\u{201D}", "\u{201E}", "\u{00AB}", "\u{00BB}":
			result.append("\"")
		case "\u{2018}", "\u{2019}", "\u{201A}":
			result.append("'")
		case "\u{2013}", "\u{2014}", "\u{2212}", "-":
			// ダッシュは数字の区切りと同じく落とす（`--` が `—` になる書き換えを畳む）
			continue
		case "\u{2026}", ".":
			continue
		default:
			// 空白と、電話番号・カード番号の欄が足す区切りは落とす
			if scalar.properties.isWhitespace || "()/".unicodeScalars.contains(scalar) {
				continue
			}
			result.unicodeScalars.append(scalar)
		}
	}
	return result
}

private func paradisOccurrences(of needle: String, in haystack: String) -> Int {
	guard !needle.isEmpty else {
		return 0
	}
	var count = 0
	var range = haystack.startIndex..<haystack.endIndex
	while let found = haystack.range(of: needle, range: range) {
		count += 1
		range = found.upperBound..<haystack.endIndex
	}
	return count
}

/**
 * 入れる前の値と選択範囲（UTF-16 の位置と長さ）、入れた後の値から、文字列が入ったかを判断する（ベータ 3 のレビュー M2・L1）。
 *  - 前後（選択範囲の外）が残っていれば、その間を「入った部分」として取り出し、送った文字列と比べる。完全に同じなら成功。
 *    アプリの書き換えを畳んで同じか、入った部分が送った文字列を含む（補完で後ろが伸びた）なら、成功で `rewritten`
 *  - 長さが同じで中身だけ違えば、アプリが書き換えた（自動修正など）として失敗で `rewritten`
 *  - 前後が崩れた・選択範囲が読めないときは、送った文字列の出てくる回数が増えたかで見る
 *  - 値が変わっていなければ確かめられない（遅れて入るかもしれない）。読めなくても確かめられない
 * 「入っていない」と言うのは、値が変わって、しかも送った文字列が見つからないときだけ（入れ直すと二重になるため）。
 */
func paradisTypingOutcome(before: String?, selection: (location: Int, length: Int)?, after: String?, text: String) -> ParadisTypingCheck {
	guard let before, let after else {
		return ParadisTypingCheck(verified: nil, inserted: nil)
	}
	let typed = paradisNormalizeTypedText(text)
	if let selection {
		let beforeUnits = Array(before.utf16)
		let start = max(0, min(selection.location, beforeUnits.count))
		let end = max(start, min(start + selection.length, beforeUnits.count))
		let prefix = String(utf16CodeUnits: Array(beforeUnits[0..<start]), count: start)
		let suffix = String(utf16CodeUnits: Array(beforeUnits[end...]), count: beforeUnits.count - end)
		if prefix + typed + suffix == before {
			// 選択範囲と同じ文字列で置き換えた。変わらないのが正しい
			return ParadisTypingCheck(verified: true, inserted: typed.count)
		}
		if after == before {
			return ParadisTypingCheck(verified: nil, inserted: nil)
		}
		let prefixCount = prefix.utf16.count
		let suffixCount = suffix.utf16.count
		if after.hasPrefix(prefix), after.hasSuffix(suffix), after.utf16.count >= prefixCount + suffixCount {
			let afterUnits = Array(after.utf16)
			let middleUnits = Array(afterUnits[prefixCount..<(afterUnits.count - suffixCount)])
			let middle = String(utf16CodeUnits: middleUnits, count: middleUnits.count)
			if middle == typed {
				return ParadisTypingCheck(verified: true, inserted: middle.count)
			}
			let looseMiddle = paradisLooseText(middle)
			let looseTyped = paradisLooseText(typed)
			if middle.contains(typed) || looseMiddle == looseTyped || (!looseTyped.isEmpty && looseMiddle.contains(looseTyped)) {
				return ParadisTypingCheck(verified: true, inserted: middle.count, rewritten: true)
			}
			return ParadisTypingCheck(verified: false, inserted: middle.count, rewritten: middle.count == typed.count)
		}
	} else if after == before {
		return ParadisTypingCheck(verified: nil, inserted: nil)
	}
	// 前後が読めない・崩れた: 送った文字列が 1 回以上多く現れたかで見る（前からあった同じ文字列では成功にしない。レビュー L1）
	let exactGrew = paradisOccurrences(of: typed, in: after) > paradisOccurrences(of: typed, in: before)
	let looseTyped = paradisLooseText(typed)
	let looseGrew = paradisOccurrences(of: looseTyped, in: paradisLooseText(after)) > paradisOccurrences(of: looseTyped, in: paradisLooseText(before))
	return ParadisTypingCheck(verified: exactGrew || looseGrew, inserted: max(0, after.count - before.count), rewritten: !exactGrew && looseGrew)
}

// MARK: - AX で入れた後に入れ直してよいか（ベータ 3 のレビュー H1）

/** 書き込みが起きていないと言い切れる `AXError`（ApplicationServices の定数と同じ値）。 */
private let paradisAXErrorsThatWriteNothing: Set<Int32> = [
	-25205, // kAXErrorAttributeUnsupported
	-25201, // kAXErrorIllegalArgument
	-25208, // kAXErrorNotImplemented
	-25202, // kAXErrorInvalidUIElement
	-25211, // kAXErrorAPIDisabled
	-25206, // kAXErrorActionUnsupported
]

/**
 * AX の書き込みの結果から、書き込みが起きていないと言い切れるか。言い切れるときだけ、貼り付けやキーで入れ直してよい。
 * 成功・締め切り（kAXErrorCannotComplete）・一般の失敗は、要求が取り消されないので後で入りうる。入れ直すと二重になる。
 */
func paradisAXWriteCertainlyDidNothing(error: Int32) -> Bool {
	return paradisAXErrorsThatWriteNothing.contains(error)
}

/** AX で入れた後に値を読み直す間隔と上限。 */
let paradisAXReadbackIntervalMicroseconds: UInt32 = 50_000
let paradisAXReadbackLimitSeconds: Double = 1.0

/**
 * AX で入れた後に読み直すたびに呼ぶ。結論が出たらその結果、まだ変わっていなければ nil（読み直しを続ける）。
 * 上限まで変わらなければ、呼び出し側は「確かめられない（遅れて入るかもしれない）」で止め、入れ直さない。
 */
func paradisAXReadbackStep(before: String, selection: (location: Int, length: Int), latest: String?, text: String) -> ParadisTypingCheck? {
	guard let latest else {
		return nil
	}
	let check = paradisTypingOutcome(before: before, selection: selection, after: latest, text: text)
	return check.verified == nil ? nil : check
}
