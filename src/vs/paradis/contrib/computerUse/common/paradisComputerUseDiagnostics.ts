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

import { isParadisSentryScrubbedWord, ParadisSpanAttributes, reportParadisDiagnosticError, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisComputerUseAvailability, ParadisComputerUseBlockReason } from './paradisComputerUse.js';

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
 * Sentry が値ごと消す語（`key`・`auth`・`password` など）を含む、補助アプリのエラーコードの言い換え。
 * 載せないと理由が `[Filtered]` で届く。
 */
const RENAMED_CODES: Readonly<Record<string, string>> = {
	'key_blocked': 'shortcut_blocked',
};

/**
 * 理由として送ってよい形（小文字・数字・`_` の語）にする。補助アプリが返すコードもここを通すので、
 * 想定外の値（文・パス）と、Sentry が消す語を含む値（言い換えの無いもの）は `other` に畳む。
 */
export function paradisComputerUseFailureCode(value: unknown): string {
	if (typeof value !== 'string' || !FAILURE_CODE.test(value)) {
		return 'other';
	}
	// `tree_key_blocked` のように前置きが付いた形でも言い換える
	const word = Object.entries(RENAMED_CODES).reduce((current, [from, to]) => current.replaceAll(from, to), value);
	return isParadisSentryScrubbedWord(word) ? 'other' : word;
}

/**
 * 常に断るアプリの理由を送るときの語。`password-manager`・`authenticator`・`keychain` は Sentry が値ごと消す語を含むので言い換える。
 */
const BLOCK_REASON_WORDS: Readonly<Record<ParadisComputerUseBlockReason, ParadisComputerUseFailure>> = {
	'password-manager': 'blocked_vault_app',
	'authenticator': 'blocked_otp_app',
	'keychain': 'blocked_os_vault',
	'para-code': 'blocked_self_app',
	'system': 'blocked_system_app',
};

export function paradisComputerUseBlockFailure(reason: ParadisComputerUseBlockReason): ParadisComputerUseFailure {
	return BLOCK_REASON_WORDS[reason];
}

/** 補助アプリの版として送ってよい形なら、それ。 */
export function paradisComputerUseHelperVersion(value: string | undefined): string | undefined {
	return value !== undefined && HELPER_VERSION.test(value) ? value : undefined;
}

/**
 * Para Code 側で決める理由の語の一覧（補助アプリのエラーコードは別に {@link paradisComputerUseFailureCode} を通す）。
 * Sentry が値ごと消す語（`password`・`auth`・`key`・`token`・`session` など）を含めない。テストが全部を検査する。
 */
export const PARADIS_COMPUTER_USE_FAILURES = [
	'caller_ssh', 'caller_unverified', 'disabled', 'unhandled_tool', 'unclassified',
	'unavailable_unchecked', 'unavailable_unsupported_os', 'unavailable_missing', 'unavailable_launch_failed', 'unavailable_incompatible', 'unavailable_misattributed',
	'app_argument_invalid', 'app_not_running', 'app_ambiguous', 'app_no_bundle_id', 'app_restarted', 'no_windows', 'no_such_window', 'permissions_missing',
	'blocked_vault_app', 'blocked_otp_app', 'blocked_os_vault', 'blocked_self_app', 'blocked_system_app',
	'user_denied', 'read_only',
	'approval_dialog_failed', 'approval_recently_denied', 'approval_busy', 'approval_unanswered', 'approval_pane_unresolved', 'approval_timed_out', 'approval_cancelled',
	'foreground_dialog_failed', 'foreground_denied', 'foreground_recently_denied', 'foreground_busy', 'foreground_unanswered', 'foreground_pane_unresolved', 'foreground_timed_out', 'foreground_cancelled', 'foreground_retry_failed',
	'typing_mismatch', 'typing_rewritten', 'typing_focus_changed',
] as const;

export type ParadisComputerUseFailure = typeof PARADIS_COMPUTER_USE_FAILURES[number];

const UNAVAILABLE_FAILURES: Readonly<Record<Exclude<ParadisComputerUseAvailability, 'ok'>, ParadisComputerUseFailure>> = {
	'unchecked': 'unavailable_unchecked',
	'unsupported-os': 'unavailable_unsupported_os',
	'missing': 'unavailable_missing',
	'launch-failed': 'unavailable_launch_failed',
	'incompatible': 'unavailable_incompatible',
	'misattributed': 'unavailable_misattributed',
};

/** 補助アプリが使えない状態で断ったときの理由の語。 */
export function paradisComputerUseUnavailableFailure(availability: Exclude<ParadisComputerUseAvailability, 'ok'>): ParadisComputerUseFailure {
	return UNAVAILABLE_FAILURES[availability];
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
	const version = paradisComputerUseHelperVersion(helperVersion);
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
		...(version !== undefined ? { safe_helper_version: version } : {}),
	};
}

/** 呼び出し 1 回を時間のかからない span として送る（値は作るときに全部渡す。await の後に足すと失われるため）。 */
export function recordParadisComputerUseCall(attributes: ParadisSpanAttributes): void {
	// shared process で MCP の処理の中にほかの span があっても、子に吸われず呼び出しの名前で届くようにする
	runInParadisSpan('computerUse', 'call', attributes, () => { }, { forceTransaction: true });
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
