type AdminAuditHrefInput = {
  entityType: string;
  entityId: string;
  sourcePage?: string;
};

type AuditMetaInput = {
  sourcePage?: string;
  section?: string;
  operation?: string;
  resultSummary?: string;
};

function trimOrEmpty(value?: string): string {
  return (value || "").trim();
}

export function buildAdminAuditHref(input: AdminAuditHrefInput): string {
  const params = new URLSearchParams();
  params.set("entityType", trimOrEmpty(input.entityType));
  params.set("entityId", trimOrEmpty(input.entityId));
  const sourcePage = trimOrEmpty(input.sourcePage);
  if (sourcePage) params.set("sourcePage", sourcePage);
  return `/admin/audit?${params.toString()}`;
}

export function appendAuditMetaParams(path: string, meta: AuditMetaInput): string {
  const params = new URLSearchParams();
  const sourcePage = trimOrEmpty(meta.sourcePage);
  const section = trimOrEmpty(meta.section);
  const operation = trimOrEmpty(meta.operation);
  const resultSummary = trimOrEmpty(meta.resultSummary);
  if (sourcePage) params.set("sourcePage", sourcePage);
  if (section) params.set("section", section);
  if (operation) params.set("operation", operation);
  if (resultSummary) params.set("resultSummary", resultSummary);
  const query = params.toString();
  if (!query) return path;
  return `${path}?${query}`;
}
