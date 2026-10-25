---
title: Cómo se ve tu enlace en Telegram y cómo cambiarlo
description: Pon tu propio título, descripción e imagen en la vista previa de un enlace corto en Telegram, Facebook, WhatsApp y otros mensajeros.
date: 2026-10-25
---

# Cómo se ve tu enlace en Telegram y cómo cambiarlo

Pegas un enlace en Telegram y debajo aparece una tarjeta: título, descripción e imagen. Telegram los saca de la página a la que lleva el enlace. Si esa página no tiene las etiquetas adecuadas, la tarjeta sale vacía o con una imagen al azar, y la gente hace menos clic.

## Tu propia vista previa en yoy.fyi

Los enlaces cortos de yoy.fyi tienen campos para la vista previa. En la web están entre las opciones extra al crear un enlace y luego en el formulario de edición:

- título de la vista previa, hasta 200 caracteres;
- descripción, hasta 500;
- dirección de la imagen, https, mejor de 1200 por 630 píxeles o más.

Cuando el bot de vista previa de Telegram, Facebook, X, LinkedIn, Slack, WhatsApp o Discord abre el enlace, yoy.fyi le da una página con tus etiquetas. Quien hace clic va directo a la dirección real, sin páginas intermedias.

Si dejas la vista previa vacía, no cambia nada. El bot sigue el enlace y lee las etiquetas del sitio como siempre.

## La tarjeta no engaña

La tarjeta siempre muestra el dominio al que lleva de verdad el enlace. Puedes poner tu título y tu imagen, pero no disfrazar el sitio. yoy.fyi revisa la dirección de la imagen igual que la del propio enlace.

## Telegram recuerda las vistas previas

Telegram guarda la tarjeta en caché. Si cambiaste la vista previa y en los chats sigue la vieja, escribe a @WebpageBot y envíale el enlace. Actualiza la tarjeta para todos.

## Desde un chat

También funciona con Claude o ChatGPT: "Cambia la vista previa de lviv-gig: título Concierto en Lviv, 25 de octubre, imagen https://example.com/poster.jpg". El asistente llama a `update_link` con el campo `preview`.
