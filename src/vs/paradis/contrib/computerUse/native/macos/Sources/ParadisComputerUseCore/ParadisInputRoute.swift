/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 入力の送り方の段（OS に触れない部分）。
//
// 操作は次の段の順に試し、最初に送れた段で送る。どの段で送ったかは結果の `route` に書く。
//  1. accessibility: AX の操作（AXPress・AXShowMenu・AXIncrement/AXDecrement・値の設定・選択範囲への文字の挿入）。
//     マウスもカーソルも動かさず、アプリを前面に出さない。公開 API の AX だけを使う
//  2. background: 背面のアプリへ入力を送る段の差し込み口。今は実装が無く、常に「使えない」を返す
//     （`ParadisUnavailableBackgroundRoute`）。実装をはめ込むときは `ParadisInputRoute` に準拠したクラスを作り、
//     補助アプリの `paradisMakeBackgroundRoute()` から返す
//  3. foreground: 今までの経路。アプリを前面に出し、実カーソルを動かして HID のタップへ送る
//
// 前面に出す段（`requiresForeground`）は、shared process が利用者の承認を取ってからにできる（設定
// `paradis.computerUse.confirmForegroundInput`）。そのときの要求は `allowForeground: false` で来るので、
// その段に来たら何も送らずに `foreground_needs_approval` で返す。前の段で何かを送った後には落ちてこない
// （段は「何も起きていないと言い切れる」ときだけ次へ譲る）ので、承認の後に同じ要求を送り直しても二重にならない。

import Foundation

// MARK: - 段と操作

/** 入力を送った段。結果の `route` に書く。 */
enum ParadisInputRouteKind: String {
	case accessibility
	case background
	case foreground
}

/** 値を変える操作の中身。 */
enum ParadisValueChange: Equatable {
	case text(String)
	case number(Double)
	case boolean(Bool)
	/** AXIncrement を回数ぶん。 */
	case increment(Int)
	/** AXDecrement を回数ぶん。 */
	case decrement(Int)
}

/** 段へ渡す操作。 */
enum ParadisInputAction: Equatable {
	case activate(windowId: UInt32?)
	case click(windowId: UInt32, target: ParadisPointerTarget, button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers)
	case drag(windowId: UInt32, from: ParadisPointerTarget, to: ParadisPointerTarget)
	case scroll(windowId: UInt32, target: ParadisPointerTarget?, direction: ParadisScrollDirection, pages: Double)
	case typeText(text: String, units: [ParadisTypedUnit])
	case pasteText(text: String)
	case pressChord(ParadisKeyChord)
	case setValue(windowId: UInt32, target: ParadisPointerTarget, change: ParadisValueChange)

	/** ログと説明に使う短い名前。 */
	var name: String {
		switch self {
		case .activate: return "activate"
		case .click: return "click"
		case .drag: return "drag"
		case .scroll: return "scroll"
		case .typeText: return "typeText"
		case .pasteText: return "pasteText"
		case .pressChord: return "pressChord"
		case .setValue: return "setValue"
		}
	}
}

/** カーソルの持ち主（shared process が決めた名札の名前・CLI の印・色）。無ければ独自のカーソルを出さない。 */
struct ParadisCursorOwnerSpec: Equatable {
	let id: String
	let name: String
	let mark: String
	/** 0xRRGGBB。 */
	let color: UInt32
}

/** 要求ごとの送り方の指定。 */
struct ParadisInputOptions: Equatable {
	/** 前面に出す段（実カーソルを動かす）で送ってよいか。省略時は今までどおり true。 */
	var allowForeground: Bool = true
	/** 独自のカーソル。nil なら出さない（設定でオフ、または古い shared process）。 */
	var cursor: ParadisCursorOwnerSpec? = nil
}

// MARK: - 段の約束

/** その段でこの操作を送れるか（OS に触れない確かめだけ）。 */
enum ParadisRouteAvailability: Equatable {
	case available
	/** この段では送れない。次の段へ。 */
	case unavailable(String)
}

