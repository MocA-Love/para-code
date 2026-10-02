// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import CoreHaptics
import ExpoModulesCore
import UIKit

/// アプリの触覚（`src/haptics.ts` のトークン）を鳴らす。
///
/// expo-haptics は呼ぶたびに generator を作り、`prepare()` の直後に鳴らすので、遅延を縮められず強さも渡せない。
/// ここでは generator を保持して `prepare()` を効かせ、`impactOccurred(intensity:)` で強さを指定する。
/// 2 打のノック（`knock`）と「溜まる」振動（`charge`）は Core Haptics（`CHHapticEngine`）で鳴らす。パターン（AHAP）は
/// このファイルに持ち、JS からは名前だけを受け取る。
///
/// JS の関数はどれも同期の `Function`（JS のスレッドで呼ばれる）で、UIKit と Core Haptics には主スレッドで触る
/// （`ParaHapticsCenter` は `@MainActor`）。鳴らすかどうか（設定・前面か・間引き）は JS 側が決める。
public final class ParaHapticsModule: Module {
	public func definition() -> ModuleDefinition {
		Name("ParaHaptics")

		/// 端末が触覚を鳴らせるか。iPad（Taptic Engine 無し）とシミュレータでは false。
		Constant("supportsHaptics") { () -> Bool in
			ParaHapticsCenter.supportsHaptics
		}

		/// 低電力モードか（JS がノック・charge を軽い 1 打へ落とすのに使う）。
		Function("isLowPowerMode") { () -> Bool in
			ProcessInfo.processInfo.isLowPowerModeEnabled
		}

		/// 次の触覚に備えて generator を温める（`selection` / `impact-<style>` / `notification`）。`engine` はエンジンを非同期に起こす。
		Function("prepare") { (kind: String) in
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.prepare(kind)
			}
		}

		Function("selection") {
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.selection()
			}
		}

		/// `style` は `light` / `medium` / `heavy` / `soft` / `rigid`。`intensity` は 0〜1。
		Function("impact") { (style: String, intensity: Double) in
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.impact(style: style, intensity: intensity)
			}
		}

		/// `type` は `success` / `warning` / `error`。
		Function("notify") { (type: String) in
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.notify(type)
			}
		}

		/// 強さと鋭さを指定した 1 打。エンジンが動いていれば Core Haptics、止まっていれば UIKit の impact で代わりに鳴らす。
		Function("transient") { (intensity: Double, sharpness: Double) in
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.transient(intensity: intensity, sharpness: sharpness)
			}
		}

		/// 名前（`knock` / `charge`）のパターンを鳴らす。知らない名前は無視する。
		Function("playPattern") { (name: String) in
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.playPattern(name)
			}
		}

		// 背面ではエンジンを止める（次に鳴らすときに起こし直す）。
		OnAppEntersBackground {
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.stopEngine()
			}
		}

		OnDestroy {
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.stopEngine()
			}
		}
	}
}

/// generator とエンジンの持ち主。主スレッドだけで使う。
@MainActor
final class ParaHapticsCenter {
	static let shared = ParaHapticsCenter()

	/// 端末が触覚を持つか（起動中に変わらない。JS のスレッドからも読む）。
	nonisolated static let supportsHaptics: Bool = CHHapticEngine.capabilitiesForHardware().supportsHaptics

	private var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
	private lazy var selectionGenerator = UISelectionFeedbackGenerator()
	private lazy var notificationGenerator = UINotificationFeedbackGenerator()

	private var engine: CHHapticEngine?
	/// エンジンが動いているか。止まった（待機での自動停止・音声の割り込み・背面・サーバーのリセット）ら false。
	private var engineRunning = false
	/// `start(completionHandler:)` の完了を待っている間に頼まれた再生（起きたら順に鳴らす）。
	private var waitingForStart: [() -> Void]?
	/// 読み取ったパターン（名前ごと・transient の強さと鋭さごと）。
	private var patterns: [String: CHHapticPattern] = [:]

	// MARK: UIFeedbackGenerator

	func prepare(_ kind: String) {
		switch kind {
		case "selection":
			selectionGenerator.prepare()
		case "notification":
			notificationGenerator.prepare()
		case "engine":
			startEngine(then: nil)
		default:
			if kind.hasPrefix("impact-") {
				impactGenerator(Self.impactStyle(String(kind.dropFirst("impact-".count)))).prepare()
			}
		}
	}

	func selection() {
		selectionGenerator.selectionChanged()
		// 値の変化は続けて起きやすい（セグメント・キー）。次の 1 回の遅延を縮めておく。
		selectionGenerator.prepare()
	}

	func impact(style: String, intensity: Double) {
		impact(Self.impactStyle(style), intensity: intensity)
	}

