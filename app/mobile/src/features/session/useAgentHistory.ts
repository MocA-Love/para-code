// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useAppStore } from '../../appState.js';
import {
	absorbTrimmedIntoHistory, AGENT_HISTORY_CAPABILITY, AGENT_HISTORY_PAGE_SIZE, agentHistoryErrorText, agentHistoryHeader, applyAgentHistoryPage, beginAgentHistoryLoad, historyBeforeRev,
	parseAgentHistoryReply, reconcileAgentHistory, type AgentHistoryHeader, type AgentHistoryState,
} from '../../agentHistory.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import type { AgentChatMessage, AgentChatState } from '../../store.js';

/** PC が記録ファイルを 2MB 読むぶんを見込んだ待ち時間。 */
const HISTORY_TIMEOUT_MS = 20_000;

/** ターミナルごとの古い発言（W2-30）。アプリの中だけに持ち、保存はしない。 */
const useAgentHistoryStore = create<{
	readonly byTerminal: Readonly<Record<string, AgentHistoryState | undefined>>;
	put(terminalKey: string, state: AgentHistoryState | undefined): void;
}>(set => ({
	byTerminal: {},
	put: (terminalKey, state) => set(current => (current.byTerminal[terminalKey] === state ? current : { byTerminal: { ...current.byTerminal, [terminalKey]: state } })),
}));

const NO_MESSAGES: readonly AgentChatMessage[] = [];

/**
 * 会話の状態が変わるたびに、古い発言を合わせ直す（画面を開いていなくても）。差分で 500 件に切られた発言は古い発言の
 * 末尾へ繰り入れてから合わせる（NG-1）。古い発言を持っているターミナルだけを見る。
 */
useAppStore.subscribe((state, previous) => {
	if (state.agentChats === previous.agentChats) {
		return;
	}
	const store = useAgentHistoryStore.getState();
	for (const [terminalKey, history] of Object.entries(store.byTerminal)) {
		const chat = state.agentChats.get(terminalKey);
		const before = previous.agentChats.get(terminalKey);
		if (history === undefined || chat === before) {
			continue;
		}
		const previousLive = before !== undefined && before.epoch === chat?.epoch ? before.messages : NO_MESSAGES;
		// この更新で切られた発言（前の状態と同じ印なら、もう繰り入れ済み）。
		const trim = chat?.trimmedByDelta;
		const trimmedByUpdate = trim !== undefined && trim !== before?.trimmedByDelta && trim.epoch === chat?.epoch ? trim.messages : NO_MESSAGES;
		const absorbed = absorbTrimmedIntoHistory(history, chat?.epoch, previousLive, chat?.messages ?? NO_MESSAGES, trimmedByUpdate);
		const next = reconcileAgentHistory(absorbed, chat?.epoch, chat?.messages ?? NO_MESSAGES);
		if (next !== history) {
			store.put(terminalKey, next);
		}
	}
});

/**
 * 会話の古い発言をさかのぼって読む（W2-30）。`loadOlder` は一覧の先頭に近づいたとき・案内を押したときに呼ぶ。
 * 返す `messages` は会話の発言より前に並べる古い発言（古い順）。
 */
export function useAgentHistory(terminalKey: string, chat: AgentChatState | undefined): {
	readonly messages: readonly AgentChatMessage[];
	readonly header: AgentHistoryHeader;
	readonly loadOlder: () => void;
} {
	const supported = usePcCapability(AGENT_HISTORY_CAPABILITY);
	const history = useAgentHistoryStore(s => s.byTerminal[terminalKey]);
	const requestAgentReply = useAppStore(s => s.requestAgentReply);
	const epoch = chat?.epoch;
	const live = chat?.messages ?? NO_MESSAGES;

	// 会話が変わった・新しい発言と重なった・つながらなくなったときに合わせ直す。
	useEffect(() => {
		const current = useAgentHistoryStore.getState().byTerminal[terminalKey];
		const next = reconcileAgentHistory(current, epoch, live);
		if (next !== current) {
			useAgentHistoryStore.getState().put(terminalKey, next);
		}
	}, [terminalKey, epoch, live]);

	const loadOlder = useCallback(() => {
		const store = useAgentHistoryStore.getState();
		const current = store.byTerminal[terminalKey];
		if (!supported || chat === undefined || epoch === undefined || chat.none === true || current?.loading === true) {
			return;
		}
		if (current === undefined ? !chat.truncated : !current.hasMore) {
			return;
		}
		const beforeRev = historyBeforeRev(current, chat.messages);
		if (beforeRev === undefined) {
			return;
		}
		const started = beginAgentHistoryLoad(current, epoch);
		store.put(terminalKey, started);
		const finish = (update: (state: AgentHistoryState) => AgentHistoryState) => {
			const latest = useAgentHistoryStore.getState().byTerminal[terminalKey];
			// 待っている間に会話が変わった・合わせ直しで捨てられたなら何もしない。
			if (latest === undefined || latest.epoch !== epoch || !latest.loading) {
				return;
			}
			useAgentHistoryStore.getState().put(terminalKey, update(latest));
		};
		requestAgentReply(terminalKey, {
			t: 'history', epoch, beforeRev, limit: AGENT_HISTORY_PAGE_SIZE,
			...(started.cursor !== undefined ? { cursor: started.cursor } : {}),
		}, 'history', HISTORY_TIMEOUT_MS)
			.then(reply => {
				const page = parseAgentHistoryReply(reply);
				finish(state => page !== undefined ? applyAgentHistoryPage(state, page) : { ...state, loading: false, error: agentHistoryErrorText('invalid') });
			})
			.catch((error: unknown) => {
				finish(state => ({ ...state, loading: false, error: error instanceof Error ? error.message : agentHistoryErrorText('unknown') }));
			});
	}, [supported, chat, epoch, terminalKey, requestAgentReply]);

	return {
		messages: history?.messages ?? NO_MESSAGES,
		header: agentHistoryHeader(supported, chat?.truncated === true, history),
		loadOlder,
	};
}