/** 段が送った結果。 */
enum ParadisRouteOutcome {
	case done([String: Any])
	/** 試したが、何も起きていないと言い切れる。次の段へ。起きたかもしれないときは使わない。 */
	case fellThrough(String)
}

/**
 * 入力の送り方の 1 段。送ってはいけない状態（利用者の入力・認証のダイアログ・前面でない など）では
 * `perform` が `ParadisHelperError` を投げて止める（次の段へは譲らない）。
 */
protocol ParadisInputRoute: AnyObject {
	var kind: ParadisInputRouteKind { get }
	/** 前面に出して実カーソルやキーボードを使う段か（使うなら利用者の承認の対象）。 */
	var requiresForeground: Bool { get }
	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability
	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome
}

/**
 * 2 段目（背面への入力）の空の実装。常に使えない。実装をはめ込むまでの置き場所で、ここに送る処理は書かない。
 */
final class ParadisUnavailableBackgroundRoute: ParadisInputRoute {
	let kind = ParadisInputRouteKind.background
	let requiresForeground = false

	func availability(of action: ParadisInputAction, pid: Int32) -> ParadisRouteAvailability {
		return .unavailable("background input is not available in this version")
	}

	func perform(_ action: ParadisInputAction, pid: Int32, options: ParadisInputOptions) throws -> ParadisRouteOutcome {
		return .fellThrough("background input is not available in this version")
	}
}

/**
 * 段を順に試して送る。結果に `route` を書き、前の段を飛ばした理由を `routeNotes` に残す（3 段目のとき）。
 * 前面に出す段に来たのに `allowForeground` が false なら、何も送らずに `foreground_needs_approval` で返す。
 */
func paradisRouteInput(_ action: ParadisInputAction, pid: Int32, routes: [ParadisInputRoute], options: ParadisInputOptions) throws -> [String: Any] {
	var skipped: [String] = []
	for route in routes {
		if case .unavailable(let reason) = route.availability(of: action, pid: pid) {
			skipped.append("\(route.kind.rawValue): \(reason)")
			continue
		}
		if route.requiresForeground && !options.allowForeground {
			throw ParadisHelperError(code: "foreground_needs_approval", message: "this action needs the app in front and the real pointer or keyboard (\(skipped.isEmpty ? action.name : skipped.joined(separator: "; ")))")
		}
		switch try route.perform(action, pid: pid, options: options) {
		case .done(var result):
			result["route"] = route.kind.rawValue
			if !skipped.isEmpty && route.kind != .accessibility {
				result["routeNotes"] = skipped
			}
			return result
		case .fellThrough(let reason):
			skipped.append("\(route.kind.rawValue): \(reason)")
		}
	}
	throw ParadisHelperError(code: "input_unsupported", message: skipped.isEmpty ? "no way to send \(action.name)" : skipped.joined(separator: "; "))
}

// MARK: - 1 段目: AX で何を押すか

/** AX の要素について分かっていること（クリックの代わりの操作を選ぶため）。 */
struct ParadisAXElementFacts: Equatable {
	let role: String
	var subrole: String? = nil
	var actions: [String] = []
	var enabled: Bool? = nil
	/** `AXFocused` を書けるか（文字の欄へフォーカスを移すため）。 */
	var focusSettable: Bool = false
}

/** クリックの代わりに行う AX の操作。 */
enum ParadisAXClickPlan: Equatable {
	/** `chain` の `depth` 番目の要素（0 が当たった要素、1 が親）に `action` を行う。 */
	case perform(action: String, depth: Int)
	/** 文字の欄へフォーカスを移し、キャレットを末尾に置く（`AXFocused` を書く）。 */
	case focus(depth: Int)
	case none(String)
}

/** 押せる部品（AXPress をクリックの代わりにしてよい役割）。 */
let paradisPressableRoles: Set<String> = [
	"AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem", "AXMenuButton", "AXPopUpButton",
	"AXDisclosureTriangle", "AXColorWell", "AXDockItem",
]

