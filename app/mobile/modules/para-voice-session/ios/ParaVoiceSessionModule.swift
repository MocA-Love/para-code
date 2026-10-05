// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import AudioToolbox
import AVFoundation
import ExpoModulesCore
import MediaPlayer
import UIKit

/// 1発話あたりの上限（PC側の取込上限と同じ）。
private let maximumClipBytes = 8 * 1024 * 1024
/// 再生待ちの滞留上限。発話の数・流れの数・バイト数で抑える（常駐機能なのでjetsamを避ける）。
private let maximumQueuedUtterances = 8
private let maximumQueuedStreams = 5
private let maximumQueuedBytes = 12 * 1024 * 1024
/// 最後の断片からこれだけ end が来なければ、届いた分で終える。
private let streamEndTimeout: TimeInterval = 8
/// 鳴らし始める前に溜める量（ms）。足りなくなるたびに次の発話から 250ms 上げ（最大 1500ms）、
/// 5 回続けて足りたら 250ms 下げる（最小 500ms）。
private let initialPrebufferMs = 500
private let prebufferStepMs = 250
private let maximumPrebufferMs = 1500
private let prebufferRelaxAfter = 5
/// -1dBFS。音量の補正を掛けた後、ここで頭打ちにする。
private let limiterCeiling: Float = 0.891_25
/// AudioConverter の入力関数が「今は手元に無い」を伝える印（'pvnd'）。
private let paraNoDataStatus: OSStatus = 0x7076_6E64
private let decodeFramesPerBuffer: AVAudioFrameCount = 4096
/// デコーダへ一度に渡す MP3 の量。デコード済み（未再生）の PCM は 10 秒ぶんまでにする。
private let feedSliceBytes = 64 * 1024
private let maximumDecodedSeconds: Double = 10
/// 鳴らしている最中にエンジンが止まったまま（割り込みの終わりが来ない等）これだけ続いたら、作り直すか諦める。
/// 割り込み中（電話・Siri 等）は数えない。
private let stalledEngineTimeout: TimeInterval = 5
/// 割り込みの終わりが来ないまま、これだけ経ったら割り込み中とみなすのをやめる（終わりの知らせが来ないことがある）。
private let maximumInterruptionWait: TimeInterval = 60

/**
 * ユーザーが開始した音声通知の間だけ iOS の playback audio session を持ち、
 * PCから届いたMP3（流れ・1本まるごと）を始まった順に鳴らす。マイクは一切使わず、出力はスピーカー。
 * ロック画面には停止操作だけを出す。
 */
public class ParaVoiceSessionModule: Module {
	private var stopTarget: Any?
	private var pauseTarget: Any?
	private var sessionActive = false
	private var observers: [NSObjectProtocol] = []
	private let keepAlive = ParaVoiceKeepAlive()
	private let player = ParaVoiceStreamPlayer()

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

		// 以下は届いた順に再生の列へ渡すため、同期の関数にする（デコードは再生の列の中で行う）。
		Function("enqueueClip") { (base64: String, gainDb: Double) in
			self.player.enqueueClip(base64: base64, gainDb: Float(gainDb))
		}

		Function("streamStart") { (streamId: String, gainDb: Double) in
			self.player.streamStart(id: streamId, gainDb: Float(gainDb))
		}

		Function("streamChunk") { (streamId: String, base64: String) in
			self.player.streamChunk(id: streamId, base64: base64)
		}

		Function("streamEnd") { (streamId: String, aborted: Bool) in
			self.player.streamEnd(id: streamId, aborted: aborted)
		}

