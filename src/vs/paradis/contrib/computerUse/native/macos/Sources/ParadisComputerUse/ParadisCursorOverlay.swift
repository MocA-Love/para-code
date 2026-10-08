/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの独自のカーソル（画面の上に描くだけで、実カーソルもマウスのイベントも使わない）。
//
// 見た目は内蔵ブラウザのエージェントのカーソル（`agentBrowser/common/paradisCursorOverlay.ts`）と同じ: 持ち主の色の矢印
// （白い縁と色の光）、名前の札（色の地に白い字、左に CLI の印）、移動の軌跡（色の線を少し残して消す）、クリックの波紋。
// 名前と色は shared process が決めて要求ごとに渡す（`ParadisCursorOwnerSpec`）。
//
// 画面ごとに透明でクリックが素通りする（`ignoresMouseEvents`）パネルを 1 枚置き、全部の操作スペースとフルスクリーンの
// アプリの上にも出す（`canJoinAllSpaces`・`fullScreenAuxiliary`）。アプリにならない（`nonactivatingPanel`、キーにならない）。
// ウィンドウの撮影は ScreenCaptureKit の単一ウィンドウ（`desktopIndependentWindow`）なので、このパネルは写らない。
//
//  - 1 段目（AX）: 操作した要素の位置へ軌跡つきで動かしてから操作し、波紋を出す
//  - 3 段目（前面）: 実カーソルが動くので矢印は出さず、名前の札と波紋だけを実カーソルの位置に合わせる（矢印が 2 つ
//    重なって見えないように。誰が動かしているかは札で分かる）
// 15 秒操作が無ければ消える。UI は main スレッドだけで触る。位置の記録だけは要求のスレッドから読むので鍵で守る。

import AppKit
import QuartzCore

/** 何もしなければ消すまでの時間。 */
private let paradisCursorIdleSeconds: TimeInterval = 15
/** 現れる・消えるときのフェードの時間。 */
private let paradisCursorFadeSeconds: TimeInterval = 0.14
/** 波紋の時間（内蔵ブラウザの rippleMs と同じ）。 */
private let paradisCursorRippleSeconds: TimeInterval = 0.46
/** 軌跡を消し終えるまでの時間（trailFadeMs と同じ）。 */
private let paradisCursorTrailFadeSeconds: TimeInterval = 0.6
/** 矢印の大きさ（内蔵ブラウザの CURSOR_SIZE と同じ、pt）。 */
private let paradisCursorArrowSize: CGFloat = 42

final class ParadisCursorOverlay {

	static let shared = ParadisCursorOverlay()

	private let lock = NSLock()
	/** 持ち主ごとの今の位置（画面の座標、左上原点）。見えていなければ無い。 */
	private var positions: [String: CGPoint] = [:]

	// 以下は main スレッドだけで触る
	private var panels: [CGDirectDisplayID: ParadisCursorPanel] = [:]
	private var sprites: [String: ParadisCursorSprite] = [:]

	/**
	 * 独自のカーソルを `point`（画面の座標）へ軌跡つきで動かす。先端が着くまでの秒数を返す（呼び出し側は
	 * その間待ってから操作する）。初めて出すときはその点にフェードで出す。
	 */
	func glide(_ owner: ParadisCursorOwnerSpec, to point: CGPoint) -> TimeInterval {
		lock.lock()
		let from = positions[owner.id]
		positions[owner.id] = point
		lock.unlock()
		let glide = paradisPlanCursorGlide(from: from, to: point)
		DispatchQueue.main.async {
			self.sprite(for: owner, at: point)?.glide(glide, appear: from == nil)
		}
		return from == nil ? paradisCursorFadeSeconds : glide.durationMs / 1000
	}

	/** クリックの波紋。 */
	func ripple(_ owner: ParadisCursorOwnerSpec, at point: CGPoint) {
		DispatchQueue.main.async {
			self.sprite(for: owner, at: point)?.ripple()
		}
	}

	/** 3 段目: 実カーソルの位置に名前の札を合わせる（矢印は出さない）。`click` なら波紋も出す。 */
	func followPointer(_ owner: ParadisCursorOwnerSpec, at point: CGPoint, click: Bool) {
		lock.lock()
		positions[owner.id] = point
		lock.unlock()
		DispatchQueue.main.async {
			guard let sprite = self.sprite(for: owner, at: point) else {
				return
			}
			sprite.follow(point)
			if click {
				sprite.ripple()
			}
		}
	}

