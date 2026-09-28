// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { onKeyCommand, setKeyCommands, type KeyCommandSpec } from '../../modules/para-ipad-input/index.js';
import { isTablet } from '../hooks/useSizeClass.js';
import { routes } from '../routes.js';
import { availableShortcuts, shortcutById, type ShortcutAction, type ShortcutContext } from './shortcuts.js';
import { topSlot, useShortcutRegistry } from './shortcutRegistry.js';

/**
 * 外付けキーボードのショートカットの親（ルートレイアウトに1つだけ置く。iPad だけ）。
 *
 * 受け口（`useShortcutSlot`）の有無と今の画面から「いま効かせるもの」を決めてネイティブへ渡し、押されたら
 * 操作を受け口へ届ける。ロック中に効かないよう、AuthGate の内側に置く（外れたら全部外す）。
 */
export function ShortcutHost() {
	if (!isTablet) {
		return null;
	}
	return <ShortcutHostInner />;
}

function ShortcutHostInner() {
	const router = useRouter();
	const pathname = usePathname();
	const slots = useShortcutRegistry(s => s.slots);
	const session = slots.session[slots.session.length - 1];
	const context: ShortcutContext = {
		tabCount: session !== undefined ? session.meta : undefined,
		send: slots.send.length > 0,
		list: slots.list.length > 0,
		launch: slots.launch.length > 0,
		sidebar: slots.sidebar.length > 0,
		escape: slots.escape.length > 0,
		inSettings: pathname.startsWith('/settings'),
		inNotifications: pathname === '/notifications',
		terminalArrows: slots.terminalArrows.length > 0,
	};
	const specs: KeyCommandSpec[] = availableShortcuts(context).map(def => ({
		id: def.id, input: def.input, modifiers: def.modifiers, title: def.title, priority: def.overridesTextInput === true,
	}));
	// 中身が同じなら渡し直さない（ネイティブ側で UIKeyCommand を作り直すので）。
	const signature = specs.map(spec => spec.id).join(',');
	const specsRef = useRef(specs);
	specsRef.current = specs;
	useEffect(() => {
		setKeyCommands(specsRef.current);
	}, [signature]);
	useEffect(() => () => setKeyCommands([]), []);

	const routerRef = useRef(router);
	routerRef.current = router;
	useEffect(() => onKeyCommand(id => dispatchShortcut(id, routerRef.current)), []);
	return null;
}

/** 押されたショートカット（ID）を操作に変えて受け口へ届ける（開発ビルドではデバッガからも呼ぶ）。 */
export function dispatchShortcut(id: string, router: ReturnType<typeof useRouter>): void {
	const def = shortcutById(id);
	if (def !== undefined) {
		runShortcut(def.action, router);
	}
}

function runShortcut(action: ShortcutAction, router: ReturnType<typeof useRouter>): void {
	switch (action.kind) {
		case 'selectTab':
			topSlot('session')?.selectTab(action.index);
			return;
		case 'stepTab':
			topSlot('session')?.stepTab(action.delta);
			return;
		case 'quick':
			topSlot('session')?.openQuick();
			return;
		case 'panel':
			topSlot('session')?.openPanel(action.panel);
			return;
		case 'send':
			topSlot('send')?.send();
			return;
		case 'stepAgent':
			topSlot('list')?.stepAgent(action.delta);
			return;
		case 'launch':
			topSlot('launch')?.launch();
			return;
		case 'toggleSidebar':
			topSlot('sidebar')?.toggle();
			return;
		case 'settings':
			router.push(routes.settings());
			return;
		case 'notifications':
			router.push(routes.notifications());
			return;
		case 'escape':
			topSlot('escape')?.escape();
			return;
		case 'terminalArrow':
			topSlot('terminalArrows')?.arrow(action.key);
			return;
	}
}
