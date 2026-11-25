/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 利用者が止める手段（Esc の 2 回押し）と、セキュア入力中にキーを送らない判定。どちらも OS に触れない純関数と、
// 鍵付きの小さな状態だけをここに置く（OS から値を読むのは ParadisComputerUse 側）。
//
// 緊急停止:
//  - 入力の見張り（ParadisInputMonitor）が、目印の無い（補助アプリが送ったのではない）Esc の押下を知らせる。
//    0.6 秒以内に 2 回続き、直近 30 秒以内に Computer Use が入力の要求を受けていたら、掛け金を掛ける
//  - 1 回では掛けない。Para Code は背面のアプリを操作するので、利用者が別のアプリで IME の変換やダイアログを
//    Esc 1 回で取り消すだけで止まってしまうため。エージェントが送る Esc は目印で除かれる
//  - 掛かっている間、入力の要求は送る前に `stopped_by_user` で断る。長い文字入力の途中でも、次の 1 打の前に止まる
//    （利用者の入力を見るフェンスと同じ場所で見る）。読むだけの要求は通す
//  - 外せるのは `resume` の要求だけ。shared process は、Para Code の画面での人の操作からしかこれを送らない。
//    補助アプリが終わると（10 分の無操作・設定のオフ・Para Code の終了）掛け金も消えるので、shared process も
//    同じ状態を持ち、補助アプリが起動し直しても断り続ける
//
// 既知の限界（実機では未確認）:
//  - macOS のセキュア入力中（パスワード欄に入力中）は、イベントタップにキーが届かないので、Esc の 2 回押しは効かない見込み
//  - 入力監視の許可が無いなどでタップにキーが届かない構成でも効かない

import Foundation

/** Esc の仮想キーコード。 */
let paradisEscapeKeyCode: Int64 = 53
/** 2 回押しとみなす間隔。 */
let paradisEmergencyStopDoublePressSeconds: Double = 0.6
/** Computer Use が入力の要求を受けてから、Esc の 2 回押しで止められる時間。 */
let paradisEmergencyStopRecentInputSeconds: Double = 30

/**
 * その押下を、緊急停止の Esc として数えるか。補助アプリが送ったもの・自動リピート・⌘ ⌃ ⌥ 付き（⌘⌥Esc の強制終了など）は数えない。
 */
func paradisCountsAsEmergencyEscape(keyCode: Int64, autorepeat: Bool, ours: Bool, hasCommandControlOrOption: Bool) -> Bool {
	return keyCode == paradisEscapeKeyCode && !autorepeat && !ours && !hasCommandControlOrOption
}

/**
 * 掛け金を掛けるか。直前の Esc から 0.6 秒以内の Esc で、Computer Use が直近 30 秒以内に入力の要求を受けていること。
 * 時刻はどれも同じ単調な時計の秒。
 */
func paradisEmergencyStopTriggered(previousEscapeAt: Double?, escapeAt: Double, lastInputAt: Double?) -> Bool {
	guard let previousEscapeAt, let lastInputAt else {
		return false
	}
	let gap = escapeAt - previousEscapeAt
	guard gap >= 0, gap <= paradisEmergencyStopDoublePressSeconds else {
		return false
	}
	// 入力の要求と Esc は別のスレッドで刻むので、わずかに前後しても数える
	return escapeAt - lastInputAt <= paradisEmergencyStopRecentInputSeconds
}

/**
 * 緊急停止の掛け金。イベントタップ（main のスレッド）と要求の処理（別のスレッド）の両方から触るので鍵を掛ける。
 * 補助アプリのプロセスが終わると消える（上の説明のとおり、shared process も同じ状態を持つ）。
 */
final class ParadisEmergencyStop {
	private let lock = NSLock()
	private var stopped = false
	private var previousEscapeAt: Double?
	private var lastInputAt: Double?

	var isStopped: Bool {
		lock.lock()
		defer {
			lock.unlock()
		}
		return stopped
	}

	/** 入力の要求を受けた・終えた時刻を覚える。 */
	func noteInput(at time: Double) {
		lock.lock()
		lastInputAt = time
		lock.unlock()
	}

	/**
	 * 目印の無いキーの押下を知らせる。`escape` は `paradisCountsAsEmergencyEscape` の答え。ほかのキーを挟むと数え直す。
	 * この押下で掛け金が掛かったら true。
	 */
	@discardableResult
	func notePhysicalKeyDown(escape: Bool, at time: Double) -> Bool {
		lock.lock()
		defer {
			lock.unlock()
		}
		guard escape else {
			previousEscapeAt = nil
			return false
		}
		let triggered = !stopped && paradisEmergencyStopTriggered(previousEscapeAt: previousEscapeAt, escapeAt: time, lastInputAt: lastInputAt)
		previousEscapeAt = time
		if triggered {
			stopped = true
		}
		return triggered
	}

	/** 掛け金を外す（`resume` の要求だけが呼ぶ）。 */
	func resume() {
		lock.lock()
		stopped = false
		previousEscapeAt = nil
		lock.unlock()
	}

	/** 掛かっていれば、入力を断る失敗。 */
	func failure() -> ParadisHelperError? {
		return isStopped ? ParadisHelperError(code: "stopped_by_user", message: "the user stopped Computer Use by pressing Escape twice") : nil
	}
}

// MARK: - セキュア入力

/**
 * セキュア入力（パスワード欄などがキーボードを独占する macOS の仕組み）が有効なとき、キーを送らずに断るか。
 *  - 持ち主がキーの届く先のアプリなら断る（そのアプリのパスワード欄に打つことになる）
 *  - 持ち主が分からず、前面のアプリへ届く送り方（HID のタップへ送る 3 段目）なら断る
 *  - 持ち主が別のアプリなら断らない（ターミナルの「キーボード入力のセキュリティを保護」を常にオンにしている人は、
 *    セキュア入力がずっと有効なので、断ると何も送れなくなる）
 * `ownerPid` は取れないことがある（セッションの辞書に載らない）。
 */
func paradisSecureInputBlocksKeys(secureInputEnabled: Bool, ownerPid: Int32?, keyTargetPid: Int32, viaFrontmost: Bool) -> Bool {
	guard secureInputEnabled else {
		return false
	}
	guard let ownerPid else {
		return viaFrontmost
	}
	return ownerPid == keyTargetPid
}

/** キーを送らずに断る失敗。 */
func paradisSecureInputFailure() -> ParadisHelperError {
	return ParadisHelperError(code: "secure_input_active", message: "macOS Secure Input is on for the application that would receive the keys")
}
