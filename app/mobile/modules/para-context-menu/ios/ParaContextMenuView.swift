// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

/**
 * RN の子を包み、長押し（iPad ではポインタの右クリックも）で iOS 標準のコンテキストメニューを出すビュー。
 *
 * - メニューの提示・浮き上がり・後ろのぼかし・右クリックはすべて `UIContextMenuInteraction` に任せる
 *   （Apple: "UIContextMenuInteraction" / "Adding context menus in your app"）。
 *   iPad のポインタの副ボタンのクリックでも同じメニューが出るのは、この interaction の既定の動き
 * - ＋メニュー（`para-plus-menu`）と違い、**前面にボタンを置かない**。タップは RN の子がそのまま受ける
 *   （行を押すとビューアが開く、などの今の動きを変えない）。長押しが認識されると RN のタッチは取り消される
 * - メニューは開くたびにそのときの props から作る（`items` が後から変わっても古い中身を出さない）
 * - 長押しの間とメニューを閉じた直後に、長押しを始めたときと違う入力欄が first responder を取ったら外す
 *   （iPad のソフトウェアキーボードで、発言を長押しするとメニューと同時に入力欄のキーボードが出て、メニューを隠していた。
 *   メニューの提示・後片付けで UIKit が覚えていた入力欄を first responder に戻していると見ている）。長押しの前から
 *   入力欄を使っていた（キーボードが出ていた）ときは、その入力欄は外さない。閉じた後に新しい触れが来たら
 *   （ユーザーが自分で入力欄を押した）、その時点で見張りを終える（外すのは UIKit が戻した分だけにする）
 * - 選ばれた項目は、**メニューが閉じ切ってから** `onSelect` で知らせる。閉じる途中に JS がモーダル
 *   （「範囲を選んでコピー…」のシートなど）を出すと、提示がぶつかって出ないことがあるため
 *   （アプリの ActionSheet も同じ理由で閉じ切ってから処理を呼ぶ）
 */

/** RNから受け取るメニュー1項目。`children` があれば入れ子（submenu）になる。 */
struct ParaContextMenuItem: Record {
	@Field var id: String = ""
	@Field var title: String = ""
	/** タイトルの下の補足（iOS 15 からの `UIMenuElement.subtitle`）。空なら付けない。 */
	@Field var subtitle: String = ""
	/** SF Symbols の名前。空なら付けない。 */
	@Field var systemImage: String = ""
	/** この項目の**前**に区切り線を入れる（`.displayInline` の節に分ける）。 */
	@Field var startsSection: Bool = false
	/** 押せない（薄く出す）。理由は `subtitle` に書く。 */
	@Field var disabled: Bool = false
	/** 赤く出す（取り消しにくい操作）。 */
	@Field var destructive: Bool = false
	/** 入れ子の項目（1段だけ）。 */
	@Field var children: [ParaContextMenuChild] = []
}

/** 入れ子メニューの項目。さらに深い入れ子は要らないので分けてある（Recordは自己参照できない）。 */
struct ParaContextMenuChild: Record {
	@Field var id: String = ""
	@Field var title: String = ""
	@Field var subtitle: String = ""
	@Field var systemImage: String = ""
	@Field var disabled: Bool = false
}

