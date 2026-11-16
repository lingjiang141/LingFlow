// Tasks already carry the immutable spec reference from dispatchPlan.
export function specBoard(tasks, projectId, selection) {
  const projectTasks = tasks.filter((task) => task.projectId === projectId);
  const bySpec = new Map();
  for (const task of projectTasks) {
    const spec = task.sources?.spec;
    if (!spec?.file || !spec.digest) continue;
    const key = JSON.stringify([spec.file, spec.digest]);
    const group = bySpec.get(key) ?? { key, file: spec.file, digest: spec.digest, tasks: [] };
    group.tasks.push(task);
    // Tasks are appended when registered; move this version to the newest position.
    bySpec.delete(key);
    bySpec.set(key, group);
  }
  const specs = [...bySpec.values()].reverse();
  const current = specs[0];
  const selected = selection === "all" ? undefined : bySpec.get(selection) ?? current;
  return { specs, current, selected, tasks: selected?.tasks ?? projectTasks };
}
