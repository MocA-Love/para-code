/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 辞書の書き出しなど、通知・読み上げの画面から文字のファイルを手元に保存する手伝い。保存先は OS の保存ダイアログで聞く
// （ブラウザの既定のダウンロード先へ黙って落とさない）。SSH などのリモートのウィンドウでも保存先は手元のディスクに
// 固定する（今までの書き出しも手元に保存していた）。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileFilter, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/** 名前をファイル名に使える形にする（パスの区切り・使えない記号・制御文字は `_`）。空なら `fallback`。 */
export function paradisNotifSafeFileName(name: string, fallback: string): string {
	const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
	return safe || fallback;
}

/**
 * 保存先を聞いて `text` を書く。取り消したときは false（書かない）。書けなかったときは例外を投げる
 * （呼び出し元が節の中に失敗を出す）。
 */
export async function paradisNotifSaveTextFile(fileDialogService: IFileDialogService, fileService: IFileService, fileName: string, text: string, filters: FileFilter[]): Promise<boolean> {
	const defaultUri = joinPath(await fileDialogService.defaultFilePath(Schemas.file), fileName);
	const target: URI | undefined = await fileDialogService.showSaveDialog({ defaultUri, filters, availableFileSystems: [Schemas.file] });
	if (!target) {
		return false;
	}
	await fileService.writeFile(target, VSBuffer.fromString(text));
	return true;
}
