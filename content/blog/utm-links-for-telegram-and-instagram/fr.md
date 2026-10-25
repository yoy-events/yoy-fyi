---
title: Un seul lien pour Telegram, Instagram et l'e-mail, en sachant d'où vient chaque clic
description: Pourquoi les statistiques ignorent souvent d'où vient le visiteur, et comment les balises UTM de yoy.fyi règlent ça sans créer d'autres liens.
date: 2026-10-25
---

# Un seul lien pour Telegram, Instagram et l'e-mail, en sachant d'où vient chaque clic

Vous avez publié le lien d'un événement dans un canal Telegram, une story Instagram et une newsletter. Une semaine plus tard, les statistiques affichent 300 clics. D'où viennent-ils ? Souvent, la réponse honnête est « aucune idée ».

## Pourquoi l'origine se perd

Quand on ouvre un lien depuis Instagram ou Telegram, on atterrit en général dans le navigateur intégré de l'application. Ces navigateurs n'indiquent souvent pas au site la page d'où vient le visiteur. Pour vos statistiques, le clic ressemble à une visite directe, et tous les canaux finissent dans le même tas.

Les balises UTM règlent ça simplement. L'origine est écrite dans l'adresse, par exemple `?utm_source=telegram&utm_medium=social`. Le site et n'importe quel outil d'analyse voient la balise, même quand le navigateur ne dit rien.

## Comment yoy.fyi s'y prend

Pas besoin d'un lien court par canal. La page d'un lien contient un bloc de liens par canal, avec des variantes prêtes et un bouton pour copier :

- Telegram : `https://yoy.fyi/lviv-gig?utm_source=telegram&utm_medium=social`
- Instagram : `...?utm_source=instagram&utm_medium=social`
- Facebook : `...?utm_source=facebook&utm_medium=social`
- e-mail : `...?utm_source=email&utm_medium=email`

Même code, même QR code. yoy.fyi transmet les balises au site de destination. Si l'adresse de ce site contient déjà son propre `utm_source`, yoy.fyi n'y touche pas.

## Où voir le résultat

La page du lien affiche un bloc des canaux par `utm_source`, avec le nombre de clics de chaque canal sur 30 jours. Si yoy.fyi est connecté à Claude ou ChatGPT, il suffit de demander : « D'où venaient les clics sur lviv-gig cette semaine, par utm_source ? »

Les données brutes sont aussi disponibles. L'export CSV donne chaque clic avec l'heure, le pays, l'appareil et les balises UTM, pratique si votre rapport vit dans un tableur.

## Quelques habitudes utiles

Écrivez les balises en minuscules, et toujours de la même façon. `Telegram`, `telegram` et `tg` apparaîtront comme trois canaux différents.

Pour un QR code sur une affiche imprimée, créez un lien à part avec sa propre balise, comme `utm_source=poster`. Les scans dans la rue ne se mélangeront pas aux clics en ligne.

Si un lien est déjà publié sans balise, ce n'est pas grave. Ses clics comptent quand même, ils tombent simplement dans « sans balise ». Utilisez la variante du canal pour les nouvelles publications.

## En bref

Un lien court, quelques variantes balisées, et les statistiques montrent quel canal marche vraiment. Pas de tableau avec une douzaine de liens séparés, pas de devinettes.
