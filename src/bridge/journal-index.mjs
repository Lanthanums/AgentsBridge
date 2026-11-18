import { DatabaseSync } from "node:sqlite";
import {
  openSync,
  closeSync,
  readSync,
  statSync,
  truncateSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export class JournalIndex {
  constructor(home, file) {
    this.file = file;
    this.db = new DatabaseSync(join(home, "events-index.sqlite"));
    try {
      this.initialize();
      this.reconcile();
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      throw error;
    }
  }
  initialize() {
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, collab_id TEXT, task_id TEXT, start_offset INTEGER, end_offset INTEGER, hash TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_collab ON events(collab_id,seq);
      CREATE INDEX IF NOT EXISTS events_type ON events(type,seq);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,seq);
      CREATE TABLE IF NOT EXISTS collaborations(id TEXT PRIMARY KEY, created_seq INTEGER, updated_seq INTEGER, state TEXT, closed INTEGER DEFAULT 0, summary TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, collab_id TEXT, state TEXT);
      CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);`);
    this.insert = this.db.prepare(
      "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",
    );
    this.putCollab = this.db.prepare(
      "INSERT INTO collaborations(id,created_seq,updated_seq,state,summary) VALUES(?,?,?,?,?)",
    );
    this.touch = this.db.prepare(
      "UPDATE collaborations SET updated_seq=? WHERE id=?",
    );
    this.state = this.db.prepare(
      "UPDATE collaborations SET state=? WHERE id=?",
    );
    this.putTask = this.db.prepare("INSERT INTO tasks VALUES(?,?,?)");
    this.taskState = this.db.prepare("UPDATE tasks SET state=? WHERE id=?");
  }

  record(e, start, bytes) {
    const payload = bytes.toString("utf8").trimEnd();
    this.insert.run(
      e.seq,
      e.id,
      e.type,
      e.collab_id,
      e.task_id,
      start,
      start + bytes.length,
      digest(bytes),
      payload,
    );
    if (e.type === "collaboration.started") {
      const { title, goal, cwd, reviewer } = e.data;
      this.putCollab.run(
        e.collab_id,
        e.seq,
        e.seq,
        "active",
        JSON.stringify({
          id: e.collab_id,
          title,
          goal,
          cwd,
          reviewer,
          project_id: e.project_id,
          epoch: e.epoch,
          created_at: e.time,
        }),
      );
    }
    if (e.collab_id) this.touch.run(e.seq, e.collab_id);
    const state =
      e.type === "collaboration.stopped"
        ? "stopped"
        : e.type === "review.requested"
          ? "awaiting_review"
          : ["collaboration.state", "review.invalidated"].includes(e.type)
            ? e.data.state
            : null;
    if (state) this.state.run(state, e.collab_id);
    if (e.type === "ui.closed")
      this.db
        .prepare("UPDATE collaborations SET closed=1 WHERE id=?")
        .run(e.collab_id);
    if (e.type === "task.queued")
      this.putTask.run(e.task_id, e.collab_id, "queued");
    else if (e.type.startsWith("task."))
      this.taskState.run(e.type.slice(5), e.task_id);
  }
  reconcile() {
    let last = this.db
      .prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1")
      .get();
    const fd = openSync(this.file, "r");
    try {
      if (last) {
        const bytes = Buffer.alloc(last.end_offset - last.start_offset);
        const n = readSync(fd, bytes, 0, bytes.length, last.start_offset);
        if (
          statSync(this.file).size < last.end_offset ||
          n !== bytes.length ||
          digest(bytes) !== last.hash
        ) {
          this.db.exec(
            "DELETE FROM events; DELETE FROM collaborations; DELETE FROM tasks;",
          );
          last = null;
        }
      }
      let offset = last?.end_offset || 0,
        position = offset,
        seq = last?.seq || 0,
        pending = Buffer.alloc(0),
        count = 0;
      const chunk = Buffer.alloc(65536);
      this.db.exec("BEGIN");
      try {
        const consume = (bytes, terminated) => {
          if (!bytes.length) {
            offset += Number(terminated);
            return;
          }
          let e;
          try {
            e = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            if (terminated)
              throw new Error(
                `Corrupt journal after byte ${offset}: ${error.message}`,
              );
            truncateSync(this.file, offset);
            return;
          }
          if (e?.seq !== seq + 1)
            throw new Error(`Corrupt journal at byte ${offset}: sequence gap`);
          if (!terminated) appendFileSync(this.file, "\n");
          const full = Buffer.concat([bytes, Buffer.from("\n")]);
          this.record(e, offset, full);
          offset += full.length;
          seq = e.seq;
          if (++count % 500 === 0) this.db.exec("COMMIT; BEGIN");
        };
        for (;;) {
          const n = readSync(fd, chunk, 0, chunk.length, position);
          if (!n) break;
          position += n;
          pending = Buffer.concat([pending, chunk.subarray(0, n)]);
          let nl;
          while ((nl = pending.indexOf(10)) >= 0) {
            consume(pending.subarray(0, nl), true);
            pending = pending.subarray(nl + 1);
          }
          if (pending.length > 32 * 1024 * 1024)
            throw new Error(
              "JOURNAL_RECORD_TOO_LARGE: inspect source log; it was not truncated",
            );
        }
        if (pending.length) consume(pending, false);
        this.db.exec("COMMIT");
        this.lastSeq = seq;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  }
  find(id) {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.payload) : undefined;
  }
  events({
    after = 0,
    before,
    collab_id,
    task_id,
    types,
    limit = 1000,
    descending = false,
  } = {}) {
    const clauses = ["seq>?"];
    const values = [after];
    if (before != null) {
      clauses.push("seq<?");
      values.push(before);
    }
    if (collab_id) {
      clauses.push("collab_id=?");
      values.push(collab_id);
    }
    if (task_id) {
      clauses.push("task_id=?");
      values.push(task_id);
    }
    if (types?.length) {
      clauses.push(`type IN (${types.map(() => "?").join(",")})`);
      values.push(...types);
    }
    const size = Math.max(
      1,
      Math.min(5000, Number.isSafeInteger(limit) ? limit : 1000),
    );
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(...values, size);
    return rows.map((r) => JSON.parse(r.payload));
  }
  *scan(options = {}) {
    let after = 0;
    for (;;) {
      const page = this.events({ ...options, after, limit: 256 });
      if (!page.length) return;
      yield* page;
      after = page.at(-1).seq;
    }
  }
  collaborations({ offset = 0, limit = 25 } = {}) {
    offset = Math.max(0, Number.isSafeInteger(offset) ? offset : 0);
    limit = Math.max(
      1,
      Math.min(100, Number.isSafeInteger(limit) ? limit : 25),
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM collaborations ORDER BY created_seq DESC LIMIT ? OFFSET ?",
      )
      .all(limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...JSON.parse(r.summary),
        state: r.state,
        created_seq: r.created_seq,
        updated_seq: r.updated_seq,
      })),
      offset,
      has_more: rows.length > limit,
    };
  }
  pendingCollaborations() {
    return this.db
      .prepare(
        "SELECT DISTINCT collab_id FROM tasks WHERE state IN ('queued','running','retrying')",
      )
      .all()
      .map((r) => r.collab_id);
  }
  interruptedReviews() {
    return this.db
      .prepare(
        "SELECT id FROM collaborations WHERE state='awaiting_review' AND json_extract(summary,'$.reviewer') != 'user'",
      )
      .all()
      .map((r) => r.id);
  }
  commandHistory({ task_id, before, limit = 100 }) {
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE seq IN (
      SELECT MAX(seq) FROM events WHERE task_id=? AND type IN ('command.started','command.updated','command.completed') GROUP BY json_extract(payload,'$.data.id')
      ) AND seq<? ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        task_id,
        before || Number.MAX_SAFE_INTEGER,
        Math.max(1, Math.min(100, limit)),
      );
    const events = rows.map((r) => JSON.parse(r.payload)).reverse();
    const oldest = events[0]?.seq;
    const more = oldest
      ? this.db
          .prepare(
            `SELECT 1 FROM events WHERE seq IN (
      SELECT MAX(seq) FROM events WHERE task_id=? AND type IN ('command.started','command.updated','command.completed') GROUP BY json_extract(payload,'$.data.id')
      ) AND seq<? LIMIT 1`,
          )
          .get(task_id, oldest)
      : null;
    return { events, before: before || null, oldest, has_older: Boolean(more) };
  }
  liveCollaborations() {
    return this.db
      .prepare(
        "SELECT id FROM collaborations WHERE state NOT IN ('done','stopped')",
      )
      .all()
      .map((r) => r.id);
  }
  taskCollaboration(id) {
    return this.db.prepare("SELECT collab_id FROM tasks WHERE id=?").get(id)
      ?.collab_id;
  }
  uiClosed(id) {
    return Boolean(
      this.db.prepare("SELECT closed FROM collaborations WHERE id=?").get(id)
        ?.closed,
    );
  }
  close() {
    this.db.close();
  }
}
