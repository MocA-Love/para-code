/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 読み取りの命令の実体（許可の確認・アプリとウィンドウの一覧・単一ウィンドウのスクショ・アクセシビリティのツリー）。
//
// 許可の無い機能は、OS の API を呼ぶ前に確かめて断る。ScreenCaptureKit は許可が無いと OS の確認を
// 出すことがあるので、`CGPreflightScreenCaptureAccess()`（確認を出さない）で先に止める。
// 入力（クリック・キー・文字・貼り付け）は ParadisInput.swift。

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/** 直前に読んだツリーの要素（番号でクリックするため）。番号は次に読むまで有効。 */
struct ParadisElementSnapshot {
	/** ツリーの応答で返す id。番号でのクリックはこの id を添えて来る（レビュー L6）。 */
	let id: Int
	let pid: Int32
	let windowId: UInt32?
	let elements: [AXUIElement]
}

/** ツリーを読む全体の締め切り。 */
private let paradisTreeDeadlineSeconds: TimeInterval = 20

final class ParadisDesktop: ParadisDesktopBackend {

	/** 直前に読んだツリー。要求は 1 本の接続で順に処理するので、鍵は要らない。 */
	var lastSnapshot: ParadisElementSnapshot?
	private var nextSnapshotId = 1
	/** 利用者の物理的な入力の見張り（入力の命令を初めて受けたときに作る）。 */
	let inputMonitor = ParadisInputMonitor()
	/** 2 段目（背面への入力）。今は常に使えない空の実装（ParadisInputRoutes.swift）。 */
	let backgroundRoute: ParadisInputRoute = paradisMakeBackgroundRoute()

	init() {
		// AX の問い合わせ全体に上限を付ける。固まったアプリで補助アプリが長く止まり、切断に気づかず残らないように（レビュー L5）
		AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
	}

