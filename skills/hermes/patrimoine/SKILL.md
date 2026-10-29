---
name: patrimoine
description: "Tenir à jour et consulter le patrimoine de Julian affiché sur sa barre tactile (PEA Crédit Agricole, CTO Interactive Brokers, Revolut) avec la commande « patrimoine ». À utiliser quand Julian annonce un achat, une vente, un dividende, un versement, ses quantités, ses liquidités ou sa cible de répartition, ou demande combien vaut son PEA, son patrimoine ou une ligne. Chiffres uniquement, jamais de conseil d'investissement."
version: 1.0.0
metadata:
  hermes:
    tags: [finance, patrimoine, barre, pea, bourse]
---

# Patrimoine (barre tactile)

Julian suit ses comptes sur la page « Patrimoine » de sa barre tactile. Tu mets
à jour les chiffres et tu les lis avec la commande `patrimoine` (dans le
terminal du Mac mini). La barre se met à jour toute seule.

## Règle absolue : des chiffres, jamais de conseil

- Ne donne **aucun** conseil d'investissement : pas de « tu devrais », pas de
  suggestion d'achat, de vente, de renforcement ou d'allègement, pas d'avis sur
  un titre, sur la répartition ou sur le moment d'agir.
- Tu rapportes uniquement ce que la commande affiche : valeurs, plus-values,
  pourcentages, écarts à la cible que Julian a fixée, dates.
- Si Julian demande un avis (« je vends ? », « c'est le moment ? »), réponds
  simplement que tu ne donnes que les chiffres, et donne-les.
- N'invente jamais une quantité, un prix, une date ou un symbole. S'il manque
  une information indispensable, demande-la en une phrase.

## Phrases → commandes

| Julian dit | Commande |
|---|---|
| « acheté 10 Air Liquide à 180 sur le PEA » | `patrimoine achat "air liquide" 10 180 --compte pea` |
| « vendu 5 TTE à 62 » | `patrimoine vente TTE 5 62` |
| « vendu 5 Air Liquide à 185, frais 1,95 € » | `patrimoine vente "air liquide" 5 185 --frais 1,95` |
| « acheté 3 IGLN à 78,40 $ chez IBKR » | `patrimoine achat IGLN.L 3 78,40 --compte ibkr` (prix en dollars) |
| « dividende Air Liquide 45 € » | `patrimoine dividende "air liquide" 45` |
| « dividende Total 102 € reçu le 1er octobre » | `patrimoine dividende total 102 --date 2026-10-01` |
| « versé 500 € sur le PEA » | `patrimoine versement pea 500` |
| « j'ai 6 500 € sur Revolut » | `patrimoine liquidites revolut 6500` |
| « il me reste 1 240 € de cash sur le PEA » | `patrimoine liquidites pea 1240` |
| « j'ai 21 Air Liquide au nominatif, PRU 150, inscrites en mars 2023 » | `patrimoine ligne AI.PA --tranche nominatif --quantite 21 --pru 150 --inscription 2023-03-01` |
| « j'ai 1 000 parts du S&P 500 à 38,20 » | `patrimoine ligne PSP5.PA --quantite 1000 --pru 38,20` |
| « ma cible : 30 % Actions Europe, 10 % Défense, 10 % Or » | `patrimoine cible "Actions Europe=30" "Défense=10" "Or=10"` |
| « nouvelle ligne <nom> sur le PEA, catégorie Défense » | `patrimoine ligne <SYMBOLE.PA> --compte pea --nom "<nom>" --categorie "Défense"` puis l'achat |
| « combien vaut mon PEA ? » | `patrimoine --json` → `comptes[id = pea].valeur_eur` |
| « où en est mon patrimoine ? » | `patrimoine` |
| « et par rapport à ma cible ? » | `patrimoine` (bloc « Répartition ») |
| « mes dernières opérations » | `patrimoine historique` |
| « annule, je me suis trompé » | `patrimoine annuler` (dernière opération seulement) |

Précisions :

- **Titres** : nom, alias (« air liquide », « total », « or », « s&p 500 »,
  « msci world », « mines d'or »), symbole Yahoo (AI.PA, TTE.PA, IGLN.L) ou ISIN.
- **Air Liquide** a deux tranches sur le PEA : `swing` (par défaut pour achat,
  vente, dividende) et `nominatif` (21 actions gardées pour la prime de
  fidélité). Si Julian parle du nominatif, ajoute `--tranche nominatif`. Pour
  `patrimoine ligne AI.PA`, la tranche est obligatoire.
- **Comptes** : `pea`, `ibkr` (CTO), `revolut`. Sans `--compte`, le compte est
  déduit du titre.
- **Prix et PRU** dans la devise de cotation : euros à Paris, dollars pour
  IGLN.L et GDX.L à Londres.
- **Dates** : aujourd'hui par défaut ; sinon `--date AAAA-MM-JJ`, `--date hier`
  ou `--date 15/10/2026`. Jamais de date future.
- **Nouvelle ligne** : il faut le symbole Yahoo exact. Si tu ne le connais pas
  avec certitude, demande-le à Julian plutôt que de le deviner.
- Nombres : virgule ou point (180,5 ou 180.5).

## Après chaque commande

- Code de sortie 0 : reprends la ligne de confirmation en une phrase (ex.
  « Noté : 10 Air Liquide (swing) à 180 €, 43 titres, PRU 171,53 € »). Signale
  les lignes qui commencent par « ! » (liquidités négatives, PRU à renseigner…).
- Code 1 : la saisie est refusée ; transmets le message tel quel et ne
  réessaie pas au hasard (ex. vente supérieure à la quantité détenue).
- Code 2 : le serveur de la barre ne répond pas ; lance `patrimoine historique`
  pour vérifier si l'opération est passée avant de la refaire.
- « serveur de la barre arrêté » : l'opération est bien enregistrée dans le
  fichier ; la barre la reprendra à son redémarrage.

## Lire les chiffres

`patrimoine --json` renvoie un format stable (`schema: barre.patrimoine/1`) :
`total_eur`, `variation_jour_eur`, `variation_jour_pct`, `comptes[]`
(`id`, `valeur_eur`, `poids_pct`…), `categories[]` (`poids_pct`, `cible_pct`,
`ecart_pts`), `cours_au`, `perime`. Si `perime` vaut `true`, précise que
certains cours sont anciens. Réponds court, en français, avec les montants
arrondis à l'euro.
