// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * PC に届かない間のエージェントへの送信を預かる（Orca W2-29、Q121 案 A）。
 *
 * 預かりは PC ごとに、ターミナル操作のアウトボックスと同じ鍵（この端末の鍵と PC の公開鍵から導く）で暗号化して
 * 端末のファイルへ保存する。期限は 24 時間。つながったら古い順に、開いているエージェントのターミナル宛てだけを
 * そのまま送る。ターミナルが閉じていたもの・過去の会話宛てのものは「再開して送る」を利用者が押すまで送らない
 * （黙って再開しない）。送る判断は `agentSessions.ts` の {@link planAgentSendQueue}。
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { decodeUtf8, fromBase64Url, openNotify, randomToken, sealNotify, toBase64Url } from '@para/protocol';
import { agentSendQueueKey, sendPcRequest, useAppStore } from './appState.js';
import {
	addAgentSendQueueItem, agentSendLiveDecision, agentSendResumeTarget, deserializeAgentSendQueue, expireAgentSendQueue, parseAgentResumeResult, planAgentSendQueue, serializeAgentSendQueue,
	type AgentResumeResult, type AgentSendQueueItem, type AgentSendTarget,
} from './agentSessions.js';
import { createAgentSendOutboxStore } from './platform.js';

const encoder = new TextEncoder();

/** 会話の状態を受け取り直すまで、取り直しを頼まずに待つ時間。 */
const CHAT_REFRESH_AFTER_MS = 2_000;
/** 送ったエージェントの会話が準備できるのを待つ上限。 */
const CHAT_READY_TIMEOUT_MS = 10_000;
/** 再開は PC がエージェントの準備を待ってから答える（最大 60 秒）ので、それより長く待つ。 */
const RESUME_TIMEOUT_MS = 90_000;

interface AgentSendQueueStore {
	readonly items: readonly AgentSendQueueItem[];
	/** 読み込み済みの PC（保存の前に必ず読む。読む前に保存すると預かりを消してしまう）。 */
	readonly loaded: ReadonlySet<string>;
}

export const useAgentSendQueue = create<AgentSendQueueStore>(() => ({ items: [], loaded: new Set() }));

function newRequestId(): string {
	return `send-${toBase64Url(randomToken(12))}`;
}

async function loadPc(pcId: string): Promise<void> {
	if (useAgentSendQueue.getState().loaded.has(pcId)) {
		return;
	}
	const key = agentSendQueueKey(pcId);
	if (key === undefined) {
		return; // PC の準備がまだ（読まずに「読んだ」ことにすると、次の保存で預かりを消してしまう）
	}
	let restored: readonly AgentSendQueueItem[] = [];
	for (const candidate of await createAgentSendOutboxStore(pcId).loadCandidates().catch(() => [] as readonly string[])) {
		try {
			restored = deserializeAgentSendQueue(pcId, decodeUtf8(openNotify(key, fromBase64Url(candidate))));
			break;
		} catch {
			// 鍵が変わった（ペアリングし直した）か壊れている。次の候補を試す。
		}
	}
	useAgentSendQueue.setState(state => {
		if (state.loaded.has(pcId)) {
			return state;
		}
		const known = new Set(state.items.map(item => item.id));
		return { items: [...state.items, ...restored.filter(item => !known.has(item.id))], loaded: new Set([...state.loaded, pcId]) };
	});
}

let saveChain: Promise<void> = Promise.resolve();

/** その PC の預かりを保存する（順に書く）。 */
function savePc(pcId: string): Promise<void> {
	saveChain = saveChain.then(async () => {
		const key = agentSendQueueKey(pcId);
		if (key === undefined || !useAgentSendQueue.getState().loaded.has(pcId)) {
			return;
		}
		const items = useAgentSendQueue.getState().items.filter(item => item.pcId === pcId);
		const store = createAgentSendOutboxStore(pcId);
		if (items.length === 0) {
			await store.clear();
			return;
		}
		await store.save(toBase64Url(sealNotify(key, encoder.encode(serializeAgentSendQueue(pcId, items)))));
	}).catch(error => console.warn('[agentSendQueue] failed to save', error));
	return saveChain;
}

function update(pcId: string, change: (items: readonly AgentSendQueueItem[]) => readonly AgentSendQueueItem[]): void {
	useAgentSendQueue.setState(state => {
		const next = change(state.items);
		return next === state.items ? state : { items: next };
	});
	void savePc(pcId);
}

