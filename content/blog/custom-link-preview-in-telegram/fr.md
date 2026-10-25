---
title: À quoi ressemble votre lien dans Telegram, et comment le changer
description: Définissez votre titre, votre description et votre image pour l'aperçu d'un lien court dans Telegram, Facebook, WhatsApp et ailleurs.
date: 2026-10-25
---

# À quoi ressemble votre lien dans Telegram, et comment le changer

Collez un lien dans Telegram et une carte apparaît dessous : titre, description, image. Telegram les prend sur la page vers laquelle pointe le lien. Si cette page n'a pas les bonnes balises, la carte est vide ou affiche une image au hasard, et on clique moins.

## Votre propre aperçu sur yoy.fyi

Les liens courts yoy.fyi ont des champs d'aperçu. Sur le site, ils se trouvent dans les options supplémentaires à la création, puis dans le formulaire de modification :

- titre de l'aperçu, jusqu'à 200 caractères ;
- description, jusqu'à 500 ;
- adresse de l'image, en https, idéalement 1200 sur 630 pixels ou plus.

Quand le robot d'aperçu de Telegram, Facebook, X, LinkedIn, Slack, WhatsApp ou Discord ouvre le lien, yoy.fyi lui renvoie une page avec vos balises. La personne qui clique arrive directement à la vraie adresse, sans page intermédiaire.

Si l'aperçu reste vide, rien ne change. Le robot suit le lien et lit les balises du site comme d'habitude.

## Une carte honnête

La carte affiche toujours le domaine vers lequel mène vraiment le lien. Vous pouvez choisir le titre et l'image, mais pas déguiser le site. yoy.fyi vérifie l'adresse de l'image comme celle du lien lui-même.

## Telegram garde les aperçus en mémoire

Telegram met la carte en cache. Si vous avez changé l'aperçu et que les conversations montrent encore l'ancien, écrivez à @WebpageBot et envoyez-lui le lien. Il met la carte à jour pour tout le monde.

## Depuis un chat

Ça marche aussi avec Claude ou ChatGPT : « Change l'aperçu de lviv-gig : titre Concert à Lviv, 25 octobre, image https://example.com/poster.jpg. » L'assistant appelle `update_link` avec le champ `preview`.
