// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore
import UIKit

/// JS から渡すショートカット1つぶん（`index.ts` の `KeyCommandSpec` と同じ形）。
struct ParaKeyCommandSpec: Record {
	@Field var id: String = ""
	/// `a`〜`z`・`0`〜`9`・記号1文字、または `Enter` / `Escape` / `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight`。
	@Field var input: String = ""
	/// `command` / `alternate` / `shift` / `control` の組み合わせ。
	@Field var modifiers: [String] = []
	/// ⌘ を長押ししたときの一覧に出す名前。
	@Field var title: String = ""
	/// 入力欄の標準の動き（⌘[ の字下げなど）より先に効かせるか。Esc など、付けると日本語の変換を奪うものには付けない。
	@Field var priority: Bool = false
}

/// ネイティブ側で持ち回すショートカット1つぶん（`ParaKeyCommandSpec` の写し。主スレッドへ渡すため値で持つ）。
typealias ParaKeyCommandValue = (id: String, input: String, modifiers: [String], title: String, priority: Bool)

/**
 * iPad の外付けキーボードのショートカットと、ポインタのホバーの効果。
 *
 * - `setKeyCommands`: JS が「いま効かせるショートカット」の一覧を渡す。ネイティブ側は UIKeyCommand を作って
 *   ルートの UIViewController に付け、押されたら `onKeyCommand`（`{ id }`）を JS へ送る。何をするかは JS 側
 *   （`src/ipad/shortcuts.ts`）が決める。⌘ を長押ししたときの一覧（discoverability）は OS が描く
 * - `ParaPointerHover`: 包んだ部分に UIPointerInteraction を付け、iPadOS のポインタの効果（ボタンは
 *   highlight、行は tint だけの hover）を出す
 */
public class ParaIpadInputModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaIpadInput")
		Events("onKeyCommand", "onWindowControlsInset", "onDeviceOrientation")

		OnCreate {
			ParaKeyCommandCenter.shared.onCommand = { [weak self] id in
				self?.sendEvent("onKeyCommand", ["id": id])
			}
			ParaWindowControlsObserver.shared.onChange = { [weak self] inset in
				self?.sendEvent("onWindowControlsInset", inset.payload)
			}
			ParaOrientationGate.shared.onDeviceOrientation = { [weak self] orientation in
				self?.sendEvent("onDeviceOrientation", ["orientation": orientation])
			}
		}

		// ブラウザの全画面の間だけ、iPhone の横向きを許す（`AppDelegate.swift` の
		// `application(_:supportedInterfaceOrientationsFor:)` が `ParaOrientationGate` を読む）。
		// 許さなくしたら縦に戻す。iPad は Info.plist のとおり全方向のまま（ここでは何もしない）。
		Function("setLandscapeAllowed") { (allowed: Bool) in
			DispatchQueue.main.async {
				ParaOrientationGate.shared.setLandscapeAllowed(allowed)
			}
		}

		// 端末の向き（画面が回らない縦の固定の間も届く）の見張り。`onDeviceOrientation` で
		// `portrait` / `landscape` / `other`（表を上・下に向けた・分からない）が届く（始めた直後にも 1 回）。
		Function("setDeviceOrientationObserved") { (observed: Bool) in
			DispatchQueue.main.async {
				ParaOrientationGate.shared.setObserved(observed)
			}
		}

		// ウィンドウ操作ボタン（左上の3点）を避ける余白の見張りを始める。値は `onWindowControlsInset` で届く
		// （始めた直後にも1回送る）。UIKit は主スレッドでしか触れないので、ここでは頼むだけ。
		Function("startWindowControlsObserver") {
			DispatchQueue.main.async {
				ParaWindowControlsObserver.shared.start()
			}
		}

		// 開発ビルド専用: 各レイアウト領域の生の余白（1回目の呼び出しで主スレッドに測らせ、次の呼び出しで読む）。
		Function("devDescribeWindowControls") { () -> [String: Any] in
			#if DEBUG
			DispatchQueue.main.async {
				ParaWindowControlsObserver.shared.devMeasure()
			}
			return ParaWindowControlsObserver.shared.devSnapshot
			#else
			return [:]
			#endif
		}

		Function("setKeyCommands") { (specs: [ParaKeyCommandSpec]) in
			let copied: [ParaKeyCommandValue] = specs.map { (id: $0.id, input: $0.input, modifiers: $0.modifiers, title: $0.title, priority: $0.priority) }
			DispatchQueue.main.async {
				ParaKeyCommandCenter.shared.apply(copied)
			}
		}

		OnDestroy {
			ParaKeyCommandCenter.shared.onCommand = nil
			ParaWindowControlsObserver.shared.onChange = nil
			ParaOrientationGate.shared.onDeviceOrientation = nil
		}

		// 開発ビルド専用: 登録したショートカットと、いまのファーストレスポンダを返す（シミュレータでの確認用）。
		Function("devDescribeKeyCommands") { () -> [String: Any] in
			#if DEBUG
			return ParaKeyCommandCenter.shared.devDescribe()
			#else
			return [:]
			#endif
		}

		// 開発ビルド専用: 登録したショートカットを、押されたときと同じくレスポンダチェーン経由で送る。
		Function("devFireKeyCommand") { (id: String) -> Bool in
			#if DEBUG
			return ParaKeyCommandCenter.shared.devFire(id)
			#else
			return false
			#endif
		}

		// 開発ビルド専用: シミュレータで向きを変える（`src/devProbe.tsx` の `__paraDev.orientation()`）。
		Function("devRequestOrientation") { (landscape: Bool) in
			#if DEBUG
			DispatchQueue.main.async {
				guard #available(iOS 16.0, *) else { return }
				let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
				scene?.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
				scene?.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeLeft : .portrait)) { error in
					NSLog("[para-dev] requestGeometryUpdate failed: %@", error.localizedDescription)
				}
			}
			#endif
		}

		View(ParaPointerHoverView.self) {
			Prop("effect") { (view: ParaPointerHoverView, effect: String) in
				view.effect = effect
			}
			Prop("cornerRadius") { (view: ParaPointerHoverView, radius: Double) in
				view.hoverCornerRadius = CGFloat(radius)
			}
		}
	}
}

