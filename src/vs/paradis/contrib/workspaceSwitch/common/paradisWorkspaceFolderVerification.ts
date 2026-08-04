/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「このフォルダはディレクトリだと確認済み」という短命な台帳。
 *
 * `WorkspaceService.doUpdateFolders` は追加する各フォルダに `fileService.stat` を1回かける。
 * 実測ではこの1回が切り替えの中央値 322ms を占めていた（レンダラーの fileService は
 * プロバイダ越しの IPC なので、ローカルディスクでも往復ぶんの時間がかかる）。
 *
 * スペース切り替えは待ち時間の大半を他の処理に使っているので、同じ `stat` を切り替えの
 * 開始直後に投げておけば結果は `updateFolders` に着く頃には出揃っている。ここはその結果を
 * 渡すための受け渡し場所で、upstream 側は台帳に載っている URI だけ `stat` を省く。
 *
 * **確認が取れたものだけを載せること**。upstream の分岐は3通りあり、
 * 「stat 成功かつディレクトリ」＝追加、「stat 成功だがディレクトリでない」＝追加しない、
 * 「stat 失敗」＝catch で握り潰して追加、と挙動が分かれる。載せてよいのは1つ目だけで、
 * 残り2つは載せずに upstream へ委ねれば従来どおりの判定になる。
 *
 * 台帳は使い終わったら必ず捨てる（`paradisClearVerifiedWorkspaceFolders`）。残すと、切り替えと
 * 無関係な後続のフォルダ追加が古い確認結果で `stat` を飛ばしてしまう。
 */
const verifiedFolders = new Set<string>();

/** ディレクトリだと確認できた URI を登録する。確認できなかったものは登録しないこと。 */
export function paradisMarkVerifiedWorkspaceFolder(uri: string): void {
	verifiedFolders.add(uri);
}

/** 適用が終わったら必ず呼ぶ。 */
export function paradisClearVerifiedWorkspaceFolders(): void {
	verifiedFolders.clear();
}

export function paradisIsVerifiedWorkspaceFolder(uri: string): boolean {
	return verifiedFolders.has(uri);
}
