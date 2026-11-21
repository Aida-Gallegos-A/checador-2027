// Documentos que el trabajador firma al alta: convenio de registro electrónico, aviso de privacidad
// y política de jornada y desconexión. Son MODELOS: deben revisarse con un abogado laboralista.
// El texto exacto que se envía queda guardado en la bitácora con su hash, así siempre se puede
// demostrar qué firmó cada persona aunque la plantilla cambie después.

export const VERSION_DOCUMENTOS = '2026-11-v1';

const EVIDENCIA = {
  presencial:
    'en la tablet (kiosco) ubicada en el centro de trabajo, tecleando un PIN personal. Al registrar, la tablet toma automáticamente '
    + 'una fotografía del rostro para acreditar quién realizó el registro. El sistema detecta si hay un rostro en la imagen, pero no '
    + 'identifica a la persona ni genera plantillas biométricas',
  campo:
    'desde la aplicación instalada en el teléfono celular dado de alta para el TRABAJADOR, o en la tablet de la oficina cuando así se '
    + 'indique. Al registrar desde el celular se toma una fotografía (selfie) y la ubicación GPS ÚNICAMENTE en el momento exacto del '
    + 'registro. La aplicación NO rastrea la ubicación durante la jornada ni fuera de ella',
  home_office:
    'desde la página web o la aplicación, con las acciones "Iniciar", "Pausa" y "Terminar". Se guarda la dirección IP y el tipo de '
    + 'dispositivo. NO se registra la ubicación exacta del domicilio, ni se monitorea la pantalla, el teclado o la cámara',
};

const DATOS_POR_MODALIDAD = {
  presencial: 'fotografía del rostro tomada al momento de registrar',
  campo: 'fotografía (selfie) y ubicación GPS tomadas solo al momento de registrar; identificador del teléfono vinculado',
  home_office: 'dirección IP y tipo de dispositivo al momento de registrar (sin ubicación exacta del domicilio)',
};

const MODALIDAD_TEXTO = { presencial: 'presencial', campo: 'de campo', home_office: 'teletrabajo (home office)' };