/**
 * UIKeyCommand の置き場所。
 *
 * コマンドはルートの UIViewController に `addKeyCommand` で付ける。ハードウェアキーボードのショートカットは
 * ファーストレスポンダから順にレスポンダチェーンをたどって探されるので、入力欄（RN の TextInput、
 * 会話や xterm の WebView）がフォーカスを持っていても、その祖先にあるルートの画面まで届く。
 * モーダル（RN の Modal）の中にいても、提示元の画面を経由してルートまで届く。
 *
 * 何もフォーカスを持っていないとチェーンの起点が無く、ルートの画面まで届かない。そのときだけ、ルートの
 * view の中に置いた見えない `ParaKeyCommandAnchor` をファーストレスポンダにしてチェーンの起点にする。
 * 入力欄の編集が終わったとき・キーボードが下がったとき（WKWebView から外れた場合）・アプリが前面に戻ったときに、
 * 誰もフォーカスを持っていなければ付け直す。
 */
final class ParaKeyCommandCenter {
	static let shared = ParaKeyCommandCenter()

	var onCommand: ((String) -> Void)?

	private var commands: [UIKeyCommand] = []
	private weak var owner: UIViewController?
	private var anchor: ParaKeyCommandAnchor?
	private var observers: [NSObjectProtocol] = []
	private var lastSpecs: [ParaKeyCommandValue] = []

