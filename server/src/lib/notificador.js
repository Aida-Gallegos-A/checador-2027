// Envío de mensajes al trabajador (WhatsApp Business / Twilio).
// MVP: solo deja constancia en consola. La constancia legal del envío vive en la bitácora.

export async function enviarWhatsApp(telefono, mensaje) {
  // TODO: integrar API de WhatsApp Business o Twilio.
  console.log(`[whatsapp → ${telefono ?? 'sin teléfono'}] ${mensaje}`);
  return { canal: 'consola', enviado: true };
}
