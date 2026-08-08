// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './appState.js';
import { colors } from './theme.js';

/**
 * 「いまPCと繋がっていない」を**新しい部品を出さずに**伝えるための派生値。
 *
 * 以前はこれを上端のカプセル（トースト）で出していた。カプセルはナビの場所に重なるので、
 * 直るまで居座ると「いまどのリポジトリのどのブランチを見ているか」が隠れる。オフライン中は
 * まさに誤認が実害になるときなので、覆うのは筋が悪い。
 *
 * いまは**スペースの島のサブ行を差し替える**（ブランチ名の代わりにこの文を出し、アバターと
 * 文字を橙にする）。島は全タブとエージェント詳細に常時出ているので、覆うものが無いまま
 * 直るまで残しておける。復帰の操作は島をタップして開くドロワーの接続ボタンが持つ。
 *
 * 出さない条件は1つ（繋がっている）。それ以外は必ず何か返す。
 */

export interface OfflineNotice {
	/** 島のサブ行に出す短い文。ブランチ名の位置に入るので**短く**保つ。 */
	readonly text: string;
	/** サブ行とアバターの色。 */
	readonly color: string;
}

export function useOfflineNotice(): OfflineNotice | undefined {
	const { connection, pcOnline, sessionProtocolReady, manualOffline, pendingRendererCount } = useAppStore(useShallow(s => ({
		connection: s.connection,
		pcOnline: s.pcOnline,
		sessionProtocolReady: s.sessionProtocolReady,
		manualOffline: s.manualOffline,
		pendingRendererCount: s.workspace?.renderers.filter(renderer => !renderer.ready).length ?? 0,
	})));

	const live = connection === 'online' && pcOnline && sessionProtocolReady;

	return useMemo(() => {
		if (live) {
			// 一部の画面だけ復旧待ちのときは、操作できる画面もあるので黄色で軽く伝える。
			return pendingRendererCount > 0
				? { text: `${pendingRendererCount}個の画面を再接続中`, color: colors.yellow }
				: undefined;
		}
		if (manualOffline) {
			return { text: '切断中 — 最後の画面', color: colors.orange };
		}
		if (!pcOnline && (connection === 'online' || connection === 'handshaking')) {
			return { text: 'PCオフライン — 最後の画面', color: colors.orange };
		}
		return { text: '再接続中 — 最後の画面', color: colors.orange };
	}, [live, pendingRendererCount, manualOffline, pcOnline, connection]);
}
