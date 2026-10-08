/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import AppKit
import ApplicationServices
import Foundation

/** SkyLight の任意シンボル。欠けていれば背面経路を選ばず、グローバル HID へは送らない。 */
final class ParadisBackgroundTransport {
	typealias Post = @convention(c) (Int32, CGEvent) -> Void
	typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
	typealias SetField = @convention(c) (CGEvent, UInt32, Int64) -> Void
	private let handle: UnsafeMutableRawPointer?
	private let postEvent: Post?
	private let setLocation: SetLocation?
	private let setField: SetField?

	init() {
		let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL)
		handle = library
		func symbol<T>(_ name: String, _ type: T.Type) -> T? {
			guard let library, let address = dlsym(library, name) ?? dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
			return unsafeBitCast(address, to: type)
		}
		postEvent = symbol("SLEventPostToPid", Post.self)
		setLocation = symbol("CGEventSetWindowLocation", SetLocation.self)
		setField = symbol("SLEventSetIntegerValueField", SetField.self)
	}

	deinit { if let handle { dlclose(handle) } }

	var available: Bool { postEvent != nil && setLocation != nil && setField != nil }

	func send(_ event: CGEvent, pid: Int32, windowId: UInt32, point: CGPoint?, group: Int64) {
		event.setIntegerValueField(.eventSourceUserData, value: paradisSyntheticEventMarker)
		setField?(event, 40, Int64(pid))
		for field: UInt32 in [51, 91, 92] { setField?(event, field, Int64(windowId)) }
		if let point {
			setLocation?(event, point)
			setField?(event, 58, group)
			setField?(event, 7, 3)
		}
		postEvent?(pid, event)
	}
}

/** キー／ボタンの解放を通常終了と SIGTERM の両方で共有する。 */
final class ParadisBackgroundCleanup {
	static let shared = ParadisBackgroundCleanup()
	private let lock = NSLock()
	private var action: (() -> Void)?
	func install(_ action: @escaping () -> Void) {
		lock.lock()
		self.action = action
		lock.unlock()
	}
	func run() {
		lock.lock()
		let pending = action
		action = nil
		lock.unlock()
		pending?()
	}
}

func paradisBackgroundWindowId(_ element: AXUIElement) -> UInt32? {
	guard let lookup = paradisAXWindowIdFunction() else { return nil }
	var id: UInt32 = 0
	return lookup(element, &id) == .success && id != 0 ? id : nil
}

/** 背面入力が追加した修飾キーだけを記録し、利用者が状態を変えた場合は触れない。 */
final class ParadisBackgroundModifiers {
	private let monitor: ParadisInputMonitor
	private let lock = NSLock()
	private var held: (press: ParadisModifierPress, at: Date)?

	init(monitor: ParadisInputMonitor) { self.monitor = monitor }

	func record(_ event: CGEvent) {
		guard event.type == .keyDown || event.type == .leftMouseDown else { return }
		lock.lock()
		defer { lock.unlock() }
		guard held == nil else { return }
		let press = paradisModifierPress(chord: event.flags, systemBefore: CGEventSource.flagsState(.hidSystemState))
		if !press.added.isEmpty { held = (press, Date()) }
	}

	func ownFlags(system: CGEventFlags) -> CGEventFlags {
		lock.lock()
		let current = held
		lock.unlock()
		guard let current else { return [] }
		return paradisOwnLeftoverModifiers(lastReleased: current.press.added, systemBefore: system, physicalModifierChangeSinceRelease: monitor.physicalModifierChange(since: current.at))
	}

	func release() throws {
		lock.lock()
		defer { lock.unlock() }
		guard let current = held else { return }
		guard monitor.physicalModifierChange(since: current.at) == false else { held = nil; return }
		try paradisPostModifierRelease(current.press)
		held = nil
	}
}
