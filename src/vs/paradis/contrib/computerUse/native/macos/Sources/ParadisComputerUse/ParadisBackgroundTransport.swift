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
	typealias GetPSN = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
	typealias PostRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
	private let handle: UnsafeMutableRawPointer?
	private let postEvent: Post?
	private let setLocation: SetLocation?
	private let setField: SetField?
	private let getPSN: GetPSN?
	private let postRecord: PostRecord?

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
		getPSN = symbol("GetProcessForPID", GetPSN.self)
		postRecord = symbol("SLPSPostEventRecordTo", PostRecord.self)
	}

	deinit { if let handle { dlclose(handle) } }

	var available: Bool { postEvent != nil && setLocation != nil && setField != nil && getPSN != nil && postRecord != nil }

	func processSerialNumber(_ pid: Int32) -> [UInt32]? {
		guard let getPSN else { return nil }
		var psn: [UInt32] = [0, 0]
		return psn.withUnsafeMutableBytes { getPSN(pid, $0.baseAddress!) } == 0 ? psn : nil
	}

	/** Cua / yabai の no-raise レコード形式。出典・ライセンスは THIRD_PARTY_NOTICES.md。 */
	func focus(_ psn: [UInt32], windowId: UInt32, focused: Bool) -> Bool {
		guard let postRecord else { return false }
		var record = [UInt8](repeating: 0, count: 0xf8)
		record[4] = 0xf8
		record[8] = 0x0d
		for index in 0..<4 { record[0x3c + index] = UInt8(truncatingIfNeeded: windowId >> (index * 8)) }
		record[0x8a] = focused ? 1 : 2
		return psn.withUnsafeBytes { process in
			record.withUnsafeBytes { bytes in postRecord(process.baseAddress!, bytes.baseAddress!) == 0 }
		}
	}

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

/** キー解放・フォーカス復元を通常終了と SIGTERM の両方で共有する。 */
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

/** 同じサーバースレッドからだけ読む。要求のキャンセルで接続が切れたら次のイベントを送らない。 */
enum ParadisBackgroundConnection {
	static var socket: Int32?
	static var disconnected: Bool {
		guard let socket else { return false }
		var byte: UInt8 = 0
		let count = recv(socket, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
		return count == 0 || (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
	}
}
