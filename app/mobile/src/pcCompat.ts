// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC とアプリの互換の窓と、PC の機能（capability）の見方（Orca W2-17）。
 *
 * 判定そのものは PC と同じ関数を使う（`paradisMobileCompat.ts` を直接 import する。PC 側は
 * 依存ゼロの純関数なので、相対パスでそのまま読める。前例 `fileViewer.tsx` の Office 復旧）。
 * PC とアプリで別々に書くと、片方だけ直ったときに「PC は通すがアプリは拒む」がずれる。
 *
 * 画面から使うのは次の 3 つ:
 * - `pcHasCapability(workspace, name)` / `usePcCapability(name)`（hooks/usePcCapability.ts）:
 *   PC がその機能を持っているか。持っていない PC にはボタンごと出さない
 * - `updateRequiredCopy(target)`: 「アプリを更新」「PC を更新」の案内文
 */

import {
	PARADIS_MOBILE_APP_CAPABILITIES,
	PARADIS_MOBILE_MIN_COMPATIBLE_PC,
	PARADIS_MOBILE_PROTOCOL_VERSION,
	ParadisMobileCapability,
	paradisEvaluateMobileCompat,
	paradisHasMobileCapability,
	paradisParseMobileCapabilities,
	type ParadisMobileCompatVerdict,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.js';

export {
	PARADIS_MOBILE_APP_CAPABILITIES as APP_CAPABILITIES,
	PARADIS_MOBILE_MIN_COMPATIBLE_PC as APP_MIN_COMPATIBLE_PC,
	PARADIS_MOBILE_PROTOCOL_VERSION as APP_PROTOCOL_VERSION,
	ParadisMobileCapability as PcCapability,
	paradisParseMobileCapabilities as parseCapabilities,
};
export type { ParadisMobileCompatVerdict as PcCompatVerdict };

/** 更新が必要な側。`app` はこのアプリ、`pc` は PC の Para Code。 */
export type UpdateTarget = 'app' | 'pc';

/** State の要求に載せる本文（`stateEncoding` は呼び出し側が足す）。 */
export function stateRequestFields(): { protocolVersion: number; minCompatiblePc: number; capabilities: readonly string[] } {
	return {
		protocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
		minCompatiblePc: PARADIS_MOBILE_MIN_COMPATIBLE_PC,
		capabilities: PARADIS_MOBILE_APP_CAPABILITIES,
	};
}

/** PC から届いた State の版と、このアプリの版から、話せるかを決める（PC と同じ関数）。 */
export function evaluatePcCompat(state: { readonly protocolVersion?: unknown; readonly minCompatibleMobile?: unknown }): ParadisMobileCompatVerdict {
	return paradisEvaluateMobileCompat({
		mobileProtocolVersion: PARADIS_MOBILE_PROTOCOL_VERSION,
		mobileMinCompatiblePc: PARADIS_MOBILE_MIN_COMPATIBLE_PC,
		pcProtocolVersion: state.protocolVersion,
		pcMinCompatibleMobile: state.minCompatibleMobile,
	});
}

export function updateTargetOf(verdict: ParadisMobileCompatVerdict): UpdateTarget | undefined {
	return verdict.kind === 'blocked' ? (verdict.reason === 'mobile-too-old' ? 'app' : 'pc') : undefined;
}

/**
 * その PC がその機能を持っているか。
 *
 * 広告の無い古い PC は「何も持っていない」とみなす（W2-17 より後に足した機能は出さない）。
 * 切断中は最後に届いた State の広告をそのまま使う（同じ PC がつながり直せば同じ機能を持っている）。
 */
export function pcHasCapability(workspace: { readonly capabilities?: readonly string[] } | undefined, name: string): boolean {
	return paradisHasMobileCapability(workspace?.capabilities, name);
}

/** 「更新が必要」の見出し（一覧の状態の行など、短く出す場所）。 */
export function updateRequiredLabel(target: UpdateTarget): string {
	return target === 'app' ? 'アプリの更新が必要' : 'PC の更新が必要';
}

/** 「更新が必要」の見出しと本文（PC の画面の中身に出す）。 */
export function updateRequiredCopy(target: UpdateTarget, pcName: string): { readonly title: string; readonly body: string } {
	return target === 'app'
		? {
			title: 'アプリの更新が必要です',
			body: `${pcName} の Para Code は、このアプリより新しい通信の方式を使っています。App Store（または TestFlight）でこのアプリを最新にしてください。PC はそのままで大丈夫です。`,
		}
		: {
			title: 'PC の更新が必要です',
			body: `${pcName} の Para Code が、このアプリより古い版です。PC で Para Code を最新にしてください。このアプリはそのままで大丈夫です。`,
		};
}
