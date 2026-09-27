/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントのスキル（`<スキルのフォルダ>/<名前>/SKILL.md`）を読む・消す・別の場所へ入れる。
//
// 対象は Claude Code（`~/.claude/skills`、プロジェクトの `.claude/skills`）、Codex
// （`~/.codex/skills`）、両方が読む共通の `.agents/skills`（ホームとプロジェクト）。どのマシンの
// ものかは URI で区別し、ファイルの操作はすべて IFileService を通す。これで手元（file）・
// SSH の接続先（vscode-remote）・WSL（Windows から見た UNC の file）を同じ手順で扱える。
//
// Orca（stablyai/orca、MIT）の `src/shared/skill-metadata.ts`（frontmatter の読み方）と
// `src/shared/skill-deletion-eligibility.ts`（消してよいものの条件）を参考にした。Orca は
// パッケージ形式・symlink での配置・journal を持つが、ここでは「フォルダをそのまま写す」だけにする。

import { basename, dirname, extUri, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, FileSystemProviderCapabilities, IFileService, IFileStat, toFileOperationResult } from '../../../../platform/files/common/files.js';

/** スキルを読むエージェント。 */
export type ParadisSkillProvider = 'claude' | 'codex' | 'agents';
export type ParadisSkillScope = 'user' | 'project';
export type ParadisSkillHostKind = 'local' | 'remote' | 'wsl';

export interface IParadisSkillHost {
	/** `local` / `remote` / `wsl:<ディストロ>`。 */
	readonly id: string;
	readonly kind: ParadisSkillHostKind;
	readonly label: string;
	/** そのマシンのホームディレクトリ。 */
	readonly home: URI;
}

/** スキルを置くフォルダ1つ。 */
export interface IParadisSkillRoot {
	readonly id: string;
	readonly host: IParadisSkillHost;
	readonly provider: ParadisSkillProvider;
	readonly scope: ParadisSkillScope;
	/** `.../skills` のフォルダ。 */
	readonly uri: URI;
	/** プロジェクトのときのリポジトリ名。 */
	readonly projectName?: string;
}

export interface IParadisSkill {
	readonly root: IParadisSkillRoot;
	/** フォルダ名（削除・導入の単位）。 */
	readonly folderName: string;
	/** frontmatter の name（無ければフォルダ名）。 */
	readonly name: string;
	readonly description: string;
	readonly uri: URI;
	readonly skillFile: URI;
	/** フォルダがシンボリックリンク（消すとリンクだけが消え、リンク先は残る）。 */
	readonly isSymbolicLink: boolean;
	/** Codex の同梱スキル（`skills/.system/`）。更新で置き直されるので消させない。 */
	readonly bundled: boolean;
	readonly mtime?: number;
}

export interface IParadisSkillRootListing {
	readonly root: IParadisSkillRoot;
	readonly exists: boolean;
	readonly skills: readonly IParadisSkill[];
	/** 読めなかったときの理由（表示用）。 */
	readonly error?: string;
}

/** SKILL.md のうち一覧に使うために読む量。 */
const SKILL_FILE_READ_LIMIT = 64 * 1024;
/** 画面に出す SKILL.md の上限。 */
export const PARADIS_SKILL_FILE_DISPLAY_LIMIT = 256 * 1024;
/** 1 つのフォルダから読むスキルの上限（誤って巨大なフォルダを指したときに止まらないように）。 */
const MAX_SKILLS_PER_ROOT = 500;
/** 導入するフォルダの大きさの上限。 */
export const PARADIS_SKILL_INSTALL_MAX_BYTES = 40 * 1024 * 1024;
const MAX_INSTALL_FILES = 2000;

export function paradisSkillProviderLabel(provider: ParadisSkillProvider): string {
	switch (provider) {
		case 'claude': return 'Claude Code';
		case 'codex': return 'Codex';
		case 'agents': return localize('paradis.skills.provider.agents', "共通（.agents）");
	}
}

/** フォルダの表示名（「Claude Code · ユーザー」「共通（.agents） · para-code」）。 */
export function paradisSkillRootLabel(root: IParadisSkillRoot): string {
	const where = root.scope === 'user' ? localize('paradis.skills.scope.user', "ユーザー") : (root.projectName ?? localize('paradis.skills.scope.project', "プロジェクト"));
	return `${paradisSkillProviderLabel(root.provider)} · ${where}`;
}

