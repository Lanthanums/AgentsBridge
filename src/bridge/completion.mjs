export const taskInFlight = (task) =>
  ["queued", "running", "retrying"].includes(task.state);

export function completionStatus(collaboration) {
  const tasks = Object.values(collaboration?.tasks || {});
  const superseded = new Set(tasks.map((task) => task.retry_of));
  const agents = {};
  const failed = [];
  let pending = 0;
  let hasRequest = false;
  for (const task of tasks) {
    if (task.message_type === "review" || superseded.has(task.id)) continue;
    if (task.message_type !== "result") hasRequest = true;
    const status = (agents[task.to] ??= { pending: 0, failed: 0 });
    if (taskInFlight(task)) {
      status.pending++;
      pending++;
    } else if (task.state !== "completed" && task.message_type !== "result") {
      status.failed++;
      failed.push(task);
    }
  }
  return {
    agents,
    failed,
    pending,
    ready: hasRequest && !pending && !failed.length,
  };
}

export function latestArtifacts(artifacts) {
  const latest = new Map();
  for (const artifact of artifacts) {
    const key = /^[A-Z]:|^\\\\/i.test(artifact.path)
      ? artifact.path.toLowerCase()
      : artifact.path;
    latest.delete(key);
    latest.set(key, artifact);
  }
  return [...latest.values()];
}
