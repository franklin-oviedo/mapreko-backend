# MAPREKO Backend

NestJS + PostgreSQL 17. Base de datos compartida por MAPREKO Personal y Business;
una cuenta puede tener un espacio personal y pertenecer a varias organizaciones.
Los administradores internos de MAPREKO tienen autorizaciones independientes.

## Preparacion local (PowerShell)

Requiere Docker Compose y una version de Node compatible con las dependencias
instaladas de NestJS (Node 24.15+ dentro de la rama 24, o una LTS compatible mas reciente).

```powershell
npm ci
Copy-Item .env.example .env
```

Edita `.env`: sustituye `POSTGRES_PASSWORD` y la contrasena de `DATABASE_URL`
por la misma contrasena local propia. Si contiene caracteres especiales, usa
codificacion URL en `DATABASE_URL`. No publiques este archivo.
Si cambias usuario, base o puerto, actualiza tambien la URL.

```powershell
npm run db:up
npm run db:migrate
npm run db:status
npm run start:dev
```

PostgreSQL solo se publica en `127.0.0.1:55432`; NestJS usa el puerto 3000.
El volumen Docker conserva los datos entre reinicios. `npm run db:stop`
detiene PostgreSQL sin borrar el volumen. Las variables `POSTGRES_*` inicializan
un volumen nuevo: cambiarlas despues no cambia las credenciales de un volumen existente.

`DATABASE_SSL=true` exige TLS con verificacion de certificado; para la instancia
Docker local usa `false`. No se admiten parametros SSL en la URL que puedan
anular esta politica. En produccion configura un rol de aplicacion de privilegios
minimos, separado del rol que ejecuta migraciones.

## Migraciones

- [Configuracion](src/database/database.config.ts): exige `DATABASE_URL`;
  nunca sincroniza el esquema ni aplica migraciones al iniciar la aplicacion.
- [Migracion inicial](src/database/migrations/1794432000000-initial-schema.ts):
  crea tablas, indices, restricciones y disparadores dentro de una transaccion.
- `npm run db:migrate`: aplica migraciones pendientes.
- `npm run db:status`: muestra su estado.
- `npm run db:revert`: revierte la ultima migracion. **La reversion inicial
  elimina los datos del dominio**; usar solo en desarrollo o con respaldo.

Esta entrega usa TypeORM para conexion, transacciones y migraciones SQL explicitas.
El modulo de identidad usa consultas parametrizadas y transacciones TypeORM.
No incluye aun entidades/repositorios ORM de mantenimiento; los mapeos
se incorporaran con cada modulo sin activar `synchronize`.

## API de resumen y tareas

Requiere la cookie User vigente. No acepta una sesion Admin como sustituto ni IDs
de espacio como autorizacion. Todas las consultas verifican membresias activas y
excluyen propiedades/espacios archivados. Las escrituras exigen ademas el mismo
Origin y `X-Mapreko-Request: 1` del modulo de identidad.

- `GET /api/dashboard/user/summary`: propiedades visibles, indicadores y hasta
  50 tareas pendientes/en progreso. Filtros opcionales `propertyId` y `search`
  (maximo 100 caracteres); la busqueda por titulo/propiedad no altera indicadores.
- `POST /api/dashboard/user/properties`: `workspaceId`, `name`, `kind`, `address`.
  Registro minimo para iniciar el mantenimiento. Solo propietario/administrador.
- `POST /api/dashboard/user/tasks`: `propertyId`, `title`, `dueOn` (`YYYY-MM-DD`),
  `priority` (`low`, `medium`, `high`, `urgent`), `description` opcional.
  Propietario, administrador o miembro; nunca viewer. Inserta la orden y su
  actividad `created` atomicamente. El servidor determina espacio, autor y estado.

Los meses se calculan en la zona horaria del perfil. Las tareas canceladas no
cuentan. Cumplimiento = completadas / total de tareas con `plan_id` del mes;
sin denominador devuelve `null`, no 0%. La comparacion es en **puntos porcentuales**
frente al mes anterior; sin referencia devuelve `null`. Atencion = pendientes
vencidas + pendientes de prioridad alta/urgente aun no vencidas, sin duplicados.
Las fechas limite se guardan al final del dia en la zona horaria de la propiedad.
Al crear un plan se registra tambien su primera tarea y orden de trabajo, todo
en una transaccion. No se generan automaticamente las siguientes ocurrencias.

