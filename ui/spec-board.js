// Tasks already carry the immutable spec reference from dispatchPlan.
export function specBoard(tasks, projectId, selection) {
  const projectTasks = tasks.filter((task) => task.projectId === projectId);
  const bySpec = new Map();
  const byCycle = new Map();
  for (const task of projectTasks) {
    const spec = task.sources?.spec;
    if (!spec?.file || !spec.digest) continue;
    const key = JSON.stringify([spec.file, spec.digest]);
    const group = bySpec.get(key) ?? { key, kind: "version", file: spec.file, digest: spec.digest, tasks: [] };
    group.tasks.push(task);
    // Tasks are appended when registered; move this version to the newest position.
    bySpec.delete(key);
    bySpec.set(key, group);
    const cycleKey = JSON.stringify(["cycle", spec.file]);
    const cycle = byCycle.get(cycleKey) ?? { key: cycleKey, kind: "cycle", file: spec.file, tasks: [] };
    cycle.tasks.push(task);
    cycle.digest = spec.digest;
    byCycle.delete(cycleKey);
    byCycle.set(cycleKey, cycle);
  }
  const specs = [...bySpec.values()].reverse();
  const cycles = [...byCycle.values()].reverse();
  for (const cycle of cycles) cycle.versions = specs.filter(spec => spec.file === cycle.file);
  const current = cycles[0];
  const explicit = byCycle.get(selection) ?? bySpec.get(selection);
  const selected = selection === "all" ? undefined : explicit ?? current;
  const selectionKey = selection === "all" ? "all" : explicit?.key ?? "current";
  return { specs, cycles, current, selected, selectionKey, tasks: selected?.tasks ?? projectTasks };
}

export function specChoices(board) {
  return [
    ["current", board.current ? `本轮全部票（含追加）· ${board.current.tasks.length} 张` : "本轮规格 · 未登记"],
    ...board.cycles.map(cycle => [cycle.key, `周期 · ${cycle.file} · ${cycle.tasks.length} 张`]),
    ...board.specs.map(spec => [spec.key, `单个版本 · ${spec.file} · ${spec.digest.slice(0, 8)}`]),
    ["all", "全部项目任务（含未关联规格）"],
  ];
}

export function isHistoricalTicket(task) {
  return task.state === "superseded" || task.state === "abandoned" || Boolean(task.releasedScope || task.scopeReleased);
}

export function ticketColumns(tasks) {
  const current = tasks.filter(task => !isHistoricalTicket(task));
  const history = tasks.filter(isHistoricalTicket);
  const inStates = (...states) => current.filter(task => states.includes(task.state));
  return [
    { title: "进行中", tasks: inStates("queued", "assigned", "rework", "paused", "blocked") },
    { title: "审查与处理", tasks: inStates("waiting_review", "waiting_verification", "waiting_batch", "reviewing", "changes_requested") },
    { title: "交付与验收", tasks: [...inStates("ready", "trial", "accepted"),
      ...history.filter(task => task.state !== "abandoned"), ...history.filter(task => task.state === "abandoned")],
      historyCount: history.length },
  ];
}