final class ParaContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
	private let onSelect = EventDispatcher()
	private var items: [ParaContextMenuItem] = []
	private var menuTitle: String = ""
	private var previewCornerRadius: CGFloat = 12
	private var previewBackgroundColor: UIColor?
	/** メニューが出ている間に選ばれた項目（閉じ切ってから知らせる）。 */
	private var pendingSelection: String?
	private var menuVisible = false
	/** 長押しを始めたときの first responder（これ以外の入力欄が途中で取ったら外す）。 */
	private weak var responderAtPress: UIResponder?
	/** 入力欄に取られないように見張っている間の、キーボードの知らせの受け口。 */
	private var keyboardObserver: NSObjectProtocol?
	/** 見張りを終える予約（重ねて始めたら前の予約は効かせない）。 */
	private var focusGuardSerial = 0
	/** 閉じた後の見張りの間だけ窓に付ける、触れを見るだけの受け口（新しい触れが来たら見張りを終える）。 */
	private var touchWatcher: ParaContextMenuTouchWatcher?

	required init(appContext: AppContext? = nil) {
		super.init(appContext: appContext)
		addInteraction(UIContextMenuInteraction(delegate: self))
	}

	func setItems(_ next: [ParaContextMenuItem]) {
		items = next
	}

	func setTitle(_ title: String) {
		menuTitle = title
	}

	func setPreviewCornerRadius(_ radius: Double) {
		previewCornerRadius = CGFloat(max(0, radius))
	}

	func setPreviewBackgroundColor(_ color: UIColor?) {
		previewBackgroundColor = color
	}

	// MARK: UIContextMenuInteractionDelegate

	func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
		// 項目が無ければメニューを出さない（長押しは何も起きない）
		guard !items.isEmpty else {
			return nil
		}
		beginFocusGuard()
		return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
			self?.buildMenu()
		}
	}

	/**
	 * 浮き上がる形。既定はビューの四角そのままで、背景が透明な行は角も地も無く浮くので、
	 * 角丸と地の色（アプリの地の色。呼び出し側が渡す）を付ける。iOS 16 から。
	 */
	@available(iOS 16.0, *)
	func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: NSCopying) -> UITargetedPreview? {
		makePreview()
	}

	@available(iOS 16.0, *)
	func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, dismissalPreviewForItemWithIdentifier identifier: NSCopying) -> UITargetedPreview? {
		makePreview()
	}

	func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
		menuVisible = true
		releaseStolenFocus()
		animator?.addCompletion { [weak self] in
			self?.releaseStolenFocus()
		}
	}

	func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
		let finish = { [weak self] in
			guard let self else {
				return
			}
			self.menuVisible = false
			// 閉じた後に UIKit が入力欄へ戻したものも外し、少し待ってから見張りを終える
			self.releaseStolenFocus()
			self.watchNextTouch()
			self.endFocusGuard(after: Self.focusGuardTail)
			if let id = self.pendingSelection {
				self.pendingSelection = nil
				self.onSelect(["id": id])
			}
		}
		if let animator {
			animator.addCompletion(finish)
		} else {
			finish()
		}
	}

	// MARK: Focus guard

	/** 閉じ切った後も見張る時間（秒）。UIKit が first responder を戻すのは閉じる動きの後になることがある。 */
	private static let focusGuardTail: TimeInterval = 0.6
	/** メニューが出ないまま終わったとき（長押しを途中でやめた）に見張りを終えるまでの時間（秒）。 */
	private static let focusGuardIdle: TimeInterval = 3

	private func beginFocusGuard() {
		responderAtPress = ParaContextMenuResponderProbe.current()
		if keyboardObserver == nil {
			keyboardObserver = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
				self?.releaseStolenFocus()
			}
		}
		endFocusGuard(after: Self.focusGuardIdle)
	}

	private func endFocusGuard(after delay: TimeInterval) {
		focusGuardSerial += 1
		let serial = focusGuardSerial
		DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
			guard let self, self.focusGuardSerial == serial, !self.menuVisible else {
				return
			}
			self.stopFocusGuard()
		}
	}

	private func stopFocusGuard() {
		if let keyboardObserver {
			NotificationCenter.default.removeObserver(keyboardObserver)
		}
		keyboardObserver = nil
		responderAtPress = nil
		removeTouchWatcher()
	}

	/** 閉じた後の見張りの間、窓に来た新しい触れで見張りを終える（触れは取らない・遅らせない）。 */
	private func watchNextTouch() {
		removeTouchWatcher()
		guard let window else {
			return
		}
		let watcher = ParaContextMenuTouchWatcher { [weak self] in
			guard let self, !self.menuVisible else {
				return
			}
			// 見張りはすぐ止める（入力欄が first responder になるのは触れの後）。受け口を外すのは、触れの処理の中で
			// 自分を外さないように次の回にする
			self.focusGuardSerial += 1
			if let observer = self.keyboardObserver {
				NotificationCenter.default.removeObserver(observer)
			}
			self.keyboardObserver = nil
			self.responderAtPress = nil
			DispatchQueue.main.async { [weak self] in
				self?.removeTouchWatcher()
			}
		}
		window.addGestureRecognizer(watcher)
		touchWatcher = watcher
	}

	private func removeTouchWatcher() {
		if let touchWatcher {
			touchWatcher.view?.removeGestureRecognizer(touchWatcher)
		}
		touchWatcher = nil
	}

	/**
	 * 長押しを始めたときと違う入力欄が first responder なら外す。外すのは RN の TextInput の実体（UITextField・UITextView）
	 * だけ。WKWebView は外さない（「範囲を選んでコピー…」は閉じた直後に選ぶ表示の WebView を first responder にするため）。
	 */
	private func releaseStolenFocus() {
		guard keyboardObserver != nil, let current = ParaContextMenuResponderProbe.current(), current !== responderAtPress, current is UITextField || current is UITextView else {
			return
		}
		current.resignFirstResponder()
	}

	deinit {
		if let keyboardObserver {
			NotificationCenter.default.removeObserver(keyboardObserver)
		}
		if let touchWatcher {
			touchWatcher.view?.removeGestureRecognizer(touchWatcher)
		}
	}

	// MARK: Menu

	private func makePreview() -> UITargetedPreview? {
		guard window != nil, bounds.width > 0, bounds.height > 0 else {
			return nil
		}
		let parameters = UIPreviewParameters()
		parameters.backgroundColor = previewBackgroundColor ?? .clear
		parameters.visiblePath = UIBezierPath(roundedRect: bounds, cornerRadius: previewCornerRadius)
		return UITargetedPreview(view: self, parameters: parameters)
	}

	private func select(_ id: String) {
		if menuVisible {
			pendingSelection = id
		} else {
			// 閉じる知らせが先に来ていた（willEnd の完了の後に項目の処理が呼ばれた）ときはすぐ知らせる
			onSelect(["id": id])
		}
	}

	/** `startsSection` で区切られた塊ごとに `.displayInline` の子メニューを作る（`para-plus-menu` と同じ）。 */
	private func buildMenu() -> UIMenu {
		var sections: [[UIMenuElement]] = []
		var current: [UIMenuElement] = []
		for item in items {
			if item.startsSection && !current.isEmpty {
				sections.append(current)
				current = []
			}
			current.append(element(for: item))
		}
		if !current.isEmpty {
			sections.append(current)
		}
		let grouped = sections.map { UIMenu(title: "", options: .displayInline, children: $0) }
		return UIMenu(title: menuTitle, children: grouped)
	}

	private func element(for item: ParaContextMenuItem) -> UIMenuElement {
		if !item.children.isEmpty {
			let children: [UIMenuElement] = item.children.map { child in
				action(id: child.id, title: child.title, subtitle: child.subtitle, systemImage: child.systemImage, disabled: child.disabled, destructive: false)
			}
			let menu = UIMenu(title: item.title, image: image(named: item.systemImage), children: children)
			if !item.subtitle.isEmpty {
				menu.subtitle = item.subtitle
			}
			return menu
		}
		return action(id: item.id, title: item.title, subtitle: item.subtitle, systemImage: item.systemImage, disabled: item.disabled, destructive: item.destructive)
	}

	private func action(id: String, title: String, subtitle: String, systemImage: String, disabled: Bool, destructive: Bool) -> UIAction {
		var attributes: UIMenuElement.Attributes = []
		if disabled {
			attributes.insert(.disabled)
		}
		if destructive {
			attributes.insert(.destructive)
		}
		let action = UIAction(title: title, image: image(named: systemImage), attributes: attributes) { [weak self] _ in
			self?.select(id)
		}
		if !subtitle.isEmpty {
			action.subtitle = subtitle
		}
		return action
	}

	private func image(named name: String) -> UIImage? {
		name.isEmpty ? nil : UIImage(systemName: name)
	}
}