	func bundleIdentifier(pid: Int32) -> String? {
		return paradisOnMain {
			guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
				return nil
			}
			return app.bundleIdentifier
		}
	}

	func permissions() -> ParadisPermissionSnapshot {
		return ParadisPermissionSnapshot(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess(), inputMonitoring: CGPreflightListenEventAccess())
	}

	func responsibility() -> (ParadisResponsibility, Int32?) {
		let responsible = paradisResponsiblePid()
		return (paradisClassifyResponsibility(selfPid: getpid(), responsiblePid: responsible), responsible)
	}

	func osVersion() -> String {
		let version = ProcessInfo.processInfo.operatingSystemVersion
		return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
	}

	// MARK: - アプリとウィンドウ

	func listApps() -> [[String: Any]] {
		return paradisOnMain {
			NSWorkspace.shared.runningApplications
				.filter { $0.activationPolicy == .regular && !$0.isTerminated }
				.map { app -> [String: Any] in
					var entry: [String: Any] = [
						"pid": Int(app.processIdentifier),
						"name": paradisSanitizeText(app.localizedName ?? "", maxLength: 120),
						"active": app.isActive,
						"hidden": app.isHidden,
					]
					if let bundleIdentifier = app.bundleIdentifier {
						entry["bundleId"] = bundleIdentifier
					}
					return entry
				}
		}
	}

	func listWindows(pid: Int32) throws -> [[String: Any]] {
		try requireRunningApp(pid)
		// AX で分かれば、標準のウィンドウか（小さな補助のウィンドウやパネルと分けるため）と、しまわれているかも付ける
		let accessibility = AXIsProcessTrusted() ? paradisAXWindowKinds(pid: pid) : [:]
		return paradisWindowInfos(pid: pid).enumerated().map { index, info in
			var entry: [String: Any] = [
				"windowId": Int(info.windowId),
				"index": index,
				"bounds": paradisRectJson(info.bounds),
				"onScreen": info.onScreen,
			]
			if let kind = accessibility[info.windowId] {
				entry["standard"] = kind.subrole == "AXStandardWindow"
				// アプリが前に出しているウィンドウ（ダイアログ・シートなど）。既定の対象はこれを先にする（ベータ 3 のレビュー M3）
				entry["focused"] = kind.focused
				if let subrole = kind.subrole {
					entry["subrole"] = subrole
				}
				entry["minimized"] = kind.minimized
			}
			// 画面収録の許可が無いとタイトルは OS から返らない
			if let title = info.title, !title.isEmpty {
				entry["title"] = paradisSanitizeText(title, maxLength: 200)
			}
			return entry
		}
	}

	func requireRunningApp(_ pid: Int32) throws {
		let running = paradisOnMain { NSRunningApplication(processIdentifier: pid).map { !$0.isTerminated } ?? false }
		guard running else {
			throw ParadisHelperError(code: "app_not_found", message: "no running application has pid \(pid)")
		}
	}

	// MARK: - スクショ

	func screenshotWindow(pid: Int32, windowId: UInt32, maxLongEdge: Int) throws -> [String: Any] {
		guard CGPreflightScreenCaptureAccess() else {
			throw ParadisHelperError(code: "screen_recording_not_granted", message: "Screen Recording permission is not granted to Para Code Computer Use")
		}
		try requireRunningApp(pid)
		guard let info = paradisWindowInfos(pid: pid).first(where: { $0.windowId == windowId }) else {
			throw ParadisHelperError(code: "window_not_found", message: "the application has no window \(windowId)")
		}
		let image = try paradisCaptureWindow(windowId: windowId, pid: pid, bounds: info.bounds, maxLongEdge: maxLongEdge)
		guard let png = paradisPngData(image) else {
			throw ParadisHelperError(code: "screenshot_failed", message: "the screenshot could not be encoded")
		}
		return [
			"mimeType": "image/png",
			"data": png.base64EncodedString(),
			"width": image.width,
			"height": image.height,
			// 画像のピクセル / ウィンドウのポイント。座標へ直すときは x / scale
			"scale": Double(image.width) / max(Double(info.bounds.width), 1),
			"window": paradisRectJson(info.bounds),
		]
	}

	// MARK: - アクセシビリティのツリー

	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int, enableManualAccessibility: Bool) throws -> [String: Any] {
		guard AXIsProcessTrusted() else {
			throw ParadisHelperError(code: "accessibility_not_granted", message: "Accessibility permission is not granted to Para Code Computer Use")
		}
		try requireRunningApp(pid)
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 2.0)
		var windows = paradisElements(application, kAXWindowsAttribute)
		var window = windows.isEmpty ? nil : try paradisPickWindow(windows, application: application, windowId: windowId, pid: pid)
		// Electron 製のアプリは、支援技術が来たと知らせるまで AX のツリーを作らない。ウィンドウが無いか中身が空なら、
		// 公開されている `AXManualAccessibility` を立てて読み直す（Electron が案内している方法。VoiceOver の
		// `AXEnhancedUserInterface` はウィンドウの動きを変えるので使わない）。利用者のアプリの状態を変えるので、
		// 操作の許可があるときだけ立て（`enableManualAccessibility`）、VS Code 系には立てず、10 分使わなければ・
		// 補助アプリが終わるときに false へ戻す（`ParadisManualAccessibilityLedger`）
		var enabledManualAccessibility = false
		paradisManualAccessibility.touch(pid)
		if enableManualAccessibility && (window.map { paradisElements($0, kAXChildrenAttribute).isEmpty } ?? true) && paradisIsElectronApp(pid: pid)
			&& !paradisManualAccessibilityExcluded(bundleId: bundleIdentifier(pid: pid), hasVSCodeProductJson: paradisHasVSCodeProductJson(pid: pid)) && paradisManualAccessibility.enable(pid: pid) {
			enabledManualAccessibility = true
			usleep(400_000)
			windows = paradisElements(application, kAXWindowsAttribute)
			window = windows.isEmpty ? nil : try paradisPickWindow(windows, application: application, windowId: windowId, pid: pid)
		}
		guard let window else {
			throw ParadisHelperError(code: "window_not_found", message: "the application has no accessible window")
		}
		let windowFrame = paradisFrame(window) ?? .zero
		var nodes: [ParadisAXNode] = []
		var elements: [AXUIElement] = []
		var truncated = false
		// 深さ優先で番号を振る（画面の上から下の順に近くなる）
		// 「フォーカスあり」は、アプリが今フォーカスを持つと答えた要素だけに付ける。要素ごとの AXFocused は、
		// 表の中の全部のセルが true を返すアプリがある（Finder のサイドバー）
		let focusedElement = paradisElement(application, kAXFocusedUIElementAttribute)
		var stack: [(AXUIElement, Int)] = [(window, 0)]
		// ツリー全体の締め切り。過ぎたら読めた分だけ返す
		let deadline = Date().addingTimeInterval(paradisTreeDeadlineSeconds)
		while let (element, depth) = stack.popLast() {
			if nodes.count >= maxNodes || Date() > deadline {
				truncated = true
				break
			}
			nodes.append(paradisDescribe(element, index: nodes.count, depth: depth, origin: windowFrame.origin, focusedElement: focusedElement))
			elements.append(element)
			if depth + 1 > maxDepth {
				if !paradisElements(element, kAXChildrenAttribute).isEmpty {
					truncated = true
				}
				continue
			}
			for child in paradisElements(element, kAXChildrenAttribute).reversed() {
				stack.append((child, depth + 1))
			}
		}
		let snapshotId = nextSnapshotId
		nextSnapshotId += 1
		lastSnapshot = ParadisElementSnapshot(id: snapshotId, pid: pid, windowId: windowId, elements: elements)
		var result: [String: Any] = [
			"snapshotId": snapshotId,
			"text": paradisRenderAXTree(nodes, truncated: truncated),
			"nodeCount": nodes.count,
			"truncated": truncated,
			"window": paradisRectJson(windowFrame),
		]
		if enabledManualAccessibility {
			result["manualAccessibility"] = true
		}
		return result
	}

	func paradisPickWindow(_ windows: [AXUIElement], application: AXUIElement, windowId: UInt32?, pid: Int32) throws -> AXUIElement {
		guard let windowId else {
			if let focused = paradisElement(application, kAXFocusedWindowAttribute) {
				return focused
			}
			return windows[0]
		}
		if let lookup = paradisAXWindowIdFunction() {
			for window in windows {
				var candidate: CGWindowID = 0
				if lookup(window, &candidate) == .success && candidate == windowId {
					return window
				}
			}
		}
		// 非公開の対応表が引けないときは、位置と大きさで同じウィンドウを探す
		if let info = paradisWindowInfos(pid: pid).first(where: { $0.windowId == windowId }) {
			for window in windows {
				if let frame = paradisFrame(window), abs(frame.origin.x - info.bounds.origin.x) < 2, abs(frame.origin.y - info.bounds.origin.y) < 2,
					abs(frame.size.width - info.bounds.size.width) < 2, abs(frame.size.height - info.bounds.size.height) < 2 {
					return window
				}
			}
		}
		throw ParadisHelperError(code: "window_not_found", message: "the window \(windowId) is not accessible")
	}

	private func paradisDescribe(_ element: AXUIElement, index: Int, depth: Int, origin: CGPoint, focusedElement: AXUIElement?) -> ParadisAXNode {
		// 属性はまとめて 1 回で読む（要素ごとに問い合わせを重ねると、大きなツリーで締め切りに近づく。ベータ 3 のレビュー L7）
		let values = paradisCopyMultiple(element, [
			kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute,
			kAXValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXSelectedAttribute,
		])
		let role = values[kAXRoleAttribute] as? String ?? "AXUnknown"
		let subrole = values[kAXSubroleAttribute] as? String
		let title = values[kAXTitleAttribute] as? String
		let label = values[kAXDescriptionAttribute] as? String
		let placeholder = values[kAXPlaceholderValueAttribute] as? String
		let secure = paradisIsSecureLike(role: role, subrole: subrole, title: title, label: label, placeholder: placeholder)
		let rawValue = values[kAXValueAttribute]
		var frame = paradisFrame(position: values[kAXPositionAttribute], size: values[kAXSizeAttribute])
		if let absolute = frame {
			frame = CGRect(x: absolute.origin.x - origin.x, y: absolute.origin.y - origin.y, width: absolute.size.width, height: absolute.size.height)
		}
		var actions: CFArray?
		let actionNames = AXUIElementCopyActionNames(element, &actions) == .success ? (actions as? [String] ?? []) : []
		return ParadisAXNode(
			index: index,
			depth: depth,
			role: role,
			subrole: subrole,
			title: title,
			value: secure ? nil : paradisValueText(rawValue),
			label: label,
			frame: frame,
			enabled: (values[kAXEnabledAttribute] as? NSNumber)?.boolValue,
			focused: focusedElement.map { CFEqual($0, element) } ?? false,
			selected: (values[kAXSelectedAttribute] as? NSNumber)?.boolValue == true,
			actions: actionNames,
			redacted: secure && rawValue != nil
		)
	}
}

