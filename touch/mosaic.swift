// Page Discord de la barre : la mosaïque des flux (Go Live) d'un salon vocal.
//
// Discord ne donne aucun accès à ses flux vidéo, mais il sait détacher chaque stream dans sa propre
// fenêtre (« Stream de <pseudo> »), et aussi la fenêtre de l'appel entière. BarreTouch capture ces
// fenêtres (ScreenCaptureKit : elles peuvent rester derrière les autres, pas réduites dans le Dock),
// repère dans chacune la ou les vignettes vidéo (rectangles de contenu sur le fond uni de Discord,
// voir Source.analyze()) et redispose le tout en grille sur la barre, entre deux bandes de commandes
// dessinées par la page. Une fenêtre de stream donne une vignette ; la fenêtre de l'appel en donne
// autant qu'elle affiche de vidéos.
// Un appui sur une vignette la met en grand (les autres en petit sur les côtés), un nouvel appui
// revient à la grille ; un appui long (1,2 s) rend la barre au tableau de bord.
// Demandé par le serveur via le relais local (POST /window, même jeton) :
//   {"action":"discord","op":"status"}                      → état, fenêtres Discord, autorisation
//   {"action":"discord","op":"start","windows":[<id>…]}     → capture de ces fenêtres + mosaïque sur la barre
//   {"action":"discord","op":"add","window":<id>}           → une fenêtre de plus dans la mosaïque
//   {"action":"discord","op":"remove","window":<id>}
//   {"action":"discord","op":"stop"}
//   {"action":"discord","op":"focus","index":<n>}           → vignette en grand (-1 : grille)
//   {"action":"discord","op":"mode","mode":"grid"|"whole"}  → vignettes repérées, ou chaque fenêtre entière
//   {"action":"discord","op":"rescan"}                      → recommence le repérage
//   {"action":"discord","op":"snapshot"}                    → images capturées + vignettes dans ~/Library/Logs/barre/
// Demande une fois l'autorisation « Enregistrement de l'écran » pour BarreTouch.

import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreImage
import IOSurface
import ApplicationServices

/// Rectangle en blocs d'analyse (16 px du tampon capturé).
struct Box: Equatable {
  var x: Int, y: Int, w: Int, h: Int
  func near(_ o: Box, _ tol: Int) -> Bool {
    abs(x - o.x) <= tol && abs(y - o.y) <= tol && abs(w - o.w) <= tol && abs(h - o.h) <= tol
  }
}

func sameBoxes(_ a: [Box], _ b: [Box], _ tol: Int = 1) -> Bool {
  a.count == b.count && zip(a, b).allSatisfy { $0.near($1, tol) }
}

// MARK: - Une fenêtre capturée

final class Source: NSObject, SCStreamOutput, SCStreamDelegate {
  static let block = 16                        // bloc d'analyse (pixels du tampon)
  let windowID: CGWindowID
  let title: String
  unowned let owner: DiscordMosaic
  var stream: SCStream?
  let queue: DispatchQueue
  var active = false                           // premières trames reçues
  var error: String?

  // Lus sur le fil principal
  var surface: IOSurface?
  var bufW = 0, bufH = 0
  var contentPx = CGRect.zero                  // zone utile du tampon (le reste est noir)
  var tilesPx: [CGRect] = []                   // vignettes repérées (pixels du tampon, origine en haut à gauche)
  var fps = 0

  // Analyse (file `queue`)
  var current: CMSampleBuffer?
  var frames = 0
  var fpsCount = 0
  var fpsAt = Date()
  var gw = 0, gh = 0
  var meanR: [Int32] = [], meanG: [Int32] = [], meanB: [Int32] = []
  var lastChange: [Double] = []
  var primed = false
  var candidate: [Box] = []
  var rounds = 0
  var stable: [Box] = []
  var everStable = false
  var loggedFrame = false

  init(window: SCWindow, owner: DiscordMosaic) {
    windowID = window.windowID
    title = window.title ?? ""
    self.owner = owner
    queue = DispatchQueue(label: "barre.discord.\(window.windowID)", qos: .userInteractive)
  }

  /// Zone à afficher quand aucune vignette n'est repérée : le contenu entier, moins la barre de titre
  /// des fenêtres de stream (bandeau fin en haut).
  func wholeRect() -> CGRect {
    var r = contentPx.isEmpty ? CGRect(x: 0, y: 0, width: bufW, height: bufH) : contentPx
    if title.hasPrefix("Stream") && r.height > 100 {
      let top = (r.height * 0.03).rounded()
      r = CGRect(x: r.minX, y: r.minY + top, width: r.width, height: r.height - top)
    }
    return r
  }

