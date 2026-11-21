# Checador 2027

Registro electrónico de jornada **con evidencia legal**, para la reforma a la LFT (art. 132, fr. XXXIV)
que obliga a llevar el registro desde el 1 de enero de 2027 y baja la jornada de 48 a 40 h entre 2026 y 2030.

No es "otro reloj checador": cada registro queda en una bitácora encadenada que no se puede editar,
las correcciones se agregan encima sin borrar nada, y el trabajador firma su semana por WhatsApp.
Eso es lo que convierte el registro en evidencia "acordada".

## Arranque rápido

Requisitos: Node 22 o superior. No hace falta instalar PostgreSQL: en desarrollo se usa
[PGlite](https://pglite.dev) (Postgres real embebido en Node).

```bash
npm install
cp server/.env.example server/.env
npm run seed -- --reset      # empresa demo, 4 empleados y 2 semanas de checadas
npm run dev                  # API en :3001 y web en :5173
```

Abre http://localhost:5173

| Pantalla | Ruta | Acceso demo |
|---|---|---|
| Kiosco (tablet) | `#/kiosco` | PINs 1234 Juan · 5678 Ana · 4321 Pedro · 8765 María |
| Panel de RH | `#/rh` | token `rh-demo` |
| Firma del trabajador | `#/firma/<id>` | el código aparece en el panel (modo demo) |

`SIMULAR_ANIO=2027` (en `server/.env`) calcula con el tope de 46 h para enseñar en demos cómo se verá 2027.

## Qué hay

**Servidor** (`server/`, Express 5 + PostgreSQL/PGlite)
- `bitacora`: una sola tabla de evidencia, de solo-agregar, encadenada con SHA-256. Un trigger de Postgres
  impide `UPDATE` y `DELETE`; si alguien lo salta con acceso directo a la base, la verificación lo detecta.
- Motor de jornada (`src/lib/jornada.js`): topes por año como datos, separa ordinarias / extra dobles /
  extra triples, jornada diurna-nocturna-mixta, turnos que cruzan la medianoche, salidas olvidadas que
  nunca se cierran solas.
- Kiosco: PIN → nombre → foto; hora siempre del servidor; huella SHA-256 de la foto en la bitácora;
  banderas (sin foto, reloj de la tablet desfasado, secuencia irregular) en lugar de bloqueos.
- Correcciones: se solicitan con motivo, se aprueban o rechazan una sola vez, el original se conserva.
- Firmas semanales: resumen con código de 6 dígitos (solo se guarda su HMAC), confirmar u objetar,
  recordatorios; todo queda en la bitácora.
- Empleados: alta individual o **importación desde Excel/CSV** (plantilla descargable, vista previa con
  errores por fila antes de guardar, actualización por número de empleado, PINs generados en Excel),
  cambios, nuevo PIN y bajas; todo queda en la bitácora.
- **Convenio de registro electrónico** + aviso de privacidad + política de jornada (modelos adaptados a la
  modalidad): se envían por WhatsApp al alta, el trabajador los lee y firma con código; el texto exacto
  queda en la bitácora con su huella. Recordatorios y "tengo dudas".
- **Expediente PDF para inspección STPS o demanda**: convenio firmado, semanas y su confirmación, cada
  registro con su evidencia (fotos verificadas contra su huella, GPS, IP), correcciones, constancias,
  textos firmados y hashes de cada evento. La huella del PDF generado queda en la bitácora.
- Panel: resumen con alertas, nómina en CSV, verificación de integridad y datos de la empresa.

**Web** (`web/`, React + Vite): kiosco con cámara y cuenta regresiva, panel de RH y página de firma.

## Pruebas

```bash
npm test
```

Cubren el cálculo de horas (2027, 2030, 12x12, nocturna, corrección) y el flujo completo del API,
incluida la detección de una alteración directa en la base.

## Producción

- `DATABASE_URL` para usar PostgreSQL real (el mismo esquema se aplica al arrancar).
- Cambiar `APP_SECRET` y `RH_TOKEN`; quitar `SIMULAR_ANIO` y `MODO_DEMO`.
- `STORAGE_DIR` → reemplazar `src/lib/almacen.js` por S3 o similar.
- `src/lib/notificador.js` → conectar WhatsApp Business o Twilio.

## Siguientes pasos

1. Conectar WhatsApp Business o Twilio (hoy los mensajes se escriben en la consola).
2. App de campo: modos 1-2-3, selfie + GPS solo al checar, sin conexión, visitas/rondines (Capacitor).
3. Home office: iniciar/pausa/terminar web, desconexión documentada, expediente NOM-037.
4. Usuarios con login y roles (RH, supervisor, trabajador) en lugar de tokens.
5. Sello de tiempo externo (NOM-151) del hash diario de la cadena.
6. Alta masiva de plantilla desde Excel y convenio firmado al alta.
7. Ajustar reportes cuando la STPS publique sus disposiciones en el DOF.

> Este software genera la mejor evidencia posible; no garantiza el resultado de un juicio.
> Convenios, avisos de privacidad y estrategia probatoria deben revisarse con un abogado laboralista.