/**
 * 補助アプリが `AXManualAccessibility` を立てたアプリ（pid とプロセスが始まった時刻の組）と、最後に使った時刻。
 * 10 分使わなければ・補助アプリが終わるときに false へ戻す（Chromium は立っている間 AX のツリーを作り続けるので、
 * 打鍵が遅くなりうる）。
 *
 *  - pid は使い回されるので、立てる・使う・戻す前に、同じプロセス（始まった時刻が同じ）かを確かめる
 *  - 戻す前に VoiceOver・スイッチコントロールが動いていれば、こちらの false がそれらの支援も止めうるので、戻さずに外すだけ
 *  - クラッシュ・SIGKILL では `atexit` が走らないので、記録を実行時フォルダのファイル（`--state-dir`）にも書き、
 *    次に起動したときに、同じプロセスがまだ動いていれば戻す
 */
final class ParadisManualAccessibilityLedger {
	private let lock = NSLock()
	private var entries: [Int32: (started: Double, lastUsed: Date)] = [:]
	private var timer: DispatchSourceTimer?
	private var stateFile: URL?

	/**
	 * 記録のファイルを決め、前の起動が戻せずに残した分を戻す（補助アプリの起動時に 1 回）。
	 */
	func configure(stateDirectory: String?) {
		guard let stateDirectory else {
			return
		}
		try? FileManager.default.createDirectory(atPath: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		let file = URL(fileURLWithPath: stateDirectory).appendingPathComponent("manual-accessibility.json")
		let leftovers = paradisDecodeManualAccessibilityEntries(try? Data(contentsOf: file))
		lock.lock()
		stateFile = file
		lock.unlock()
		for entry in leftovers {
			restore(pid: entry.pid, started: entry.started)
		}
		persist()
	}

	/** 立てる。立てられたら true（すでに立てていれば false。読み直す必要が無い）。 */
	func enable(pid: Int32) -> Bool {
		guard let started = paradisProcessStart(pid) else {
			return false
		}
		lock.lock()
		let already = entries[pid].map { paradisSameProcess(recordedStart: $0.started, currentStart: started) } ?? false
		if !already {
			// 前に同じ pid で記録した別のプロセスは、もう居ない
			entries.removeValue(forKey: pid)
		}
		lock.unlock()
		guard !already, AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success else {
			return false
		}
		lock.lock()
		entries[pid] = (started, Date())
		if timer == nil {
			let source = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
			source.schedule(deadline: .now() + 60, repeating: 60)
			source.setEventHandler { [weak self] in
				self?.restoreExpired(now: Date())
			}
			source.resume()
			timer = source
		}
		lock.unlock()
		persist()
		return true
	}

	/** そのアプリを使った（読み取り・操作）。立てていない・別のプロセスに替わっていれば、時刻を進めない。 */
	func touch(_ pid: Int32) {
		lock.lock()
		let recorded = entries[pid]
		lock.unlock()
		guard let recorded else {
			return
		}
		let same = paradisSameProcess(recordedStart: recorded.started, currentStart: paradisProcessStart(pid))
		lock.lock()
		if same {
			entries[pid] = (recorded.started, Date())
		} else {
			entries.removeValue(forKey: pid)
		}
		lock.unlock()
		if !same {
			persist()
		}
	}

	func restoreExpired(now: Date) {
		lock.lock()
		let expired = entries.filter { paradisManualAccessibilityExpired(lastUsed: $0.value.lastUsed, now: now) }
		expired.keys.forEach { entries.removeValue(forKey: $0) }
		lock.unlock()
		guard !expired.isEmpty else {
			return
		}
		for (pid, entry) in expired {
			restore(pid: pid, started: entry.started)
		}
		persist()
	}

	/** 全部戻す（補助アプリが終わるとき）。 */
	func restoreAll() {
		lock.lock()
		let all = entries
		entries.removeAll()
		lock.unlock()
		for (pid, entry) in all {
			restore(pid: pid, started: entry.started)
		}
		persist()
	}

	/** 同じプロセスで、支援技術が動いていなければ false へ戻す。 */
	private func restore(pid: Int32, started: Double) {
		let assistive = paradisOnMain { NSWorkspace.shared.isVoiceOverEnabled || NSWorkspace.shared.isSwitchControlEnabled }
		guard paradisManualAccessibilityRestoreDecision(recordedStart: started, currentStart: paradisProcessStart(pid), assistiveTechnologyRunning: assistive) == .restore else {
			return
		}
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 0.5)
		AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanFalse)
	}

	/** 今の記録をファイルへ書く（記録が無ければ消す）。 */
	private func persist() {
		lock.lock()
		let file = stateFile
		let list = entries.map { ParadisManualAccessibilityEntry(pid: $0.key, started: $0.value.started) }
		lock.unlock()
		guard let file else {
			return
		}
		if list.isEmpty {
			try? FileManager.default.removeItem(at: file)
			return
		}
		guard let data = try? JSONEncoder().encode(list) else {
			return
		}
		try? data.write(to: file, options: [.atomic])
		chmod(file.path, 0o600)
	}
}

