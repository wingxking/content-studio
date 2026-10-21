import { calendarDate } from "../contracts/delivery-calendar.ts";

export function publishingCalendarSelection(monthValue: string | null, dayValue: string | null, now = new Date()) {
  const today = calendarDate(now.toISOString(), "Asia/Singapore");
  const month = monthValue && /^\d{4}-(0[1-9]|1[0-2])$/u.test(monthValue) ? monthValue : today.slice(0, 7);
  const first = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(first);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const days = end.getUTCDate();
  const day = dayValue && /^\d{4}-\d{2}-\d{2}$/u.test(dayValue) && dayValue.startsWith(`${month}-`) && Number(dayValue.slice(8)) >= 1 && Number(dayValue.slice(8)) <= days
    ? dayValue
    : today.startsWith(`${month}-`) ? today : `${month}-01`;
  return { month, day, days, leading: first.getUTCDay() };
}
