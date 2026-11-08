/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SpeechAnalyzer session for the Para Code speech helper. The transcriber choice, the locale matching, the
// asset reservation and the audio conversion follow Orca's iOS on-device dictation (MIT, see
// ../../THIRD_PARTY_NOTICES.md).

import AVFoundation
import Foundation
import Speech

enum ParadisSpeechFailure: Error {
	case locale(String)
	case unsupported(String)
	case assets(String)
	case audio(String)

	var code: String {
		switch self {
		case .locale: "locale"
		case .unsupported: "unsupported"
		case .assets: "assets"
		case .audio: "audio"
		}
	}

	var message: String {
		switch self {
		case .locale(let message), .unsupported(let message), .assets(let message), .audio(let message): message
		}
	}
}

/// SpeechTranscriber where the hardware runs it; elsewhere the dictation model (DictationTranscriber).
@available(macOS 26.0, *)
enum ParadisTranscriber {
	case speech(SpeechTranscriber)
	case dictation(DictationTranscriber)

	init(locale: Locale) {
		if SpeechTranscriber.isAvailable {
			self = .speech(SpeechTranscriber(locale: locale, preset: .progressiveTranscription))
		} else {
			self = .dictation(DictationTranscriber(locale: locale, preset: .progressiveLongDictation))
		}
	}

	var kind: String {
		switch self {
		case .speech: "speech"
		case .dictation: "dictation"
		}
	}

	var module: any SpeechModule {
		switch self {
		case .speech(let transcriber): transcriber
		case .dictation(let transcriber): transcriber
		}
	}

	/// nil when this language can't be transcribed on device. Picks deterministically: supportedLocale(equivalentTo:)
	/// can answer a different region on each call.
	static func supportedLocale(for identifier: String) async -> Locale? {
		let requested = Locale(identifier: identifier)
		let language = maximal(requested)
		let supported = SpeechTranscriber.isAvailable
			? await SpeechTranscriber.supportedLocales
			: await DictationTranscriber.supportedLocales
		let sameLanguage = supported.filter { sameLanguageAndScript(maximal($0), language) }
			.sorted { $0.identifier(.bcp47) < $1.identifier(.bcp47) }
		// The requested region, then the regions of the user's own languages and of the Mac, then the language's usual one.
		let preferredRegions = Locale.preferredLanguages.map(Locale.init(identifier:))
			.filter { sameLanguageAndScript(maximal($0), language) }
			.map(\.region)
		let regions = [requested.region] + preferredRegions + [Locale.current.region, language.region]
		for region in regions.compactMap({ $0 }) {
			if let match = sameLanguage.first(where: { $0.region == region }) {
				return match
			}
		}
		return sameLanguage.first
	}

	/// Fills in the likely script and region, so "zh-TW" compares as Hant and "ja" carries JP.
	private static func maximal(_ locale: Locale) -> Locale.Language {
		Locale.Language(identifier: locale.language.maximalIdentifier)
	}

	private static func sameLanguageAndScript(_ a: Locale.Language, _ b: Locale.Language) -> Bool {
		a.languageCode == b.languageCode && a.script == b.script
	}

	/// Collects results until the analyzer finishes; resolves with every finalized segment.
	func collect(onText: @escaping @Sendable (_ committed: String, _ tentative: String) -> Void) -> Task<String, Error> {
		switch self {
		case .speech(let transcriber):
			Self.collect(transcriber.results, text: { $0.text }, onText: onText)
		case .dictation(let transcriber):
			Self.collect(transcriber.results, text: { $0.text }, onText: onText)
		}
	}

	private static func collect<Results: AsyncSequence & Sendable>(
		_ results: Results,
		text: @escaping @Sendable (Results.Element) -> AttributedString,
		onText: @escaping @Sendable (String, String) -> Void
	) -> Task<String, Error> where Results.Element: SpeechModuleResult {
		Task {
			var committed = ""
			for try await result in results {
				let words = String(text(result).characters)
				if result.isFinal {
					committed += words
					onText(committed, "")
				} else {
					onText(committed, words)
				}
			}
			return committed
		}
	}
}

