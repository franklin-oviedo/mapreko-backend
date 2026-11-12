# Despliegue en Render con Supabase

## Crear el servicio

En Render, crea un **Blueprint** desde este repositorio y la rama `main`. Render detectara `render.yaml`, compilara la API NestJS y ejecutara las migraciones al iniciar el servicio. El blueprint usa el plan gratuito; Render puede suspender servicios gratuitos inactivos, por lo que la primera solicitud tras una pausa puede tardar.

Al crear el servicio, Render solicitara las variables marcadas `sync: false`. Configura estos valores en el servicio, en **Environment**:

| Variable | Valor |
| --- | --- |
| `DATABASE_URL` | URI PostgreSQL de Supabase; para Render usa la cadena de conexion del **Session pooler** si el host de conexion directa no admite IPv4. |
| `DATABASE_SSL` | `true` |
| `FRONTEND_ORIGIN` | Origen de Cloudflare Pages, por ejemplo `https://mapreko-frontend.pages.dev`, sin barra final. |
| `GOOGLE_REDIRECT_URI` | `${FRONTEND_ORIGIN}/api/auth/google/callback`, usando el dominio real de Pages. |
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth de Google. |
| `GOOGLE_CLIENT_SECRET` | Secreto de ese cliente OAuth. |
| `AUTH_SECRET` | Secreto aleatorio de al menos 32 bytes. |

Obtiene la URI PostgreSQL en el panel de Supabase, en **Connect**. Copia la URI completa con usuario, contraseña, host, puerto y nombre de base de datos; reemplaza cualquier marcador de posicion de contraseña antes de guardarla. No guardes esa URI en Git, en Angular ni en variables publicas de Pages: ingresala solo en el entorno privado de Render. Mantén `DATABASE_SSL=true`; la app valida los certificados TLS.

Genera `AUTH_SECRET` localmente, por ejemplo con `openssl rand -base64 48`, y pegalo directamente en la variable privada `AUTH_SECRET` de Render. No lo compartas ni lo subas al repositorio.

## OAuth de Google

En Google Cloud Console, configura el cliente OAuth como aplicacion web. Agrega el dominio de Cloudflare Pages a **Authorized JavaScript origins** y agrega exactamente el valor de `GOOGLE_REDIRECT_URI` a **Authorized redirect URIs**. El servicio no habilita el acceso Google hasta que estas variables coincidan.

## URL del servicio

Render asigna al servicio un dominio `https://<nombre-del-servicio>.onrender.com`; configura ese origen sin ruta como `API_ORIGIN` en Cloudflare Pages. Luego usa **Manual Deploy > Deploy latest commit** si el servicio no se desplego automaticamente.
