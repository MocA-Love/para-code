// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppStore } from '../src/appState.js';

/**
 * ペアリング画面: カメラでQRを読み取り、PCと接続する。
 * 読み取り後に表示されるSAS 6桁を、PC側ダイアログの6桁と突き合わせてもらう。
 */
export default function PairScreen() {
	const router = useRouter();
	const pairFromUri = useAppStore(s => s.pairFromUri);
	const [permission, requestPermission] = useCameraPermissions();
	const [sas, setSas] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [scanning, setScanning] = useState(true);

	if (!permission) {
		return <View style={styles.center}><Text style={styles.dim}>カメラを準備中…</Text></View>;
	}
	if (!permission.granted) {
		return (
			<View style={styles.center}>
				<Text style={styles.title}>カメラの許可が必要です</Text>
				<Text style={styles.dim}>QR コードを読み取るためにカメラを使用します。</Text>
				<Pressable style={styles.primaryBtn} onPress={requestPermission}><Text style={styles.primaryBtnText}>カメラを許可</Text></Pressable>
			</View>
		);
	}

	const onScan = async (data: string) => {
		if (!scanning) {
			return;
		}
		setScanning(false);
		try {
			await pairFromUri(data, deviceName(), code => setSas(code));
			// 成立 → ホームへ
			router.back();
		} catch (e) {
			setError(String(e));
			setScanning(true);
		}
	};

	if (sas) {
		return (
			<View style={styles.center}>
				<Text style={styles.title}>確認コード</Text>
				<Text style={styles.dim}>PC 側に表示されている 6 桁と一致することを確認してください。</Text>
				<Text style={styles.sas}>{sas}</Text>
				<Text style={styles.dim}>PC で「接続を承認」を押すと接続が完了します。</Text>
			</View>
		);
	}

	return (
		<View style={styles.screen}>
			<CameraView
				style={StyleSheet.absoluteFill}
				barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
				onBarcodeScanned={scanning ? ({ data }) => { void onScan(data); } : undefined}
			/>
			<View style={styles.overlay}>
				<Text style={styles.scanHint}>PC の Para Code に表示された QR を枠に収めてください</Text>
				{error ? <Text style={styles.error}>{error}</Text> : null}
			</View>
		</View>
	);
}

function deviceName(): string {
	return 'モバイルデバイス';
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#000' },
	center: { flex: 1, backgroundColor: '#0d1117', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
	title: { color: '#fff', fontSize: 22, fontWeight: '700' },
	dim: { color: '#8b8b8b', fontSize: 13, textAlign: 'center', lineHeight: 20 },
	sas: { color: '#4fc3f7', fontSize: 44, fontWeight: '700', letterSpacing: 10, fontVariant: ['tabular-nums'] },
	overlay: { position: 'absolute', bottom: 60, left: 20, right: 20, alignItems: 'center', gap: 8 },
	scanHint: { color: '#fff', fontSize: 13, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8, overflow: 'hidden' },
	error: { color: '#f48771', fontSize: 12, textAlign: 'center' },
	primaryBtn: { backgroundColor: '#007acc', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
	primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
