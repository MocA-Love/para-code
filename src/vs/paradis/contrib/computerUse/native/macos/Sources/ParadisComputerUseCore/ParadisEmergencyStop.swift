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
//    0.6 秒以内に 2 回続き、Computer Use が入力の要求を処理している最中か、直近 30 秒以内に処理していたら、掛け金を掛ける
//  - 1 回では掛けない。Para Code は背面のアプリを操作するので、利用者が別のアプリで IME の変換やダイアログを
//    Esc 1 回で取り消すだけで止まってしまうため。エージェントが送る Esc は目印で除かれる
//  - 掛かっている間、入力の要求は送る前に `stopped_by_user` で断る。長い文字入力の途中でも、次の 1 打の前に止まる
//    （利用者の入力を見るフェンスと同じ場所で見る）。読むだけの要求は通す
//  - 外せるのは `resume` の要求だけ。shared process は、Para Code の画面での人の操作からしかこれを送らない。
//    補助アプリが終わると（10 分の無操作・設定のオフ・Para Code の終了）掛け金も消える。shared process は、止まったことを
//    一度見た後は同じ状態を自分でも持ち、補助アプリが起動し直しても断り続ける。shared process が見る前（止めた後に
//    どの要求も来ないまま）補助アプリが終わったときは、停止は残らない
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

/** キーの押下の、緊急停止での扱い。 */
enum ParadisEmergencyKey: Equatable {
	/** 2 回押しの 1 回として数える Esc。 */
	case escape
	/** ほかのキー。挟まったら数え直す。 */
	case other
	/** 無かったことにする（数えず、数え直しもしない）。 */
	case ignored
}

/**
 * その押下を、緊急停止でどう扱うか。補助アプリが送ったものと、Esc の自動リピートは無視する（1 回目を少し長く押して
 * リピートが始まっても、2 回目で止まるように）。⌘ ⌃ ⌥ 付きの Esc（⌘⌥Esc の強制終了など）はほかのキーとして扱う。
 */
func paradisEmergencyKey(keyCode: Int64, autorepeat: Bool, ours: Bool, hasCommandControlOrOption: Bool) -> ParadisEmergencyKey {
	if ours {
		return .ignored
	}
	guard keyCode == paradisEscapeKeyCode, !hasCommandControlOrOption else {
		return .other
	}
	return autorepeat ? .ignored : .escape
}

/**
 * 掛け金を掛けるか。直前の Esc から 0.6 秒以内の Esc で、Computer Use が直近 30 秒以内に入力の要求を処理していたこと
 * （処理している最中なら、呼び出し側が `lastInputAt` に今の時刻を渡す）。時刻はどれも同じ単調な時計の秒。
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
	/** 処理している最中の入力の要求の数（1 つの要求が 30 秒を超えても、その間は止められるように）。 */
	private var activeInputs = 0

	var isStopped: Bool {
		lock.lock()
		defer {
			lock.unlock()
		}
		return stopped
	}

	/** 入力の要求の処理を始めた。終えたら必ず `endInput` を呼ぶ。 */
	func beginInput(at time: Double) {
		lock.lock()
		activeInputs += 1
		lastInputAt = time
		lock.unlock()
	}

	/** 入力の要求の処理を終えた（成功でも失敗でも）。ここから 30 秒は Esc の 2 回押しで止められる。 */
	func endInput(at time: Double) {
		lock.lock()
		activeInputs = max(0, activeInputs - 1)
		lastInputAt = time
		lock.unlock()
	}

	/**
	 * キーの押下を知らせる。`key` は `paradisEmergencyKey` の答え。ほかのキーを挟むと数え直す。
	 * この押下で掛け金が掛かったら true。
	 */
	@discardableResult
	func noteKeyDown(_ key: ParadisEmergencyKey, at time: Double) -> Bool {
		lock.lock()
		defer {
			lock.unlock()
		}
		switch key {
		case .ignored:
			return false
		case .other:
			previousEscapeAt = nil
			return false
		case .escape:
			break
		}
		let triggered = !stopped && paradisEmergencyStopTriggered(previousEscapeAt: previousEscapeAt, escapeAt: time, lastInputAt: activeInputs > 0 ? time : lastInputAt)
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

	/**
	 * 掛け金が掛かっていなければ `send` を実行する（押下を 1 つ送る）。鍵を持ったまま送るので、イベントタップが
	 * 掛け金を掛ける（`noteKeyDown`）のと順序が付く: 掛かった後に押下が送られることは無い。掛かっていれば送らずに投げる。
	 * `send` の中からこの掛け金に触れないこと（鍵は再入できない）。
	 */
	func sendUnlessStopped(_ send: () -> Void) throws {
		lock.lock()
		defer {
			lock.unlock()
		}
		if stopped {
			throw ParadisHelperError(code: "stopped_by_user", message: "the user stopped Computer Use by pressing Escape twice")
		}
		send()
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
 *  - 前面のアプリへ届く送り方で、持ち主が今の前面のアプリ（`frontmostPid`）なら断る（頼まれた的と違っていても）
 *  - 持ち主が的でも前面でもない別のアプリなら断らない（ターミナルの「キーボード入力のセキュリティを保護」を常にオンにしている人は、
 *    セキュア入力がずっと有効なので、断ると何も送れなくなる）
 * `ownerPid` は取れないことがある（セッションの辞書に載らない）。
 */
func paradisSecureInputBlocksKeys(secureInputEnabled: Bool, ownerPid: Int32?, keyTargetPid: Int32, viaFrontmost: Bool, frontmostPid: Int32? = nil) -> Bool {
	guard secureInputEnabled else {
		return false
	}
	guard let ownerPid else {
		return viaFrontmost
	}
	// 前面へ届く送り方では、キーを受け取るのは今の前面のアプリ。送っている途中で前面が持ち主のアプリに替わっても
	// 断れるよう、頼まれた的だけでなく前面のアプリとも比べる
	return ownerPid == keyTargetPid || (viaFrontmost && frontmostPid == ownerPid)
}

/** キーを送らずに断る失敗。 */
func paradisSecureInputFailure() -> ParadisHelperError {
	return ParadisHelperError(code: "secure_input_active", message: "macOS Secure Input is on for the application that would receive the keys")
}
