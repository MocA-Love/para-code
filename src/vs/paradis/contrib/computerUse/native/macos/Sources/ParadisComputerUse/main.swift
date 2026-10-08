/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code Computer Use.app の入り口。
//
// shared process が `open -n -g "Para Code Computer Use.app" --args --agent --socket <path> --token-file <path>` で
// 起動する。LaunchServices から起動することで、TCC の許可（アクセシビリティ・画面収録）がこのアプリ自身に付く
// （Para Code 本体の子として exec すると、Para Code の許可で評価されうる。設計書 1.2）。

import AppKit
import Foundation

/** 相手の親として求める Para Code の main の bundle id。ビルド時に Info.plist へ書く。 */
private func paradisMainBundleIdentifier() -> String {
	return (Bundle.main.object(forInfoDictionaryKey: "ParadisMainBundleIdentifier") as? String) ?? "ltd.paradis.paracode"
}

/** Para Code のデータのフォルダの名前（argv.json の場所）。ビルド時に Info.plist へ書く。 */
private func paradisDataFolderName() -> String {
	return (Bundle.main.object(forInfoDictionaryKey: "ParadisDataFolderName") as? String) ?? ".para-code"
}

private final class ParadisAgentDelegate: NSObject, NSApplicationDelegate {
	private let server: ParadisAgentServer
	private let desktop: ParadisDesktop
	private var terminationSource: DispatchSourceSignal?

	init(server: ParadisAgentServer, desktop: ParadisDesktop) {
		self.server = server
		self.desktop = desktop
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		// 締め切りで終わらされるときも、押したままのボタンとキーを離してから終わる（レビュー N5）
		signal(SIGTERM, SIG_IGN)
		let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
		source.setEventHandler {
			paradisPressedInput.releaseAll()
			exit(0)
		}
		source.resume()
		terminationSource = source
		// 許可があれば、最初の入力の命令の前から見張る（直前の利用者の入力を見逃さない。レビュー N6）
		desktop.inputMonitor.ensureStarted()
		let server = self.server
		let thread = Thread {
			server.run()
		}
		thread.name = "paradis-computer-use-agent"
		thread.start()
	}
}

switch paradisParseArguments(Array(CommandLine.arguments.dropFirst())) {
case .agent(let socketPath, let tokenFile, let stateDirectory):
	guard let token = paradisConsumeTokenFile(tokenFile) else {
		paradisExit(.badArguments, "token file is missing or malformed")
	}
	let desktop = ParadisDesktop()
	// 前の起動がクラッシュ・SIGKILL で戻せなかった AXManualAccessibility を戻し、以後の記録の置き場所を決める
	paradisManualAccessibility.configure(stateDirectory: stateDirectory)
	// どの終わり方（shutdown・切断・締め切りの SIGTERM）でも、立てた AXManualAccessibility を戻す
	atexit {
		paradisManualAccessibility.restoreAll()
	}
	let handler = ParadisRequestHandler(backend: desktop, expectedToken: token, selfPid: getpid())
	let server = ParadisAgentServer(socketPath: socketPath, handler: handler, helperIdentity: paradisSelfSigningIdentity(), mainBundleIdentifier: paradisMainBundleIdentifier(), dataFolderName: paradisDataFolderName())
	let application = NSApplication.shared
	application.setActivationPolicy(.accessory)
	let delegate = ParadisAgentDelegate(server: server, desktop: desktop)
	application.delegate = delegate
	application.run()
case .permissionStatus:
	let desktop = ParadisDesktop()
	let (responsibility, responsiblePid) = desktop.responsibility()
	var result = desktop.permissions().json
	result["responsibility"] = responsibility.rawValue
	if let responsiblePid {
		result["responsiblePid"] = Int(responsiblePid)
	}
	if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
		print(text)
	}
	exit(0)
case .usage:
	paradisExit(.usage, "Para Code Computer Use is started by Para Code. It cannot be used on its own.")
}
