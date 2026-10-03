// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
//
//  NotificationViewController.swift
//  ParaCodeNotifyContent
//
//  通知の長押しの画面（Notification Content Extension）。案 B2: エージェントの最後の発言（承認ならコマンド、
//  質問なら質問文）を Markdown のまま描き、下に「開く」を置く。許可・拒否・返信は iOS のボタン（カテゴリの
//  アクション。アプリの app/mobile/src/notificationActions.ts が登録）が受け持ち、押すとアプリが前面で開いて
//  Face ID の後に送る。ここからは何も送らない。
//
//  中身の出どころ:
//  - プッシュ: 通知拡張（NotifyExtension）が復号して userInfo の最上位に書いた `detail`・`category`
//    （復号できなかったプッシュではこれらを剥がしてあるので、生ペイロードの値は読まない）
//  - アプリが出したローカル通知: expo が userInfo["body"] に入れた data の `detail`・`category`
//  `detail` が無い（古い PC・「通知に内容を含める」がオフ・プッシュに入りきらなかった）ときは本文を出す。

import UIKit
import UserNotifications
import UserNotificationsUI

final class NotificationViewController: UIViewController, UNNotificationContentExtension {

	private let titleLabel = UILabel()
	private let subtitleLabel = UILabel()
	private let kindLabel = UILabel()
	private let textView = UITextView()
	private let openButton = UIButton(type: .system)

	/// 画面の高さの上限（これを超える分は中でスクロールする）。
	private static let maxHeight: CGFloat = 520

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground

		kindLabel.font = UIFont.preferredFont(forTextStyle: .caption1).bold()
		titleLabel.font = .preferredFont(forTextStyle: .headline)
		titleLabel.numberOfLines = 1
		subtitleLabel.font = .preferredFont(forTextStyle: .subheadline)
		subtitleLabel.textColor = .secondaryLabel
		subtitleLabel.numberOfLines = 1

		textView.isEditable = false
		textView.isSelectable = true
		textView.backgroundColor = .clear
		textView.textContainerInset = .zero
		textView.textContainer.lineFragmentPadding = 0
		textView.dataDetectorTypes = []

		openButton.setTitle("開く", for: .normal)
		openButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .body).bold()
		openButton.addTarget(self, action: #selector(openApp), for: .touchUpInside)

		let header = UIStackView(arrangedSubviews: [kindLabel, titleLabel, subtitleLabel])
		header.axis = .vertical
		header.spacing = 2
		let stack = UIStackView(arrangedSubviews: [header, textView, openButton])
		stack.axis = .vertical
		stack.spacing = 10
		stack.alignment = .fill
		stack.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(stack)
		NSLayoutConstraint.activate([
			stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
			stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
			stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
			stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -10),
		])
	}

	func didReceive(_ notification: UNNotification) {
		let content = notification.request.content
		let data = Self.appData(notification.request)
		titleLabel.text = content.title
		subtitleLabel.text = content.subtitle
		subtitleLabel.isHidden = content.subtitle.isEmpty
		let kind = Self.kind(data["category"] as? String)
		kindLabel.text = kind?.word
		kindLabel.textColor = kind?.color ?? .secondaryLabel
		kindLabel.isHidden = kind == nil

		if let detail = data["detail"] as? String, !detail.isEmpty {
			textView.attributedText = MarkdownRenderer.render(detail)
		} else {
			textView.attributedText = NSAttributedString(string: content.body, attributes: [
				.font: UIFont.preferredFont(forTextStyle: .body),
				.foregroundColor: UIColor.label,
			])
		}
		updatePreferredSize()
	}

	override func viewDidLayoutSubviews() {
		super.viewDidLayoutSubviews()
		updatePreferredSize()
	}

	/// 本文の高さに合わせて画面の高さを決める（上限を超えたら中でスクロールする）。
	private func updatePreferredSize() {
		let width = max(view.bounds.width - 32, 100)
		let textHeight = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
		let chrome: CGFloat = 14 + 10 + 10 + 10 + 44 + (subtitleLabel.isHidden ? 22 : 42) + (kindLabel.isHidden ? 0 : 16)
		let height = min(textHeight + chrome, Self.maxHeight)
		textView.isScrollEnabled = textHeight + chrome > Self.maxHeight
		if abs(preferredContentSize.height - height) > 1 {
			preferredContentSize = CGSize(width: view.bounds.width, height: height)
		}
	}

	@objc private func openApp() {
		// 通知の本体をタップしたのと同じ扱い（アプリが前面で開き、その会話へ移る）。
		extensionContext?.performNotificationDefaultAction()
	}

	/// アプリ向けの項目。プッシュは通知拡張が書いた最上位、ローカル通知は expo が userInfo["body"] に入れた data。
	/// プッシュの userInfo["body"] は APNs の生ペイロード（リレーが書ける）なので読まない。
	private static func appData(_ request: UNNotificationRequest) -> [AnyHashable: Any] {
		let info = request.content.userInfo
		if request.trigger is UNPushNotificationTrigger {
			return info
		}
		return (info["body"] as? [AnyHashable: Any]) ?? [:]
	}

	/// 種類の言葉と色（PC の paradisNotifyCompose.ts の種類の言葉と同じ）。
	private static func kind(_ category: String?) -> (word: String, color: UIColor)? {
		switch category {
		case "done": return ("完了", .systemGreen)
		case "approval": return ("承認待ち", .systemOrange)
		case "question": return ("質問", .systemBlue)
		case "error": return ("エラー", .systemRed)
		default: return nil
		}
	}
}