	private init() {
		let center = NotificationCenter.default
		let reclaim: (Notification) -> Void = { [weak self] _ in self?.scheduleReclaim() }
		observers.append(center.addObserver(forName: UITextField.textDidEndEditingNotification, object: nil, queue: .main, using: reclaim))
		observers.append(center.addObserver(forName: UITextView.textDidEndEditingNotification, object: nil, queue: .main, using: reclaim))
		// 会話・ターミナルの WKWebView からフォーカスが外れても、上の2つは来ない。キーボードが下がったのを合図にする。
		observers.append(center.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main, using: reclaim))
		observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: { [weak self] _ in
			// 前面へ戻る間にルートの画面が作り直されていることがあるので、付け直しから行う。
			guard let self else { return }
			self.apply(self.lastSpecs)
		}))
	}

	func apply(_ specs: [ParaKeyCommandValue]) {
		lastSpecs = specs
		guard let root = rootViewController() else {
			return
		}
		if let previous = owner {
			for command in commands {
				previous.removeKeyCommand(command)
			}
		}
		commands = specs.compactMap(makeCommand)
		for command in commands {
			root.addKeyCommand(command)
		}
		owner = root
		// ショートカットを使わない端末（iPhone）・画面では、見えない起点も置かない。
		guard !commands.isEmpty else {
			return
		}
		installAnchor(in: root)
		scheduleReclaim()
	}

	#if DEBUG
	func devDescribe() -> [String: Any] {
		let responder = ParaFirstResponderProbe.current()
		let rootCommands = owner?.keyCommands?.compactMap { $0.propertyList as? String } ?? []
		return [
			"registered": commands.compactMap { $0.propertyList as? String },
			"onRoot": rootCommands,
			"firstResponder": responder.map { String(describing: type(of: $0)) } ?? "nil",
			"anchorInWindow": anchor?.window != nil,
		]
	}

	func devFire(_ id: String) -> Bool {
		guard let command = commands.first(where: { ($0.propertyList as? String) == id }), let action = command.action else {
			return false
		}
		// 押されたときと同じく、ファーストレスポンダからチェーンをたどって受け口を探させる。
		return UIApplication.shared.sendAction(action, to: nil, from: command, for: nil)
	}
	#endif

	func handle(_ command: UIKeyCommand) {
		guard let id = command.propertyList as? String else {
			return
		}
		onCommand?(id)
	}

	private func makeCommand(_ spec: ParaKeyCommandValue) -> UIKeyCommand? {
		guard let input = keyInput(spec.input) else {
			return nil
		}
		var flags: UIKeyModifierFlags = []
		for modifier in spec.modifiers {
			switch modifier {
			case "command": flags.insert(.command)
			case "alternate": flags.insert(.alternate)
			case "shift": flags.insert(.shift)
			case "control": flags.insert(.control)
			default: break
			}
		}
		let command = UIKeyCommand(
			title: spec.title,
			image: nil,
			action: #selector(UIViewController.paraHandleKeyCommand(_:)),
			input: input,
			modifierFlags: flags,
			propertyList: spec.id,
			alternates: [],
			discoverabilityTitle: spec.title,
			attributes: [],
			state: .off
		)
		if #available(iOS 15.0, *), spec.priority {
			// 入力欄の標準の動き（⌘[ の字下げなど）より、こちらの割り当てを先に効かせる。全部に付けると、
			// 日本語の変換中の Esc（変換の取り消し）までシート・ドックを閉じる側が奪うので、JS が指定したものだけ。
			command.wantsPriorityOverSystemBehavior = true
		}
		return command
	}

	private func keyInput(_ name: String) -> String? {
		switch name {
		case "Enter": return "\r"
		case "Escape": return UIKeyCommand.inputEscape
		case "ArrowUp": return UIKeyCommand.inputUpArrow
		case "ArrowDown": return UIKeyCommand.inputDownArrow
		case "ArrowLeft": return UIKeyCommand.inputLeftArrow
		case "ArrowRight": return UIKeyCommand.inputRightArrow
		default: return name.count == 1 ? name : nil
		}
	}

	private func rootViewController() -> UIViewController? {
		let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
		let windows = scenes.flatMap { $0.windows }
		return (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController
	}

	private func installAnchor(in root: UIViewController) {
		guard let view = root.view else {
			return
		}
		if let anchor, anchor.superview === view {
			return
		}
		anchor?.removeFromSuperview()
		let next = ParaKeyCommandAnchor(frame: .zero)
		view.addSubview(next)
		anchor = next
	}

	/// 誰もフォーカスを持っていなければ、見えない起点をファーストレスポンダにする（入力欄からは奪わない）。
	private func scheduleReclaim() {
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
			guard let self, let anchor = self.anchor, anchor.window != nil, !self.commands.isEmpty else {
				return
			}
			if ParaFirstResponderProbe.current() == nil {
				anchor.becomeFirstResponder()
			}
		}
	}
}

/// フォーカスを持つものが無いときのレスポンダチェーンの起点（見えない・触れない・読み上げない）。
final class ParaKeyCommandAnchor: UIView {
	override init(frame: CGRect) {
		super.init(frame: frame)
		isUserInteractionEnabled = false
		isAccessibilityElement = false
		accessibilityElementsHidden = true
	}

	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	override var canBecomeFirstResponder: Bool { true }
}

