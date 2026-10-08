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
//  2. background: 指定ウィンドウへの入力。補助アプリの `paradisMakeBackgroundRoute(desktop:)` で作る。
//     `ParadisUnavailableBackgroundRoute` は代替実装・Core のテスト用に残す。
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
	/** キーの背面配送にだけ使う宛先のヒント。AX・前面経路の関門にはしない。 */
	var backgroundWindowId: UInt32? = nil
	/** 前面に出す段（実カーソルを動かす）で送ってよいか。省略時は今までどおり true。 */
	var allowForeground: Bool = true
	/**
	 * 前面の段で送る前に、目的のアプリを前面に出し、利用者の物理的な入力が止むのを待つ。利用者が承認ダイアログで
	 * 前面の送り方を許した直後の送り直しに付く（ダイアログのボタンを押したので Para Code が前面で、直前に物理的な
	 * 入力もある。そのままでは `window_not_focused` か `user_active` で止まる）。
	 */
	var activateFirst: Bool = false
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
 * 背面 API が使えない環境を表す代替実装。Core の経路選択テストでも使う。
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

/** 押すとメニューを開く部品（ポップアップ・メニューボタン）。 */
let paradisMenuOpeningRoles: Set<String> = ["AXPopUpButton", "AXMenuButton"]

/**
 * その操作がメニューを開くか。メニューは開いている間キーボードのフォーカスを取るので、背面のアプリで開くと
 * 利用者の次の打鍵がメニューの項目を選んで実行しうる。エージェントは開いたメニューを閉じられない。
 */
func paradisAXActionOpensMenu(action: String, role: String) -> Bool {
	return action == "AXShowMenu" || (action == "AXPress" && paradisMenuOpeningRoles.contains(role))
}

/** 当たった要素と、その親を3つまで調べる。 */
let paradisAXClickChainLimit = 4

/**
 * クリックを AX の操作に置き換えられるか（1 段目）。置き換えられるのは、修飾キーの無い 1 回のクリックだけ。
 *  - 左: 押せる部品の AXPress。文字の欄なら AXFocused を書く
 *  - 右: AXShowMenu を受け付ける要素
 * 当たった要素が中身だけ（ボタンの中の文字など）のときは、親を `paradisAXClickChainLimit` までたどる。
 * 使えない（無効になっている）部品は置き換えない（3 段目のクリックに任せる）。
 */
func paradisAccessibilityClickPlan(button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers, chain: [ParadisAXElementFacts], targetIsFrontmost: Bool) -> ParadisAXClickPlan {
	let plan = paradisAccessibilityClickPlanIgnoringMenus(button: button, clickCount: clickCount, modifiers: modifiers, chain: chain)
	// メニューを開く操作は、目的のアプリが前面のときだけ 1 段目で送る（背面では 3 段目に任せる。前面に出してから開く）
	if !targetIsFrontmost, case .perform(let action, let depth) = plan, paradisAXActionOpensMenu(action: action, role: chain[depth].role) {
		return .none("opening a menu in an app that is not in front would move the keyboard focus to the menu")
	}
	return plan
}