	/** 全部の持ち主のカーソルを消す（設定でオフにした要求が来たとき）。 */
	func hideAll() {
		lock.lock()
		let any = !positions.isEmpty
		positions.removeAll()
		lock.unlock()
		guard any else {
			return
		}
		DispatchQueue.main.async {
			for sprite in self.sprites.values {
				sprite.fadeOut()
			}
		}
	}

	fileprivate func forget(_ ownerId: String) {
		lock.lock()
		positions.removeValue(forKey: ownerId)
		lock.unlock()
	}

	// MARK: - main スレッド

	/** 持ち主のカーソル。点のある画面のパネルへ移す（画面をまたいだら作り直す）。 */
	private func sprite(for owner: ParadisCursorOwnerSpec, at point: CGPoint) -> ParadisCursorSprite? {
		guard let panel = panel(containing: point) else {
			return nil
		}
		if let existing = sprites[owner.id], existing.panel === panel {
			existing.update(owner)
			return existing
		}
		sprites[owner.id]?.remove()
		let sprite = ParadisCursorSprite(owner: owner, panel: panel, overlay: self)
		sprites[owner.id] = sprite
		return sprite
	}

	private func panel(containing point: CGPoint) -> ParadisCursorPanel? {
		guard let screen = NSScreen.screens.first(where: { paradisScreenRect($0).contains(point) }) ?? NSScreen.main,
			let displayId = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
		else {
			return nil
		}
		if let panel = panels[displayId] {
			if panel.frame != screen.frame {
				panel.setFrame(screen.frame, display: false)
			}
			panel.screenRect = paradisScreenRect(screen)
			return panel
		}
		let panel = ParadisCursorPanel(screen: screen)
		panels[displayId] = panel
		return panel
	}
}

/** 画面の矩形を、左上原点の画面の座標（CGWindowList・CGEvent と同じ）で。 */
private func paradisScreenRect(_ screen: NSScreen) -> CGRect {
	let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
	return CGRect(x: screen.frame.minX, y: primaryHeight - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
}

/** 画面 1 枚を覆う、透明でクリックが素通りするパネル。 */
private final class ParadisCursorPanel: NSPanel {
	var screenRect: CGRect
	let root: CALayer

	init(screen: NSScreen) {
		screenRect = paradisScreenRect(screen)
		let view = ParadisCursorRootView(frame: NSRect(origin: .zero, size: screen.frame.size))
		view.wantsLayer = true
		root = view.layer ?? CALayer()
		super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
		contentView = view
		isOpaque = false
		backgroundColor = .clear
		hasShadow = false
		ignoresMouseEvents = true
		isReleasedWhenClosed = false
		hidesOnDeactivate = false
		isFloatingPanel = true
		// 補助技術の上の段（メニューやポップアップより上）。クリックは素通りするので、ほかのアプリの操作は妨げない
		level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.assistiveTechHighWindow)))
		collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
		setAccessibilityElement(false)
		orderFrontRegardless()
	}

	override var canBecomeKey: Bool { false }
	override var canBecomeMain: Bool { false }

	/** 画面の座標をこのパネルの中の座標（左上原点）にする。 */
	func local(_ point: CGPoint) -> CGPoint {
		return CGPoint(x: point.x - screenRect.minX, y: point.y - screenRect.minY)
	}
}

/** 左上原点の層の置き場所。 */
private final class ParadisCursorRootView: NSView {
	override var isFlipped: Bool { true }
	override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/** 持ち主 1 つのカーソル（矢印・札・波紋・軌跡）。 */
private final class ParadisCursorSprite {
	let panel: ParadisCursorPanel
	private weak var overlay: ParadisCursorOverlay?
	private var owner: ParadisCursorOwnerSpec
	/** 先端の位置に置く入れ物。矢印・札・波紋はこの中。 */
	private let container = CALayer()
	private let arrow = CAShapeLayer()
	private let rippleLayer = CAShapeLayer()
	private let label = CALayer()
	private let markLayer = CALayer()
	private let markText = CATextLayer()
	private let nameText = CATextLayer()
	private var idleTimer: Timer?
	private var visible = false

