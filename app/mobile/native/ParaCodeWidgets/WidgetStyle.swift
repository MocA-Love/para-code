// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
// ホーム画面・ロック画面のウィジェットの共通の見た目（色・状態の印・見出し・ボタン・時刻の書き方）。
// 値は /widgets モック（paracode-widgets-mock.html の .wg 系のトークン）に合わせている。
// 状態は色だけで表さず形でも表す（ティント・クリアの外観では色が白一色になるため）。

import SwiftUI
import UIKit
import WidgetKit

// MARK: - 色

@available(iOS 17.0, *)
struct WidgetPalette {
	var text: Color
	var dim: Color
	var muted: Color
	var panel: Color
	var raised: Color
	var line: Color
	var red: Color
	var yellow: Color
	var green: Color
	var ok: Color
	var add: Color
	var del: Color
	var priBg: Color
	var priTx: Color
	var background: Color
	/// ティント・クリア（accented）とロック画面（vibrant）。色を捨てて白の濃淡で描く。
	var monochrome: Bool

	static func make(mode: WidgetRenderingMode, scheme: ColorScheme, accentHex: String?) -> WidgetPalette {
		if mode != .fullColor {
			return WidgetPalette(
				text: .white, dim: .white.opacity(0.72), muted: .white.opacity(0.55),
				panel: .white.opacity(0.10), raised: .white.opacity(0.18), line: .white.opacity(0.2),
				red: .white, yellow: .white, green: .white, ok: .white, add: .white, del: .white,
				priBg: .white.opacity(0.26), priTx: .white, background: .clear, monochrome: true
			)
		}
		let dark = scheme == .dark
		var palette = dark
			? WidgetPalette(
				text: Color(hex: 0xE0E0E0), dim: Color(hex: 0xA1A1A1), muted: Color(hex: 0x8C8C8C),
				panel: Color(hex: 0x1A1A1A), raised: Color(hex: 0x242424), line: Color(hex: 0x2A2A2A),
				red: Color(hex: 0xEF4444), yellow: Color(hex: 0xEAB308), green: Color(hex: 0x10B981), ok: Color(hex: 0x22C55E),
				add: Color(hex: 0x81B88B), del: Color(hex: 0xC74E39),
				priBg: Color(hex: 0xE0E0E0), priTx: Color(hex: 0x111111), background: Color(hex: 0x111111), monochrome: false
			)
			: WidgetPalette(
				text: Color(hex: 0x1A1A1A), dim: Color(hex: 0x5C5C5C), muted: Color(hex: 0x767676),
				panel: Color(hex: 0xF2F2F3), raised: Color(hex: 0xE8E8EA), line: Color(hex: 0xE2E2E4),
				red: Color(hex: 0xDC2626), yellow: Color(hex: 0xB7791F), green: Color(hex: 0x0F9F6E), ok: Color(hex: 0x16A34A),
				add: Color(hex: 0x2F8A3E), del: Color(hex: 0xB8412B),
				priBg: Color(hex: 0x1A1A1A), priTx: .white, background: .white, monochrome: false
			)
		// 設定 → ウィジェットのアクセント（主ボタンの色）。文字色は明るさで白黒を選ぶ。
		if let accentHex, let value = parseHex(accentHex) {
			palette.priBg = Color(hex: value)
			palette.priTx = luminance(value) > 0.55 ? Color(hex: 0x111111) : .white
		}
		return palette
	}

	func stateColor(_ state: String) -> Color {
		switch state {
		case "approve", "question", "error": return red
		case "running": return yellow
		case "unread": return green
		default: return muted
		}
	}

	private static func parseHex(_ hex: String) -> UInt32? {
		let trimmed = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
		guard trimmed.count == 6 else { return nil }
		return UInt32(trimmed, radix: 16)
	}

	private static func luminance(_ value: UInt32) -> Double {
		let r = Double((value >> 16) & 0xFF) / 255
		let g = Double((value >> 8) & 0xFF) / 255
		let b = Double(value & 0xFF) / 255
		return 0.2126 * r + 0.7152 * g + 0.0722 * b
	}
}

