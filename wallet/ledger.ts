import type { Config, Billing } from "../launcher/config";
import type { Store } from "../tracking/store";
export function monthAt(now: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
  }).format(new Date(now));
}
export function available(
  s: Store,
  c: Config,
  source: "aws" | "other",
  now: number,
  b?: Billing,
) {
  const month = monthAt(now);
  const spent = (
    s.db
      .query(
        "SELECT COALESCE(SUM(cents),0) AS cents FROM debits WHERE source=? AND month=?",
      )
      .get(source, month) as { cents: number }
  ).cents;
  if (source === "other")
    return Math.max(0, Math.floor(c.wallet.other.default_usd * 100) - spent);
  if (s.get("aws-stop-latched") === true) return 0;
  if (
    !b ||
    b.month !== month ||
    now - b.observedAt > 86400000 ||
    b.observedAt > now ||
    b.projectedCents >= c.wallet.aws.hold_at_projected * 100 ||
    b.postedCents >= c.wallet.aws.stop_at_actual * 100
  )
    return 0;
  return Math.max(
    0,
    Math.floor(
      (c.wallet.aws.ceiling_usd_month - c.wallet.aws.reserve_usd) * 100,
    ) -
      b.postedCents -
      b.unpostedCents -
      b.fixedCents -
      spent,
  );
}
// Called only inside the admission transaction. Reservations are conservative, irreversible debits.
// No agent-facing funding, refund or cap-writing operation exists.
export function debit(
  s: Store,
  id: string,
  source: string,
  cents: number,
  now: number,
) {
  s.db
    .query("INSERT INTO debits VALUES(?,?,?,?,?,?,?)")
    .run(id, id, source, monthAt(now), cents, now, `reserved:${id}`);
}

export function observeBilling(
  s: Store,
  c: Config,
  b: Billing | undefined,
  now: number,
) {
  if (
    !b ||
    b.observedAt > now ||
    now - b.observedAt > 86400000 ||
    b.month !== monthAt(now)
  )
    return;
  s.atomic(() => {
    s.event(
      `billing:${b.receipt}`,
      "billing-reading",
      b,
      "Append a correction with its own source receipt; never erase the original",
      now,
    );
    if (b.postedCents >= c.wallet.aws.stop_at_actual * 100) {
      s.set("aws-stop-latched", true);
      s.event(
        `aws-stop:${b.month}`,
        "wallet-stop",
        { receipt: b.receipt },
        "Only owner review may clear the stop latch; caps stay in read-only policy",
        now,
      );
    }
  });
}