/// いまのファーストレスポンダを公開 API だけで調べる（`sendAction(_:to: nil ...)` は起点のレスポンダへ届く）。
enum ParaFirstResponderProbe {
	fileprivate static weak var found: UIResponder?

	static func current() -> UIResponder? {
		found = nil
		UIApplication.shared.sendAction(#selector(UIResponder.paraCaptureFirstResponder(_:)), to: nil, from: nil, for: nil)
		return found
	}
}

extension UIResponder {
	@objc func paraCaptureFirstResponder(_ sender: Any?) {
		ParaFirstResponderProbe.found = self
	}
}

extension UIViewController {
	/// UIKeyCommand の受け口。チェーンの途中のどの画面で受けても、中身は1か所へ集める。
	@objc func paraHandleKeyCommand(_ sender: UIKeyCommand) {
		ParaKeyCommandCenter.shared.handle(sender)
	}
}

/**
 * 包んだ部分にポインタの効果を付ける（iPad だけ）。
 *  - `highlight`: 小さいボタン。ポインタがボタンの形に変わり、ボタンが少し浮く
 *  - `tint`: 行。ポインタの形は変えず、行の上に薄い色を重ねるだけ
 *
 * **効果のビューを React の管理するビューへ入れさせない。** ポインタの効果が出ている間（押した後に消えていく
 * 約0.5秒も含む）、UIKit は台・ポータルなどのビューをプレビューの `target.container` へ `insertSubview(_:at:)` で
 * 差し込む（`_UIPointerContentEffect._ensureRelativeEffectViewOrderInContainer`）。`UITargetedPreview(view:parameters:)`
 * のように置き場所を指定しないと、置き場所は包んだビューの親＝React の管理するビュー（ヘッダーのように平らに
 * たたまれていれば画面の根）になる。React は子の位置を番号で覚えているので、その間に子を足すと1つずれた位置へ
 * 入り、後で外すときに `Attempt to unmount a view which has a different index` で落ちる（2026-09-27、
 * ヘッダーのソース管理ボタンを押してドックを開き、もう一度押して閉じたときに実際に落ちた）。
 *
 * そこで React の子は内側の `contentHost` に入れ、プレビューはその `contentHost` を、置き場所は自分自身を指す。
 * 効果のビューは自分の直下（React が番号で触らない階層）にだけ入る。
 *
 * **当たり判定は自分の枠で切らない。** 包んだボタン（Pressable）は hitSlop で見た目より広く（44pt）押せるように
 * してあるが、RN の `betterHitTest` は子が枠からはみ出していないと枠の外の点を捨て、素の UIView の `contentHost`
 * も自分の枠で切る。そのままだと iPad でだけ押せる範囲が見た目の大きさに縮むので、枠の外の点も React の子に
 * 聞き直す（`hitTest(_:with:)` と `ParaPointerHoverContentHost`）。ポインタの効果の範囲（見た目）は変えない。
 */
final class ParaPointerHoverView: ExpoView, UIPointerInteractionDelegate {
	var effect: String = "highlight"
	var hoverCornerRadius: CGFloat = 8
	/// React の子を入れる中身。ポインタの効果はこれを写して、自分の直下に台を置く。
	private let contentHost = ParaPointerHoverContentHost()

	required init(appContext: AppContext? = nil) {
		super.init(appContext: appContext)
		contentHost.frame = bounds
		contentHost.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		addSubview(contentHost)
		if UIDevice.current.userInterfaceIdiom == .pad {
			addInteraction(UIPointerInteraction(delegate: self))
		}
	}

	override func layoutSubviews() {
		super.layoutSubviews()
		contentHost.frame = bounds
	}

	override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
		contentHost.insertSubview(childComponentView, at: index)
	}

