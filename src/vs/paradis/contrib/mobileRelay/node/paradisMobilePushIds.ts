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
 * - collapseId: 同じエージェント（`agentToken`）の通知を置き換える。トークンが無い通知には付けない
 * - threadId: 同じスペース（`ws`）の通知をまとめる。`ws` が無ければこの PC の通知としてまとめる
 */
export function paradisMobilePushIds(notifyKey: Uint8Array, notifyBytes: Uint8Array): IParadisMobilePushIds {
	let agentToken: string | undefined;
	let ws: string | undefined;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(notifyBytes)) as { agentToken?: unknown; ws?: unknown };
		agentToken = typeof parsed.agentToken === 'string' && parsed.agentToken.length > 0 ? parsed.agentToken : undefined;
		ws = typeof parsed.ws === 'string' && parsed.ws.length > 0 ? parsed.ws : undefined;
	} catch {
		return {};
	}
	const idKey = createHmac('sha256', notifyKey).update(PUSH_ID_KEY_LABEL).digest();
	const id = (purpose: 'collapse' | 'thread', value: string) => createHmac('sha256', idKey).update(`${purpose}\0${value}`).digest('hex').slice(0, PUSH_ID_HEX_LENGTH);
	return {
		...(agentToken !== undefined ? { collapseId: id('collapse', agentToken) } : {}),
		threadId: id('thread', ws ?? ''),
	};
}
