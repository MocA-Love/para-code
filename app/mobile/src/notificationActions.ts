// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 通知のボタン（許可・拒否・返信・開く）の定義と、押されたあとに何を送るかの判断（純関数）。
 *
 * **ボタンはアプリを前面で開き、Face ID の後に送る。** ロックされたまま裏で送ることはしない（裏でリレーへ
 * 繋ぎ直す必要があり、アプリのロックも通らないため）。iOS のボタンは `opensAppToForeground` と
 * `isAuthenticationRequired`（端末のロック解除）を付け、アプリ側はさらにアプリのロック（`AuthGate`）が
 * 解けるまで待つ。送る処理は `notificationActionRunner.ts`。
 *
 * カテゴリの識別子は PC の `paradisNotifyCompose.ts`（`para.<種類>`）、通知拡張（NotificationService.swift）、
 * 長押しの画面（ParaCodeNotifyContent の Info.plist の `UNNotificationExtensionCategory`）と一致させる。
 */

/** ボタンの識別子。 */
export const NOTIFY_ACTION_IDS = {
	open: 'para.open',
	reply: 'para.reply',
	approve: 'para.approve',
	deny: 'para.deny',
} as const;

/** expo-notifications の `setNotificationCategoryAsync` へ渡す形（必要な項目だけ）。 */
export interface NotifyCategoryAction {
	readonly identifier: string;
	readonly buttonTitle: string;
	readonly textInput?: { readonly submitButtonTitle: string; readonly placeholder: string };
	readonly options: { readonly opensAppToForeground: boolean; readonly isAuthenticationRequired?: boolean; readonly isDestructive?: boolean };
}

export interface NotifyCategoryDefinition {
	readonly identifier: string;
	readonly actions: readonly NotifyCategoryAction[];
}

const OPEN: NotifyCategoryAction = { identifier: NOTIFY_ACTION_IDS.open, buttonTitle: '開く', options: { opensAppToForeground: true } };
const REPLY: NotifyCategoryAction = {
	identifier: NOTIFY_ACTION_IDS.reply,
	buttonTitle: '返信',
	textInput: { submitButtonTitle: '送信', placeholder: 'エージェントへの返信' },
	options: { opensAppToForeground: true, isAuthenticationRequired: true },
};

/** 登録するカテゴリ。質問の選択肢は通知ごとに違うので、ボタンは「開く」だけにしてアプリで答える。 */
export const NOTIFY_CATEGORIES: readonly NotifyCategoryDefinition[] = [
	{ identifier: 'para.done', actions: [REPLY, OPEN] },
	{ identifier: 'para.error', actions: [REPLY, OPEN] },
	{
		identifier: 'para.approval', actions: [
			{ identifier: NOTIFY_ACTION_IDS.approve, buttonTitle: '許可', options: { opensAppToForeground: true, isAuthenticationRequired: true } },
			{ identifier: NOTIFY_ACTION_IDS.deny, buttonTitle: '拒否', options: { opensAppToForeground: true, isAuthenticationRequired: true, isDestructive: true } },
			OPEN,
		],
	},
	{ identifier: 'para.question', actions: [OPEN] },
	// どの承認かの ID が無い承認（PC が付けられなかった）。許可・拒否のボタンは出さない。
	{ identifier: 'para.approval.open', actions: [OPEN] },
];

/**
 * 通知の種類からカテゴリの識別子を引く。種類の無い旧 PC の通知はカテゴリを付けない（ボタンを出さない）。
 * どの承認かの ID が無い承認は、許可・拒否のボタンが無いカテゴリにする。通知拡張（NotificationService.swift）と同じ規則。
 */
export function notifyCategoryIdentifier(category: string | undefined, interactionId?: string): string | undefined {
	if (category === 'approval' && (interactionId === undefined || interactionId.length === 0)) {
		return 'para.approval.open';
	}
	return category === 'done' || category === 'approval' || category === 'question' || category === 'error' ? `para.${category}` : undefined;
}

/** 押されたボタンで頼まれたこと。「開く」・本体のタップは遷移だけなので undefined。 */
export type NotificationActionRequest =
	| { readonly kind: 'approve' }
	| { readonly kind: 'deny' }
	| { readonly kind: 'reply'; readonly text: string };

/** 返信の上限（エージェントへの 1 回の送信として十分な長さ）。 */
const REPLY_MAX_LENGTH = 4000;

export function readNotificationAction(actionIdentifier: string | undefined, userText: string | undefined): NotificationActionRequest | undefined {
	switch (actionIdentifier) {
		case NOTIFY_ACTION_IDS.approve:
			return { kind: 'approve' };
		case NOTIFY_ACTION_IDS.deny:
			return { kind: 'deny' };
		case NOTIFY_ACTION_IDS.reply: {
			const text = userText?.trim();
			return text !== undefined && text.length > 0 ? { kind: 'reply', text: text.slice(0, REPLY_MAX_LENGTH) } : undefined;
		}
		default:
			return undefined;
	}
}

