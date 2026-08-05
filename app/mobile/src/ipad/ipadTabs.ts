// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Ionicons } from '@expo/vector-icons';

/** サイドバー下部のセグメント1つぶんの定義。 */
export interface SidebarTab {
	/** タブのルート名（`app/(tabs)/` 配下のファイル名に対応）。 */
	name: 'index' | 'terminal' | 'scm' | 'files';
	label: string;
	href: '/' | '/terminal' | '/scm' | '/files';
	icon: keyof typeof Ionicons.glyphMap;
	iconActive: keyof typeof Ionicons.glyphMap;
	/** 応答待ち件数のバッジを出すか（iPhone版のNativeTabsと同じ2つに合わせる）。 */
	badge?: boolean;
}

/**
 * iPhone版の下部タブ（`app/(tabs)/_layout.tsx`）と同じ4つ・同じ順序・同じラベル。
 * iPadでも「同じ場所に同じものがある」ことを保つため、ここを独自に増やさない。
 */
export const SIDEBAR_TABS: readonly SidebarTab[] = [
	{ name: 'index', label: 'ホーム', href: '/', icon: 'home-outline', iconActive: 'home', badge: true },
	{ name: 'terminal', label: 'ターミナル', href: '/terminal', icon: 'terminal-outline', iconActive: 'terminal', badge: true },
	{ name: 'scm', label: 'ソース管理', href: '/scm', icon: 'git-branch-outline', iconActive: 'git-branch' },
	{ name: 'files', label: 'ファイル', href: '/files', icon: 'folder-outline', iconActive: 'folder' },
];

/**
 * タブ本体ではないが、そのタブから開くスタック画面。開いている間も出発点のタブを
 * 選択状態のままにして、「今どの区画にいるのか」を見失わせない
 * （iPhone版はスタック画面が全画面を覆うので同じ問題が起きない）。
 */
const HOME_DESCENDANTS = new Set([
	'/agent', '/agent-activity', '/agent-activity-detail', '/agent-launch',
	'/archive', '/notifications', '/browser',
]);

/**
 * 現在のパスから選択中のタブを決める。
 *
 * 設定やダッシュボード類（`/settings` `/ccusage` `/system` など）はサイドバーの
 * 設定ボタンから開くタブ非依存の画面なので、どのタブも選択しない（`undefined`）。
 */
export function activeSidebarTab(pathname: string): SidebarTab['name'] | undefined {
	// クエリやハッシュが付く場合に備えて落とす（`/browser?token=...` など）。
	const path = pathname.replace(/[?#].*$/, '');
	if (path === '/' || path === '/index' || HOME_DESCENDANTS.has(path)) {
		return 'index';
	}
	if (path === '/terminal' || path === '/scm' || path === '/files') {
		return path.slice(1) as SidebarTab['name'];
	}
	return undefined;
}
