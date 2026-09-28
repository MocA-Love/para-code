/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アクセシビリティのツリーをエージェントへ渡す文字列にする部分と、スクショの大きさの計算。
// AX API に触らない純粋な処理だけをここに置き、テストで確かめる。
//
// パスワード欄らしい要素の判定語は Orca（stablyai/orca、MIT）の
// native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift の isSecureTextElement にそろえた。

import CoreGraphics
import Foundation

/** 読み取った要素 1 つ。座標はウィンドウ左上を原点とするポイント。 */
struct ParadisAXNode {
	let index: Int
	let depth: Int
	let role: String
	let subrole: String?
	let title: String?
	let value: String?
	let label: String?
	let frame: CGRect?
	let enabled: Bool?
	let focused: Bool?
	/** 選ばれている（表の行・サイドバーの項目など）。フォーカスとは別。 */
	var selected: Bool = false
	let actions: [String]
	/** パスワード欄らしいので値を出さなかった。 */
	let redacted: Bool
}

/** 1 つの属性の値として出す最大文字数。 */
let paradisAXMaxTextLength = 200

/** パスワード欄らしい要素か（値を出さない）。 */
func paradisIsSecureLike(role: String, subrole: String?, title: String?, label: String?, placeholder: String?) -> Bool {
	if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
		return true
	}
	let haystack = [role, subrole ?? "", title ?? "", label ?? "", placeholder ?? ""].joined(separator: " ").lowercased()
	let needles = ["secure", "password", "passcode", "verification code", "one-time code", "パスワード", "暗証番号", "認証コード", "確認コード", "セキュリティコード", "ワンタイム"]
	return needles.contains { haystack.contains($0) }
}

/**
 * 画面に出ている文字列を 1 行に収める。制御文字・双方向制御・改行を空白にし、長ければ切る。
 * 画面の文字はエージェントへの指示として読まれうるので、行の区切りを偽装できないようにする。
 */
func paradisSanitizeText(_ text: String, maxLength: Int = paradisAXMaxTextLength) -> String {
	var scalars = String.UnicodeScalarView()
	var lastWasSpace = false
	for scalar in text.unicodeScalars {
		let isControl = scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .format
			|| scalar.properties.generalCategory == .lineSeparator || scalar.properties.generalCategory == .paragraphSeparator
		if isControl || scalar == " " {
			if !lastWasSpace {
				scalars.append(" ")
				lastWasSpace = true
			}
			continue
		}
		scalars.append(scalar)
		lastWasSpace = false
	}
	let collapsed = String(scalars).trimmingCharacters(in: .whitespaces)
	if collapsed.count <= maxLength {
		return collapsed
	}
	return String(collapsed.prefix(maxLength)) + "\u{2026}"
}

/** ツリーを番号付きの字下げした文字列にする。 */
func paradisRenderAXTree(_ nodes: [ParadisAXNode], truncated: Bool) -> String {
	var lines: [String] = []
	for node in nodes {
		var parts: [String] = ["[\(node.index)]", node.role]
		if let subrole = node.subrole, !subrole.isEmpty {
			parts.append("(\(subrole))")
		}
		if let title = node.title.map({ paradisSanitizeText($0) }), !title.isEmpty {
			parts.append("\"\(title)\"")
		}
		if node.redacted {
			parts.append("value=<redacted>")
		} else if let value = node.value.map({ paradisSanitizeText($0) }), !value.isEmpty {
			parts.append("value=\"\(value)\"")
		}
		if let label = node.label.map({ paradisSanitizeText($0) }), !label.isEmpty {
			parts.append("label=\"\(label)\"")
		}
		if let frame = node.frame {
			parts.append("@\(Int(frame.origin.x.rounded())),\(Int(frame.origin.y.rounded())) \(Int(frame.size.width.rounded()))x\(Int(frame.size.height.rounded()))")
		}
		if node.enabled == false {
			parts.append("disabled")
		}
		if node.focused == true {
			parts.append("focused")
		}
		if node.selected {
			parts.append("selected")
		}
		if !node.actions.isEmpty {
			parts.append("actions=" + node.actions.map { paradisSanitizeText($0, maxLength: 40) }.joined(separator: ","))
		}
		lines.append(String(repeating: "  ", count: max(0, node.depth)) + parts.joined(separator: " "))
	}
	if truncated {
		lines.append("... (tree truncated)")
	}
	return lines.joined(separator: "\n")
}

/** 長辺を上限に収めた大きさ（縦横比を保つ）。どちらの辺も 1 以上。 */
func paradisBoundedSize(width: Int, height: Int, maxLongEdge: Int) -> (width: Int, height: Int) {
	let safeWidth = max(1, width)
	let safeHeight = max(1, height)
	let longEdge = max(safeWidth, safeHeight)
	guard maxLongEdge > 0, longEdge > maxLongEdge else {
		return (safeWidth, safeHeight)
	}
	let ratio = Double(maxLongEdge) / Double(longEdge)
	return (max(1, Int((Double(safeWidth) * ratio).rounded())), max(1, Int((Double(safeHeight) * ratio).rounded())))
}
