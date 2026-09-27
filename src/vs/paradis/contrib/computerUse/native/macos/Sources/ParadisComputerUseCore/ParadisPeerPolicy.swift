/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 補助アプリへつないできた相手を受け入れるかの判断（設計書 6.1）。
//
// 補助アプリは TCC の許可を持つので、命令できる者はアプリごとの承認を飛ばせる。同じユーザーの
// エージェントが補助アプリを自分で起動して自分のソケットにつなぐ迂回を塞ぐため、相手のコード署名と、
// 相手の親が Para Code の main であることを確かめる。ここは判断だけで、事実を集めるのは main.swift 側。
//
// 残る穴（受け入れる）: `ELECTRON_RUN_AS_NODE=1` で Para Code の実行ファイルを動かすと、同じ署名の
// プロセスを作れる。親が main でなければ止まるが、main の子である拡張機能ホストの拡張機能は通り得る。
// 拡張機能はもともと利用者の権限で何でもできる前提なので、ここでは防がない。

import Foundation

/** コード署名から読んだもの。署名が無い・壊れているときは作らない（nil で表す）。 */
struct ParadisSigningIdentity: Equatable {
	let identifier: String?
	let teamIdentifier: String?
}

/** 判断に使う事実。 */
struct ParadisPeerFacts {
	/** 補助アプリ自身の署名。チーム ID があればリリース、無ければ ad-hoc の開発用。 */
	let helper: ParadisSigningIdentity
	/** 相手の署名（チーム ID の要件を満たして検証できたときだけ）。 */
	let peer: ParadisSigningIdentity?
	/** 相手の親の署名（同上）。 */
	let parent: ParadisSigningIdentity?
	/** 相手の親の bundle id（NSRunningApplication から。開発用の判断にだけ使う）。 */
	let parentBundleIdentifier: String?
	/** 相手の親の、さらに親の pid。 */
	let parentParentPid: Int32?
	/** 相手が同じユーザーで動いているか。 */
	let sameUser: Bool
}

enum ParadisPeerDecision: Equatable {
	case allow
	case deny(String)
}

/** 開発時（`./scripts/code.sh`）の main の bundle id。 */
let paradisDevelopmentMainBundleIdentifier = "com.github.Electron"

/**
 * 相手を受け入れるか。
 *
 * - リリース（補助アプリにチーム ID がある）: 相手と相手の親が同じチーム ID で署名され、親の識別子が
 *   Para Code の main（`mainBundleIdentifier`）、相手の識別子がその下（`<main>.helper` など）、
 *   親の親が launchd（pid 1）であること。
 * - 開発（ad-hoc）: 手元のビルドは Para Code 本体も署名が崩れていることがあるので、相手の親の
 *   bundle id が Para Code か Electron であることだけを見る。ad-hoc の補助アプリは手元でしか作られない。
 */
func paradisDecidePeer(_ facts: ParadisPeerFacts, mainBundleIdentifier: String) -> ParadisPeerDecision {
	guard facts.sameUser else {
		return .deny("peer runs as another user")
	}
	guard let team = facts.helper.teamIdentifier, !team.isEmpty else {
		guard let bundle = facts.parentBundleIdentifier else {
			return .deny("peer parent is not an application")
		}
		if bundle == mainBundleIdentifier || bundle == paradisDevelopmentMainBundleIdentifier {
			return .allow
		}
		return .deny("peer parent is not Para Code")
	}
	guard let peer = facts.peer else {
		return .deny("peer code signature is not valid for this team")
	}
	guard peer.teamIdentifier == team else {
		return .deny("peer is signed by another team")
	}
	guard let peerIdentifier = peer.identifier, peerIdentifier.hasPrefix(mainBundleIdentifier + ".") else {
		return .deny("peer is not a Para Code helper process")
	}
	guard let parent = facts.parent else {
		return .deny("peer parent code signature is not valid for this team")
	}
	guard parent.teamIdentifier == team, parent.identifier == mainBundleIdentifier else {
		return .deny("peer parent is not the Para Code main process")
	}
	guard facts.parentParentPid == 1 else {
		return .deny("Para Code main process was not started by launchd")
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