  func begin(_ win: SCWindow, fps wanted: Int) {
    let f = win.frame
    let scale = NSScreen.screens.first { $0.frame.intersects(f) }?.backingScaleFactor ?? 2
    var w = max(2, f.width * scale), h = max(2, f.height * scale)
    if w > 1920 { h = h * 1920 / w; w = 1920 }
    if h > 1080 { w = w * 1080 / h; h = 1080 }
    let cfg = SCStreamConfiguration()
    cfg.width = Int(w.rounded()) & ~1
    cfg.height = Int(h.rounded()) & ~1
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(5, min(60, wanted))))
    cfg.queueDepth = 5
    cfg.showsCursor = false
    cfg.scalesToFit = true
    // (pas de backgroundColor : SCStreamConfiguration relâche la couleur et plante à la copie ; le fond est noir par défaut)
    if #available(macOS 14.0, *) { cfg.captureResolution = .best }
    let filter = SCContentFilter(desktopIndependentWindow: win)
    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
    do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue) } catch {
      self.error = "capture"
      log("Discord : sortie de flux refusée pour « \(title) » (\(error.localizedDescription))")
      owner.sourceFailed(self)
      return
    }
    stream = s
    s.startCapture { [weak self] err in
      DispatchQueue.main.async {
        guard let self, self.stream === s else { return }
        if let err {
          self.error = "capture"
          self.stream = nil
          log("Discord : capture impossible de « \(self.title) » (\(err.localizedDescription))")
          self.owner.sourceFailed(self)
          return
        }
        log("Discord : capture de « \(self.title) » (fenêtre \(self.windowID), \(cfg.width)×\(cfg.height))")
      }
    }
  }

  func end() {
    let s = stream
    stream = nil
    s?.stopCapture { _ in }
    active = false
    surface = nil
    queue.async { [weak self] in self?.current = nil }
  }

  func stream(_ stream: SCStream, didStopWithError err: Error) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.stream === stream else { return }
      log("Discord : flux de « \(self.title) » interrompu (\(err.localizedDescription))")
      self.stream = nil
      self.error = "fermee"
      self.owner.sourceFailed(self)
    }
  }

  func resetAnalysis() {
    gw = 0; gh = 0
    primed = false
    candidate = []; rounds = 0
    stable = []; everStable = false
    frames = 0
  }

  // MARK: trames

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb)
    var content = CGRect(x: 0, y: 0, width: W, height: H)
    if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let a = atts.first {
      if let st = a[.status] as? Int, let status = SCFrameStatus(rawValue: st), status != .complete { return }
      if let d = a[.contentRect] as? NSDictionary, let r = CGRect(dictionaryRepresentation: d as CFDictionary) {
        let sf = (a[.scaleFactor] as? CGFloat) ?? 1
        let c = CGRect(x: r.origin.x * sf, y: r.origin.y * sf, width: r.width * sf, height: r.height * sf).integral
        if c.width >= 32, c.height >= 32, c.maxX <= CGFloat(W) + 2, c.maxY <= CGFloat(H) + 2 {
          content = c.intersection(content)
        }
        if !loggedFrame {
          loggedFrame = true
          log("Discord : « \(title) » trame \(W)×\(H), contenu \(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))×\(Int(r.height)) ×\(sf)")
        }
      }
    }
    current = sb
    frames += 1
    fpsCount += 1
    let now = Date()
    if now.timeIntervalSince(fpsAt) >= 1 {
      let n = fpsCount
      fpsCount = 0
      fpsAt = now
      DispatchQueue.main.async { [weak self] in self?.fps = n }
    }
    if frames % 6 == 1 { analyze(pb, content: content) }
    guard let surface = CVPixelBufferGetIOSurface(pb)?.takeUnretainedValue() else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.stream != nil else { return }
      self.surface = surface
      var changed = !self.active
      self.active = true
      if self.bufW != W || self.bufH != H || self.contentPx != content {
        self.bufW = W; self.bufH = H; self.contentPx = content
        changed = true
      }
      if changed { self.owner.relayout() } else { self.owner.paint(self) }
    }
  }

  // MARK: repérage des vignettes

  /// Repère les vignettes : Discord pose ses vidéos (coins arrondis, petit espace entre elles) sur un
  /// fond uni. Un bloc de 16 px est « contenu » s'il a bougé dans les 4 dernières secondes ou si sa
  /// couleur n'est pas celle du fond ; les blocs de contenu collés forment les vignettes. Une nouvelle
  /// disposition n'est retenue qu'une fois vue plusieurs fois de suite (les commandes qui apparaissent
  /// au survol ne la font pas bouger). Dans une fenêtre de stream, la vignette est la vidéo elle-même,
  /// sans ses bandes noires.
  func analyze(_ pb: CVPixelBuffer, content: CGRect) {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb)
    let cx = max(0, Int(content.minX)), cy = max(0, Int(content.minY))
    let cw = min(W - cx, Int(content.width)), ch = min(H - cy, Int(content.height))
    let B = Source.block
    let ngw = cw / B, ngh = ch / B
    guard ngw >= 4, ngh >= 3 else { return }
    if ngw != gw || ngh != gh {
      gw = ngw; gh = ngh
      meanR = [Int32](repeating: 0, count: gw * gh)
      meanG = meanR; meanB = meanR
      lastChange = [Double](repeating: 0, count: gw * gh)
      primed = false
      candidate = []; rounds = 0
    }
    let p = base.assumingMemoryBound(to: UInt8.self)
    let now = Date().timeIntervalSinceReferenceDate
    @inline(__always) func px(_ x: Int, _ y: Int) -> (Int32, Int32, Int32) {
      let o = y * bpr + x * 4
      return (Int32(p[o + 2]), Int32(p[o + 1]), Int32(p[o]))   // BGRA
    }
    for by in 0..<gh {
      for bx in 0..<gw {
        let x0 = cx + bx * B, y0 = cy + by * B
        let a = px(x0 + 4, y0 + 4), b = px(x0 + 12, y0 + 4), c = px(x0 + 4, y0 + 12), d = px(x0 + 12, y0 + 12)
        let nr = (a.0 + b.0 + c.0 + d.0) >> 2, ng = (a.1 + b.1 + c.1 + d.1) >> 2, nb = (a.2 + b.2 + c.2 + d.2) >> 2
        let i = by * gw + bx
        if primed && abs(nr - meanR[i]) + abs(ng - meanG[i]) + abs(nb - meanB[i]) > 24 { lastChange[i] = now }
        meanR[i] = nr; meanG[i] = ng; meanB[i] = nb
      }
    }
    primed = true

    // Couleur du fond : la plus fréquente sur le pourtour (quantifiée à 32 niveaux)
    var hist: [Int: (n: Int, r: Int32, g: Int32, b: Int32)] = [:]
    for by in 0..<gh {
      for bx in 0..<gw where bx == 0 || by == 0 || bx == gw - 1 || by == gh - 1 {
        let i = by * gw + bx
        let k = Int(meanR[i] >> 3) << 10 | Int(meanG[i] >> 3) << 5 | Int(meanB[i] >> 3)
        var e = hist[k] ?? (0, 0, 0, 0)
        e.n += 1; e.r += meanR[i]; e.g += meanG[i]; e.b += meanB[i]
        hist[k] = e
      }
    }
    guard let top = hist.values.max(by: { $0.n < $1.n }), top.n > 0 else { return }
    let bgR = top.r / Int32(top.n), bgG = top.g / Int32(top.n), bgB = top.b / Int32(top.n)
    let isBg: (Int32, Int32, Int32) -> Bool = { r, g, b in max(abs(r - bgR), abs(g - bgG), abs(b - bgB)) <= 18 }

    var mask = [Bool](repeating: false, count: gw * gh)
    for i in 0..<(gw * gh) {
      mask[i] = (now - lastChange[i] < 4) || !isBg(meanR[i], meanG[i], meanB[i])
    }
    // Fermeture (dilatation puis érosion 3×3) : comble les petits trous dans une vignette
    func morph(_ m: [Bool], _ grow: Bool) -> [Bool] {
      var o = m
      for y in 0..<gh {
        for x in 0..<gw {
          var v = !grow
          loop: for dy in -1...1 {
            for dx in -1...1 {
              let xx = x + dx, yy = y + dy
              let inside = xx >= 0 && yy >= 0 && xx < gw && yy < gh
              let s = inside ? m[yy * gw + xx] : false
              if grow && s { v = true; break loop }
              if !grow && !s { v = false; break loop }
            }
          }
          o[y * gw + x] = v
        }
      }
      return o
    }
    mask = morph(morph(mask, true), false)

    // Composantes connexes → boîtes
    var seen = [Bool](repeating: false, count: gw * gh)
    var boxes: [Box] = []
    var stack: [Int] = []
    for start in 0..<(gw * gh) where mask[start] && !seen[start] {
      var minX = gw, minY = gh, maxX = -1, maxY = -1
      stack = [start]
      seen[start] = true
      while let i = stack.popLast() {
        let x = i % gw, y = i / gw
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        for dy in -1...1 {
          for dx in -1...1 {
            let xx = x + dx, yy = y + dy
            guard xx >= 0, yy >= 0, xx < gw, yy < gh else { continue }
            let j = yy * gw + xx
            if mask[j] && !seen[j] { seen[j] = true; stack.append(j) }
          }
        }
      }
      boxes.append(Box(x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1))
    }
    // Vignettes plausibles : au moins 112×64 px, format vidéo (de 9:16 vertical à 21:9)
    boxes = boxes.filter { b in
      let a = Double(b.w) / Double(b.h)
      return b.w >= 7 && b.h >= 4 && a >= 0.5 && a <= 2.7 && (b.w >= 10 || b.h >= 10)
    }
    // Ordre de lecture : par ligne (centres proches), puis de gauche à droite
    boxes.sort { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
    var rows: [[Box]] = []
    for b in boxes {
      if var last = rows.last, let ref = last.first, b.y < ref.y + max(1, ref.h / 2) {
        last.append(b); rows[rows.count - 1] = last
      } else {
        rows.append([b])
      }
    }
    boxes = rows.flatMap { $0.sorted { $0.x < $1.x } }

    if sameBoxes(boxes, candidate) { rounds += 1 } else { candidate = boxes; rounds = 1 }
    let need = everStable ? 8 : 2
    guard rounds >= need, !sameBoxes(candidate, stable) else { return }
    stable = candidate
    everStable = true

    // Bords au pixel près : on avance depuis le bord du bloc jusqu'à la première ligne/colonne qui
    // n'est plus du fond (coins arrondis et espaces entre vignettes exclus de la découpe).
    func refined(_ b: Box) -> CGRect {
      var x0 = cx + b.x * B, y0 = cy + b.y * B
      var x1 = min(cx + cw, x0 + b.w * B), y1 = min(cy + ch, y0 + b.h * B)
      func colHas(_ x: Int) -> Bool {
        var n = 0, t = 0
        var y = y0 + B
        while y < y1 - B { let c = px(x, y); if !isBg(c.0, c.1, c.2) { n += 1 }; t += 1; y += 6 }
        return t > 0 && n * 100 >= t * 12
      }
      func rowHas(_ y: Int) -> Bool {
        var n = 0, t = 0
        var x = x0 + B
        while x < x1 - B { let c = px(x, y); if !isBg(c.0, c.1, c.2) { n += 1 }; t += 1; x += 6 }
        return t > 0 && n * 100 >= t * 12
      }
      var k = 0
      while k < B && !colHas(x0 + k) { k += 2 }; x0 += k
      k = 0
      while k < B && !colHas(x1 - 1 - k) { k += 2 }; x1 -= k
      k = 0
      while k < B && !rowHas(y0 + k) { k += 2 }; y0 += k
      k = 0
      while k < B && !rowHas(y1 - 1 - k) { k += 2 }; y1 -= k
      return CGRect(x: x0, y: y0, width: max(16, x1 - x0), height: max(16, y1 - y0))
    }
    let found = stable.map(refined)
    log("Discord : « \(title) » : \(found.count) vignette(s)" + (found.isEmpty ? " (fenêtre entière affichée)" : " : " + found.map { "\(Int($0.width))×\(Int($0.height))@\(Int($0.minX)),\(Int($0.minY))" }.joined(separator: " ")))
    DispatchQueue.main.async { [weak self] in
      guard let self, self.stream != nil else { return }
      self.tilesPx = found
      self.owner.relayout()
      self.owner.app.mosaicChanged()
    }
  }

  /// Diagnostic : la dernière trame en PNG.
  func savePNG(to file: URL) -> Bool {
    var sb: CMSampleBuffer?
    queue.sync { sb = current }
    guard let sb, let pb = CMSampleBufferGetImageBuffer(sb) else { return false }
    let img = CIImage(cvPixelBuffer: pb)
    guard let cg = CIContext().createCGImage(img, from: img.extent),
          let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { return false }
    return (try? png.write(to: file)) != nil
  }
}

