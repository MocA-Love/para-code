/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Computer Use の失敗を Sentry で読めるようにする（呼び出しごとの span と、補助アプリが壊れたときだけのエラー）。
//
// 呼び出しの失敗（利用者が操作中・古い番号・拒否など）はエージェントが同じ失敗を何十回も繰り返しうるので、
// エラーにはせず `para.computerUse.call` の span の値にする（span の枠は月 500 万件で、エラーの 5,000 件とは別）。
// エラーとして送るのは、補助アプリが起動できない・続けて落ちるといった、その利用者の Computer Use が止まる場合だけ。
//
// 送るのは決まった語・回数・ミリ秒・補助アプリの版だけ。アプリの名前と bundle id、ウィンドウの題名、
// 入力した文字、キーの名前、座標、エラーの文は送らない。キー名には Sentry のサーバー側で値を消す語
// （token・session・command・prompt・terminal・env など）を含めない。

import { ParadisSpanAttributes, reportParadisDiagnosticError, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';

/** 呼び出しの結末。`refused` は設定・利用者の判断・常に断るアプリで断ったもの（壊れているのではない）。 */
export type ParadisComputerUseCallOutcome = 'ok' | 'refused' | 'error';

/** 1 回の呼び出しの途中で分かったこと。ツールの処理が書き込み、終わったときに span の値になる。 */
export interface IParadisComputerUseCallDiagnostics {
	/** 補助アプリが選んだ送り方（`accessibility`・`background`・`foreground`。文字入力は `+` でつなぐ）。 */
	route?: string;
	/** 失敗した要求で、補助アプリが既に送っていた入力の単位数。 */
	inputSent?: number;
	/** 前面の送り方の承認を利用者に聞いたか。 */
	foregroundAsked: boolean;
	/** 承認ダイアログで利用者の答えを待った時間（所要時間からこれを引くと Para Code の処理時間になる）。 */
	approvalWaitMs: number;
	/** ツリー・スクショ・操作後の状態のうち、読めなかったものの数（呼び出しは成功として返している）。 */
	stateFailures: number;
	/** 最初に読めなかったものの理由。 */
	stateFailure?: string;
}

export function createParadisComputerUseCallDiagnostics(): IParadisComputerUseCallDiagnostics {
	return { foregroundAsked: false, approvalWaitMs: 0, stateFailures: 0 };
}

const FAILURE_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const ROUTE = /^[a-z]{1,16}(?:\+[a-z]{1,16}){0,3}$/;
const HELPER_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/**
 * 理由として送ってよい形（小文字・数字・`_` の語）にする。補助アプリが返すコードもここを通すので、
 * 想定外の値（文・パス）は `other` に畳む。
 */
export function paradisComputerUseFailureCode(value: unknown): string {
	return typeof value === 'string' && FAILURE_CODE.test(value) ? value : 'other';
}

/** `launch-failed` のような名前を、理由の語（`launch_failed`）にする。 */
export function paradisComputerUseReasonWord(value: string): string {
	return paradisComputerUseFailureCode(value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/-/g, '_'));
}

/** `para.computerUse.call` の span に載せる値。 */
export function paradisComputerUseCallAttributes(
	tool: string,
	outcome: ParadisComputerUseCallOutcome,
	failure: string | undefined,
	durationMs: number,
	diagnostics: IParadisComputerUseCallDiagnostics,
	helperVersion: string | undefined,
): ParadisSpanAttributes {
	return {
		safe_tool: paradisComputerUseFailureCode(tool),
		safe_outcome: outcome,
		...(failure !== undefined ? { safe_failure: paradisComputerUseFailureCode(failure) } : {}),
		safe_duration_ms: Math.max(0, Math.round(durationMs)),
		safe_approval_wait_ms: Math.max(0, Math.round(diagnostics.approvalWaitMs)),
		safe_foreground_asked: diagnostics.foregroundAsked,
		...(diagnostics.route !== undefined && ROUTE.test(diagnostics.route) ? { safe_route: diagnostics.route } : {}),
		...(diagnostics.inputSent !== undefined ? { safe_input_sent: diagnostics.inputSent } : {}),
		safe_state_failures: diagnostics.stateFailures,
		...(diagnostics.stateFailure !== undefined ? { safe_state_failure: paradisComputerUseFailureCode(diagnostics.stateFailure) } : {}),
		...(helperVersion !== undefined && HELPER_VERSION.test(helperVersion) ? { safe_helper_version: helperVersion } : {}),
	};
}

/** 呼び出し 1 回を時間のかからない span として送る（値は作るときに全部渡す。await の後に足すと失われるため）。 */
export function recordParadisComputerUseCall(attributes: ParadisSpanAttributes): void {
	runInParadisSpan('computerUse', 'call', attributes, () => { });
}

/** 補助アプリが壊れた段階。`unsupported-os`（macOS 14 より前）は壊れているのではないので含めない。 */
export type ParadisComputerUseHelperFailureStage =
	/** 配布物に補助アプリが入っていない。 */
	| 'missing'
	/** `open` で起動できない。 */
	| 'open'
	/** 起動したがソケットを開かない。 */
	| 'socket'
	/** handshake に答えない。 */
	| 'handshake'
	/** プロトコルの版が合わない。 */
	| 'protocol'
	/** macOS が許可を補助アプリ以外に帰属させている。 */
	| 'responsibility'
	/** 答えている途中で続けて落ちた。 */
	| 'crashed-repeatedly';

/** 補助アプリが壊れたことを 1 件のエラー（warning）として送る口。テストでは差し替える。 */
export type ParadisComputerUseHelperFailureReporter = (stage: ParadisComputerUseHelperFailureStage, error: unknown, safeExtra: Record<`safe_${string}`, string | number | boolean>) => void;

/**
 * 段階を operation に入れて送る（指紋は実質 operation だけなので、入れないと全段階が 10 分 3 件の枠を分け合う）。
 * 渡した例外は名前と errno だけが残り、文は送られない。
 */
export function reportParadisComputerUseHelperFailure(stage: ParadisComputerUseHelperFailureStage, error: unknown, safeExtra: Record<`safe_${string}`, string | number | boolean>): void {
	reportParadisDiagnosticError('owned', 'computer-use', `helper-${stage}`, error, safeExtra, 'warning');
}