/** 文字の欄（左クリックはフォーカスを移すこと）。 */
let paradisTextInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

/** 中身だけの要素（ここに当たったら親の部品を見る。ボタンの中の文字や絵など）。 */
private let paradisPassiveRoles: Set<String> = ["AXStaticText", "AXImage", "AXGroup", "AXUnknown"]

/** 親をたどる深さ（当たった要素を含めて 3 つまで）。 */
let paradisAXClickChainLimit = 3

/**
 * クリックを AX の操作に置き換えられるか（1 段目）。置き換えられるのは、修飾キーの無い 1 回のクリックだけ。
 *  - 左: 押せる部品の AXPress。文字の欄なら AXFocused を書く
 *  - 右: AXShowMenu を受け付ける要素
 * 当たった要素が中身だけ（ボタンの中の文字など）のときは、親を `paradisAXClickChainLimit` までたどる。
 * 使えない（無効になっている）部品は置き換えない（3 段目のクリックに任せる）。
 */
func paradisAccessibilityClickPlan(button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers, chain: [ParadisAXElementFacts]) -> ParadisAXClickPlan {
	guard modifiers.isEmpty else {
		return .none("clicks with modifier keys need real input")
	}
	guard clickCount == 1 else {
		return .none("double and triple clicks need real input")
	}
	guard !chain.isEmpty else {
		return .none("no accessibility element at the target")
	}
	for (depth, facts) in chain.prefix(paradisAXClickChainLimit).enumerated() {
		if facts.enabled == false {
			return .none("the element is disabled")
		}
		switch button {
		case .left:
			if paradisPressableRoles.contains(facts.role) && facts.actions.contains("AXPress") {
				return .perform(action: "AXPress", depth: depth)
			}
			if paradisTextInputRoles.contains(facts.role) || facts.subrole == "AXSearchField" {
				return facts.focusSettable ? .focus(depth: depth) : .none("the text field does not accept focus through accessibility")
			}
		case .right:
			if facts.actions.contains("AXShowMenu") {
				return .perform(action: "AXShowMenu", depth: depth)
			}
		}
		guard paradisPassiveRoles.contains(facts.role) else {
			return .none("\(facts.role) does not accept \(button == .left ? "AXPress" : "AXShowMenu")")
		}
	}
	return .none("no element near the target accepts \(button == .left ? "AXPress" : "AXShowMenu")")
}

/** 値の変更をどう行うか。 */
enum ParadisAXValuePlan: Equatable {
	/** `AXValue` を書く。 */
	case setValue
	/** `action`（AXIncrement / AXDecrement）を `count` 回。 */
	case perform(action: String, count: Int)
	case none(String)
}

/** 値の変更を AX で行えるか。 */
func paradisAccessibilityValuePlan(_ change: ParadisValueChange, facts: ParadisAXElementFacts, valueSettable: Bool, secret: Bool) -> ParadisAXValuePlan {
	if secret {
		return .none("password fields are never set through accessibility; click the field and use type_text")
	}
	if facts.enabled == false {
		return .none("the element is disabled")
	}
	switch change {
	case .increment(let count):
		return facts.actions.contains("AXIncrement") ? .perform(action: "AXIncrement", count: count) : .none("\(facts.role) does not accept AXIncrement")
	case .decrement(let count):
		return facts.actions.contains("AXDecrement") ? .perform(action: "AXDecrement", count: count) : .none("\(facts.role) does not accept AXDecrement")
	case .text, .number, .boolean:
		return valueSettable ? .setValue : .none("\(facts.role) does not accept a new value through accessibility")
	}
}

// MARK: - 1 段目: 確かめ

/** AX の操作の後に読み戻した結果。`verified` が nil なら確かめようが無い（ボタンなど状態を持たない部品）。 */
struct ParadisAXCheck: Equatable {
	let verified: Bool?
	/** 読み戻した値（文字にしたもの。読めなければ nil）。 */
	let value: String?
}

