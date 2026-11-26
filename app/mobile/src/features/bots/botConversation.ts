// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import type { useRouter } from 'expo-router';
import { useAppStore } from '../../appState.js';
import { useParaToast } from '../../paraToast.js';
import type { WorkspaceState } from '../../store.js';
import { openSession } from '../pc/openSession.js';
import { resolveTerminalSpace } from '../pc/pcList.js';
import { spaceColor } from '../pc/spaceColor.js';
import { appendBotDraft, botPaneOf, botRefusalText, newBotOpId } from './bots.js';
import { openBotOnPc } from './botStore.js';

type Router = ReturnType<typeof useRouter>;
type Terminal = WorkspaceState['terminals'][number];

/** PC にペインを頼んでから現れるまで待つ長さ。 */
const OPEN_WAIT_MS = 30_000;

/** 入力欄へ足す下書き。関数なら、ペインが確かにあると分かってから呼ぶ（提案の「始める」は PC で「始めた」にするので、
 * ペインが現れないまま呼ぶと依頼の文が行き場を失う）。undefined を返したら足さずに開く。 */
export type BotDraft = string | (() => Promise<string | undefined>);

/**
 * Bot の会話を開く。会話は新しい画面を作らず、その Bot のペインの今のセッションの画面へ移る。ペインが State に無ければ
 * PC に起動を頼み（`botOpen`）、ペインが現れたら移る。`draft` を渡すと、移る前に入力欄の書きかけの後ろへ足す（送らない。すでに開いている入力欄には出ないことがある）。
 */
export function useBotConversation(router: Router, pcId: string | undefined, botId: string | undefined, active: boolean) {
	const terminals = useAppStore(s => (active ? s.workspace?.terminals : undefined));
	const pane = botId !== undefined && terminals !== undefined ? botPaneOf(terminals, botId) : undefined;
	const [waiting, setWaiting] = useState<{ readonly draft: BotDraft | undefined; readonly until: number } | undefined>(undefined);
	const routerRef = useRef(router);
	routerRef.current = router;

	const [preparing, setPreparing] = useState(false);
	const enter = async (terminal: Terminal, draftSource: BotDraft | undefined) => {
		if (pcId === undefined) {
			return;
		}
		let draft: string | undefined;
		if (typeof draftSource === 'function') {
			setPreparing(true);
			try {
				draft = await draftSource();
			} finally {
				setPreparing(false);
			}
		} else {
			draft = draftSource;
		}
		const store = useAppStore.getState();
		const workspace = store.workspace;
		const owner = workspace !== undefined ? resolveTerminalSpace(terminal, workspace.workspaces, workspace.activeWs) : undefined;
		if (owner === undefined) {
			return;
		}
		if (draft !== undefined && store.activePcId === pcId) {
			store.setAgentDraft(terminal.terminalKey, appendBotDraft(store.agentDrafts[terminal.terminalKey] ?? '', draft));
		}
		openSession(routerRef.current, {
			pcId,
			spaceId: owner.id,
			spaceName: owner.name,
			color: spaceColor(owner),
			terminalKey: terminal.terminalKey,
			title: terminal.title,
			...(owner.branch !== undefined ? { branch: owner.branch } : {}),
		});
	};

	// 頼んだペインが現れたら移る。待ちきれなければ知らせて止める
	useEffect(() => {
		if (waiting === undefined) {
			return undefined;
		}
		if (pane !== undefined) {
			setWaiting(undefined);
			void enter(pane, waiting.draft);
			return undefined;
		}
		const timer = setTimeout(() => {
			setWaiting(undefined);
			useParaToast.getState().show({ key: `bot-open-${botId ?? ''}`, text: 'Bot のペインが PC に現れませんでした', sub: 'PC の Para Code を確かめてください', icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
		}, Math.max(0, waiting.until - Date.now()));
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- enter は最新の値を読む
	}, [waiting, pane]);

	const open = async (draft?: BotDraft): Promise<void> => {
		if (pcId === undefined || botId === undefined) {
			return;
		}
		if (pane !== undefined) {
			await enter(pane, draft);
			return;
		}
		setWaiting({ draft, until: Date.now() + OPEN_WAIT_MS });
		const result = await openBotOnPc(pcId, botId, newBotOpId());
		if (!result.ok) {
			setWaiting(undefined);
			useParaToast.getState().show({ key: `bot-open-${botId}`, text: 'Bot を起動できませんでした', sub: botRefusalText(result.code), icon: 'alert-circle-outline', tone: 'warn' }, 3_500);
		}
	};

	return { pane, opening: waiting !== undefined || preparing, open };
}
