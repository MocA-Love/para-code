/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 補助アプリへつないできた相手を受け入れるかの判断（設計書 6.1、レビュー H1）。
//
// 補助アプリは TCC の許可を持つので、命令できる者はアプリごとの承認を飛ばせる。受け入れるのは
// Para Code の shared process そのものだけにする。拡張機能ホスト・pty host・renderer など、main の子の
// ほかのプロセスは断る（ペインのエージェントは `--extensionDevelopmentPath` などで拡張機能ホストに
// 自分のコードを載せられるため）。main が inspect / remote-debugging 系の引数や NODE_OPTIONS 付きで
// 起動されていても断る（パッケージ版の fuses は EnableNodeCliInspectArguments と
// EnableNodeOptionsEnvironmentVariable が有効のまま。NOTES.md 参照）。
//
// shared process の見分け方: upstream の UtilityProcess（utilityProcess.ts の createEnv）は、子の環境変数の
// `VSCODE_ESM_ENTRYPOINT` と `VSCODE_CRASH_REPORTER_PROCESS_TYPE` を、渡された環境の上から必ず書く。
// 拡張機能ホストへ利用者が渡す環境（`--extensionEnvironment`）でも上書きできない。
//
// 残る穴: 同じユーザーのプロセスが Para Code の shared process 自体の中でコードを動かせる場合は防げない
// （Para Code 自体が乗っ取られた状態と同じ）。

import Foundation

/** コード署名から読んだもの。署名が無い・壊れているときは作らない（nil で表す）。 */
struct ParadisSigningIdentity: Equatable {
	let identifier: String?
	let teamIdentifier: String?
}

/** `KERN_PROCARGS2` から読んだ、起動時の引数と環境変数。 */
struct ParadisProcessArguments: Equatable {
	let executablePath: String
	let arguments: [String]
	let environment: [String]

	/** 同じ名前が 2 つ以上あれば nil（どちらが効くか分からないので、無いのと同じには扱わない）。 */
	func environmentValue(_ name: String) -> String?? {
		let prefix = name + "="
		let matches = environment.filter { $0.hasPrefix(prefix) }
		if matches.count > 1 {
			return .some(nil)
		}
		return matches.first.map { .some(String($0.dropFirst(prefix.count))) } ?? .none
	}

	func hasEnvironment(_ name: String) -> Bool {
		return environment.contains { $0.hasPrefix(name + "=") }
	}
}

/**
 * `sysctl(KERN_PROCARGS2)` の中身を読む。形は「argc（4 バイト）・実行ファイルのパス・NUL の詰め物・
 * argv を NUL 区切りで argc 個・環境変数を NUL 区切りで空の文字列まで」。
 */
func paradisParseProcessArguments(_ bytes: [UInt8]) -> ParadisProcessArguments? {
	guard bytes.count >= 4 else {
		return nil
	}
	let argc = Int(bytes[0]) | Int(bytes[1]) << 8 | Int(bytes[2]) << 16 | Int(bytes[3]) << 24
	guard argc >= 0, argc < 4_096 else {
		return nil
	}
	var index = 4
	func readString() -> String? {
		guard index < bytes.count else {
			return nil
		}
		let start = index
		while index < bytes.count && bytes[index] != 0 {
			index += 1
		}
		let value = String(decoding: bytes[start..<index], as: UTF8.self)
		index += 1
		return value
	}
	guard let executablePath = readString() else {
		return nil
	}
	while index < bytes.count && bytes[index] == 0 {
		index += 1
	}
	var arguments: [String] = []
	for _ in 0..<argc {
		guard let argument = readString() else {
			return nil
		}
		arguments.append(argument)
	}
	var environment: [String] = []
	while let entry = readString(), !entry.isEmpty {
		environment.append(entry)
	}
	return ParadisProcessArguments(executablePath: executablePath, arguments: arguments, environment: environment)
}

/** 判断に使う事実。 */
struct ParadisPeerFacts {
	/** 補助アプリ自身の署名。チーム ID があればリリース、無ければ ad-hoc の開発用。 */
	let helper: ParadisSigningIdentity
	/** 相手の署名（チーム ID の要件を満たして検証できたときだけ）。 */
	let peer: ParadisSigningIdentity?
	/** 相手の親の署名（同上）。 */
	let parent: ParadisSigningIdentity?
	/** 相手の実行ファイルを含む .app の bundle id（開発用の判断に使う）。 */
	let peerBundleIdentifier: String?
	/** 相手の親の実行ファイルを含む .app の bundle id（同上）。 */
	let parentBundleIdentifier: String?
	let peerArguments: ParadisProcessArguments?
	let parentArguments: ParadisProcessArguments?
	/** 相手の親の、さらに親の pid。 */
	let parentParentPid: Int32?
	/** 相手が同じユーザーで動いているか。 */
	let sameUser: Bool
}

