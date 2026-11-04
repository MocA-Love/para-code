// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { ContextMenu, nativeContextMenuAvailable } from '../../components/contextMenu.js';
import { contextMenuOps } from '../../components/copyActions.js';
import { buildMessageMenu } from './messageMenu.js';
import { SelectableTextSheet } from './selectableTextSheet.js';

/**
 * 発言を包み、長押し（iPad では右クリックも）で発言のメニュー（`messageMenu.ts`）を出す。
 * ネイティブのメニューが無いビルドではメニューを付けない（本文の今の「長押しで全文コピー」のまま）。
 * 包んだ中の本文は `selectable` を外すこと（{@link chatTextSelectable}）。
 */
export function MessageContextMenu({ text, markdown, speaker, style, previewRadius, previewBackground, children }: {
	/** 発言の元の文字（エージェントは Markdown）。 */
	text: string;
	markdown: boolean;
	/** 「選択して読む」の見出しの下に出す、誰の発言か。 */
	speaker: string;
	style?: StyleProp<ViewStyle>;
	previewRadius?: number;
	previewBackground?: string;
	children: ReactNode;
}) {
	const [selecting, setSelecting] = useState(false);
	const menu = useMemo(
		() => nativeContextMenuAvailable && text.trim().length > 0 ? buildMessageMenu({ text, markdown }, { ...contextMenuOps(), selectRange: () => setSelecting(true) }) : undefined,
		[text, markdown],
	);
	return (
		<>
			<ContextMenu menu={menu} style={style} previewRadius={previewRadius} previewBackground={previewBackground}>
				{children}
			</ContextMenu>
			{selecting ? <SelectableTextSheet text={text} title={speaker} onClose={() => setSelecting(false)} /> : null}
		</>
	);
}

/** 発言の本文の Text に付ける `selectable`。メニューで包むビルドでは外す（同じ長押しを取り合わないように）。 */
export const chatTextSelectable = !nativeContextMenuAvailable;