/// Language assets (downloaded and kept by the system) for the transcriber.
@available(macOS 26.0, *)
enum ParadisSpeechAssets {
	static func describe(_ status: AssetInventory.Status) -> String {
		switch status {
		case .unsupported: "unsupported"
		case .supported: "supported"
		case .downloading: "downloading"
		case .installed: "installed"
		@unknown default: "unknown"
		}
	}

	/// Makes sure the assets for `locale` are installed, downloading them when needed.
	static func prepare(_ module: any SpeechModule, locale: Locale, onProgress: @escaping @Sendable (Double) -> Void) async throws {
		let status = await AssetInventory.status(forModules: [module])
		if status == .unsupported {
			throw ParadisSpeechFailure.unsupported("the speech assets for \(locale.identifier(.bcp47)) are not supported on this Mac")
		}
		if status != .installed {
			do {
				try await reserve(locale)
				// A nil request means the assets are already installed.
				if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
					let observation = request.progress.observe(\.fractionCompleted, options: [.initial, .new]) { progress, _ in
						onProgress(progress.fractionCompleted)
					}
					defer { observation.invalidate() }
					try await request.downloadAndInstall()
				}
			} catch {
				throw ParadisSpeechFailure.assets(String(describing: error))
			}
		}
		// Installed assets without any audio format the analyzer can run them with are as good as missing.
		if await module.availableCompatibleAudioFormats.isEmpty {
			throw ParadisSpeechFailure.unsupported("no audio format can run the speech model on this Mac")
		}
	}

	/// The system only downloads, and keeps, assets for locales the app has reserved, up to a per-app limit.
	private static func reserve(_ locale: Locale) async throws {
		let reserved = await AssetInventory.reservedLocales
		if reserved.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
			return
		}
		// At the limit, give up another reservation rather than fail this download, a variant of this language first.
		if reserved.count >= AssetInventory.maximumReservedLocales,
			let other = reserved.first(where: { $0.language.languageCode == locale.language.languageCode }) ?? reserved.first {
			await AssetInventory.release(reservedLocale: other)
		}
		try await AssetInventory.reserve(locale: locale)
	}
}

/// Reads PCM from stdin on its own thread, so audio sent while the assets download waits in the stream.
enum ParadisStandardInput {
	static func start(format: AVAudioFormat, into input: AsyncStream<AVAudioPCMBuffer>.Continuation) {
		let thread = Thread {
			var pending = Data()
			var chunk = [UInt8](repeating: 0, count: 16_384)
			while true {
				let count = read(STDIN_FILENO, &chunk, chunk.count)
				if count < 0 && errno == EINTR {
					continue
				}
				if count <= 0 {
					break
				}
				pending.append(contentsOf: chunk[0..<count])
				// A read can split a sample; keep the odd byte for the next one.
				let usable = pending.count - pending.count % 2
				if usable > 0 {
					if let buffer = makeBuffer(pending.prefix(usable), format: format) {
						input.yield(buffer)
					}
					pending.removeFirst(usable)
				}
			}
			input.finish()
		}
		thread.start()
	}

	private static func makeBuffer(_ pcm: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
		let frames = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
		guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
			let samples = buffer.int16ChannelData?[0]
		else {
			return nil
		}
		buffer.frameLength = frames
		_ = pcm.copyBytes(to: UnsafeMutableBufferPointer(start: samples, count: Int(frames)))
		return buffer
	}
}