		// 開発ビルドの確かめ用（溜めの閾値・途切れた回数など）。
		Function("playbackStats") { () -> [String: Any] in
			self.player.stats()
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
		keepAlive.start()
		player.activate()
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
		// 再生の列で止め終えてからセッションを手放す（列の中のエンジンがまだ動いていると setActive(false) が失敗する）
		player.stopAllAndWait()
		keepAlive.stop()
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
			MPMediaItemPropertyTitle: "Para Code",
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
	 * 再生のエンジン（AVAudioEngine）も、割り込み・出力先の変更で止まっていたら起こし直す。
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
				// 割り込みが始まった。終わるまでエンジンを作り直さず、鳴らしかけの発話も捨てずに待つ
				self.player.setInterrupted(true)
				return
			}
			self.player.setInterrupted(false)
			self.resumeSession()
		})
		observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
			guard let self, self.sessionActive else {
				return
			}
			// メディアサービス再起動後は、セッションもプレイヤーも作り直すしかない。
			self.player.stopAllAndWait()
			self.keepAlive.stop()
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
			self.player.reviveEngineIfStopped()
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
		keepAlive.start()
		player.reviveEngineIfStopped()
		refreshNowPlaying()
	}

	private func restoreCategoryIfNeeded() {
		let session = AVAudioSession.sharedInstance()
		if session.category != .playback {
			try? session.setCategory(.playback, mode: .spokenAudio, options: [])
			try? session.setActive(true)
		}
		keepAlive.start()
	}
}

/// バックグラウンドで停止されないための無音ループ。
private final class ParaVoiceKeepAlive {
	private var player: AVAudioPlayer?

	func start() {
		if player?.isPlaying == true {
			return
		}
		guard let player = try? AVAudioPlayer(data: ParaVoiceKeepAlive.silence()) else {
			return
		}
		player.numberOfLoops = -1
		player.volume = 0
		player.prepareToPlay()
		player.play()
		self.player = player
	}

	func stop() {
		player?.stop()
		player = nil
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

/// 1 回の発話（流れか、1 本まるごと）。
private final class ParaVoiceUtterance {
	let id: String
	let isStream: Bool
	let gainDb: Float
	/// まだデコーダへ渡していない MP3。
	var raw: [Data] = []
	/// 受け取った MP3 の合計（滞留の上限の計算に使う）。
	var bytes = 0
	var ended = false
	var started = false
	var underran = false
	var lastChunkAt: TimeInterval
	let createdAt: TimeInterval

	init(id: String, isStream: Bool, gainDb: Float, now: TimeInterval) {
		self.id = id
		self.isStream = isStream
		self.gainDb = gainDb
		self.lastChunkAt = now
		self.createdAt = now
	}
}

/// 音量の補正を掛けて、-1dBFS で頭打ちにする（瞬時に下げ、約 100ms で戻す）。
private struct ParaPeakLimiter {
	private var envelope: Float = 1
	private let release: Float

	init(sampleRate: Double) {
		release = Float(1 - exp(-1 / (0.1 * sampleRate)))
	}

	mutating func process(_ buffer: AVAudioPCMBuffer, gain: Float) {
		guard let channels = buffer.floatChannelData else {
			return
		}
		let frames = Int(buffer.frameLength)
		let count = Int(buffer.format.channelCount)
		for frame in 0..<frames {
			var peak: Float = 0
			for channel in 0..<count {
				peak = max(peak, abs(channels[channel][frame] * gain))
			}
			let target: Float = peak > limiterCeiling ? limiterCeiling / peak : 1
			if target < envelope {
				envelope = target
			} else {
				envelope += (target - envelope) * release
			}
			let applied = gain * envelope
			for channel in 0..<count {
				channels[channel][frame] = max(-limiterCeiling, min(limiterCeiling, channels[channel][frame] * applied))
			}
		}
	}
}

private let paraPropertyListener: AudioFileStream_PropertyListenerProc = { clientData, stream, propertyId, _ in
	guard propertyId == kAudioFileStreamProperty_ReadyToProducePackets else {
		return
	}
	let decoder = Unmanaged<ParaMp3Decoder>.fromOpaque(clientData).takeUnretainedValue()
	var format = AudioStreamBasicDescription()
	var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
	guard AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &format) == noErr else {
		decoder.markFailed()
		return
	}
	decoder.createConverter(source: format)
}

private let paraPacketsCallback: AudioFileStream_PacketsProc = { clientData, numberBytes, numberPackets, inputData, packetDescriptions in
	let decoder = Unmanaged<ParaMp3Decoder>.fromOpaque(clientData).takeUnretainedValue()
	let descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>? = packetDescriptions
	decoder.receivePackets(byteCount: numberBytes, packetCount: numberPackets, data: inputData, descriptions: descriptions)
}

private let paraConverterInput: AudioConverterComplexInputDataProc = { _, ioNumberDataPackets, ioData, outDescriptions, userData in
	guard let userData else {
		ioNumberDataPackets.pointee = 0
		return paraNoDataStatus
	}
	let decoder = Unmanaged<ParaMp3Decoder>.fromOpaque(userData).takeUnretainedValue()
	return decoder.supplyPacket(ioNumberDataPackets: ioNumberDataPackets, ioData: ioData, outDescriptions: outDescriptions)
}

/**
 * MP3 を届いた順に区切り（AudioFileStream）、PCM にする（AudioConverter）。1 発話を 1 つのデコーダで最後まで
 * 通すので、運ぶときの区切りで継ぎ目は出ない。どの呼び出しも再生の列（1 本のスレッド）から行う。
 */
private final class ParaMp3Decoder {
	private var fileStream: AudioFileStreamID?
	private var converter: AudioConverterRef?
	private var sourceFormat = AudioStreamBasicDescription()
	private let outputFormat: AVAudioFormat
	private var packets: [(data: Data, description: AudioStreamPacketDescription)] = []
	private var packetIndex = 0
	private var packetBuffer: UnsafeMutableRawPointer?
	private var packetBufferCapacity = 0
	private let packetDescription = UnsafeMutablePointer<AudioStreamPacketDescription>.allocate(capacity: 1)
	private var endOfInput = false
	private let onOutput: (AVAudioPCMBuffer) -> Void
	private(set) var failed = false
	/// 入力の終わりを受け、出せる PCM を出し切った。
	private(set) var drained = false