// MARK: - La mosaïque

final class DiscordMosaic {
  static let bundle = "com.hnc.Discord"
  unowned let app: App
  var stage: BarPanel?                         // fenêtre noire sous le tableau de bord : porte les vignettes
  var view: NSView!
  var sources: [Source] = []
  var active = false
  var mode = "grid"                            // grid : vignettes repérées ; whole : chaque fenêtre entière
  var focus = -1
  var error: String?
  var askedCapture = false
  var startedAt = Date.distantPast
  var layoutLogs = 0
  // Lecture de Discord par l'accessibilité (discordax.swift) : participants et streams du salon
  let axQueue = DispatchQueue(label: "barre.discord.ax", qos: .utility)
  var snap: DiscordAX.Snapshot?
  var axBusy = false
  var axAt = Date.distantPast
  var lastChannel: String?
  var job: (user: String, step: String)?       // action en cours (détacher, regarder…)
  var names: [CATextLayer] = []                // pseudos sous les vignettes
  // Image de la fenêtre Discord (capture ponctuelle) : avatars, anneau vert « parle », micro rouge
  var shotWindow: SCWindow?
  var shotWindowAt = Date.distantPast
  var shotBusy = false
  var shotAt = Date.distantPast
  var shotsWanted = true                       // false quand le serveur a la liaison RPC (voix et avatars en direct)
  var voice: [String: (speaking: Bool, muted: Bool)] = [:]
  var avatarSaved: [String: Date] = [:]
  let avatarDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/barre/data/discord-avatars")

  /// Vignettes affichées (dans l'ordre des fenêtres), leurs calques et leurs zones tactiles.
  var tiles: [(source: Source, src: CGRect)] = []
  var layers: [CALayer] = []
  var hits: [(rect: CGRect, index: Int)] = []  // repère de la barre, origine en haut à gauche