## API de mantenimiento y conocimiento

Las rutas requieren una sesion User activa y vuelven a comprobar la membresia
de la propiedad. Los cambios requieren el mismo Origin y
`X-Mapreko-Request: 1`; viewers solo pueden consultar.

- `GET /api/maintenance/user/plans`: planes accesibles, actividades del mes,
  propiedades visibles e indicadores. Acepta `propertyId` y `month` (`YYYY-MM`).
  Las actividades incluyen responsable(s), pasos, descripcion y permiso de escritura.
- `POST /api/maintenance/user/plans`: crea plan, tarea reutilizable, primera
  orden de trabajo, snapshot de tarea y actividad en una transaccion.
- `PATCH /api/maintenance/user/plans/:id/status`: pausa o reactiva un plan;
  la autorizacion y actualizacion se realizan bajo los mismos bloqueos.
- `POST /api/maintenance/user/activities/:id/complete`: marca una orden y sus
  pasos como completados y registra una actividad de historial atomicamente.
  Verifica membresia activa bajo bloqueo y no duplica el historial en reintentos.
- `GET /api/maintenance/user/articles`: guias publicadas con filtros `search`
  y `category`.
- `GET /api/maintenance/user/articles/:slug`: contenido completo de una guia.

El centro de conocimiento es contenido editorial general, no un diagnostico
ni una recomendacion generada con datos de una propiedad. La interfaz advierte
que no sustituye manuales, tecnicos, normas locales ni servicios de emergencia.

## Modelo de datos

| Area                  | Tablas                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidad             | `users`, `auth_identities`, `platform_admins`, `sessions`, `session_refresh_tokens`, `auth_events`                                                       |
| Personal / Business   | `workspaces`, `workspace_members`                                                                                                                        |
| Propiedades y activos | `properties`, `property_spaces`, `asset_categories`, `assets`                                                                                            |
| Mantenimiento         | `maintenance_plans`, `maintenance_plan_tasks`, `work_orders`, `work_order_assignees`, `work_order_tasks`, `work_order_activities`, `maintenance_records` |
| Recordatorios         | `reminders`                                                                                                                                              |
| Conocimiento          | `knowledge_categories`, `knowledge_articles`, `maintenance_recommendations`                                                                              |

```mermaid
erDiagram
  users ||--o{ auth_identities : identifies
  users ||--o{ sessions : opens
  sessions ||--o{ session_refresh_tokens : rotates
  users ||--o| platform_admins : explicitly_authorized
  users ||--o{ workspace_members : joins
  workspaces ||--|{ workspace_members : includes
  workspaces ||--o{ properties : owns
  properties ||--o{ property_spaces : contains
  properties ||--o{ assets : contains
  asset_categories |o--o{ assets : classifies
  properties ||--o{ maintenance_plans : schedules
  assets |o--o{ maintenance_plans : maintains
  maintenance_plans ||--o{ maintenance_plan_tasks : defines
  maintenance_plans |o--o{ work_orders : generates
  work_orders ||--o{ work_order_assignees : assigns
  work_orders ||--o{ work_order_tasks : snapshots
  work_orders ||--o{ work_order_activities : tracks
  work_orders |o--o| maintenance_records : records
  work_orders |o--o{ reminders : reminds
  maintenance_plans |o--o{ reminders : reminds
  knowledge_categories ||--o{ knowledge_articles : groups
  assets ||--o{ maintenance_recommendations : receives
  knowledge_articles |o--o{ maintenance_recommendations : explains
```

### Identidad y acceso

- No hay contrasenas locales. La identidad estable es `(provider, subject)`
  con proveedor `google` en el MVP, no el correo. La unicidad de correo se
  comprueba ignorando mayusculas y espacios exteriores.
- Los datos sincronizados de Google estan separados del perfil editable.
- El alta de `users` y `auth_identities` debe ocurrir en una transaccion;
  ante `23505` por concurrencia se revierte y recupera la identidad ya existente.
  No se deben vincular cuentas automaticamente por coincidencia de correo.