enum ParadisPeerDecision: Equatable {
	case allow
	case deny(String)
}

/** shared process の入り口（upstream の sharedProcess.ts の `entryPoint`）。 */
let paradisSharedProcessEntryPoint = "vs/code/electron-utility/sharedProcess/sharedProcessMain"
/** shared process の種類（upstream の sharedProcess.ts の `type`）。 */
let paradisSharedProcessType = "shared-process"

/** 相手とその main に付いていたら断る引数の頭。どれも外からコードを動かすか、状態を覗く口になる。 */
let paradisForbiddenArgumentPrefixes = [
	"--inspect", "--debug", "--remote-debugging", "--js-flags", "--extensionDevelopmentPath", "--extensionTestsPath",
	"--enable-proposed-api", "--remote-allow-origins",
]

/** 相手とその main に付いていたら断る環境変数。 */
let paradisForbiddenEnvironment = ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VSCODE_NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]

/**
 * 相手を受け入れるか。
 *
 * どちらのビルドでも: 相手は Para Code の helper（`<main>.helper` そのもの。Plugin・Renderer・GPU の helper は断る）で、
 * `--type=utility`、環境変数が shared process の入り口と種類を指すこと。親は Para Code の main。相手と main に
 * inspect / remote-debugging 系の引数や NODE_OPTIONS・ELECTRON_RUN_AS_NODE が無いこと。
 * リリース（補助アプリにチーム ID がある）では、さらに相手と親が同じチームで署名され、親の親が launchd（pid 1）であること。
 * 開発（ad-hoc）では署名の検証と親の親の確認だけを飛ばし、識別子は .app の bundle id で見る。
 */
func paradisDecidePeer(_ facts: ParadisPeerFacts, mainBundleIdentifier: String) -> ParadisPeerDecision {
	guard facts.sameUser else {
		return .deny("peer runs as another user")
	}
	let helperIdentifier = mainBundleIdentifier + ".helper"
	let release = !(facts.helper.teamIdentifier ?? "").isEmpty
	if release {
		let team = facts.helper.teamIdentifier!
		guard let peer = facts.peer, peer.teamIdentifier == team else {
			return .deny("peer is not signed by this team")
		}
		guard peer.identifier == helperIdentifier else {
			return .deny("peer is not the Para Code helper process")
		}
		guard let parent = facts.parent, parent.teamIdentifier == team, parent.identifier == mainBundleIdentifier else {
			return .deny("peer parent is not the Para Code main process")
		}
		guard facts.parentParentPid == 1 else {
			return .deny("Para Code main process was not started by launchd")
		}
	} else {
		guard facts.peerBundleIdentifier == helperIdentifier else {
			return .deny("peer is not the Para Code helper process")
		}
		guard facts.parentBundleIdentifier == mainBundleIdentifier else {
			return .deny("peer parent is not Para Code")
		}
	}
	guard let peerArguments = facts.peerArguments, let parentArguments = facts.parentArguments else {
		return .deny("the arguments of the peer or its parent could not be read")
	}
	guard peerArguments.arguments.contains("--type=utility") else {
		return .deny("peer is not a utility process")
	}
	guard peerArguments.environmentValue("VSCODE_ESM_ENTRYPOINT") == .some(paradisSharedProcessEntryPoint),
		peerArguments.environmentValue("VSCODE_CRASH_REPORTER_PROCESS_TYPE") == .some(paradisSharedProcessType)
	else {
		return .deny("peer is not the shared process")
	}
	for (label, process) in [("peer", peerArguments), ("Para Code main process", parentArguments)] {
		if let argument = process.arguments.first(where: { argument in paradisForbiddenArgumentPrefixes.contains { argument.hasPrefix($0) } }) {
			return .deny("\(label) was started with \(argument.split(separator: "=").first ?? "")")
		}
		if let name = paradisForbiddenEnvironment.first(where: { process.hasEnvironment($0) }) {
			return .deny("\(label) was started with \(name)")
		}
	}
	return .allow
}

// MARK: - responsible process

/**
 * TCC の許可をどのプロセスで評価されるか（設計書 5.1）。
 * `responsibility_get_pid_responsible_for_pid` は非公開 API なので、見つからなければ unknown として確認を飛ばす。
 */
enum ParadisResponsibility: String {
	case selfProcess = "self"
	case other = "other"
	case unknown = "unknown"
}

func paradisClassifyResponsibility(selfPid: Int32, responsiblePid: Int32?) -> ParadisResponsibility {
	guard let responsiblePid, responsiblePid > 0 else {
		return .unknown
	}
	return responsiblePid == selfPid ? .selfProcess : .other
}
