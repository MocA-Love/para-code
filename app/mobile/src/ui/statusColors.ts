// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ConnectionState } from '../relayClient.js';
import { agentStatusKind } from '../agentStatus.js';
import { colors, status, type StatusKey } from '../theme.js';

/**
 * 新しい部品（`src/ui/`）が描く「状態の点・輪・メーター」の色と呼び名。
 * 画面から切り離した純関数にして、組み合わせを実機なしでテストで固定する
 * （`statusColors.test.ts`）。エージェントの状態の判定そのものは既存の `src/agentStatus.ts` を使い、
 * ここでは書き直さない。
 */

/** PC とのつながりを、点の色で表せる4段に畳んだもの。 */
export type ConnectionKind = 'connected' | 'connecting' | 'pcOffline' | 'offline';

/**
 * リレーとの接続（`connection`）と、その向こうで Para Code が動いているか（`pcOnline`）から
 * 点の種類を決める。語は `src/pcStatus.ts` の `pcStatusText` と揃えている。
 *
 * リレーには繋がっているのに Para Code が落ちている状態は「オフライン」と分ける
 * （原因が PC 側にあることを色で伝える。Orca の「デスクトップに届かない」＝赤と同じ扱い）。
 */
export function connectionKind(connection: ConnectionState, pcOnline: boolean): ConnectionKind {
	if (connection === 'online') {
		return pcOnline ? 'connected' : 'pcOffline';
	}
	if (connection === 'connecting' || connection === 'handshaking') {
		return 'connecting';
	}
	return 'offline';
}

const CONNECTION_STYLE: Record<ConnectionKind, { readonly color: string; readonly label: string }> = {
	connected: { color: colors.green, label: '接続中' },
	connecting: { color: colors.amber, label: '接続しています…' },
	pcOffline: { color: colors.red, label: 'PCオフライン' },
	offline: { color: colors.textMuted, label: 'オフライン' },
};

export function connectionColor(kind: ConnectionKind): string {
	return CONNECTION_STYLE[kind].color;
}

export function connectionLabel(kind: ConnectionKind): string {
	return CONNECTION_STYLE[kind].label;
}

/**
 * エージェントの状態の点の色。待機だけは薄めた灰（`colors.idleDot`）にする。
 * 文字やアイコンに使う色は `theme.status[kind].color`（待機は不透明の灰）を使うこと。
 */
export function agentDotColor(kind: StatusKey): string {
	return kind === 'idle' ? colors.idleDot : status[kind].color;
}

/** 回転する輪で描くか（実行中だけ）。 */
export function isSpinningKind(kind: StatusKey): boolean {
	return kind === 'running';
}

/** PC から届いた `agentStatus` の文字列を、点の種類に直す（判定は `agentStatusKind`）。 */
export function agentKindFromStatus(agentStatus: string | undefined): StatusKey {
	return agentStatusKind(agentStatus);
}

/** メーターの値（使用率 %）を 0〜100 の整数にそろえる。幅・色・数字が同じ値を使うように。 */
export function meterPercent(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * メーターの色。Orca（とPC版のステータスバー）と同じ帯: 60% 未満は緑、80% 未満は琥珀、
 * それ以上は赤。値が無いときは弱い灰。
 */
export function meterColor(percent: number | undefined): string {
	if (percent === undefined) {
		return colors.textMuted;
	}
	if (percent >= 80) {
		return colors.red;
	}
	if (percent >= 60) {
		return colors.amber;
	}
	return colors.green;
}

/** メーター右端の数字。値が無いときはダッシュ。 */
export function meterValueLabel(percent: number | undefined): string {
	return percent === undefined ? '—' : `${percent}%`;
}
