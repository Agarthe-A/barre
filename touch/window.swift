// Page Switch de la barre : placer la fenêtre de l'émulateur (Eden ou Ryujinx) sur la barre, comme une
// Switch en mode portable, ou sur l'écran principal. Pendant qu'on joue sur la barre, le tableau de bord
// devient transparent au centre (l'image du jeu, 16:9) et la page affiche des commandes dans les bandes noires.
// Demandé par le serveur via le relais local (POST /window, même jeton) :
//   {"action":"eden","target":"bar"|"main"}  → place l'émulateur (plein écran sur la barre, fenêtre centrée sur l'écran)
//   {"action":"panel","visible":true|false}  → tableau de bord complet, ou commandes autour du jeu
//   {"action":"status","light":true}          → {"trusted","gameMode","eden","emu","title","onBar","hole"}
//   {"action":"discord", …}                    → mosaïque des flux Discord, voir mosaic.swift
// Sur la barre, un appui long (1,2 s) sur l'image du jeu fait revenir le tableau de bord.
// Déplacer la fenêtre d'une autre app demande l'autorisation « Accessibilité » pour BarreTouch.

import AppKit
import ApplicationServices

enum EdenWindow {
  /// Émulateurs connus : identifiant de bundle → nom court renvoyé au serveur.
  static let bundles: [(bundle: String, name: String)] = [
    ("com.yuzu-emu.yuzu", "eden"),
    ("org.ryujinx.Ryujinx", "ryujinx")
  ]

