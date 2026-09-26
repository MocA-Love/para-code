// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Platform } from 'react-native';
import { mono } from './theme.js';

/**
 * 等幅フォント。`mono.default`（= 'monospace'）は iOS では等幅に解決されないため、
 * スタイルには常にこれを使う（`'Menlo'` の直書きもしない）。
 *
 * `theme.ts` は vitest から直接読まれるので react-native を import できない。そのため
 * プラットフォームで分岐する値だけをこのファイルに分けている。
 */
// `Platform.select` ではなく `Platform.OS` で分ける。テストの react-native モックは OS しか持たないため。
export const monoFamily: string = Platform.OS === 'ios' ? mono.ios : mono.default;
