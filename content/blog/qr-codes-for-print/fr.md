---
title: Un code QR pour vos affiches, modifiable après l'impression
description: Comment préparer sur yoy.fyi un code QR à imprimer qui se scanne bien, compte les scans à part et pointe au bon endroit après impression.
date: 2026-10-25
---

# Un code QR pour vos affiches, modifiable après l'impression

Les affiches sont imprimées et la page d'inscription vient de changer d'adresse. Si le code QR pointait directement vers l'ancienne page, le tirage est perdu. S'il pointait vers un lien court, il suffit de changer la destination du lien.

## Pourquoi passer par un lien court

Un code QR yoy.fyi encode une adresse comme `https://yoy.fyi/fest`. Vous choisissez où elle redirige sur la page du lien, à tout moment, dans le formulaire de modification. Le code imprimé ne change pas.

Un code court rend aussi le QR plus simple. Moins de données, donc moins de petits carrés, et une meilleure lecture à distance.

## Formats pour l'impression

La page du lien en propose deux :

- un PNG de 1024 pixels, pour les flyers et les réseaux sociaux ;
- un SVG, vectoriel, pour les grands formats. Il s'agrandit sans perte de qualité, ce que les imprimeurs apprécient.

## Couleurs et légende

Dans le bloc des couleurs et de la légende du QR, vous choisissez la couleur du code et du fond. yoy.fyi refuse un code clair sur fond sombre et les couleurs trop peu contrastées, parce que beaucoup de téléphones ne les lisent tout simplement pas.

Sous le code, vous pouvez ajouter une légende comme « Scannez-moi » ou « Inscription ». La légende n'existe que dans le SVG.

## Compter les scans à part des clics

Créez un lien court dédié à l'affiche. Sa page sur yoy.fyi ne montrera alors que les scans de l'affiche, à part des clics d'Instagram. Ajoutez une balise comme `?utm_source=poster` à l'adresse de destination, et l'analyse de votre site verra aussi ces scans.

## Testez avant d'imprimer

Scannez le code à l'écran avec deux téléphones différents, puis sur une épreuve imprimée, à la distance où les gens le verront. Sur une affiche, gardez au moins 3 centimètres sur 3, et davantage pour une affiche lue de loin.
