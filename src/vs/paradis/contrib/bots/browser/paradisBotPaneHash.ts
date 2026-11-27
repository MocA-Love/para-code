/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ウィンドウの側で、Bot のペインをトークンのハッシュで探す。shared process はトークンの値をウィンドウへ渡さず、
// ハッシュ（SHA-256）だけを渡すので、ここで自分の生きたペインのトークンをハッシュにして照らす。

import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import type { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';

/** ペイントークンの SHA-256（16 進）。shared process の `paradisBotPaneTokenHash` と同じ値。 */
export async function paradisBotPaneTokenHashInWindow(paneToken: string): Promise<string> {
	return encodeHex(VSBuffer.wrap(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paneToken)))));
}

/** このウィンドウの生きたペインのうち、ハッシュが合うもの。 */
export async function paradisBotInstancesInWindow(paneTokenService: Pick<IParadisPaneTokenService, 'listPaneTokens'>, hashes: readonly string[]): Promise<number[]> {
	if (hashes.length === 0) {
		return [];
	}
	const wanted = new Set(hashes);
	const matched: number[] = [];
	for (const { instanceId, token } of paneTokenService.listPaneTokens()) {
		if (wanted.has(await paradisBotPaneTokenHashInWindow(token))) {
			matched.push(instanceId);
		}
	}
	return matched;
}

/**
 * このウィンドウにある Bot のペイン（ハッシュが合い、閉じていないもの）と、その所属スペース。待避中（別のスペースへ
 * 切り替えて park された）ペインも数える（`listPaneTokens` は表示に関係なく全部を返す）。無ければ undefined。
 */
export async function paradisFindBotPane<T extends { readonly isDisposed: boolean }>(
	services: {
		readonly paneTokenService: Pick<IParadisPaneTokenService, 'listPaneTokens'>;
		/** 待避中のものも含めて、このウィンドウのターミナルを引く。 */
		findInstance(instanceId: number): T | undefined;
		/** ペインの所属スペース（スペースの外なら undefined）。 */
		stateKeyOf(instanceId: number): string | undefined;
	},
	hashes: readonly string[],
): Promise<{ readonly instanceId: number; readonly instance: T; readonly stateKey: string | undefined } | undefined> {
	for (const instanceId of await paradisBotInstancesInWindow(services.paneTokenService, hashes)) {
		const instance = services.findInstance(instanceId);
		if (instance !== undefined && !instance.isDisposed) {
			return { instanceId, instance, stateKey: services.stateKeyOf(instanceId) };
		}
	}
	return undefined;
}

/** Bot の台帳のうち、ペインの引き当てに要る所。 */
interface IParadisBotPaneLookup {
	readonly snapshot: { readonly bots: readonly { readonly id: string }[] };
	paneHashesOf(botId: string, purpose?: 'chat' | 'patrol'): Promise<readonly string[]>;
}

/**
 * このウィンドウにある、その Bot の会話のペイン（見回りのペインは選ばない。部屋から送る先）。
 * 無ければ undefined。
 */
export async function paradisFindBotChatPane<T extends { readonly isDisposed: boolean }>(
	services: Parameters<typeof paradisFindBotPane<T>>[0],
	botsService: Pick<IParadisBotPaneLookup, 'paneHashesOf'>,
	botId: string,
): Promise<{ readonly instanceId: number; readonly instance: T; readonly stateKey: string | undefined } | undefined> {
	return paradisFindBotPane(services, await botsService.paneHashesOf(botId, 'chat'));
}

/**
 * Para Code を終了するときに閉じる、このウィンドウの Bot のペイン（全部の Bot の会話と見回り）。終了時に閉じて、次の起動で
 * Bot の帯の付かない普通のターミナル（「zsh bot」）として復元しないために使う。会話は次の起動で Bot のページから
 * 起動し直す（再起動の後の会話の続きは、ターミナルの復元ではなく会話の id から戻す）。
 */
export async function paradisBotShutdownInstancesInWindow(
	botsService: IParadisBotPaneLookup,
	paneTokenService: Pick<IParadisPaneTokenService, 'listPaneTokens'>,
): Promise<number[]> {
	const hashes: string[] = [];
	for (const bot of botsService.snapshot.bots) {
		hashes.push(...await botsService.paneHashesOf(bot.id));
	}
	return paradisBotInstancesInWindow(paneTokenService, hashes);
}
