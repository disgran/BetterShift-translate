import { formatDateToLocal, getServerTimezone } from "@/lib/date-utils";

interface HaConfig {
  url: string;
  token: string;
  calendarId: string;
}

interface ShiftData {
  id: string;
  title: string;
  date: Date;
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  notes?: string | null;
}

function isEnabled(): boolean {
  return process.env.HA_SYNC_ENABLED === "true";
}

function getConfig(): HaConfig {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  const calendarId = process.env.HA_CALENDAR_ID;

  if (!url || !token || !calendarId) {
    throw new Error(
      "HA_URL, HA_TOKEN y HA_CALENDAR_ID son requeridos cuando HA_SYNC_ENABLED=true"
    );
  }

  return { url, token, calendarId };
}

/**
 * Construye los campos de fecha/hora para el evento HA.
 * - Turnos normales: "YYYY-MM-DDTHH:MM:00" (hora local del servidor)
 * - Turnos de día completo: "YYYY-MM-DD" (solo fecha)
 */
function buildDateFields(
  shift: ShiftData
): Record<string, string> {
  const dateStr = formatDateToLocal(shift.date);

  if (shift.isAllDay) {
    return {
      dtstart: dateStr,
      dtend: dateStr,
    };
  }

  const tz = getServerTimezone();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDateStr = formatter.format(shift.date);

  return {
    dtstart: `${localDateStr}T${shift.startTime}:00`,
    dtend: `${localDateStr}T${shift.endTime}:00`,
  };
}

async function haRequest(
  config: HaConfig,
  method: string,
  body: Record<string, unknown>
): Promise<void> {
  const url = `${config.url}/api/calendars/${config.calendarId}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HA API ${method} ${url} falló: ${res.status} ${res.statusText} - ${text}`
    );
  }
}

/**
 * Crea un evento en el calendario de Home Assistant.
 * Usa el id del shift como uid para poder actualizarlo o eliminarlo después.
 */
export async function createHaEvent(shift: ShiftData): Promise<void> {
  if (!isEnabled()) return;

  try {
    const config = getConfig();
    await haRequest(config, "POST", {
      uid: shift.id,
      summary: `[BetterShift] ${shift.title}`,
      description: shift.notes ?? "",
      ...buildDateFields(shift),
    });
    console.log(`[HA Sync] Evento creado: ${shift.id}`);
  } catch (err) {
    console.error("[HA Sync] Error al crear evento:", err);
  }
}

/**
 * Actualiza un evento existente en el calendario de Home Assistant.
 * Identifica el evento por el uid (= shift.id).
 */
export async function updateHaEvent(shift: ShiftData): Promise<void> {
  if (!isEnabled()) return;

  try {
    const config = getConfig();
    await haRequest(config, "PUT", {
      uid: shift.id,
      summary: `[BetterShift] ${shift.title}`,
      description: shift.notes ?? "",
      ...buildDateFields(shift),
    });
    console.log(`[HA Sync] Evento actualizado: ${shift.id}`);
  } catch (err) {
    console.error("[HA Sync] Error al actualizar evento:", err);
  }
}

/**
 * Elimina un evento del calendario de Home Assistant.
 * Identifica el evento por el uid (= shiftId).
 */
export async function deleteHaEvent(shiftId: string): Promise<void> {
  if (!isEnabled()) return;

  try {
    const config = getConfig();
    await haRequest(config, "DELETE", { uid: shiftId });
    console.log(`[HA Sync] Evento eliminado: ${shiftId}`);
  } catch (err) {
    console.error("[HA Sync] Error al eliminar evento:", err);
  }
}
