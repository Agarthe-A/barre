// Page Plex de la barre : lecture sur le grand écran. Le serveur demande à BarreTouch d'ouvrir une fenêtre
// vidéo (AVPlayer, HLS de Plex relayé par le serveur) en plein écran sur l'écran principal ; la barre
// garde les commandes (lecture, pause, position, son) et peut la refermer pour reprendre la lecture
// sur la barre. Demandé via le relais local (POST /window, même jeton) :
//   {"action":"plex","op":"open","src":"http://127.0.0.1:4747/api/plex/hls/…","title":"…","volume":0.8}
//   {"action":"plex","op":"status"}    → {"open","paused","time","duration","volume","ready"}
//   {"action":"plex","op":"play"|"pause"|"seek" (time)|"volume" (value)|"close"}
// Échap ou un double clic dans la fenêtre la ferme (la barre reprend alors la lecture).

import AppKit
import AVFoundation
import AVKit

final class PlexVideoWindow: NSWindow {
  var onEscape: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53 { onEscape?() } else { super.keyDown(with: event) }
  }
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { onEscape?() }
  }
}

final class PlexWindow {
  unowned let app: App
  var window: PlexVideoWindow?
  var player: AVPlayer?
  var playerView: AVPlayerView?
  var title = ""
  var closedByUser = false
  var lastTime: Double = 0

  init(app: App) { self.app = app }

  func request(_ j: [String: Any]) -> [String: Any] {
    switch j["op"] as? String {
    case "open":
      guard let src = j["src"] as? String, let u = URL(string: src) else { return ["ok": false, "error": "src"] }
      return open(u, title: (j["title"] as? String) ?? "", volume: (j["volume"] as? Double) ?? 0.8)
    case "status":
      return status()
    case "play":
      player?.play()
      return status()
    case "pause":
      player?.pause()
      return status()
    case "seek":
      guard let p = player, let t = j["time"] as? Double else { return ["ok": false, "error": "time"] }
      let wasPlaying = p.rate > 0
      p.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 2, preferredTimescale: 600)) { _ in if wasPlaying { p.play() } }
      var s = status()
      s["time"] = max(0, t)
      return s
    case "volume":
      guard let v = j["value"] as? Double else { return ["ok": false, "error": "value"] }
      player?.volume = Float(max(0, min(1, v)))
      return status()
    case "close":
      let t = currentTime()
      close()
      return ["ok": true, "time": t]
    default:
      return ["ok": false, "error": "op inconnue"]
    }
  }

  func currentTime() -> Double {
    guard let p = player else { return lastTime }
    let t = p.currentTime().seconds
    return t.isFinite ? t : lastTime
  }

  func status() -> [String: Any] {
    guard let p = player, let w = window, w.isVisible else {
      return ["ok": true, "open": false, "time": lastTime, "closedByUser": closedByUser]
    }
    let d = p.currentItem?.duration.seconds ?? .nan
    let ready = p.currentItem?.status == .readyToPlay
    lastTime = currentTime()
    return ["ok": true, "open": true, "paused": p.rate == 0, "time": lastTime, "duration": d.isFinite ? d : NSNull(),
            "volume": Double(p.volume), "ready": ready, "title": title, "buffering": p.timeControlStatus == .waitingToPlayAtSpecifiedRate]
  }

  func open(_ url: URL, title: String, volume: Double) -> [String: Any] {
    close()
    guard let screen = app.deskScreen() else { return ["ok": false, "error": "ecran"] }
    self.title = title
    closedByUser = false
    let w = PlexVideoWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    w.level = .statusBar          // au-dessus de la barre des menus et du Dock de cet écran : vrai plein écran
    w.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
    w.backgroundColor = .black
    w.isReleasedWhenClosed = false
    w.hasShadow = false
    w.title = title
    w.onEscape = { [weak self] in self?.closedByUser = true; self?.close() }
    let item = AVPlayerItem(url: url)
    let p = AVPlayer(playerItem: item)
    p.volume = Float(max(0, min(1, volume)))
    p.automaticallyWaitsToMinimizeStalling = true
    let v = AVPlayerView(frame: NSRect(origin: .zero, size: screen.frame.size))
    v.player = p
    v.controlsStyle = .none
    v.videoGravity = .resizeAspect
    v.showsFullScreenToggleButton = false
    w.contentView = v
    w.setFrame(screen.frame, display: true)
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window = w
    player = p
    playerView = v
    p.play()
    log("Plex : « \(title) » sur le grand écran (\(screen.localizedName))")
    return ["ok": true]
  }

  func close() {
    guard window != nil || player != nil else { return }
    lastTime = currentTime()
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
    playerView?.player = nil
    playerView = nil
    window?.orderOut(nil)
    window = nil
    log("Plex : fenêtre du grand écran fermée (\(Int(lastTime)) s)")
  }
}
