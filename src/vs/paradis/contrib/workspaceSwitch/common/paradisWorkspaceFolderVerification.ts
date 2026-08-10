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
 *
 * **消費者は2箇所ある。同じ述語だが、飛ばした判定の役割が違う**:
 *
 * | 使用時点の実体 | `doUpdateFolders`（追加側） | `toValidWorkspaceFolders`（除外側） |
 * |---|---|---|
 * | ディレクトリのまま | 追加する（差なし） | 含める（差なし） |
 * | stat 失敗 | 追加する（差なし） | 含める（**warn ログが出ないだけ**） |
 * | ファイルに化けた | 追加しない → **追加する** | 除外する → **含める** |
 *
 * 最終行だけが本当の差で、成立するのは「切り替えの実行中にディレクトリがファイルへ
 * 置き換わった」場合に限られる。フォルダが削除されていた場合は先行 stat も失敗して
 * 台帳に載らないので、upstream の判定がそのまま走る。
 *
 * **upstream 取り込み時の確認義務**: (1) `toValidWorkspaceFolders` の try ブロックに
 * 新しい検証が増えていないか（増えていれば確認済みフォルダだけそれを丸ごと飛ばす）、
 * (2) `toValidWorkspaceFolders` / `validateWorkspaceFoldersAndReload` の呼び出し元が
 * 増えていないか（増えると台帳が「フォルダ除去の抑止装置」に化ける）。
 */
const verifiedFolders = new Set<string>();

/**
 * 台帳が実際に stat を飛ばした回数。
 *
 * **これが無いと「効いているのか」が誰にも分からない。** キーは URI の生文字列だが、
 * `toValidWorkspaceFolders` が見る URI は `.code-workspace` へ書き出して再構成された
 * 別インスタンスなので、文字列が一致しない可能性がある。外れても stat が走るだけで
 * **安全側に無言で倒れる**＝最適化が丸ごと空振りしていても気付けない。だから数える。
 */
let verifiedHits = 0;

/** ディレクトリだと確認できた URI を登録する。確認できなかったものは登録しないこと。 */
export function paradisMarkVerifiedWorkspaceFolder(uri: string): void {
	verifiedFolders.add(uri);
}

/** 適用が終わったら必ず呼ぶ。`Set.clear()` なので二重に呼んでも無害。 */
export function paradisClearVerifiedWorkspaceFolders(): void {
	verifiedFolders.clear();
}

export function paradisIsVerifiedWorkspaceFolder(uri: string): boolean {
	const hit = verifiedFolders.has(uri);
	if (hit) {
		verifiedHits++;
	}
	return hit;
}

/** 直前の切り替えで stat を飛ばせた回数を読み出して 0 に戻す。計測専用。 */
export function paradisTakeVerifiedWorkspaceFolderHits(): number {
	const hits = verifiedHits;
	verifiedHits = 0;
	return hits;
}
