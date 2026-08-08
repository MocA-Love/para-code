// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore
import UIKit

/**
 * ホームヘッダーの＋ボタン。**メニューの提示はOSに任せる**。
 *
 * iOS 26 のボタン→メニューの変形（Liquid Glass のモーフ、ばね、押し込みの手応え）は
 * Apple のドキュメントが明記しているシステム挙動:
 *
 *   “For controls like sliders and toggles, the knob transforms into Liquid Glass during
 *    interaction, and **buttons fluidly morph into menus and popovers**.”
 *    — Adopting Liquid Glass / Controls
 *
 * `UIButton` に `menu` を持たせて `showsMenuAsPrimaryAction = true` にするだけで、
 * アプリ側は `glassEffect` も `glassEffectID` も書かずにあの動きが手に入る。
 *
 * なぜ自前実装をやめたか（録画を60fpsでコマ送りして確かめた事実）:
 *  - 開くのに約17フレーム＝0.28秒。自前実装は0.55秒で倍近く遅かった
 *  - **形が角丸の長方形を一度も通らない。** ピルが液体の塊に崩れ、卵型に膨らみ、
 *    最後に長方形へ落ち着く。閉じるときは**ピーナッツ型に凹んでから**ピルへ戻る
 *  - 凹んだ形は frame と cornerRadius の補間では絶対に作れない（凸形しか出せない）。
 *    あれは2つの形をメタボールとして混ぜている結果で、手では届かない
 *  - 中身は最初ぼやけていて、あとからピントが合う（不透明度のフェードではない）
 *
 * 注意: **このビューを `GlassEffectContainer` の中へ入れてはいけない。**
 * iOS 26.1 で `Menu` をコンテナ内に置くとモーフが壊れる報告がある。
 * 呼び出し側でもヘッダーの `GlassGroup` から出してある。
 */

/** RNから受け取るメニュー1項目。`children` があれば入れ子（submenu）になる。 */
struct ParaPlusMenuItem: Record {
	/** 選択時に `onSelect` で返す識別子。区切り（section）では空でよい。 */
	@Field var id: String = ""
	@Field var title: String = ""
	/** SF Symbols の名前。空なら付けない。 */
	@Field var systemImage: String = ""
	/**
	 * この項目の**前**に区切り線を入れる。
	 * `UIMenu(options: .displayInline)` の節に分けることで描かれる。
	 */
	@Field var startsSection: Bool = false
	/**
	 * いま選ばれている項目（`UIAction.state = .on`）。チェックの位置・記号との並び順は
	 * **OSが決める**ので、こちらは状態を渡すだけにする。
	 */
	@Field var selected: Bool = false
	/** 入れ子のメニュー（「エージェントを起動」→ Claude / Codex / ターミナル）。 */
	@Field var children: [ParaPlusMenuChild] = []
}

/** 入れ子メニューの項目。さらに深い入れ子は要らないので分けてある（Recordは自己参照できない）。 */
struct ParaPlusMenuChild: Record {
	@Field var id: String = ""
	@Field var title: String = ""
	@Field var systemImage: String = ""
	@Field var selected: Bool = false
}

final class ParaPlusMenuView: ExpoView {
	private let button = UIButton(type: .system)
	private let onSelect = EventDispatcher()
	private var items: [ParaPlusMenuItem] = []

	required init(appContext: AppContext? = nil) {
		super.init(appContext: appContext)

		button.showsMenuAsPrimaryAction = true
		button.tintColor = .label
		button.accessibilityLabel = "作成と表示のメニュー"
		setSymbol("plus")
		addSubview(button)
	}

	override func layoutSubviews() {
		super.layoutSubviews()
		button.frame = bounds
		// **ボタンを必ず最前面に置く。** RNの子はあとから subview として積まれるので、
		// そのままだとボタンより前に来てタップを飲む。ヒットテストは前面から走るので、
		// 前に出しておけば「島のどこを押してもメニューが開く」になる（子は背景が透明な
		// ボタンの下に見えたまま）。
		bringSubviewToFront(button)
	}

	func setAccessibilityTitle(_ label: String) {
		button.accessibilityLabel = label.isEmpty ? "作成と表示のメニュー" : label
	}

	/**
	 * ボタンに出す SF Symbol。**空文字なら何も描かない**——ターミナル名の島のように、
	 * 見た目をRN側の子（文字とシェブロン）に任せる場合に使う。
	 */
	func setSymbol(_ name: String) {
		guard !name.isEmpty else {
			button.setImage(nil, for: .normal)
			return
		}
		let configuration = UIImage.SymbolConfiguration(pointSize: 19, weight: .regular)
		button.setImage(UIImage(systemName: name, withConfiguration: configuration), for: .normal)
	}

	func setItems(_ next: [ParaPlusMenuItem]) {
		items = next
		button.menu = buildMenu()
	}

	/**
	 * `startsSection` で区切られた塊ごとに `.displayInline` の子メニューを作る。
	 * こうするとフラットに並んだまま、塊の境目にだけ区切り線が入る（いまの divider と同じ位置）。
	 */
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
		return UIMenu(title: "", children: grouped)
	}

	private func element(for item: ParaPlusMenuItem) -> UIMenuElement {
		if !item.children.isEmpty {
			// 入れ子。開く動きもOSが描く。
			let children = item.children.map { child in
				let action = UIAction(title: child.title, image: image(named: child.systemImage)) { [weak self] _ in
					self?.onSelect(["id": child.id])
				}
				action.state = child.selected ? .on : .off
				return action
			}
			return UIMenu(title: item.title, image: image(named: item.systemImage), children: children)
		}
		let action = UIAction(title: item.title, image: image(named: item.systemImage)) { [weak self] _ in
			self?.onSelect(["id": item.id])
		}
		action.state = item.selected ? .on : .off
		return action
	}

	private func image(named name: String) -> UIImage? {
		name.isEmpty ? nil : UIImage(systemName: name)
	}
}
