/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisMobileLinkMetrics } from './paradisMobileLinkMetrics.js';

/**
 * このプロセスの通信の計測（F0）。shared process（リレーの送受信）と各ウィンドウの renderer（PTY の入出力）で別々の
 * 実体になる。renderer の分は `paradisMobileLinkMetrics.contribution.ts` が shared process へ送って 1 つにまとめる。
 * 既定はオフ（コマンド「Start Mobile Link Measurement」でオンにする）。
 */
export const paradisMobileLinkMetrics = new ParadisMobileLinkMetrics(Date.now, () => performance.now());