/** 送るのを待っているボタンの操作。 */
export interface PendingNotificationAction {
	readonly pcId: string;
	readonly terminalKey: string;
	readonly request: NotificationActionRequest;
	/** 通知が指していた承認の ID（新しい PC だけ）。違う承認には答えない。 */
	readonly interactionId?: string;
	/** 通知が届いた時刻（`response.notification.date`）。古すぎる通知のボタンは送らない。 */
	readonly at: number;
	/** アプリが操作を預かった時刻。この後にロックの解除（Face ID）があるまで送らない。 */
	readonly queuedAt: number;
}

/** 預かってからこれを過ぎたら送らない（Face ID に手間取った・PC につながらない）。 */
export const NOTIFICATION_ACTION_MAX_WAIT_MS = 60_000;
/** 届いてからこれを過ぎた通知のボタンは送らない（起動時に取り出した古い応答で送らないため。バナーの上限と同じ 30 分）。 */
// 届いてから 30 分はユーザーの決定（q.html Q179 A、2026-10-04）。
export const NOTIFICATION_ACTION_MAX_AGE_MS = 30 * 60_000;

/**
 * 送る前提がそろったか。
 * - `needs-unlock`: ロックは解けているが、預けた後の解除（Face ID）がまだ。呼び出し側が解除し直しを頼む
 * - `wait`: ロック中・別の PC を見ている・PC とやり取りできない
 */
export function notificationActionReadiness(pending: PendingNotificationAction, ctx: {
	readonly now: number;
	readonly locked: boolean;
	/** 最後にロックが解けた時刻。 */
	readonly lastUnlockedAt: number | undefined;
	readonly activePcId: string | undefined;
	readonly live: boolean;
}): 'wait' | 'needs-unlock' | 'ready' | 'expired' {
	if (ctx.now - pending.queuedAt > NOTIFICATION_ACTION_MAX_WAIT_MS || ctx.now - pending.at > NOTIFICATION_ACTION_MAX_AGE_MS) {
		return 'expired';
	}
	if (ctx.locked) {
		return 'wait';
	}
	if (ctx.lastUnlockedAt === undefined || ctx.lastUnlockedAt <= pending.queuedAt) {
		return 'needs-unlock';
	}
	return ctx.activePcId === pending.pcId && ctx.live ? 'ready' : 'wait';
}

/** 会話の状態（`AgentChatState` の一部）。 */
export interface NotificationActionChat {
	readonly syncedAt?: number;
	readonly none?: boolean;
	readonly capabilities?: { readonly agentActions?: boolean };
	readonly interaction?: { readonly kind: 'question' | 'approval'; readonly id: string; readonly choices?: readonly { readonly id: string }[] };
}

/** 会話の状態を見て、何を送るかを決める。`since` より後に PC から受け取り直した状態でだけ決める。 */
export function planNotificationActionSend(pending: PendingNotificationAction, chat: NotificationActionChat | undefined, since: number):
	| { readonly kind: 'wait' }
	| { readonly kind: 'approval'; readonly interactionId: string; readonly choice: string }
	| { readonly kind: 'reply'; readonly text: string }
	| { readonly kind: 'drop'; readonly message: string } {
	if (chat === undefined || (chat.syncedAt ?? 0) < since || (chat.none !== true && chat.capabilities?.agentActions !== true)) {
		return { kind: 'wait' };
	}
	if (chat.none === true) {
		return { kind: 'drop', message: 'エージェントが見つかりませんでした' };
	}
	if (pending.request.kind === 'reply') {
		if (chat.interaction !== undefined) {
			return { kind: 'drop', message: '質問や許可への回答が先に必要です' };
		}
		return { kind: 'reply', text: pending.request.text };
	}
	const interaction = chat.interaction;
	if (interaction?.kind !== 'approval') {
		return { kind: 'drop', message: 'この確認はもう終わっています' };
	}
	// 通知がどの確認を指していたか分からない（PC が ID を付けられなかった）ときは答えない。後から来た別の確認に
	// 答えてしまうため。
	if (pending.interactionId === undefined || pending.interactionId !== interaction.id) {
		return { kind: 'drop', message: '確認の対象が変わりました。画面で確かめてください' };
	}
	const choice = pending.request.kind === 'approve' ? 'yes' : 'no';
	if (interaction.choices !== undefined && !interaction.choices.some(candidate => candidate.id === choice)) {
		return { kind: 'drop', message: 'この確認は画面の選択肢から答えてください' };
	}
	return { kind: 'approval', interactionId: interaction.id, choice };
}