export function documentosPara(empresa, empleado) {
  const patron = empresa.nombre;
  const rfc = empresa.rfc ? `, con RFC ${empresa.rfc}` : '';
  const domicilio = empresa.domicilio ?? '[domicilio de la empresa pendiente de capturar]';
  const correo = empresa.correo_privacidad ?? '[correo de privacidad pendiente de capturar]';
  const trab = empleado.nombre;
  const mod = empleado.modalidad;

  const convenio = [
    `CONVENIO PARA EL USO DEL REGISTRO ELECTRÓNICO DE JORNADA`,
    `Que celebran ${patron}${rfc} (en adelante, "LA EMPRESA") y ${trab}, número de empleado ${empleado.numero} (en adelante, "EL TRABAJADOR"), conforme al artículo 132, fracción XXXIV, de la Ley Federal del Trabajo.`,
    `PRIMERA. Objeto. Las partes acuerdan que la hora de inicio y de término de la jornada, así como las pausas para tomar alimentos, se registrarán por medios electrónicos en el sistema Checador 2027, y que dicho registro será el medio para acreditar la jornada efectivamente laborada.`,
    `SEGUNDA. Forma de registro. EL TRABAJADOR, en modalidad ${MODALIDAD_TEXTO[mod]}, registrará su entrada, salida a comer, regreso y salida ${EVIDENCIA[mod]}.`,
    `TERCERA. Hora del registro. La hora de cada registro es la del servidor del sistema y no la del dispositivo, de modo que no puede ser modificada por ninguna de las partes.`,
    `CUARTA. Inalterabilidad. Los registros no se borran ni se editan. Si EL TRABAJADOR olvida registrar o considera que un registro es incorrecto, podrá solicitar una corrección indicando el motivo; la corrección se agrega al historial con quién la pidió, quién la autorizó y cuándo, y el registro original se conserva.`,
    `QUINTA. Confirmación semanal. Cada semana EL TRABAJADOR recibirá por WhatsApp o SMS el resumen de sus horas ordinarias y extraordinarias. Podrá confirmarlo con el código que reciba o manifestar su inconformidad; en este último caso LA EMPRESA revisará el registro y le enviará un resumen corregido. La confirmación no impide a EL TRABAJADOR ejercer los derechos que la ley le otorga.`,
    `SEXTA. Tiempo extraordinario. El tiempo extraordinario solo se laborará cuando LA EMPRESA lo autorice, se registrará en el sistema y se pagará conforme a la Ley Federal del Trabajo. Si EL TRABAJADOR continúa laborando después de cumplir su jornada, el sistema lo registrará como tiempo extraordinario.`,
    `SÉPTIMA. Acceso. EL TRABAJADOR podrá consultar en cualquier momento su historial de registros y solicitar una copia.`,
    `OCTAVA. Conservación. Los registros se conservarán durante la relación de trabajo y, al menos, un año después de su terminación, y se pondrán a disposición de la autoridad laboral cuando lo requiera.`,
    `NOVENA. Firma electrónica. EL TRABAJADOR firma este convenio ingresando el código que recibió en su teléfono ${empleado.telefono ?? ''}. Las partes reconocen esta firma como manifestación expresa de su voluntad.`,
  ].join('\n\n');

  const aviso = [
    `AVISO DE PRIVACIDAD INTEGRAL PARA EL REGISTRO DE JORNADA`,
    `Responsable. ${patron}${rfc}, con domicilio en ${domicilio}, es responsable del tratamiento de los datos personales que se describen a continuación, conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.`,
    `Datos que se tratan. Nombre, número de empleado, puesto, teléfono celular, horas de entrada, salida y pausas, y ${DATOS_POR_MODALIDAD[mod]}.`,
    `Datos que NO se tratan. No se realiza reconocimiento facial ni se generan datos biométricos. No se rastrea la ubicación fuera del momento de registrar. No se monitorean pantallas, teclados ni conversaciones.`,
    `Finalidades. (1) Cumplir la obligación de llevar un registro electrónico de la jornada (art. 132, fr. XXXIV, LFT); (2) calcular horas ordinarias y extraordinarias para el pago de salarios; (3) acreditar la jornada ante la autoridad laboral o en un procedimiento; (4) enviarle por WhatsApp o SMS los resúmenes semanales y códigos de firma.`,
    `Transferencias. Los datos podrán entregarse a la Secretaría del Trabajo y Previsión Social y a autoridades laborales o jurisdiccionales cuando lo requieran, sin necesidad de su consentimiento. Los proveedores de tecnología (almacenamiento en la nube y mensajería) actúan como encargados y no pueden usar los datos para fines propios.`,
    `Conservación. Durante la relación laboral y un año después de su terminación, salvo que una disposición legal o un procedimiento en curso exija conservarlos por más tiempo.`,
    `Derechos ARCO. Puede solicitar el acceso, rectificación, cancelación u oposición al tratamiento de sus datos, en lo que no se oponga a obligaciones legales de LA EMPRESA, escribiendo a ${correo}.`,
    `Cambios. Cualquier cambio a este aviso se le comunicará por el mismo medio por el que recibió este documento.`,
  ].join('\n\n');

  const politica = [
    `POLÍTICA DE JORNADA, TIEMPO EXTRA Y DESCONEXIÓN`,
    `1. Jornada. La jornada de EL TRABAJADOR es ${empleado.tipo_jornada ?? 'diurna'}, con el horario pactado en su contrato, y respeta el máximo semanal vigente cada año conforme a la reforma a la Ley Federal del Trabajo (46 horas en 2027, 44 en 2028, 42 en 2029 y 40 en 2030), sin reducción de salario.`,
    `2. Registro completo. Debe registrarse todo el tiempo laborado, incluido el que se trabaje fuera del horario a solicitud de un superior.`,
    `3. Tiempo extra autorizado. Ningún superior puede pedir trabajo fuera de la jornada sin registrarlo como tiempo extraordinario. El sistema avisa al supervisor antes de rebasar los límites legales.`,
    `4. Desconexión. Al terminar su jornada, EL TRABAJADOR no está obligado a responder llamadas, mensajes o correos de trabajo, salvo emergencias o tiempo extraordinario autorizado y registrado.${mod === 'home_office' ? ' Esta política forma parte de las obligaciones de la NOM-037-STPS-2023 sobre teletrabajo.' : ''}`,
    `5. Inconformidades. Si EL TRABAJADOR considera que su resumen semanal no refleja lo que trabajó, debe indicarlo al responder el resumen. Ninguna inconformidad dará lugar a represalias.`,
  ].join('\n\n');

  return [
    { clave: 'convenio_registro', titulo: 'Convenio de registro electrónico de jornada', version: VERSION_DOCUMENTOS, texto: convenio },
    { clave: 'aviso_privacidad', titulo: 'Aviso de privacidad', version: VERSION_DOCUMENTOS, texto: aviso },
    { clave: 'politica_jornada', titulo: 'Política de jornada y desconexión', version: VERSION_DOCUMENTOS, texto: politica },
  ];
}
