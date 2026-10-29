// Discord lu et piloté par l'accessibilité macOS (pour la page Discord de la barre, voir mosaic.swift).
//
// Discord (Electron) ne construit son arbre d'accessibilité que si on le lui demande
// (AXManualAccessibility). On y lit alors le salon vocal en cours, ses participants (pseudo, micro,
// « EN DIRECT », jeu joué), les streams (vignettes « Vignette d'appel, stream, <pseudo> » de la grille
// d'appel, fenêtres « Stream de <pseudo> » déjà détachées), et on y appuie sur les boutons :
// menu d'une vignette › « Fenêtre détachée », puis « Regarder le stream » dans la fenêtre. Rien d'autre.
// Tout se fait sans toucher à la souris ni au clavier ; la lecture tourne sur une file secondaire.

import AppKit
import ApplicationServices

struct AXNode {
  let el: AXUIElement
  let role: String
  let title: String
  let desc: String
  let value: String
  let depth: Int
  let frame: CGRect?
  /// Texte utile du nœud (titre, sinon description, sinon valeur).
  var text: String { !title.isEmpty ? title : !desc.isEmpty ? desc : value }
  func has(_ s: String) -> Bool { title.localizedCaseInsensitiveContains(s) || desc.localizedCaseInsensitiveContains(s) || value.localizedCaseInsensitiveContains(s) }
}

enum DiscordAX {
  static let bundle = "com.hnc.Discord"
  static let liveWords = ["EN DIRECT", "LIVE"]
  static let watchWords = ["Regarder le stream", "Watch Stream", "Watch stream"]
  static let popoutWords = ["fenêtre séparée", "separate window", "Fenêtre détachée", "Pop Out", "Pop out", "Détacher"]

