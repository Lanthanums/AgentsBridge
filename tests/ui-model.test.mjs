import test from "node:test";
import assert from "node:assert/strict";
import { placeMessageChips } from "../src/ui/chip-layout.mjs";
import { avatarStateFor, projectAvatarEvent } from "../src/ui/avatar-state.mjs";
import {
  emptyModel,
  project,
  positions,
  agentLabel,
} from "../src/ui/model.mjs";
import {
  clampBounds,
  dockBounds,
  dockMetrics,
  shouldDock,
  inDockZone,
  roundedWindowShape,
  rightEdgeGap,
} from "../src/desktop/window.mjs";

test("budget and independent notification warnings survive replay and clear only the recovered notification", () => {
  const events = [
    ["collaboration.started", { goal: "retain work" }],
    ["result.notification_failed", { reply_to: "one", error: "quota" }],
    ["result.notification_failed", { reply_to: "two", error: "network" }],
    ["budget.exhausted", { reason: "usage_budget" }],
    ["result.notification_delivered", { reply_to: "two" }],
    ["budget.updated", { budget: { max_tokens: 500000 }, exhausted: null }],
  ].map(([type, data], index) => ({
    type,
    data,
    seq: index + 1,
    id: String(index),
    collab_id: "c",
    epoch: 1,
  }));
  const partial = project(emptyModel(), events.slice(0, 4));
  const result = project(partial, events.slice(4));
  assert.deepEqual(result, project(emptyModel(), events));
  assert.equal(partial.collaborations.c.notification_error, "network");
  assert.equal(partial.collaborations.c.budget_exhausted.reason, "usage_budget");
  assert.equal(result.collaborations.c.notification_error, "quota");
  assert.equal(result.collaborations.c.budget_exhausted, null);
  assert.equal(result.collaborations.c.budget.max_tokens, 500000);
  assert.equal(result.collaborations.c.epoch, 1);
  assert.equal(result.collaborations.c.state, "active");
});

test("avatar cues use first-event boundaries and leave task and collaboration semantics in the model", () => {
  const run = projectAvatarEvent(undefined, {
    type: "task.running",
    id: "wake",
    task_id: "new",
  });
  const participant = { agent: "kimi", state: "working" };
  const collaboration = { state: "active", avatarFacts: { kimi: run } };
  assert.equal(
    avatarStateFor(participant, collaboration, null, 0, 60),
    "quiet",
  );
  assert.equal(
    projectAvatarEvent(run, { type: "metric.first_event", task_id: "old" }),
    run,
  );
  collaboration.avatarFacts.kimi = projectAvatarEvent(run, {
    type: "metric.first_event",
    task_id: "new",
  });
  assert.equal(
    avatarStateFor(participant, collaboration, null, 0, 60),
    "working",
  );
  assert.equal(
    avatarStateFor(
      { ...participant, state: "tool" },
      collaboration,
      null,
      0,
      60,
    ),
    "tool",
  );
  const cancelled = projectAvatarEvent(run, {
    type: "task.cancelled",
    task_id: "new",
    id: "cancel",
  });
  assert.deepEqual(cancelled.effect, { key: "cancel", type: "cancelled" });
  assert.equal(cancelled.awaitingFirst, false);
});

test("avatars distinguish long thinking, inferred stall and the designated review gate", () => {
  const participant = { agent: "dsh", state: "thinking" };
  const collaboration = { state: "active" };
  assert.equal(
    avatarStateFor(participant, collaboration, null, 59, 60),
    "thinking",
  );
  assert.equal(
    avatarStateFor(participant, collaboration, null, 60, 60),
    "long",
  );
  assert.equal(
    avatarStateFor(
      { ...participant, state: "suspected_stall" },
      collaboration,
      null,
      60,
      60,
    ),
    "stall",
  );
  assert.equal(
    avatarStateFor(
      participant,
      { state: "awaiting_review", reviewer: "user" },
      null,
      0,
      60,
    ),
    "confirm",
  );
  assert.equal(
    avatarStateFor(
      participant,
      { state: "awaiting_review", reviewer: "kimi" },
      null,
      0,
      60,
    ),
    "waiting",
  );
  assert.equal(
    avatarStateFor(
      participant,
      { state: "awaiting_review", reviewer: "dsh" },
      null,
      0,
      60,
    ),
    "thinking",
  );
  assert.equal(
    avatarStateFor(participant, { state: "stopped" }, null, 0, 60),
    "stopped",
  );
});

