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
	typealias PostRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
	typealias MainConnection = @convention(c) () -> UInt32
	typealias WindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
	typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
	typealias ProcessForPID = @convention(c) (Int32, UnsafeMutableRawPointer) -> Int32
	private let handle: UnsafeMutableRawPointer?
	private let postEvent: Post?
	private let setLocation: SetLocation?
	private let setField: SetField?
	// キーウィンドウを替える記録（E1。ParadisKeyWindow.swift）
	private let postRecord: PostRecord?
	private let mainConnection: MainConnection?
	private let windowOwner: WindowOwner?
	private let connectionPSN: ConnectionPSN?
	private let processForPID: ProcessForPID?

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
		postRecord = symbol("SLPSPostEventRecordTo", PostRecord.self)
		mainConnection = symbol("CGSMainConnectionID", MainConnection.self)
		windowOwner = symbol("SLSGetWindowOwner", WindowOwner.self)
		connectionPSN = symbol("SLSGetConnectionPSN", ConnectionPSN.self)
		processForPID = symbol("GetProcessForPID", ProcessForPID.self)
	}

	deinit { if let handle { dlclose(handle) } }

	var available: Bool { postEvent != nil && setLocation != nil && setField != nil }

	/** キーウィンドウを替える記録を送れるか。 */
	var keyRecordsAvailable: Bool { postRecord != nil && (processForPID != nil || (mainConnection != nil && windowOwner != nil && connectionPSN != nil)) }

	/** そのウィンドウを持つプロセスの PSN（8 バイト）。 */
	private func processSerialNumber(windowId: UInt32, pid: Int32) -> [UInt8]? {
		var psn = [UInt8](repeating: 0, count: 8)
		if let mainConnection, let windowOwner, let connectionPSN {
			var owner: UInt32 = 0
			if windowOwner(mainConnection(), windowId, &owner) == 0, owner != 0,
				psn.withUnsafeMutableBytes({ connectionPSN(owner, $0.baseAddress!) }) == 0 {
				return psn
			}
		}
		if let processForPID, psn.withUnsafeMutableBytes({ processForPID(pid, $0.baseAddress!) }) == 0 {
			return psn
		}
		return nil
	}

	/**
	 * 対象のプロセスの中でキーウィンドウを `current` から `target` へ替える記録を送る（前面に出さず、ウィンドウも上げず、
	 * ポインタにも触れない。記録は対象の pid にだけ届く）。全部送れたら true。アプリが従ったかは呼び出し側が読み直す。
	 */
	func postKeyWindowRecords(pid: Int32, current: UInt32?, target: UInt32) -> Bool {
		guard let postRecord, let psn = processSerialNumber(windowId: target, pid: pid) else {
			return false
		}
		func post(_ record: [UInt8]) -> Bool {
			return psn.withUnsafeBytes { psnBytes in record.withUnsafeBytes { postRecord(psnBytes.baseAddress!, $0.baseAddress!) } } == 0
		}
		var ok = true
		if let current {
			ok = post(paradisFocusRecord(windowId: current, focus: false)) && ok
			usleep(paradisKeyRecordSettleMicroseconds)
		}
		ok = post(paradisFocusRecord(windowId: target, focus: true)) && ok
		usleep(paradisKeyRecordSettleMicroseconds)
		for kind: UInt8 in [0x01, 0x02] {
			ok = post(paradisMakeKeyRecord(windowId: target, kind: kind)) && ok
		}
		return ok
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

/** キーウィンドウを替える記録の間に置く時間（間が無いと、外す記録の処理中に当てる記録を落とすアプリがある）。 */
let paradisKeyRecordSettleMicroseconds: UInt32 = 120_000

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
