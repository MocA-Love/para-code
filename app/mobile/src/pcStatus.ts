// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { PcSummary } from './appState.js';

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
	const state = pc.connection === 'online' && pc.pcOnline
		? (active ? '接続中' : '待機中')
		: pc.connection === 'online' || pc.connection === 'handshaking' ? 'PCオフライン'
			: pc.connection === 'connecting' ? '接続しています…' : 'オフライン';
	const detail = active ? '使用中' : pc.waiting > 0 ? `応答待ち ${pc.waiting}件` : undefined;
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
