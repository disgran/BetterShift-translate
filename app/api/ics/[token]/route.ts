import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calendars, shifts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { validateAccessToken, updateTokenUsage } from "@/lib/auth/token-auth";

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function toIcalDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const validation = await validateAccessToken(token);

    if (!validation) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const calendar = await db.query.calendars.findFirst({
      where: eq(calendars.id, validation.calendarId),
    });

    if (!calendar) {
      return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
    }

    const calendarShifts = await db.query.shifts.findMany({
      where: eq(shifts.calendarId, validation.calendarId),
      orderBy: (shifts, { asc }) => [asc(shifts.date)],
    });

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//BetterShift//Calendar Feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${escapeIcs(calendar.name)}`,
    ];

    for (const shift of calendarShifts) {
      const start = new Date(shift.date);
      const eventStart = new Date(start);
      const eventEnd = new Date(start);

      if (shift.isAllDay) {
        eventStart.setHours(0, 0, 0, 0);
        eventEnd.setHours(23, 59, 59, 999);
      } else {
        const [startHour, startMinute] = shift.startTime.split(":").map(Number);
        const [endHour, endMinute] = shift.endTime.split(":").map(Number);

        eventStart.setHours(startHour, startMinute, 0, 0);
        eventEnd.setHours(endHour, endMinute, 0, 0);

        if (eventEnd <= eventStart) {
          eventEnd.setDate(eventEnd.getDate() + 1);
        }
      }

      lines.push(
        "BEGIN:VEVENT",
        `UID:${shift.id}`,
        `DTSTAMP:${toIcalDate(new Date())}`,
        `DTSTART:${toIcalDate(eventStart)}`,
        `DTEND:${toIcalDate(eventEnd)}`,
        `SUMMARY:${escapeIcs(shift.title)}`,
        shift.notes ? `DESCRIPTION:${escapeIcs(shift.notes)}` : "",
        shift.color ? `COLOR:${shift.color}` : "",
        "END:VEVENT"
      );
    }

    lines.push("END:VCALENDAR");

    void updateTokenUsage(validation.id);

    const ics = `${lines.join("\r\n")}\r\n`;

    return new NextResponse(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${calendar.name}.ics"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    console.error("[ics token route]", error);
    return NextResponse.json(
      { error: "Failed to export calendar" },
      { status: 500 }
    );
  }
}