  static func trusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
  }

  /// Émulateur en cours : celui qui affiche un jeu de préférence, sinon le premier lancé.
  static func running() -> (app: NSRunningApplication, name: String)? {
    var found: [(app: NSRunningApplication, name: String)] = []
    for b in bundles {
      if let a = NSRunningApplication.runningApplications(withBundleIdentifier: b.bundle).first { found.append((a, b.name)) }
    }
    if found.count > 1 {
      for f in found where hasGame(name: f.name, title: title(of: f.app) ?? "") { return f }
    }
    return found.first
  }

  /// Titre « … | Jeu (64-bit) | 1.0.0 | MoltenVK » chez Eden ; « Ryujinx 1.3.3 - Jeu v1.0.0 (TID) (32-bit) » chez Ryujinx.
  static func hasGame(name: String, title: String) -> Bool {
    name == "ryujinx" ? title.contains(" - ") : title.components(separatedBy: " | ").count >= 4
  }

  static func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success, let v else { return nil }
    return v as? T
  }

  static func frame(_ w: AXUIElement) -> CGRect? {
    guard let p: AXValue = attr(w, kAXPositionAttribute), let s: AXValue = attr(w, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p, .cgPoint, &pt)
    AXValueGetValue(s, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
  }

  /// Fenêtre principale de l'émulateur (celle du jeu ou de la liste), à défaut la plus grande.
  static func mainWindow(of app: NSRunningApplication) -> AXUIElement? {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    if let w: AXUIElement = attr(ax, kAXMainWindowAttribute) { return w }
    let ws: [AXUIElement] = attr(ax, kAXWindowsAttribute) ?? []
    return ws.max { (frame($0)?.width ?? 0) * (frame($0)?.height ?? 0) < (frame($1)?.width ?? 0) * (frame($1)?.height ?? 0) }
  }

  static func mainWindow() -> AXUIElement? {
    guard let r = running() else { return nil }
    return mainWindow(of: r.app)
  }

  static func title(of app: NSRunningApplication) -> String? {
    guard let w = mainWindow(of: app) else { return nil }
    return attr(w, kAXTitleAttribute) as String?
  }

  /// Repère Accessibilité : origine en haut à gauche de l'écran principal, y vers le bas.
  static func axRect(_ r: NSRect) -> CGRect {
    let h = NSScreen.screens.first?.frame.height ?? r.maxY
    return CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
  }

  static func setFrame(_ w: AXUIElement, _ r: CGRect) {
    var pt = r.origin, sz = r.size
    if let p = AXValueCreate(.cgPoint, &pt) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, p) }
    if let s = AXValueCreate(.cgSize, &sz) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, s) }
    if let p = AXValueCreate(.cgPoint, &pt) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, p) }
  }

  static func isFullScreen(_ w: AXUIElement) -> Bool { (attr(w, "AXFullScreen") as Bool?) ?? false }

  static func setFullScreen(_ w: AXUIElement, _ on: Bool) {
    AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, on as CFBoolean)
  }

  // MARK: plein écran propre à chaque émulateur (masque ses barres de menu et d'état)

  /// Article du menu d'Eden (« View › Fullscreen », « Vue › Plein écran » en français).
  static let viewMenus: Set<String> = ["View", "Vue", "Affichage"]
  static let fullscreenItems: Set<String> = ["Fullscreen", "Plein écran", "Plein Écran"]

  static func menuItem(_ app: NSRunningApplication, _ menus: Set<String>, _ items: Set<String>) -> AXUIElement? {
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    guard let bar: AXUIElement = attr(ax, kAXMenuBarAttribute) else { return nil }
    let tops: [AXUIElement] = attr(bar, kAXChildrenAttribute) ?? []
    for t in tops where menus.contains((attr(t, kAXTitleAttribute) as String?) ?? "") {
      for m in (attr(t, kAXChildrenAttribute) as [AXUIElement]?) ?? [] {
        for i in (attr(m, kAXChildrenAttribute) as [AXUIElement]?) ?? [] where items.contains((attr(i, kAXTitleAttribute) as String?) ?? "") {
          return i
        }
      }
    }
    return nil
  }

  /// Touche envoyée directement au processus (Ryujinx : F11 = plein écran, sans ses barres). Ne passe pas par
  /// les raccourcis système de macOS, et n'atteint que cette app.
  static func sendKey(_ key: CGKeyCode, to app: NSRunningApplication) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let d = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true) { d.postToPid(app.processIdentifier) }
    usleep(40_000)
    if let u = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) { u.postToPid(app.processIdentifier) }
  }

  /// L'émulateur est-il dans son propre mode plein écran ? (nil : impossible à savoir)
  static func emuFullscreen(_ r: (app: NSRunningApplication, name: String), _ w: AXUIElement) -> Bool? {
    if r.name == "ryujinx" { return isFullScreen(w) }   // F11 chez Ryujinx = plein écran macOS + barres masquées
    guard let i = menuItem(r.app, viewMenus, fullscreenItems) else { return nil }
    let mark: String? = attr(i, kAXMenuItemMarkCharAttribute)
    return !(mark ?? "").isEmpty
  }

  /// Bascule le plein écran propre à l'émulateur. false : pas de moyen connu (on retombe sur le plein écran macOS).
  static func toggleEmuFullscreen(_ r: (app: NSRunningApplication, name: String)) -> Bool {
    if r.name == "ryujinx" { sendKey(103, to: r.app); return true }   // kVK_F11
    guard let i = menuItem(r.app, viewMenus, fullscreenItems) else { return false }
    return AXUIElementPerformAction(i, kAXPressAction as CFString) == .success
  }

  /// Place la fenêtre sur `screen`. Appelé sur le fil principal ; attend la fin des animations plein écran.
  static func place(on screen: NSScreen, fill: Bool) -> [String: Any] {
    guard trusted(prompt: true) else { return ["ok": false, "error": "accessibilite"] }
    guard let r = running() else { return ["ok": false, "error": "eden-ferme"] }
    guard let w = mainWindow(of: r.app) else { return ["ok": false, "error": "fenetre"] }
    let app = r.app
    // Sortie de tout plein écran avant de déplacer la fenêtre
    if r.name == "ryujinx" {
      if isFullScreen(w) {
        app.activate()
        wait(0.3)
        sendKey(103, to: app)       // F11 : rend aussi ses barres de menu et d'état à Ryujinx
        wait(1.8)
        if isFullScreen(w) { setFullScreen(w, false); wait(1.8) }
      }
    } else {
      if isFullScreen(w) {
        setFullScreen(w, false)
        wait(1.8)   // sortie du plein écran macOS : animation de changement d'espace
      }
      if emuFullscreen(r, w) == true {
        _ = toggleEmuFullscreen(r)
        wait(0.8)
      }
    }
    let vf = screen.visibleFrame
    if fill {
      setFrame(w, axRect(vf))
    } else {
      // Fenêtre centrée, 16:9, 75 % de la largeur utile de l'écran
      let width = min(vf.width * 0.75, (vf.height * 0.85 - 28) * 16 / 9)
      let size = CGSize(width: width.rounded(), height: (width * 9 / 16 + 28).rounded())
      let rect = NSRect(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2, width: size.width, height: size.height)
      setFrame(w, axRect(rect))
    }
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    app.activate()
    if fill {
      wait(0.5)
      // Plein écran de l'émulateur (sans ses barres) sur l'écran où se trouve la fenêtre ; à défaut, plein écran macOS.
      // La demande est parfois ignorée pendant une animation : on vérifie et on réessaie une fois.
      if toggleEmuFullscreen(r) {
        wait(r.name == "ryujinx" ? 1.8 : 1.0)
        if emuFullscreen(r, w) == false { _ = toggleEmuFullscreen(r); wait(1.8) }
      } else {
        setFullScreen(w, true)
        wait(1.0)
      }
    }
    return ["ok": true, "emu": r.name,
            "frame": frame(w).map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))×\(Int($0.height))" } ?? "?",
            "fullscreen": isFullScreen(w) || emuFullscreen(r, w) == true]
  }

  static func wait(_ s: Double) { Thread.sleep(forTimeInterval: s) }   // l'animation se joue dans l'émulateur, pas ici
}

