/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel・Word の差分で、片側の版にファイルが無い（追加・削除されたファイル）ことを見分ける決まり。
// git の旧版は、その版に無いファイルを `FILE_NOT_FOUND` で返し、最初のコミットより前（空のツリー）は
// 0 バイトで返す。無い側だけを空のブック・空の文書として比べ、本当の読み込みの失敗はエラーのままにする。

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, toFileOperationResult } from '../../../../platform/files/common/files.js';

/** 差分の片側を読んだ結果のうち、無い側の判定に使う部分。 */
export interface IParadisOfficeDiffSide {
	readonly error?: unknown;
	/** その版にファイルがそもそも無かった。 */
	readonly absent?: boolean;
}

/** 読み込みの失敗が「その版にファイルが無い」ことを表すか。 */
export function isParadisOfficeRevisionMissing(error: unknown): boolean {
	return error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND;
}

/**
 * git の空のツリー（最初のコミットより前）を読んだ結果か。`git:` の側だけを見る。
 * 作業ツリーで 0 バイトに切り詰められたファイルは、今まで通り読めないファイルとして扱う。
 */
export function isParadisOfficeEmptyGitRevision(resource: URI, byteLength: number | undefined): boolean {
	return resource.scheme === 'git' && byteLength === 0;
}

/**
 * 片側だけが無く、もう片側を読めたときは、無い側を `empty()` に置き換える。両側とも無い、または
 * もう片側も失敗したときはそのまま返す（呼び出し側がエラーにする）。
 * git はリポジトリが見つからないときも `FILE_NOT_FOUND` を返す。両側が `git:` の比較では両側とも失敗して
 * エラーになるが、新版が作業ツリーのファイルのときは旧版が無いのと区別できず、全部が追加として見える。
 */
export function resolveParadisOfficeDiffSides<T extends IParadisOfficeDiffSide>(original: T, modified: T, empty: () => T): { readonly original: T; readonly modified: T } {
	const asEmpty = (side: T, other: T): T => side.absent && !other.absent && other.error === undefined ? empty() : side;
	return { original: asEmpty(original, modified), modified: asEmpty(modified, original) };
}

/**
 * 読み込みの失敗のうち、理由を利用者向けの文に置き換えられるもの（大きすぎる・見つからない）の文。
 * それ以外は `undefined`（呼び出し側が扱いを決める）。英語の内部メッセージにはファイルのパスや URI が入るので、
 * そのまま見せない。
 */
export function describeParadisOfficeReadFailure(error: unknown): string | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}
	switch (toFileOperationResult(error)) {
		case FileOperationResult.FILE_TOO_LARGE:
			return localize('paradis.officeDiff.tooLarge', "ファイルが大きすぎるため比較できません");
		case FileOperationResult.FILE_NOT_FOUND:
			return localize('paradis.officeDiff.notFound', "ファイルが見つかりません");
		default:
			return undefined;
	}
}

/** Word の差分の片側。`bytes` は読めた中身（空のツリーなら 0 バイト）。 */
export interface IParadisWordDiffSide extends IParadisOfficeDiffSide {
	readonly bytes?: Uint8Array;
}

/**
 * Word の差分の左右の中身を決める。無い側は空の文書（段落 1 つだけ）にする。
 * 失敗した側があれば、その失敗を投げる（旧版を先に見る）。
 */
export function resolveParadisWordDiffBytes(original: IParadisWordDiffSide, modified: IParadisWordDiffSide): { readonly original: Uint8Array; readonly modified: Uint8Array } {
	const sides = resolveParadisOfficeDiffSides(original, modified, () => ({ bytes: paradisEmptyDocxBytes(), absent: true }));
	// 両側とも読めないときは、無いのではなく本当に読めなかった側の理由を先に出す（「見つかりません」で隠さない）。
	const failed = [sides.original, sides.modified].filter(side => side.error !== undefined).sort((a, b) => Number(!!a.absent) - Number(!!b.absent));
	if (failed.length > 0) {
		throw failed[0].error;
	}
	return { original: sides.original.bytes ?? new Uint8Array(0), modified: sides.modified.bytes ?? new Uint8Array(0) };
}

/** 段落が 1 つだけの最小の .docx（A4）。無い側の文書として描く。 */
const PARADIS_EMPTY_DOCX_BASE64 = 'UEsDBBQAAAAIAAAAIQB5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAAAAhAJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAAAAIQBqgnpR4gAAAFMBAAARAAAAd29yZC9kb2N1bWVudC54bWxNkMFugzAMhl8F+b4mdCoDVNrbbpUmbXuANDEBicQoccu6p1/CNLGL7c+2/t/y8fzlpuKOIY7kOyh3Egr0mszobQefH69PNRSRlTdqIo8dPDDC+XRcWkP65tBzkQR8bJcOBua5FSLqAZ2KO5rRp1lPwSlOGKxYKJg5kMYYk76bxF7KSjg1esiSVzKPnGeRY0TNb2Fl+/5dLNmiLBtZQaqHVFf1cw3id+GiQuoyzanf1Ie8EkY7cMIXWWa8EjO5jSfs/00HVAZDB/VhxZ6IMzbNPqO98Yoy24ntNPF3s9j+cfoBUEsBAhQDFAAAAAgAAAAhAHluM9foAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAAACEAm/036q0AAAApAQAACwAAAAAAAAAAAAAAgAEZAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAAACEAaoJ6UeIAAABTAQAAEQAAAAAAAAAAAAAAgAHvAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAAAMAAAAA';

/** 最小の .docx のバイト列。呼ぶたびに新しい配列を返す（受け取った側が手放してよい）。 */
export function paradisEmptyDocxBytes(): Uint8Array {
	return decodeBase64(PARADIS_EMPTY_DOCX_BASE64).buffer;
}