	private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle, intensity: Double) {
		let generator = impactGenerator(style)
		generator.impactOccurred(intensity: CGFloat(Self.unit(intensity)))
		generator.prepare()
	}

	func notify(_ type: String) {
		let feedback: UINotificationFeedbackGenerator.FeedbackType
		switch type {
		case "success": feedback = .success
		case "error": feedback = .error
		default: feedback = .warning
		}
		notificationGenerator.notificationOccurred(feedback)
	}

	private func impactGenerator(_ style: UIImpactFeedbackGenerator.FeedbackStyle) -> UIImpactFeedbackGenerator {
		if let existing = impacts[style] {
			return existing
		}
		let created = UIImpactFeedbackGenerator(style: style)
		impacts[style] = created
		return created
	}

	private static func impactStyle(_ name: String) -> UIImpactFeedbackGenerator.FeedbackStyle {
		switch name {
		case "light": return .light
		case "heavy": return .heavy
		case "soft": return .soft
		case "rigid": return .rigid
		default: return .medium
		}
	}

	private static func unit(_ value: Double) -> Double {
		value.isFinite ? min(1, max(0, value)) : 1
	}

	// MARK: Core Haptics

	/// 1 打。指の動きに合わせて鳴らすもの（引き切りから戻ったとき）なので、エンジンの起動を待たない。
	/// 動いていなければ鋭さに近い UIKit の impact で代わりに鳴らし、次に備えてエンジンを非同期に起こす。
	func transient(intensity: Double, sharpness: Double) {
		let i = Float(Self.unit(intensity))
		let s = Float(Self.unit(sharpness))
		guard engineRunning, let engine else {
			impact(s >= 0.7 ? .rigid : s <= 0.3 ? .soft : .light, intensity: Double(i))
			startEngine(then: nil)
			return
		}
		let key = String(format: "transient:%.2f:%.2f", i, s)
		guard let pattern = pattern(key, make: {
			let event = CHHapticEvent(
				eventType: .hapticTransient,
				parameters: [
					CHHapticEventParameter(parameterID: .hapticIntensity, value: i),
					CHHapticEventParameter(parameterID: .hapticSharpness, value: s),
				],
				relativeTime: 0
			)
			return try CHHapticPattern(events: [event], parameters: [])
		}) else {
			return
		}
		play(pattern, on: engine)
	}

	/// 名前のパターンを鳴らす。エンジンが止まっていれば非同期に起こしてから鳴らす（その 1 回は遅れてよい）。
	func playPattern(_ name: String) {
		guard let dictionary = ParaHapticPatterns.dictionary(named: name), let pattern = pattern("pattern:\(name)", make: {
			try CHHapticPattern(dictionary: dictionary)
		}) else {
			return
		}
		startEngine { [weak self] in
			guard let self, let engine = self.engine else {
				return
			}
			self.play(pattern, on: engine)
		}
	}

	func stopEngine() {
		waitingForStart = nil
		guard let engine, engineRunning else {
			return
		}
		engineRunning = false
		engine.stop(completionHandler: nil)
	}

	private func pattern(_ key: String, make: () throws -> CHHapticPattern) -> CHHapticPattern? {
		if let cached = patterns[key] {
			return cached
		}
		do {
			let created = try make()
			patterns[key] = created
			return created
		} catch {
			NSLog("[ParaHaptics] invalid pattern %@: %@", key, String(describing: error))
			return nil
		}
	}

	private func play(_ pattern: CHHapticPattern, on engine: CHHapticEngine) {
		do {
			let player = try engine.makePlayer(with: pattern)
			try player.start(atTime: CHHapticTimeImmediate)
		} catch {
			// 動いているはずのエンジンが使えなかった（リセットの直後など）。作り直しは次の再生に任せる。
			NSLog("[ParaHaptics] failed to play a pattern: %@", String(describing: error))
			self.engine = nil
			engineRunning = false
		}
	}

	/// エンジンを動かしてから `then` を呼ぶ。動いていればすぐ、止まっていれば `start(completionHandler:)` の完了後（主スレッド）。
	/// 主スレッドで同期の `start()` を待たない（自動停止したエンジンの起動で UI が詰まらないように）。
	private func startEngine(then: (() -> Void)?) {
		guard Self.supportsHaptics else {
			return
		}
		if engineRunning, engine != nil {
			then?()
			return
		}
		if waitingForStart != nil {
			if let then {
				waitingForStart?.append(then)
			}
			return
		}
		guard let engine = makeEngineIfNeeded() else {
			return
		}
		waitingForStart = then.map { [$0] } ?? []
		// エンジンそのものは Sendable ではないので、完了では識別子だけを主スレッドへ持ち帰る
		let startedId = ObjectIdentifier(engine)
		engine.start { @Sendable error in
			let message = error.map { String(describing: $0) }
			DispatchQueue.main.async {
				ParaHapticsCenter.shared.engineStarted(startedId, failure: message)
			}
		}
	}

	private func engineStarted(_ started: ObjectIdentifier, failure: String?) {
		let waiting = waitingForStart ?? []
		waitingForStart = nil
		// 待っている間に止められた・作り直されたエンジンの完了は捨てる
		guard let engine, ObjectIdentifier(engine) == started else {
			return
		}
		if let failure {
			NSLog("[ParaHaptics] failed to start the haptic engine: %@", failure)
			engineRunning = false
			return
		}
		engineRunning = true
		waiting.forEach { $0() }
	}

	private func makeEngineIfNeeded() -> CHHapticEngine? {
		if let engine {
			return engine
		}
		do {
			let created = try CHHapticEngine()
			// 音は鳴らさない（オーディオセッションを持たないので録音・再生と干渉しない）。
			created.playsHapticsOnly = true
			// 待機中は OS が止める（電池のため）。止まったら印を倒し、次に鳴らすときに起こす。
			created.isAutoShutdownEnabled = true
			let createdId = ObjectIdentifier(created)
			created.stoppedHandler = { @Sendable _ in
				DispatchQueue.main.async {
					ParaHapticsCenter.shared.engineStopped(createdId)
				}
			}
			// haptic サーバーが落ちて戻った。プレイヤーは毎回作っているので、印を倒して次に起こし直すだけ。
			created.resetHandler = { @Sendable in
				DispatchQueue.main.async {
					ParaHapticsCenter.shared.engineStopped(createdId)
				}
			}
			engine = created
			return created
		} catch {
			NSLog("[ParaHaptics] failed to create the haptic engine: %@", String(describing: error))
			return nil
		}
	}

	private func engineStopped(_ stopped: ObjectIdentifier) {
		if let engine, ObjectIdentifier(engine) == stopped {
			engineRunning = false
		}
	}
}

