/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの TUI（Claude Code / Codex）へ、質問・承認の回答を打鍵として流す部品。
//
// もとはモバイル中継の renderer 側（mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts）に
// あったものを、デスクトップのチャット表示からも使えるよう切り出した（フェーズ6）。キー列そのものは
// mobileRelay/common/paradisAgentQuestionKeys.ts が組み立てる。ここは「いつ・どう流すか」だけを持つ。

import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/**
 * 質問の選択肢が画面に出るのを待つ上限。ここを過ぎたら待たずに流す（送信を止める門ではない）。
 *
 * 実測（Claude Code 2.1.223）では、質問が描かれてから打鍵が効くまでに待ちが要る。待たずに
 * 送った1打鍵は入力欄へ吸われて消え、3秒待った同じ打鍵は通った。上限はその実測より少し広く取る。
 */
const INTERACTION_READY_TIMEOUT_MS = 5_000;
/** 選択肢が見えてから打鍵するまでの一拍（描画とフォーカス移動の隙間ぶん）。 */
const INTERACTION_READY_SETTLE_MS = 400;
/** 画面を見に行く間隔。 */
const INTERACTION_READY_POLL_MS = 150;

/**
 * ターミナルの**見えている範囲**だけを文字列にする。
 *
 * `getContentsAsText()` を引数無しで呼ぶと**スクロールバック全体**（既定1000行、設定次第でもっと）
 * を走査する。目印の照合にそれを使うと、**過去に同じ質問が出ていれば履歴に必ず当たる**ので
 * 「もう描かれている」と誤判定し、待ちの意味が消える。同じ質問へ答え直すケース（まさに直したい
 * 場面）ほど確実に踏むので、可視領域に限ること。走査量が数十行で収まる利点もある。
 */
export function paradisVisibleTerminalText(instance: ITerminalInstance): string {
	const raw = instance.xterm?.raw;
	if (raw === undefined) {
		return '';
	}
	const buffer = raw.buffer.active;
	const lines: string[] = [];
	for (let y = buffer.baseY; y < buffer.baseY + raw.rows; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

/**
 * 画面に目印が出ているかを、**空白と改行を無視して**照合する。
 *
 * ターミナルは幅で折り返し、折り返しの境目には改行が入る。Para Code は2Dグリッドで
 * 狭いペインが常態なので、素朴な部分一致だと日本語ラベルなどは折り返しでほぼ必ず外れる。
 * 目印側も同じ規則で作る（paradisQuestionReadyMarker）。
 */
export function paradisScreenShowsMarker(screen: string, marker: string): boolean {
	return screen.replace(/\s+/g, '').includes(marker);
}

/**
 * 打鍵を流し始めてよい状態になるまで待つ。
 *
 * TUI は「質問を描く」のと「選択肢リストがキーボードフォーカスを取る」のが同時ではない。
 * その隙間に届いたキーは**入力欄へ吸われて消える**（Claude Code 2.1.223 で実測。待たずに
 * 送ると入力欄に文字が残るだけで質問は動かず、3秒待てば同じキーがそのまま通った）。
 * 単問・単一選択のキー列は数字1つだけなので、これを落とすと後続で拾い直す機会が無い。
 *
 * 目印は質問自身の選択肢ラベル（paradisQuestionReadyMarker）。TUI のフッタ文言に
 * 頼ると、表示が変わったときに黙って壊れる。
 *
 * 目印が無い場合と、待っても現れない場合は**そのまま流す**。ここは取りこぼしを減らすための
 * ものであって、送信を止める門ではない（画面の読み取りに失敗して回答できなくなる方が悪い）。
 */
export async function paradisWaitForAgentInteractionTarget(instance: ITerminalInstance, readyMarker: string | undefined, partCount: number): Promise<void> {
	const startedAt = Date.now();
	const settle = () => new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_SETTLE_MS));
	// この待ちが効いているかは本番でしか分からない。目印を見つけられたのか、時間切れだったのか、
	// そもそも目印が無かったのかを残さないと、「まだ落ちる」ときに次の一手を決められない。
	//
	// **これは renderer 発なので、届く保証がまだない**（このプロジェクトでは renderer 由来の
	// transaction が一度も観測できていない。原因は未特定）。レース説そのものの判定は
	// PC側（shared process）の `agentQuestion.answer-settled` に載せた `safe_ms_since_question`
	// で行う。こちらは届けば「目印の待ちが効いたか」という一段細かい話が読める、という位置づけ。
	const record = (outcome: 'marker-seen' | 'timed-out' | 'no-marker') => {
		runInParadisSpan('agentQuestion', 'inject-wait', {
			safe_outcome: outcome,
			safe_wait_ms: Date.now() - startedAt,
			// 1つだけの回答（単問・単一選択、承認）は取りこぼすと拾い直せない。
			safe_key_parts: partCount,
		}, () => { });
	};
	if (readyMarker === undefined) {
		// 目印を作れない回答（承認など）は、少なくとも先頭を0msで叩かない。
		// 承認の「はい」は `1` に続けて Enter を送るので、先頭が入力欄へ吸われると
		// **Enterがその `1` をエージェントへのメッセージとして送信してしまう**。
		await settle();
		record('no-marker');
		return;
	}
	const deadline = startedAt + INTERACTION_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (paradisScreenShowsMarker(paradisVisibleTerminalText(instance), readyMarker)) {
			// 描かれてからフォーカスが移るまでのわずかな隙間を越えるための一拍。
			await settle();
			record('marker-seen');
			return;
		}
		await new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_POLL_MS));
	}
	// 目印が見つからないまま時間切れ。ここは取りこぼしを減らすためのものであって
	// 送信を止める門ではないので、そのまま流す（画面の読み取りに失敗して回答できなくなる方が悪い）。
	await settle();
	record('timed-out');
}

/**
 * 回答のキー列を、先頭の前に画面を確かめてから一定間隔で1つずつ流す。
 *
 * `beforeEachKey` は各キーを流す直前に呼ばれ、`false` を返すとそこで止める。**待ちを挟んだ後は
 * 必ず作り直しと差し替えを確かめること。** 先頭の打鍵にも待ちが入るので、「待っている間に別の
 * 経路で答えられた／別の質問に変わった」窓がある。ここを飛ばすと、消えた質問の跡地へ数字を
 * 打ち込むことになり、続く Enter でそれがエージェントへのメッセージとして送信される。
 *
 * @returns 全部流せたら true。途中で止めたら false。
 */
export async function paradisSendAgentInteractionKeys(
	instance: ITerminalInstance,
	parts: readonly string[],
	delayMs: number,
	readyMarker: string | undefined,
	beforeEachKey: () => Promise<boolean>,
): Promise<boolean> {
	// **最初の1打鍵を待たずに流さないこと。** TUI が選択肢リストへキーボードフォーカスを
	// 移す前に届いたキーは、リストではなく入力欄へ吸われて消える（Claude Code 2.1.223 で
	// 実測）。キー列が1つだけの回答は、これを落とすと拾い直す機会が無い。
	await paradisWaitForAgentInteractionTarget(instance, readyMarker, parts.length);
	for (let index = 0; index < parts.length; index++) {
		if (index > 0) {
			await new Promise<void>(resolve => setTimeout(resolve, delayMs));
		}
		if (!(await beforeEachKey())) {
			return false;
		}
		await instance.sendText(parts[index], false);
	}
	return true;
}
