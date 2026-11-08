/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// G-02: ソース管理の失敗をエージェントに直させる。
// - git の操作の失敗: git 拡張のダイアログ・通知の「AI で直す」（extensions/git/src/paradisAgentFix.ts）が
//   このファイルの内部コマンドを呼ぶ。失敗の出力を添えた依頼文を、今のスペースのエージェントへ送る
// - マージの衝突: ソース管理のビューの「Merge Changes」の見出しに「AI で解決」を出す
// upstream の「Resolve Conflicts with AI」は Copilot のチャットへ渡すもので、Claude Code・Codex には渡らない。

import { Codicon } from '../../../../base/common/codicons.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISCMResourceGroup } from '../../../../workbench/contrib/scm/common/scm.js';
import { paradisHandOffToSpaceAgent, paradisSpaceAgentHandoffServices } from '../../agentHandoff/electron-browser/paradisSpaceAgentHandoff.js';
import { paradisBuildMergeConflictPrompt, paradisBuildScmFailurePrompt, paradisParseScmFailure } from '../common/paradisScmAgentFix.js';

/** git 拡張から呼ばれる内部コマンド（extensions/git/src/paradisAgentFix.ts と同じ ID）。 */
const PARADIS_FIX_SCM_FAILURE_COMMAND_ID = 'paradis.scmAgentFix.fixFailure';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_FIX_SCM_FAILURE_COMMAND_ID,
			title: localize2('paradis.scmAgentFix.fixFailure', "ソース管理の失敗をエージェントに直させる"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, raw?: unknown): Promise<void> {
		const services = paradisSpaceAgentHandoffServices(accessor);
		const failure = paradisParseScmFailure(raw);
		if (!failure) {
			return;
		}
		const rootValue = typeof raw === 'object' && raw !== null ? (raw as { readonly root?: unknown }).root : undefined;
		await paradisHandOffToSpaceAgent(services, {
			prompt: paradisBuildScmFailurePrompt(failure),
			placeholder: localize('paradis.scmAgentFix.failurePlaceholder', "失敗の出力を送るエージェントを選ぶ"),
			expectedRoot: typeof rootValue === 'string' ? URI.parse(rootValue) : undefined,
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.scmAgentFix.resolveConflicts',
			title: localize2('paradis.scmAgentFix.resolveConflicts', "AI で解決"),
			tooltip: localize('paradis.scmAgentFix.resolveConflictsTooltip', "衝突しているファイルの一覧を、このスペースの Claude Code・Codex へ送って解いてもらう"),
			icon: Codicon.sparkle,
			f1: false,
			menu: {
				id: MenuId.SCMResourceGroupContext,
				group: 'inline',
				order: -1,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.equals('scmResourceGroup', 'merge')),
			},
		});
	}

	async run(accessor: ServicesAccessor, ...groups: unknown[]): Promise<void> {
		const services = paradisSpaceAgentHandoffServices(accessor);
		const group = groups.find((candidate): candidate is ISCMResourceGroup => typeof candidate === 'object' && candidate !== null && Array.isArray((candidate as ISCMResourceGroup).resources));
		if (!group) {
			return;
		}
		const root = group.provider.rootUri;
		const files = group.resources.map(resource => (root ? relativePath(root, resource.sourceUri) : undefined) ?? resource.sourceUri.path);
		await paradisHandOffToSpaceAgent(services, {
			prompt: paradisBuildMergeConflictPrompt(files),
			placeholder: localize('paradis.scmAgentFix.conflictPlaceholder', "衝突の解決を頼むエージェントを選ぶ（{0} 件）", files.length),
			expectedRoot: root,
		});
	}
});
