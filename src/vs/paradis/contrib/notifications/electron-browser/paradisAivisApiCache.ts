/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Aivis関連API（辞書一覧・モデル情報）の結果キャッシュ。
// ParadisAivisVoiceSection と ParadisAivisDictionarySection は共に settingsService.onDidChange の
// 'aivis' スコープを購読しており、フォーマット文字列の編集やスライダー操作など辞書一覧・モデル情報と
// 無関係な変更でも再描画のたびにこれらのAPIを毎回叩き直すと、「読み込み中…」表示による本文高さの
// 変動でスクロール位置がずれる・ちらつく原因になる。モジュールスコープにキャッシュを持つことで、
// 同じ入力（APIキー / UUID）に対する再フェッチを避ける。
// ただしダイアログを閉じている間にAivisSpeech側（外部）で辞書・モデルが変更されている可能性が
// あるため、ダイアログを開き直すたびに `clearAivisApiCaches()` でキャッシュを破棄する。

import { IParadisAivisDictionaryListItem, IParadisAivisModelSummary } from '../common/paradisNotifications.js';

let dictionaryListCache = new Map<string, IParadisAivisDictionaryListItem[]>();

export function getCachedAivisDictionaryList(apiKey: string): IParadisAivisDictionaryListItem[] | undefined {
	return dictionaryListCache.get(apiKey);
}

export function setCachedAivisDictionaryList(apiKey: string, list: IParadisAivisDictionaryListItem[]): void {
	dictionaryListCache.set(apiKey, list);
}

/** 辞書の作成・削除・import等でリストが変わった直後に、次回描画時の再フェッチを促すために呼ぶ。 */
export function invalidateAivisDictionaryListCache(apiKey: string): void {
	dictionaryListCache.delete(apiKey);
}

let modelInfoCache = new Map<string, IParadisAivisModelSummary>();

export function getCachedAivisModelInfo(apiKey: string, uuid: string): IParadisAivisModelSummary | undefined {
	return modelInfoCache.get(`${apiKey} ${uuid}`);
}

/**
 * モデルが見つからない (`null`) 結果は永続キャッシュしない。AivisSpeech側でモデルが後から
 * 公開・修正される可能性があり、"見つからなかった" を固定してしまうと再描画のたびに
 * 空表示のまま復帰しなくなるため、次回描画時には毎回再確認できるようにしておく。
 */
export function setCachedAivisModelInfo(apiKey: string, uuid: string, info: IParadisAivisModelSummary | null): void {
	if (info === null) {
		return;
	}
	modelInfoCache.set(`${apiKey} ${uuid}`, info);
}

/** 通知設定ダイアログを開くたびに呼ぶ。閉じている間の外部変更を次回描画で必ず拾えるようにする。 */
export function clearAivisApiCaches(): void {
	dictionaryListCache = new Map();
	modelInfoCache = new Map();
}
