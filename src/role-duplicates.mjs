export function reconcileRoleDuplicates(state) {
  const ids=new Map(),identityDiagnostics=[];
  state.roles=state.roles.filter(role=>{
    const retained=ids.get(role.id);
    if(!retained){ids.set(role.id,role);return true;}
    const same=['projectId','kind','sessionId','provider','identityPrompt','name'].every(key=>role[key]===retained[key]);
    if(!same) {
      retained.enabled=false;
      (state.roleIdentityConflicts??=[]).push({id:role.id,at:Date.now(),record:structuredClone(role)});
    }
    identityDiagnostics.push({roleId:role.id,retained:retained.id,name:role.name,state:same?'id-deduplicated':'id-conflict',
      reason:same?'相同身份的重复 id 合并为一条，原责任引用不变':'同 id 身份冲突，保留冲突副本并暂停该身份；核对后再开启'});
    return false;
  });
  const referenced = role => state.tasks.some(task => [task.assignee, task.developerId, task.reviewerId, task.dispatchedBy].includes(role.id)) ||
    state.notices.some(notice => notice.roleId === role.id) || state.wakes.some(wake => wake.roleId === role.id) ||
    (state.messages ?? []).some(message => message.from === role.id || message.to === role.id) ||
    (state.checkJobs ?? []).some(job => job.requester === role.id) || state.projects.some(project => project.primaryControllerId === role.id);
  const groups = new Map();
  for (const role of state.roles.filter(role => !role.archivedAt)) {
    const key = JSON.stringify([role.projectId, role.name.trim().toLowerCase()]);
    groups.set(key, [...groups.get(key) ?? [], role]);
  }
  const notices = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a,b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || Number(referenced(b)) - Number(referenced(a)));
    const retained = group[0];
    for (const role of group.slice(1)) {
      const sameIdentity = role.kind === retained.kind && role.sessionId === retained.sessionId &&
        (role.provider ?? "dsh") === (retained.provider ?? "dsh") && (role.identityPrompt ?? "") === (retained.identityPrompt ?? "");
      if (sameIdentity && !referenced(role)) {
        role.archivedAt = Date.now(); role.mergedInto = retained.id; role.enabled = false;
        notices.push({ roleId: role.id, retained: retained.id, state: "merged", name: role.name });
      } else notices.push({ roleId: role.id, retained: retained.id, state: "needs-review", name: role.name,
        reason: "同名角色身份、权限或历史责任不同，保留记录；先核对再归档或改名" });
    }
  }
  state.roleDuplicateDiagnostics = [...identityDiagnostics,...notices];
}