- `platform_admins` no tiene permisos administrativos por defecto.
  Los roles de organizacion nunca conceden administracion interna.
  El primer administrador requiere aprovisionamiento interno explicito.
- Las sesiones distinguen aplicaciones `user` / `admin` y registran expiracion,
  cierre y revocacion. Los tokens de renovacion guardan solo hashes SHA-256,
  su consumo, revocacion y cadena de rotacion; nunca tokens Google ni tokens en claro.
- El modulo de identidad implementa OIDC con la biblioteca oficial de Google,
  comprobacion de cuenta activa, permisos por aplicacion, cookies HttpOnly,
  proteccion CSRF por origen/cabecera, rotacion atomica y revocacion
  de la familia ante reutilizacion. Las cookies son Secure al servir sobre HTTPS.
- AUTH-08 queda fuera del MVP: la estructura conserva origen y fecha de
  vinculacion, pero no ofrece vinculacion/desvinculacion ni nuevos proveedores.

### Aislamiento Personal / Business

- `workspaces.kind = personal` representa la cuenta personal; `business`
  representa una organizacion, con nombre legal e identificacion fiscal opcionales.
- Un usuario solo tiene un espacio personal, que solo admite a su propietario.
  El tipo del espacio y el propietario personal son inmutables.
- El propietario se obtiene de `owner_user_id`; las membresias adicionales
  usan roles `admin`, `member` y `viewer`, con estado activo/inactivo.
  Cambiar el propietario Business requiere verificar permisos en el servicio.
- Crea el espacio y la membresia de su propietario en la misma transaccion:
  la FK del propietario es diferida hasta el commit.
- Todas las referencias entre recursos privados incluyen `workspace_id`.
  Un activo no puede apuntar a una propiedad de otro espacio; tampoco se puede
  asignar una orden a un usuario externo. Las ubicaciones y activos asociados
  a planes, ordenes e historial deben pertenecer a la misma propiedad.
- La base impide relaciones cruzadas, **no filtra consultas ni usa RLS**.
  Cada servicio debe autorizar membresia activa/rol y filtrar por el espacio
  autenticado; no debe confiar en un `workspace_id` recibido del cliente.
- Las membresias con historial se desactivan en vez de eliminarse. Propiedades
  y activos se archivan; las FK restrictivas protegen las referencias historicas.

### Mantenimiento, calendario e indicadores

- `assets.kind` diferencia equipos e instalaciones. Los espacios de una
  propiedad permiten registrar habitaciones, plantas o areas.
- Un plan recurrente pertenece a una propiedad y opcionalmente a un activo.
  Guarda intervalo positivo, fechas, zona horaria IANA y siguiente vencimiento.
  La aplicacion validara las zonas horarias.
- El futuro programador calcula recurrencias en la zona del plan (incluidos
  cambios de horario y fin de mes) y genera ordenes. La unicidad de
  `(workspace_id, plan_id, scheduled_for)` evita duplicar una ocurrencia.
  `scheduled_for` conserva la ocurrencia original aunque se reprograme `due_at`.
- `work_orders` tambien representa tareas personales. Las plantillas se copian
  a `work_order_tasks` para conservar instrucciones aunque cambie el plan.
- Al completar una orden, el servicio actualizara estado, actividades e
  historial en una transaccion. `maintenance_records` tambien admite
  mantenimiento registrado manualmente sin orden previa.
- El calendario se deriva de `next_due_at`, `due_at` y `remind_at`; no hay
  una tabla duplicada de eventos. Un recordatorio apunta exactamente a un plan
  o una orden, y conserva estado de entrega/intentos/error sin ocultar fallos.
- Indicadores basicos se consultan por espacio y periodo: ordenes pendientes,
  vencidas (`due_at < now()` y estado abierto), completadas, duracion real y
  costos del historial. Los costos deben agruparse por `currency_code`, nunca
  sumar monedas distintas ni duplicar filas al unir responsables/actividades.
- UUID como claves, `timestamptz` para instantes y `numeric` para dinero.
  No hay datos ficticios, articulos generados ni administradores precreados.

