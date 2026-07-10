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
	if (started) {
		return;
	}
	started = true;
	let lastJson = '';
	let warnedUnsupported = false;
	const apply = (state: Pick<StoreState, 'workspace' | 'agentChats'>) => {
		// サポート判定は更新のたびに問い合わせる。isSupported() はライブアクティビティの
		// 許可状態（設定アプリで切り替え可能）を含むため、マウント時の一発判定にすると
		// 「起動時に許可オフ → 後から有効化」で二度と表示されなくなる。
		if (!isLiveActivitySupported()) {
			if (!warnedUnsupported) {
				warnedUnsupported = true;
				console.log('[liveActivity] unsupported or not enabled (build without the widget extension, or Live Activities disabled in Settings)');
			}
			return;
		}
		warnedUnsupported = false;
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
	};
	useAppStore.subscribe(apply);
	// subscribe はストア変化時にしか発火しないため、購読開始時点で既に実行中/応答待ちの
	// エージェントがいる場合も即時反映する
	apply(useAppStore.getState());
}

/** ストア状態からActivityの表示状態を組み立てる。表示すべきものが無ければundefined。 */
function buildState(state: Pick<StoreState, 'workspace' | 'agentChats'>): LiveActivityState | undefined {
	const terminals = state.workspace?.terminals ?? [];
	const workspaces = new Map((state.workspace?.workspaces ?? []).map(w => [w.id, w.name]));
	// エージェント実績のあるターミナルに限定する（プレーンなターミナルがワークスペース
	// 集約状態を拾ってActivityに載る誤表示の再発防止。状態自体もペイン単位になったが二重に守る）
	const agents = terminals.filter(t => t.agent === true);
	const waiting = agents.filter(t => isAgentWaiting(t.agentStatus));
	const running = agents.filter(t => t.agentStatus === 'working');
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
