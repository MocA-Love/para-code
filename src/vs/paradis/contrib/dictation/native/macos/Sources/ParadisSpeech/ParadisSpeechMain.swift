/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code speech helper: on-device speech recognition for Para Code's dictation, using Apple's
// SpeechAnalyzer on macOS 26 and later.
//
//   ParadisSpeech transcribe --locale <BCP 47 | auto>
//   ParadisSpeech check [--locale <BCP 47 | auto>]
//
// transcribe reads little-endian 16-bit mono 16 kHz PCM from stdin until EOF and writes one JSON object per
// line to stdout (the contract is in src/vs/paradis/contrib/dictation/common/paradisSpeechEngine.ts). It exits
// after the final text. SIGTERM cancels. The helper never opens the microphone: Para Code captures the audio in
// its renderer and pipes it here.
//
// check prints one JSON line describing what this Mac supports (for manual verification) and exits.
//
// The deployment target stays at macOS 14 so that the helper still starts on older systems and reports
// "unsupported" instead of failing to load; everything that needs macOS 26 is behind #available.

import Foundation

/// Serializes the JSON lines written to stdout (the stdin reader thread and the analyzer tasks both write).
final class ParadisSpeechOutput: @unchecked Sendable {
	static let shared = ParadisSpeechOutput()

	private let lock = NSLock()

	func send(_ object: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
			return
		}
		lock.lock()
		defer { lock.unlock() }
		// The parent may already be gone (cancelled); a failed write must not crash the helper.
		try? FileHandle.standardOutput.write(contentsOf: data + Data([0x0A]))
	}

	func error(_ code: String, _ message: String) {
		send(["type": "error", "code": code, "message": message])
	}
}

/// The locale to use for "auto": the first of the user's preferred languages.
func paradisRequestedLocale(_ identifier: String) -> String {
	if identifier.isEmpty || identifier.lowercased() == "auto" {
		return Locale.preferredLanguages.first ?? Locale.current.identifier
	}
	return identifier
}

@main
struct ParadisSpeechMain {
	static func main() async {
		// Writing to a closed stdout must return an error, not kill the process.
		signal(SIGPIPE, SIG_IGN)
		let arguments = Array(CommandLine.arguments.dropFirst())
		let command = arguments.first ?? ""
		var locale = "auto"
		if let index = arguments.firstIndex(of: "--locale"), index + 1 < arguments.count {
			locale = arguments[index + 1]
		}
		guard command == "transcribe" || command == "check" else {
			try? FileHandle.standardError.write(contentsOf: Data("usage: ParadisSpeech transcribe|check [--locale <BCP 47 | auto>]\n".utf8))
			exit(2)
		}
		guard #available(macOS 26.0, *) else {
			ParadisSpeechOutput.shared.error("unsupported", "macOS 26 or later is required")
			exit(3)
		}
		if command == "check" {
			exit(await ParadisSpeechTranscription.check(locale: paradisRequestedLocale(locale)))
		}
		exit(await ParadisSpeechTranscription.run(locale: paradisRequestedLocale(locale)))
	}
}
