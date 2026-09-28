/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// APNs の通知をロック画面で置き換える・まとめるための ID（W2-08、Orca `apns-client.ts:39,71`）。
//
// push-notify の `collapseId`（→ `apns-collapse-id`。同じ値の通知は端末上で置き換わる）と
// `threadId`（→ `aps.thread-id`。通知センターでまとまる）はリレーと APNs から見える。そのため
// エージェントのトークンやスペースの名前をそのまま載せず、ペアリングごとの通知鍵（PC とそのモバイル
// だけが知る）から作った HMAC にする。モバイルの Notification Service Extension は本文を復号して
// 自分の ID を使うので、ここの値と一致させる必要は無い（ヘッダーは OS の置き換え用）。

import { createHmac } from 'crypto';

/** ID の長さ（hex）。リレーは base64url 8〜64 文字だけを受け付け、APNs の collapse-id は 64 バイトまで。 */
const PUSH_ID_HEX_LENGTH = 32;
/** 通知鍵（AES の鍵）をそのまま HMAC に使わないよう、用途を分けた鍵を作るためのラベル。 */
const PUSH_ID_KEY_LABEL = 'paradis-push-id-v1';

export interface IParadisMobilePushIds {
	readonly collapseId?: string;
	readonly threadId?: string;
}

/**
 * 通知の本文（JSON）から、push-notify に載せる ID を作る。
 * - collapseId: 同じエージェント（`agentToken`）の完了・エラーの通知を置き換える。トークンが無い通知と、
 *   許可待ち・質問（`agent-question`）には付けない（未回答の許可が後の通知に置き換わって見えなくならないように）
 * - threadId: 同じスペース（`ws`）の通知をまとめる。`ws` が無ければこの PC の通知としてまとめる
 */
export function paradisMobilePushIds(notifyKey: Uint8Array, notifyBytes: Uint8Array): IParadisMobilePushIds {
	let agentToken: string | undefined;
	let ws: string | undefined;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(notifyBytes)) as { kind?: unknown; agentToken?: unknown; ws?: unknown };
		agentToken = parsed.kind !== 'agent-question' && typeof parsed.agentToken === 'string' && parsed.agentToken.length > 0 ? parsed.agentToken : undefined;
		ws = typeof parsed.ws === 'string' && parsed.ws.length > 0 ? parsed.ws : undefined;
	} catch {
		return {};
	}
	const id = pushIdHasher(notifyKey);
	return {
		...(agentToken !== undefined ? { collapseId: id('collapse', agentToken) } : {}),
		threadId: id('thread', ws ?? ''),
	};
}

/**
 * 「もう消してよい通知」の印（W2-27）。通知の `id` を、同じ用途別の鍵で HMAC にしたもの。
 * プッシュの暗号文の中（`dismiss`）に入れるので、リレーと APNs には見えない。通知拡張（NSE）は
 * 復号に使えた鍵で、通知センターに残る通知の `notifyId` から同じ値を作って突き合わせる
 * （`app/mobile/native/NotifyExtension/NotificationService.swift` の `dismissTag`。値は
 * `paradisMobilePushIds.test.ts` で固定）。鍵はペアリングごとなので、別の PC の通知には一致しない。
 */
export function paradisMobileDismissTags(notifyKey: Uint8Array, notifyIds: readonly string[]): string[] {
	if (notifyIds.length === 0) {
		return [];
	}
	const id = pushIdHasher(notifyKey);
	return notifyIds.map(notifyId => id('dismiss', notifyId));
}

function pushIdHasher(notifyKey: Uint8Array): (purpose: 'collapse' | 'thread' | 'dismiss', value: string) => string {
	const idKey = createHmac('sha256', notifyKey).update(PUSH_ID_KEY_LABEL).digest();
	return (purpose, value) => createHmac('sha256', idKey).update(`${purpose}\0${value}`).digest('hex').slice(0, PUSH_ID_HEX_LENGTH);
}
