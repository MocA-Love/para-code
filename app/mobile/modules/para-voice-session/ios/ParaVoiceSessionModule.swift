// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import AVFoundation
import ExpoModulesCore
import MediaPlayer

/**
 * ユーザーが開始した音声通知の間だけ iOS の playback audio session を有効にする。
 * WebRTC の音声自体は react-native-webrtc が再生し、このモジュールはバックグラウンド継続と
 * ロック画面の停止操作を担当する。録音カテゴリやマイク入力は使用しない。
 */
public class ParaVoiceSessionModule: Module {
	private var stopTarget: Any?
	private var pauseTarget: Any?

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

		OnDestroy {
			Task { @MainActor in
				self.deactivateSession()
			}
		}
	}

	@MainActor
	private func activateSession() throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(.playback, mode: .spokenAudio, options: [])
		try session.setActive(true)

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

		MPNowPlayingInfoCenter.default().nowPlayingInfo = [
			MPMediaItemPropertyTitle: "Para Code 音声通知",
			MPMediaItemPropertyArtist: "PCからの音声通知を受信中",
			MPNowPlayingInfoPropertyIsLiveStream: true,
			MPNowPlayingInfoPropertyPlaybackRate: 1.0,
		]
	}

	@MainActor
	private func deactivateSession() {
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
		MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}
}
