// Relais osascript : le serveur du tableau de bord (service sans fenêtre) ne peut pas faire afficher
// les demandes d'autorisation « Automatisation » de macOS (Musique, Rappels). Il fait donc exécuter
// osascript par BarreTouch, une vraie app, qui peut les afficher et en garder l'autorisation.
// Écoute uniquement sur 127.0.0.1:4748, protégé par le jeton du tableau de bord.
//   POST /osascript  {"args": ["-l","JavaScript","-e","…"], "timeout": 5}
//   → {"ok": bool, "out": "…", "err": "…", "timedOut": bool}

import Foundation
import Network

final class OsaRelay {
  private let listener: NWListener
  private let token: String
  var onWindow: (([String: Any]) -> [String: Any])?

  init?(port: UInt16, token: String) {
    self.token = token
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    params.allowLocalEndpointReuse = true
    guard let l = try? NWListener(using: params) else { log("relais osascript : port \(port) indisponible"); return nil }
    listener = l
    l.newConnectionHandler = { [weak self] c in self?.handle(c) }
    l.stateUpdateHandler = { st in
      if case .ready = st { log("relais osascript prêt sur 127.0.0.1:\(port)") }
      if case .failed(let e) = st { log("relais osascript en échec : \(e)") }
    }
    l.start(queue: .global(qos: .userInitiated))
  }

  private func handle(_ c: NWConnection) {
    c.start(queue: .global(qos: .userInitiated))
    var buf = Data()
    func readMore() {
      c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, err in
        guard let self else { c.cancel(); return }
        if let data { buf.append(data) }
        if let req = OsaRelay.parse(buf) { self.respond(c, head: req.head, body: req.body); return }
        if done || err != nil || buf.count > 4 << 20 { c.cancel(); return }
        readMore()
      }
    }
    readMore()
  }

  private static func parse(_ d: Data) -> (head: String, body: Data)? {
    guard let r = d.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: d[d.startIndex..<r.lowerBound], as: UTF8.self)
    var len = 0
    for line in head.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-length:") {
      len = Int(line.dropFirst(15).trimmingCharacters(in: .whitespaces)) ?? 0
    }
    let body = d[r.upperBound...]
    if body.count < len { return nil }
    return (head, Data(body.prefix(len)))
  }

  private func respond(_ c: NWConnection, head: String, body: Data) {
    let lines = head.components(separatedBy: "\r\n")
    let auth = lines.first { $0.lowercased().hasPrefix("authorization:") }
      .map { String($0.dropFirst(14)).trimmingCharacters(in: .whitespaces) } ?? ""
    func send(_ code: Int, _ obj: [String: Any]) {
      let payload = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
      let h = "HTTP/1.1 \(code) \(code == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\n" +
              "Content-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
      c.send(content: Data(h.utf8) + payload, completion: .contentProcessed { _ in c.cancel() })
    }
    let isWindow = lines.first?.hasPrefix("POST /window ") == true
    guard isWindow || lines.first?.hasPrefix("POST /osascript ") == true else { send(404, ["error": "inconnu"]); return }
    guard !token.isEmpty, auth == "Bearer \(token)" else { send(401, ["error": "jeton"]); return }
    if isWindow {
      // Fenêtres et tableau de bord : traité par l'app sur le fil principal (voir window.swift)
      guard let j = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let h = onWindow else {
        send(400, ["error": "requête"]); return
      }
      var r: [String: Any] = [:]
      DispatchQueue.main.sync { r = h(j) }
      send(200, r)
      return
    }
    guard let j = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let args = j["args"] as? [String] else { send(400, ["error": "requête"]); return }
    let timeout = min(max((j["timeout"] as? Double) ?? 5, 1), 180)
    send(200, OsaRelay.osascript(args, timeout: timeout))
  }

  static func osascript(_ args: [String], timeout: Double) -> [String: Any] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = args
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return ["ok": false, "out": "", "err": "\(error)", "timedOut": false] }
    var o = Data(), e = Data()
    let g = DispatchGroup()
    g.enter(); DispatchQueue.global().async { o = out.fileHandleForReading.readDataToEndOfFile(); g.leave() }
    g.enter(); DispatchQueue.global().async { e = err.fileHandleForReading.readDataToEndOfFile(); g.leave() }
    let deadline = Date().addingTimeInterval(timeout)
    var timedOut = false
    while p.isRunning {
      if Date() > deadline { p.terminate(); timedOut = true; break }
      usleep(10_000)
    }
    p.waitUntilExit()
    _ = g.wait(timeout: .now() + 2)
    return ["ok": !timedOut && p.terminationStatus == 0,
            "out": String(decoding: o, as: UTF8.self),
            "err": String(decoding: e, as: UTF8.self),
            "timedOut": timedOut]
  }
}