/** プロセスが始まった時刻（秒）。LaunchServices を通さずに起動したアプリでも取れるよう、カーネルの値を読む。 */
func paradisProcessStart(_ pid: Int32) -> Double? {
	var info = proc_bsdinfo()
	let size = Int32(MemoryLayout<proc_bsdinfo>.size)
	guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
		return nil
	}
	return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}

let paradisManualAccessibility = ParadisManualAccessibilityLedger()

/** VS Code の派生か（`Contents/Resources/app/product.json` があるか）。 */
private func paradisHasVSCodeProductJson(pid: Int32) -> Bool {
	guard let bundleURL = paradisOnMain({ NSRunningApplication(processIdentifier: pid)?.bundleURL }) else {
		return false
	}
	return FileManager.default.fileExists(atPath: bundleURL.appendingPathComponent("Contents/Resources/app/product.json").path)
}

/** Electron 製のアプリか（`Contents/Frameworks/Electron Framework.framework` があるか）。 */
private func paradisIsElectronApp(pid: Int32) -> Bool {
	guard let bundleURL = paradisOnMain({ NSRunningApplication(processIdentifier: pid)?.bundleURL }) else {
		return false
	}
	return FileManager.default.fileExists(atPath: bundleURL.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
}

// MARK: - ウィンドウの一覧（CGWindowList）

struct ParadisWindowInfo {
	let windowId: UInt32
	let title: String?
	let bounds: CGRect
	let onScreen: Bool
}

/** その pid の通常のウィンドウ（layer 0）を手前から順に。 */
func paradisWindowInfos(pid: Int32) -> [ParadisWindowInfo] {
	guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
		return []
	}
	return list.compactMap { entry in
		guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
			(entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
			let number = entry[kCGWindowNumber as String] as? NSNumber,
			let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
			let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
			bounds.width > 1, bounds.height > 1
		else {
			return nil
		}
		return ParadisWindowInfo(
			windowId: number.uint32Value,
			title: entry[kCGWindowName as String] as? String,
			bounds: bounds,
			onScreen: (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
		)
	}
}

func paradisRectJson(_ rect: CGRect) -> [String: Any] {
	return ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.size.width), "height": Double(rect.size.height)]
}