test("compact bubbles stay clear of agent labels and nearby bubbles in a narrow six-node canvas", () => {
  const stage = { width: 380, height: 282 };
  const centers = positions(6).map((p) => ({
    x: (p.x * stage.width) / 100,
    y: (p.y * stage.height) / 100 - 20,
  }));
  const edges = [
    [0, 3],
    [3, 0],
    [1, 4],
    [4, 1],
    [2, 5],
    [5, 2],
  ].map(([from, to]) => ({
    labelX: centers[from].x + (from < to ? -17 : 17),
    labelY: (centers[from].y + centers[to].y) / 2,
  }));
  const chips = placeMessageChips(edges, centers, stage);
  assert.equal(chips.length, edges.length);
  for (const [i, chip] of chips.entries()) {
    assert.ok(chip.x >= 14 && chip.x <= stage.width - 14);
    assert.ok(chip.y >= 12 && chip.y <= stage.height - 12);
    for (const center of centers) {
      assert.ok(
        Math.abs(chip.x - center.x) >= 80 ||
          chip.y + 12 <= center.y + 30 ||
          chip.y - 12 >= center.y + 67,
      );
    }
    for (const other of chips.slice(0, i)) {
      assert.ok(
        Math.abs(chip.x - other.x) >= 28 || Math.abs(chip.y - other.y) >= 24,
      );
    }
  }
});
test("incremental replay has the same projection as the full log and reconnect deduplicates sequence", () => {
  const records = [
    {
      seq: 1,
      id: "1",
      type: "collaboration.started",
      collab_id: "c",
      epoch: 1,
      data: { title: "test" },
    },
    {
      seq: 2,
      id: "2",
      type: "participant.joined",
      collab_id: "c",
      data: { agent: "kimi" },
    },
    {
      seq: 3,
      id: "3",
      type: "agent.state",
      collab_id: "c",
      agent: "kimi",
      data: { state: "thinking", silent_since: "2026-11-04T00:00:00Z" },
    },
  ];
  const split = project(
    project(emptyModel(), records.slice(0, 2)),
    records.slice(1),
  );
  assert.deepEqual(split, project(emptyModel(), records));
  assert.equal(
    agentLabel(
      split.collaborations.c.participants.kimi,
      Date.parse("2026-11-04T00:00:26Z"),
    ),
    "思考中 · 已静默 26 秒",
  );
});
test("2/3/4 participant positions follow row, triangle and inset grid", () => {
  assert.equal(positions(2)[0].y, positions(2)[1].y);
  assert.ok(positions(3)[0].y < positions(3)[1].y);
  const grid = positions(4);
  assert.equal(grid.length, 4);
  assert.equal(new Set(grid.map((p) => `${p.x},${p.y}`)).size, 4);
  assert.deepEqual([...new Set(grid.map((p) => p.x))], [28, 72]);
  assert.deepEqual([...new Set(grid.map((p) => p.y))], [28, 72]);
});
test("default note and floater are compact and anchored to the top-right work area", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const note = clampBounds({}, [primary], primary);
  assert.deepEqual(note, { x: 1380, y: 20, width: 520, height: 500 });
  const floater = clampBounds({}, [primary], primary, true);
  assert.deepEqual(floater, { x: 1580, y: 20, width: 320, height: 64 });
});
test("monitor removal returns an offscreen window to primary; negative monitor positions stay legal", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  const fallback = clampBounds(
    { x: 3500, y: 1800, width: 960, height: 700 },
    [primary],
    primary,
  );
  assert.ok(fallback.x >= 0 && fallback.x + fallback.width <= 1920);
  assert.ok(fallback.y + fallback.height <= 1080);
  const negative = { x: -1920, y: 0, width: 1920, height: 1080 };
  const kept = clampBounds(
    { x: -1500, y: 10, width: 960, height: 700 },
    [primary, negative],
    primary,
  );
  assert.equal(kept.x, -1500);
  const small = { x: -800, y: 0, width: 800, height: 600 };
  const fitted = clampBounds(
    { x: -700, y: 20, width: 1100, height: 900 },
    [small, primary],
    primary,
  );
  assert.ok(fitted.x >= small.x && fitted.x + fitted.width <= 0);
  assert.ok(fitted.y >= 0 && fitted.y + fitted.height <= small.height);
});
test("edge snapping requires a committed drag, and dock previews remain fully reachable", () => {
  const area = { x: -1707, y: 40, width: 1707, height: 1019 };
  const near = { x: -330, y: 160, width: 320, height: 64 };
  assert.equal(shouldDock(near, area, false), false);
  assert.equal(shouldDock(near, area, true), true);
  assert.equal(shouldDock({ ...near, x: -360 }, area, true), false);
  assert.deepEqual(dockBounds(near, area), {
    x: -23,
    y: 160,
    width: 45,
    height: 45,
  });
  assert.deepEqual(dockBounds(near, area, true), {
    x: -224,
    y: 160,
    width: 224,
    height: 45,
  });
  assert.equal(dockBounds({ ...near, y: 5000 }, area).y, 1014);
  assert.equal(dockBounds({ ...near, y: -400 }, area).y, 40);
});

test("compact native shape excludes corner pixels and keeps full center rows", () => {
  for (const [w, h, r] of [
    [320, 64, 16],
    [45, 45, 23],
    [224, 45, 23],
  ]) {
    const rows = roundedWindowShape(w, h, r);
    assert.equal(rows.length, h);
    assert.ok(rows[0].x > 0);
    assert.equal(rows[Math.floor(h / 2)].width, w);
    assert.deepEqual(
      rows.map((row) => row.width),
      rows.map((row) => row.width).reverse(),
    );
    for (const row of rows)
      assert.ok(row.width > 0 && row.x >= 0 && row.x + row.width <= w);
  }
});

test("detached ball uses cursor proximity to the monitor edge, independent of pill width", () => {
  const area = { x: -1700, y: 40, width: 1700, height: 1000 };
  assert.equal(inDockZone({ x: -48, y: 100 }, area), true);
  assert.equal(inDockZone({ x: -49, y: 100 }, area), false);
  assert.equal(inDockZone({ x: -1, y: 20 }, area), false);
  assert.equal(inDockZone({ x: 1, y: 100 }, area), false);
});
