/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ElevenLabs API（声・モデル・発音辞書の一覧）の結果キャッシュ。paradisAivisApiCache.ts と同じ理由で、
// 'aivis' スコープの変更（文面の編集やスライダー操作）のたびに設定ダイアログの各セクションが描き直しても
// API を叩き直さないようにする。ダイアログを開くたびに clearElevenLabsApiCaches() で捨てる。

import { IParadisElevenLabsDictionaryListItem, IParadisElevenLabsModel, IParadisElevenLabsVoice } from '../common/paradisElevenLabs.js';

/** API キーごとに1つの値を覚える小さな表。 */
class ParadisPerKeyCache<T> {
	private entries = new Map<string, T>();

	get(apiKey: string): T | undefined {
		return this.entries.get(apiKey);
	}

	set(apiKey: string, value: T): void {
		this.entries.set(apiKey, value);
	}

	delete(apiKey: string): void {
		this.entries.delete(apiKey);
	}

	clear(): void {
		this.entries = new Map();
	}
}

export const paradisElevenLabsVoiceCache = new ParadisPerKeyCache<readonly IParadisElevenLabsVoice[]>();
export const paradisElevenLabsModelCache = new ParadisPerKeyCache<readonly IParadisElevenLabsModel[]>();
export const paradisElevenLabsDictionaryCache = new ParadisPerKeyCache<readonly IParadisElevenLabsDictionaryListItem[]>();

/** 通知設定ダイアログを開くたびに呼ぶ。閉じている間の外部変更を次回描画で必ず拾えるようにする。 */
export function clearElevenLabsApiCaches(): void {
	paradisElevenLabsVoiceCache.clear();
	paradisElevenLabsModelCache.clear();
	paradisElevenLabsDictionaryCache.clear();
}