function patch(pcId: string, id: string, fields: Partial<Pick<AgentSendQueueItem, 'status' | 'error' | 'reason'>>): void {
	update(pcId, items => items.map(item => {
		if (item.id !== id) {
			return item;
		}
		const { error: _error, reason: _reason, ...rest } = item;
		return { ...rest, ...fields };
	}));
}

/** 送信を預かる。保存し終えたら resolve する。 */
export async function enqueueAgentSend(pcId: string, text: string, target: AgentSendTarget): Promise<AgentSendQueueItem> {
	await loadPc(pcId);
	if (!useAgentSendQueue.getState().loaded.has(pcId)) {
		throw new Error('送信を預かれませんでした。PC にもう一度つないでから送ってください');
	}
	const item: AgentSendQueueItem = { id: newRequestId(), pcId, createdAt: Date.now(), text, target, status: 'waiting' };
	update(pcId, items => addAgentSendQueueItem(items, item));
	await savePc(pcId);
	return item;
}

/** 預かりから外す（取り消し・送り終えた）。 */
export function removeAgentSend(pcId: string, id: string): void {
	update(pcId, items => items.filter(item => item.id !== id));
}

/** 送れなかったものを待ちに戻す（［もう一度送る］）。 */
export function retryAgentSend(pcId: string, id: string): void {
	patch(pcId, id, { status: 'waiting' });
}

/**
 * 会話を再開して送る（利用者が「再開して送る」を押したとき・過去の会話の画面から送るとき）。PC は同じ ID の依頼を
 * 二度実行しないので、応答が届かず送り直しても再開は 1 回だけ。
 */
export async function resumeAndSend(pcId: string, sourceId: string, key: string, prompt: string, requestId: string = newRequestId()): Promise<AgentResumeResult> {
	const ws = mobileSpaceIdFor(sourceId);
	if (ws === undefined) {
		throw new Error('このスペースは今の PC に見つかりません');
	}
	const reply = await sendPcRequest<Record<string, unknown>>(pcId, 'scm', { t: 'agentSessionResume', ws, key, prompt, requestId }, { timeoutMs: RESUME_TIMEOUT_MS });
	const result = parseAgentResumeResult(reply);
	if (result === undefined) {
		throw new Error('PC からの応答が正しくありません');
	}
	return result;
}

/**
 * PC のスペースの id（`sourceId`）から、アプリの画面のスペースの id を引く。アプリの id はウィンドウの番号を含み、
 * PC を再起動すると変わるので、預かりには `sourceId` を残して送るときに引き直す。
 */
export function mobileSpaceIdFor(sourceId: string): string | undefined {
	return useAppStore.getState().workspace?.workspaces.find(space => space.sourceId === sourceId)?.id;
}

/** 預かった 1 件を「再開して送る」。成功したら預かりから外し、結果を返す。 */
export async function confirmResumeAndSend(item: AgentSendQueueItem): Promise<AgentResumeResult | undefined> {
	const target = agentSendResumeTarget(item);
	if (target === undefined) {
		patch(item.pcId, item.id, { status: 'failed', error: 'この送信は再開できません' });
		return undefined;
	}
	patch(item.pcId, item.id, { status: 'sending' });
	try {
		const result = await resumeAndSend(item.pcId, target.ws, target.key, item.text, item.id);
		if (result.status === 'running') {
			patch(item.pcId, item.id, { status: 'failed', error: 'この会話は PC で開いています。会話の画面から送ってください' });
			return result;
		}
		if (result.delivered !== true && result.terminalKey !== undefined) {
			// 会話は開けたが依頼を渡せなかった。消さずに、開いた会話の入力欄へ移しておく。
			useAppStore.getState().setAgentDraft(result.terminalKey, item.text);
		}
		removeAgentSend(item.pcId, item.id);
		return result;
	} catch (error) {
		patch(item.pcId, item.id, { status: 'needs-confirm', error: error instanceof Error ? error.message : '送れませんでした' });
		return undefined;
	}
}

/**
 * 開いているエージェントのターミナルへ 1 件送る。会話の準備を待ち、送れたら預かりから外す。
 * `confirmed`（利用者が「このターミナルへ送る」を押した）でなければ、ターミナルの会話が預けたときと同じかを確かめ、
 * 違う・分からないなら送らずに確認へ回す（レビュー H2）。送信には預かりの id を付け、PC は同じ id を二度送らない（M4）。
 */
