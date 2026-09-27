// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { useRouter } from 'expo-router';
import { useAppStore } from '../../appState.js';
import { createAgentLatestEntryToken } from '../../agentNavigation.js';
import { hapticSelection } from '../../haptics.js';
import { resetDetailColumnFor } from '../../ipad/detailColumn.js';
import { routes } from '../../routes.js';
import { useLastSession } from '../home/lastSessionStore.js';

type Router = ReturnType<typeof useRouter>;

/** セッションを開く先。 */
export interface SessionTarget {
	readonly pcId: string;
	readonly spaceId: string;
	readonly spaceName: string;
	readonly branch?: string;
	readonly color?: string;
	/** 開くタブのターミナル。無ければスペースの既定のタブ。 */
	readonly terminalKey?: string;
	/** ターミナルの名前（再開カードの見出し）。無ければスペース名。 */
	readonly title?: string;
}

/**
 * PC の画面の行・ホームの再開カードからセッションを開く。
 *
 * - 「新しく開いた」印（`latest`）を付け、会話を最新まで送らせる（通知から開いたときと同じ扱い）
 * - 旧来の部品やストアの操作が既定の対象にしている選択も合わせる。**`setSelectedWs` は
 *   `selectedTerminalKey` を外すので、この順序を守る**（ルートレイアウトの通知タップと同じ）。
 *   別の PC のセッションなら、選択はルートの画面が PC を切り替えたあとに合わせるので触らない
 * - ホームの「再開」カードの記録を更新する
 * - iPad の2列でその PC の詳細の列が出ていれば、開いていたもの（別のセッションやソース管理）を閉じてから開く
 *   （詳細の列は積み増さず入れ替える。Orca と同じ）
 */
export function openSession(router: Router, target: SessionTarget): void {
	hapticSelection();
	const store = useAppStore.getState();
	if (store.activePcId === target.pcId) {
		store.setSelectedWs(target.spaceId);
		if (target.terminalKey !== undefined) {
			store.setSelectedTerminalKey(target.terminalKey);
		}
	}
	useLastSession.getState().record({
		pcId: target.pcId,
		spaceId: target.spaceId,
		title: target.title ?? target.spaceName,
		spaceName: target.spaceName,
		...(target.terminalKey !== undefined ? { terminalKey: target.terminalKey } : {}),
		...(target.branch !== undefined ? { branch: target.branch } : {}),
		...(target.color !== undefined ? { color: target.color } : {}),
	});
	resetDetailColumnFor(target.pcId);
	// withAnchor: ホームの「再開」から入ったときも、PC の中の Stack の根（PC の画面・2列の置き場）を下に敷く。
	router.push(routes.session(target.pcId, target.spaceId, {
		...(target.terminalKey !== undefined ? { tab: { kind: 'terminal', terminalKey: target.terminalKey } } : {}),
		latest: createAgentLatestEntryToken(),
	}), { withAnchor: true });
}
