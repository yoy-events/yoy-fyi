---
title: Cent liens courts d'un coup avec un fichier CSV
description: Comment créer de nombreux liens courts yoy.fyi avec un seul fichier issu d'un tableur, et exporter vos liens et clics en CSV.
date: 2026-10-25
---

# Cent liens courts d'un coup avec un fichier CSV

Avant un festival, vous avez un tableau de trente sessions, et chacune a besoin d'un lien court et d'un code QR. Les créer un par un prend du temps. yoy.fyi accepte un fichier CSV.

## Le format

La première ligne nomme les colonnes. Une est obligatoire, `target_url`. Trois autres sont facultatives :

- `title` : le nom du lien ;
- `code` : votre propre code, par exemple `fest-day1` ;
- `tags` : des tags séparés par des virgules, toute la cellule entre guillemets.

```
target_url,title,code,tags
https://example.com/fest/day-1,Festival jour 1,fest-day1,"fest, day1"
https://example.com/fest/day-2,Festival jour 2,fest-day2,"fest, day2"
```

Préparez-le dans Google Sheets ou Excel et enregistrez-le en CSV.

## Importer

Sur la page d'accueil, sous le formulaire, un lien mène à l'import. Envoyez le fichier ou collez le texte. Chaque import accepte jusqu'à 100 lignes et 256 Ko, et vous pouvez en faire cinq par heure.

Ensuite, une liste s'affiche. Chaque ligne montre soit le nouveau lien court avec un bouton pour copier, soit la raison de l'échec avec le numéro de ligne. Les bonnes lignes sont créées même si la voisine pose problème, par exemple un code déjà pris ou une adresse qui n'est pas en http.

## Exporter

Le lien d'export vous donne tous vos liens : code, adresse courte, destination, titre, tags, état et total des clics. La page de chaque lien propose aussi un CSV de ses clics, avec l'heure, le pays, l'appareil et les balises UTM.

Les cellules qu'un tableur pourrait prendre pour une formule, comme celles qui commencent par `=`, reçoivent une apostrophe devant. Ouvrir le fichier dans Excel ne pose pas de risque.

## Depuis un chat

Avec Claude ou ChatGPT, vous pouvez créer jusqu'à 20 liens en une seule demande. Essayez : « Crée des liens courts pour ces cinq pages et ajoute le tag fest. »