	init(outputFormat: AVAudioFormat, onOutput: @escaping (AVAudioPCMBuffer) -> Void) {
		self.outputFormat = outputFormat
		self.onOutput = onOutput
		var stream: AudioFileStreamID?
		let status = AudioFileStreamOpen(Unmanaged.passUnretained(self).toOpaque(), paraPropertyListener, paraPacketsCallback, kAudioFileMP3Type, &stream)
		if status == noErr {
			fileStream = stream
		} else {
			failed = true
		}
	}

	deinit {
		if let fileStream {
			AudioFileStreamClose(fileStream)
		}
		if let converter {
			AudioConverterDispose(converter)
		}
		packetBuffer?.deallocate()
		packetDescription.deallocate()
	}

	func markFailed() {
		failed = true
	}

	func feed(_ data: Data) {
		guard let fileStream, !failed, !endOfInput, !data.isEmpty else {
			return
		}
		let status = data.withUnsafeBytes { (pointer: UnsafeRawBufferPointer) -> OSStatus in
			guard let base = pointer.baseAddress else {
				return noErr
			}
			return AudioFileStreamParseBytes(fileStream, UInt32(data.count), base, [])
		}
		if status != noErr {
			// 先頭のゴミなどで区切れない固まりは捨てて続ける（次の同期ビットから読み直す）
			NSLog("[ParaVoice] AudioFileStreamParseBytes failed: \(status)")
		}
		convert()
	}

	/// 入力の終わり。残りを出し切る。
	func finish() {
		guard !endOfInput else {
			return
		}
		endOfInput = true
		convert()
		drained = true
	}

	func createConverter(source: AudioStreamBasicDescription) {
		guard converter == nil else {
			return
		}
		sourceFormat = source
		var newConverter: AudioConverterRef?
		var input = source
		guard AudioConverterNew(&input, outputFormat.streamDescription, &newConverter) == noErr, let newConverter else {
			failed = true
			return
		}
		if source.mChannelsPerFrame > 1 {
			// 声は左右同じなので、左だけを取る（出力はモノラル。ミキサーが両方へ鳴らす）
			var map: [Int32] = [0]
			AudioConverterSetProperty(newConverter, kAudioConverterChannelMap, UInt32(MemoryLayout<Int32>.size * map.count), &map)
		}
		converter = newConverter
	}

