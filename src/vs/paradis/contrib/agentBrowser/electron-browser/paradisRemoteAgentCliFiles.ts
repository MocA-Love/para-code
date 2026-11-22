/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンドの手引き（スキル）と Codex の規則を、SSH の接続先のホームへ置く・外す（窓が IFileService で書く）。
// 中身と決まりは `../common/paradisAgentCliSkill.ts`、手元の分は `../node/paradisAgentCliInstall.ts`。
//
// 置き場所は接続先の既定のホームだけ（`~/.claude`・`~/.agents`・`~/.codex`）。接続先の `CLAUDE_CONFIG_DIR`・`CODEX_HOME` と、
// 追加の Codex のホーム（`~/.codex-2` など）は見ない。エージェントを使っていない接続先（`~/.claude`・`~/.codex` が無い）には
// フォルダを作らない。印の無いファイルとシンボリックリンクは触らない。

import { VSBuffer } from '../../../../base/common/buffer.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IParadisAgentCliFile, PARADIS_AGENT_CLI_CODEX_RULES_CONTENT, PARADIS_AGENT_CLI_CODEX_RULES_FILE, PARADIS_AGENT_CLI_SKILL_CONTENT, PARADIS_AGENT_CLI_SKILL_DIRECTORY, paradisAgentCliFileAction } from '../common/paradisAgentCliSkill.js';

interface IRemoteAgentCliFile {
	readonly kind: IParadisAgentCliFile['kind'];
	readonly resource: URI;
	readonly content: string;
}

/** あるか・リンクか。無ければ undefined。 */
async function lookAt(fileService: IFileService, resource: URI): Promise<{ readonly link: boolean; readonly directory: boolean } | undefined> {
	try {
		const stat = await fileService.stat(resource);
		return { link: stat.isSymbolicLink, directory: stat.isDirectory };
	} catch {
		return undefined;
	}
}

async function remoteAgentCliFiles(fileService: IFileService, home: URI): Promise<IRemoteAgentCliFile[]> {
	const files: IRemoteAgentCliFile[] = [];
	if ((await lookAt(fileService, joinPath(home, '.claude')))?.directory) {
		files.push({ kind: 'claude-skill', resource: joinPath(home, '.claude', 'skills', PARADIS_AGENT_CLI_SKILL_DIRECTORY, 'SKILL.md'), content: PARADIS_AGENT_CLI_SKILL_CONTENT });
	}
	if ((await lookAt(fileService, joinPath(home, '.codex')))?.directory) {
		files.push({ kind: 'codex-skill', resource: joinPath(home, '.agents', 'skills', PARADIS_AGENT_CLI_SKILL_DIRECTORY, 'SKILL.md'), content: PARADIS_AGENT_CLI_SKILL_CONTENT });
		files.push({ kind: 'codex-rules', resource: joinPath(home, '.codex', 'rules', PARADIS_AGENT_CLI_CODEX_RULES_FILE), content: PARADIS_AGENT_CLI_CODEX_RULES_CONTENT });
	}
	return files;
}

/**
 * 接続先のホームへ置く（`enabled`）か、Para Code が置いたものを外す。
 *
 * @returns 変えたファイルの数
 */
export async function paradisSyncRemoteAgentCliFiles(fileService: IFileService, home: URI, enabled: boolean): Promise<number> {
	let changed = 0;
	for (const file of await remoteAgentCliFiles(fileService, home)) {
		const folder = dirname(file.resource);
		const [target, parent, grandParent] = await Promise.all([lookAt(fileService, file.resource), lookAt(fileService, folder), lookAt(fileService, dirname(folder))]);
		// 途中のフォルダやファイルがリンク・ファイルでないものなら、その先へは書かない
		if (target?.link || target?.directory || parent?.link || parent?.directory === false || grandParent?.link || grandParent?.directory === false) {
			continue;
		}
		const existing = target === undefined ? undefined : (await fileService.readFile(file.resource)).value.toString();
		const action = paradisAgentCliFileAction(existing, enabled ? file.content : undefined);
		if (action === 'remove') {
			await fileService.del(file.resource);
			changed++;
		} else if (action === 'write') {
			// 別名で書いてから置き換える（読んでいる途中のエージェントが書きかけを読まない）
			const staging = joinPath(folder, `.${PARADIS_AGENT_CLI_SKILL_DIRECTORY}-${generateUuid()}.tmp`);
			await fileService.writeFile(staging, VSBuffer.fromString(file.content));
			await fileService.move(staging, file.resource, true);
			changed++;
		}
	}
	return changed;
}