// ---------- フォルダの一覧 ----------

export interface IParadisSkillRootPlanInput {
	readonly host: IParadisSkillHost;
	/** Claude Code の設定フォルダ（`$CLAUDE_CONFIG_DIR`。無ければ `~/.claude`）。 */
	readonly claudeConfigDir?: URI;
	/** Codex のホーム（`$CODEX_HOME`。無ければ `~/.codex`）。 */
	readonly codexHome?: URI;
	/** このマシンにあるリポジトリ（プロジェクト単位のフォルダを見る）。 */
	readonly projects: readonly { readonly name: string; readonly uri: URI }[];
}

/** 1 つのマシンについて、見るフォルダを並べる。 */
export function paradisPlanSkillRoots(input: IParadisSkillRootPlanInput): IParadisSkillRoot[] {
	const { host } = input;
	const roots: IParadisSkillRoot[] = [
		{ id: `${host.id}|claude|user`, host, provider: 'claude', scope: 'user', uri: joinPath(input.claudeConfigDir ?? joinPath(host.home, '.claude'), 'skills') },
		{ id: `${host.id}|codex|user`, host, provider: 'codex', scope: 'user', uri: joinPath(input.codexHome ?? joinPath(host.home, '.codex'), 'skills') },
		{ id: `${host.id}|agents|user`, host, provider: 'agents', scope: 'user', uri: joinPath(host.home, '.agents', 'skills') },
	];
	const seen = new Set<string>();
	for (const project of input.projects) {
		const key = extUri.getComparisonKey(project.uri);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		roots.push(
			{ id: `${host.id}|claude|project|${key}`, host, provider: 'claude', scope: 'project', projectName: project.name, uri: joinPath(project.uri, '.claude', 'skills') },
			{ id: `${host.id}|agents|project|${key}`, host, provider: 'agents', scope: 'project', projectName: project.name, uri: joinPath(project.uri, '.agents', 'skills') },
		);
	}
	return roots;
}

// ---------- frontmatter ----------

export interface IParadisSkillMetadata {
	readonly name?: string;
	readonly description?: string;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\'')))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * SKILL.md の先頭の YAML frontmatter から name と description を読む。
 *
 * YAML の全部は読まない（`key: value`、引用符、`|` / `>` のブロックだけ）。name が無ければ本文の
 * 最初の見出し、description が無ければ本文の最初の段落を使う。
 */
