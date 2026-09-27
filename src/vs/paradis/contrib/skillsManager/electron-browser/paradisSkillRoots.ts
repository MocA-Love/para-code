/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スキルを探すマシンとフォルダを決める。
//
// - この PC: ホームと、このウィンドウに登録した手元のリポジトリ。`$CLAUDE_CONFIG_DIR` / `$CODEX_HOME`
//   はシェルの環境から読む（絶対パスのときだけ使う）
// - SSH の接続先: このウィンドウが接続しているときだけ。ホームは接続先から受け取ったものだけを使い、
//   分からなければ出さない（手元のホームへ取り違えない）。接続先の `$CLAUDE_CONFIG_DIR` などは見ない
// - WSL: Windows で、WSL の中のリポジトリを登録しているときだけ。ディストロのホームを UNC で開く

import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { process } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { localize } from '../../../../nls.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { paradisResolveWslAgentHome } from '../../../common/paradisWslAgentHome.js';
import { paradisRemoteUserHome } from '../../agentBrowser/common/paradisRemoteUserHome.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisSkillHost, IParadisSkillRoot, paradisPlanSkillRoots } from '../common/paradisSkills.js';

export interface IParadisSkillRootServices {
	readonly pathService: IPathService;
	readonly environmentService: IWorkbenchEnvironmentService;
	readonly labelService: ILabelService;
	readonly switchService: IParadisWorkspaceSwitchService;
	readonly logService: ILogService;
}

function absoluteDir(value: string | undefined): URI | undefined {
	const trimmed = value?.trim();
	return trimmed && isAbsolute(trimmed) ? URI.file(trimmed) : undefined;
}

/** このウィンドウから見える全マシンのスキルのフォルダ。 */
export async function paradisResolveSkillRoots(services: IParadisSkillRootServices): Promise<IParadisSkillRoot[]> {
	const repositories = services.switchService.repositories;
	const roots: IParadisSkillRoot[] = [];

	// この PC
	const localHome = services.pathService.userHome({ preferLocal: true });
	let env: Record<string, string | undefined> = {};
	try {
		env = await process.shellEnv();
	} catch (error) {
		services.logService.info('[ParadisSkills] could not read the shell environment; using the default homes', error);
	}
	const localProjects = repositories.filter(repository => repository.uri.scheme === Schemas.file && !(isWindows && paradisResolveWslAgentHome(repository.uri.fsPath)));
	roots.push(...paradisPlanSkillRoots({
		host: { id: 'local', kind: 'local', label: localize('paradis.skills.host.local', "この PC"), home: localHome },
		claudeConfigDir: absoluteDir(env.CLAUDE_CONFIG_DIR),
		codexHome: absoluteDir(env.CODEX_HOME),
		projects: localProjects,
	}));

	// SSH の接続先
	const remoteAuthority = services.environmentService.remoteAuthority;
	if (remoteAuthority) {
		try {
			const home = paradisRemoteUserHome(remoteAuthority, await services.pathService.userHome());
			if (home) {
				const host: IParadisSkillHost = {
					id: 'remote',
					kind: 'remote',
					label: localize('paradis.skills.host.remote', "接続先: {0}", services.labelService.getHostLabel(Schemas.vscodeRemote, remoteAuthority)),
					home,
				};
				roots.push(...paradisPlanSkillRoots({
					host,
					projects: repositories.filter(repository => repository.uri.scheme === Schemas.vscodeRemote && repository.uri.authority.toLowerCase() === remoteAuthority.toLowerCase()),
				}));
			}
		} catch (error) {
			services.logService.warn('[ParadisSkills] could not resolve the remote home', error);
		}
	}

	// WSL
	if (isWindows) {
		const distros = new Map<string, { host: IParadisSkillHost; projects: { name: string; uri: URI }[] }>();
		for (const repository of repositories) {
			if (repository.uri.scheme !== Schemas.file) {
				continue;
			}
			const wsl = paradisResolveWslAgentHome(repository.uri.fsPath);
			if (!wsl) {
				continue;
			}
			const key = `${wsl.distro.toLowerCase()}|${wsl.homeUncPath.toLowerCase()}`;
			let entry = distros.get(key);
			if (!entry) {
				entry = {
					host: { id: `wsl:${wsl.distro}`, kind: 'wsl', label: localize('paradis.skills.host.wsl', "WSL: {0}", wsl.distro), home: URI.file(wsl.homeUncPath) },
					projects: [],
				};
				distros.set(key, entry);
			}
			entry.projects.push({ name: repository.name, uri: repository.uri });
		}
		for (const { host, projects } of distros.values()) {
			roots.push(...paradisPlanSkillRoots({ host, projects }));
		}
	}
	return roots;
}