extension Color {
	init(hex: UInt32) {
		self.init(
			.sRGB,
			red: Double((hex >> 16) & 0xFF) / 255,
			green: Double((hex >> 8) & 0xFF) / 255,
			blue: Double(hex & 0xFF) / 255,
			opacity: 1
		)
	}
}

// MARK: - 文言

enum WidgetText {
	static let stateLabels: [String: String] = [
		"approve": "許可待ち", "question": "質問", "error": "エラー",
		"running": "実行中", "unread": "未確認", "idle": "待機",
	]

	static func stateLabel(_ state: String) -> String {
		return stateLabels[state] ?? "待機"
	}

	static func kindLabel(_ kind: String) -> String {
		switch kind {
		case "claude": return "Claude"
		case "codex": return "Codex"
		default: return "エージェント"
		}
	}

	/// 「3分」「2時間」（行の右端に収める短い形。アプリの formatElapsedShort と同じ）。
	static func elapsedShort(since ms: Double, now: Date) -> String {
		let minutes = Int(max(0, now.timeIntervalSince1970 * 1000 - ms) / 60_000)
		if minutes < 1 { return "いま" }
		if minutes < 60 { return "\(minutes)分" }
		let hours = minutes / 60
		if hours < 24 { return "\(hours)時間" }
		return "\(hours / 24)日"
	}

	/// 「2分前の状態」。
	static func freshness(_ ms: Double?, now: Date) -> String {
		guard let ms else { return "状態は未取得" }
		let minutes = Int(max(0, now.timeIntervalSince1970 * 1000 - ms) / 60_000)
		if minutes < 1 { return "いまの状態" }
		if minutes < 60 { return "\(minutes)分前の状態" }
		let hours = minutes / 60
		if hours < 24 { return "\(hours)時間前の状態" }
		return "\(hours / 24)日前の状態"
	}

	/// 「9分前」（コストと上限を取った時刻など）。
	static func ago(_ ms: Double, now: Date) -> String {
		let minutes = Int(max(0, now.timeIntervalSince1970 * 1000 - ms) / 60_000)
		if minutes < 1 { return "たった今" }
		if minutes < 60 { return "\(minutes)分前" }
		let hours = minutes / 60
		if hours < 24 { return "\(hours)時間前" }
		return "\(hours / 24)日前"
	}

	/// 「1時間20分後」。
	static func until(_ ms: Double?, now: Date) -> String? {
		guard let ms else { return nil }
		let minutes = Int((ms - now.timeIntervalSince1970 * 1000) / 60_000)
		if minutes <= 0 { return nil }
		let days = minutes / (60 * 24)
		if days > 0 { return "\(days)日後" }
		let hours = minutes / 60
		if hours > 0 { return minutes % 60 > 0 ? "\(hours)時間\(minutes % 60)分後" : "\(hours)時間後" }
		return "\(minutes)分後"
	}

	static func cost(_ value: Double?) -> String {
		guard let value else { return "—" }
		return String(format: "$%.2f", value)
	}

	static func bytes(_ value: Double?) -> String {
		guard let value, value > 0 else { return "—" }
		let gb = value / 1_073_741_824
		return gb >= 1000 ? String(format: "%.1f TB", gb / 1024) : "\(Int(gb.rounded())) GB"
	}
}

// MARK: - 部品