	override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
		childComponentView.removeFromSuperview()
	}

	override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
		// 枠の中は RN の既定どおり（pointerEvents なども RN が見る）。
		if let hit = super.hitTest(point, with: event) {
			return hit
		}
		// 枠の外は、hitSlop で広げた React の子が受けるかどうかだけを聞く（自分・contentHost は受けない）。
		guard isUserInteractionEnabled, !isHidden, alpha >= 0.01 else {
			return nil
		}
		return contentHost.hitTest(contentHost.convert(point, from: self), with: event)
	}

	func pointerInteraction(_ interaction: UIPointerInteraction, styleFor region: UIPointerRegion) -> UIPointerStyle? {
		guard window != nil, contentHost.bounds.width > 0, contentHost.bounds.height > 0 else {
			return nil
		}
		let parameters = UIPreviewParameters()
		parameters.visiblePath = UIBezierPath(roundedRect: contentHost.bounds, cornerRadius: hoverCornerRadius)
		let target = UIPreviewTarget(container: self, center: CGPoint(x: contentHost.frame.midX, y: contentHost.frame.midY))
		let preview = UITargetedPreview(view: contentHost, parameters: parameters, target: target)
		switch effect {
		case "tint":
			return UIPointerStyle(effect: .hover(preview, preferredTintMode: .overlay, prefersShadow: false, prefersScaledContent: false))
		default:
			return UIPointerStyle(effect: .highlight(preview))
		}
	}
}

/**
 * `ParaPointerHoverView` の中身の入れ物。当たり判定を自分の枠で切らず、React の子（hitSlop で枠より広く
 * 押せるボタン）に委ねる。子が受けなければ自分も受けない（外側の `ParaPointerHoverView` が RN の既定どおりに扱う）。
 */
final class ParaPointerHoverContentHost: UIView {
	override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
		guard isUserInteractionEnabled, !isHidden, alpha >= 0.01 else {
			return nil
		}
		for child in subviews.reversed() {
			if let hit = child.hitTest(child.convert(point, from: self), with: event) {
				return hit
			}
		}
		return nil
	}
}

/// ウィンドウ操作ボタンを避けるために足す余白（pt）。素のセーフエリアに上乗せする分だけを持つ。
struct ParaWindowControlsInset: Equatable {
	/// 画面の上端に置く帯（見出し）の先頭に足す幅。ボタンの右端まで。
	var leading: CGFloat = 0

	var payload: [String: Double] {
		["leading": Double(leading)]
	}
}

/**
 * iPadOS 26 以降のウィンドウ操作ボタン（ウィンドウアプリのときに左上へ出る閉じる・最小化・並べるの3点）を
 * 避ける余白を測り、変わったら知らせる。
 *
 * UIKit の標準のナビゲーションバーはボタンを自動で避けるが、このアプリの見出しは React Native で描いた
 * 自前の帯なので、自分で避ける。Apple の推奨（WWDC25「Make your UIKit app more flexible」）は
 * `layoutGuide(for: .margins(cornerAdaptation: .horizontal))` で「画面の上端の帯はボタンの右端から始める」こと。
 * ここでは同じ領域の `edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))` と素の `safeAreaInsets` の
 * 差をボタンの幅として JS へ渡す（余白の大きさは見出しが自分で持っているので、margins ではなく safeArea を使う）。
 *
 * **corner adaptation はウィンドウ操作ボタンだけでなく、画面・ウィンドウの角の丸みでも値を返す。** 実測
 * （2026-09-27、Xcode 27 / iOS 27 シミュレータ）で、iPhone 17 Pro の縦向きは素のセーフエリアが左右 0 なのに
 * 左右とも 18、iPad のウィンドウアプリ（幅 469）は左 66・右 9.5 だった。角の丸みは左右同じだけ付くので、
 * 先頭の側が末尾の側より大きいときだけ「ボタンがある」とみなし、そうでなければ 0 にする。
 *
 * 測る場所はルートの画面の view。ウィンドウの大きさ・全画面 ⇄ ウィンドウ・ボタンの形が変わるとルートの
 * view の大きさかセーフエリアが変わるので、そこに敷いた見えない `ParaWindowControlsProbe` の
 * `layoutSubviews` / `safeAreaInsetsDidChange` を合図に測り直す。
 */
final class ParaWindowControlsObserver {
	static let shared = ParaWindowControlsObserver()

	var onChange: ((ParaWindowControlsInset) -> Void)?
	#if DEBUG
	private(set) var devSnapshot: [String: Any] = [:]
	#endif

	private var current = ParaWindowControlsInset()
	private var probe: ParaWindowControlsProbe?
	private var pending = false
	private var observers: [NSObjectProtocol] = []