@available(macOS 26.0, *)
enum ParadisSpeechTranscription {
	/// One dictation: PCM on stdin, JSON lines on stdout. Returns the exit code.
	static func run(locale identifier: String) async -> Int32 {
		let output = ParadisSpeechOutput.shared
		guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false) else {
			output.error("audio", "could not describe the input audio format")
			return 1
		}
		// Unbounded so audio fed while the model loads waits here instead of being dropped.
		let (audio, audioInput) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
		ParadisStandardInput.start(format: inputFormat, into: audioInput)
		do {
			guard let locale = await ParadisTranscriber.supportedLocale(for: identifier) else {
				throw ParadisSpeechFailure.locale("on-device speech recognition does not support \(identifier)")
			}
			let transcriber = ParadisTranscriber(locale: locale)
			try await ParadisSpeechAssets.prepare(transcriber.module, locale: locale) { progress in
				output.send(["type": "status", "state": "downloading", "progress": progress])
			}
			output.send(["type": "ready", "locale": locale.identifier(.bcp47), "transcriber": transcriber.kind])
			let text = try await transcribe(audio, transcriber: transcriber, inputFormat: inputFormat) { committed, tentative in
				output.send(["type": "text", "committed": committed, "tentative": tentative])
			}
			output.send(["type": "final", "text": text])
			return 0
		} catch let failure as ParadisSpeechFailure {
			output.error(failure.code, failure.message)
			return 1
		} catch {
			output.error("failed", String(describing: error))
			return 1
		}
	}

	/// Describes what this Mac supports, for manual verification.
	static func check(locale identifier: String) async -> Int32 {
		var info: [String: Any] = [
			"type": "check",
			"os": ProcessInfo.processInfo.operatingSystemVersionString,
			"speechTranscriberAvailable": SpeechTranscriber.isAvailable,
			"requestedLocale": identifier,
		]
		if let locale = await ParadisTranscriber.supportedLocale(for: identifier) {
			let transcriber = ParadisTranscriber(locale: locale)
			info["locale"] = locale.identifier(.bcp47)
			info["transcriber"] = transcriber.kind
			info["assets"] = ParadisSpeechAssets.describe(await AssetInventory.status(forModules: [transcriber.module]))
			info["reservedLocales"] = await AssetInventory.reservedLocales.map { $0.identifier(.bcp47) }
		}
		ParadisSpeechOutput.shared.send(info)
		return 0
	}

	private static func transcribe(
		_ stream: AsyncStream<AVAudioPCMBuffer>,
		transcriber: ParadisTranscriber,
		inputFormat: AVAudioFormat,
		onText: @escaping @Sendable (String, String) -> Void
	) async throws -> String {
		guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber.module], considering: inputFormat) else {
			throw ParadisSpeechFailure.audio("no audio format is compatible with the speech model")
		}
		// Convert only when the analyzer wants something other than the fed format.
		var converter: AVAudioConverter?
		if analyzerFormat != inputFormat {
			guard let resampler = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
				throw ParadisSpeechFailure.audio("could not convert the audio for the speech model")
			}
			// Keep every input frame; the default priming drops the start of each converted buffer.
			resampler.primeMethod = .none
			converter = resampler
		}

		let collector = transcriber.collect(onText: onText)
		let (analyzerStream, analyzerInput) = AsyncStream.makeStream(of: AnalyzerInput.self)
		let analyzer = SpeechAnalyzer(modules: [transcriber.module])
		do {
			try await analyzer.start(inputSequence: analyzerStream)
			for await buffer in stream {
				let ready = if let converter { convert(buffer, with: converter) } else { Optional(buffer) }
				if let ready {
					analyzerInput.yield(AnalyzerInput(buffer: ready))
				}
			}
			analyzerInput.finish()
			try await analyzer.finalizeAndFinishThroughEndOfInput()
			// Results arrive asynchronously; returning before the collector drains loses the last words.
			return try await collector.value
		} catch {
			analyzerInput.finish()
			await analyzer.cancelAndFinishNow()
			collector.cancel()
			_ = try? await collector.value
			throw error
		}
	}

	private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
		let ratio = converter.outputFormat.sampleRate / buffer.format.sampleRate
		let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
		guard capacity > 0, let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else {
			return nil
		}
		var consumed = false
		var error: NSError?
		let status = converter.convert(to: output, error: &error) { _, inputStatus in
			if consumed {
				inputStatus.pointee = .noDataNow
				return nil
			}
			consumed = true
			inputStatus.pointee = .haveData
			return buffer
		}
		guard status != .error, output.frameLength > 0 else {
			return nil
		}
		return output
	}
}