  init(app: App) {
    self.app = app
    Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.pollAX(); self?.pollShot() }
  }

  // MARK: image de la fenêtre Discord (avatars, qui parle, micros coupés)

  /// Fenêtre principale de Discord pour ScreenCaptureKit (relue toutes les 5 s : elle peut bouger).
  func refreshShotWindow() {
    guard Date().timeIntervalSince(shotWindowAt) > 5 else { return }
    shotWindowAt = Date()
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] (content: SCShareableContent?, _: Error?) in
      let w = content?.windows.first { $0.owningApplication?.bundleIdentifier == DiscordMosaic.bundle && (($0.title ?? "").hasSuffix(" - Discord") || $0.title == "Discord") }
      DispatchQueue.main.async { self?.shotWindow = w }
    }
  }

  /// Toutes les 0,3 s pendant la mosaïque (2 s sinon) : une image de la fenêtre principale, dans laquelle
  /// on lit ce que l'accessibilité ne donne pas : l'anneau vert de celui qui parle, le micro rouge, l'avatar.
  func pollShot() {
    guard app.s.discordAx, shotsWanted, !shotBusy, running(), CGPreflightScreenCaptureAccess(), let snap, snap.mainWindow,
          snap.participants.contains(where: { $0.row != nil || $0.avatar != nil }) else { return }
    guard Date().timeIntervalSince(shotAt) >= (active ? 0.3 : 2) else { return }
    refreshShotWindow()
    guard let w = shotWindow, let win = snap.mainFrame, win.width > 100, win.height > 100 else { return }
    shotBusy = true
    shotAt = Date()
    let cfg = SCStreamConfiguration()
    var cw = win.width * 2, ch = win.height * 2
    if cw > 3840 { ch = ch * 3840 / cw; cw = 3840 }
    cfg.width = Int(cw.rounded()) & ~1
    cfg.height = Int(ch.rounded()) & ~1
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = false
    cfg.scalesToFit = true
    if #available(macOS 14.0, *) { cfg.captureResolution = .best }
    let people = snap.participants
    let wantAvatars = people.filter { p in avatarSaved[p.name].map { Date().timeIntervalSince($0) > 600 } ?? true }.map { $0.name }
    SCScreenshotManager.captureSampleBuffer(contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: cfg) { [weak self] sb, err in
      guard let self else { return }
      var result: [String: (speaking: Bool, muted: Bool)] = [:]
      var saved: [String] = []
      if let sb, let pb = CMSampleBufferGetImageBuffer(sb) {
        (result, saved) = self.readShot(pb, win: win, people: people, avatars: wantAvatars, debug: false)
      } else if let err { log("Discord : image de la fenêtre impossible (\(err.localizedDescription))") }
      DispatchQueue.main.async {
        self.shotBusy = false
        for n in saved { self.avatarSaved[n] = Date() }
        if "\(result)" != "\(self.voice)" || !saved.isEmpty {
          self.voice = result
          self.app.mosaicChanged()
        }
      }
    }
  }

  /// Lecture des pixels (file de ScreenCaptureKit). Lignes de participants : avatar rond de 24 pt à gauche
  /// (anneau vert quand la personne parle), icônes rouges à droite (micro ou casque coupé).
  func readShot(_ pb: CVPixelBuffer, win: CGRect, people: [DiscordAX.Participant], avatars: [String], debug: Bool) -> ([String: (speaking: Bool, muted: Bool)], [String]) {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return ([:], []) }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb)
    let sx = CGFloat(W) / win.width, sy = CGFloat(H) / win.height
    let p = base.assumingMemoryBound(to: UInt8.self)
    @inline(__always) func px(_ x: Int, _ y: Int) -> (Int, Int, Int)? {
      guard x >= 0, y >= 0, x < W, y < H else { return nil }
      let o = y * bpr + x * 4
      return (Int(p[o + 2]), Int(p[o + 1]), Int(p[o]))
    }
    func toPx(_ r: CGRect) -> CGRect { CGRect(x: (r.minX - win.minX) * sx, y: (r.minY - win.minY) * sy, width: r.width * sx, height: r.height * sy) }
    let green = { (c: (Int, Int, Int)) in c.1 > 120 && c.0 < 100 && c.2 < 130 && c.1 > c.0 + 50 }
    let red = { (c: (Int, Int, Int)) in c.0 > 180 && c.1 < 110 && c.2 < 110 }
    var out: [String: (speaking: Bool, muted: Bool)] = [:]
    var saved: [String] = []
    let ci = CIContext()
    let img = CIImage(cvPixelBuffer: pb)
    for pp in people {
      var speaking = false, muted = false
      if let row = pp.row {
        let R = toPx(row)
        // Avatar : disque de 24 pt dont le centre est à 20 pt du bord gauche de la ligne ; anneau juste autour
        let cx = R.minX + DiscordMosaic.avatarCenterX * sx, cy = R.midY
        let radius = DiscordMosaic.avatarRadius * sx
        var g = 0, t = 0
        for rr in [radius + 0.5 * sx, radius + 1.5 * sx, radius + 2.5 * sx] {   // anneau fin collé au disque
          for k in 0..<24 {
            let a = CGFloat(k) / 24 * 2 * .pi
            if let c = px(Int(cx + cos(a) * rr), Int(cy + sin(a) * rr)) { t += 1; if green(c) { g += 1 } }
          }
        }
        speaking = t > 0 && g * 100 >= t * 15
        // Icônes de droite : rouge = micro ou casque coupé (badges et icônes connus ignorés)
        // Badge « EN DIRECT » (pilule rouge plus large que son texte) et icône du jeu : ignorés largement
        let skip = pp.badges.map { toPx($0.insetBy(dx: -16, dy: -8)) }
        var r = 0
        var x = Int(R.maxX - 52 * sx)
        while x < Int(R.maxX) {
          var y = Int(R.minY)
          while y < Int(R.maxY) {
            let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
            if !skip.contains(where: { $0.contains(pt) }), let c = px(x, y), red(c) { r += 1 }
            y += 2
          }
          x += 2
        }
        muted = r >= Int(6 * sx * sy)
        if debug { log("Discord : ligne « \(pp.name) » : anneau vert \(g)/\(t), rouge \(r)") }
      }
      out[pp.name] = (speaking, muted)
      // Avatar : le grand de la grille d'appel si visible, sinon le petit disque de la ligne
      if avatars.contains(pp.name) {
        var crop: CGRect?
        if let a = pp.avatar { crop = toPx(a).insetBy(dx: 1, dy: 1) }
        else if let row = pp.row { let R = toPx(row); let rad = DiscordMosaic.avatarRadius * sx; crop = CGRect(x: R.minX + DiscordMosaic.avatarCenterX * sx - rad, y: R.midY - rad, width: rad * 2, height: rad * 2) }
        if let c = crop?.integral, c.width >= 16, c.height >= 16, c.minX >= 0, c.minY >= 0, c.maxX <= CGFloat(W), c.maxY <= CGFloat(H) {
          let flipped = CGRect(x: c.minX, y: CGFloat(H) - c.maxY, width: c.width, height: c.height)   // Core Image : origine en bas
          if let cg = ci.createCGImage(img, from: flipped), let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
            try? FileManager.default.createDirectory(at: avatarDir, withIntermediateDirectories: true)
            if (try? png.write(to: avatarDir.appendingPathComponent(DiscordMosaic.avatarKey(pp.name) + ".png"))) != nil { saved.append(pp.name) }
          }
        }
      }
    }
    return (out, saved)
  }

  static let avatarCenterX: CGFloat = 16     // centre du disque, en points depuis le bord gauche de la ligne
  static let stripHeight: CGFloat = 84       // bandeau des participants sous les flux (dessiné par la page)
  static let avatarRadius: CGFloat = 12
  /// Nom de fichier sûr pour un pseudo : base64url.
  static func avatarKey(_ name: String) -> String {
    Data(name.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }


  /// Relit Discord toutes les 2 s quand la mosaïque est affichée, toutes les 5 s sinon (0,3 s par lecture, hors fil principal).
  func pollAX() {
    guard app.s.discordAx, !axBusy, running(), EdenWindow.trusted(prompt: false) else { return }
    guard Date().timeIntervalSince(axAt) >= (active ? 2 : 5) else { return }
    axBusy = true
    axAt = Date()
    let last = lastChannel
    axQueue.async { [weak self] in
      let s = DiscordAX.snapshot(lastChannel: last)
      DispatchQueue.main.async {
        guard let self else { return }
        self.axBusy = false
        if let s, !s.menuOpen {
          let before = self.snap.map { "\($0.dict())" }
          self.snap = s
          if let c = s.channel { self.lastChannel = c }
          if self.active, before != "\(s.dict())" { self.relayout(); self.app.mosaicChanged() }
        }
      }
    }
  }

  // MARK: zone et fenêtre

  /// Zone des flux sur la barre (repère de la page : origine en haut à gauche), entre les deux bandes.
  func area() -> CGRect {
    let f = app.barScreen()?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 720)
    let b = CGFloat(app.s.discordBands)
    return CGRect(x: b, y: 0, width: max(200, f.width - 2 * b), height: max(200, f.height - DiscordMosaic.stripHeight))
  }

  /// Bandeau des participants, sous les flux (repère de la page).
  func strip() -> CGRect {
    let a = area()
    return CGRect(x: a.minX, y: a.maxY, width: a.width, height: DiscordMosaic.stripHeight)
  }

  func running() -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: DiscordMosaic.bundle).isEmpty }

  /// Fenêtres de Discord : la principale (marquée `main`), les streams détachés, la fenêtre de l'appel.
  func windows() -> [[String: Any]] {
    let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: DiscordMosaic.bundle).map { $0.processIdentifier })
    guard !pids.isEmpty else { return [] }
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [[String: Any]] = []
    for w in list {
      guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid),
            (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
      let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
      let width = (b["Width"] as? Double) ?? 0, height = (b["Height"] as? Double) ?? 0
      guard width >= 300, height >= 200 else { continue }
      let title = w[kCGWindowName as String] as? String ?? ""
      if title.isEmpty && CGPreflightScreenCaptureAccess() { continue }   // fenêtres utilitaires sans titre (aperçus, superpositions)
      let id = w[kCGWindowNumber as String] as? Int ?? 0
      let src = sources.first { Int($0.windowID) == id }
      out.append([
        "id": id, "title": title, "w": Int(width), "h": Int(height),
        "onscreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
        "main": title.hasSuffix(" - Discord") || title == "Discord",
        "stream": title.hasPrefix("Stream"),
        "captured": src != nil,
        "live": src?.active ?? false,
        "tiles": src?.tilesPx.count ?? 0
      ])
    }
    return out
  }

  func ensureStage(on screen: NSScreen) {
    if stage == nil {
      let w = BarPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      w.level = .statusBar
      w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
      w.hidesOnDeactivate = false
      w.isMovable = false
      w.hasShadow = false
      w.ignoresMouseEvents = true
      w.isReleasedWhenClosed = false
      w.backgroundColor = .black
      let v = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
      v.wantsLayer = true
      v.layer?.backgroundColor = NSColor.black.cgColor
      w.contentView = v
      stage = w
      view = v
    }
    stage?.setFrame(screen.frame, display: true)
    view.frame = NSRect(origin: .zero, size: screen.frame.size)
  }

  /// Appelé par App.placeWindow() : la fenêtre des flux suit la barre, juste sous le tableau de bord.
  func placeStage() {
    guard active, let st = stage else { return }
    guard let sc = app.barScreen(), sc != NSScreen.screens.first else { st.orderOut(nil); return }
    st.setFrame(sc.frame, display: true)
    st.orderFrontRegardless()
  }

  // MARK: requêtes du serveur

  func request(_ j: [String: Any]) -> [String: Any] {
    switch j["op"] as? String {
    case "status":
      if let s = j["shots"] as? Bool { shotsWanted = s }
      var r = info()
      r["ok"] = true
      r["windows"] = windows()
      r["running"] = running()
      r["permission"] = CGPreflightScreenCaptureAccess()
      return r
    case "windows":
      return ["ok": true, "windows": windows()]
    case "start":
      var ids = (j["windows"] as? [Int]) ?? []
      if let one = j["window"] as? Int { ids.append(one) }
      ids = ids.filter { $0 > 0 }
      guard !ids.isEmpty else { return ["ok": false, "error": "fenetre"] }
      return start(windowIDs: ids.map { CGWindowID($0) })
    case "add":
      guard let id = j["window"] as? Int, id > 0 else { return ["ok": false, "error": "fenetre"] }
      guard active else { return start(windowIDs: [CGWindowID(id)]) }
      if sources.contains(where: { $0.windowID == CGWindowID(id) }) { return ["ok": true] }
      return capture(windowIDs: [CGWindowID(id)])
    case "remove":
      guard let id = j["window"] as? Int, let s = sources.first(where: { $0.windowID == CGWindowID(id) }) else { return ["ok": true] }
      drop(s, reason: nil)
      return ["ok": true, "active": active]
    case "stop":
      stop()
      return ["ok": true]
    case "focus":
      let i = (j["index"] as? Int) ?? -1
      focus = i >= 0 && i < tiles.count ? i : -1
      relayout()
      return ["ok": true, "focus": focus]
    case "mode":
      mode = (j["mode"] as? String) == "whole" ? "whole" : "grid"
      focus = -1
      relayout()
      return ["ok": true, "mode": mode]
    case "rescan":
      for s in sources { s.queue.async { s.resetAnalysis() } }
      return ["ok": true]
    case "snapshot":
      return snapshot()
    case "ax-dump":
      return axDump(maxNodes: (j["max"] as? Int) ?? 8000)
    case "ax-menu":
      // Diagnostic : ouvre le menu contextuel de la vignette d'un pseudo puis enregistre l'arbre
      guard let user = j["user"] as? String, let appEl = DiscordAX.appElement(),
            let main = DiscordAX.windows(appEl).first(where: { DiscordAX.title($0).hasSuffix(" - Discord") }) else { return ["ok": false, "error": "accessibilite"] }
      let list = DiscordAX.nodes(under: main)
      guard let tile = list.first(where: { $0.role == "AXButton" && $0.desc == "Vignette d'appel, stream, \(user)" }) else { return ["ok": false, "error": "vignette"] }
      let actions: [String] = { var a: CFArray?; AXUIElementCopyActionNames(tile.el, &a); return (a as? [String]) ?? [] }()
      let shown = DiscordAX.showMenu(tile.el)
      Thread.sleep(forTimeInterval: 0.7)
      let d = axDump(maxNodes: 20000)
      return ["ok": true, "shown": shown, "actions": actions, "dump": d]
    case "ax-rows":
      // Diagnostic : image de la fenêtre principale et découpe de chaque ligne de participant
      guard let snap, let w = shotWindow ?? nil, let win = snap.mainFrame else { refreshShotWindow(); return ["ok": false, "error": "pas encore de fenêtre (réessaie)"] }
      let cfg = SCStreamConfiguration()
      cfg.width = Int(win.width * 2) & ~1; cfg.height = Int(win.height * 2) & ~1
      cfg.pixelFormat = kCVPixelFormatType_32BGRA; cfg.showsCursor = false; cfg.scalesToFit = true
      if #available(macOS 14.0, *) { cfg.captureResolution = .best }
      let people = snap.participants
      let dir = logURL.deletingLastPathComponent()
      SCScreenshotManager.captureSampleBuffer(contentFilter: SCContentFilter(desktopIndependentWindow: w), configuration: cfg) { [weak self] sb, _ in
        guard let self, let sb, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let H = CGFloat(CVPixelBufferGetHeight(pb)), W = CGFloat(CVPixelBufferGetWidth(pb))
        let sx = W / win.width, sy = H / win.height
        let ci = CIContext(); let img = CIImage(cvPixelBuffer: pb)
        for (i, pp) in people.enumerated() {
          guard let row = pp.row else { continue }
          let R = CGRect(x: (row.minX - win.minX) * sx - 8, y: (row.minY - win.minY) * sy - 8, width: row.width * sx + 16, height: row.height * sy + 16).intersection(CGRect(x: 0, y: 0, width: W, height: H))
          let flipped = CGRect(x: R.minX, y: H - R.maxY, width: R.width, height: R.height)
          if let cg = ci.createCGImage(img, from: flipped), let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("discord-row-\(i + 1).png"))
          }
        }
        _ = self.readShot(pb, win: win, people: people, avatars: people.map { $0.name }, debug: true)
        log("Discord : \(people.count) ligne(s) découpée(s) dans \(dir.path) (image \(Int(W))×\(Int(H)))")
      }
      return ["ok": true, "rows": people.compactMap { $0.row.map { "\($0)" } }]
    case "touch":
      // Diagnostic : rejoue un contact sur la page (x, y en pixels de la barre), comme le tactile
      guard let kind = j["kind"] as? String, let x = j["x"] as? Double, let y = j["y"] as? Double else { return ["ok": false, "error": "kind/x/y"] }
      let nx = max(0, min(1, x / Double(app.panel.frame.width))), ny = max(0, min(1, y / Double(app.panel.frame.height)))
      app.web.evaluateJavaScript("window.__barreTouch && window.__barreTouch('\(kind)', \(nx), \(ny))", completionHandler: nil)
      return ["ok": true]
    case "js":
      // Diagnostic : évalue du JavaScript dans la page et renvoie le résultat (chaîne)
      guard let code = j["code"] as? String else { return ["ok": false, "error": "code"] }
      var out: Any = NSNull()
      var done = false
      app.web.evaluateJavaScript("(() => { try { return String(JSON.stringify((() => { \(code) })())); } catch (e) { return 'ERR ' + e.message; } })()") { r, e in out = r ?? (e.map { "ERR \($0.localizedDescription)" } ?? NSNull()); done = true }
      let deadline = Date().addingTimeInterval(3)
      while !done && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
      return ["ok": done, "result": out]
    case "ax-escape":
      DiscordAX.escape()
      return ["ok": true]
    case "ax-snapshot":
      if (j["fresh"] as? Bool) == true { snap = DiscordAX.snapshot(lastChannel: lastChannel, debug: true) }
      return ["ok": true, "snapshot": snap?.dict() ?? NSNull()]
    case "watch":
      guard let user = j["user"] as? String, !user.isEmpty else { return ["ok": false, "error": "pseudo"] }
      return watch(user: user)
    case "unwatch":
      guard let user = j["user"] as? String, !user.isEmpty else { return ["ok": false, "error": "pseudo"] }
      return unwatch(user: user)
    default:
      return ["ok": false, "error": "op inconnue"]
    }
  }

  // MARK: streams pilotés par l'accessibilité

  /// Affiche le stream d'un pseudo sur la barre : BarreTouch détache sa vignette (menu › Fenêtre détachée),
  /// appuie sur « Regarder le stream » dans la fenêtre, puis la capture. En arrière-plan ; `status.job` suit.
  func watch(user: String) -> [String: Any] {
    guard job == nil else { return ["ok": false, "error": "occupe"] }
    guard EdenWindow.trusted(prompt: false) else { return ["ok": false, "error": "accessibilite"] }
    guard CGPreflightScreenCaptureAccess() else { return start(windowIDs: [1]) }   // déclenche la demande d'autorisation
    job = (user, "detacher")
    log("Discord : « \(user) » demandé : fenêtre détachée…")
    axQueue.async { [weak self] in
      guard let self, let appEl = DiscordAX.appElement() else { DispatchQueue.main.async { self?.endJob(user, "accessibilite") }; return }
      let r = DiscordAX.popout(appEl, user: user)
      guard let w = r.window else { DispatchQueue.main.async { self.endJob(user, r.error ?? "fenetre") }; return }
      DispatchQueue.main.async { self.job = (user, "regarder") }
      // « Regarder le stream » peut mettre une seconde à apparaître dans la fenêtre fraîchement détachée
      var pressed = false
      for _ in 0..<12 {
        if DiscordAX.pressWatch(in: w) { pressed = true; break }
        Thread.sleep(forTimeInterval: 0.35)
      }
      if !pressed { log("Discord : « \(user) » : pas de bouton « Regarder le stream » (déjà en lecture ?)") }
      let title = DiscordAX.title(w)
      DispatchQueue.main.async {
        self.job = (user, "capturer")
        self.axAt = .distantPast
        let id = self.windows().first { ($0["title"] as? String) == title }?["id"] as? Int
        guard let id else { self.endJob(user, "fenetre"); return }
        if self.active { _ = self.capture(windowIDs: [CGWindowID(id)]) } else { _ = self.start(windowIDs: [CGWindowID(id)]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.endJob(user, nil) }
      }
    }
    return ["ok": true, "pending": true]
  }

  func endJob(_ user: String, _ err: String?) {
    job = nil
    if let err { error = err; log("Discord : « \(user) » : échec (\(err))") } else { log("Discord : « \(user) » sur la barre") }
    axAt = .distantPast
    app.mosaicChanged()
  }

  /// Retire le stream d'un pseudo : sa fenêtre détachée est fermée (la capture s'arrête d'elle-même).
  func unwatch(user: String) -> [String: Any] {
    guard EdenWindow.trusted(prompt: false), let appEl = DiscordAX.appElement() else { return ["ok": false, "error": "accessibilite"] }
    if let s = sources.first(where: { $0.title == "Stream de \(user)" || $0.title == "Stream from \(user)" }) { drop(s, reason: nil) }
    let ok = DiscordAX.closeStream(appEl, user: user)
    axAt = .distantPast
    log("Discord : « \(user) » retiré" + (ok ? "" : " (fenêtre non fermée)"))
    return ["ok": ok, "error": ok ? NSNull() : "fermeture"]
  }

  // MARK: démarrage / arrêt

  /// Capture ces fenêtres (en remplaçant les captures en cours). Réponse tout de suite (`pending`) :
  /// les flux démarrent en arrière-plan, `status` dit ensuite si la mosaïque est active.
  func start(windowIDs ids: [CGWindowID]) -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() {
      if !askedCapture {
        askedCapture = true
        log("Discord : autorisation « Enregistrement de l'écran » demandée pour BarreTouch")
        _ = CGRequestScreenCaptureAccess()
      }
      error = "capture-permission"
      return ["ok": false, "error": "capture-permission"]
    }
    guard let bar = app.barScreen(), bar != NSScreen.screens.first else { return ["ok": false, "error": "barre-absente"] }
    // On garde les fenêtres déjà capturées qui restent demandées ; les autres s'arrêtent.
    for s in sources where !ids.contains(s.windowID) { s.end() }
    sources.removeAll { !ids.contains($0.windowID) }
    error = nil
    focus = -1
    if !active {
      startedAt = Date()
      active = true
      ensureStage(on: bar)
      app.setMosaicMode(true)
    }
    let missing = ids.filter { id in !sources.contains { $0.windowID == id } }
    relayout()
    return missing.isEmpty ? ["ok": true] : capture(windowIDs: missing)
  }

  func capture(windowIDs ids: [CGWindowID], enlarged: Bool = false) -> [String: Any] {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] (content: SCShareableContent?, err: Error?) in
      DispatchQueue.main.async {
        guard let self, self.active else { return }
        let wins = ids.compactMap { id in content?.windows.first { $0.windowID == id } }
        if wins.count < ids.count {
          self.error = "fenetre"
          log("Discord : fenêtre introuvable (\(ids.filter { id in !wins.contains { $0.windowID == id } })\(err.map { ", \($0.localizedDescription)" } ?? ""))")
        }
        // Petites fenêtres agrandies d'abord (capture nette), puis on relit leur taille avant de capturer
        if !enlarged, wins.contains(where: { self.enlarge($0) }) {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { _ = self.capture(windowIDs: wins.map { $0.windowID }, enlarged: true) }
          return
        }
        for win in wins where !self.sources.contains(where: { $0.windowID == win.windowID }) {
          let s = Source(window: win, owner: self)
          self.sources.append(s)
          s.begin(win, fps: self.app.s.discordFps)
        }
        if self.sources.isEmpty { self.stop(reason: self.error ?? "fenetre") }
      }
    }
    return ["ok": true, "pending": true]
  }

  /// Fenêtre de stream ou d'appel trop petite : on l'agrandit (via Accessibilité) pour une capture nette.
  /// Elle reste à sa place et peut passer derrière les autres : la capture n'en dépend pas.
  @discardableResult
  func enlarge(_ win: SCWindow) -> Bool {
    let title = win.title ?? ""
    guard app.s.discordEnlarge, win.frame.width < 1280, !title.isEmpty, !title.hasSuffix(" - Discord"),
          EdenWindow.trusted(prompt: false),
          let d = NSRunningApplication.runningApplications(withBundleIdentifier: DiscordMosaic.bundle).first,
          let desk = app.deskScreen() else { return false }
    let ax = AXUIElementCreateApplication(d.processIdentifier)
    let ws: [AXUIElement] = EdenWindow.attr(ax, kAXWindowsAttribute) ?? []
    guard let w = ws.first(where: { (EdenWindow.attr($0, kAXTitleAttribute) as String?) == title }),
          let f = EdenWindow.frame(w) else { return false }
    let vf = EdenWindow.axRect(desk.visibleFrame)
    let width = min(1600, vf.width - 20)
    let height = min(vf.height - 20, (width * f.height / max(1, f.width)).rounded())
    let x = min(max(f.minX, vf.minX + 10), vf.maxX - width - 10)
    let y = min(max(f.minY, vf.minY + 10), vf.maxY - height - 10)
    EdenWindow.setFrame(w, CGRect(x: x, y: y, width: width, height: height))
    log("Discord : fenêtre « \(title) » agrandie en \(Int(width))×\(Int(height))")
    return true
  }

  func sourceFailed(_ s: Source) {
    drop(s, reason: s.error)
  }

  func drop(_ s: Source, reason: String?) {
    s.end()
    sources.removeAll { $0 === s }
    if let reason { error = reason }
    log("Discord : « \(s.title) » retirée de la mosaïque" + (reason.map { " (\($0))" } ?? ""))
    if sources.isEmpty { stop(reason: reason) } else { relayout(); app.mosaicChanged() }
  }

  func stop(reason: String? = nil) {
    for s in sources { s.end() }
    sources = []
    let wasActive = active
    active = false
    for l in layers { l.removeFromSuperlayer() }
    for n in names { n.removeFromSuperlayer() }
    layers = []
    names = []
    hits = []
    tiles = []
    focus = -1
    stage?.orderOut(nil)
    if let reason { error = reason }
    if app.mosaicMode { app.setMosaicMode(false) }
    if wasActive { log("Discord : mosaïque arrêtée" + (reason.map { " (\($0))" } ?? "")) }
  }

  // MARK: disposition sur la barre

  func fit(_ aspect: CGFloat, in r: CGRect) -> CGRect {
    var w = r.width, h = w / aspect
    if h > r.height { h = r.height; w = h * aspect }
    return CGRect(x: (r.midX - w / 2).rounded(), y: (r.midY - h / 2).rounded(), width: w.rounded(), height: h.rounded())
  }

  /// Grille qui donne les plus grandes vignettes possibles (dernière ligne centrée).
  func gridLayout(_ aspects: [CGFloat], in area: CGRect, gap: CGFloat = 12) -> [CGRect] {
    let n = aspects.count
    guard n > 0 else { return [] }
    let mean = aspects.reduce(0, +) / CGFloat(n)
    var best = (cols: 1, rows: n, tileW: CGFloat(0))
    for cols in 1...n {
      let rows = (n + cols - 1) / cols
      let cellW = (area.width - gap * CGFloat(cols - 1)) / CGFloat(cols)
      let cellH = (area.height - gap * CGFloat(rows - 1)) / CGFloat(rows)
      let tw = min(cellW, cellH * mean)
      if tw > best.tileW { best = (cols, rows, tw) }
    }
    let cols = best.cols, rows = best.rows
    let cellW = (area.width - gap * CGFloat(cols - 1)) / CGFloat(cols)
    let cellH = (area.height - gap * CGFloat(rows - 1)) / CGFloat(rows)
    var rects: [CGRect] = []
    for r in 0..<rows {
      let inRow = min(cols, n - r * cols)
      let rowW = CGFloat(inRow) * cellW + gap * CGFloat(inRow - 1)
      let x0 = area.minX + (area.width - rowW) / 2
      let y0 = area.minY + CGFloat(r) * (cellH + gap)
      for c in 0..<inRow {
        let a = aspects[r * cols + c]
        let w = min(cellW, cellH * a), h = w / a
        rects.append(CGRect(x: (x0 + CGFloat(c) * (cellW + gap) + (cellW - w) / 2).rounded(), y: (y0 + (cellH - h) / 2).rounded(), width: w.rounded(), height: h.rounded()))
      }
    }
    return rects
  }

  /// Une vignette en grand au centre, les autres en petit dans deux colonnes de part et d'autre.
  func focusLayout(_ aspects: [CGFloat], focus f: Int, in area: CGRect) -> [CGRect] {
    let strip: CGFloat = 164
    var rects = [CGRect](repeating: .zero, count: aspects.count)
    rects[f] = fit(aspects[f], in: area.insetBy(dx: strip, dy: 0))
    var k = 0
    for i in 0..<aspects.count where i != f {
      let side = k % 2, slot = k / 2
      k += 1
      let w = strip - 20, h = (w / aspects[i]).rounded()
      let x = side == 0 ? area.minX + 10 : area.maxX - strip + 10
      let y = area.minY + 10 + CGFloat(slot) * (h + 12)
      if y + h <= area.maxY { rects[i] = CGRect(x: x, y: y, width: w, height: h) }
    }
    return rects
  }

  /// Recompose la grille : vignettes repérées de chaque fenêtre (ou la fenêtre entière), puis calques.
  func relayout() {
    guard active, let bar = app.barScreen() else { return }
    let H = bar.frame.height
    let zone = area()
    tiles = []
    for s in sources where s.active && s.bufW > 0 {
      let whole = s.wholeRect()
      if mode == "whole" || s.tilesPx.isEmpty { tiles.append((s, whole)) } else {
        for t in s.tilesPx { let c = t.intersection(whole); if !c.isEmpty && c.width >= 16 && c.height >= 16 { tiles.append((s, c)) } }
      }
    }
    let aspects = tiles.map { max(0.3, $0.src.width / max(1, $0.src.height)) }
    var rects: [CGRect] = []
    if tiles.count > 1, focus >= 0, focus < tiles.count {
      rects = focusLayout(aspects, focus: focus, in: zone)
    } else {
      if tiles.count <= 1 { focus = -1 }
      rects = gridLayout(aspects, in: zone)
    }
    while layers.count < tiles.count {
      let l = CALayer()
      l.contentsGravity = .resizeAspect
      l.masksToBounds = true
      l.cornerRadius = 10
      l.backgroundColor = NSColor.black.cgColor
      view.layer?.addSublayer(l)
      layers.append(l)
    }
    while layers.count > tiles.count { layers.removeLast().removeFromSuperlayer() }
    while names.count < tiles.count {
      let t = CATextLayer()
      t.foregroundColor = NSColor.white.cgColor
      t.backgroundColor = NSColor(white: 0, alpha: 0.62).cgColor
      t.alignmentMode = .center
      t.truncationMode = .end
      t.contentsScale = 2
      view.layer?.addSublayer(t)
      names.append(t)
    }
    while names.count > tiles.count { names.removeLast().removeFromSuperlayer() }
    hits = []
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, t) in tiles.enumerated() {
      let r = rects[i]
      let l = layers[i]
      let bw = CGFloat(t.source.bufW), bh = CGFloat(t.source.bufH)
      l.isHidden = r.isEmpty
      l.frame = CGRect(x: r.minX, y: H - r.maxY, width: r.width, height: r.height)   // calques : origine en bas à gauche
      l.contentsRect = CGRect(x: t.src.minX / bw, y: 1 - t.src.maxY / bh, width: t.src.width / bw, height: t.src.height / bh)
      l.contents = t.source.surface
      if !r.isEmpty { hits.append((r, i)) }
      // Pseudo en bas à gauche de la vignette (nom affiché quand Discord le donne)
      let n = names[i]
      let label = displayName(for: t.source)
      let small = r.width < 300
      let fs: CGFloat = small ? 13 : 20
      n.isHidden = r.isEmpty || label.isEmpty
      n.fontSize = fs
      n.font = NSFont.systemFont(ofSize: fs, weight: .semibold)
      n.string = label
      let tw = min(r.width - 16, CGFloat(label.count) * fs * 0.62 + 24)
      let th: CGFloat = small ? 22 : 32
      n.frame = CGRect(x: r.minX + 8, y: H - r.maxY + 8, width: tw, height: th)
      n.cornerRadius = 8
    }
    CATransaction.commit()
    if app.s.debug || layoutLogs < 4 {
      layoutLogs += 1
      log("Discord : disposition \(mode)\(focus >= 0 ? " (n°\(focus + 1) en grand)" : "") : " + zip(tiles, rects).map { "\($0.0.source.title.replacingOccurrences(of: "Stream de ", with: "")) \(Int($0.0.src.width))×\(Int($0.0.src.height))@\(Int($0.0.src.minX)),\(Int($0.0.src.minY)) → \(Int($0.1.width))×\(Int($0.1.height))@\(Int($0.1.minX)),\(Int($0.1.minY))" }.joined(separator: " ; "))
    }
  }

  /// Pseudo d'une fenêtre de stream (« Stream de <pseudo> »), remplacé par le nom affiché si Discord le donne.
  func displayName(for s: Source) -> String {
    let user = s.title.replacingOccurrences(of: "Stream de ", with: "").replacingOccurrences(of: "Stream from ", with: "")
    if user == s.title { return "" }   // fenêtre d'appel entière : Discord y écrit déjà les pseudos
    return snap?.streams.first { $0.user == user }?.displayName ?? user
  }

  /// Nouvelle trame d'une fenêtre : ses calques prennent la nouvelle surface.
  func paint(_ s: Source) {
    guard active, let surface = s.surface else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (i, t) in tiles.enumerated() where t.source === s && i < layers.count { layers[i].contents = surface }
    CATransaction.commit()
  }

  /// Appui bref sur la zone des flux (repère de la barre, origine en haut à gauche).
  func tap(at p: CGPoint) {
    guard active, let h = hits.first(where: { $0.rect.contains(p) }) else { return }
    focus = h.index == focus ? -1 : h.index
    relayout()
    app.mosaicChanged()
  }

  func info() -> [String: Any] {
    let a = area()
    let fps = sources.map { $0.fps }.min() ?? 0
    return [
      "active": active, "count": tiles.count, "sources": sources.map { ["id": Int($0.windowID), "title": $0.title, "live": $0.active, "tiles": $0.tilesPx.count, "fps": $0.fps] },
      "title": sources.map { $0.title.replacingOccurrences(of: "Stream de ", with: "") }.joined(separator: " · "),
      "focus": focus, "mode": mode, "fps": fps, "error": error ?? NSNull(),
      "job": job.map { ["user": $0.user, "step": $0.step] } ?? NSNull(),
      "ax": snap?.dict() ?? NSNull(), "axOk": EdenWindow.trusted(prompt: false),
      "voice": voice.reduce(into: [String: Any]()) { $0[$1.key] = ["speaking": $1.value.speaking, "muted": $1.value.muted] },
      "avatars": avatarSaved.reduce(into: [String: Any]()) { $0[$1.key] = [ "key": DiscordMosaic.avatarKey($1.key), "v": Int($1.value.timeIntervalSince1970) ] },
      "since": active ? Int(startedAt.timeIntervalSince1970 * 1000) : NSNull(),
      "hole": ["x": Int(a.minX), "y": Int(a.minY), "w": Int(a.width), "h": Int(a.height)],
      "strip": { let t = strip(); return ["x": Int(t.minX), "y": Int(t.minY), "w": Int(t.width), "h": Int(t.height)] }(),
      "tiles": hits.map { ["x": Int($0.rect.minX), "y": Int($0.rect.minY), "w": Int($0.rect.width), "h": Int($0.rect.height), "i": $0.index] }
    ]
  }

  /// Diagnostic : l'arbre d'accessibilité de Discord (rôles, titres, descriptions, positions) dans
  /// ~/Library/Logs/barre/discord-ax.txt. Discord (Electron) ne construit cet arbre que si on le lui
  /// demande (AXManualAccessibility).
  func axDump(maxNodes: Int) -> [String: Any] {
    guard EdenWindow.trusted(prompt: false) else { return ["ok": false, "error": "accessibilite"] }
    guard let d = NSRunningApplication.runningApplications(withBundleIdentifier: DiscordMosaic.bundle).first else { return ["ok": false, "error": "discord-ferme"] }
    let appEl = AXUIElementCreateApplication(d.processIdentifier)
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    var lines: [String] = []
    var count = 0
    let t0 = Date()
    func walk(_ el: AXUIElement, _ depth: Int) {
      if count >= maxNodes || depth > 60 || Date().timeIntervalSince(t0) > 20 { return }
      count += 1
      let role: String = EdenWindow.attr(el, kAXRoleAttribute) ?? "?"
      let sub: String = EdenWindow.attr(el, kAXSubroleAttribute) ?? ""
      let title: String = EdenWindow.attr(el, kAXTitleAttribute) ?? ""
      let desc: String = EdenWindow.attr(el, kAXDescriptionAttribute) ?? ""
      let help: String = EdenWindow.attr(el, kAXHelpAttribute) ?? ""
      let v: CFTypeRef? = EdenWindow.attr(el, kAXValueAttribute)
      let value = v.map { "\($0)" } ?? ""
      let f = EdenWindow.frame(el).map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))×\(Int($0.height))" } ?? ""
      if !title.isEmpty || !desc.isEmpty || !value.isEmpty || ["AXButton", "AXWindow", "AXMenuItem", "AXMenu", "AXPopUpButton", "AXCheckBox", "AXMenuButton"].contains(role) {
        lines.append(String(repeating: " ", count: depth) + "\(role)\(sub.isEmpty ? "" : "/" + sub) t=«\(title.prefix(80))» d=«\(desc.prefix(100))» v=«\(value.prefix(60))»\(help.isEmpty ? "" : " h=«\(help.prefix(60))»") \(f)")
      }
      let kids: [AXUIElement] = EdenWindow.attr(el, kAXChildrenAttribute) ?? []
      for k in kids { walk(k, depth + 1) }
    }
    walk(appEl, 0)
    let file = logURL.deletingLastPathComponent().appendingPathComponent("discord-ax.txt")
    try? lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
    log("Discord : arbre d'accessibilité : \(count) nœuds parcourus, \(lines.count) lignes dans \(file.lastPathComponent) (\(String(format: "%.1f", Date().timeIntervalSince(t0))) s)")
    return ["ok": true, "nodes": count, "lines": lines.count, "file": file.path]
  }

  /// Diagnostic : enregistre la dernière trame de chaque fenêtre et les vignettes repérées.
  func snapshot() -> [String: Any] {
    guard !sources.isEmpty else { return ["ok": false, "error": "pas de capture en cours"] }
    let dir = logURL.deletingLastPathComponent()
    var files: [String] = []
    var meta = info()
    var per: [[String: Any]] = []
    for (i, s) in sources.enumerated() {
      let file = dir.appendingPathComponent("discord-capture-\(i + 1).png")
      if s.savePNG(to: file) { files.append(file.path) }
      per.append(["title": s.title, "file": file.path, "buffer": ["w": s.bufW, "h": s.bufH],
                  "content": ["x": Int(s.contentPx.minX), "y": Int(s.contentPx.minY), "w": Int(s.contentPx.width), "h": Int(s.contentPx.height)],
                  "tilesPx": s.tilesPx.map { ["x": Int($0.minX), "y": Int($0.minY), "w": Int($0.width), "h": Int($0.height)] }])
    }
    meta["captures"] = per
    if let d = try? JSONSerialization.data(withJSONObject: meta, options: [.prettyPrinted]) {
      try? d.write(to: dir.appendingPathComponent("discord-capture.json"))
    }
    log("Discord : \(files.count) capture(s) enregistrée(s) dans \(dir.path)")
    return ["ok": true, "files": files]
  }
}

extension App {
  /// Mosaïque Discord sur la barre : comme le mode jeu, la page devient transparente au centre et
  /// n'y dessine que les bandes de commandes ; les contacts sur les flux sont traités ici (appui bref :
  /// vignette en grand, appui long : retour au tableau de bord).
  func setMosaicMode(_ on: Bool) {
    if on && gameMode { setGameMode(false) }
    let was = mosaicMode
    mosaicMode = on
    mosaicArea = on ? mosaic.area() : nil
    if was != on { log(on ? "Discord sur la barre : flux au centre, commandes sur les côtés" : "tableau de bord de retour sur la barre (Discord)") }
    panel.isOpaque = !(on || gameMode)
    panel.backgroundColor = (on || gameMode) ? .clear : NSColor(red: 13 / 255, green: 14 / 255, blue: 16 / 255, alpha: 1)
    placeWindow()
    mosaicChanged()
  }

  /// Prévient la page (état immédiat ; le serveur prend le relais par son sondage).
  func mosaicChanged() {
    guard let d = try? JSONSerialization.data(withJSONObject: mosaic.info()), let s = String(data: d, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.__barreMosaic && window.__barreMosaic(\(mosaicMode), \(s))", completionHandler: nil)
  }
}