	private init() {
		let center = NotificationCenter.default
		// 前面へ戻る間にルートの画面が作り直されていることがあるので、敷き直してから測る。
		observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
			self?.start()
		})
	}

	/// 見張りを敷いて、いまの値を（変わっていなくても）1回送る。主スレッドで呼ぶ。
	func start() {
		// ウィンドウ操作ボタンは iPad だけのもの。iPhone では見張りを敷かず、値（常に 0）も送らない。
		guard UIDevice.current.userInterfaceIdiom == .pad else {
			return
		}
		installProbe()
		current = measure()
		onChange?(current)
	}

	/// 大きさ・セーフエリアが変わった合図。同じ回のレイアウトで何度来ても1回だけ測る（レイアウトが落ち着いてから）。
	fileprivate func scheduleMeasure() {
		guard !pending else {
			return
		}
		pending = true
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			self.pending = false
			let next = self.measure()
			if next != self.current {
				self.current = next
				self.onChange?(next)
			}
		}
	}

	private func rootView() -> UIView? {
		let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
		let windows = scenes.flatMap { $0.windows }
		return (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController?.view
	}

	private func installProbe() {
		guard UIDevice.current.userInterfaceIdiom == .pad, let view = rootView() else {
			return
		}
		if let probe, probe.superview === view {
			return
		}
		probe?.removeFromSuperview()
		let next = ParaWindowControlsProbe(frame: view.bounds)
		next.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		next.observer = self
		// 一番奥に敷く（触れない・読み上げない・描かないので、見た目にも操作にも関わらない）。
		view.insertSubview(next, at: 0)
		probe = next
	}

	private func measure() -> ParaWindowControlsInset {
		// ウィンドウ操作ボタンは iPad のウィンドウアプリだけのもの。iPhone は常に 0（画面の角の丸みで
		// corner adaptation が値を返しても、それはセーフエリアの話で見出しをずらす理由にならない）。
		guard UIDevice.current.userInterfaceIdiom == .pad, #available(iOS 26.0, *), let view = rootView(), view.window != nil else {
			return ParaWindowControlsInset()
		}
		let safe = view.safeAreaInsets
		let horizontal = view.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))
		let leadingIsLeft = view.effectiveUserInterfaceLayoutDirection == .leftToRight
		let left = horizontal.left - safe.left
		let right = horizontal.right - safe.right
		let leading = leadingIsLeft ? left : right
		let trailing = leadingIsLeft ? right : left
		// 角の丸みだけ（左右同じ）なら 0。ボタンのぶんだけ先頭の側が大きくなる。
		guard leading - trailing > 1 else {
			return ParaWindowControlsInset()
		}
		return ParaWindowControlsInset(leading: max(0, leading.rounded()))
	}

	#if DEBUG
	func devMeasure() {
		installProbe()
		guard let view = rootView() else {
			devSnapshot = ["root": "nil"]
			return
		}
		func describe(_ insets: UIEdgeInsets) -> [String: Double] {
			["top": Double(insets.top), "left": Double(insets.left), "bottom": Double(insets.bottom), "right": Double(insets.right)]
		}
		var snapshot: [String: Any] = [
			"bounds": ["width": Double(view.bounds.width), "height": Double(view.bounds.height)],
			"safeArea": describe(view.safeAreaInsets),
			"current": current.payload,
			"probeInstalled": probe?.superview === view,
		]
		if #available(iOS 26.0, *) {
			snapshot["safeAreaHorizontal"] = describe(view.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal)))
			snapshot["safeAreaVertical"] = describe(view.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)))
			snapshot["marginsHorizontal"] = describe(view.edgeInsets(for: .margins(cornerAdaptation: .horizontal)))
			snapshot["margins"] = describe(view.edgeInsets(for: .margins()))
			if let scene = view.window?.windowScene {
				let frame = scene.effectiveGeometry.coordinateSpace.bounds
				snapshot["sceneBounds"] = ["width": Double(frame.width), "height": Double(frame.height)]
			}
		}
		devSnapshot = snapshot
	}
	#endif
}

/**
 * ルートの view いっぱいに敷く見えない view。大きさやセーフエリアが変わったら測り直しを頼む。
 *
 * 大きさが変わらずに領域だけ変わる場合（ボタンの出方が変わったときなど）も拾えるよう、中に置いた
 * `marker` を `layoutGuide(for: .safeArea(cornerAdaptation: .horizontal))` に貼り付けておく。領域が動くと
 * Auto Layout が marker を動かし、そのたびにこの view の `layoutSubviews` が呼ばれる。
 */