private func paradisAccessibilityClickPlanIgnoringMenus(button: ParadisMouseButton, clickCount: Int, modifiers: ParadisModifiers, chain: [ParadisAXElementFacts]) -> ParadisAXClickPlan {
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

/**
 * 1 段目で目的のウィンドウを操作してよいか。画面に出ていない（別の操作スペース・しまわれた）ウィンドウや、
 * 隠したアプリ（⌘H）のウィンドウは、利用者に見えないところで変わるうえ、独自のカーソルが今の画面の無関係な
 * アプリの上に出るので、3 段目へ譲る（3 段目は前面に出してから送る）。譲る理由を返す。
 */
func paradisAccessibilityWindowSkipReason(onScreen: Bool, minimized: Bool, appHidden: Bool) -> String? {
	if appHidden {
		return "the app is hidden"
	}
	if minimized {
		return "the window is minimized"
	}
	if !onScreen {
		return "the window is not on the current screen or Space"
	}
	return nil
}

/**
 * 座標で当たった要素を 1 段目で使えるか。使えなければ次の段へ譲る理由。当たった要素が目的のウィンドウそのもの
 * （ボタンなどの無いところ）なら、ウィンドウの要素は `AXWindow` を持たないので、別のウィンドウとは書かない（実機の報告）。
 */
func paradisHitElementSkipReason(hitIsTargetWindow: Bool, ownerIsTargetWindow: Bool) -> String? {
	if hitIsTargetWindow {
		return "the point is on the window itself, not on a control"
	}
	if !ownerIsTargetWindow {
		return "the element at the point belongs to another window"
	}
	return nil
}

/**
 * 画面のロック中・ほかのユーザーへの切り替え中か（`CGSessionCopyCurrentDictionary` の `kCGSessionOnConsoleKey` と
 * `CGSSessionScreenIsLocked`）。読めない値（nil）では止めない。
 */
func paradisSessionFailure(onConsole: Bool?, screenLocked: Bool?) -> ParadisHelperError? {
	if onConsole == false {
		return ParadisHelperError(code: "screen_locked", message: "another user is using the screen")
	}
	if screenLocked == true {
		return ParadisHelperError(code: "screen_locked", message: "the screen is locked")
	}
	return nil
}

// MARK: - Electron の AXManualAccessibility

/**
 * `AXManualAccessibility` を立てないアプリ。VS Code 系は、立てるとスクリーンリーダー向けの動き（エディタの読み上げ用の
 * モードなど）に切り替わるので触らない。
 */
private let paradisManualAccessibilityExcludedPatterns: [String] = [
	"com.microsoft.vscode", "com.microsoft.vscodeinsiders", "com.vscodium", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf",
]

/**
 * `hasVSCodeProductJson` は `Contents/Resources/app/product.json` があるか（VS Code の派生は全部これを持つので、
 * 一覧に無い新しい派生（Positron・Kiro・Trae など）もこれで外す）。
 */
func paradisManualAccessibilityExcluded(bundleId: String?, hasVSCodeProductJson: Bool) -> Bool {
	if hasVSCodeProductJson {
		return true
	}
	guard let lower = bundleId?.lowercased() else {
		return true
	}
	return paradisManualAccessibilityExcludedPatterns.contains { lower == $0 || lower.hasPrefix($0 + ".") }
}

/** ウェブの中身を探すときにたどる深さと要素の数の上限。 */
let paradisWebAreaSearchMaxDepth = 8
let paradisWebAreaSearchMaxNodes = 400

/**
 * Electron のウィンドウに `AXManualAccessibility` が要るか（ウェブの中身がまだ AX に出ていないか）。
 * Electron のウィンドウには、AX のツリーを作る前から閉じる・しまう・広げるのボタンなどの子があるので、
 * 「ウィンドウの子が空」では判断できない（実機の報告）。ウィンドウから幅優先でたどり、範囲の中の `AXWebArea` を
 * 全部見る。子のある `AXWebArea` が 1 つでもあれば要らない（空の webview が別にあっても）。`AXWebArea` が無いか全部
 * 空で、最後までたどれたときだけ要る。深さか要素の数の上限で打ち切ったら要らないとする（決まらないときに立てると、
 * 別のツールが立てた設定を台帳に載せて後で false へ戻しうるため）。ウィンドウが無いときは要る。
 * `AXWebArea` の下はたどらない（子の有無だけを見る）。
 */
func paradisWindowNeedsManualAccessibility<Node>(_ window: Node?, children: (Node) -> [Node], role: (Node) -> String?,
	maxDepth: Int = paradisWebAreaSearchMaxDepth, maxNodes: Int = paradisWebAreaSearchMaxNodes) -> Bool {
	guard let window else {
		return true
	}
	var queue: [(Node, Int)] = [(window, 0)]
	var index = 0
	while index < queue.count {
		if index >= maxNodes {
			return false
		}
		let (node, depth) = queue[index]
		index += 1
		let nodeChildren = children(node)
		if role(node) == "AXWebArea" {
			if !nodeChildren.isEmpty {
				return false
			}
			continue
		}
		if nodeChildren.isEmpty {
			continue
		}
		if depth >= maxDepth {
			return false
		}
		queue.append(contentsOf: nodeChildren.map { ($0, depth + 1) })
	}
	return true
}

/**
 * `AXManualAccessibility` を立てて台帳に載せてよいか。立てる前に読んだ今の値がすでに true なら、別のツール（または
 * アプリ自身）が立てたものなので、立てず台帳にも載せない（10 分後に false へ戻さないため）。読めない値は立ててよい。
 */
func paradisShouldEnableManualAccessibility(currentValue: Bool?) -> Bool {
	return currentValue != true
}

/** 立てたアプリの記録 1 件。pid と、そのプロセスが始まった時刻（秒。pid の使い回しを見分ける）。 */
struct ParadisManualAccessibilityEntry: Codable, Equatable {
	let pid: Int32
	let started: Double
}

/** 同じプロセスか（始まった時刻が 1 秒以内で一致する）。今のプロセスが無ければ false。 */
func paradisSameProcess(recordedStart: Double, currentStart: Double?) -> Bool {
	guard let currentStart else {
		return false
	}
	return abs(recordedStart - currentStart) < 1
}

/** 記録したアプリをどうするか。 */
enum ParadisManualAccessibilityRestore: Equatable {
	/** false へ戻す。 */
	case restore
	/** 戻さずに記録から外す（もう居ない・pid が別のアプリに使い回された・支援技術が動いている）。 */
	case forget
}

/**
 * 戻すか。VoiceOver やスイッチコントロールが動いていれば、こちらの false がそれらのための支援も止めうるので戻さない。
 */
func paradisManualAccessibilityRestoreDecision(recordedStart: Double, currentStart: Double?, assistiveTechnologyRunning: Bool) -> ParadisManualAccessibilityRestore {
	guard paradisSameProcess(recordedStart: recordedStart, currentStart: currentStart), !assistiveTechnologyRunning else {
		return .forget
	}
	return .restore
}

/** 記録のファイルを読む（読めない・壊れていれば空）。 */
func paradisDecodeManualAccessibilityEntries(_ data: Data?) -> [ParadisManualAccessibilityEntry] {
	guard let data, let entries = try? JSONDecoder().decode([ParadisManualAccessibilityEntry].self, from: data) else {
		return []
	}
	return entries
}

/**
 * 1 段目で操作を断る、目的のアプリで開いているメニュー。背面のアプリでメニューが開いているなら、利用者が
 * そのアプリで右クリックして使っている最中なので、送らずに止める（エージェントは背面ではメニューを開かない）。
 * 前面のアプリでは、エージェント自身が開いたメニューの項目を押す流れがあるので止めない。
 */
func paradisMenuOpenFailure(menuWindow: ParadisMenuWindowFacts?, axMenuOpen: Bool, targetIsFrontmost: Bool) -> ParadisHelperError? {
	guard (menuWindow != nil || axMenuOpen) && !targetIsFrontmost else {
		return nil
	}
	let seen = menuWindow.map { "a window at layer \($0.layer), \(Int($0.width))x\(Int($0.height))" } ?? "an accessibility menu"
	return ParadisHelperError(code: "menu_open", message: "a menu is open in the app (\(seen)); the user may be using it, or it is a menu that could not be closed")
}

/** アプリが画面に出しているウィンドウ 1 つの、メニューかを見分けるための値。 */
struct ParadisMenuWindowFacts: Equatable {
	let layer: Int
	let alpha: Double
	let width: Double
	let height: Double
}

/**
 * メニューのウィンドウか。ポップアップメニューの層にあって、透明でなく、大きさがあるもの。同じ層に出る透明な
 * ウィンドウ・大きさの無いウィンドウは数えない（ポップオーバーやツールチップの名残で止めないため）。
 */
func paradisIsMenuWindow(_ window: ParadisMenuWindowFacts, menuLayer: Int) -> Bool {
	return window.layer == menuLayer && window.alpha > 0 && window.width > 0 && window.height > 0
}

/** 操作の後のメニューの扱いの報告。 */
struct ParadisMenuAfterAction: Equatable {
	/** 操作が開いたメニューを閉じた。 */
	let closed: Bool
	/** 操作が開いたメニューが閉じられずに残っている（AX に出ない・非同期に開いたなど）。 */
	let stillOpen: Bool
	let note: String?
}

/**
 * 操作の後のメニューの報告（背面のアプリで、操作が開いたメニューについてだけ）。`opened` は操作の後にメニューが
 * 開いていた（AX の `AXMenu` かメニューのウィンドウ）、`closed` は `AXCancel` が通った、`stillVisible` は閉じた後も
 * メニューのウィンドウが残っている、`userTypedDuringAction` は操作が戻るまでの間に利用者がキーを打った。
 */
func paradisMenuAfterAction(opened: Bool, closed: Bool, stillVisible: Bool, userTypedDuringAction: Bool) -> ParadisMenuAfterAction {
	guard opened else {
		return ParadisMenuAfterAction(closed: false, stillOpen: false, note: nil)
	}
	let stillOpen = !closed || stillVisible
	var notes: [String] = []
	if stillOpen {
		notes.append("A menu opened in the app while it was not in front, and Para Code could not close it. Tell the user that a menu is open in this app and ask them to close it (Escape or a click elsewhere); do not send more input to the app until then.")
	} else {
		notes.append("A menu opened in the app while it was not in front, so Para Code closed it. Bring the app forward with computer_activate_app to use the menu.")
	}
	if userTypedDuringAction {
		notes.append("The user typed while the menu was open, so their keys may have gone to the menu; ask the user to check the app.")
	}
	return ParadisMenuAfterAction(closed: closed && !stillVisible, stillOpen: stillOpen, note: notes.joined(separator: " "))
}

/**
 * 操作が戻るまでの間に利用者がキーを打ったか。`secondsSinceKeyboard` は最後の物理的なキー入力からの秒数、
 * `actionSeconds` は操作を始めてからの秒数。
 */
func paradisUserTypedDuringAction(secondsSinceKeyboard: Double?, actionSeconds: Double) -> Bool {
	guard let secondsSinceKeyboard else {
		return false
	}
	return secondsSinceKeyboard < actionSeconds
}

// MARK: - AXManualAccessibility の記録のファイル

/** 補助アプリごとの記録のファイル名（2 つの Para Code が同じ userData を使っても、互いの記録を消さないため）。 */
func paradisManualAccessibilityStateFileName(helperPid: Int32) -> String {
	return "manual-accessibility-\(helperPid).json"
}

/** 記録のファイル名から、書いた補助アプリの pid を読む。前の版の名前（pid 無し）は 0。記録のファイルでなければ nil。 */
func paradisManualAccessibilityStateFileOwner(_ name: String) -> Int32? {
	if name == "manual-accessibility.json" {
		return 0
	}
	guard name.hasPrefix("manual-accessibility-"), name.hasSuffix(".json") else {
		return nil
	}
	let digits = name.dropFirst("manual-accessibility-".count).dropLast(".json".count)
	guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else {
		return nil
	}
	return Int32(digits)
}

/** 起動時に、そのファイルの記録を戻して消すか。自分のものと、まだ動いているほかの補助アプリのものは触らない。 */
func paradisShouldRecoverStateFile(ownerPid: Int32, selfPid: Int32, ownerIsRunningHelper: Bool) -> Bool {
	return ownerPid != selfPid && !ownerIsRunningHelper
}

/**
 * 操作の後にメニューを閉じるか。閉じるのは、背面のアプリで、操作の前には開いておらず、操作の後に開いているとき
 * だけ（操作が開いたメニュー）。フォーカスが変わったかは条件にしない: ボタンの処理の中でメニューを出すアプリでは、
 * メニューが開いている間、画面全体へのフォーカスの問い合わせが答えを返さず（確認用のアプリで確かめた）、
 * 変わったと分からないため。
 */
func paradisShouldCloseMenu(targetIsFrontmost: Bool, menuOpenBefore: Bool, menuOpenAfter: Bool) -> Bool {
	return !targetIsFrontmost && !menuOpenBefore && menuOpenAfter
}

/** 立てた `AXManualAccessibility` を、操作が無いまま戻すまでの時間。 */
let paradisManualAccessibilityIdleSeconds: TimeInterval = 600

/** 最後に使ってからの時間が過ぎたか（過ぎたら false へ戻す）。 */
func paradisManualAccessibilityExpired(lastUsed: Date, now: Date) -> Bool {
	return now.timeIntervalSince(lastUsed) >= paradisManualAccessibilityIdleSeconds
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
	if let raw = params["backgroundWindowId"] {
		guard let value = paradisExactInt(raw), value > 0, value <= Int(UInt32.max) else {
			throw ParadisHelperError.invalidArgument("backgroundWindowId must be a positive window identifier")
		}
		options.backgroundWindowId = UInt32(value)
	}
	if let raw = params["allowForeground"] {
		guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
			throw ParadisHelperError.invalidArgument("\"allowForeground\" must be true or false")
		}
		options.allowForeground = number.boolValue
	}
	if let raw = params["activateFirst"] {
		guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
			throw ParadisHelperError.invalidArgument("\"activateFirst\" must be true or false")
		}
		options.activateFirst = number.boolValue
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

/** 背面の座標クリックでも、ラベルや画像の親にあるメニュー部品を除く。 */
func paradisBackgroundClickOpensMenu(roles: [String]) -> Bool {
	return roles.prefix(paradisAXClickChainLimit).contains { paradisMenuOpeningRoles.contains($0) || $0 == "AXMenuBarItem" || $0 == "AXMenuItem" }
}

/** AXCancel の試行と、閉じたことの観測を別々に報告する。 */
func paradisBackgroundMenuResult(opened: Bool, attempted: Bool, accepted: Bool, stillOpen: Bool) -> [String: Any] {
	guard opened else { return [:] }
	let note: String
	if !stillOpen {
		note = "The menu opened by the background action is now closed."
	} else if attempted {
		note = "Para Code tried AXCancel, but the menu is still open. Ask the user to close it before sending more input."
	} else {
		note = "A menu opened, but no accessible menu was available for AXCancel. Ask the user to close it before sending more input."
	}
	return ["menuCancelAttempted": attempted, "menuCancelAccepted": accepted, "menuClosed": !stillOpen, "menuOpen": stillOpen, "note": note]
}

/** Electron の背面単一クリックはページで捨てられる場合がある。送信前に前面経路へ譲る。 */
func paradisBackgroundSingleClickSupported(clickCount: Int, isElectron: Bool, targetIsFrontmost: Bool) -> Bool {
	return clickCount != 1 || !isElectron || targetIsFrontmost
}

/** 入力先を検査できない場合も、背面キーの許可として扱わない。 */
func paradisBackgroundKeyboardFailure(role: String?, belongsToWindow: Bool, isSecret: Bool) -> ParadisHelperError? {
	guard let role, !role.isEmpty, belongsToWindow else {
		return ParadisHelperError(code: "window_not_focused", message: "the focused element cannot be inspected in the requested window")
	}
	return isSecret ? ParadisHelperError(code: "key_blocked", message: "background input does not target password fields") : nil
}

/** 文字入力による補完候補は、クリックで開いたメニューの後始末に含めない。 */
func paradisBackgroundChecksMenuAfter(_ action: ParadisInputAction) -> Bool {
	if case .click = action { return true }
	return false
}