  static func appElement() -> AXUIElement? {
    guard EdenWindow.trusted(prompt: false),
          let d = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return nil }
    let el = AXUIElementCreateApplication(d.processIdentifier)
    AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return el
  }

  static func windows(_ app: AXUIElement) -> [AXUIElement] { EdenWindow.attr(app, kAXWindowsAttribute) ?? [] }
  static func title(_ el: AXUIElement) -> String { (EdenWindow.attr(el, kAXTitleAttribute) as String?) ?? "" }
  static func press(_ el: AXUIElement) -> Bool { AXUIElementPerformAction(el, kAXPressAction as CFString) == .success }

  /// Touche Échap envoyée à Discord seul (ferme un menu resté ouvert), sans lui donner le focus.
  static func escape() {
    guard let d = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: false) else { return }
    down.postToPid(d.processIdentifier)
    up.postToPid(d.processIdentifier)
  }

  /// Un menu contextuel ouvert masque tout le reste de l'arbre : on le referme d'abord.
  static func dismissMenu(_ main: AXUIElement) -> [AXNode] {
    var list = nodes(under: main)
    if list.count < 80, list.contains(where: { $0.role == "AXMenuItem" }) {
      escape()
      Thread.sleep(forTimeInterval: 0.5)
      list = nodes(under: main)
    }
    return list
  }
  static func showMenu(_ el: AXUIElement) -> Bool { AXUIElementPerformAction(el, "AXShowMenu" as CFString) == .success }

  /// Parcours en profondeur (ordre du document) ; les menus de la barre des menus sont ignorés.
  static func nodes(under root: AXUIElement, maxNodes: Int = 25000, budget: TimeInterval = 3, keep: (AXNode) -> Bool = { _ in true }) -> [AXNode] {
    var out: [AXNode] = []
    var count = 0
    let t0 = Date()
    func walk(_ el: AXUIElement, _ depth: Int) {
      if count >= maxNodes || depth > 80 || Date().timeIntervalSince(t0) > budget { return }
      count += 1
      let role: String = EdenWindow.attr(el, kAXRoleAttribute) ?? "?"
      if role == "AXMenuBar" { return }
      let title: String = EdenWindow.attr(el, kAXTitleAttribute) ?? ""
      let desc: String = EdenWindow.attr(el, kAXDescriptionAttribute) ?? ""
      var value = ""
      if role == "AXStaticText" || role == "AXCheckBox" || role == "AXHeading" {
        let v: CFTypeRef? = EdenWindow.attr(el, kAXValueAttribute)
        value = v.map { "\($0)" } ?? ""
      }
      let frame = (role == "AXButton" || role == "AXImage" || role == "AXStaticText" || role == "AXLink" || role == "AXGroup") ? EdenWindow.frame(el) : nil
      let n = AXNode(el: el, role: role, title: title, desc: desc, value: value, depth: depth, frame: frame)
      if keep(n) { out.append(n) }
      let kids: [AXUIElement] = EdenWindow.attr(el, kAXChildrenAttribute) ?? []
      for k in kids { walk(k, depth + 1) }
    }
    walk(root, 0)
    return out
  }

  /// Descendants d'un nœud dans une liste plate (ceux qui le suivent avec une profondeur supérieure).
  static func descendants(of i: Int, in list: [AXNode]) -> ArraySlice<AXNode> {
    var j = i + 1
    while j < list.count && list[j].depth > list[i].depth { j += 1 }
    return list[(i + 1)..<j]
  }

  // MARK: lecture

  struct Participant {
    var name: String; var live = false; var muted = false; var deaf = false; var game: String?
    var row: CGRect?                 // ligne du participant dans la liste des salons (points écran)
    var badges: [CGRect] = []        // textes et icônes connus de la ligne (badge EN DIRECT, jeu…), à ignorer en lisant les pixels
    var avatar: CGRect?              // grand avatar dans la grille d'appel (points écran), si visible
  }
  struct Stream { var user: String; var displayName: String?; var inGrid = false; var window: String?; var watching = false; var own = false }
  struct Snapshot {
    var channel: String?
    var connected: String?            // « <salon> / <serveur> » du bloc Voix connectée
    var menuOpen = false              // un menu contextuel masque tout le reste de l'arbre
    var mainFrame: CGRect?            // cadre de la fenêtre principale (points écran, origine en haut à gauche)
    var participants: [Participant] = []
    var streams: [Stream] = []
    var mainWindow = false
    var at = Date()
    func dict() -> [String: Any] {
      let nul: Any = NSNull()
      return ["channel": channel.map { $0 as Any } ?? nul, "connected": connected.map { $0 as Any } ?? nul,
       "participants": participants.map { p -> [String: Any] in ["name": p.name, "live": p.live, "muted": p.muted, "deaf": p.deaf, "game": p.game.map { $0 as Any } ?? nul] },
       "streams": streams.map { s -> [String: Any] in ["user": s.user, "name": s.displayName ?? s.user, "inGrid": s.inGrid, "window": s.window.map { $0 as Any } ?? nul, "watching": s.watching, "own": s.own] },
       "at": Int(at.timeIntervalSince1970 * 1000)]
    }
  }

  static func snapshot(lastChannel: String?, debug: Bool = false) -> Snapshot? {
    guard let app = appElement() else { return nil }
    var snap = Snapshot()
    var display: [String: String] = [:]          // pseudo (vignette) → nom affiché (image)
    var gridStreams: [String: Bool] = [:]        // pseudo → regarde déjà
    var ownStreams = Set<String>()               // le stream de l'utilisateur lui-même (« Ton stream est toujours en cours »)
    var avatarFrames: [String: CGRect] = [:]     // nom affiché → grand avatar de la grille d'appel
    for w in windows(app) {
      let t = title(w)
      if t.hasPrefix("Stream de ") || t.hasPrefix("Stream from ") || t.hasPrefix("'s Stream") {
        let user = t.replacingOccurrences(of: "Stream de ", with: "").replacingOccurrences(of: "Stream from ", with: "")
        let list = nodes(under: w, maxNodes: 2000, budget: 0.5)
        let watching = !list.contains { n in n.role == "AXButton" && watchWords.contains { n.has($0) } }
        snap.streams.append(Stream(user: user, inGrid: false, window: t, watching: watching))
        continue
      }
      guard t.hasSuffix(" - Discord") || t == "Discord" else { continue }
      snap.mainWindow = true
      snap.mainFrame = EdenWindow.frame(w)
      let list = nodes(under: w)
      if list.count < 80, list.contains(where: { $0.role == "AXMenuItem" }) { snap.menuOpen = true }
      // Salon vocal en cours : en-tête « Salon vocal X » de la vue d'appel, sinon le lien du bloc « Voix connectée »
      // (« <salon> / <serveur> », visible même quand un autre serveur est affiché)
      for n in list where n.role == "AXHeading" && n.title.hasPrefix("Salon vocal ") { snap.channel = String(n.title.dropFirst("Salon vocal ".count)) }
      if let i = list.firstIndex(where: { $0.role == "AXButton" && ($0.title.contains("Voix connectée") || $0.title.contains("Voice Connected")) }),
         let link = list[(i + 1)..<min(list.count, i + 8)].first(where: { $0.role == "AXLink" && $0.desc.contains(" / ") }) {
        snap.connected = link.desc
        if snap.channel == nil, let cut = link.desc.range(of: " / ", options: .backwards) { snap.channel = String(link.desc[link.desc.startIndex..<cut.lowerBound]) }
      }
      // Les éléments d'une rangée (vignette, participant) ne sont pas tous des descendants de son bouton :
      // on lit la « région » qui va d'un bouton au suivant du même genre.
      func region(from i: Int, until stop: (AXNode) -> Bool) -> ArraySlice<AXNode> {
        var j = i + 1
        while j < list.count && !stop(list[j]) { j += 1 }
        return list[(i + 1)..<j]
      }
      let isTile = { (n: AXNode) in n.role == "AXButton" && n.desc.hasPrefix("Vignette d'appel, ") }
      // Grille d'appel : vignettes « Vignette d'appel, stream, <pseudo> » et « Vignette d'appel, <pseudo> » (avatar → nom affiché)
      for (i, n) in list.enumerated() where isTile(n) {
        let rest = String(n.desc.dropFirst("Vignette d'appel, ".count))
        let r = region(from: i, until: isTile)
        if rest.hasPrefix("stream, ") {
          let user = String(rest.dropFirst("stream, ".count))
          gridStreams[user] = !r.contains { k in k.role == "AXButton" && watchWords.contains { k.has($0) } }
          if r.contains(where: { $0.value.hasPrefix("Ton stream") || $0.value.hasPrefix("Your stream") }) { ownStreams.insert(user) }
        } else if let img = r.first(where: { $0.role == "AXImage" && !$0.desc.isEmpty }) {
          display[rest] = img.desc
          if let f = img.frame, f.width >= 40, f.height >= 40 { avatarFrames[img.desc] = f }
        }
      }
      // Liste des salons : « X (salon vocal) » puis, jusqu'au salon ou à la catégorie suivante, un bouton par participant
      let isChannel = { (n: AXNode) in (n.role == "AXLink" || n.role == "AXButton") && (n.desc.contains("(salon") || n.desc.contains("(catégorie)") || n.desc.contains("(voice channel)") || n.desc.contains("(text channel)") || n.desc.contains("(category)")) }
      let isPerson = { (n: AXNode) in n.role == "AXButton" && !n.desc.isEmpty && !n.desc.hasPrefix("Définir") && !n.desc.hasPrefix("Set ") && !isChannel(n) }
      var chosen: [Participant]?
      var fallback: [Participant]?
      for (i, n) in list.enumerated() where isChannel(n) && (n.desc.contains("(salon vocal)") || n.desc.contains("(voice channel)")) {
        let cut = n.desc.range(of: " (salon vocal)") ?? n.desc.range(of: " (voice channel)")
        let name = cut.map { String(n.desc[n.desc.startIndex..<$0.lowerBound]) } ?? n.desc
        let r = Array(region(from: i, until: isChannel))
        var parts: [Participant] = []
        for k in r {
          if isPerson(k) { parts.append(Participant(name: k.desc, row: k.frame)); continue }
          guard !parts.isEmpty else { continue }
          var p = parts[parts.count - 1]
          if let f = k.frame, (k.role == "AXStaticText" || k.role == "AXImage"), f.width >= 2, f.height >= 2, p.row.map({ $0.intersects(f) }) == true { p.badges.append(f) }
          if liveWords.contains(where: { k.value == $0 || k.desc == $0 }) { p.live = true }
          if k.value.hasPrefix("Joue à ") { p.game = String(k.value.dropFirst("Joue à ".count)) }
          if k.value.hasPrefix("Playing ") { p.game = String(k.value.dropFirst("Playing ".count)) }
          if k.role == "AXImage" || k.role == "AXStaticText" {
            if k.has("sourdine") || k.has("deafen") { p.deaf = true } else if k.has("muet") || k.has("mute") { p.muted = true }
          }
          parts[parts.count - 1] = p
        }
        if !parts.isEmpty && fallback == nil { fallback = parts }
        if let c = snap.channel ?? lastChannel, c == name { chosen = parts }
        if debug { log("Discord AX : salon « \(name) » : \(r.count) nœuds, \(parts.count) participant(s) \(parts.map { $0.name })") }
      }
      if debug { log("Discord AX : fenêtre principale : \(list.count) nœuds, salon en cours « \(snap.channel ?? "?") », \(display.count) nom(s) affiché(s), \(gridStreams.count) stream(s) en grille") }
      if snap.channel == nil, chosen != nil { snap.channel = lastChannel }
      snap.participants = chosen ?? fallback ?? []
      for i in snap.participants.indices { snap.participants[i].avatar = avatarFrames[snap.participants[i].name] }
    }
    for (user, watching) in gridStreams where !snap.streams.contains(where: { $0.user == user }) {
      snap.streams.append(Stream(user: user, inGrid: true, window: nil, watching: watching, own: ownStreams.contains(user)))
    }
    for i in snap.streams.indices { snap.streams[i].displayName = display[snap.streams[i].user] }
    snap.streams.sort { $0.user.localizedCaseInsensitiveCompare($1.user) == .orderedAscending }
    return snap
  }

  // MARK: actions

  /// Fenêtre « Stream de <pseudo> », si elle existe.
  static func streamWindow(_ app: AXUIElement, user: String) -> AXUIElement? {
    windows(app).first { let t = title($0); return t == "Stream de \(user)" || t == "Stream from \(user)" }
  }

  /// Appuie sur « Regarder le stream » dans une fenêtre (ou une vignette) si le bouton est là.
  static func pressWatch(in root: AXUIElement) -> Bool {
    let list = nodes(under: root, maxNodes: 3000, budget: 0.8)
    guard let b = list.first(where: { n in n.role == "AXButton" && watchWords.contains { n.has($0) } }) else { return false }
    return press(b.el)
  }

  /// Détache le stream d'un pseudo depuis la grille d'appel : menu contextuel de sa vignette, puis
  /// « Fenêtre détachée ». Attend la fenêtre jusqu'à `wait` secondes. Renvoie la fenêtre, ou l'erreur.
  static func popout(_ app: AXUIElement, user: String, wait: TimeInterval = 4) -> (window: AXUIElement?, error: String?) {
    if let w = streamWindow(app, user: user) { return (w, nil) }
    guard let main = windows(app).first(where: { title($0).hasSuffix(" - Discord") || title($0) == "Discord" }) else { return (nil, "discord-ferme") }
    var list = dismissMenu(main)
    let findTile = { (l: [AXNode]) in l.first { $0.role == "AXButton" && $0.desc == "Vignette d'appel, stream, \(user)" } }
    var found = findTile(list)
    if found == nil, let i = list.firstIndex(where: { $0.role == "AXButton" && ($0.title.contains("Voix connectée") || $0.title.contains("Voice Connected")) }),
       let link = list[(i + 1)..<min(list.count, i + 8)].first(where: { $0.role == "AXLink" && $0.desc.contains(" / ") }), press(link.el) {
      // Un autre salon ou serveur est affiché : on revient sur la vue de l'appel
      Thread.sleep(forTimeInterval: 1.2)
      list = nodes(under: main)
      found = findTile(list)
    }
    guard let tile = found else { return (nil, "vignette") }
    guard showMenu(tile.el) else { return (nil, "menu") }
    Thread.sleep(forTimeInterval: 0.5)
    list = nodes(under: main, maxNodes: 25000, budget: 2)
    guard let item = list.first(where: { n in (n.role == "AXMenuItem" || n.role == "AXButton" || n.role == "AXMenuButton") && popoutWords.contains { n.has($0) } }) else {
      // Menu resté ouvert : on le referme (Échap) avant de renoncer
      log("Discord AX : menu de « \(user) » sans « fenêtre séparée » : " + list.filter { $0.role == "AXMenuItem" }.map { $0.title.prefix(40) }.joined(separator: " | "))
      escape()
      return (nil, "menu-detacher")
    }
    guard press(item.el) else { return (nil, "menu-detacher") }
    let deadline = Date().addingTimeInterval(wait)
    while Date() < deadline {
      Thread.sleep(forTimeInterval: 0.25)
      if let w = streamWindow(app, user: user) { return (w, nil) }
    }
    return (nil, "fenetre")
  }

  /// Ferme la fenêtre « Stream de <pseudo> » (bouton rouge de la fenêtre).
  static func closeStream(_ app: AXUIElement, user: String) -> Bool {
    guard let w = streamWindow(app, user: user) else { return true }
    if let b: AXUIElement = EdenWindow.attr(w, kAXCloseButtonAttribute) { return press(b) }
    return false
  }
}
