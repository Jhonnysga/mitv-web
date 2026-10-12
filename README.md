# MiTV

Cliente web liviano y no oficial para ver tus canales de TV en vivo, guía de
programación, catchup (48 h), películas y series, usando tu suscripción del
servicio de TV por streaming (middleware Setplex Nora).

Sitio en vivo: **https://jhonnysga.github.io/mitv-web/**

## Uso

1. Abre el sitio en tu navegador (teléfono, tablet o computadora).
2. Inicia sesión con tu usuario y contraseña del servicio de TV.
   - Tus credenciales se guardan **solo** en el `localStorage` de tu navegador
     (si marcas "Recordarme") y se envían **únicamente** a
     `https://app.thundernet.net.ve`. Nada se envía a otros servidores.
3. Navega por las secciones: **En vivo**, **Películas**, **Series**, **Catchup**.

> **Nota:** el servicio aplica geobloqueo: funciona solo con IP de Venezuela.
> Si ves el mensaje "Servicio disponible solo en Venezuela", conéctate desde
> una red venezolana.

## Características

- Parrilla de canales con logo, número y nombre; categorías y favoritos.
- Guía EPG: "ahora/siguiente" en la parrilla y guía de 5 días por canal.
- Buscador y navegación por teclado (Tab/Enter, Esc para cerrar).
- Reproductor HLS con Shaka Player y soporte Widevine/EME.
- Catchup: programación de las últimas 48 h con reproducción.
- Películas y series con fichas, temporadas y episodios.
- Diseño responsive oscuro, sin build step: HTML + CSS + JS puros.

## Desarrollo

No hay proceso de compilación. Para probar en local basta servir la carpeta:

```bash
cd web && python3 -m http.server 8080
# abrir http://localhost:8080
```

El despliegue es GitHub Pages (rama `main`, carpeta `/`).

## Aviso

Proyecto no oficial, sin afiliación con el proveedor del servicio ni con Setplex.
Requiere una suscripción activa del servicio de TV.
