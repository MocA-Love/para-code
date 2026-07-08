// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { endLiveActivity, isLiveActivitySupported, startOrUpdateLiveActivity, type LiveActivityAgentRow, type LiveActivityState } from '../modules/para-live-activity/index.js';
import { isAgentWaiting, type StoreState } from './store.js';
import { useAppStore } from './appState.js';

/**
 * アプリの状態（workspace.terminals のエージェント状態）をLive Activityへ同期する
 * （live.html 案L1「ステータス集約型」）。実行中/応答待ちのエージェントが1つでも
 * あればActivityを開始・更新し、いなくなったら終了する。
 * 現状はアプリ（JS）が動いている間の更新のみ（バックグラウンドのpush更新は将来対応）。
 */
let started = false;

export function startLiveActivitySync(): void {
	if (started || !isLiveActivitySupported()) {
		return;
	}
	started = true;
	let lastJson = '';
	useAppStore.subscribe(state => {
		const next = buildState(state);
		const json = next === undefined ? '' : JSON.stringify(next);
		if (json === lastJson) {
			return;
		}
		lastJson = json;
		if (next === undefined) {
			void endLiveActivity().catch(() => { /* Activity無しは無視 */ });
		} else {
			void startOrUpdateLiveActivity('Para Code', next).catch(err => console.warn('[liveActivity] update failed', err));
		}
	});
}

/** ストア状態からActivityの表示状態を組み立てる。表示すべきものが無ければundefined。 */
function buildState(state: Pick<StoreState, 'workspace' | 'agentChats'>): LiveActivityState | undefined {
	const terminals = state.workspace?.terminals ?? [];
	const workspaces = new Map((state.workspace?.workspaces ?? []).map(w => [w.id, w.name]));
	const waiting = terminals.filter(t => isAgentWaiting(t.agentStatus));
	const running = terminals.filter(t => t.agentStatus === 'working');
	if (waiting.length === 0 && running.length === 0) {
		return undefined;
	}
	// 応答待ち優先で最大2行。エージェント名はチャット情報があればそれを使う。
	const rows: LiveActivityAgentRow[] = [...waiting, ...running].slice(0, 2).map(t => {
		const agent = state.agentChats.get(t.id)?.agent;
		const name = agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : t.title;
		return {
			name,
			ws: (t.ws !== undefined ? workspaces.get(t.ws) : undefined) ?? t.title,
			status: isAgentWaiting(t.agentStatus) ? 'waiting' : 'running',
		};
	});
	// 応答待ちが1件だけのときは質問文プレビューを出す（L2ハイブリッド）
	let questionPreview: string | undefined;
	const single = waiting.length === 1 ? waiting[0] : undefined;
	if (single !== undefined) {
		const messages = state.agentChats.get(single.id)?.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m !== undefined && m.kind === 'question') {
				questionPreview = m.text.slice(0, 120);
				break;
			}
		}
	}
	return {
		waitingCount: waiting.length,
		runningCount: running.length,
		agents: rows,
		...(questionPreview !== undefined ? { questionPreview } : {}),
	};
}
