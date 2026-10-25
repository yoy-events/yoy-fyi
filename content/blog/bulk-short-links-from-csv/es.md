---
title: Cien enlaces cortos de una vez con un archivo CSV
description: Cómo crear muchos enlaces cortos de yoy.fyi con un solo archivo de una hoja de cálculo y cómo exportar enlaces y clics a CSV.
date: 2026-10-25
---

# Cien enlaces cortos de una vez con un archivo CSV

Antes de un festival tienes una hoja con treinta sesiones, y cada una necesita un enlace corto y un código QR. Crearlos uno a uno lleva mucho tiempo. yoy.fyi acepta un archivo CSV.

## El formato

La primera línea nombra las columnas. Una es obligatoria, `target_url`. Otras tres son opcionales:

- `title`: el nombre del enlace;
- `code`: tu propio código, por ejemplo `fest-day1`;
- `tags`: etiquetas separadas por comas, con toda la celda entre comillas.

```
target_url,title,code,tags
https://example.com/fest/day-1,Festival día 1,fest-day1,"fest, day1"
https://example.com/fest/day-2,Festival día 2,fest-day2,"fest, day2"
```

Prepáralo en Google Sheets o Excel y guárdalo como CSV.

## Importar

En la página principal, debajo del formulario, hay un enlace para importar. Sube el archivo o pega el texto. Cada importación admite hasta 100 filas y 256 KB, y puedes hacer cinco por hora.

Después ves una lista. Cada fila muestra el nuevo enlace corto con un botón para copiar, o el motivo del fallo con el número de línea. Las filas buenas se crean aunque la de al lado tenga un problema, como un código ocupado o una dirección que no es http.

## Exportar

El enlace de exportación te da todos tus enlaces: código, dirección corta, destino, título, etiquetas, estado y total de clics. La página de cada enlace tiene además una descarga en CSV de sus clics, con hora, país, dispositivo y etiquetas UTM.

Las celdas que una hoja de cálculo podría tomar por una fórmula, como las que empiezan por `=`, llevan un apóstrofo delante. Abrir el archivo en Excel es seguro.

## Desde un chat

Con Claude o ChatGPT puedes crear hasta 20 enlaces en una sola petición. Prueba: "Crea enlaces cortos para estas cinco páginas y ponles la etiqueta fest".
