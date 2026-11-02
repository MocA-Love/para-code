/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// この端末だけに持つプリセットの表示設定（「自分だけ非表示」と「フォルダ名も表示する」）の台帳キー。
// どちらも .paracode.json やユーザー設定には書かず、ストレージに文字列キーの集合として持つ。

import { URI } from '../../../../base/common/uri.js';
import { IParadisPresetDefinition, paradisPresetFingerprint, paradisPresetFolderKey, ParadisPresetSource } from './paradisTerminalPresets.js';

/** 新しい形式のキーの先頭。旧形式（`${定義元ファイルのURI}::${指紋}`）と見分けるために付ける。 */
const LOCALLY_HIDDEN_KEY_PREFIX = 'v2::';

/** リポジトリのプリセット 1 件について、台帳で照合するキー。 */
export interface IParadisLocallyHiddenKeys {
	/** いま書き込むキー。親リポジトリの .paracode.json とプリセットの名前で決まる。 */
	readonly primary: string;
	/**
	 * 照合はするが書き込まないキー。戻すときはこれも全部消す（どれか 1 つでも残ると隠れたままになる）。
	 *  - 同じ親に属するワークツリーの .paracode.json で作った新しい形式のキー。ワークツリーの一覧が揃う前
	 *    （起動直後など）に隠すと、親へ寄せられずにワークツリーの URI で書かれるため
	 *  - 旧形式のキー（`${.paracode.json の URI}::${指紋}`）。親と、同じ親に属する全ワークツリーの分。
	 *    指紋はコマンドやフォルダの中身で変わり、URI はワークツリーごとに変わるので、旧形式では隠した状態が保てなかった
	 */
	readonly aliases: readonly string[];
}

/**
 * 「自分だけ非表示」の台帳キーを作る。
 *
 * ワークツリーは親リポジトリの .paracode.json の写しを持つので、`repositoryPresetFile` には親の
 * .paracode.json を、`relatedPresetFiles` には開いているフォルダと同じ親に属するワークツリーの
 * .paracode.json を渡す（ワークツリーを作るたびに隠したプリセットが戻らないように）。
 *
 * 同一性はプリセットの名前で決める（チームの誰かがコマンドを書き換えても、隠したままにするため）。
 * 同じファイルに同じ名前のプリセットが複数あるとき（`nameIsShared`）だけ、区別のために指紋を足す。
 * そのため仕様として、次のようにふるまう。
 *  - 隠したプリセットと同じ名前のプリセットが後から足されると、名前が重なってキーが変わり、また表示される
 *  - 隠したプリセットを消して同じ名前で作り直すと、最初から隠れている
 */
export function paradisLocallyHiddenKeys(repositoryPresetFile: URI, relatedPresetFiles: readonly URI[], definition: IParadisPresetDefinition, nameIsShared: boolean): IParadisLocallyHiddenKeys {
	const fingerprint = paradisPresetFingerprint(definition, { ignoreAppliesTo: true });
	const identity = JSON.stringify(nameIsShared ? [definition.name.trim(), fingerprint] : [definition.name.trim()]);
	const primary = `${LOCALLY_HIDDEN_KEY_PREFIX}${repositoryPresetFile.toString()}::${identity}`;
	const files = [...new Set([repositoryPresetFile, ...relatedPresetFiles].map(uri => uri.toString()))];
	const aliases = [
		...files.map(uri => `${LOCALLY_HIDDEN_KEY_PREFIX}${uri}::${identity}`),
		...files.map(uri => `${uri}::${fingerprint}`),
	].filter(key => key !== primary);
	return { primary, aliases };
}

/** 同じファイルの定義の中で、2 件以上が持っている名前（前後の空白は無視する）。 */
export function paradisSharedPresetNames(definitions: readonly { readonly name: string }[]): ReadonlySet<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const definition of definitions) {
		const name = definition.name.trim();
		if (seen.has(name)) {
			shared.add(name);
		}
		seen.add(name);
	}
	return shared;
}

/** 台帳にこのプリセットのキー（新旧どちらか）が入っているか。 */
export function paradisIsLocallyHidden(ledger: ReadonlySet<string>, keys: IParadisLocallyHiddenKeys): boolean {
	return ledger.has(keys.primary) || keys.aliases.some(key => ledger.has(key));
}

/** フォルダ名の変更で「フォルダ名も表示する」の印を移す 1 件。 */
export interface IParadisFolderLabelMove {
	readonly from: string;
	readonly to: string;
}

/**
 * フォルダ名を `oldFolder` から `newFolder` へ変えたとき、「フォルダ名も表示する」の印を移す先を返す。
 * 印のキーは保存先とフォルダ名で決まる（{@link paradisPresetFolderKey}）ので、保存先ごとに 1 件。
 * 名前が変わらない（前後の空白だけの違いを含む）ときは空。
 */
export function paradisFolderLabelMoves(presets: readonly { readonly source: ParadisPresetSource; readonly sourceUri?: URI }[], oldFolder: string, newFolder: string): readonly IParadisFolderLabelMove[] {
	if (oldFolder.trim() === newFolder.trim()) {
		return [];
	}
	const moves = new Map<string, IParadisFolderLabelMove>();
	for (const preset of presets) {
		const from = paradisPresetFolderKey(preset, oldFolder);
		if (!moves.has(from)) {
			moves.set(from, { from, to: paradisPresetFolderKey(preset, newFolder) });
		}
	}
	return [...moves.values()];
}