/**
 * 触れの始まりを知らせるだけの受け口。触れを取り消さず・遅らせず、知らせたらすぐ失敗して、ほかの受け口
 * （RN の触れ・入力欄・スクロール）の邪魔をしない。
 */
final class ParaContextMenuTouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
	private let onTouch: () -> Void

	init(onTouch: @escaping () -> Void) {
		self.onTouch = onTouch
		super.init(target: nil, action: nil)
		cancelsTouchesInView = false
		delaysTouchesBegan = false
		delaysTouchesEnded = false
		delegate = self
	}

	override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
		super.touchesBegan(touches, with: event)
		onTouch()
		state = .failed
	}

	override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool {
		false
	}

	func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
		true
	}
}

/** いまの first responder を公開 API だけで調べる（`sendAction(_:to: nil ...)` は first responder へ届く）。 */
enum ParaContextMenuResponderProbe {
	fileprivate static weak var found: UIResponder?

	static func current() -> UIResponder? {
		found = nil
		UIApplication.shared.sendAction(#selector(UIResponder.paraContextMenuCaptureFirstResponder(_:)), to: nil, from: nil, for: nil)
		return found
	}
}

extension UIResponder {
	@objc func paraContextMenuCaptureFirstResponder(_ sender: Any?) {
		ParaContextMenuResponderProbe.found = self
	}
}
