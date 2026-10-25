---
title: Un solo enlace para Telegram, Instagram y email, sabiendo de dónde viene cada clic
description: Por qué las estadísticas a menudo no saben de dónde llega el visitante y cómo las etiquetas UTM de yoy.fyi lo resuelven sin crear más enlaces.
date: 2026-10-25
---

# Un solo enlace para Telegram, Instagram y email, sabiendo de dónde viene cada clic

Publicaste el enlace de un evento en un canal de Telegram, en una historia de Instagram y en un boletín. Una semana después las estadísticas dicen 300 clics. ¿De dónde? Muchas veces la respuesta sincera es "ni idea".

## Por qué se pierde el origen

Quien abre un enlace desde Instagram o Telegram suele acabar en el navegador integrado de la aplicación. Esos navegadores a menudo no le dicen al sitio de qué página viene la persona. Para tus estadísticas, el clic parece una visita directa, y todos los canales acaban en el mismo montón.

Las etiquetas UTM lo resuelven de forma sencilla. El origen va dentro de la dirección, por ejemplo `?utm_source=telegram&utm_medium=social`. El sitio y cualquier herramienta de analítica ven la etiqueta aunque el navegador no diga nada.

## Cómo lo hace yoy.fyi

No necesitas un enlace corto distinto para cada canal. La página del enlace tiene un bloque de enlaces por canal con variantes listas y un botón para copiar:

- Telegram: `https://yoy.fyi/lviv-gig?utm_source=telegram&utm_medium=social`
- Instagram: `...?utm_source=instagram&utm_medium=social`
- Facebook: `...?utm_source=facebook&utm_medium=social`
- email: `...?utm_source=email&utm_medium=email`

El mismo código y el mismo QR. yoy.fyi pasa las etiquetas al sitio de destino. Si la dirección de ese sitio ya tiene su propio `utm_source`, yoy.fyi no lo toca.

## Dónde ver el resultado

La página del enlace muestra un bloque de canales por `utm_source` con los clics de cada canal en los últimos 30 días. Si yoy.fyi está conectado a Claude o ChatGPT, basta con preguntar: "¿De dónde vinieron esta semana los clics de lviv-gig, por utm_source?"

También tienes los datos en bruto. La descarga en CSV trae cada clic con su hora, país, dispositivo y etiquetas UTM, algo útil si haces el informe en una hoja de cálculo.

## Algunos hábitos que ayudan

Escribe las etiquetas en minúsculas y siempre igual. `Telegram`, `telegram` y `tg` aparecen como tres canales distintos.

Para un QR en un cartel impreso, crea un enlace aparte con su propia etiqueta, por ejemplo `utm_source=poster`. Así los escaneos en la calle no se mezclan con los clics en línea.

Si un enlace ya está publicado sin etiquetas, no pasa nada. Sus clics se cuentan igual, solo que quedan como "sin etiqueta". Usa la variante del canal en las publicaciones nuevas.

## En resumen

Un enlace corto, unas cuantas variantes etiquetadas, y las estadísticas muestran qué canal funciona de verdad. Sin una hoja con una docena de enlaces sueltos y sin adivinar.
