-- Checador 2027 · Esquema
-- Principio: todo lo que sirve como evidencia vive en `bitacora`, que es de solo-agregar
-- y está encadenada con hash. Las tablas de catálogo (empresas, empleados, centros) sí se editan.

CREATE TABLE IF NOT EXISTS empresas (
  id            serial PRIMARY KEY,
  nombre        text NOT NULL,
  zona_horaria  text NOT NULL DEFAULT 'America/Mexico_City',
  creado_en     timestamptz NOT NULL DEFAULT now()
);

-- Cabeza de la cadena por empresa. Se bloquea (FOR UPDATE) al agregar a la bitácora
-- para que dos registros simultáneos no tomen el mismo hash previo.
CREATE TABLE IF NOT EXISTS cadena_cabeza (
  empresa_id   int PRIMARY KEY REFERENCES empresas(id),
  ultimo_hash  text NOT NULL,
  ultimo_id    int,
  total        int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS centros (
  id                 serial PRIMARY KEY,
  empresa_id         int NOT NULL REFERENCES empresas(id),
  nombre             text NOT NULL,
  token_kiosco_hash  text UNIQUE
);

CREATE TABLE IF NOT EXISTS empleados (
  id            serial PRIMARY KEY,
  empresa_id    int NOT NULL REFERENCES empresas(id),
  numero        text NOT NULL,
  nombre        text NOT NULL,
  puesto        text,
  telefono      text,
  modalidad     text NOT NULL CHECK (modalidad IN ('presencial', 'campo', 'home_office')),
  tipo_jornada  text NOT NULL DEFAULT 'diurna' CHECK (tipo_jornada IN ('diurna', 'nocturna', 'mixta')),
  -- HMAC(APP_SECRET, empresa:pin). Permite buscar por PIN sin guardarlo en claro.
  pin_indice    text,
  activo        boolean NOT NULL DEFAULT true,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, numero),
  UNIQUE (empresa_id, pin_indice)
);

-- Bitácora de evidencia (solo-agregar, encadenada).
-- clase:
--   checada                 entrada / salida_comida / regreso_comida / salida
--   correccion_solicitada   alguien pide agregar o reemplazar una checada
--   correccion_aprobada     la corrección se aplica (actúa como checada efectiva)
--   correccion_rechazada
--   resumen_enviado         resumen semanal enviado al trabajador para firma
--   recordatorio            reenvío del resumen
--   firma                   el trabajador confirma su semana
--   objecion                el trabajador objeta su semana
--   nota                    cualquier otra constancia (alta, convenio, etc.)
CREATE TABLE IF NOT EXISTS bitacora (
  id             serial PRIMARY KEY,
  empresa_id     int NOT NULL REFERENCES empresas(id),
  empleado_id    int REFERENCES empleados(id),
  clase          text NOT NULL CHECK (clase IN (
                   'checada', 'correccion_solicitada', 'correccion_aprobada', 'correccion_rechazada',
                   'resumen_enviado', 'recordatorio', 'firma', 'objecion', 'nota')),
  -- Hora del evento (para checadas: la hora efectiva). Para todo lo demás = hora_servidor.
  hora           timestamptz NOT NULL,
  hora_servidor  timestamptz NOT NULL,
  datos          jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      text NOT NULL,
  hash           text NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS bitacora_empleado_hora ON bitacora (empresa_id, empleado_id, clase, hora);
CREATE INDEX IF NOT EXISTS bitacora_empresa_id ON bitacora (empresa_id, id);

-- Nadie (ni la propia aplicación) puede editar o borrar la bitácora.
CREATE OR REPLACE FUNCTION bitacora_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora de evidencia no se puede modificar ni borrar (id %)', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bitacora_inmutable ON bitacora;
CREATE TRIGGER trg_bitacora_inmutable
  BEFORE UPDATE OR DELETE ON bitacora
  FOR EACH ROW EXECUTE FUNCTION bitacora_inmutable();
