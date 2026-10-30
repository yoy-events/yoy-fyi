---
title: Quel lien a rapporté les inscriptions et l'argent : les conversions dans yoy.fyi
description: Comment dire à yoy.fyi qu'un clic a abouti à une inscription ou un achat, et voir sur la page du lien combien de personnes et d'argent il a rapportés.
date: 2026-10-26
---

# Quel lien a rapporté les inscriptions et l'argent : les conversions dans yoy.fyi

Un clic seul en dit peu. Ce qui compte, c'est que la personne se soit inscrite ou ait acheté un billet. Si vous placez des liens différents dans Telegram, Instagram et une newsletter, vous voulez savoir lequel a rapporté de l'argent, pas seulement des clics.

## Comment ça marche

1. Créez le lien avec `pass_click_id: true`. yoy.fyi ajoute alors `yoy_sid`, l'identifiant de ce clic précis, à l'adresse vers laquelle le lien pointe.
2. Sur votre site, conservez `yoy_sid` (dans un cookie ou un champ caché du formulaire) et gardez-le jusqu'à l'inscription ou au paiement.
3. Quand l'événement se produit, votre serveur le signale à yoy.fyi avec cet identifiant.

```
POST https://yoy.fyi/v1/conversions
Authorization: Bearer yfi_...

{ "click_id": "01a17...", "event": "purchase", "value": 450, "currency": "UAH", "external_id": "order-77" }
```

La clé a besoin de l'autorisation `conversions:write`. Vous pouvez la choisir sur la page des clés d'API.

## Nouvelles tentatives

`external_id` est votre propre identifiant de l'événement, par exemple un numéro de commande. Si une requête est envoyée deux fois, la seconde réponse renvoie la même conversion et rien n'est compté en double. Si des données différentes arrivent sous le même identifiant, yoy.fyi répond par l'erreur `conversion_conflict`.

## Où voir le résultat

La page du lien contient un bloc sur les 30 derniers jours : combien d'inscriptions, combien d'achats et pour quel montant. Les montants sont additionnés par devise, car on ne peut pas additionner des hryvnias et des dollars.

Par l'API, `GET /v1/analytics/conversions` renvoie la même chose. Et si yoy.fyi est connecté à Claude ou ChatGPT, vous pouvez demander : « Combien d'achats le lien spring-concert a-t-il rapportés ce mois-ci ? »

## Bon à savoir

Une conversion ne peut être enregistrée que pour un clic sur un lien de votre propre service. yoy.fyi n'accepte pas l'identifiant d'un clic d'un autre service. L'heure de l'événement ne peut pas précéder le clic ni être dans le futur. Ces contrôles protègent des erreurs, pas de la fraude : si votre serveur envoie de fausses données, les statistiques seront fausses.
