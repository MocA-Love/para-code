// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

/// 1クリップあたりの上限（PC側の取込上限と同じ）。
private let maximumClipBytes = 8 * 1024 * 1024
/// 再生待ちの滞留上限。件数とバイト数の両方で抑える（常駐機能なのでjetsamを避ける）。
private let maximumQueuedClips = 8
private let maximumQueuedBytes = 12 * 1024 * 1024

/**
 * ユーザーが開始した音声通知の間だけ iOS の playback audio session を持ち、
 * PCから届いたMP3を順番に再生する。マイクは一切使わず、出力はスピーカー。
 * ロック画面には停止操作だけを出す。
 */
public class ParaVoiceSessionModule: Module {
	private var stopTarget: Any?
	private var pauseTarget: Any?
	private var sessionActive = false
	private var observers: [NSObjectProtocol] = []
	private let player = ParaVoiceClipPlayer()

	public func definition() -> ModuleDefinition {
		Name("ParaVoiceSession")
		Events("onRemoteStop")

		Function("isSupported") { () -> Bool in
			true
		}

		AsyncFunction("activate") { () async throws in
			try await MainActor.run {
				try self.activateSession()
			}
		}

		AsyncFunction("deactivate") { () async in
			await MainActor.run {
				self.deactivateSession()
			}
		}

		AsyncFunction("enqueueClip") { (base64: String) async in
			// base64のデコードは数MBになるので、メインスレッドへ渡す前に済ませる。
			guard let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= maximumClipBytes else {
				return
			}
			await MainActor.run {
				self.player.enqueue(data)
			}
		}

		OnDestroy {
			Task { @MainActor in
				self.deactivateSession()
			}
		}
	}

	private func activateSession() throws {
		let session = AVAudioSession.sharedInstance()
		// 再開始や再購読のたびに setActive(true) を撃つと、別セッションと競合して
		// InsufficientPriority で失敗する。すでに保持している間はカテゴリの再確認だけにする。
		if sessionActive {
			restoreCategoryIfNeeded()
		} else {
			try session.setCategory(.playback, mode: .spokenAudio, options: [])
			try session.setActive(true)
			sessionActive = true
		}

		// クリップの合間にアプリが停止されるとリレー接続ごと切れるため、無音を鳴らし続ける。
		player.startKeepAlive()
		startObserving()

		let commands = MPRemoteCommandCenter.shared()
		commands.playCommand.isEnabled = false
		commands.nextTrackCommand.isEnabled = false
		commands.previousTrackCommand.isEnabled = false
		commands.stopCommand.isEnabled = true
		commands.pauseCommand.isEnabled = true

		if stopTarget == nil {
			stopTarget = commands.stopCommand.addTarget { [weak self] _ in
				self?.sendEvent("onRemoteStop")
				return .success
			}
		}
		if pauseTarget == nil {
			pauseTarget = commands.pauseCommand.addTarget { [weak self] _ in
				self?.sendEvent("onRemoteStop")
				return .success
			}
		}

		refreshNowPlaying()
	}

	private func deactivateSession() {
		stopObserving()
		player.stopAll()
		let commands = MPRemoteCommandCenter.shared()
		if let target = stopTarget {
			commands.stopCommand.removeTarget(target)
			stopTarget = nil
		}
		if let target = pauseTarget {
			commands.pauseCommand.removeTarget(target)
			pauseTarget = nil
		}
		commands.stopCommand.isEnabled = false
		commands.pauseCommand.isEnabled = false
		MPNowPlayingInfoCenter.default().playbackState = .stopped
		MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
		sessionActive = false
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}

	private func refreshNowPlaying() {
		var info: [String: Any] = [
			MPMediaItemPropertyTitle: "Paracode",
			MPNowPlayingInfoPropertyIsLiveStream: true,
			MPNowPlayingInfoPropertyPlaybackRate: 1.0,
		]
		if let artwork = ParaVoiceSessionModule.artwork {
			info[MPMediaItemPropertyArtwork] = artwork
		}
		MPNowPlayingInfoCenter.default().nowPlayingInfo = info
		// これを立てないとロック画面が一時停止中の扱いになり、触ると表示ごと消える。
		MPNowPlayingInfoCenter.default().playbackState = .playing
	}

	/**
	 * ロック画面へ出すアートワーク（アプリのアイコン）。
	 * 同梱リソースが見つからないビルドでは、バンドル直下のアプリアイコンで代替する。
	 */
	private static let artwork: MPMediaItemArtwork? = {
		guard let image = loadArtworkImage() else {
			return nil
		}
		return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
	}()

	private static func loadArtworkImage() -> UIImage? {
		if let url = Bundle(for: ParaVoiceSessionModule.self).url(forResource: "ParaVoiceSessionAssets", withExtension: "bundle"),
			let bundle = Bundle(url: url),
			let image = UIImage(named: "icon", in: bundle, compatibleWith: nil) {
			return image
		}
		return UIImage(named: "AppIcon60x60") ?? UIImage(named: "AppIcon")
	}

