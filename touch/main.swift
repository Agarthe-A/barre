// BarreTouch : affiche le tableau de bord sur la barre Wisecoco 12,3" et rend son tactile utilisable.
//
// macOS ignore le tactile de la barre (écran tactile USB standard, page HID « Digitizer »).
// L'app lit donc elle-même les contacts envoyés en USB et les rejoue dans la page sous forme
// d'événements pointeur : le curseur ne bouge pas et la fenêtre ne vole jamais le focus clavier.
//
// Réglages facultatifs : ~/.config/barre/touch.json (relu à chaque nouveau contact)
//   { "swapXY": false, "flipX": false, "flipY": false, "debug": false,
//     "screen": "wisecoco", "maxX": 1920, "maxY": 720 }

import Cocoa
import WebKit
import IOKit.hid

// Journal : ~/Library/Logs/barre/touch.log (écrit par l'app elle-même, quel que soit son mode de lancement)
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/barre/touch.log")

func log(_ s: String) {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd HH:mm:ss"
  let line = Data("\(f.string(from: Date())) [touch] \(s)\n".utf8)
  if let h = try? FileHandle(forWritingTo: logURL) {
    h.seekToEndOfFile()
    h.write(line)
    try? h.close()
  } else {
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? line.write(to: logURL)
  }
}

struct Settings {
  var port = 4747
  var token = ""
  var screen = "wisecoco"          // nom de l'écran dans Réglages → Écrans
  var vendorID = 0x0712            // contrôleur tactile de la barre (« hotlotus »)
  var productID = 0x0010
  var maxX = 1920.0, maxY = 720.0  // valeurs maximales envoyées par le contrôleur
  var swapXY = false, flipX = false, flipY = false
  var debug = false
  var seize = true                 // capture exclusive : macOS ne voit plus du tout la barre comme souris
  var featureReports = [2, 3]      // lus à la connexion : fait passer le contrôleur du mode souris au mode tactile
  var featureDelay = 0.3           // délai (s) avant cette lecture
  var pollInput = false            // diagnostic : interroger le rapport 4 toutes les 50 ms
  var outputReports: [[Int]] = []  // rapports de sortie envoyés au branchement
  var diagPhases: [[Int]] = []     // diagnostic : suite de lectures de configuration, avec réinitialisation USB entre chaque
  var diagPhaseSec = 12.0
  var initRequests: [String] = []  // requêtes USB brutes rejouées au branchement (via tools/usbctl)
  var countEvery = 10.0            // diagnostic : bilan des rapports reçus toutes les N secondes
  var discordBands = 160.0         // mosaïque Discord : largeur des bandes de commandes de chaque côté
  var discordEnlarge = true        // agrandir la fenêtre détachée de Discord si elle est petite (capture nette)
  var discordFps = 30              // images par seconde capturées
  var discordAx = true             // lire Discord par l'accessibilité (participants, streams, boutons)
}

func loadSettings() -> Settings {
  var s = Settings()
  let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/barre")
  func json(_ name: String) -> [String: Any] {
    guard let d = try? Data(contentsOf: dir.appendingPathComponent(name)),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
    return j
  }
  let c = json("config.json")
  if let v = c["token"] as? String { s.token = v }
  if let v = c["port"] as? Int { s.port = v }
  let t = json("touch.json")
  if let v = t["screen"] as? String { s.screen = v }
  if let v = t["vendorID"] as? Int { s.vendorID = v }
  if let v = t["productID"] as? Int { s.productID = v }
  if let v = t["maxX"] as? Double { s.maxX = v }
  if let v = t["maxY"] as? Double { s.maxY = v }
  if let v = t["swapXY"] as? Bool { s.swapXY = v }
  if let v = t["flipX"] as? Bool { s.flipX = v }
  if let v = t["flipY"] as? Bool { s.flipY = v }
  if let v = t["debug"] as? Bool { s.debug = v }
  if let v = t["seize"] as? Bool { s.seize = v }
  if let v = t["featureReports"] as? [Int] { s.featureReports = v }
  if let v = t["featureDelay"] as? Double { s.featureDelay = v }
  if let v = t["pollInput"] as? Bool { s.pollInput = v }
  if let v = t["outputReports"] as? [[Int]] { s.outputReports = v }
  if let v = t["diagPhases"] as? [[Int]] { s.diagPhases = v }
  if let v = t["diagPhaseSec"] as? Double { s.diagPhaseSec = v }
  if let v = t["initRequests"] as? [String] { s.initRequests = v }
  if let v = t["countEvery"] as? Double { s.countEvery = v }
  if let v = t["discordBands"] as? Double { s.discordBands = v }
  if let v = t["discordEnlarge"] as? Bool { s.discordEnlarge = v }
  if let v = t["discordFps"] as? Int { s.discordFps = v }
  if let v = t["discordAx"] as? Bool { s.discordAx = v }
  return s
}

