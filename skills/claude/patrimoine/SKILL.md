---
name: patrimoine
description: "Tenir à jour et consulter le patrimoine de Julian (PEA Crédit Agricole, CTO Interactive Brokers, Revolut) affiché sur la page Patrimoine de sa barre tactile, via la commande « patrimoine ». À utiliser quand Julian annonce un achat, une vente, un dividende, un versement, ses quantités, ses liquidités ou sa cible de répartition, ou demande ce que vaut son PEA, son patrimoine ou une ligne. Uniquement des chiffres : aucun conseil d'investissement."
---

# Patrimoine (barre tactile)

La page « Patrimoine » de la barre lit `~/.config/barre/data/patrimoine.json`.
Ne modifie jamais ce fichier à la main : passe toujours par la commande
`patrimoine` (Bash), qui valide la saisie, recalcule le PRU, met à jour les
liquidités et prévient la barre.

## Règle absolue : des chiffres, jamais de conseil

- Aucun conseil d'investissement : pas de « tu devrais », pas de suggestion
  d'achat, de vente, de renforcement ou d'allègement, pas d'avis sur un titre,
  sur la répartition ou sur le moment d'agir — même si on te le demande.
- Rapporte uniquement ce que la commande affiche (valeurs, plus-values,
  pourcentages, écarts à la cible fixée par Julian, dates).
- N'invente jamais une quantité, un prix, une date ou un symbole Yahoo ; s'il
  en manque un, demande-le.

## Phrases → commandes

| Julian dit | Commande |
|---|---|
| « acheté 10 Air Liquide à 180 sur le PEA » | `patrimoine achat "air liquide" 10 180 --compte pea` |
| « vendu 5 TTE à 62 » | `patrimoine vente TTE 5 62` |
| « vendu 5 Air Liquide à 185, frais 1,95 € » | `patrimoine vente "air liquide" 5 185 --frais 1,95` |
| « acheté 3 IGLN à 78,40 $ chez IBKR » | `patrimoine achat IGLN.L 3 78,40 --compte ibkr` (prix en dollars) |
| « dividende Air Liquide 45 € » | `patrimoine dividende "air liquide" 45` |
| « versé 500 € sur le PEA » | `patrimoine versement pea 500` |
| « j'ai 6 500 € sur Revolut » | `patrimoine liquidites revolut 6500` |
| « j'ai 21 Air Liquide au nominatif, PRU 150, inscrites en mars 2023 » | `patrimoine ligne AI.PA --tranche nominatif --quantite 21 --pru 150 --inscription 2023-03-01` |
| « ma cible : 30 % Actions Europe, 10 % Défense » | `patrimoine cible "Actions Europe=30" "Défense=10"` |
| « nouvelle ligne <nom> sur le PEA, catégorie Défense » | `patrimoine ligne <SYMBOLE.PA> --compte pea --nom "<nom>" --categorie "Défense"` puis l'achat |
| « combien vaut mon PEA ? » | `patrimoine --json` → `comptes[id = pea].valeur_eur` |
| « où en est mon patrimoine ? » / « et la cible ? » | `patrimoine` |
| « mes dernières opérations » | `patrimoine historique` |
| « annule la dernière » | `patrimoine annuler` |

`patrimoine aide` liste toutes les options.

Précisions :

- **Titres** : nom, alias (« air liquide », « total », « or », « s&p 500 »,
  « msci world », « mines d'or »), symbole Yahoo (AI.PA, TTE.PA, IGLN.L) ou ISIN.
- **Air Liquide** : deux tranches sur le PEA, `swing` (par défaut pour les
  opérations) et `nominatif` (prime de fidélité). Ajoute `--tranche nominatif`
  quand Julian parle du nominatif ; obligatoire pour `patrimoine ligne AI.PA`.
- **Comptes** : `pea`, `ibkr`, `revolut` (déduit du titre si absent).
- **Devises** : prix et PRU dans la devise de cotation (dollars pour IGLN.L et
  GDX.L), liquidités en euros sauf `--devise USD`.
- **Dates** : aujourd'hui par défaut, sinon `--date AAAA-MM-JJ` (jamais future).

## Après chaque commande

- Code 0 : résume la confirmation en une phrase et signale les lignes « ! ».
- Code 1 : saisie refusée ; transmets le message, ne réessaie pas au hasard.
- Code 2 : le serveur de la barre ne répond pas ; vérifie avec
  `patrimoine historique` avant de refaire l'opération.
- « serveur de la barre arrêté » : c'est enregistré dans le fichier, la barre
  le relira au démarrage.

`patrimoine --json` (format stable `barre.patrimoine/1`, décrit dans
`~/barre/README.md`) sert aux lectures précises. Si `perime` vaut `true`,
précise que certains cours sont anciens.