/// Markdown を描く（見出し・箇条書き・引用・コードブロック・表・強調・インラインコード・リンク）。
/// 通知の長押しで読むだけなので、行ごとに見て装飾する簡単なもの。行の中の装飾は AttributedString(markdown:) に任せる。
enum MarkdownRenderer {

	static func render(_ markdown: String) -> NSAttributedString {
		let body = UIFont.preferredFont(forTextStyle: .body)
		let mono = UIFont.monospacedSystemFont(ofSize: body.pointSize * 0.88, weight: .regular)
		let out = NSMutableAttributedString()
		var inFence = false
		let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
		for (index, rawLine) in lines.enumerated() {
			let newline = index < lines.count - 1 ? "\n" : ""
			let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
			if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
				inFence.toggle()
				continue
			}
			if inFence {
				out.append(NSAttributedString(string: rawLine + newline, attributes: [
					.font: mono,
					.foregroundColor: UIColor.label,
					.backgroundColor: UIColor.secondarySystemBackground,
				]))
				continue
			}
			if trimmed.range(of: #"^(?:[-*_]\s*){3,}$"#, options: .regularExpression) != nil {
				out.append(NSAttributedString(string: "――――――――" + newline, attributes: [.font: body, .foregroundColor: UIColor.tertiaryLabel]))
				continue
			}
			if trimmed.hasPrefix("|") {
				// 表は等幅のまま出す（区切りの行は捨てる）。
				if trimmed.range(of: #"^\|?[\s:|-]+\|?$"#, options: .regularExpression) != nil {
					continue
				}
				out.append(NSAttributedString(string: trimmed + newline, attributes: [.font: mono, .foregroundColor: UIColor.label]))
				continue
			}
			if let heading = trimmed.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
				let level = trimmed[heading].filter { $0 == "#" }.count
				let size = body.pointSize + CGFloat(max(0, 4 - level)) * 2
				out.append(inline(String(trimmed[heading.upperBound...]) + newline, font: UIFont.systemFont(ofSize: size, weight: .bold), mono: mono, color: .label))
				continue
			}
			if let quote = trimmed.range(of: #"^(?:>\s?)+"#, options: .regularExpression) {
				out.append(inline(String(trimmed[quote.upperBound...]) + newline, font: body, mono: mono, color: .secondaryLabel))
				continue
			}
			if let bullet = rawLine.range(of: #"^\s*[-*+]\s+"#, options: .regularExpression) {
				let depth = rawLine.prefix(while: { $0 == " " || $0 == "\t" }).count / 2
				let indent = String(repeating: "  ", count: depth)
				out.append(inline(indent + "• " + String(rawLine[bullet.upperBound...]) + newline, font: body, mono: mono, color: .label))
				continue
			}
			out.append(inline(rawLine + newline, font: body, mono: mono, color: .label))
		}
		return out
	}

	/// 行の中の装飾（強調・斜体・インラインコード・リンク・打ち消し）。読めなければそのまま出す。
	private static func inline(_ text: String, font: UIFont, mono: UIFont, color: UIColor) -> NSAttributedString {
		let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
		guard let parsed = try? AttributedString(markdown: text, options: options) else {
			return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
		}
		let out = NSMutableAttributedString()
		for run in parsed.runs {
			let piece = String(parsed[run.range].characters)
			var runFont = font
			var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
			if let intent = run.inlinePresentationIntent {
				if intent.contains(.code) {
					runFont = mono
					attributes[.backgroundColor] = UIColor.secondarySystemBackground
				}
				var traits: UIFontDescriptor.SymbolicTraits = []
				if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
				if intent.contains(.emphasized) { traits.insert(.traitItalic) }
				if !traits.isEmpty, let descriptor = runFont.fontDescriptor.withSymbolicTraits(runFont.fontDescriptor.symbolicTraits.union(traits)) {
					runFont = UIFont(descriptor: descriptor, size: runFont.pointSize)
				}
				if intent.contains(.strikethrough) {
					attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
				}
			}
			if run.link != nil {
				attributes[.foregroundColor] = UIColor.link
			}
			attributes[.font] = runFont
			out.append(NSAttributedString(string: piece, attributes: attributes))
		}
		return out
	}
}

private extension UIFont {
	func bold() -> UIFont {
		guard let descriptor = fontDescriptor.withSymbolicTraits(.traitBold) else {
			return self
		}
		return UIFont(descriptor: descriptor, size: pointSize)
	}
}
