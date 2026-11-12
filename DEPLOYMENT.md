# Despliegue en Render con Supabase

## Crear el servicio

En Render, crea un **Blueprint** desde este repositorio y la rama `main`. Render detectara `render.yaml`, compilara la API NestJS y ejecutara las migraciones al iniciar el servicio. El blueprint usa el plan gratuito; Render puede suspender servicios gratuitos inactivos, por lo que la primera solicitud tras una pausa puede tardar.

El comando de compilacion es `npm ci --include=dev && npm run build`. Se incluyen las dependencias de desarrollo porque contienen el compilador NestJS, incluso cuando `NODE_ENV=production`.

Si el servicio ya existe y conserva una configuracion anterior, sincroniza el Blueprint o actualiza **Settings > Build & Deploy > Build Command** con ese comando. Despues ejecuta **Manual Deploy > Clear build cache & deploy**. El `package-lock.json` del repositorio debe mantenerse sincronizado con `package.json`; para actualizarlo localmente usa `npm install --package-lock-only` y confirma que `npm ci --include=dev` funciona antes de publicarlo.

Al crear el servicio, Render solicitara las variables marcadas `sync: false`. Configura estos valores en el servicio, en **Environment**:

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | URI PostgreSQL de Supabase; para Render usa la cadena de conexion del **Session pooler** si el host de conexion directa no admite IPv4. |
| `DATABASE_SSL` | `true` |
| `FRONTEND_ORIGIN` | Origen publico del frontend en Cloudflare, por ejemplo `https://mapreko-frontend.<subdominio-cuenta>.workers.dev`, sin barra final. |
| `GOOGLE_REDIRECT_URI` | `${FRONTEND_ORIGIN}/api/auth/google/callback`, reemplazando el marcador por el origen real del frontend. |
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth de Google. |
| `GOOGLE_CLIENT_SECRET` | Secreto de ese cliente OAuth. |
| `AUTH_SECRET` | Secreto aleatorio de al menos 32 bytes. |

Obtiene la URI PostgreSQL en el panel de Supabase, en **Connect**. Copia la URI completa con usuario, contraseña, host, puerto y nombre de base de datos; reemplaza cualquier marcador de posicion de contraseña antes de guardarla. No guardes esa URI en Git, en Angular ni en variables publicas de Pages: ingresala solo en el entorno privado de Render. Mantén `DATABASE_SSL=true`; la app valida los certificados TLS.

Genera `AUTH_SECRET` localmente, por ejemplo con `openssl rand -base64 48`, y pegalo directamente en la variable privada `AUTH_SECRET` de Render. No lo compartas ni lo subas al repositorio.

## Conexion PostgreSQL, no API de Supabase

Este backend usa TypeORM y PostgreSQL. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` y `SUPABASE_JWKS_URL` no son variables consumidas por la aplicacion y no sustituyen `DATABASE_URL`. El inicio de sesion actual usa Google directamente, no Supabase Auth.

Guarda en **Render > Environment** la URI PostgreSQL del **Session pooler** de Supabase y `DATABASE_SSL=true`. Si la URI incluye parametros `sslmode` u otros parametros `ssl*`, quitalos: la politica TLS se configura mediante `DATABASE_SSL` y la aplicacion rechaza configuraciones duplicadas. Codifica los caracteres especiales de la contrasena para una URI.

Si una clave secreta se comparte en un chat o un registro, revocala y genera una nueva desde el panel de Supabase. Nunca la guardes en el repositorio ni en el frontend; no hace falta anadirla al backend actual.

## OAuth de Google

En Google Cloud Console, configura el cliente OAuth como aplicacion web. Agrega el origen publico del frontend a **Authorized JavaScript origins** y agrega exactamente el valor de `GOOGLE_REDIRECT_URI` a **Authorized redirect URIs**. El servicio no habilita el acceso Google hasta que estas variables coincidan.

## URL del servicio

Render asigna al servicio un dominio `https://<nombre-del-servicio>.onrender.com`; configura ese origen sin ruta como variable de ejecucion `API_ORIGIN` del frontend en Cloudflare. Luego usa **Manual Deploy > Deploy latest commit** si el servicio no se desplego automaticamente. Si cambias de Pages a Workers, actualiza `FRONTEND_ORIGIN`, `GOOGLE_REDIRECT_URI` y la configuracion OAuth de Google con el dominio nuevo.