export async function sendToLiveTerminal(item: AgentSendQueueItem, confirmed = false): Promise<void> {
	if (item.target.kind !== 'live') {
		return;
	}
	const terminalKey = item.target.terminalKey;
	const app = useAppStore.getState();
	patch(item.pcId, item.id, { status: 'sending' });
	// 今の会話の状態を PC から受け取り直してから判断する（NG-2）。つながり直した直後の手元の状態は切れる前のもので、
	// その間に PC で `/clear` などをされていると、古い会話の指紋で比べて別の会話へ送ってしまう。
	const since = Date.now();
	app.attachAgent(terminalKey);
	try {
		const decide = () => agentSendLiveDecision(item, useAppStore.getState().agentChats.get(terminalKey), since, confirmed);
		const deadline = Date.now() + CHAT_READY_TIMEOUT_MS;
		let refreshed = false;
		while (decide() === 'wait' && Date.now() < deadline) {
			// 既に開いていた会話は attach し直しても何も届かないので、少し待っても来なければ取り直しを頼む。
			if (!refreshed && Date.now() - since > CHAT_REFRESH_AFTER_MS) {
				refreshed = true;
				useAppStore.getState().refreshAgent(terminalKey);
			}
			await new Promise<void>(resolve => setTimeout(resolve, 200));
		}
		const decision = decide();
		if (decision === 'wait') {
			patch(item.pcId, item.id, { status: 'failed', error: '宛先の会話の状態を PC から受け取れませんでした。もう一度送ってください' });
			return;
		}
		if (decision === 'confirm') {
			patch(item.pcId, item.id, { status: 'needs-confirm', reason: 'other-conversation' });
			return;
		}
		const result = await useAppStore.getState().sendAgentMessage(terminalKey, item.text, item.id);
		if (result.status === 'accepted') {
			removeAgentSend(item.pcId, item.id);
			return;
		}
		patch(item.pcId, item.id, { status: 'failed', error: result.message ?? '送れませんでした' });
	} finally {
		app.detachAgent(terminalKey);
	}
}

let flushing = false;

/** いま見ている PC につながっている間に、待っている送信を片付ける。 */
async function flush(pcId: string): Promise<void> {
	if (flushing) {
		return;
	}
	flushing = true;
	try {
		await loadPc(pcId);
		update(pcId, items => expireAgentSendQueue(items, Date.now()));
		const terminals = useAppStore.getState().workspace?.terminals ?? [];
		for (const plan of planAgentSendQueue(useAgentSendQueue.getState().items, pcId, terminals, Date.now())) {
			const app = useAppStore.getState();
			if (app.activePcId !== pcId || !isLive(app)) {
				return;
			}
			if (plan.kind === 'confirm') {
				patch(pcId, plan.item.id, { status: 'needs-confirm', reason: plan.reason });
			} else if (plan.kind === 'fail') {
				patch(pcId, plan.item.id, { status: 'failed', error: plan.error });
			} else {
				await sendToLiveTerminal(plan.item);
			}
		}
	} finally {
		flushing = false;
	}
}

function isLive(state: { readonly connection: string; readonly pcOnline: boolean; readonly sessionProtocolReady: boolean; readonly protocolError: string | undefined; readonly workspace: unknown }): boolean {
	return state.connection === 'online' && state.pcOnline && state.sessionProtocolReady && state.protocolError === undefined && state.workspace !== undefined;
}

/** いま見ている PC に PC とのやり取りができるか（送信を預かるかの判断に使う）。 */
export function useAgentSendLive(): boolean {
	return useAppStore(isLive);
}

/**
 * 預かりの見張り役。アプリの根に 1 つだけ置く。いま見ている PC を読み込み、つながったら待っている送信を片付ける。
 */
export function useAgentSendQueueRunner(): void {
	const activePcId = useAppStore(s => s.activePcId);
	const live = useAppStore(isLive);
	const waiting = useAgentSendQueue(s => s.items.some(item => item.pcId === activePcId && item.status === 'waiting'));
	useEffect(() => {
		if (activePcId !== undefined) {
			void loadPc(activePcId);
		}
	}, [activePcId]);
	useEffect(() => {
		if (activePcId !== undefined && live && waiting) {
			void flush(activePcId);
		}
	}, [activePcId, live, waiting]);
}

/** {@link useAgentSendQueueRunner} を木に置くための部品（何も描かない）。アプリの根に 1 つだけ置く。 */
export function AgentSendQueueRunner(): null {
	useAgentSendQueueRunner();
	return null;
}