/** 値を比べるための文字（数は小数点以下 4 桁で丸める）。 */
func paradisAXValueText(_ value: Any?) -> String? {
	if let text = value as? String {
		return text
	}
	if let number = value as? NSNumber {
		if CFGetTypeID(number) == CFBooleanGetTypeID() {
			return number.boolValue ? "1" : "0"
		}
		let rounded = (number.doubleValue * 10_000).rounded() / 10_000
		return rounded == rounded.rounded() && abs(rounded) < 1e15 ? String(Int64(rounded)) : String(rounded)
	}
	return nil
}

/**
 * AXPress の後の確かめ。状態を持つ部品（チェックボックス・ラジオボタン・スイッチ）は値が変わったか、
 * ほかの部品は確かめようが無い（nil）。
 */
func paradisAXPressCheck(role: String, before: String?, after: String?) -> ParadisAXCheck {
	switch role {
	case "AXCheckBox", "AXRadioButton":
		guard let before, let after else {
			return ParadisAXCheck(verified: nil, value: after)
		}
		// ラジオボタンは選ばれていれば押しても変わらない
		return ParadisAXCheck(verified: before != after || (role == "AXRadioButton" && after == "1"), value: after)
	default:
		return ParadisAXCheck(verified: nil, value: after)
	}
}

/**
 * 値を書いた後の確かめ。文字はそのまま、数は丸めて比べる。アプリが範囲に収めた・丸めたなどで違えば false。
 * 増減は、値が動いたか（向きも見る）。
 */
func paradisAXValueCheck(change: ParadisValueChange, before: String?, after: String?) -> ParadisAXCheck {
	guard let after else {
		return ParadisAXCheck(verified: nil, value: nil)
	}
	switch change {
	case .text(let text):
		return ParadisAXCheck(verified: paradisNormalizeTypedText(after) == paradisNormalizeTypedText(text), value: after)
	case .number(let number):
		return ParadisAXCheck(verified: paradisAXValueText(NSNumber(value: number)) == after || Double(after).map { abs($0 - number) < 1e-6 } == true, value: after)
	case .boolean(let flag):
		return ParadisAXCheck(verified: after == (flag ? "1" : "0"), value: after)
	case .increment, .decrement:
		guard let before, let old = Double(before), let new = Double(after) else {
			return ParadisAXCheck(verified: before.map { $0 != after }, value: after)
		}
		if case .increment = change {
			return ParadisAXCheck(verified: new > old, value: after)
		}
		return ParadisAXCheck(verified: new < old, value: after)
	}
}

/** 操作の前後の、利用者のフォーカス（前面のアプリ・キーボードのフォーカスのあるアプリ・その手前のウィンドウ）。 */
struct ParadisFocusSnapshot: Equatable {
	let frontmostPid: Int32?
	let focusedApplicationPid: Int32?
	/** フォーカスのあるアプリの手前のウィンドウの番号（CGWindowID）。分からなければ nil。 */
	let focusedWindowId: UInt32?
}

/**
 * AX の操作が利用者のフォーカスを変えなかったか。読めなかった値（nil）同士は比べない。前面のアプリだけは
 * 読めなくなったら変わったとみなす。
 */
func paradisFocusPreserved(before: ParadisFocusSnapshot, after: ParadisFocusSnapshot) -> Bool {
	if before.frontmostPid != after.frontmostPid {
		return false
	}
	if let old = before.focusedApplicationPid, let new = after.focusedApplicationPid, old != new {
		return false
	}
	if let old = before.focusedWindowId, let new = after.focusedWindowId, old != new {
		return false
	}
	return true
}

// MARK: - 利用者の打鍵

/**
 * 利用者の最後の物理的なキー入力からの秒数（1 段目の確かめ。マウスの動きでは止めない）。
 * タップにキーが一度でも届いたならタップの値、まだなら HID の値（止まる側に倒す）。
 */
func paradisPhysicalKeyboardAge(tapKeyboard: Double?, hidKeyboard: Double?, tapSawKeyboard: Bool, secondsSinceTapStarted: Double?) -> Double? {
	guard secondsSinceTapStarted != nil, tapSawKeyboard else {
		return hidKeyboard
	}
	return tapKeyboard
}

