export function recommendDevelopers(developers, tasks, ticketKeys, explicit = {}, available) {
  const requested = key => explicit && Object.hasOwn(explicit, key) ? explicit[key] : undefined;
  const enabled = developers.filter(role => role.enabled);
  const pool = enabled.length ? enabled : developers;
  const candidates = pool.map(role => ({
    id: role.id, available: available(role),
    load: tasks.filter(task => task.developerId === role.id && task.state === "queued").length,
  }));
  for (const key of ticketKeys) {
    const selected = candidates.find(candidate => candidate.id === requested(key));
    if (selected) selected.load++;
  }
  return ticketKeys.map(key => {
    const override = requested(key);
    if (override != null) return override;
    const [selected] = [...candidates].sort((a, b) => Number(b.available) - Number(a.available) || a.load - b.load);
    selected.load++;
    return selected.id;
  });
}

export function planningResourceWarnings(tasks, predecessors, documents) {
  const byKey = new Map([...predecessors, ...tasks].map(task => [task.ticketKey, task]));
  const byId = new Map([...byKey.values()].map(task => [task.id, task]));
  const ports = new Map();
  for (const document of Object.values(documents)) {
    const ownTicket = /^#\s+(?:票\s+)?([A-Z][\w]*-\d+)/m.exec(document.text)?.[1];
    for (const line of document.text.split(/\r?\n/)) {
      if (!/共享|共用|共占|争用|互斥|串行|同一|shared|exclusive/i.test(line)) continue;
      const keys = new Set(ownTicket ? [ownTicket] : []);
      for (const group of line.matchAll(/\b([A-Z][\w]*-)(\d+(?:\s*\/\s*\d+)*)/g))
        for (const number of group[2].split(/\s*\/\s*/)) keys.add(group[1] + number);
      for (const match of line.matchAll(/(?:端口|port)\s*[:：=]?\s*`?(\d{1,5})\b|\b(\d{1,5})`?\s*(?:端口|port)/gi)) {
        const port = match[1] ?? match[2];
        if (+port < 1 || +port > 65535) continue;
        const group = ports.get(port) ?? new Set();
        for (const key of keys) if (byKey.has(key)) group.add(key);
        ports.set(port, group);
      }
    }
  }
  const warnings = [];
  for (const task of tasks) {
    const portHints = [...ports].filter(([, keys]) => keys.size > 1 && keys.has(task.ticketKey));
    const missing = portHints.filter(([port]) => !task.resources.some(resource => new RegExp(`(?:^|\\D)${port}(?:$|\\D)`).test(resource)));
    if (missing.length) warnings.push({
      code: "shared-resource-missing", path: `tickets[${task.ticketKey}].resources`,
      message: "规划文字提到共用端口，派发资源中未找到对应声明；请核对并为共用方填写同一个资源名",
      suggestedResources: missing.map(([port]) => "port:" + port),
    });
    for (const dependency of task.dependencies) {
      const peer = byId.get(dependency);
      if (!peer) continue;
      const shared = [...new Set([...task.resources.filter(resource => peer.resources?.includes(resource)),
        ...portHints.filter(([, keys]) => keys.has(peer.ticketKey)).map(([port]) => "port:" + port)])];
      if (shared.length) warnings.push({
        code: "dependency-shared-resource", path: `tickets[${task.ticketKey}].after`, predecessor: peer.ticketKey ?? peer.id,
        sharedResources: shared, message: "该前置同时涉及共享资源。若只需互斥，请用 resources；若确实依赖前置的产出或用户指定顺序，保留 after",
      });
    }
  }
  return warnings;
}
