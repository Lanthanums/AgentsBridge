import { EventEmitter } from "node:events";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  writeFileSync,
  renameSync,
  truncateSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { JournalIndex } from "./journal-index.mjs";
export const terminal = (s) => ["done", "stopped"].includes(s);
export class Journal extends EventEmitter {
  constructor(home, { write = writeSync, sync = fsyncSync } = {}) {
    super();
    this.home = home;
    this.write = write;
    this.sync = sync;
    mkdirSync(home, { recursive: true });
    this.file = join(home, "events.jsonl");
    closeSync(openSync(this.file, "a"));
    try {
      this.index = new JournalIndex(home, this.file);
    } catch (error) {
      if (
        !/not a database|database disk image is malformed|SQLITE_CORRUPT/i.test(
          error.message,
        )
      )
        throw error;
      const suffix = ".corrupt-" + randomUUID();
      for (const name of [
        "events-index.sqlite",
        "events-index.sqlite-wal",
        "events-index.sqlite-shm",
      ]) {
        const path = join(home, name);
        if (existsSync(path)) renameSync(path, path + suffix);
      }
      this.index = new JournalIndex(home, this.file);
      this.indexRecovered = true;
    }
    this.lastSeq = this.index.lastSeq;
    this.offset = statSync(this.file).size;
    this.fd = openSync(this.file, "a");
  }
  find(id) {
    return this.index.find(id);
  }
  scan(options = {}) {
    return this.index.scan(options);
  }
  history({ collab_id, before, limit = 100 } = {}) {
    const types = ["message.sent"];
    const events = this.index
      .events({ collab_id, before, types, limit, descending: true })
      .reverse();
    const oldest = events[0]?.seq;
    return {
      events,
      before: before || null,
      oldest,
      newest: events.at(-1)?.seq,
      has_older: Boolean(
        oldest &&
        this.index.events({ collab_id, types, before: oldest, limit: 1 })
          .length,
      ),
    };
  }

  append(
    type,
    collab,
    data = {},
    {
      id = randomUUID(),
      epoch = collab?.epoch,
      task_id = null,
      agent = null,
    } = {},
  ) {
    const existing = this.find(id);
    if (existing) return existing;
    if (this.writeError)
      throw new Error(`JOURNAL_UNAVAILABLE: ${this.writeError.message}`);
    const e = {
      schema_version: 2,
      seq: this.lastSeq + 1,
      id,
      time: new Date().toISOString(),
      type,
      project_id: collab?.project_id || null,
      collab_id: collab?.id || null,
      epoch,
      task_id,
      agent,
      data,
    };
    const bytes = Buffer.from(JSON.stringify(e) + "\n");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = this.write(
          this.fd,
          bytes,
          offset,
          bytes.length - offset,
        );
        if (
          !Number.isSafeInteger(written) ||
          written <= 0 ||
          written > bytes.length - offset
        )
          throw new Error("JOURNAL_SHORT_WRITE");
        offset += written;
      }
      this.sync(this.fd);
      this.index.db.exec("BEGIN");
      try {
        this.index.record(e, this.offset, bytes);
        this.index.db.exec("COMMIT");
      } catch (error) {
        this.index.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      // Do not append through a potentially torn tail until restart has recovered it.
      this.writeError = error;
      throw error;
    }
    this.lastSeq = e.seq;
    this.offset += bytes.length;
    this.emit("event", e);
    return e;
  }
  events(after = 0, collab_id, limit = 1000) {
    return this.index.events({ after, collab_id, limit });
  }

  blob(value, suffix = "txt") {
    const body =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const hash = createHash("sha256").update(body).digest("hex");
    const dir = join(this.home, "blobs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${hash}.${suffix}`);
    if (!existsSync(path)) writeFileSync(path, body);
    return { path, sha256: hash, bytes: Buffer.byteLength(body) };
  }
  writeJson(path, value) {
    const temp = path + ".tmp";
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, path);
  }
  close() {
    closeSync(this.fd);
    this.index.close();
  }
}