	func receivePackets(byteCount: UInt32, packetCount: UInt32, data: UnsafeRawPointer, descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
		guard let descriptions else {
			packets.append((Data(bytes: data, count: Int(byteCount)), AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: byteCount)))
			return
		}
		for index in 0..<Int(packetCount) {
			let description = descriptions[index]
			let start = Int(description.mStartOffset)
			let size = Int(description.mDataByteSize)
			guard size > 0, start + size <= Int(byteCount) else {
				continue
			}
			packets.append((Data(bytes: data.advanced(by: start), count: size), AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: description.mVariableFramesInPacket, mDataByteSize: description.mDataByteSize)))
		}
	}

	func supplyPacket(ioNumberDataPackets: UnsafeMutablePointer<UInt32>, ioData: UnsafeMutablePointer<AudioBufferList>, outDescriptions: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?) -> OSStatus {
		guard packetIndex < packets.count else {
			ioNumberDataPackets.pointee = 0
			return endOfInput ? noErr : paraNoDataStatus
		}
		let packet = packets[packetIndex]
		packetIndex += 1
		let size = packet.data.count
		if packetBufferCapacity < size {
			packetBuffer?.deallocate()
			packetBuffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
			packetBufferCapacity = size
		}
		guard let packetBuffer else {
			ioNumberDataPackets.pointee = 0
			return paraNoDataStatus
		}
		packet.data.copyBytes(to: packetBuffer.assumingMemoryBound(to: UInt8.self), count: size)
		ioData.pointee.mNumberBuffers = 1
		ioData.pointee.mBuffers.mData = packetBuffer
		ioData.pointee.mBuffers.mDataByteSize = UInt32(size)
		ioData.pointee.mBuffers.mNumberChannels = sourceFormat.mChannelsPerFrame
		packetDescription.pointee = packet.description
		outDescriptions?.pointee = packetDescription
		ioNumberDataPackets.pointee = 1
		return noErr
	}

	private func convert() {
		guard let converter, !failed else {
			return
		}
		while true {
			guard let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: decodeFramesPerBuffer) else {
				return
			}
			// mutableAudioBufferList は読むたびに mDataByteSize を frameLength に合わせ直すので、容量いっぱいにしてから
			// 1 回だけ読み、同じポインタを渡す（読み直すと 0 バイトになり、変換が paramErr で失敗する）
			buffer.frameLength = decodeFramesPerBuffer
			let bufferList = buffer.mutableAudioBufferList
			var frames = decodeFramesPerBuffer
			let status = AudioConverterFillComplexBuffer(converter, paraConverterInput, Unmanaged.passUnretained(self).toOpaque(), &frames, bufferList, nil)
			let produced = status == noErr || status == paraNoDataStatus ? frames : 0
			if produced > 0 {
				buffer.frameLength = produced
				onOutput(buffer)
			}
			if status == noErr && produced == decodeFramesPerBuffer {
				continue
			}
			if status != noErr && status != paraNoDataStatus {
				NSLog("[ParaVoice] AudioConverterFillComplexBuffer failed: \(status)")
				failed = true
			}
			break
		}
		if packetIndex > 0 {
			packets.removeFirst(packetIndex)
			packetIndex = 0
		}
	}
}

/**
 * 届いた発話を始まった順に鳴らす（AVAudioEngine の AVAudioPlayerNode）。後から来た流れは溜める。
 * 状態はすべて `queue`（1 本の直列の列）の中だけで触る。
 */
