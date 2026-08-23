// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as React from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, type LayoutChangeEvent, View } from 'react-native';
import { terminalFallbackPlacement } from './terminalHeaderBehavior.js';

export function TerminalBodyLayout({
	headerHeight,
	nativeMenuAvailable,
	terminalCount,
	fallback,
	onOutputLayout,
	output,
	input,
}: {
	headerHeight: number;
	nativeMenuAvailable: boolean;
	terminalCount: number;
	fallback: ReactNode;
	onOutputLayout: (event: LayoutChangeEvent) => void;
	output: ReactNode;
	input: ReactNode;
}) {
	const showFallback = terminalFallbackPlacement(nativeMenuAvailable, terminalCount) === 'body';
	return (
		<View testID="terminal-layout" style={styles.layout}>
			<View testID="terminal-body" style={[styles.terminalBody, { paddingTop: headerHeight }]}>
				{showFallback ? <View testID="terminal-fallback-band" style={styles.fallbackBand}>{fallback}</View> : null}
				<View testID="terminal-output-slot" style={styles.outputSlot} onLayout={onOutputLayout}>
					{output}
				</View>
			</View>
			<View testID="terminal-input-bar" style={styles.inputBar}>{input}</View>
		</View>
	);
}

const styles = StyleSheet.create({
	layout: { flex: 1, minHeight: 0 },
	terminalBody: { flex: 1, minHeight: 0 },
	fallbackBand: { flexShrink: 0, paddingHorizontal: 12, paddingVertical: 6 },
	outputSlot: { flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'flex-end' },
	inputBar: { paddingHorizontal: 12, paddingTop: 10 },
});