// MARK: - ScreenCaptureKit

private final class ParadisAsyncBox<T>: @unchecked Sendable {
	var result: Result<T, Error>?
}

/** 単一ウィンドウを撮る（カーソルなし・影なし）。画面全体は撮らない。 */
private func paradisCaptureWindow(windowId: UInt32, pid: Int32, bounds: CGRect, maxLongEdge: Int) throws -> CGImage {
	let semaphore = DispatchSemaphore(value: 0)
	let box = ParadisAsyncBox<CGImage>()
	let scale = paradisOnMain { NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2 }
	let task = Task.detached {
		do {
			let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw ParadisHelperError(code: "window_not_found", message: "the window \(windowId) cannot be captured")
			}
			// 承認はアプリ単位なので、別のアプリのウィンドウ番号を渡されたら撮らない
			guard window.owningApplication?.processID == pid else {
				throw ParadisHelperError(code: "window_not_found", message: "the window \(windowId) does not belong to the application")
			}
			let filter = SCContentFilter(desktopIndependentWindow: window)
			let configuration = SCStreamConfiguration()
			let size = paradisBoundedSize(width: Int((window.frame.width * scale).rounded(.up)), height: Int((window.frame.height * scale).rounded(.up)), maxLongEdge: maxLongEdge)
			configuration.width = size.width
			configuration.height = size.height
			configuration.scalesToFit = true
			configuration.preservesAspectRatio = true
			configuration.showsCursor = false
			configuration.ignoreShadowsSingleWindow = true
			box.result = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration))
		} catch {
			box.result = .failure(error)
		}
		semaphore.signal()
	}
	guard semaphore.wait(timeout: .now() + 10) == .success else {
		task.cancel()
		throw ParadisHelperError(code: "screenshot_failed", message: "the screenshot timed out")
	}
	switch box.result {
	case .success(let image)?:
		return image
	case .failure(let error as ParadisHelperError)?:
		throw error
	case .failure(let error)?:
		throw ParadisHelperError(code: "screenshot_failed", message: String(describing: error))
	case nil:
		throw ParadisHelperError(code: "screenshot_failed", message: "the screenshot returned nothing")
	}
}

