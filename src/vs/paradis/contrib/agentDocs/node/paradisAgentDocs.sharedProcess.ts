/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で、資料の台帳（hook の購読と preview_file の後の登録）と、para-browser MCP の資料のツールを足す。
// `paradis.sharedProcess.contribution.ts` から副作用 import される。台帳は利用者データの `paradis-docs/ledger.json`。

import { promises as fs } from 'fs';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import { onParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisRegisterMcpToolProvider } from '../../agentBrowser/common/paradisMcpToolProvider.js';
import { paradisRegisterPreviewFileObserver } from '../../agentBrowser/node/paradisPreviewFileObservers.js';
import { IParadisDocLedgerStorage, ParadisAgentDocsLedger } from './paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from './paradisAgentDocsService.js';
import { ParadisAgentDocsToolProvider } from './paradisAgentDocsToolProvider.js';

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

ParadisSharedProcessContributions.register('agentDocs', ({ accessor }) => {
	const logService = accessor.get(ILogService);
	const folder = join(accessor.get(INativeEnvironmentService).userDataPath, 'paradis-docs');
	const store = new DisposableStore();
	const ledger = store.add(new ParadisAgentDocsLedger(ledgerFileStorage(folder), error => logService.warn('[ParadisAgentDocs] could not read or write the document ledger', error)));
	const service = store.add(new ParadisAgentDocsService(ledger, onParadisAgentHookEvent));
	store.add(paradisRegisterPreviewFileObserver(opened => service.onPreviewFileOpened(opened)));
	store.add(paradisRegisterMcpToolProvider(new ParadisAgentDocsToolProvider(service)));
	return store;
});