private final class ParaVoiceStreamPlayer {
	private let queue = DispatchQueue(label: "ltd.paradis.para-voice.player")
	private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 1, interleaved: false)!
	private var engine: AVAudioEngine?
	private var node: AVAudioPlayerNode?
	private var engineObserver: NSObjectProtocol?
	private var utterances: [ParaVoiceUtterance] = []
	private var decoder: ParaMp3Decoder?
	private var limiter = ParaPeakLimiter(sampleRate: 44_100)
	private var pending: [AVAudioPCMBuffer] = []
	private var pendingFrames: AVAudioFramePosition = 0
	private var scheduled: [(token: Int, buffer: AVAudioPCMBuffer)] = []
	private var scheduledFrames: AVAudioFramePosition = 0
	/// 鳴らしている最中にエンジンが止まっているのに気付いた時刻。
	private var engineStoppedSince: TimeInterval?
	/// 割り込み（電話・Siri 等）が始まった時刻。終わりの知らせで外す。
	private var interruptedSince: TimeInterval?
	/// エンジンを起こせなかった（割り込み中など）。先頭の発話を捨てずに、起こせるようになるまで待つ。
	private var suspended = false
	private var suspendedSince: TimeInterval?
	private let statsLock = NSLock()
	private var statsCache: [String: Any] = [:]
	private var nextToken = 0
	private var generation = 0
	private var rebuffering = false
	private var prebufferMs = initialPrebufferMs
	private var cleanStreak = 0
	private var timer: DispatchSourceTimer?
	private var nextClipId = 0
	// 確かめ用の数
	private var startedCount = 0
	private var finishedCount = 0
	private var underrunCount = 0
	private var droppedCount = 0
	private var lastStartDelayMs: Double = -1
	private var lastUnderran = false

	private var now: TimeInterval {
		ProcessInfo.processInfo.systemUptime
	}

	func activate() {
		queue.async {
			self.pump()
		}
	}

	func stopAll() {
		queue.async {
			self.stopAllNow()
		}
	}

	/// 止め終えるまで待つ（セッションを手放す前に呼ぶ）。再生の列はメインスレッドを待たないので詰まらない。
	func stopAllAndWait() {
		queue.sync {
			self.stopAllNow()
		}
	}

	private func stopAllNow() {
		utterances.removeAll()
		suspended = false
		suspendedSince = nil
		resetHead()
		teardownEngine()
		timer?.cancel()
		timer = nil
		refreshStats()
	}

	/// 割り込みが始まった・終わった。
	func setInterrupted(_ interrupted: Bool) {
		queue.async {
			self.interruptedSince = interrupted ? (self.interruptedSince ?? self.now) : nil
		}
	}

	/// 割り込み・出力先の変更の後、エンジンが止まっていたら起こし直す。起こせずに待っていた発話も鳴らし直す。
	func reviveEngineIfStopped() {
		queue.async {
			if let engine = self.engine, !engine.isRunning {
				self.rebuildEngine()
			} else if self.suspended {
				self.rebuildEngine()
			}
		}
	}

	/// 割り込み中か（終わりの知らせが来ないまま長く経ったら、割り込み中とはみなさない）。
	private var isInterrupted: Bool {
		guard let since = interruptedSince else {
			return false
		}
		return now - since < maximumInterruptionWait
	}

	func enqueueClip(base64: String, gainDb: Float) {
		queue.async {
			guard let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= maximumClipBytes else {
				return
			}
			self.nextClipId += 1
			let utterance = ParaVoiceUtterance(id: "clip-\(self.nextClipId)", isStream: false, gainDb: gainDb, now: self.now)
			utterance.raw.append(data)
			utterance.bytes = data.count
			utterance.ended = true
			self.utterances.append(utterance)
			self.ensureTimer()
			self.enforceLimits()
			self.pump()
		}
	}

	func streamStart(id: String, gainDb: Float) {
		queue.async {
			guard !self.utterances.contains(where: { $0.id == id }) else {
				return
			}
			self.utterances.append(ParaVoiceUtterance(id: id, isStream: true, gainDb: gainDb, now: self.now))
			self.ensureTimer()
			self.enforceLimits()
			self.pump()
		}
	}

	func streamChunk(id: String, base64: String) {
		queue.async {
			// 知らない（捨てた・終えた）流れの断片は捨てる
			guard let utterance = self.utterances.first(where: { $0.id == id }), !utterance.ended,
				let data = Data(base64Encoded: base64), !data.isEmpty else {
				return
			}
			utterance.bytes += data.count
			utterance.lastChunkAt = self.now
			if utterance.bytes > maximumClipBytes {
				self.endStream(utterance)
				return
			}
			// デコーダへは pump が進み具合に合わせて渡す
			utterance.raw.append(data)
			self.enforceLimits()
			self.pump()
		}
	}

	func streamEnd(id: String, aborted: Bool) {
		queue.async {
			guard let utterance = self.utterances.first(where: { $0.id == id }) else {
				return
			}
			if aborted && !utterance.started {
				// 鳴り始める前に切れた流れは鳴らさない
				self.remove(utterance)
				self.pump()
				return
			}
			// 鳴り始めた後に切れた流れは、届いた分を鳴らし切って終える
			self.endStream(utterance)
		}
	}

	/// 最後に列の中で控えた数を返す（列を待たない。デコード中でも JS を止めない）。
	func stats() -> [String: Any] {
		statsLock.lock()
		defer { statsLock.unlock() }
		return statsCache
	}

	private func refreshStats() {
		let snapshot: [String: Any] = [
			"prebufferMs": prebufferMs,
			"cleanStreak": cleanStreak,
			"queued": utterances.count,
			"playing": utterances.first?.started ?? false,
			"rebuffering": rebuffering,
			"started": startedCount,
			"finished": finishedCount,
			"underruns": underrunCount,
			"dropped": droppedCount,
			"lastStartDelayMs": lastStartDelayMs,
			"lastUnderran": lastUnderran,
			"engineRunning": engine?.isRunning ?? false,
			"decodedMs": Double(pendingFrames + scheduledFrames) / outputFormat.sampleRate * 1000,
		]
		statsLock.lock()
		statsCache = snapshot
		statsLock.unlock()
	}

	// MARK: - 列の中だけで呼ぶ

	private func endStream(_ utterance: ParaVoiceUtterance) {
		utterance.ended = true
		pump()
	}

	private func remove(_ utterance: ParaVoiceUtterance) {
		if utterance === utterances.first {
			resetHead()
		}
		utterances.removeAll { $0 === utterance }
		droppedCount += 1
	}

	/// 溜める上限（発話 8・流れ 5・合計 12MiB）を超えたら、まだ鳴り始めていない一番新しい発話を捨てる。合計は、まだ
	/// デコーダへ渡していない MP3 の残りで数える（デコードし終えた分は手元に残っていない）。
	private func enforceLimits() {
		while true {
			let streams = utterances.filter { $0.isStream }.count
			let bytes = utterances.reduce(0) { total, utterance in total + utterance.raw.reduce(0) { $0 + $1.count } }
			if utterances.count <= maximumQueuedUtterances && streams <= maximumQueuedStreams && bytes <= maximumQueuedBytes {
				return
			}
			let victim = streams > maximumQueuedStreams
				? utterances.last(where: { $0.isStream && !$0.started })
				: utterances.last(where: { !$0.started })
			guard let victim else {
				return
			}
			remove(victim)
			NSLog("[ParaVoice] dropped a queued utterance (utterances \(utterances.count), streams \(streams), bytes \(bytes)); dropped \(droppedCount) so far")
		}
	}

	private func ensureTimer() {
		guard timer == nil else {
			return
		}
		let timer = DispatchSource.makeTimerSource(queue: queue)
		timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
		timer.setEventHandler { [weak self] in
			self?.checkStalledStreams()
		}
		timer.resume()
		self.timer = timer
	}

	/// 最後の断片から 8 秒 end が来ない流れは、届いた分で終える。鳴らしている最中にエンジンが 5 秒止まったままなら
	/// 作り直し、作り直せなければその発話を諦める。
	private func checkStalledStreams() {
		let current = now
		for utterance in utterances where utterance.isStream && !utterance.ended && current - utterance.lastChunkAt > streamEndTimeout {
			endStream(utterance)
		}
		if isInterrupted {
			// 割り込み中は作り直さない（作り直しても起こせない）。終わりの知らせで起こし直す
			engineStoppedSince = nil
			suspendedSince = nil
		} else if suspended {
			// 割り込みでもないのに起こせない。5 秒待って作り直し、それでも駄目ならその発話は諦める
			let since = suspendedSince ?? current
			suspendedSince = since
			if current - since >= stalledEngineTimeout {
				suspendedSince = nil
				rebuildEngine()
				if suspended {
					suspended = false
					finishHead()
				}
			}
		} else if let head = utterances.first, head.started, let engine, !engine.isRunning {
			let since = engineStoppedSince ?? current
			engineStoppedSince = since
			if current - since >= stalledEngineTimeout {
				engineStoppedSince = nil
				rebuildEngine()
				if self.engine?.isRunning != true {
					suspended = false
					finishHead()
				}
			}
		} else {
			engineStoppedSince = nil
		}
		if utterances.isEmpty {
			timer?.cancel()
			timer = nil
		}
		refreshStats()
	}

	private func resetHead() {
		decoder = nil
		pending.removeAll()
		pendingFrames = 0
		rebuffering = false
		engineStoppedSince = nil
		if !scheduled.isEmpty {
			scheduled.removeAll()
			scheduledFrames = 0
			generation += 1
			node?.stop()
		}
	}

	/// デコード済み（未再生）が 10 秒ぶんに満たない間、先頭の MP3 を 64KiB ずつデコーダへ渡す。全部渡して終わりが
	/// 来ていれば、デコーダに残りを出し切らせる。
	private func feedHead(_ head: ParaVoiceUtterance, _ decoder: ParaMp3Decoder) {
		let cap = AVAudioFramePosition(outputFormat.sampleRate * maximumDecodedSeconds)
		while pendingFrames + scheduledFrames < cap, !head.raw.isEmpty, !decoder.failed {
			let data = head.raw.removeFirst()
			if data.count > feedSliceBytes {
				head.raw.insert(Data(data.dropFirst(feedSliceBytes)), at: 0)
				decoder.feed(Data(data.prefix(feedSliceBytes)))
			} else {
				decoder.feed(data)
			}
		}
		if head.raw.isEmpty && head.ended && !decoder.drained {
			decoder.finish()
		}
	}

	private func pump() {
		defer { refreshStats() }
		guard let head = utterances.first else {
			stopEngineWhenIdle()
			return
		}
		if decoder == nil {
			limiter = ParaPeakLimiter(sampleRate: outputFormat.sampleRate)
			let gain = Float(pow(10, Double(head.gainDb) / 20))
			decoder = ParaMp3Decoder(outputFormat: outputFormat) { [weak self] buffer in
				self?.receiveDecoded(buffer, gain: gain)
			}
		}
		guard let decoder else {
			return
		}
		feedHead(head, decoder)
		if suspended {
			// エンジンを起こせるようになるまで、デコード済みの PCM は手元に溜めておく（10 秒ぶんまで）
			return
		}
		let decoderDone = decoder.failed || (head.ended && decoder.drained)
		let bufferedMs = Double(pendingFrames) / outputFormat.sampleRate * 1000
		if !head.started {
			// 1 本まるごとも同じ閾値まで先にデコードしてから鳴らす（全部をデコードし終えるのは待たない）
			let threshold = Double(prebufferMs)
			if pendingFrames > 0 && (decoderDone || bufferedMs >= threshold) {
				startPlayback(head)
			} else if decoderDone && pendingFrames == 0 {
				finishHead()
			}
			return
		}
		if rebuffering {
			// 足りなくなったら、また溜まるまで無音で待つ
			if decoderDone || bufferedMs >= Double(prebufferMs) {
				rebuffering = false
				schedulePending()
			}
		} else {
			schedulePending()
		}
		if decoderDone && pending.isEmpty && scheduled.isEmpty {
			finishHead()
		}
	}

	private func receiveDecoded(_ buffer: AVAudioPCMBuffer, gain: Float) {
		limiter.process(buffer, gain: gain)
		pending.append(buffer)
		pendingFrames += AVAudioFramePosition(buffer.frameLength)
	}

	private func startPlayback(_ head: ParaVoiceUtterance) {
		guard ensureEngine() else {
			// 鳴らせない（割り込み中・セッションを奪われている等）。発話は捨てずに、起こせるようになるまで待つ
			suspend()
			return
		}
		head.started = true
		startedCount += 1
		lastStartDelayMs = (now - head.createdAt) * 1000
		schedulePending()
	}

	private func schedulePending() {
		guard !pending.isEmpty else {
			return
		}
		for buffer in pending {
			schedule(buffer)
		}
		pending.removeAll()
		pendingFrames = 0
	}

	private func schedule(_ buffer: AVAudioPCMBuffer) {
		guard let node else {
			return
		}
		let token = nextToken
		nextToken += 1
		scheduled.append((token, buffer))
		scheduledFrames += AVAudioFramePosition(buffer.frameLength)
		let scheduledGeneration = generation
		node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
			self?.queue.async {
				self?.bufferPlayed(token: token, generation: scheduledGeneration)
			}
		}
	}

	private func bufferPlayed(token: Int, generation playedGeneration: Int) {
		guard playedGeneration == generation else {
			return
		}
		if let index = scheduled.firstIndex(where: { $0.token == token }) {
			scheduledFrames -= AVAudioFramePosition(scheduled[index].buffer.frameLength)
			scheduled.remove(at: index)
		}
		guard scheduled.isEmpty, let head = utterances.first, head.started, let decoder else {
			// まだ鳴らす分が残っている。デコードを先へ進める
			pump()
			return
		}
		let decoderDone = decoder.failed || (head.ended && decoder.drained)
		if decoderDone && pending.isEmpty {
			finishHead()
			return
		}
		if pending.isEmpty && !rebuffering {
			// 足りなくなった
			head.underran = true
			underrunCount += 1
			rebuffering = true
		}
		pump()
	}

	private func finishHead() {
		guard !utterances.isEmpty else {
			return
		}
		let head = utterances.removeFirst()
		resetHead()
		finishedCount += 1
		if head.isStream && head.started {
			lastUnderran = head.underran
			if head.underran {
				prebufferMs = min(maximumPrebufferMs, prebufferMs + prebufferStepMs)
				cleanStreak = 0
			} else {
				cleanStreak += 1
				if cleanStreak >= prebufferRelaxAfter {
					prebufferMs = max(initialPrebufferMs, prebufferMs - prebufferStepMs)
					cleanStreak = 0
				}
			}
		}
		pump()
	}

	private func suspend() {
		if !suspended {
			suspended = true
			suspendedSince = now
		}
		// 止まっているエンジンは捨てる（起こすときに作り直す）
		teardownEngine()
		scheduled.removeAll()
		scheduledFrames = 0
		refreshStats()
	}

	private func ensureEngine() -> Bool {
		if engine == nil {
			buildEngine()
		}
		guard let engine, let node else {
			return false
		}
		if !engine.isRunning {
			do {
				try engine.start()
			} catch {
				NSLog("[ParaVoice] AVAudioEngine.start failed: \(error)")
				return false
			}
		}
		if !node.isPlaying {
			node.play()
		}
		return true
	}

	private func buildEngine() {
		let engine = AVAudioEngine()
		let node = AVAudioPlayerNode()
		engine.attach(node)
		engine.connect(node, to: engine.mainMixerNode, format: outputFormat)
		engine.prepare()
		// 出力先・形式が変わるとエンジンは止まる。起こし直して、ノードを付け直す
		engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self, weak engine] _ in
			self?.queue.async {
				// 作り直した後に古いエンジンの知らせが遅れて届いたら、何もしない（二重に作り直さない）
				guard let self, let engine, engine === self.engine else {
					return
				}
				self.rebuildEngine()
			}
		}
		self.engine = engine
		self.node = node
	}

	private func teardownEngine() {
		if let engineObserver {
			NotificationCenter.default.removeObserver(engineObserver)
			self.engineObserver = nil
		}
		generation += 1
		node?.stop()
		engine?.stop()
		if let engine, let node {
			engine.detach(node)
		}
		node = nil
		engine = nil
	}

	/// エンジンを作り直し、まだ鳴り終わっていない PCM を付け直す（鳴りかけの固まりは頭から鳴り直す）。起こせなければ
	/// PCM を手元に戻して待つ（割り込みの終わり・出力先の変更でもう一度呼ばれる）。
	private func rebuildEngine() {
		guard engine != nil || suspended else {
			return
		}
		let outstanding = scheduled.map { $0.buffer }
		teardownEngine()
		scheduled.removeAll()
		scheduledFrames = 0
		let wasSuspended = suspended
		suspended = false
		suspendedSince = nil
		guard let head = utterances.first, head.started else {
			if wasSuspended {
				// 鳴らし始める前に止まっていた発話。もう一度鳴らし始めを試す
				pump()
			}
			return
		}
		guard ensureEngine() else {
			pending.insert(contentsOf: outstanding, at: 0)
			pendingFrames += outstanding.reduce(AVAudioFramePosition(0)) { $0 + AVAudioFramePosition($1.frameLength) }
			suspend()
			return
		}
		for buffer in outstanding {
			schedule(buffer)
		}
		pump()
	}

	private func stopEngineWhenIdle() {
		guard let engine, engine.isRunning, scheduled.isEmpty else {
			return
		}
		node?.stop()
		engine.stop()
	}
}