private func paradisPngData(_ image: CGImage) -> Data? {
	let data = NSMutableData()
	guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
		return nil
	}
	CGImageDestinationAddImage(destination, image, nil)
	guard CGImageDestinationFinalize(destination) else {
		return nil
	}
	return data as Data
}

// MARK: - AX の小道具

typealias ParadisAXWindowIdFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

/** `_AXUIElementGetWindow`（非公開）。無ければ位置と大きさで照合する。 */
func paradisAXWindowIdFunction() -> ParadisAXWindowIdFunction? {
	guard let handle = dlopen(nil, RTLD_NOW), let symbol = dlsym(handle, "_AXUIElementGetWindow") else {
		return nil
	}
	return unsafeBitCast(symbol, to: ParadisAXWindowIdFunction.self)
}

func paradisCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
		return nil
	}
	return value
}

private func paradisString(_ element: AXUIElement, _ attribute: String) -> String? {
	return paradisCopy(element, attribute) as? String
}

private func paradisBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
	return (paradisCopy(element, attribute) as? NSNumber)?.boolValue
}

func paradisElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
	guard let value = paradisCopy(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
		return nil
	}
	return (value as! AXUIElement)
}

func paradisElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
	guard let array = paradisCopy(element, attribute) as? [AnyObject] else {
		return []
	}
	return array.compactMap { item in
		CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
	}
}


/** 値を文字にする。文字・数・真偽値だけ（ほかの型は出さない）。 */
private func paradisValueText(_ value: CFTypeRef?) -> String? {
	guard let value else {
		return nil
	}
	if let text = value as? String {
		return text
	}
	if let number = value as? NSNumber {
		return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
	}
	return nil
}

func paradisFrame(_ element: AXUIElement) -> CGRect? {
	return paradisFrame(position: paradisCopy(element, kAXPositionAttribute), size: paradisCopy(element, kAXSizeAttribute))
}

/** いくつかの属性をまとめて読む。読めなかった属性（値が AXError のもの）は入れない。 */
func paradisCopyMultiple(_ element: AXUIElement, _ attributes: [String]) -> [String: CFTypeRef] {
	var values: CFArray?
	guard AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
		let array = values as [AnyObject]?
	else {
		return [:]
	}
	var result: [String: CFTypeRef] = [:]
	for (attribute, value) in zip(attributes, array) {
		if CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value as! AXValue) == .axError {
			continue
		}
		if value is NSNull {
			continue
		}
		result[attribute] = value
	}
	return result
}

func paradisFrame(position positionValue: CFTypeRef?, size sizeValue: CFTypeRef?) -> CGRect? {
	guard let positionValue, let sizeValue, CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
		return nil
	}
	var position = CGPoint.zero
	var size = CGSize.zero
	guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position), AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
		return nil
	}
	return CGRect(origin: position, size: size)
}

/** AX で見たウィンドウの種類。CGWindowID ごと。 */
struct ParadisAXWindowKind {
	let subrole: String?
	let minimized: Bool
	/** アプリの AXFocusedWindow（無ければ AXMainWindow）。 */
	let focused: Bool
}

func paradisAXWindowKinds(pid: Int32) -> [UInt32: ParadisAXWindowKind] {
	guard let lookup = paradisAXWindowIdFunction() else {
		return [:]
	}
	let application = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(application, 1.0)
	var kinds: [UInt32: ParadisAXWindowKind] = [:]
	let front = paradisElement(application, kAXFocusedWindowAttribute) ?? paradisElement(application, kAXMainWindowAttribute)
	for window in paradisElements(application, kAXWindowsAttribute) {
		var windowId: CGWindowID = 0
		guard lookup(window, &windowId) == .success else {
			continue
		}
		kinds[windowId] = ParadisAXWindowKind(
			subrole: paradisCopy(window, kAXSubroleAttribute) as? String,
			minimized: (paradisCopy(window, kAXMinimizedAttribute) as? NSNumber)?.boolValue ?? false,
			focused: front.map { CFEqual($0, window) } ?? false
		)
	}
	return kinds
}
