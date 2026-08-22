/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * アプリ内更新履歴 (paradisChangelog.md) の解析モデル。
 *
 * md の構造は CLAUDE.md の「更新履歴（アプリ内changelog）の運用」で固定されている:
 *
 *   ## paracode-N（YYYY-MM-DD）
 *
 *   ### 改善
 *
 *   - 項目...
 *
 * `## paracode-N` の見出しが1リリース、`### 見出し` がカテゴリ(新機能/改善/修正など)、
 * `- ` 行が1項目。それ以外の行(# 冒頭の導入文など)は無視する。
 * 項目本文は `` `code` `` と **太字** のインライン記法のみを前提とする。
 */

export interface IParadisChangelogSection {
	readonly category: string;
	readonly items: readonly string[];
}

export interface IParadisChangelogRelease {
	/** paracode-N の N。新しいほど大きい。 */
	readonly version: number;
	readonly label: string;
	/** 見出しかち取った日付表記(YYYY-MM-DD)。無ければ undefined。 */
	readonly date?: string;
	readonly sections: readonly IParadisChangelogSection[];
}

const RELEASE_HEADING_RE = /^##\s+paracode-(\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const ITEM_RE = /^[-*]\s+(.+)$/;

interface IParsedSection {
	readonly category: string;
	readonly items: string[];
}

interface IParsedRelease {
	readonly version: number;
	readonly label: string;
	readonly date?: string;
	readonly sections: IParsedSection[];
}

export function parseParadisChangelog(markdown: string): IParadisChangelogRelease[] {
	const releases: IParadisChangelogRelease[] = [];
	let current: IParsedRelease | undefined;

	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.trimEnd();

		const releaseMatch = RELEASE_HEADING_RE.exec(line);
		if (releaseMatch) {
			current = {
				version: parseInt(releaseMatch[1], 10),
				label: `paracode-${releaseMatch[1]}`,
				date: releaseMatch[2] || undefined,
				sections: []
			};
			releases.push(current);
			continue;
		}
		if (!current) {
			continue;
		}

		const sectionMatch = SECTION_HEADING_RE.exec(line);
		if (sectionMatch) {
			current.sections.push({ category: sectionMatch[1], items: [] });
			continue;
		}

		const itemMatch = ITEM_RE.exec(line);
		if (itemMatch && current.sections.length > 0) {
			current.sections[current.sections.length - 1].items.push(itemMatch[1]);
		}
	}

	return releases;
}

/**
 * リモートと同梱の履歴を1つのリストへ統合する。重複したバージョン番号は
 * 同梱側(=実際にそのビルドへ入った確定テキスト)を優先し、結果は新しい順に並べる。
 */
export function mergeChangelogs(remote: readonly IParadisChangelogRelease[], bundled: readonly IParadisChangelogRelease[]): IParadisChangelogRelease[] {
	const byVersion = new Map<number, IParadisChangelogRelease>();
	for (const release of bundled) {
		byVersion.set(release.version, release);
	}
	for (const release of remote) {
		if (!byVersion.has(release.version)) {
			byVersion.set(release.version, release);
		}
	}
	return [...byVersion.values()].sort((a, b) => b.version - a.version);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 項目本文のインライン記法(`` `code` `` と **太字**)を HTML へ変換する。
 * 入力はまず HTML エスケープされるので、項目に書かれた生のタグは表示されるだけ。
 */
export function formatInlineMarkdown(text: string): string {
	const escaped = escapeHtml(text);
	return escaped
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
