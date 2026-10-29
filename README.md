# VDownFast

Aplicación web personal para resolver y descargar videos e imágenes de redes sociales mediante [yt-dlp](https://github.com/yt-dlp/yt-dlp). Está construida con Node.js 22, TypeScript y Hono; la interfaz usa HTML, CSS y JavaScript nativos, sin frameworks ni recursos externos.

## Contenido

- [Arquitectura y funcionamiento](#arquitectura-y-funcionamiento)
- [Requisitos](#requisitos)
- [Ejecución local](#ejecución-local)
- [Despliegue con Docker](#despliegue-con-docker)
- [Inicio de sesión y sesiones](#inicio-de-sesión-y-sesiones)
- [Variables de entorno](#variables-de-entorno)
- [Cookies para contenido privado](#cookies-para-contenido-privado)
- [Dominios compatibles](#dominios-compatibles)
- [HTTPS y portapapeles](#https-y-portapapeles)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Solución de problemas](#solución-de-problemas)

## Arquitectura y funcionamiento

El navegador solicita la página a Hono, que sirve `src/index.html` con los dominios compatibles inyectados desde la constante compartida del backend. La interfaz gestiona el formulario, guarda la estrategia seleccionada en `localStorage` e intenta detectar enlaces en el portapapeles o al pegar texto. Al detectar una URL, inicia la descarga y pide en paralelo la auditoría de formatos.

`POST /api/formats` analiza la URL con yt-dlp y devuelve opciones de video, audio e imagen. Las opciones de video siempre seleccionan una pista de audio junto con el video; las opciones de solo audio se muestran en un grupo aparte. Las resoluciones de video aparecen de mayor a menor y las de audio se ordenan por bitrate. La primera opción es la mejor resolución de video disponible; la selección predeterminada es 1080p si existe, la resolución inferior más alta si no, o la menor resolución disponible si todas superan 1080p.

El cliente también envía `POST /api/resolve` para comenzar la descarga sin esperar a que termine la auditoría. El backend valida protocolo y dominio, y ejecuta yt-dlp con `child_process.spawn` y argumentos separados, nunca con un shell. El resultado de la auditoría se comparte entre solicitudes simultáneas y se guarda en memoria durante cinco minutos; la cola limita a tres los procesos yt-dlp simultáneos.

La estrategia seleccionada determina cómo se entrega el contenido:

- **URL directa:** el servidor transmite el formato seleccionado desde la plataforma sin remuxarlo. El paso por el backend permite conocer cuándo finaliza la transferencia.
- **Proxy streaming:** el servidor transmite el contenido al navegador y reenvía las solicitudes `Range`. Los enlaces requieren un token asociado a una resolución reciente; además, se bloquean destinos locales o privados para reducir el riesgo de SSRF.
- **Servidor descarga y sirve:** yt-dlp descarga el archivo temporalmente y el servidor lo entrega como adjunto. El archivo se elimina al terminar la transferencia o durante la limpieza de archivos expirados.

La interfaz mantiene el botón de descarga deshabilitado con un spinner hasta que el backend notifica que terminó la transferencia o se produjo un error. El backend expone `GET /api/downloads/:id/status` para consultar ese estado. Si el contenido necesita combinar pistas, remux a MP4 o incrustar una miniatura, se procesa con yt-dlp y ffmpeg. Cuando hay miniatura, se añade al MP4 como imagen de portada incrustada y se elimina el archivo temporal de imagen. La instalación Docker incluye ffmpeg. En el contenedor, yt-dlp se actualiza a la versión estable más reciente al arrancar y luego cada 24 horas. El arranque y las actualizaciones periódicas registran el resultado y la versión activa en los logs; los errores de extracción también quedan registrados sin incluir las URLs procesadas.

El acceso se gestiona con un formulario propio y sesiones persistentes. Las rutas de API y descarga requieren una sesión válida; `/healthz` permanece público para comprobaciones de servicio.

## Requisitos

### Para ejecución local

- Node.js 22 o superior y npm.
- yt-dlp disponible en `PATH`.
- ffmpeg disponible en `PATH` para combinar audio y video.

En Debian o Ubuntu, ffmpeg y las utilidades de soporte pueden instalarse con:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg python3 curl
```

Instala yt-dlp siguiendo las instrucciones oficiales del proyecto. Comprueba que `yt-dlp --version` y `ffmpeg -version` funcionen desde la terminal.

### Para Docker

Se requiere Docker Engine con el complemento Docker Compose. La imagen instala Node.js 22, ffmpeg, Python, curl y el binario oficial de yt-dlp.

## Ejecución local

Desde la raíz del proyecto, instala las dependencias:

```sh
npm ci
```

Para desarrollo con recarga automática:

```sh
npm run dev
```

Para compilar y ejecutar la versión compilada:

```sh
npm run build
npm start
```

La aplicación escucha en `http://localhost:3000` por defecto. En desarrollo, si no configuras credenciales, la autenticación queda desactivada. Para probar el login localmente, genera un hash y configura `AUTH_USER` y `AUTH_PASS_HASH` en el entorno.

```sh
npm run auth:hash
PORT=3000 AUTH_USER=usuario AUTH_PASS_HASH='scrypt$...' npm run dev
```

La ruta predeterminada para cookies de yt-dlp es `/data/cookies.txt`; puedes cambiarla con `COOKIES_PATH`.

## Despliegue con Docker

Desde la raíz del proyecto:

```sh
cp .env.example .env
```

Genera el hash de tu contraseña en una terminal interactiva:

```sh
npm run auth:hash
```

El script no muestra la contraseña mientras la escribes. Copia el hash que imprime a `AUTH_PASS_HASH` en `.env`, entre comillas simples, y cambia `AUTH_USER`. Protege el archivo `.env` y no lo subas al repositorio. Asegúrate además de que `data/` sea escribible por el usuario `node` del contenedor (UID 1000), pues allí se guarda la base SQLite:

```sh
mkdir -p data
```

Después descarga la imagen publicada en GitHub Container Registry y arranca el servicio:

```sh
docker compose pull
docker compose up -d
```

La aplicación estará disponible en `http://localhost:3000` si se ejecuta en el mismo equipo, o en `http://IP_DEL_SERVIDOR:3000` si está en un VPS. El puerto puede modificarse mediante `PORT` en `.env`.

Comandos útiles para operar el servicio:

```sh
docker compose logs -f
docker compose restart
docker compose down
```

Para comprobar la versión activa de yt-dlp o forzar su actualización a la última versión estable:

```sh
docker exec vdownfast yt-dlp --version
docker exec vdownfast yt-dlp -U
docker compose restart
```

El contenedor también comprueba las actualizaciones automáticamente cada 24 horas. Si no puede acceder al repositorio oficial, conserva la versión incluida en la imagen y muestra el fallo en los logs.

## Publicación de la imagen en GHCR

El workflow `.github/workflows/publish-ghcr.yml` construye y publica la imagen automáticamente en `ghcr.io/jonathanrangelb/vdownfast` con las etiquetas `latest` y `sha-<commit>` cada vez que se hace push a `main`. Usa `GITHUB_TOKEN`; no requiere secretos adicionales. Para que el VPS pueda descargarla sin iniciar sesión, configura la visibilidad del paquete como **Public** en GitHub Packages. Si prefieres mantenerlo privado, inicia sesión en GHCR desde el VPS con una credencial que tenga `read:packages`.

Compose monta `./data` en `/data` para `cookies.txt` y un volumen Docker dedicado en `/sessions` para SQLite. El volumen de sesiones se crea con permisos del usuario `node` y persiste aunque se recree el contenedor; `docker compose down -v` también lo elimina. Los archivos descargados temporalmente se guardan en `/tmp/dl` dentro del contenedor.

## Inicio de sesión y sesiones

La página muestra el formulario de acceso hasta que el backend confirma una sesión válida. Al iniciar sesión correctamente, el servidor establece una cookie aleatoria `HttpOnly`, `SameSite=Strict` y, en producción, `Secure`. El navegador la envía automáticamente en las visitas y peticiones posteriores; JavaScript no puede leerla.

Las sesiones se guardan en SQLite en `/sessions/sessions.sqlite` en Docker y sobreviven a reinicios o reconstrucciones del contenedor. La cookie contiene un identificador aleatorio; la base de datos almacena su hash, no el valor original. Cada sesión caduca después de `SESSION_TTL_DAYS` días (30 por defecto). **Cerrar sesión** revoca la sesión en el servidor y elimina la cookie.

La contraseña se configura como hash scrypt. Para generarlo, ejecuta `npm run auth:hash` y guárdalo en `AUTH_PASS_HASH`. `AUTH_PASS` en texto plano solo se admite temporalmente en desarrollo; en producción se exige el hash. En producción el servicio no inicia si faltan credenciales. En desarrollo, sin credenciales, el acceso queda abierto.

Se limita el inicio de sesión a cinco intentos por IP cada 15 minutos. Asegúrate de que Caddy reenvíe correctamente la IP del cliente y de que el puerto interno de la aplicación no quede expuesto directamente a Internet.

## Variables de entorno

| Variable | Valor predeterminado | Descripción |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP de la aplicación. |
| `AUTH_USER` | Sin definir | Usuario del login propio. Obligatorio en producción. |
| `AUTH_PASS_HASH` | Sin definir | Hash scrypt de la contraseña generado con `npm run auth:hash`. Obligatorio en producción. |
| `AUTH_PASS` | Sin definir | Compatibilidad temporal solo en desarrollo; no se acepta en producción. |
| `SESSION_DB_PATH` | `.data/sessions.sqlite` local; `/sessions/sessions.sqlite` fijado por Compose | Archivo SQLite donde se guardan las sesiones. |
| `SESSION_TTL_DAYS` | `30` | Duración de la sesión, entre 1 y 90 días. |
| `COOKIES_PATH` | `/data/cookies.txt` | Ruta del archivo de cookies compatible con yt-dlp. |

En el despliegue público, configura un usuario, genera un hash de contraseña robusta y sirve la aplicación mediante HTTPS. El atributo `Secure` de la cookie se activa automáticamente en la imagen Docker de producción.

## Cookies para contenido privado

Algunas plataformas requieren una sesión autenticada. Exporta las cookies desde el navegador en formato Netscape —por ejemplo, con una extensión de exportación de cookies— y guarda el archivo como:

```text
data/cookies.txt
```

El contenedor lo utiliza en las operaciones de yt-dlp si el archivo existe. No compartas este archivo ni lo subas a un repositorio: contiene credenciales de sesión. Si eliges otra ubicación, actualiza `COOKIES_PATH`.

## Dominios compatibles

La lista de dominios está definida en `src/domains.ts` y se comparte con el cliente al servir la página. Incluye Instagram, X/Twitter, TikTok, Facebook, fb.watch, YouTube, youtu.be, Reddit, Threads y Pinterest.

Para añadir o quitar plataformas, edita `SUPPORTED_DOMAINS` en ese archivo y reconstruye la aplicación. La validación del navegador y la del backend utilizarán la misma lista.

## HTTPS y portapapeles

Los navegadores requieren un contexto seguro para conceder acceso a `navigator.clipboard.readText()`. Por ello, la detección automática del portapapeles necesita HTTPS; abrir la página por HTTP en un VPS puede impedir esa función. El pegado mediante el evento `paste` y el envío manual también están disponibles.

Se puede añadir un proxy inverso TLS como Caddy delante del servicio, o utilizar Cloudflare Tunnel. Configura el proxy para reenviar las solicitudes al puerto de VDownFast y conserva la autenticación de la aplicación.

## Estructura del proyecto

```text
src/
  domains.ts       Lista de dominios y validación de URLs.
  index.html       Interfaz completa, con CSS y JavaScript inline.
  server.ts        Aplicación Hono, rutas API y gestión de yt-dlp.
Dockerfile         Imagen multi-stage basada en Node.js 22.
docker-compose.yml Servicio, puerto, variables y volumen de datos.
docker-entrypoint.sh Actualización inicial de yt-dlp y arranque.
.env.example      Plantilla de configuración.
```

Las rutas principales son `GET /`, `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/formats`, `POST /api/resolve`, `GET /api/proxy`, `GET /api/downloads/:id/status`, `GET /api/thumbnail`, `GET /api/file/:id` y `GET /healthz`.

## Solución de problemas

- **No abre la página:** comprueba que el contenedor esté activo con `docker compose ps` y revisa `docker compose logs -f`. Abre `http://localhost:3000` o la dirección IP y el puerto correctos; no abras `dist/index.html` directamente.
- **El contenido no se resuelve:** verifica que el enlace corresponda a un dominio compatible y que el contenido esté disponible. Para contenido privado, comprueba que `data/cookies.txt` esté en formato Netscape y sea legible por el contenedor.
- **YouTube pide confirmar que no eres un bot:** la plataforma está exigiendo autenticación para la IP del servidor. Exporta cookies de YouTube en formato Netscape, guárdalas como `data/cookies.txt` y reinicia el servicio. Actualizar yt-dlp no sustituye esta autenticación. Las cookies son credenciales sensibles y pueden caducar o rotar; no las compartas ni las subas al repositorio.
- **La descarga combinada falla:** confirma que yt-dlp está actualizado y que ffmpeg está disponible. La imagen Docker instala ambos componentes y actualiza yt-dlp automáticamente.
- **No se detecta el portapapeles:** utiliza HTTPS y concede el permiso del navegador. También puedes pegar el enlace en cualquier parte de la página o usar el formulario.
