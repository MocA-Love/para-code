/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ビューアが読むファイルを配るローカルサーバの、renderer / shared process / リモートサーバで
// 共有する定義。

/** workbench(renderer) ⇔ shared process / リモートサーバ のチャネル名。 */
export const PARADIS_HTML_PREVIEW_CHANNEL = 'paradisHtmlPreview';

/**
 * 載せたフォルダーの居場所。
 *
 * **URL ではなく port と token を返す。** リモートに載せた場合、webview から見える host は
 * リモートの port ではなく手元へ転送したポートになるため、URL の組み立ては呼び出し側でしか
 * 決められない。
 */
export interface IParadisPreviewMount {
	readonly port: number;
	readonly token: string;
}

export interface IParadisHtmlPreviewService {
	/**
	 * フォルダーをサーバに載せ、その居場所を返す。同じフォルダーを何度渡しても同じ token を返す。
	 */
	mount(directory: string): Promise<IParadisPreviewMount>;
}

/**
 * 配信 URL を組み立てる。末尾は必ず `/`。
 *
 * @param segments 載せたフォルダーからの相対セグメント（無ければフォルダー直下を指す）
 */
export function paradisPreviewUrl(mount: IParadisPreviewMount, port: number, segments: readonly string[] = []): string {
	const suffix = segments.length > 0 ? `${segments.map(encodeURIComponent).join('/')}/` : '';
	return `http://127.0.0.1:${port}/${mount.token}/${suffix}`;
}
