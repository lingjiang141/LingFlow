export const installedToolsVersion = "lingflow-team-v3";
const key = Symbol.for("lingflow.tools.installations");
export function installTools(agent, definitions, effect) {
  const tools = agent.ctx.tools, scopes = tools[key] ??= new Map();
  let installed = scopes.get(agent.id);
  if (!(installed instanceof Map)) scopes.set(agent.id, installed = new Map());
  for (const definition of [...definitions].sort((a, b) => a.name.localeCompare(b.name))) {
    const previous = installed.get(definition.name);
    const present = typeof tools.get === "function" ? Boolean(tools.get(definition.name, agent)) : Boolean(previous);
    if ((previous?.version ?? previous) === installedToolsVersion && present) continue;
    previous?.dispose?.();
    effect(() => {
      const disposable = tools.register(definition);
      const record = { version: installedToolsVersion };
      let disposed = false;
      record.dispose = () => {
        if (disposed) return;
        disposed = true;
        if (installed.get(definition.name) === record) installed.delete(definition.name);
        if (typeof disposable === "function") disposable(); else disposable?.dispose?.();
      };
      installed.set(definition.name, record);
      return record.dispose;
    });
  }
}

export function missingTools(agent, names = ["lingflow_connect", "lingflow_team"]) {
  const tools = agent?.ctx?.tools;
  return names.filter(name => {
    try { return typeof tools?.get === "function" ? !tools.get(name, agent) : !tools?.[key]?.get(agent.id)?.has(name); }
    catch { return true; }
  });
}
