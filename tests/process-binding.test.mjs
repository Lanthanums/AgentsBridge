import test from "node:test";
import assert from "node:assert/strict";
import { processAncestors } from "../native/process-tree.mjs";
test("process binding traces wrapper ancestors and retains a missing dead host as a stop tombstone", async () => {
  const snapshot = async () => [
    {
      ProcessId: 100,
      ParentProcessId: 200,
      CreatedUtc: "2026-11-06T03:29:45.0000020Z",
    },
    {
      ProcessId: 200,
      ParentProcessId: 300,
      CreatedUtc: "2026-11-06T03:29:45.0000010Z",
    },
  ];
  assert.deepEqual(await processAncestors(100, { snapshot }), {
    chain: [100, 200, 300],
    reusedParent: null,
  });
  await assert.rejects(
    processAncestors(999, { snapshot }),
    /PARENT_PROCESS_NOT_ALIVE/,
  );
});
test("a recycled parent PID breaks a false cycle without becoming a trusted ancestor", async () => {
  const snapshot = async () => [
    {
      ProcessId: 100,
      ParentProcessId: 200,
      CreatedUtc: "2026-11-06T03:29:45.0000030Z",
    },
    {
      ProcessId: 200,
      ParentProcessId: 300,
      CreatedUtc: "2026-11-06T03:29:45.0000010Z",
    },
    {
      ProcessId: 300,
      ParentProcessId: 200,
      CreatedUtc: "2026-11-06T03:29:45.0000020Z",
    },
  ];
  assert.deepEqual(await processAncestors(100, { snapshot }), {
    chain: [100, 200],
    reusedParent: 300,
  });
});
test("invalid parent identities and ancestry cycles are rejected before granting a scope", async () => {
  await assert.rejects(processAncestors("100"), /INVALID_PARENT_PID/);
  await assert.rejects(
    processAncestors(1, {
      snapshot: async () => [
        {
          ProcessId: 1,
          ParentProcessId: 2,
          CreatedUtc: "2026-11-06T03:29:45.0000010Z",
        },
        {
          ProcessId: 2,
          ParentProcessId: 1,
          CreatedUtc: "2026-11-06T03:29:45.0000010Z",
        },
      ],
    }),
    /ANCESTRY_CYCLE/,
  );
});