/// Para Code のロゴ（角丸の枠と P）。モックの #pc-logo。
struct ParaLogoShape: Shape {
	func path(in rect: CGRect) -> Path {
		let s = min(rect.width, rect.height) / 24
		var path = Path()
		path.addRoundedRect(in: CGRect(x: rect.minX + 2.5 * s, y: rect.minY + 2.5 * s, width: 19 * s, height: 19 * s), cornerSize: CGSize(width: 5.5 * s, height: 5.5 * s))
		path.move(to: CGPoint(x: rect.minX + 8.5 * s, y: rect.minY + 16.5 * s))
		path.addLine(to: CGPoint(x: rect.minX + 8.5 * s, y: rect.minY + 7.5 * s))
		path.addLine(to: CGPoint(x: rect.minX + 12.7 * s, y: rect.minY + 7.5 * s))
		path.addArc(center: CGPoint(x: rect.minX + 12.7 * s, y: rect.minY + 10.5 * s), radius: 3 * s, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
		path.addLine(to: CGPoint(x: rect.minX + 8.5 * s, y: rect.minY + 13.5 * s))
		return path
	}
}

struct ParaLogo: View {
	var size: CGFloat
	var color: Color
	var body: some View {
		ZStack {
			ParaLogoShape()
				.stroke(color, style: StrokeStyle(lineWidth: size / 12, lineCap: .round, lineJoin: .round))
			Circle()
				.fill(color)
				.frame(width: size * 2.6 / 24, height: size * 2.6 / 24)
				.offset(x: size * (15.8 - 12) / 24, y: size * (16.3 - 12) / 24)
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

/// 状態の印。要対応=塗りの丸、エラー=塗りの丸に「!」、実行中=弧、未確認=チェック入りの丸、待機=白抜きの丸。
@available(iOS 17.0, *)
struct StateGlyph: View {
	var state: String
	var palette: WidgetPalette
	var size: CGFloat = 12

	var body: some View {
		ZStack {
			switch state {
			case "approve", "question":
				Circle().fill(palette.red).frame(width: size * 0.7, height: size * 0.7)
			case "error":
				Circle().fill(palette.red).frame(width: size * 0.8, height: size * 0.8)
				Text("!").font(.system(size: size * 0.6, weight: .heavy)).foregroundStyle(palette.monochrome ? Color.black.opacity(0.6) : palette.background)
			case "running":
				Circle().stroke(palette.line, lineWidth: size * 0.15).frame(width: size * 0.66, height: size * 0.66)
				Circle().trim(from: 0, to: 0.75)
					.stroke(palette.yellow, style: StrokeStyle(lineWidth: size * 0.15, lineCap: .round))
					.frame(width: size * 0.66, height: size * 0.66)
					.rotationEffect(.degrees(-90))
			case "unread":
				Circle().fill(palette.green).frame(width: size * 0.76, height: size * 0.76)
				Image(systemName: "checkmark")
					.font(.system(size: size * 0.4, weight: .heavy))
					.foregroundStyle(palette.monochrome ? Color.black.opacity(0.6) : palette.background)
			default:
				Circle().stroke(palette.muted, lineWidth: size * 0.12).frame(width: size * 0.6, height: size * 0.6)
			}
		}
		.frame(width: size, height: size)
		.widgetAccentable()
		.accessibilityLabel(WidgetText.stateLabel(state))
	}
}

/// 見出し（ロゴ・見出し・右側の補足）。
@available(iOS 17.0, *)
struct WidgetHeader<Trailing: View>: View {
	var title: String
	var palette: WidgetPalette
	var privateTitle = false
	@ViewBuilder var trailing: () -> Trailing

	var body: some View {
		HStack(spacing: 5) {
			ParaLogo(size: 13, color: palette.text).widgetAccentable()
			Group {
				if privateTitle {
					Text(title).privacySensitive()
				} else {
					Text(title)
				}
			}
			.font(.system(size: 12, weight: .medium))
			.foregroundStyle(palette.dim)
			.lineLimit(1)
			Spacer(minLength: 4)
			trailing()
		}
		.frame(height: 16)
	}
}

@available(iOS 17.0, *)
extension WidgetHeader where Trailing == EmptyView {
	init(title: String, palette: WidgetPalette, privateTitle: Bool = false) {
		self.init(title: title, palette: palette, privateTitle: privateTitle) { EmptyView() }
	}
}

/// 右上の PC 名と接続の印（オンライン=緑の点、オフライン=白抜き+「オフライン」）。
@available(iOS 17.0, *)
struct PcBadge: View {
	var pc: WidgetPc
	var palette: WidgetPalette
	var body: some View {
		HStack(spacing: 4) {
			if pc.online {
				Circle().fill(palette.ok).frame(width: 6.4, height: 6.4).widgetAccentable()
				Text(pc.name).privacySensitive()
			} else {
				Circle().stroke(palette.muted, lineWidth: 1.3).frame(width: 6, height: 6)
				Text("オフライン")
			}
		}
		.font(.system(size: 11))
		.foregroundStyle(palette.muted)
		.lineLimit(1)
	}
}

/// 小さな丸いボタン（モックの .wb）。Link（アプリを開く）と、App Intent の Button で使う。
@available(iOS 17.0, *)
struct PillLabel: View {
	var title: String
	var systemImage: String
	var palette: WidgetPalette
	var primary = false
	var imageTrailing = false

	var body: some View {
		HStack(spacing: 3) {
			if !imageTrailing {
				Image(systemName: systemImage).font(.system(size: 9, weight: .bold))
			}
			Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1)
			if imageTrailing {
				Image(systemName: systemImage).font(.system(size: 9, weight: .bold))
			}
		}
		.padding(.horizontal, 10)
		.frame(height: 26)
		.foregroundStyle(primary ? palette.priTx : palette.text)
		.background(Capsule().fill(primary ? palette.priBg : palette.raised))
		.widgetAccentable(primary)
		.fixedSize()
	}
}

/// 横棒（CPU・メモリ・上限）。warn / critical で色を変え、モノクロでは濃さで表す。
@available(iOS 17.0, *)
struct MeterBar: View {
	var percent: Double
	var warn: Double
	var critical: Double
	var palette: WidgetPalette
	var height: CGFloat = 5

	var body: some View {
		GeometryReader { proxy in
			ZStack(alignment: .leading) {
				Capsule().fill(palette.raised)
				Capsule()
					.fill(fill)
					.frame(width: max(height, proxy.size.width * CGFloat(min(100, max(0, percent)) / 100)))
					.widgetAccentable()
			}
		}
		.frame(height: height)
	}

	private var fill: Color {
		if percent >= critical { return palette.red }
		if percent >= warn { return palette.yellow }
		return palette.text
	}
}

/// 電池の形（枠・残量・端子）。
@available(iOS 17.0, *)
struct BatteryGlyphView: View {
	var level: Int
	var palette: WidgetPalette
	var width: CGFloat = 20

	var body: some View {
		HStack(spacing: 1) {
			ZStack(alignment: .leading) {
				RoundedRectangle(cornerRadius: 2.6).stroke(palette.dim, lineWidth: 1.2).frame(width: width, height: 10)
				RoundedRectangle(cornerRadius: 1.2)
					.fill(level <= 10 ? palette.red : level <= 20 ? palette.yellow : palette.text)
					.frame(width: max(1.5, (width - 4) * CGFloat(level) / 100), height: 6)
					.padding(.leading, 2)
			}
			RoundedRectangle(cornerRadius: 0.8).fill(palette.dim).frame(width: 1.8, height: 3.8)
		}
		.widgetAccentable()
		.accessibilityLabel("バッテリー \(level)%")
	}
}

/// 下端の「◯分前の状態」。設定で「古いときだけ」を選んだときは 5 分未満なら出さない（オフラインなら必ず出す）。
func freshnessText(pc: WidgetPc?, settings: WidgetAppSettings, now: Date) -> String? {
	guard let pc else { return nil }
	let label = WidgetText.freshness(pc.freshAt, now: now)
	if !pc.online {
		return "\(label) ・ PC オフライン"
	}
	if settings.freshness == "stale", let at = pc.freshAt, now.timeIntervalSince1970 * 1000 - at < 5 * 60_000 {
		return nil
	}
	return label
}