// MARK: - 要求の引数

/** 色 `#rrggbb` を読む。 */
func paradisParseHexColor(_ text: String) -> UInt32? {
	guard text.count == 7, text.hasPrefix("#") else {
		return nil
	}
	let digits = text.dropFirst()
	guard digits.allSatisfy({ $0.isHexDigit }) else {
		return nil
	}
	return UInt32(digits, radix: 16)
}

/**
 * 要求の `cursor`（`{ id, name, mark, color }`）を読む。形が違えば出さない（nil）。名前は制御文字を落として 24 文字まで、
 * 印は英大文字 2 文字まで（内蔵ブラウザの `paradisParseCursorOwner` と同じ決まり）。
 */
func paradisParseCursorOwner(_ value: Any?) -> ParadisCursorOwnerSpec? {
	guard let record = value as? [String: Any],
		let id = record["id"] as? String, id.count >= 8, id.count <= 32, id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
		let name = record["name"] as? String,
		let mark = record["mark"] as? String, mark.count <= 2, mark.allSatisfy({ $0.isASCII && $0.isUppercase }),
		let colorText = record["color"] as? String, let color = paradisParseHexColor(colorText)
	else {
		return nil
	}
	let cleaned = String(String.UnicodeScalarView(name.unicodeScalars.filter { scalar in
		scalar.properties.generalCategory != .control && scalar.properties.generalCategory != .format
	}).prefix(24))
	guard !cleaned.trimmingCharacters(in: .whitespaces).isEmpty else {
		return nil
	}
	return ParadisCursorOwnerSpec(id: id, name: cleaned, mark: mark, color: color)
}

/** 要求の引数から送り方の指定を読む。`allowForeground` が無ければ今までどおり true。 */
func paradisParseInputOptions(_ params: [String: Any]) throws -> ParadisInputOptions {
	var options = ParadisInputOptions()
	if let raw = params["allowForeground"] {
		guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
			throw ParadisHelperError.invalidArgument("\"allowForeground\" must be true or false")
		}
		options.allowForeground = number.boolValue
	}
	options.cursor = paradisParseCursorOwner(params["cursor"])
	return options
}

/** 増減の回数の上限。 */
let paradisMaxValueSteps = 50

/** `setValue` の `value` / `adjust` / `steps` を読む。 */
func paradisParseValueChange(_ params: [String: Any]) throws -> ParadisValueChange {
	let adjust = params["adjust"]
	let value = params["value"]
	guard (adjust == nil) != (value == nil) else {
		throw ParadisHelperError.invalidArgument("give either \"value\" or \"adjust\"")
	}
	if let adjust {
		var steps = 1
		if let raw = params["steps"] {
			guard let count = paradisExactInt(raw), count >= 1, count <= paradisMaxValueSteps else {
				throw ParadisHelperError.invalidArgument("\"steps\" must be an integer from 1 to \(paradisMaxValueSteps)")
			}
			steps = count
		}
		switch adjust as? String {
		case "increment":
			return .increment(steps)
		case "decrement":
			return .decrement(steps)
		default:
			throw ParadisHelperError.invalidArgument("\"adjust\" must be increment or decrement")
		}
	}
	if let number = value as? NSNumber {
		if CFGetTypeID(number) == CFBooleanGetTypeID() {
			return .boolean(number.boolValue)
		}
		guard number.doubleValue.isFinite else {
			throw ParadisHelperError.invalidArgument("\"value\" must be a finite number")
		}
		return .number(number.doubleValue)
	}
	guard let text = value as? String else {
		throw ParadisHelperError.invalidArgument("\"value\" must be a string, a number or true/false")
	}
	if !text.isEmpty {
		// 文字の決まりは文字入力と同じ（4,000 文字まで・タブと制御文字は断る）
		_ = try paradisTypedUnits(text)
	}
	return .text(text)
}
