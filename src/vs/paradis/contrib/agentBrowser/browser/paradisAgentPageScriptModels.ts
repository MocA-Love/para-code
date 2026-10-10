/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ITextModel } from '../../../../editor/common/model.js';
import { paradisParseAgentPageScriptUri } from '../common/paradisAgentBrowser.js';

/**
 * タブのスクリプトが変わったときに、そのタブのスクリプトを「中身を見る」で開いた文書を見直す。
 * 外された・本文を持っていないスクリプトの文書は `goneText` に替え、エディタのタブを開いたままでも
 * 古い本文が見え続けないようにする。スクリプトの id は使い回さないので、本文が残っている文書はそのまま。
 */
export async function paradisRefreshAgentPageScriptModels(
	models: readonly ITextModel[],
	viewId: string,
	getSource: (viewId: string, id: string) => Promise<string | undefined>,
	goneText: string,
): Promise<void> {
	await Promise.all(models.map(async model => {
		const parsed = paradisParseAgentPageScriptUri(model.uri);
		if (!parsed || parsed.viewId !== viewId) {
			return;
		}
		let source: string | undefined;
		try {
			source = await getSource(parsed.viewId, parsed.id);
		} catch {
			// 取れなかったときは決めつけず、そのままにする
			return;
		}
		if (source === undefined && !model.isDisposed() && model.getValue() !== goneText) {
			model.setValue(goneText);
		}
	}));
}
