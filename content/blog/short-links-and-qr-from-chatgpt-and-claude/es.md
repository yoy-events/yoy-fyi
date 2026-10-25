---
title: Enlaces cortos y códigos QR directamente desde ChatGPT o Claude
description: Conecta yoy.fyi a Claude o ChatGPT y crea enlaces cortos que funcionan, códigos QR y estadísticas de clics con un simple mensaje.
date: 2026-10-25
---

# Enlaces cortos y códigos QR directamente desde ChatGPT o Claude

Le pides a un asistente que acorte un enlace y se inventa una dirección que no lleva a ninguna parte. Pasa a menudo. Un modelo de lenguaje no puede crear un enlace corto que funcione por sí solo. Alguien tiene que guardar el enlace y hacer la redirección.

yoy.fyi hace exactamente eso, y se puede conectar a Claude o a ChatGPT. A partir de ahí, los enlaces que te da el chat son reales. Se abren, tienen código QR y cuentan los clics.

## Qué necesitas

Una cuenta de Google y dos minutos. yoy.fyi es gratis y no hace falta registrarse aparte: al entrar con Google se crea la cuenta.

Todos los clientes usan la misma dirección:

```
https://yoy.fyi/mcp
```

Es un servidor MCP. MCP, el Model Context Protocol, es un protocolo abierto que los asistentes usan para llamar a herramientas externas.

## Conectarlo a Claude

1. Abre claude.ai, ve a la configuración y luego a Connectors.
2. Elige Add custom connector y pega `https://yoy.fyi/mcp`.
3. Pulsa Connect. Se abre yoy.fyi. Entra con Google.
4. En la página de permisos, marca la casilla para crear, cambiar y desactivar enlaces cortos. Viene desmarcada, y sin ella Claude solo puede leer tus enlaces.
5. Pulsa el botón para permitir. Vuelves a Claude.

En un chat nuevo, activa yoy.fyi desde el botón "+", en la sección de conectores. Anthropic cambia los nombres de estos menús de vez en cuando, pero el camino es parecido.

## Conectarlo a ChatGPT

En ChatGPT los conectores propios funcionan con el modo desarrollador: Settings, Apps & Connectors, Advanced, Developer mode. Crea un conector con la misma dirección, `https://yoy.fyi/mcp`. El inicio de sesión y la página de permisos son iguales que arriba. Que veas la opción o no depende de tu plan.

## Qué puedes pedir

Estas peticiones funcionan:

- "Acorta https://example.com/concierto-lviv-25-octubre y llámalo Concierto en Lviv"
- "Crea un enlace con el código lviv-gig hacia https://example.com/gig"
- "¿Cuántos clics tuvo lviv-gig esta semana y desde qué países?"
- "Muéstrame mis enlaces con la etiqueta music"
- "Haz que lviv-gig apunte a https://example.com/gig-new"
- "Desactiva lviv-gig"

El asistente llama a las herramientas de yoy.fyi y te devuelve una dirección real, por ejemplo `https://yoy.fyi/lviv-gig`. Ábrela en el navegador para comprobarlo.

## ¿Y el código QR?

Cada enlace tiene el suyo. Lo descargas en la página del enlace en yoy.fyi, como PNG de 1024 píxeles para imprimir o como SVG para diseño. En esa misma página puedes cambiar los colores y añadir un texto debajo del código, por ejemplo "Escanéame". El código lleva al enlace corto, así que cada escaneo también aparece en las estadísticas.

## Qué ve el asistente

Solo tus enlaces y solo con los permisos que diste. La conexión aparece en la página de aplicaciones conectadas de tu cuenta de yoy.fyi. Si la revocas ahí, su token deja de funcionar al momento.

## Por qué no basta con pedírselo al modelo

Un modelo puede escribir algo que parece un enlace. Pero la redirección vive en un servidor, y alguien tiene que guardarla, revisar la dirección y contar los clics. Esa parte la hace yoy.fyi. El chat es una forma cómoda de manejarlo.
