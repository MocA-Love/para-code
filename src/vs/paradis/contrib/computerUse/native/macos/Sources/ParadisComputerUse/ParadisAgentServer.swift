/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Unix ソケットで shared process からの接続を 1 本だけ受ける（設計書 6.1）。
//
//  - ソケットの置き場所は、自分のユーザーだけが入れる（0700）フォルダに限る
//  - 最初の 1 本を受けたら listen をやめ、ソケットのファイルも消す
//  - 相手の署名と親を確かめ、合わなければ何も返さずに終わる
//  - 最初の要求（handshake）のトークンが違えば終わる
//  - 接続が切れたら終わる。要求が 10 分来なくても終わる

import Darwin
import Foundation

/** 起動から接続が来るまで待つ時間。 */
private let paradisAcceptTimeoutMs: Int32 = 30_000
/** 接続から handshake が来るまで待つ時間。 */
private let paradisHandshakeTimeoutMs: Int32 = 10_000
/** 要求が来ないまま待つ時間。過ぎたら終わる（shared process は次の呼び出しで起動し直す）。 */
private let paradisIdleTimeoutMs: Int32 = 10 * 60 * 1000
/** 要求 1 行の上限（要求は小さい。応答のスクショはこの制限を受けない）。 */
private let paradisMaxRequestBytes = 1 << 20

/** 終了コード。shared process 側のログで理由を見分けるためのもの。 */
enum ParadisExitCode: Int32 {
	case normal = 0
	case badArguments = 2
	case peerRejected = 3
	case authenticationFailed = 4
	case noConnection = 5
	case socketError = 6
	case usage = 13
}

func paradisExit(_ code: ParadisExitCode, _ message: String? = nil) -> Never {
	if let message {
		fputs("[paradis-computer-use] \(message)\n", stderr)
	}
	exit(code.rawValue)
}

/**
 * トークンのファイルを読んで、すぐ消す。自分のユーザーの持ち物で、ほかの人が読めない（0600 相当）
 * 通常のファイルであること。読めても読めなくても消す。
 */
func paradisConsumeTokenFile(_ path: String) -> String? {
	defer {
		unlink(path)
	}
	let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
	guard fd >= 0 else {
		return nil
	}
	defer {
		close(fd)
	}
	var info = stat()
	guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), (info.st_mode & 0o077) == 0,
		info.st_size > 0, info.st_size <= 256
	else {
		return nil
	}
	var buffer = [UInt8](repeating: 0, count: Int(info.st_size))
	let count = read(fd, &buffer, buffer.count)
	guard count == buffer.count, let text = String(bytes: buffer, encoding: .utf8) else {
		return nil
	}
	let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
	return paradisIsWellFormedToken(token) ? token : nil
}

final class ParadisAgentServer {
	private let socketPath: String
	private let handler: ParadisRequestHandler
	private let helperIdentity: ParadisSigningIdentity
	private let mainBundleIdentifier: String

	init(socketPath: String, handler: ParadisRequestHandler, helperIdentity: ParadisSigningIdentity, mainBundleIdentifier: String) {
		self.socketPath = socketPath
		self.handler = handler
		self.helperIdentity = helperIdentity
		self.mainBundleIdentifier = mainBundleIdentifier
	}

	func run() -> Never {
		let listener = listen()
		let connection = acceptOne(listener)
		verifyPeer(connection)
		serve(connection)
	}

	// MARK: - listen / accept