export function paradisParseSkillMetadata(text: string): IParadisSkillMetadata {
	const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
	const match = /^---[ \t]*\n(?<front>[\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
	const fields = new Map<string, string>();
	if (match?.groups) {
		const lines = match.groups.front.split('\n');
		for (let index = 0; index < lines.length; index++) {
			const field = /^(?<key>[A-Za-z_][\w-]*):[ \t]*(?<value>.*)$/.exec(lines[index]);
			if (!field?.groups) {
				continue;
			}
			const { key, value } = field.groups;
			if (/^[|>][+-]?$/.test(value.trim())) {
				const folded = value.trim().startsWith('>');
				const block: string[] = [];
				while (index + 1 < lines.length && (/^[ \t]+/.test(lines[index + 1]) || lines[index + 1].trim() === '')) {
					block.push(lines[++index].trim());
				}
				fields.set(key, (folded ? block.join(' ') : block.join('\n')).trim());
			} else {
				fields.set(key, unquote(value));
			}
		}
	}
	const body = match ? normalized.slice(match[0].length) : normalized;
	const heading = /^#{1,6}[ \t]+(?<title>.+)$/m.exec(body)?.groups?.title.trim();
	const paragraph = body.split(/\n{2,}/).map(part => part.trim()).find(part => part.length > 0 && !part.startsWith('#'));
	const name = fields.get('name') || heading;
	const description = fields.get('description') || (paragraph ? paragraph.replace(/\s+/g, ' ').slice(0, 240) : undefined);
	return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

// ---------- 読む ----------

function isNotFound(error: unknown): boolean {
	return error instanceof Error && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND;
}

async function readSkill(fileService: IFileService, root: IParadisSkillRoot, child: IFileStat, bundled: boolean): Promise<IParadisSkill | undefined> {
	const skillFile = joinPath(child.resource, 'SKILL.md');
	let text: string;
	try {
		text = (await fileService.readFile(skillFile, { length: SKILL_FILE_READ_LIMIT })).value.toString();
	} catch {
		return undefined;
	}
	const metadata = paradisParseSkillMetadata(text);
	return {
		root,
		folderName: child.name,
		name: metadata.name ?? child.name,
		description: metadata.description ?? '',
		uri: child.resource,
		skillFile,
		isSymbolicLink: child.isSymbolicLink,
		bundled,
		...(child.mtime !== undefined ? { mtime: child.mtime } : {}),
	};
}

/** 1 つのフォルダのスキルを読む。フォルダが無ければ `exists: false`。 */
export async function paradisListSkills(fileService: IFileService, root: IParadisSkillRoot): Promise<IParadisSkillRootListing> {
	let stat: IFileStat;
	try {
		stat = await fileService.resolve(root.uri, { resolveMetadata: true });
	} catch (error) {
		return isNotFound(error) ? { root, exists: false, skills: [] } : { root, exists: false, skills: [], error: String((error as Error)?.message ?? error) };
	}
	if (!stat.isDirectory) {
		return { root, exists: false, skills: [] };
	}
	const skills: IParadisSkill[] = [];
	const children = (stat.children ?? []).filter(child => child.isDirectory).slice(0, MAX_SKILLS_PER_ROOT);
	for (const child of children) {
		if (child.name === '.system' && root.provider === 'codex') {
			// Codex の同梱スキル。一覧には出すが消させない
			try {
				const system = await fileService.resolve(child.resource, { resolveMetadata: true });
				for (const bundled of (system.children ?? []).filter(entry => entry.isDirectory)) {
					const skill = await readSkill(fileService, root, bundled, true);
					if (skill) {
						skills.push(skill);
					}
				}
			} catch {
				// 読めなければ同梱分は出さない
			}
			continue;
		}
		if (child.name.startsWith('.')) {
			continue;
		}
		const skill = await readSkill(fileService, root, child, false);
		if (skill) {
			skills.push(skill);
		}
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return { root, exists: true, skills };
}

/** SKILL.md の中身（画面に出す分だけ）。 */
export async function paradisReadSkillFile(fileService: IFileService, skill: IParadisSkill): Promise<{ readonly text: string; readonly truncated: boolean }> {
	const content = await fileService.readFile(skill.skillFile, { length: PARADIS_SKILL_FILE_DISPLAY_LIMIT + 1 });
	const truncated = content.value.byteLength > PARADIS_SKILL_FILE_DISPLAY_LIMIT;
	return { text: (truncated ? content.value.slice(0, PARADIS_SKILL_FILE_DISPLAY_LIMIT) : content.value).toString(), truncated };
}

// ---------- 安全の確認 ----------

/** スキルのフォルダ名として受け付けるか（区切り文字・`.`・`..`・制御文字を含まない）。 */
export function paradisIsSafeSkillFolderName(name: string): boolean {
	return name.length > 0 && name.length <= 200
		&& name !== '.' && name !== '..'
		&& !name.startsWith('.')
		&& !/[\\/:\x00-\x1f\x7f]/.test(name);
}

/** そのスキルがフォルダの直下にあるか（それ以外は消さない・上書きしない）。 */
function isDirectChild(root: IParadisSkillRoot, uri: URI): boolean {
	return extUri.isEqual(dirname(uri), root.uri) && paradisIsSafeSkillFolderName(basename(uri));
}

/** 消せないときは理由を返す。 */
export function paradisSkillDeleteBlocker(skill: IParadisSkill): string | undefined {
	if (skill.bundled) {
		return localize('paradis.skills.blocked.bundled', "Codex に同梱のスキルは消せません（更新のたびに置き直されます）。");
	}
	if (!isDirectChild(skill.root, skill.uri) || skill.folderName !== basename(skill.uri)) {
		return localize('paradis.skills.blocked.outside', "スキルのフォルダの直下にないため消せません。");
	}
	return undefined;
}

/**
 * スキルを消す。ごみ箱が使えるマシン（手元）ではごみ箱へ移す。
 *
 * シンボリックリンクはリンクだけを消す（リンク先の実体には触らない）。呼ぶ前に必ず利用者に
 * 確認すること（この関数は確認しない）。
 */
export async function paradisDeleteSkill(fileService: IFileService, skill: IParadisSkill): Promise<void> {
	const blocker = paradisSkillDeleteBlocker(skill);
	if (blocker !== undefined) {
		throw new Error(blocker);
	}
	// 表示してから今までに差し替えられていないか（リンクになった・消えた）を確かめる
	const current = await fileService.resolve(skill.uri, { resolveMetadata: true });
	if (current.isSymbolicLink !== skill.isSymbolicLink || !current.isDirectory) {
		throw new Error(localize('paradis.skills.changed', "表示した後にスキルのフォルダが変わりました。一覧を読み直してから操作してください。"));
	}
	const useTrash = fileService.hasCapability(skill.uri, FileSystemProviderCapabilities.Trash);
	await fileService.del(skill.uri, { recursive: !skill.isSymbolicLink, useTrash });
}

/** ごみ箱へ移すか（確認の文言に使う）。 */
export function paradisSkillDeleteUsesTrash(fileService: IFileService, skill: IParadisSkill): boolean {
	return fileService.hasCapability(skill.uri, FileSystemProviderCapabilities.Trash);
}

/** 導入先に置く場所。 */
export function paradisSkillInstallTarget(skill: IParadisSkill, target: IParadisSkillRoot): URI {
	return joinPath(target.uri, skill.folderName);
}

/** 導入できないときは理由を返す。 */
export function paradisSkillInstallBlocker(skill: IParadisSkill, target: IParadisSkillRoot): string | undefined {
	if (!paradisIsSafeSkillFolderName(skill.folderName)) {
		return localize('paradis.skills.blocked.name', "このフォルダ名のスキルは導入できません。");
	}
	if (extUri.isEqual(skill.root.uri, target.uri)) {
		return localize('paradis.skills.blocked.same', "同じ場所へは導入できません。");
	}
	return undefined;
}

/** 写す前に大きさを数える（大きすぎる・数が多すぎるフォルダは写さない）。 */
async function measure(fileService: IFileService, uri: URI): Promise<{ bytes: number; files: number }> {
	let bytes = 0;
	let files = 0;
	const queue: URI[] = [uri];
	while (queue.length > 0) {
		const stat = await fileService.resolve(queue.shift()!, { resolveMetadata: true });
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				queue.push(child.resource);
			} else {
				bytes += child.size ?? 0;
				files++;
			}
			if (files > MAX_INSTALL_FILES || bytes > PARADIS_SKILL_INSTALL_MAX_BYTES) {
				return { bytes, files };
			}
		}
	}
	return { bytes, files };
}

/**
 * スキルのフォルダを別の場所（別のマシンを含む）へ写す。
 *
 * 同じ名前がすでにあるときは `overwrite` が true のときだけ置き換える（呼ぶ側で確認すること）。
 * いったん隣の一時フォルダへ写してから入れ替えるので、途中で失敗しても元のスキルは壊れない。
 */
export async function paradisInstallSkill(fileService: IFileService, skill: IParadisSkill, target: IParadisSkillRoot, overwrite: boolean): Promise<URI> {
	const blocker = paradisSkillInstallBlocker(skill, target);
	if (blocker !== undefined) {
		throw new Error(blocker);
	}
	const size = await measure(fileService, skill.uri);
	if (size.files > MAX_INSTALL_FILES || size.bytes > PARADIS_SKILL_INSTALL_MAX_BYTES) {
		throw new Error(localize('paradis.skills.tooLarge', "スキルのフォルダが大きすぎます（{0} MB・{1} ファイルまで）。", PARADIS_SKILL_INSTALL_MAX_BYTES / 1024 / 1024, MAX_INSTALL_FILES));
	}
	const destination = paradisSkillInstallTarget(skill, target);
	const exists = await fileService.exists(destination);
	if (exists && !overwrite) {
		throw new Error(localize('paradis.skills.exists', "導入先に同じ名前のスキルがあります。"));
	}
	await fileService.createFolder(target.uri).catch(() => undefined);
	const staging = joinPath(target.uri, `.${skill.folderName}.paradis-install-${Date.now().toString(36)}`);
	try {
		await fileService.copy(skill.uri, staging, false);
		if (exists) {
			const current = await fileService.resolve(destination);
			// 置き換えるのは直下の普通のフォルダだけ（リンクなら、リンク先には触らずリンクだけを外す）
			await fileService.del(destination, { recursive: !current.isSymbolicLink, useTrash: fileService.hasCapability(destination, FileSystemProviderCapabilities.Trash) });
		}
		await fileService.move(staging, destination, false);
	} finally {
		await fileService.del(staging, { recursive: true }).catch(() => undefined);
	}
	return destination;
}
