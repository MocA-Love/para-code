/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import Foundation
import CoreGraphics

/** この要求が追加した修飾キーを直後に解放し、前回の残りの回収だけは物理操作を確認する。 */
final class ParadisBackgroundModifiers {
	private let physicalChange: (Date) -> Bool?
	private let currentFlags: () -> CGEventFlags
	private let postRelease: (ParadisModifierPress) throws -> Void
	private let lock = NSLock()
	private var held: (press: ParadisModifierPress, at: Date)?

	init(physicalChange: @escaping (Date) -> Bool?, currentFlags: @escaping () -> CGEventFlags, postRelease: @escaping (ParadisModifierPress) throws -> Void) {
		self.physicalChange = physicalChange
		self.currentFlags = currentFlags
		self.postRelease = postRelease
	}

	func record(_ event: CGEvent) {
		guard event.type == .keyDown || event.type == .leftMouseDown else { return }
		lock.lock()
		defer { lock.unlock() }
		guard held == nil else { return }
		let press = paradisModifierPress(chord: event.flags, systemBefore: currentFlags())
		if !press.added.isEmpty { held = (press, Date()) }
	}

	func ownFlags(system: CGEventFlags) -> CGEventFlags {
		lock.lock()
		let current = held
		lock.unlock()
		guard let current else { return [] }
		// この要求で今送っている修飾キーは、監視不可でも自分のものと分かる。
		return current.press.added.intersection(system)
	}

	/** 送信した直後の解放は、監視権限の有無にかかわらず行う（前面経路と同じ）。 */
	func releaseCurrent() throws {
		lock.lock()
		defer { lock.unlock() }
		guard let current = held else { return }
		try postRelease(current.press)
		held = nil
	}

	/** 前回の解放失敗を回収する場合だけ、物理的な変更が無いことを求める。 */
	func recoverLeftover() throws {
		lock.lock()
		defer { lock.unlock() }
		guard let current = held else { return }
		guard physicalChange(current.at) == false else { held = nil; return }
		try postRelease(current.press)
		held = nil
	}
}
