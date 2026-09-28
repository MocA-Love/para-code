// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PcSummary } from './appState.js';
import type { ConnectionState } from './relayClient.js';
import { updateRequiredLabel } from './pcCompat.js';

/**
 * リレーがこの端末の資格を拒んだPC（PCでペアリングを解除された、PCがリレーへ登録し直した等）の
 * 呼び名と案内。待っても直らないので「オフライン」「接続しています…」と並べず、再ペアリングへ案内する。
 * **表示する場所（ホームのPCカード・PCの画面と iPad の左列・セッションの見出し・PC切り替え・設定のPC一覧）は
 * すべてここの判定と文言を使う。**
 */
export const PAIRING_REJECTED_LABEL = '再ペアリングが必要';
export const PAIRING_REJECTED_HINT = 'この端末のペアリングは PC で解除されたか、使えなくなっています。PC の Para Code で QR コードを出し直して、ペアリングし直してください。';

/** 資格を拒まれていて、いまも繋がっていないか（繋がれば拒否は解けている）。 */
export function isPairingRejected(pc: { readonly connection: ConnectionState; readonly pcOnline: boolean; readonly pairingRejected: boolean }): boolean {
	return pc.pairingRejected && !(pc.connection === 'online' && pc.pcOnline);
}

/**
 * PC一覧・PC詳細に出す「そのPCがいまどうなっているか」の一文。
 *
 * 設定のPC一覧とPC詳細の両方が同じ判定を使う。以前は画面ごとに同じ条件分岐を持っていたため、
 * 状態が増えたときに片方だけ直る事故が起きうる形になっていた。
 * 純関数にしてあるので、接続状態の組み合わせを画面を開かずにテストで固定できる。
 *
 * `connection` は「リレーとの接続」、`pcOnline` は「その向こうでPara Codeが動いているか」で別物。
 * 繋がってはいるがPara Codeが落ちている状態を「オフライン」と一緒にすると原因が分からなくなる。
 */
export function pcStatusText(pc: PcSummary, active: boolean): string {
	// 版が合わない PC は、待っても直らないので、どちらを更新するかを出す
	const state = pc.updateRequired !== undefined ? updateRequiredLabel(pc.updateRequired) : pc.connection === 'online' && pc.pcOnline
		? (active ? '接続中' : '待機中')
		// リレーが資格を拒んだ。待っても直らないので「オフライン」と並べない
		: isPairingRejected(pc) ? PAIRING_REJECTED_LABEL
			: pc.connection === 'online' || pc.connection === 'handshaking' ? 'PCオフライン'
				: pc.connection === 'connecting' ? '接続しています…' : 'オフライン';
	const detail = active ? '使用中' : pc.waiting > 0 ? `要対応 ${pc.waiting}件` : undefined;
	return detail !== undefined ? `${state} · ${detail}` : state;
}

/**
 * バッテリーを状態の行に添えてよいか。
 *
 * 繋がっていないPCの残量は「最後に見えた値」でしかなく、実際にはとうに変わっている。
 * 古い数字を現在値のように見せない（オフライン中は出さない）。
 */
export function shouldShowBattery(pc: PcSummary): boolean {
	return pc.battery !== undefined && pc.connection === 'online' && pc.pcOnline;
}