## Pruebas

```powershell
npm test
npm run lint
npm run build

# Usa una instancia local dedicada a pruebas, con permiso CREATE SCHEMA.
# Nunca apuntar las pruebas a produccion.
$env:TEST_DATABASE_URL = 'postgresql://usuario:clave@localhost:55432/mapreko'
npm run test:database
```

Las pruebas PostgreSQL crean un esquema aleatorio aislado y solo eliminan ese
esquema al terminar. Comprueban concurrencia en identidades, aislamiento entre
espacios, roles, rotacion de tokens, calendarios, historial, restricciones y
el ciclo completo aplicar/revertir/reaplicar. Tambien prueban el modulo de
identidad por HTTP con Google simulado. Las pruebas unitarias del verificador
usan firmas RSA reales con claves exclusivamente de prueba.
Las pruebas HTTP existentes (`npm run test:e2e`) necesitan `DATABASE_URL` y una
instancia PostgreSQL disponible porque ahora cargan el modulo de persistencia.

## Frontend y trabajo conjunto

Abre [mapreko.code-workspace](../mapreko-frontend/mapreko.code-workspace) desde VS Code
y ejecuta **MAPREKO: iniciar ambos** despues de preparar la base.
Los repositorios conservan su propio historial Git.
El frontend sigue en `http://localhost:4200`; no contiene acceso directo a PostgreSQL.

