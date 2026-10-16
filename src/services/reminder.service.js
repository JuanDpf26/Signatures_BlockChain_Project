/**
 * RECORDATORIOS POR CORREO
 *
 * Cada hora (mientras el servidor está activo) busca revisiones y firmas que
 * llevan 48 horas o más sin respuesta y le escribe a quien debe responder.
 * Máximo 3 recordatorios por solicitud, separados al menos 48 horas.
 * Quien envió la solicitud también puede pedir un recordatorio manual
 * (una vez cada 24 horas).
 *
 * Se apaga con REMINDERS_ENABLED=false. Cada persona puede desactivarlos en
 * Configuración (users.email_reminders).
 */
const pool = require('../config/db');
const { sendReminderEmail } = require('./email.service');
const { logAudit } = require('./audit.service');

const EVERY_MS = 60 * 60 * 1000;
const WAIT_HOURS = 48;
const MAX_AUTO = 3;

const daysSince = (d) => Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 86400000));

/** Envía el recordatorio de una solicitud de la bandeja y lo deja anotado */
const remindShare = async (row, { manual = false } = {}) => {
  await sendReminderEmail({
    to: row.recipient_email,
    name: row.recipient_name,
    sender: { name: row.sender_name, email: row.sender_email },
    title: row.title,
    kind: row.kind,
    days: daysSince(row.created_at),
    message: row.message,
  });
  await pool.query(
    `UPDATE document_shares SET reminder_count = COALESCE(reminder_count, 0) + 1, last_reminded_at = NOW() WHERE id = $1`,
    [row.id]
  );
  logAudit({
    userId: manual ? row.sender_id : row.recipient_id,
    actorEmail: manual ? row.sender_email : null,
    action: 'reminder.sent',
    description: `${manual ? 'Recordatorio manual' : 'Recordatorio automático'} de ${row.kind === 'sign' ? 'firma' : 'revisión'} a ${row.recipient_email}`,
    resource: row.document_id,
    result: 'permitido',
    detail: { share: row.id, kind: row.kind, manual },
  });
};

const SHARE_SQL = `
  SELECT s.id, s.kind, s.message, s.created_at, s.document_id, s.sender_id, s.recipient_id, s.recipient_email,
         s.reminder_count, s.last_reminded_at, s.status,
         d.title, u.name AS sender_name, u.email AS sender_email, r.name AS recipient_name,
         COALESCE(r.email_reminders, TRUE) AS wants
    FROM document_shares s
    JOIN documents d ON d.id::text = s.document_id
    LEFT JOIN users u ON u.id::text = s.sender_id
    LEFT JOIN users r ON r.id::text = s.recipient_id`;

/** Una pasada: solicitudes de la bandeja + turnos del dueño en firmas de varias personas */
const runReminders = async () => {
  let sent = 0;
  try {
    const due = await pool.query(
      `${SHARE_SQL}
        WHERE s.kind IN ('review', 'sign') AND s.status IN ('sent', 'read')
          AND NOT COALESCE(s.archived_by_recipient, FALSE)
          AND NOT COALESCE(s.deleted_by_recipient, FALSE)
          AND COALESCE(s.reminder_count, 0) < $1
          AND COALESCE(s.last_reminded_at, s.created_at) < NOW() - ($2 || ' hours')::interval
          AND COALESCE(r.email_reminders, TRUE)
        ORDER BY s.created_at ASC
        LIMIT 40`,
      [MAX_AUTO, String(WAIT_HOURS)]
    );
    for (const row of due.rows) {
      try {
        await remindShare(row);
        sent++;
      } catch (e) {
        console.warn(`[recordatorios] No se pudo recordar ${row.id}:`, e.message);
      }
    }

    // Firma de varias personas en la que le toca al dueño (no tiene mensaje en la bandeja)
    const own = await pool.query(
      `SELECT d.id, d.title, d.user_id, d.metadata, u.name, u.email, COALESCE(u.email_reminders, TRUE) AS wants
         FROM documents d JOIN users u ON u.id = d.user_id
        WHERE d.metadata->'cosign'->>'status' = 'collecting'`
    );
    for (const d of own.rows) {
      const cosign = d.metadata.cosign;
      const cur = (cosign.signers || []).find((s) => s.status === 'pending');
      if (!cur || String(cur.user_id) !== String(d.user_id) || !d.wants) continue;
      const last = cur.last_reminded_at || cur.notified_at || cosign.created_at;
      if ((cur.reminder_count || 0) >= MAX_AUTO || Date.now() - new Date(last).getTime() < WAIT_HOURS * 3600000) continue;
      try {
        await sendReminderEmail({ to: d.email, name: d.name, sender: { name: 'DocBlockSign' }, title: d.title, kind: 'sign', days: daysSince(cur.notified_at || cosign.created_at) });
        cur.reminder_count = (cur.reminder_count || 0) + 1;
        cur.last_reminded_at = new Date().toISOString();
        await pool.query(
          `UPDATE documents SET metadata = jsonb_set(metadata, '{cosign}', $1::jsonb) WHERE id = $2`,
          [JSON.stringify(cosign), d.id]
        );
        sent++;
      } catch (e) {
        console.warn(`[recordatorios] Documento ${d.id}:`, e.message);
      }
    }
    if (sent) console.log(`🔔 [Recordatorios] ${sent} enviados`);
  } catch (err) {
    console.error('❌ [Recordatorios]', err.message);
  }
  return sent;
};

let timer = null;
const startReminders = () => {
  if (String(process.env.REMINDERS_ENABLED || '').toLowerCase() === 'false') {
    console.log('🔕 [Recordatorios] Desactivados (REMINDERS_ENABLED=false)');
    return;
  }
  if (timer) return;
  setTimeout(runReminders, 2 * 60 * 1000); // primera pasada 2 min después de arrancar
  timer = setInterval(runReminders, EVERY_MS);
  console.log('🔔 [Recordatorios] Activos: revisiones y firmas pendientes cada 48 h (máx. 3)');
};

module.exports = { runReminders, startReminders, remindShare, SHARE_SQL, WAIT_HOURS, MAX_AUTO };