/// knock と charge の AHAP（`mobile-haptics-design.html` の 3-1）。
private enum ParaHapticPatterns {
	/// 名前のパターン。知らない名前は nil。
	static func dictionary(named name: String) -> [CHHapticPattern.Key: Any]? {
		all[name]
	}

	private static var all: [String: [CHHapticPattern.Key: Any]] { [
		// 前面で承認・質問が届いた: transient 2 打（0s と 0.12s、強さ 0.5 / 鋭さ 0.35）
		"knock": [
			.version: 1.0,
			.pattern: [0.0, 0.12].map { time -> [CHHapticPattern.Key: Any] in
				[.event: [
					CHHapticPattern.Key.time: time,
					CHHapticPattern.Key.eventType: CHHapticEvent.EventType.hapticTransient.rawValue,
					CHHapticPattern.Key.eventParameters: [
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.hapticIntensity.rawValue, CHHapticPattern.Key.parameterValue: 0.5],
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.hapticSharpness.rawValue, CHHapticPattern.Key.parameterValue: 0.35],
					],
				]]
			},
		],
		// エフォートの最大に入った: continuous 0.25s（鋭さ 0.2、attack 0.15 / decay 0 / release 0.05）、強さを 0.2 → 0.6 へ上げる
		"charge": [
			.version: 1.0,
			.pattern: [
				[.event: [
					CHHapticPattern.Key.time: 0.0,
					CHHapticPattern.Key.eventType: CHHapticEvent.EventType.hapticContinuous.rawValue,
					CHHapticPattern.Key.eventDuration: 0.25,
					CHHapticPattern.Key.eventParameters: [
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.hapticIntensity.rawValue, CHHapticPattern.Key.parameterValue: 1.0],
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.hapticSharpness.rawValue, CHHapticPattern.Key.parameterValue: 0.2],
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.attackTime.rawValue, CHHapticPattern.Key.parameterValue: 0.15],
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.decayTime.rawValue, CHHapticPattern.Key.parameterValue: 0.0],
						[CHHapticPattern.Key.parameterID: CHHapticEvent.ParameterID.releaseTime.rawValue, CHHapticPattern.Key.parameterValue: 0.05],
					],
				]] as [CHHapticPattern.Key: Any],
				[.parameterCurve: [
					CHHapticPattern.Key.parameterID: CHHapticDynamicParameter.ID.hapticIntensityControl.rawValue,
					CHHapticPattern.Key.time: 0.0,
					CHHapticPattern.Key.parameterCurveControlPoints: [
						[CHHapticPattern.Key.time: 0.0, CHHapticPattern.Key.parameterValue: 0.2],
						[CHHapticPattern.Key.time: 0.25, CHHapticPattern.Key.parameterValue: 0.6],
					],
				]] as [CHHapticPattern.Key: Any],
			],
		],
	] }
}