	private func listen() -> Int32 {
		let directory = (socketPath as NSString).deletingLastPathComponent
		var directoryInfo = stat()
		guard lstat(directory, &directoryInfo) == 0, (directoryInfo.st_mode & S_IFMT) == S_IFDIR, directoryInfo.st_uid == getuid(),
			(directoryInfo.st_mode & 0o077) == 0
		else {
			paradisExit(.badArguments, "socket directory must be a private directory owned by the user")
		}
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let pathBytes = Array(socketPath.utf8)
		let capacity = MemoryLayout.size(ofValue: address.sun_path)
		guard pathBytes.count < capacity else {
			paradisExit(.badArguments, "socket path is too long")
		}
		withUnsafeMutableBytes(of: &address.sun_path) { raw in
			for (index, byte) in pathBytes.enumerated() {
				raw[index] = byte
			}
			raw[pathBytes.count] = 0
		}
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else {
			paradisExit(.socketError, "socket() failed: \(errno)")
		}
		_ = fcntl(fd, F_SETFD, FD_CLOEXEC)
		// 既にある場所へは作らない（shared process が毎回新しい名前を渡す）
		let bound = withUnsafePointer(to: &address) { pointer in
			pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		guard bound == 0 else {
			paradisExit(.socketError, "bind() failed: \(errno)")
		}
		chmod(socketPath, 0o600)
		guard Darwin.listen(fd, 1) == 0 else {
			unlink(socketPath)
			paradisExit(.socketError, "listen() failed: \(errno)")
		}
		return fd
	}

	private func acceptOne(_ listener: Int32) -> Int32 {
		guard paradisWaitReadable(listener, timeoutMs: paradisAcceptTimeoutMs) else {
			unlink(socketPath)
			paradisExit(.noConnection, "no connection arrived")
		}
		let connection = accept(listener, nil, nil)
		// 受けるのは 1 本だけ。すぐに listen をやめ、ソケットのファイルも消す
		close(listener)
		unlink(socketPath)
		guard connection >= 0 else {
			paradisExit(.socketError, "accept() failed: \(errno)")
		}
		_ = fcntl(connection, F_SETFD, FD_CLOEXEC)
		var noSigPipe: Int32 = 1
		setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
		return connection
	}

	private func verifyPeer(_ connection: Int32) {
		guard let facts = paradisCollectPeerFacts(socket: connection, helper: helperIdentity) else {
			paradisExit(.peerRejected, "peer could not be identified")
		}
		#if PARADIS_ALLOW_ANY_PEER
		// テスト用のビルドだけ（buildHelper.ts --allow-any-peer-for-testing）。チーム ID のある署名では効かせない
		if helperIdentity.teamIdentifier == nil {
			fputs("[paradis-computer-use] peer check skipped (testing build)\n", stderr)
			return
		}
		#endif
		if case .deny(let reason) = paradisDecidePeer(facts, mainBundleIdentifier: mainBundleIdentifier) {
			paradisExit(.peerRejected, "peer rejected: \(reason)")
		}
	}

	// MARK: - 要求を受ける

	private func serve(_ connection: Int32) -> Never {
		var buffer = ParadisLineBuffer(maxLineBytes: paradisMaxRequestBytes)
		var chunk = [UInt8](repeating: 0, count: 64 * 1024)
		while true {
			let timeout = handler.authenticated ? paradisIdleTimeoutMs : paradisHandshakeTimeoutMs
			guard paradisWaitReadable(connection, timeoutMs: timeout) else {
				if handler.authenticated {
					paradisExit(.normal, "idle timeout")
				}
				paradisExit(.authenticationFailed, "handshake did not arrive")
			}
			let count = read(connection, &chunk, chunk.count)
			if count < 0 && errno == EINTR {
				continue
			}
			guard count > 0 else {
				// 相手が切った（Para Code が終わった・作り直した）
				paradisExit(handler.authenticated ? .normal : .authenticationFailed, handler.authenticated ? nil : "connection closed before handshake")
			}
			let lines: [Data]
			do {
				lines = try buffer.append(Data(chunk[0..<count]))
			} catch {
				paradisExit(handler.authenticated ? .normal : .authenticationFailed, "request line too long")
			}
			for line in lines {
				switch handler.handle(line: line) {
				case .reply(let data):
					guard paradisWriteAll(data, to: connection) else {
						paradisExit(.normal)
					}
				case .replyAndTerminate(let data):
					if let data {
						_ = paradisWriteAll(data, to: connection)
						paradisExit(.normal)
					}
					paradisExit(.authenticationFailed, "authentication failed")
				}
			}
		}
	}
}

private func paradisWaitReadable(_ fd: Int32, timeoutMs: Int32) -> Bool {
	var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
	while true {
		let result = poll(&descriptor, 1, timeoutMs)
		if result < 0 && errno == EINTR {
			continue
		}
		return result > 0
	}
}

private func paradisWriteAll(_ data: Data, to fd: Int32) -> Bool {
	return data.withUnsafeBytes { raw -> Bool in
		guard let base = raw.baseAddress else {
			return true
		}
		var offset = 0
		while offset < raw.count {
			let written = write(fd, base.advanced(by: offset), raw.count - offset)
			if written < 0 {
				if errno == EINTR {
					continue
				}
				return false
			}
			if written == 0 {
				return false
			}
			offset += written
		}
		return true
	}
}
