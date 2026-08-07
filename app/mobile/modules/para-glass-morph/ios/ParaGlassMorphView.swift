// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import ExpoModulesCore
import SwiftUI

/**
 * ホームの＋メニュー用の「ガラスの形」だけを描くビュー。
 *
 * 閉=ヘッダーのピルと同一frameのカプセル、開=メニューのパネル。2つの形を同じ
 * `glassEffectID` で `isExpanded` に応じて入れ替えると、`GlassEffectContainer` が
 * カプセル⇄パネルの液体モーフ（融合の首・バウンス）を描く。
 *
 * 要点は **RNから来たprop（`props.isExpanded`）をそのまま使わず、`.onChange` で受けて
 * ローカル `@State` への代入を `withAnimation` の中で行う**こと。RN側のprop更新は
 * SwiftUIのアニメーショントランザクションに乗らないため、直接使うと形がスナップする
 * （@expo/ui の modifier 経由で実測済み）。
 *
 * 中身（ボタンやメニューの行）はこのビューでは描かない。RN側が上のレイヤーに重ねる。
 */
final class ParaGlassMorphViewProps: ExpoSwiftUI.ViewProps {
	@Field var isExpanded: Bool = false
	@Field var pillWidth: CGFloat = 112
	@Field var pillHeight: CGFloat = 40
	@Field var panelWidth: CGFloat = 274
	@Field var panelHeight: CGFloat = 300
	@Field var panelCornerRadius: CGFloat = 30
	/** パネルに足す色被せ（#RRGGBBAA）。空なら被せない。 */
	@Field var panelTint: String = ""
	@Field var expandDuration: CGFloat = 0.55
	@Field var expandBounce: CGFloat = 0.25
	@Field var collapseDuration: CGFloat = 0.35
	@Field var collapseBounce: CGFloat = 0.08
}

struct ParaGlassMorphView: ExpoSwiftUI.View, ExpoSwiftUI.WithHostingView {
	@ObservedObject var props: ParaGlassMorphViewProps
	@State private var expanded: Bool = false
	@Namespace private var ns

	init(props: ParaGlassMorphViewProps) {
		self.props = props
	}

	private var panelColor: Color? {
		let hex = props.panelTint.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
		// 16進以外の文字が混ざった入力はScannerが前方一致で「成功」してしまい黙って
		// 誤った色になるので、先に全文字を検査して弾く。
		guard !hex.isEmpty, hex.allSatisfy(\.isHexDigit) else { return nil }
		var value: UInt64 = 0
		guard Scanner(string: hex).scanHexInt64(&value) else { return nil }
		let r, g, b, a: UInt64
		switch hex.count {
		case 6:
			(r, g, b, a) = (value >> 16 & 0xFF, value >> 8 & 0xFF, value & 0xFF, 255)
		case 8:
			(r, g, b, a) = (value >> 24 & 0xFF, value >> 16 & 0xFF, value >> 8 & 0xFF, value & 0xFF)
		default:
			return nil
		}
		return Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255, opacity: Double(a) / 255)
	}

	var body: some View {
		if #available(iOS 26.0, *) {
			GlassEffectContainer(spacing: 40) {
				ZStack(alignment: .topTrailing) {
					if expanded {
						Color.clear
							.frame(width: props.panelWidth, height: props.panelHeight)
							.glassEffect(
								panelColor.map { Glass.regular.tint($0) } ?? .regular,
								in: .rect(cornerRadius: props.panelCornerRadius)
							)
							.glassEffectID("paraPlusBubble", in: ns)
					} else {
						Color.clear
							.frame(width: props.pillWidth, height: props.pillHeight)
							.glassEffect(.regular, in: .capsule)
							.glassEffectID("paraPlusBubble", in: ns)
					}
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
			}
			.onAppear {
				expanded = props.isExpanded
			}
			.onChange(of: props.isExpanded) { _, newValue in
				withAnimation(
					newValue
						? .spring(duration: props.expandDuration, bounce: props.expandBounce)
						: .spring(duration: props.collapseDuration, bounce: props.collapseBounce)
				) {
					expanded = newValue
				}
			}
		} else {
			// iOS 26未満のバイナリで誤ってマウントされた場合は何も描かない
			// （RN側は liquidGlass 判定でこの経路に来ない）。
			Color.clear
		}
	}
}
