/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 読み取りの命令の実体（許可の確認・アプリとウィンドウの一覧・単一ウィンドウのスクショ・アクセシビリティのツリー）。
//
// 許可の無い機能は、OS の API を呼ぶ前に確かめて断る。ScreenCaptureKit は許可が無いと OS の確認を
// 出すことがあるので、`CGPreflightScreenCaptureAccess()`（確認を出さない）で先に止める。
// 入力（クリック・文字）はこの版には無い。

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

final class ParadisDesktop: ParadisDesktopBackend {

	func permissions() -> ParadisPermissionSnapshot {
		return ParadisPermissionSnapshot(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
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
		return paradisWindowInfos(pid: pid).enumerated().map { index, info in
			var entry: [String: Any] = [
				"windowId": Int(info.windowId),
				"index": index,
				"bounds": paradisRectJson(info.bounds),
				"onScreen": info.onScreen,
			]
			// 画面収録の許可が無いとタイトルは OS から返らない
			if let title = info.title, !title.isEmpty {
				entry["title"] = paradisSanitizeText(title, maxLength: 200)
			}
			return entry
		}
	}

	private func requireRunningApp(_ pid: Int32) throws {
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

	func accessibilityTree(pid: Int32, windowId: UInt32?, maxNodes: Int, maxDepth: Int) throws -> [String: Any] {
		guard AXIsProcessTrusted() else {
			throw ParadisHelperError(code: "accessibility_not_granted", message: "Accessibility permission is not granted to Para Code Computer Use")
		}
		try requireRunningApp(pid)
		let application = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(application, 2.0)
		let windows = paradisElements(application, kAXWindowsAttribute)
		guard !windows.isEmpty else {
			throw ParadisHelperError(code: "window_not_found", message: "the application has no accessible window")
		}
		let window = try paradisPickWindow(windows, application: application, windowId: windowId, pid: pid)
		let windowFrame = paradisFrame(window) ?? .zero
		var nodes: [ParadisAXNode] = []
		var truncated = false
		// 深さ優先で番号を振る（画面の上から下の順に近くなる）
		var stack: [(AXUIElement, Int)] = [(window, 0)]
		while let (element, depth) = stack.popLast() {
			if nodes.count >= maxNodes {
				truncated = true
				break
			}
			nodes.append(paradisDescribe(element, index: nodes.count, depth: depth, origin: windowFrame.origin))
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
		return [
			"text": paradisRenderAXTree(nodes, truncated: truncated),
			"nodeCount": nodes.count,
			"truncated": truncated,
			"window": paradisRectJson(windowFrame),
		]
	}

	private func paradisPickWindow(_ windows: [AXUIElement], application: AXUIElement, windowId: UInt32?, pid: Int32) throws -> AXUIElement {
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

	private func paradisDescribe(_ element: AXUIElement, index: Int, depth: Int, origin: CGPoint) -> ParadisAXNode {
		let role = paradisString(element, kAXRoleAttribute) ?? "AXUnknown"
		let subrole = paradisString(element, kAXSubroleAttribute)
		let title = paradisString(element, kAXTitleAttribute)
		let label = paradisString(element, kAXDescriptionAttribute)
		let placeholder = paradisString(element, kAXPlaceholderValueAttribute)
		let secure = paradisIsSecureLike(role: role, subrole: subrole, title: title, label: label, placeholder: placeholder)
		let value = secure ? nil : paradisValueText(element)
		var frame = paradisFrame(element)
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
			value: value,
			label: label,
			frame: frame,
			enabled: paradisBool(element, kAXEnabledAttribute),
			focused: paradisBool(element, kAXFocusedAttribute),
			actions: actionNames,
			redacted: secure && paradisHasValue(element)
		)
	}
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

private typealias ParadisAXWindowIdFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

/** `_AXUIElementGetWindow`（非公開）。無ければ位置と大きさで照合する。 */
private func paradisAXWindowIdFunction() -> ParadisAXWindowIdFunction? {
	guard let handle = dlopen(nil, RTLD_NOW), let symbol = dlsym(handle, "_AXUIElementGetWindow") else {
		return nil
	}
	return unsafeBitCast(symbol, to: ParadisAXWindowIdFunction.self)
}

private func paradisCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
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

private func paradisElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
	guard let value = paradisCopy(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else {
		return nil
	}
	return (value as! AXUIElement)
}

private func paradisElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
	guard let array = paradisCopy(element, attribute) as? [AnyObject] else {
		return []
	}
	return array.compactMap { item in
		CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
	}
}

private func paradisHasValue(_ element: AXUIElement) -> Bool {
	return paradisCopy(element, kAXValueAttribute) != nil
}

/** 値を文字にする。文字・数・真偽値だけ（ほかの型は出さない）。 */
private func paradisValueText(_ element: AXUIElement) -> String? {
	guard let value = paradisCopy(element, kAXValueAttribute) else {
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

private func paradisFrame(_ element: AXUIElement) -> CGRect? {
	guard let positionValue = paradisCopy(element, kAXPositionAttribute), let sizeValue = paradisCopy(element, kAXSizeAttribute),
		CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID()
	else {
		return nil
	}
	var position = CGPoint.zero
	var size = CGSize.zero
	guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position), AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
		return nil
	}
	return CGRect(origin: position, size: size)
}