	init(owner: ParadisCursorOwnerSpec, panel: ParadisCursorPanel, overlay: ParadisCursorOverlay) {
		self.owner = owner
		self.panel = panel
		self.overlay = overlay
		let scale = panel.screen?.backingScaleFactor ?? 2
		container.opacity = 0
		container.bounds = .zero

		// 矢印: cursor-motion の 128 の正方形の形（内蔵ブラウザの CURSOR_PATH と同じ）。先端 (55, 30) を原点に置く
		let factor = paradisCursorArrowSize / 128
		var transform = CGAffineTransform(scaleX: factor, y: factor).translatedBy(x: -55, y: -30)
		arrow.path = paradisCursorArrowPath().copy(using: &transform)
		arrow.strokeColor = NSColor.white.cgColor
		arrow.lineWidth = 5 * factor
		arrow.lineJoin = .round
		// 持ち主の色の光（内蔵ブラウザの drop-shadow(0 0 3px <色>) に当たる）
		arrow.shadowOpacity = 0.9
		arrow.shadowRadius = 3
		arrow.shadowOffset = .zero

		let rippleRadius: CGFloat = 18
		rippleLayer.path = CGPath(ellipseIn: CGRect(x: -rippleRadius, y: -rippleRadius, width: rippleRadius * 2, height: rippleRadius * 2), transform: nil)
		rippleLayer.fillColor = nil
		rippleLayer.lineWidth = 2
		rippleLayer.opacity = 0

		label.cornerRadius = 5
		label.shadowOpacity = 0.25
		label.shadowRadius = 3
		label.shadowOffset = CGSize(width: 0, height: 2)
		markLayer.cornerRadius = 6.5
		markLayer.backgroundColor = NSColor(white: 1, alpha: 0.28).cgColor
		for text in [markText, nameText] {
			text.contentsScale = scale
			text.foregroundColor = NSColor.white.cgColor
			text.alignmentMode = .center
		}
		markLayer.addSublayer(markText)
		label.addSublayer(markLayer)
		label.addSublayer(nameText)

		container.addSublayer(rippleLayer)
		container.addSublayer(arrow)
		container.addSublayer(label)
		panel.root.addSublayer(container)
		apply(owner)
	}

	func update(_ owner: ParadisCursorOwnerSpec) {
		if owner != self.owner {
			self.owner = owner
			apply(owner)
		}
	}

	/** 色と名前を当てる。札の大きさは名前の幅から決める。 */
	private func apply(_ owner: ParadisCursorOwnerSpec) {
		CATransaction.begin()
		CATransaction.setDisableActions(true)
		let color = paradisColor(owner.color)
		arrow.fillColor = color.cgColor
		arrow.shadowColor = color.cgColor
		rippleLayer.strokeColor = color.cgColor
		label.backgroundColor = color.cgColor
		let nameFont = NSFont.systemFont(ofSize: 10.5, weight: .medium)
		let markFont = NSFont.systemFont(ofSize: 9, weight: .bold)
		nameText.font = nameFont
		nameText.fontSize = 10.5
		nameText.string = owner.name
		markText.font = markFont
		markText.fontSize = 9
		markText.string = owner.mark
		let nameSize = (owner.name as NSString).size(withAttributes: [.font: nameFont])
		let height: CGFloat = 19
		var x: CGFloat = 7
		markLayer.isHidden = owner.mark.isEmpty
		if !owner.mark.isEmpty {
			markLayer.frame = CGRect(x: x, y: (height - 13) / 2, width: 13, height: 13)
			markText.frame = CGRect(x: 0, y: 0.5, width: 13, height: 12)
			x += 13 + 5
		}
		nameText.frame = CGRect(x: x, y: (height - ceil(nameSize.height)) / 2, width: ceil(nameSize.width) + 1, height: ceil(nameSize.height))
		label.frame = CGRect(x: 18, y: 22, width: x + ceil(nameSize.width) + 1 + 7, height: height)
		CATransaction.commit()
	}

	/** 軌跡つきで動かす。`appear` なら終点にフェードで出す。 */
	func glide(_ glide: ParadisCursorGlide, appear: Bool) {
		let points = glide.points.map { panel.local($0) }
		guard let last = points.last else {
			return
		}
		CATransaction.begin()
		CATransaction.setDisableActions(true)
		arrow.opacity = 1
		container.removeAnimation(forKey: "glide")
		container.position = last
		CATransaction.commit()
		if !appear && glide.durationMs > 0 && points.count > 1 {
			let move = CAKeyframeAnimation(keyPath: "position")
			move.values = points.map { NSValue(point: $0) }
			move.duration = glide.durationMs / 1000
			move.calculationMode = .linear
			container.add(move, forKey: "glide")
			drawTrail(points, duration: move.duration)
		}
		show()
	}

	/** 3 段目: 実カーソルの位置に札だけを置く。 */
	func follow(_ point: CGPoint) {
		CATransaction.begin()
		CATransaction.setDisableActions(true)
		container.removeAnimation(forKey: "glide")
		container.position = panel.local(point)
		arrow.opacity = 0
		CATransaction.commit()
		show()
	}

