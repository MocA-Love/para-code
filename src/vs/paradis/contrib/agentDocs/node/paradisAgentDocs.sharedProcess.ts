/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で、資料の台帳（hook の購読と preview_file の後の登録）、資料のコメントの保存係と届け方の係、
// para-browser MCP の資料のツールを足す。`paradis.sharedProcess.contribution.ts` から副作用 import される。
// 台帳は利用者データの `paradis-docs/ledger.json`、コメントは `paradis-docs/comments/`。

import { promises as fs } from 'fs';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { onParadisAgentAwaitingUser, onParadisAgentHookEvent, onParadisAgentTurnEnded } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { onParadisAgentTranscriptEntries } from '../../agentBrowser/node/paradisAgentTranscriptEntryBus.js';
import { paradisPaneAgentStatusSource } from '../../agentBrowser/node/paradisPaneAgentStatusSource.js';
import { paradisClaudeModBridge } from '../../claudeMod/node/paradisClaudeModBridge.js';
import { PARADIS_DOC_DELIVERY_CHANNEL } from '../common/paradisDocCommentDelivery.js';
import { PARADIS_DOC_COMMENTS_CHANNEL } from '../common/paradisDocComments.js';
import { ParadisDocCommentDelivery } from './paradisDocCommentDelivery.js';
import { ParadisDocCommentsChannel, ParadisDocDeliveryChannel, paradisDocCommentsFileStorage } from './paradisDocComments.sharedProcess.js';
import { ParadisDocCommentsStore } from './paradisDocCommentsStore.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { paradisRegisterPreviewFileObserver } from '../../agentBrowser/node/paradisPreviewFileObservers.js';
import { IParadisDocLedgerStorage, ParadisAgentDocsLedger } from './paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from './paradisAgentDocsService.js';
import { ParadisAgentDocsToolProvider } from './paradisAgentDocsToolProvider.js';
import { PARADIS_AGENT_DOCS_VIEW_CHANNEL } from '../common/paradisAgentDocsView.js';
import { ParadisAgentDocsViewChannel } from './paradisAgentDocsViewChannel.js';
import { PARADIS_DOC_EDITING_CHANNEL } from '../common/paradisDocEditing.js';
import { ParadisDocEditingChannel, ParadisDocEditingTracker } from './paradisDocEditingTracker.js';

/** 台帳のファイル。読めなければ無いものとして始め、書くときは一時ファイルから置き換える。 */
function ledgerFileStorage(folder: string): IParadisDocLedgerStorage {
	const file = join(folder, 'ledger.json');
	return {
		read: async () => {
			try {
				return await fs.readFile(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
		},
		write: async text => {
			await fs.mkdir(folder, { recursive: true });
			const temporary = join(folder, `.ledger-${generateUuid()}.tmp`);
			await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temporary, file);
		},
	};
}

ParadisSharedProcessContributions.register('agentDocs', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const folder = join(accessor.get(INativeEnvironmentService).userDataPath, 'paradis-docs');
	const store = new DisposableStore();
	const ledger = store.add(new ParadisAgentDocsLedger(ledgerFileStorage(folder), error => logService.warn('[ParadisAgentDocs] could not read or write the document ledger', error)));
	const service = store.add(new ParadisAgentDocsService(ledger, onParadisAgentHookEvent, onParadisAgentTranscriptEntries));
	const comments = store.add(new ParadisDocCommentsStore(paradisDocCommentsFileStorage(join(folder, 'comments')), error => logService.warn('[ParadisDocComments] could not read or write the comments of a document', error)));
	// 書きかけは Claude Code の入力欄の mod からだけ分かる（無ければ「分からない」）。hook は台帳が確かめた後のもの（SSH の窓の hook も使える）
	const delivery = store.add(new ParadisDocCommentDelivery(service, comments, paradisPaneAgentStatusSource, (token, session) => paradisClaudeModBridge.draftOf(token, session)?.text, service.onHook, onParadisAgentTurnEnded));
	store.add(paradisRegisterPreviewFileObserver(opened => service.onPreviewFileOpened(opened)));
	store.add(paradisRegisterMcpToolProvider(new ParadisAgentDocsToolProvider(service, comments)));
	// 「資料」ビュー（ウィンドウ）が台帳を読む・頼む口
	server.registerChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL, store.add(new ParadisAgentDocsViewChannel(service, comments)));
	// プレビューのコメントの読み書きと、持ち主のペインへ貼る口
	server.registerChannel(PARADIS_DOC_COMMENTS_CHANNEL, new ParadisDocCommentsChannel(comments, id => delivery.deliverNow(id)));
	server.registerChannel(PARADIS_DOC_DELIVERY_CHANNEL, new ParadisDocDeliveryChannel(delivery));
	// プレビューの「編集中」の印（Claude Code の PreToolUse から）
	server.registerChannel(PARADIS_DOC_EDITING_CHANNEL, new ParadisDocEditingChannel(store.add(new ParadisDocEditingTracker(service.onHook, onParadisAgentTurnEnded, onParadisAgentAwaitingUser))));
	return store;
});
