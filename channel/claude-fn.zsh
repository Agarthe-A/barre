
# Barre : les questions d'autorisation de Claude Code s'affichent dans le terminal ET sur la barre
# (la première réponse gagne). Pour revenir à l'ancien comportement : supprimer ce bloc.
claude() {
  local a sid="$$-$RANDOM$RANDOM"
  # Sous-commandes (claude mcp, claude update…) : lancement normal.
  case "$1" in
    agents|attach|auth|auto-mode|config|daemon|doctor|gateway|import|install|kill|logs|mcp|migrate-installer|plugin|plugins|purge|remote-control|respawn|rm|self-hosted-runner|setup-token|stop|ultrareview|update|upgrade|-v|--version|-h|--help)
      command claude "$@"; return ;;
  esac
  # Mode non interactif (-p) : le canal ne sert à rien.
  for a in "$@"; do
    case "$a" in -p|--print) command claude "$@"; return ;; esac
  done
  # La forme « option=valeur » évite que la question passée en argument soit lue comme un nom de canal.
  # BARRE_SID relie le hook et le canal d'un même lancement (deux sessions dans un même dossier ne se mélangent pas).
  BARRE_CHANNEL=1 BARRE_SID="$sid" command claude --mcp-config="$HOME/barre/channel/mcp.json" --dangerously-load-development-channels=server:barre "$@"
}