	func ripple() {
		let scale = CABasicAnimation(keyPath: "transform.scale")
		scale.fromValue = 0.35
		scale.toValue = 1.6
		let fade = CABasicAnimation(keyPath: "opacity")
		fade.fromValue = 0.75
		fade.toValue = 0
		let group = CAAnimationGroup()
		group.animations = [scale, fade]
		group.duration = paradisCursorRippleSeconds
		group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
		rippleLayer.add(group, forKey: "ripple")
		show()
	}

	func fadeOut() {
		idleTimer?.invalidate()
		idleTimer = nil
		guard visible else {
			return
		}
		visible = false
		overlay?.forget(owner.id)
		let fade = CABasicAnimation(keyPath: "opacity")
		fade.fromValue = container.presentation()?.opacity ?? 1
		fade.toValue = 0
		fade.duration = paradisCursorFadeSeconds * 2
		container.opacity = 0
		container.add(fade, forKey: "fade")
	}

	func remove() {
		idleTimer?.invalidate()
		idleTimer = nil
		container.removeFromSuperlayer()
	}

	private func show() {
		if !visible {
			visible = true
			let fade = CABasicAnimation(keyPath: "opacity")
			fade.fromValue = 0
			fade.toValue = 1
			fade.duration = paradisCursorFadeSeconds
			container.opacity = 1
			container.add(fade, forKey: "fade")
		}
		panel.orderFrontRegardless()
		idleTimer?.invalidate()
		idleTimer = Timer.scheduledTimer(withTimeInterval: paradisCursorIdleSeconds, repeats: false) { [weak self] _ in
			self?.fadeOut()
		}
	}

	/** 軌跡: 先端に合わせて線を伸ばし、着いたら薄くして消す。 */
	private func drawTrail(_ points: [CGPoint], duration: TimeInterval) {
		let path = CGMutablePath()
		path.addLines(between: points)
		let trail = CAShapeLayer()
		trail.path = path
		trail.fillColor = nil
		trail.strokeColor = paradisColor(owner.color).withAlphaComponent(0.65).cgColor
		trail.lineWidth = 3
		trail.lineCap = .round
		trail.lineJoin = .round
		trail.strokeEnd = 1
		trail.opacity = 0
		panel.root.insertSublayer(trail, below: container)
		// 線の伸びを先端の位置（等しい時間おきの点）にそろえる: 各点までの長さの割合をキーにする
		var lengths: [CGFloat] = [0]
		for index in 1..<points.count {
			lengths.append(lengths[index - 1] + hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y))
		}
		let total = max(lengths.last ?? 1, 1)
		let grow = CAKeyframeAnimation(keyPath: "strokeEnd")
		grow.values = lengths.map { $0 / total }
		grow.duration = duration
		grow.calculationMode = .linear
		let fade = CAKeyframeAnimation(keyPath: "opacity")
		fade.values = [1, 1, 0]
		fade.keyTimes = [0, NSNumber(value: duration / (duration + paradisCursorTrailFadeSeconds)), 1]
		fade.duration = duration + paradisCursorTrailFadeSeconds
		CATransaction.begin()
		CATransaction.setCompletionBlock {
			trail.removeFromSuperlayer()
		}
		trail.add(grow, forKey: "grow")
		trail.add(fade, forKey: "fade")
		CATransaction.commit()
	}
}

private func paradisColor(_ rgb: UInt32) -> NSColor {
	return NSColor(srgbRed: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
}

/**
 * 矢印の形。内蔵ブラウザの `CURSOR_PATH`（cursor-motion の 128 の正方形の SVG の path）と同じ点を CGPath にしたもの:
 * `M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 C88 75 91 72 95 70
 *  C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z`
 */
private func paradisCursorArrowPath() -> CGPath {
	let path = CGMutablePath()
	path.move(to: CGPoint(x: 55, y: 30))
	let curves: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
		(48, 28, 42, 33, 43, 41),
		(43, 41, 64, 98, 64, 98),
		(67, 106, 73, 106, 77, 99),
		(77, 99, 86, 79, 86, 79),
		(88, 75, 91, 72, 95, 70),
		(95, 70, 108, 63, 108, 63),
		(115, 59, 114, 53, 107, 50),
		(107, 50, 55, 30, 55, 30),
	]
	for curve in curves {
		path.addCurve(to: CGPoint(x: curve.4, y: curve.5), control1: CGPoint(x: curve.0, y: curve.1), control2: CGPoint(x: curve.2, y: curve.3))
	}
	path.closeSubpath()
	return path
}