// Injecté dans la page : transforme un contact (coordonnées 0…1) en événements pointeur + clic.
let shim = #"""
(() => {
  if (window.__barreTouch) return;
  const PID = 4242;
  let cur = null;
  const at = (x, y) => document.elementFromPoint(x, y) || document.body;
  const pev = (type, x, y, pressed) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y,
    pointerId: PID, pointerType: 'touch', isPrimary: true,
    button: type === 'pointermove' ? -1 : 0, buttons: pressed ? 1 : 0,
    width: 24, height: 24, pressure: pressed ? 0.5 : 0
  });
  const click = (x, y) => new MouseEvent('click', {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0, detail: 1
  });
  function ripple(x, y) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;' +
      'background:rgba(236,234,228,.22);pointer-events:none;z-index:2147483647;transform:scale(.35);' +
      'opacity:1;transition:transform .4s ease-out,opacity .4s ease-out';
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    document.documentElement.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => { d.style.transform = 'scale(1.25)'; d.style.opacity = '0'; }));
    setTimeout(() => d.remove(), 500);
  }
  const common = (a, b) => { for (let n = a; n; n = n.parentNode) if (n.contains && n.contains(b)) return n; return null; };
  window.__barreTouch = (kind, nx, ny) => {
    const x = nx * innerWidth, y = ny * innerHeight;
    if (kind === 'down') {
      if (cur) window.__barreTouch('up', cur.x / innerWidth, cur.y / innerHeight);
      const t = at(x, y);
      cur = { t, x, y };
      ripple(x, y);
      t.dispatchEvent(pev('pointerover', x, y, false));
      t.dispatchEvent(pev('pointerdown', x, y, true));
    } else if (kind === 'move') {
      if (!cur) return;
      cur.x = x; cur.y = y;
      at(x, y).dispatchEvent(pev('pointermove', x, y, true));
    } else if (kind === 'up') {
      if (!cur) return;
      const t = at(x, y), d = cur;
      cur = null;
      t.dispatchEvent(pev('pointerup', x, y, false));
      const c = common(d.t, t);
      if (c) (c === document ? document.documentElement : c).dispatchEvent(click(x, y));
    }
  };
})();
"""#

final class BarPanel: NSPanel {
  override var canBecomeKey: Bool { false }   // ne prend jamais le clavier
  override var canBecomeMain: Bool { false }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var s = loadSettings()
  var panel: BarPanel!
  var web: WKWebView!
  var hid: IOHIDManager?
  var hidFailures = 0
  var reloadPending = false
  var relay: OsaRelay?
  var gameMode = false          // jeu affiché sur la barre : page transparente au centre, commandes sur les côtés (window.swift)
  var hole: CGRect?             // image du jeu sur la barre, en points (origine en haut à gauche)
  var mosaicMode = false        // flux Discord sur la barre (mosaic.swift) : même principe que le mode jeu
  var mosaicArea: CGRect?       // zone des flux, en points (origine en haut à gauche)
  var mosaic: DiscordMosaic!
  var plexWindow: PlexWindow!
  var lastCaptureCheck = Date()
  var downAt = Date()
  var swallow = false           // contact posé sur l'image du jeu : non transmis à la page

  // Contact suivi (un seul doigt : le premier posé)
  var activeID: Int?
  var lastX = 0.0, lastY = 0.0
  var lastReport = Date.distantPast
  var moves = 0

  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.setActivationPolicy(.accessory)
    if othersRunning() {
      Thread.sleep(forTimeInterval: 1.5)
      if othersRunning() { log("déjà lancée ailleurs : arrêt"); exit(0) }
    }
    mosaic = DiscordMosaic(app: self)
    plexWindow = PlexWindow(app: self)
    buildWindow()
    placeWindow()
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
      name: NSApplication.didChangeScreenParametersNotification, object: nil)
    load()
    startHID()
    relay = OsaRelay(port: 4748, token: s.token)
    relay?.onWindow = { [weak self] j in self?.windowRequest(j) ?? ["ok": false] }
    // Au réveil du Mac, la barre peut être repassée en mode souris : on la réactive.
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, !self.s.initRequests.isEmpty else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { log("réveil du Mac : réactivation du tactile"); self.runInitRequests() }
    }
    if !s.diagPhases.isEmpty {
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.runDiag(0) }
    }
    Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.watchdog() }
  }

  func othersRunning() -> Bool {
    let me = ProcessInfo.processInfo.processIdentifier
    return NSRunningApplication.runningApplications(withBundleIdentifier: "com.barre.touch")
      .contains { $0.processIdentifier != me }
  }

  // MARK: fenêtre sur la barre

  func buildWindow() {
    panel = BarPanel(contentRect: NSRect(x: 0, y: 0, width: 1920, height: 720),
                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar                 // au-dessus de la barre des menus de cet écran
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.hasShadow = false
    panel.backgroundColor = NSColor(red: 13 / 255, green: 14 / 255, blue: 16 / 255, alpha: 1)
    let cfg = WKWebViewConfiguration()
    cfg.userContentController.addUserScript(
      WKUserScript(source: shim, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    cfg.mediaTypesRequiringUserActionForPlayback = []
    web = WKWebView(frame: .zero, configuration: cfg)
    web.setValue(false, forKey: "drawsBackground")   // fond de la page seulement : transparent quand un jeu est sur la barre
    web.navigationDelegate = self
    panel.contentView = web
  }

  func barScreen() -> NSScreen? {
    let want = s.screen.lowercased()
    if let sc = NSScreen.screens.first(where: { $0.localizedName.lowercased().contains(want) }) { return sc }
    return NSScreen.screens.first { $0.frame.height > 0 && $0.frame.width / $0.frame.height > 2.4 }
  }

  func placeWindow() {
    guard let sc = barScreen() else {
      panel.orderOut(nil)
      mosaic?.stage?.orderOut(nil)
      log("barre non détectée : fenêtre masquée")
      return
    }
    // Jamais par-dessus l'écran principal (barre des menus, Dock) : si macOS a fait de la barre
    // l'écran principal, on s'efface jusqu'à ce qu'elle redevienne secondaire.
    if sc == NSScreen.screens.first {
      panel.orderOut(nil)
      mosaic?.stage?.orderOut(nil)
      log("la barre est l'écran principal : tableau de bord masqué")
      return
    }
    mosaic?.placeStage()   // flux Discord juste sous le tableau de bord
    panel.setFrame(sc.frame, display: true)
    panel.orderFrontRegardless()
    log("affichage sur « \(sc.localizedName) » \(Int(sc.frame.width))×\(Int(sc.frame.height))")
  }

  @objc func screensChanged() { placeWindow() }

  // MARK: page du tableau de bord

  func load() {
    reloadPending = false
    s = loadSettings()
    guard let u = URL(string: "http://127.0.0.1:\(s.port)/?kiosk=1&touch=1&token=\(s.token)") else { return }
    web.load(URLRequest(url: u))
  }

  func reloadLater() {
    if reloadPending { return }
    reloadPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.load() }
  }

  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
    log("page indisponible (\(e.localizedDescription)), nouvel essai dans 5 s")
    reloadLater()
  }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { reloadLater() }
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { log("moteur web relancé"); load() }

  // MARK: tactile (HID)

  func startHID() {
    if IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) != kIOHIDAccessTypeGranted {
      if hidFailures == 0 {
        _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
        log("tactile : en attente de l'autorisation. Active BarreTouch dans Réglages → Confidentialité et sécurité → Surveillance de l'entrée.")
      }
      hidFailures += 1
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.startHID() }
      return
    }
    if hidFailures > 0 {
      // Lancée sans l'autorisation : macOS ne la prend en compte qu'après un redémarrage.
      log("autorisation accordée : redémarrage pour la prendre en compte")
      restart()
    }
    let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
    IOHIDManagerSetDeviceMatching(m, [kIOHIDVendorIDKey: s.vendorID, kIOHIDProductIDKey: s.productID] as CFDictionary)
    let ctx = Unmanaged.passUnretained(self).toOpaque()
    IOHIDManagerRegisterDeviceMatchingCallback(m, { ctx, _, _, dev in
      log("tactile détecté")
      guard let ctx else { return }
      let app = Unmanaged<App>.fromOpaque(ctx).takeUnretainedValue()
      app.attach(dev)
      DispatchQueue.main.asyncAfter(deadline: .now() + app.s.featureDelay) { app.enableTouch(dev) }
    }, ctx)
    IOHIDManagerRegisterDeviceRemovalCallback(m, { ctx, _, _, _ in
      log("tactile débranché")
      guard let ctx else { return }
      Unmanaged<App>.fromOpaque(ctx).takeUnretainedValue().release()
    }, ctx)
    IOHIDManagerScheduleWithRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    var r: IOReturn = -1
    if s.seize {
      r = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
      log(r == kIOReturnSuccess ? "tactile : capture exclusive active"
                                : String(format: "tactile : capture exclusive refusée (0x%08x)", r))
    }
    if r != kIOReturnSuccess {
      r = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeNone))
      if r == kIOReturnSuccess { log("tactile : écoute active") }
    }
    if r == kIOReturnSuccess {
      hid = m
      return
    }
    IOHIDManagerUnscheduleFromRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    log(String(format: "tactile : ouverture impossible (0x%08x), nouvel essai dans 10 s", r))
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.startHID() }
  }

  func restart() {
    if ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] == "com.barre.touch" { exit(0) } // launchd relance
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-n", Bundle.main.bundlePath]
    try? p.run()
    exit(0)
  }

  // Tampon large (1 Ko) : certains contrôleurs envoient des rapports plus longs que ce que déclare
  // leur descripteur, et macOS les jette si le tampon est trop petit.
  func attach(_ dev: IOHIDDevice) {
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
    IOHIDDeviceRegisterInputReportCallback(dev, buf, 1024, { ctx, _, _, _, reportID, report, length in
      guard let ctx else { return }
      Unmanaged<App>.fromOpaque(ctx).takeUnretainedValue()
        .handle(reportID: reportID, b: UnsafeBufferPointer(start: report, count: length))
    }, Unmanaged.passUnretained(self).toOpaque())
    if s.pollInput { startPolling(dev) }
    if !s.initRequests.isEmpty { runInitRequests() }
    // Rapports de sortie envoyés au branchement, ex. [[9, 128, 7, 208, 2]] (n° 9 + 4 octets).
    for rep in s.outputReports where rep.count >= 2 {
      var bytes = rep.map { UInt8(truncatingIfNeeded: $0) }
      let r = IOHIDDeviceSetReport(dev, kIOHIDReportTypeOutput, CFIndex(bytes[0]), &bytes, bytes.count)
      log(String(format: "rapport de sortie %d envoyé : 0x%08x ", Int(bytes[0]), r) + bytes.map { String(format: "%02x", $0) }.joined(separator: " "))
    }
  }

  // Rejoue des requêtes USB exactes (longueurs comprises) par le canal de contrôle de l'appareil.
  // Séquence qui active le tactile (trouvée le 28/10/2026) : couper le « réveil à distance » que macOS
  // active à la connexion (CLEAR_FEATURE), puis faire comme Windows (compat ID, SET_IDLE, descripteur HID,
  // lecture des rapports de configuration 2 et 3 en 257 octets). La barre envoie alors ses vrais rapports 4.
  var lastInit = Date.distantPast
  func runInitRequests() {
    lastInit = Date()
    usingDigitizer = false
    let tool = (Bundle.main.bundlePath as NSString).deletingLastPathComponent + "/tools/usbctl"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = s.initRequests
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.terminationHandler = { _ in
      let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      DispatchQueue.main.async { for l in out.split(separator: "\n") { log("init USB : \(l)") } }
    }
    do { try p.run() } catch { log("init USB impossible : \(error.localizedDescription)") }
  }

  // Diagnostic : demande l'état du rapport 4 par le canal de contrôle (GET_REPORT), sans attendre l'envoi spontané.
  var pollTimer: Timer?
  var lastPoll: [UInt8] = []
  func startPolling(_ dev: IOHIDDevice) {
    pollTimer?.invalidate()
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
      guard let self else { return }
      var buf = [UInt8](repeating: 0, count: 64)
      var len = CFIndex(buf.count)
      let r = IOHIDDeviceGetReport(dev, kIOHIDReportTypeInput, 4, &buf, &len)
      let got = Array(buf.prefix(max(0, min(len, 64))))
      if r != kIOReturnSuccess {
        if self.lastPoll != [0xEE] { log(String(format: "GET_REPORT entrée 4 : 0x%08x", r)); self.lastPoll = [0xEE] }
        return
      }
      if got != self.lastPoll {
        self.lastPoll = got
        log("GET_REPORT entrée 4 (\(len) o) : " + got.prefix(16).map { String(format: "%02x", $0) }.joined(separator: " "))
        if got.count >= 11 { got.withUnsafeBufferPointer { self.handle(reportID: 4, b: $0) } }
      }
    }
  }

  // Comme Windows et Linux : lire les rapports de configuration (nombre max de doigts, bloc 0xC5)
  // fait passer ce type de contrôleur du mode « souris » au vrai mode tactile.
  func enableTouch(_ dev: IOHIDDevice) {
    let o = IOHIDDeviceOpen(dev, IOOptionBits(kIOHIDOptionsTypeNone))
    if o != kIOReturnSuccess { log(String(format: "ouverture du contrôleur : 0x%08x", o)) }
    for id in s.featureReports {
      var buf = [UInt8](repeating: 0, count: 600)
      var len = CFIndex(buf.count)
      let r = IOHIDDeviceGetReport(dev, kIOHIDReportTypeFeature, CFIndex(id), &buf, &len)
      let head = buf.prefix(max(0, min(len, 8))).map { String(format: "%02x", $0) }.joined(separator: " ")
      log(String(format: "configuration %d lue : 0x%08x, %ld octets ", id, r, len) + head)
    }
  }

  var lastRaw: [UInt32: [UInt8]] = [:]
  var repeats = 0
  var usingDigitizer = false

  // Rapport 4 (56 octets) : ID, puis 10 emplacements de 5 octets
  // [identifiant (6 bits) | doigt posé (1 bit)] X (16 bits) Y (16 bits), puis horodatage (4) et nombre de doigts (1).
  // Rapport 5 (7 octets) : mode souris de secours, [boutons] X (16 bits) Y (16 bits) [molette].
  var counts: [UInt32: Int] = [:]

  func handle(reportID: UInt32, b: UnsafeBufferPointer<UInt8>) {
    counts[reportID, default: 0] += 1
    if s.debug {
      let bytes = Array(b.prefix(reportID == 4 ? 12 : 16))
      if lastRaw[reportID] != bytes {
        log("rapport \(reportID) (\(b.count) o)" + (repeats > 0 ? " [\(repeats) identiques avant]" : "") + " " +
            bytes.map { String(format: "%02x", $0) }.joined(separator: " "))
        lastRaw[reportID] = bytes
        repeats = 0
      } else {
        repeats += 1
      }
    }
    // La barre est retombée en « souris vide » (rapports 5) : on rejoue la séquence d'activation.
    if reportID == 5 && !s.initRequests.isEmpty && Date().timeIntervalSince(lastInit) > 10 {
      log("mode souris détecté : réactivation du tactile")
      runInitRequests()
    }
    if reportID == 5 && b.count >= 6 && !usingDigitizer {
      lastReport = Date()
      let x = Double(Int(b[2]) | Int(b[3]) << 8), y = Double(Int(b[4]) | Int(b[5]) << 8)
      if b[1] & 1 == 1 {
        if activeID == nil { begin(99, x, y) } else { move(x, y) }
      } else if activeID != nil {
        release()
      }
      return
    }
    guard reportID == 4, b.count >= 11 else { return }
    if !usingDigitizer { usingDigitizer = true; log("mode tactile reçu (\(b.count) octets par rapport)") }
    lastReport = Date()
    // Nombre d'emplacements déduit de la taille : ID (1) + 5 par doigt + horodatage (4) + nombre de doigts (1)
    let slots = max(1, min(10, (b.count - 6) / 5))
    let n = min(Int(b[b.count - 1]), slots)
    var contacts: [(id: Int, tip: Bool, x: Double, y: Double)] = []
    for i in 0..<n {
      let o = 1 + i * 5
      contacts.append((Int(b[o] & 0x3f), (b[o] >> 6) & 1 == 1,
                       Double(Int(b[o + 1]) | Int(b[o + 2]) << 8),
                       Double(Int(b[o + 3]) | Int(b[o + 4]) << 8)))
    }

    if let a = activeID {
      if let c = contacts.first(where: { $0.id == a }) {
        if c.tip { move(c.x, c.y) } else { release(c.x, c.y) }
      } else {
        release()
      }
    } else if let c = contacts.first(where: { $0.tip }) {
      begin(c.id, c.x, c.y)
    }
  }

  // Diagnostic : enchaîne plusieurs façons d'initialiser le contrôleur pendant que l'on tapote la barre.
  func runDiag(_ i: Int) {
    log("diag : bilan phase précédente : " + (counts.isEmpty ? "aucun rapport" :
        counts.sorted { $0.key < $1.key }.map { "n°\($0.key) × \($0.value)" }.joined(separator: ", ")))
    counts = [:]
    guard i < s.diagPhases.count else { log("diag : terminé"); return }
    s.featureReports = s.diagPhases[i]
    usingDigitizer = false
    log("diag : phase \(i + 1)/\(s.diagPhases.count), lecture de configuration : \(s.featureReports)")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: (Bundle.main.bundlePath as NSString).deletingLastPathComponent + "/tools/usbreset")
    try? p.run()
    DispatchQueue.main.asyncAfter(deadline: .now() + s.diagPhaseSec) { [weak self] in self?.runDiag(i + 1) }
  }

  func begin(_ id: Int, _ x: Double, _ y: Double) {
    if s.diagPhases.isEmpty { s = loadSettings() }   // réglages relus à chaque contact : calibrage sans redémarrer
    activeID = id
    lastX = x; lastY = y
    moves = 0
    downAt = Date()
    // Jeu sur la barre : un contact sur l'image du jeu n'est pas transmis à la page, seul l'appui long compte.
    swallow = false
    if gameMode, let h = hole {
      let (nx, ny) = norm(x, y)
      let w = panel.frame.width, hh = panel.frame.height
      swallow = h.contains(CGPoint(x: nx * w, y: ny * hh))
    } else if mosaicMode, let a = mosaicArea {
      // Flux Discord : un appui bref sur une vignette la met en grand (release), l'appui long rend la barre
      swallow = a.contains(point(x, y))
    }
    if swallow { return }
    send("down", x, y)
  }

  func move(_ x: Double, _ y: Double) {
    if abs(x - lastX) < 1 && abs(y - lastY) < 1 { return }
    lastX = x; lastY = y
    moves += 1
    if swallow { return }
    send("move", x, y)
  }

  func release(_ x: Double? = nil, _ y: Double? = nil) {
    guard activeID != nil else { return }
    activeID = nil
    if swallow {
      swallow = false
      if mosaicMode, moves < 4, Date().timeIntervalSince(downAt) < 0.8 { mosaic.tap(at: point(x ?? lastX, y ?? lastY)) }
      return
    }
    send("up", x ?? lastX, y ?? lastY)
  }

  var lastCountLog = Date()

  func watchdog() {
    if s.debug && s.diagPhases.isEmpty && Date().timeIntervalSince(lastCountLog) > s.countEvery && !counts.isEmpty {
      log("rapports reçus (\(Int(s.countEvery)) s) : " + counts.sorted { $0.key < $1.key }.map { "n°\($0.key) × \($0.value)" }.joined(separator: ", "))
      counts = [:]
      lastCountLog = Date()
    }
    // Jeu sur la barre : un appui long (1,2 s sans glisser) sur l'image du jeu fait revenir le tableau de bord.
    // (le reste de ce contact reste avalé jusqu'au lever du doigt : pas de clic involontaire sur la page)
    if gameMode, swallow, activeID != nil, moves < 4, Date().timeIntervalSince(downAt) > 1.2 {
      setGameMode(false)
    }
    if mosaicMode, swallow, activeID != nil, moves < 4, Date().timeIntervalSince(downAt) > 1.2 {
      mosaic.stop()
    }
    // Autorisation « Enregistrement de l'écran » accordée après la demande : macOS ne la prend en compte
    // qu'au prochain lancement.
    if mosaic.askedCapture, Date().timeIntervalSince(lastCaptureCheck) > 3 {
      lastCaptureCheck = Date()
      if CGPreflightScreenCaptureAccess() { log("enregistrement de l'écran autorisé : redémarrage pour le prendre en compte"); restart() }
    }
    // Filet de sécurité si le contrôleur n'envoie pas le lever du doigt.
    if activeID != nil && Date().timeIntervalSince(lastReport) > 1.0 {
      log("plus de signal : doigt considéré comme levé")
      release()
    }
  }

  /// Coordonnées brutes du contrôleur → point de la barre (origine en haut à gauche).
  func point(_ x: Double, _ y: Double) -> CGPoint {
    let (nx, ny) = norm(x, y)
    return CGPoint(x: nx * panel.frame.width, y: ny * panel.frame.height)
  }

  /// Coordonnées brutes du contrôleur → 0…1 dans la page (calibrage de touch.json).
  func norm(_ x: Double, _ y: Double) -> (Double, Double) {
    var nx = x / s.maxX, ny = y / s.maxY
    if s.swapXY { swap(&nx, &ny) }
    if s.flipX { nx = 1 - nx }
    if s.flipY { ny = 1 - ny }
    return (min(max(nx, 0), 1), min(max(ny, 0), 1))
  }

  func send(_ kind: String, _ x: Double, _ y: Double) {
    let (nx, ny) = norm(x, y)
    if kind != "move" || s.debug {
      log("\(kind) brut \(Int(x)),\(Int(y)) → \(String(format: "%.3f", nx)), \(String(format: "%.3f", ny))" +
          (kind == "up" ? " (\(moves) mouvements)" : ""))
    }
    web.evaluateJavaScript("window.__barreTouch && window.__barreTouch('\(kind)', \(nx), \(ny))", completionHandler: nil)
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.run()