	/**
	 * 着信・Siri・他アプリの排他取得でセッションを奪われたまま戻れないと、無音キープアライブが
	 * 止まってアプリごとサスペンドされ、以降の音声が一切届かなくなる。OS側の通知で必ず復帰させる。
	 */
	private func startObserving() {
		guard observers.isEmpty else {
			return
		}
		let center = NotificationCenter.default
		observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
			guard let self, self.sessionActive else {
				return
			}
			let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
			guard AVAudioSession.InterruptionType(rawValue: raw) == .ended else {
				return
			}
			self.resumeSession()
		})
		observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
			guard let self, self.sessionActive else {
				return
			}
			// メディアサービス再起動後は、セッションもプレイヤーも作り直すしかない。
			self.player.stopAll()
			self.sessionActive = false
			try? self.activateSession()
		})
		observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
			guard let self, self.sessionActive else {
				return
			}
			// ブラウザミラー等でWebRTCが playAndRecord + voiceChat へ寄せると、出力が受話口に
			// 落ちてマイクまで開く。カテゴリが変わっていたら再生専用へ戻す。
			self.restoreCategoryIfNeeded()
		})
	}

	private func stopObserving() {
		for observer in observers {
			NotificationCenter.default.removeObserver(observer)
		}
		observers.removeAll()
	}

	private func resumeSession() {
		try? AVAudioSession.sharedInstance().setActive(true)
		restoreCategoryIfNeeded()
		player.startKeepAlive()
		refreshNowPlaying()
	}

	private func restoreCategoryIfNeeded() {
		let session = AVAudioSession.sharedInstance()
		if session.category != .playback {
			try? session.setCategory(.playback, mode: .spokenAudio, options: [])
			try? session.setActive(true)
		}
		player.startKeepAlive()
	}
}

/**
 * 届いたMP3を到着順に1本ずつ鳴らす再生キュー。
 * 併せて、バックグラウンドで停止されないための無音ループを持つ。
 */
private final class ParaVoiceClipPlayer: NSObject, AVAudioPlayerDelegate {
	private var keepAlive: AVAudioPlayer?
	private var current: AVAudioPlayer?
	private var queue: [Data] = []
	private var queuedBytes = 0

	func startKeepAlive() {
		if keepAlive?.isPlaying == true {
			return
		}
		guard let player = try? AVAudioPlayer(data: ParaVoiceClipPlayer.silence()) else {
			return
		}
		player.numberOfLoops = -1
		player.volume = 0
		player.prepareToPlay()
		player.play()
		keepAlive = player
	}

	func enqueue(_ data: Data) {
		queue.append(data)
		queuedBytes += data.count
		// 溢れた分は古い順に捨てる（通知音声は貯めても価値が下がるだけ）。
		while queue.count > maximumQueuedClips || (queuedBytes > maximumQueuedBytes && queue.count > 1) {
			queuedBytes -= queue.removeFirst().count
		}
		playNextIfIdle()
	}

	func stopAll() {
		queue.removeAll()
		queuedBytes = 0
		current?.stop()
		current = nil
		keepAlive?.stop()
		keepAlive = nil
	}

	private func playNextIfIdle() {
		while current?.isPlaying != true, !queue.isEmpty {
			let data = queue.removeFirst()
			queuedBytes -= data.count
			guard let player = try? AVAudioPlayer(data: data) else {
				continue
			}
			player.delegate = self
			player.prepareToPlay()
			if player.play() {
				current = player
				return
			}
			current = nil
		}
	}

	func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
		DispatchQueue.main.async { self.finish(player) }
	}

	func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
		DispatchQueue.main.async { self.finish(player) }
	}

	private func finish(_ player: AVAudioPlayer) {
		if current === player {
			current = nil
		}
		playNextIfIdle()
	}

	/// 無音ループ用の1秒ぶんのWAV（8kHz/モノラル/16bit）をメモリ上で組み立てる。
	private static func silence() -> Data {
		let sampleRate = 8_000
		let samples = sampleRate
		let dataBytes = samples * 2
		var wav = Data()
		func appendUInt32(_ value: UInt32) {
			var little = value.littleEndian
			wav.append(Data(bytes: &little, count: 4))
		}
		func appendUInt16(_ value: UInt16) {
			var little = value.littleEndian
			wav.append(Data(bytes: &little, count: 2))
		}
		wav.append(contentsOf: Array("RIFF".utf8))
		appendUInt32(UInt32(36 + dataBytes))
		wav.append(contentsOf: Array("WAVEfmt ".utf8))
		appendUInt32(16)
		appendUInt16(1)
		appendUInt16(1)
		appendUInt32(UInt32(sampleRate))
		appendUInt32(UInt32(sampleRate * 2))
		appendUInt16(2)
		appendUInt16(16)
		wav.append(contentsOf: Array("data".utf8))
		appendUInt32(UInt32(dataBytes))
		wav.append(Data(count: dataBytes))
		return wav
	}
}