extension App {
  /// Écran principal « de bureau » : le premier écran qui n'est pas la barre.
  func deskScreen() -> NSScreen? {
    let bar = barScreen()
    return NSScreen.screens.first { $0 != bar } ?? NSScreen.screens.first
  }

  func windowRequest(_ j: [String: Any]) -> [String: Any] {
    switch j["action"] as? String {
    case "status":
      let trusted = EdenWindow.trusted(prompt: false)
      let r = EdenWindow.running()
      var out: [String: Any] = ["ok": true, "trusted": trusted, "gameMode": gameMode, "eden": r != nil, "emu": r?.name ?? NSNull()]
      if trusted, let r, let w = EdenWindow.mainWindow(of: r.app) {
        out["title"] = (EdenWindow.attr(w, kAXTitleAttribute) as String?) ?? ""
        // Version légère (sondage fréquent) : sans parcourir les menus de l'émulateur
        if (j["light"] as? Bool) != true {
          out["fullscreen"] = EdenWindow.isFullScreen(w) || EdenWindow.emuFullscreen(r, w) == true
        }
        if let f = EdenWindow.frame(w), let bar = barScreen() {
          let b = EdenWindow.axRect(bar.frame)
          out["onBar"] = b.contains(CGPoint(x: f.midX, y: f.midY))
        }
      }
      if gameMode, let h = hole { out["hole"] = ["x": Int(h.minX), "y": Int(h.minY), "w": Int(h.width), "h": Int(h.height)] }
      return out
    case "panel":
      let visible = (j["visible"] as? Bool) ?? true
      setGameMode(!visible)
      return ["ok": true, "gameMode": gameMode]
    case "discord":
      // Mosaïque des flux Discord (mosaic.swift)
      return mosaic.request(j)
    case "eden":
      let target = (j["target"] as? String) ?? "main"
      if target == "bar" {
        guard let bar = barScreen(), bar != NSScreen.screens.first else { return ["ok": false, "error": "barre-absente"] }
        var r = EdenWindow.place(on: bar, fill: true)
        if (r["ok"] as? Bool) == true { setGameMode(true) }
        r["gameMode"] = gameMode
        return r
      }
      guard let desk = deskScreen() else { return ["ok": false, "error": "ecran"] }
      var r = EdenWindow.place(on: desk, fill: false)
      setGameMode(false)
      r["gameMode"] = gameMode
      return r
    default:
      return ["ok": false, "error": "action inconnue"]
    }
  }

  /// Zone de l'image du jeu sur la barre (repère de la page : origine en haut à gauche de la barre).
  /// En plein écran, l'émulateur centre une image 16:9 ; ce qui dépasse sur les côtés est noir.
  func gameHole() -> CGRect? {
    guard let bar = barScreen(), let w = EdenWindow.mainWindow(), let f = EdenWindow.frame(w) else { return nil }
    let b = EdenWindow.axRect(bar.frame)
    let r = f.intersection(b)
    guard !r.isNull, r.width > 200, r.height > 200 else { return nil }
    let local = CGRect(x: r.minX - b.minX, y: r.minY - b.minY, width: r.width, height: r.height)
    var gw = local.height * 16 / 9, gh = local.height
    if gw > local.width { gw = local.width; gh = gw * 9 / 16 }
    return CGRect(x: (local.midX - gw / 2).rounded(), y: (local.midY - gh / 2).rounded(), width: gw.rounded(), height: gh.rounded())
  }

  /// Jeu sur la barre : la fenêtre reste affichée mais devient transparente, la page n'y dessine que
  /// les commandes des côtés. Sinon : tableau de bord opaque habituel.
  func setGameMode(_ on: Bool) {
    if on && mosaicMode { mosaic.stop() }   // un jeu et la mosaïque Discord ne partagent pas la barre
    let was = gameMode
    gameMode = on
    hole = on ? (gameHole() ?? hole) : nil
    if was != on {
      log(on ? "jeu sur la barre : commandes sur les côtés" + (hole.map { " (image \(Int($0.width))×\(Int($0.height)) à x=\(Int($0.minX)))" } ?? "")
             : "tableau de bord de retour sur la barre")
    }
    panel.isOpaque = !(on || mosaicMode)
    panel.backgroundColor = (on || mosaicMode) ? .clear : NSColor(red: 13 / 255, green: 14 / 255, blue: 16 / 255, alpha: 1)
    placeWindow()
    let h = hole.map { "{x:\(Int($0.minX)),y:\(Int($0.minY)),w:\(Int($0.width)),h:\(Int($0.height))}" } ?? "null"
    web.evaluateJavaScript("window.__barreGameMode && window.__barreGameMode(\(on), \(h))", completionHandler: nil)
  }
}
