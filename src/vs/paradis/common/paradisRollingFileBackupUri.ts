/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `IFileService` 越し（SSH の接続先・ウィンドウから書く設定）版の、書き換え前の控え。
// 手元の Node から書く設定は `vs/paradis/node/paradisRollingFileBackup.ts` を使う（考え方と名前は同じ）。

import { URI } from '../../base/common/uri.js';
import { IFileService } from '../../platform/files/common/files.js';

/** 控えの名前に足す接尾辞（`vs/paradis/node/paradisRollingFileBackup.ts` と同じ）。 */
const PARADIS_ROLLING_BACKUP_SUFFIX = '.paradis.bak';

/** 最初の1回だけ写す控えの接尾辞（`vs/paradis/node/paradisRollingFileBackup.ts` と同じ）。 */
const PARADIS_ORIGINAL_BACKUP_SUFFIX = '.paradis.orig.bak';

/** `file` の控えの置き場所（同じフォルダの `<名前>.paradis.bak`）。 */
export function paradisRollingBackupUri(file: URI): URI {
	return file.with({ path: `${file.path}${PARADIS_ROLLING_BACKUP_SUFFIX}` });
}

/** `file` を Para Code が初めて書き換える前の中身の置き場所（`<名前>.paradis.orig.bak`）。 */
export function paradisOriginalBackupUri(file: URI): URI {
	return file.with({ path: `${file.path}${PARADIS_ORIGINAL_BACKUP_SUFFIX}` });
}

/**
 * 利用者の設定を書き換える直前に、今の中身を1つだけ控えへ写す（上書きなので増え続けない）。
 * 写すのは `copy` なので、元のファイルの権限をそのまま引き継ぐ。設定が symlink（dotfiles の管理など）
 * なら実体を写す（`copy` はリンクをリンクのまま写すので、そのままでは控えもリンクになり、中身を
 * 残せない）。控えの場所が symlink なら写さない。
 *
 * 控えは保険なので、写せなくても書き換えは止めない（写せない理由はログへ）。
 * @returns 写したか（元のファイルが無い・写せなければ false）
 */
export async function paradisWriteRollingBackupUri(fileService: Pick<IFileService, 'exists' | 'copy' | 'realpath' | 'stat'>, file: URI, onError?: (error: unknown) => void, options?: { readonly keepOriginal?: boolean }): Promise<boolean> {
	try {
		if (!(await fileService.exists(file))) {
			return false;
		}
		const backup = paradisRollingBackupUri(file);
		if (await fileService.exists(backup) && (await fileService.stat(backup)).isSymbolicLink) {
			throw new Error(`Refusing to overwrite a symlinked backup: ${backup.path}`);
		}
		const source = await fileService.realpath(file) ?? file;
		// 頼まれたとき（hook の設定ファイル）は、最初の1回だけ元の中身も残す。既にあれば（symlink でも）触らない。
		// 秘密を持ちうるファイルには頼まない（消えない写しに古い値が残り続けるため）
		const original = paradisOriginalBackupUri(file);
		if (options?.keepOriginal && !(await fileService.exists(original))) {
			try {
				await fileService.copy(source, original, false);
			} catch {
				// 控えは保険なので、写せなくても続ける
			}
		}
		await fileService.copy(source, backup, true);
		return true;
	} catch (error) {
		onError?.(error);
		return false;
	}
}
