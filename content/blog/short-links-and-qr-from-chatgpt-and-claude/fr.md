---
title: Liens courts et codes QR directement depuis ChatGPT ou Claude
description: Connectez yoy.fyi à Claude ou ChatGPT pour créer de vrais liens courts, des codes QR et suivre les clics avec un simple message.
date: 2026-10-25
---

# Liens courts et codes QR directement depuis ChatGPT ou Claude

Vous demandez à un assistant de raccourcir un lien et il invente une adresse qui ne mène nulle part. Ça arrive souvent. Un modèle de langage ne peut pas créer seul un lien court qui fonctionne. Il faut un service qui enregistre le lien et fait la redirection.

yoy.fyi est ce service, et on peut le brancher sur Claude ou ChatGPT. Ensuite, les liens que donne le chat sont réels. Ils s'ouvrent, ont un code QR et comptent les clics.

## Ce qu'il faut

Un compte Google et deux minutes. yoy.fyi est gratuit et il n'y a pas d'inscription à part : la connexion avec Google crée le compte.

Tous les clients utilisent la même adresse :

```
https://yoy.fyi/mcp
```

C'est un serveur MCP. MCP, le Model Context Protocol, est un protocole ouvert que les assistants utilisent pour appeler des outils externes.

## Le connecter à Claude

1. Ouvrez claude.ai, allez dans les paramètres, puis dans Connectors.
2. Choisissez Add custom connector et collez `https://yoy.fyi/mcp`.
3. Cliquez sur Connect. yoy.fyi s'ouvre. Connectez-vous avec Google.
4. Sur la page des autorisations, cochez la case qui permet de créer, modifier et désactiver des liens courts. Elle est décochée par défaut, et sans elle Claude peut seulement lire vos liens.
5. Cliquez sur le bouton pour autoriser. Vous revenez dans Claude.

Dans une nouvelle conversation, activez yoy.fyi avec le bouton "+", dans la partie connecteurs. Anthropic renomme ces menus de temps en temps, mais le chemin reste proche.

## Le connecter à ChatGPT

Dans ChatGPT, les connecteurs personnalisés passent par le mode développeur : Settings, Apps & Connectors, Advanced, Developer mode. Créez un connecteur avec la même adresse, `https://yoy.fyi/mcp`. La connexion et la page des autorisations fonctionnent comme plus haut. L'option dépend de votre abonnement.

## Ce que vous pouvez demander

Ces demandes fonctionnent :

- « Raccourcis https://example.com/concert-lviv-25-octobre et appelle-le Concert à Lviv »
- « Crée un lien avec le code lviv-gig vers https://example.com/gig »
- « Combien de clics a eu lviv-gig cette semaine, et depuis quels pays ? »
- « Montre mes liens avec le tag music »
- « Fais pointer lviv-gig vers https://example.com/gig-new »
- « Désactive lviv-gig »

L'assistant appelle les outils de yoy.fyi et renvoie une vraie adresse, par exemple `https://yoy.fyi/lviv-gig`. Ouvrez-la dans un navigateur pour vérifier.

## Et le code QR ?

Chaque lien a le sien. Téléchargez-le sur la page du lien dans yoy.fyi, en PNG de 1024 pixels pour l'impression ou en SVG pour vos maquettes. Sur la même page, vous pouvez changer les couleurs et ajouter une légende sous le code, comme « Scannez-moi ». Le code pointe vers le lien court, donc chaque scan apparaît aussi dans les statistiques.

## Ce que voit l'assistant

Uniquement vos liens, et uniquement avec les autorisations que vous avez données. La connexion apparaît dans la page des applications connectées de votre compte yoy.fyi. Révoquez-la là-bas et son jeton cesse de fonctionner aussitôt.

## Pourquoi ne pas simplement demander au modèle

Un modèle peut écrire un texte qui ressemble à un lien. Mais la redirection vit sur un serveur, et quelqu'un doit la conserver, vérifier l'adresse et compter les clics. C'est le rôle de yoy.fyi. Le chat est juste une façon pratique de le piloter.
