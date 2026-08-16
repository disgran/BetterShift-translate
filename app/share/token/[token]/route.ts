import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calendars, shifts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import ICAL from "ical.js";
import { validateAccessToken, updateTokenUsage } from "@/lib/auth/token-auth";
import { getServerTimezone, formatDateToLocal } from "@/lib/date-utils";

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildCalendarIcs(calendarName: string, calendarShifts: typeof shifts.$inferSelect[]) {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//BetterShift//Calendar Feed//EN");
  cal.updatePropertyWithValue("version", "2.0");
  cal.updatePropertyWithValue("calscale", "GREGORIAN");
  cal.updatePropertyWithValue("method", "PUBLISH");
  cal.updatePropertyWithValue("x-wr-calname", calendarName);
  cal.updatePropertyWithValue("x-wr-timezone", getServerTimezone());

  for (const shift of calendarShifts) {
    const vevent = new ICAL.Component("vevent");
    const event = new ICAL.Event(vevent);

    event.uid = shift.id;
    event.summary = shift.title;

    if (shift.notes) {
      event.description = escapeIcsText(shift.notes);
    }

    const shiftDate = shift.date as Date;

    if (shift.isAllDay) {
      const dateStr = formatDateToLocal(shiftDate);
      const startTime = ICAL.Time.fromDateString(dateStr);
      event.startDate = startTime;

      const endDate = new Date(shiftDate);
      endDate.setDate(endDate.getDate() + 1);
      const endYear = endDate.getFullYear();
      const endMonth = String(endDate.getMonth() + 1).padStart(2, "0");
      const endDay = String(endDate.getDate()).padStart(2, "0");
      event.endDate = ICAL.Time.fromDateString(`${endYear}-${endMonth}-${endDay}`);
    } else {
      const [startHour, startMinute] = shift.startTime.split(":").map(Number);
      const [endHour, endMinute] = shift.endTime.split(":").map(Number);

      const startDateTime = new Date(shiftDate);
      startDateTime.setHours(startHour, startMinute, 0, 0);

      const endDateTime = new Date(shiftDate);
      endDateTime.setHours(endHour, endMinute, 0, 0);

      if (endDateTime <= startDateTime) {
        endDateTime.setDate(endDateTime.getDate() + 1);
      }

      event.startDate = ICAL.Time.fromJSDate(startDateTime, true);
      event.endDate = ICAL.Time.fromJSDate(endDateTime, true);
    }

    vevent.addPropertyWithValue("color", shift.color);
    vevent.addPropertyWithValue("x-apple-calendar-color", shift.color);
    cal.addSubcomponent(vevent);
  }

  return cal.toString();
}

export async function GET(
  request: NextRequest,
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

    void updateTokenUsage(validation.id);

    const filename = `${calendar.name.replace(/[^a-z0-9]/gi, "_").toLowerCase().substring(0, 30)}.ics`;
    const icsContent = buildCalendarIcs(calendar.name, calendarShifts);

    return new NextResponse(icsContent, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    console.error("[share-token] ICS export error:", error);
    return NextResponse.json(
      { error: "Failed to export calendar" },
      { status: 500 }
    );
  }
}