final class ParaWindowControlsProbe: UIView {
	weak var observer: ParaWindowControlsObserver?
	private let marker = UIView()

	override init(frame: CGRect) {
		super.init(frame: frame)
		isUserInteractionEnabled = false
		isAccessibilityElement = false
		accessibilityElementsHidden = true
		backgroundColor = .clear
		if #available(iOS 26.0, *) {
			marker.translatesAutoresizingMaskIntoConstraints = false
			marker.isUserInteractionEnabled = false
			addSubview(marker)
			let guide = layoutGuide(for: .safeArea(cornerAdaptation: .horizontal))
			NSLayoutConstraint.activate([
				marker.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
				marker.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
				marker.topAnchor.constraint(equalTo: guide.topAnchor),
				marker.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
			])
		}
	}

	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	override func layoutSubviews() {
		super.layoutSubviews()
		observer?.scheduleMeasure()
	}

	override func safeAreaInsetsDidChange() {
		super.safeAreaInsetsDidChange()
		observer?.scheduleMeasure()
	}
}

/**
 * iPhone の横向きの許可（ブラウザの全画面の間だけ）と、端末の向きの見張り。
 *
 * アプリは縦に固定している（Info.plist の `UISupportedInterfaceOrientations` は縦だけ）。`AppDelegate.swift` の
 * `application(_:supportedInterfaceOrientationsFor:)` が {@link supportedOrientations(base:)} を返すので、
 * 許している間だけ iPhone でも横向きを含める。iPad は Info.plist のとおり（`base` をそのまま返す）。
 * `ios/` は git の管理外なので、AppDelegate への手当ては `NOTES.md` に記録してある。
 */
public final class ParaOrientationGate {
	public static let shared = ParaOrientationGate()

	var onDeviceOrientation: ((String) -> Void)?

	private var landscapeAllowed = false
	private var observing = false
	private var observer: NSObjectProtocol?
	private var lastReported: String?

	/** AppDelegate から呼ぶ。主スレッドで呼ばれる。 */
	public func supportedOrientations(base: UIInterfaceOrientationMask) -> UIInterfaceOrientationMask {
		if UIDevice.current.userInterfaceIdiom == .pad || !landscapeAllowed {
			return base
		}
		return base.union(.landscape)
	}

	func setLandscapeAllowed(_ allowed: Bool) {
		guard allowed != landscapeAllowed else { return }
		landscapeAllowed = allowed
		guard UIDevice.current.userInterfaceIdiom != .pad else { return }
		guard #available(iOS 16.0, *) else { return }
		let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
		for scene in scenes {
			for window in scene.windows {
				window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
			}
		}
		// 許したときは、端末がもう横なら横へ回す（倒してから入ったときに、もう一度倒し直さなくてよいように）。
		// 許さなくしたときは縦へ戻す。
		let device = UIDevice.current.orientation
		let target: UIInterfaceOrientationMask? = allowed
			? (device == .landscapeLeft ? .landscapeRight : device == .landscapeRight ? .landscapeLeft : nil)
			: .portrait
		guard let target else { return }
		for scene in scenes {
			scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { error in
				NSLog("[ParaOrientationGate] requestGeometryUpdate failed: %@", error.localizedDescription)
			}
		}
	}

	func setObserved(_ observed: Bool) {
		guard observed != observing else { return }
		observing = observed
		if observed {
			UIDevice.current.beginGeneratingDeviceOrientationNotifications()
			observer = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
				self?.report()
			}
			lastReported = nil
			report()
		} else {
			if let observer {
				NotificationCenter.default.removeObserver(observer)
			}
			observer = nil
			UIDevice.current.endGeneratingDeviceOrientationNotifications()
		}
	}

	private func report() {
		let orientation: String
		switch UIDevice.current.orientation {
		case .portrait, .portraitUpsideDown:
			orientation = "portrait"
		case .landscapeLeft, .landscapeRight:
			orientation = "landscape"
		default:
			orientation = "other"
		}
		guard orientation != lastReported else { return }
		lastReported = orientation
		onDeviceOrientation?(orientation)
	}
}