Referencia visual: [Figma MAPREKO](https://www.figma.com/design/oDmfB3J29wePUFrYRXWt8v/MAPREKO?node-id=0-1).
El modelo soporta los modulos Resumen, Plan de mantenimiento y Aprende observados
en el prototipo. La etapa de identidad ya tiene pantallas y endpoints; los modulos
de mantenimiento, programadores y entregas de correo se implementaran despues.

## Google OAuth: configuracion local

AUTH-01 a AUTH-07 estan implementadas. AUTH-08 permanece fuera del MVP.
El flujo es OIDC Authorization Code con PKCE S256, state y nonce.
Solicita exclusivamente `openid email profile`. No guarda access/refresh tokens
Google, contrasenas locales ni credenciales propias en almacenamiento JavaScript.

1. En Google Cloud crea/configura un cliente OAuth de tipo **Aplicacion web**,
   con pantalla de consentimiento y usuarios de prueba si esta en modo Testing.
2. Autoriza el origen `http://localhost:4200` y la URI de redireccion exacta
   `http://localhost:4200/api/auth/google/callback`.
3. Agrega localmente a `.env` (no al repositorio):

```dotenv
FRONTEND_ORIGIN=http://localhost:4200
GOOGLE_REDIRECT_URI=http://localhost:4200/api/auth/google/callback
GOOGLE_CLIENT_ID=tu-cliente.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-secreto-local
AUTH_SECRET=
```

Genera `AUTH_SECRET` localmente con al menos 32 bytes aleatorios, por ejemplo
`node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`.
Conserva el mismo secreto entre reinicios e instancias. Rotarlo invalida los
JWT anteriores. No pegues secretos en chats, issues ni capturas.

4. Ejecuta `npm run db:migrate` y reinicia el backend despues de cambiar `.env`.
   Inicia Angular y abre `/login`. El backend expone configuracion publica de
   disponibilidad, nunca el secreto ni los valores OAuth.

La migracion adicional permite que un nombre no disponible desde Google sea
NULL, sin inventar datos del usuario. Su reversion se rechaza si existen usuarios
sin nombre: primero revisa esos datos manualmente o conserva la migracion.

En produccion usa `NODE_ENV=production`, un unico origen HTTPS publico y un reverse
proxy para `/api`. `GOOGLE_REDIRECT_URI` debe ser ese origen seguido de
`/api/auth/google/callback`. Configura ambas variables tambien en Google Cloud.
No se habilita CORS: las mutaciones requieren el Origin exacto y
`X-Mapreko-Request: 1`; las peticiones de otros origenes no pueden superar
el preflight. Una cookie firmada HttpOnly de 10 minutos protege el flujo OAuth.
Access JWT dura 15 minutos; la sesion/refresh tiene vencimiento absoluto de 30 dias.
La cookie User es distinta de Admin; las dos aplicaciones revalidan permisos en
la base en cada solicitud. Una suspension o revocacion administrativa tiene
efecto inmediato en las peticiones protegidas.

La renovacion bloquea la sesion y rota su token en una transaccion. La reutilizacion
de un token consumido revoca la sesion completa y registra el evento, incluso al
devolver 401. El cliente debe serializar renovaciones para no disparar esa politica.
Las marcas de revocacion usan `clock_timestamp()`: `now()` conserva la hora de
inicio de transaccion y puede ser anterior a un token creado mientras se espera un bloqueo.
Los limites de peticiones usan el almacen en memoria de `@nestjs/throttler`;
en un despliegue multiinstancia debe sustituirse por almacenamiento compartido.
No habilites `trust proxy` sin configurar expresamente los proxies de confianza.

## API de identidad

OpenAPI/Swagger: `http://localhost:3000/api/docs`; JSON en `/api/docs-json`.
`application` solo admite `user` o `admin`.

| Metodo | Ruta                                  | Comportamiento                                                     |
| ------ | ------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/auth/config`                    | Disponibilidad publica del acceso Google                           |
| GET    | `/api/auth/google/start/:application` | Redirige a Google                                                  |
| GET    | `/api/auth/google/callback`           | Valida firma, iss, aud, exp, sub, nonce y correo verificado        |
| GET    | `/api/auth/:application/session`      | Perfil, permisos actuales y espacios propios                       |
| POST   | `/api/auth/:application/refresh`      | Renueva cookies sin exponer tokens al cliente                      |
| POST   | `/api/auth/:application/logout`       | Cierre idempotente y revocacion                                    |
| PATCH  | `/api/auth/:application/profile`      | Nombre, apellidos, nombre visible, telefono, idioma y zona horaria |
| GET    | `/api/auth/:application/sessions`     | Sesiones propias activas de esa aplicacion                         |
| DELETE | `/api/auth/:application/sessions/:id` | Revoca una sesion propia                                           |

Las respuestas privadas son `Cache-Control: no-store`. Los cuerpos de perfil
desconocidos, vacios o invalidos se rechazan con 400; email/sub no son editables.
El correo no vincula cuentas automaticamente: una colision con otra identidad
devuelve conflicto y requiere soporte. El perfil propio no es sobrescrito por
sincronizaciones posteriores de nombre Google.

### Aprovisionamiento interno de administradores

El usuario debe acceder primero a MAPREKO User para crear su identidad.
Un operador autorizado registra despues su `user_id` en `platform_admins`,
indicando rol `admin` o `support` y el `granted_by` del operador.
El primer registro requiere el procedimiento interno de bootstrap con una
conexion de base autorizada; no existe endpoint publico de autoasignacion.
Un administrador de organizacion Business nunca concede acceso a Admin.
`support` recibe `knowledge:read`; `admin` tambien `knowledge:write`.
Revocar `platform_admins.revoked_at` impide inmediatamente usar sesiones Admin.

La interfaz web es adaptable a navegadores Android. Un cliente Android nativo,
otros proveedores y vinculacion de identidades requieren una etapa posterior.
La prueba final con una cuenta Google real requiere configurar el cliente
OAuth local y completar interactivamente el consentimiento.

---

## Documentacion original del scaffolding NestJS

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

To add it to this project, run this and approve the code it prints at [observe.nestjs.com/link](https://observe.nestjs.com/link) - signing up for free if you have no account:

```bash
$ npx @nestjs/observe link
```

It installs `@nestjs/observe`, wires it into `AppModule` and `main.ts`, and writes the app key and secret into `.env`, which every `nest start` script (`start`, `start:dev`, `start:debug`) then loads. In production, set `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` in the environment instead.

Or do it by hand:

```bash
$ npm install @nestjs/observe
```

Then follow the [setup guide](https://docs.nestjs.com/observability/sdk) - it takes a single import and an app key.

The free plan needs no payment details and covers 300,000 events a month. You can also browse the [live demo](https://www.observe-demo.nestjs.com/dashboard) first - the whole dashboard over a busy service's data, with nothing to install.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
