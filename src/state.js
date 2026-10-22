import Database from 'better-sqlite3';

export function createState(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    instance TEXT NOT NULL, message_id TEXT NOT NULL, contact TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, last_error TEXT,
    PRIMARY KEY (instance, message_id)
  );
  CREATE INDEX IF NOT EXISTS events_due ON events(status, next_attempt_at);
  CREATE TABLE IF NOT EXISTS cooldowns (
    instance TEXT NOT NULL, contact TEXT NOT NULL, sent_at INTEGER NOT NULL,
    PRIMARY KEY (instance, contact)
  );`);
  if (!db.pragma('table_info(events)').some(column => column.name === 'selection_id')) db.exec('ALTER TABLE events ADD COLUMN selection_id TEXT');
  // An in-flight send at a crash is ambiguous: it must be reconciled manually.
  db.prepare("UPDATE events SET status = 'ambiguous', last_error = 'interrupted_send' WHERE status = 'processing'").run();
  const insert = db.prepare("INSERT OR IGNORE INTO events (instance,message_id,contact,status,next_attempt_at,created_at,updated_at,selection_id) VALUES (?,?,?,'pending',?,?,?,?)");
  const due = db.prepare("SELECT * FROM events WHERE status IN ('pending','failed') AND next_attempt_at <= ? ORDER BY created_at LIMIT 1");
  const cooldown = db.prepare('SELECT sent_at FROM cooldowns WHERE instance = ? AND contact = ?');
  const processing = db.prepare("UPDATE events SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE instance = ? AND message_id = ?");
  const skipped = db.prepare("UPDATE events SET status = 'skipped', updated_at = ? WHERE instance = ? AND message_id = ?");
  const sent = db.prepare("UPDATE events SET status = 'sent', updated_at = ?, last_error = NULL WHERE instance = ? AND message_id = ?");
  const markCooldown = db.prepare('INSERT INTO cooldowns (instance,contact,sent_at) VALUES (?,?,?) ON CONFLICT(instance,contact) DO UPDATE SET sent_at = excluded.sent_at');
  const failure = db.prepare('UPDATE events SET status = ?, next_attempt_at = ?, updated_at = ?, last_error = ? WHERE instance = ? AND message_id = ?');
  const claim = db.transaction((now, resolveCooldownMs) => {
    const event = due.get(now);
    if (!event) return null;
    const windowMs = resolveCooldownMs(event.instance);
    const previous = cooldown.get(event.instance, event.contact);
    if (!event.selection_id && previous && previous.sent_at + windowMs > now) {
      skipped.run(now, event.instance, event.message_id);
      return { ...event, skipped: true };
    }
    processing.run(now, event.instance, event.message_id);
    return { ...event, attempts: event.attempts + 1 };
  });
  return {
    enqueue(event) { const now = Date.now(); return insert.run(event.instance, event.messageId, event.contact, now, now, now, event.selectionId ?? null).changes === 1; },
    discard(event, now) { skipped.run(now, event.instance, event.message_id); },
    claim,
    clearCooldown(instance, contact) { return db.prepare('DELETE FROM cooldowns WHERE instance = ? AND contact = ?').run(instance, contact).changes; },
    sent(event, now) { db.transaction(() => { sent.run(now, event.instance, event.message_id); if (!event.selection_id) markCooldown.run(event.instance, event.contact, now); })(); },
    failed(event, error, now) { const exhausted = event.attempts >= 3; const backoff = Math.min(60_000, 2 ** event.attempts * 1000); failure.run(exhausted ? 'dead' : 'failed', now + backoff, now, error, event.instance, event.message_id); },
    ambiguous(event, now) { failure.run('ambiguous', now, now, 'delivery_uncertain', event.instance, event.message_id); },
    cleanup(cutoff) { db.prepare("DELETE FROM events WHERE created_at < ? AND status IN ('sent','skipped','dead')").run(cutoff); db.prepare('DELETE FROM cooldowns WHERE sent_at < ?').run(cutoff); },
    healthy() { return db.prepare('SELECT 1 AS ok').get().ok === 1; },
    close() { db.close(); },
    inspect(instance, messageId) { return db.prepare('SELECT * FROM events WHERE instance = ? AND message_id = ?').get(instance, messageId); }
  };
}
