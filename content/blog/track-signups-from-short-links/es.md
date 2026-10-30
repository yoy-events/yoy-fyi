---
title: Qué enlace trajo los registros y el dinero: conversiones en yoy.fyi
description: Cómo decirle a yoy.fyi que un clic acabó en un registro o una compra y ver en la página del enlace cuántas personas y cuánto dinero trajo.
date: 2026-10-26
---

# Qué enlace trajo los registros y el dinero: conversiones en yoy.fyi

Un clic dice poco. Lo que importa es si la persona se registró o compró una entrada. Si pones enlaces distintos en Telegram, Instagram y un boletín, quieres saber cuál trajo dinero, no solo clics.

## Cómo funciona

1. Crea el enlace con `pass_click_id: true`. Entonces yoy.fyi añade `yoy_sid`, el identificador de ese clic concreto, a la dirección a la que lleva el enlace.
2. En tu web, guarda `yoy_sid` (en una cookie o en un campo oculto del formulario) y llévalo hasta el registro o el pago.
3. Cuando ocurre el evento, tu servidor lo comunica a yoy.fyi con ese identificador.

```
POST https://yoy.fyi/v1/conversions
Authorization: Bearer yfi_...

{ "click_id": "01a17...", "event": "purchase", "value": 450, "currency": "UAH", "external_id": "order-77" }
```

La clave necesita el permiso `conversions:write`. Puedes elegirlo en la página de claves de API.

## Reintentos

`external_id` es tu propio identificador del evento, por ejemplo un número de pedido. Si una petición se envía dos veces, la segunda respuesta devuelve la misma conversión y nada se cuenta dos veces. Si con el mismo identificador llegan datos distintos, yoy.fyi responde con el error `conversion_conflict`.

## Dónde ver el resultado

La página del enlace tiene un bloque de los últimos 30 días: cuántos registros, cuántas compras y por qué importe. Los importes se suman por moneda, porque no se pueden sumar grivnas y dólares.

Por la API, `GET /v1/analytics/conversions` devuelve lo mismo. Y si yoy.fyi está conectado a Claude o ChatGPT, puedes preguntar: "¿Cuántas compras trajo este mes el enlace spring-concert?"

## Conviene saber

Una conversión solo se puede registrar para un clic en un enlace de tu propio servicio. yoy.fyi no acepta el identificador de un clic de otro servicio. La hora del evento no puede ser anterior al clic ni estar en el futuro. Estas comprobaciones protegen de errores, no del fraude: si tu servidor envía datos falsos, las estadísticas serán falsas.
