import { useEffect, useRef, useState } from "react";
import type {
  ProxyCheckView,
  ProxyPreview,
  ProxyPreviewInput,
  ProxyProgressEvent,
  ProxyReplacementMode,
  ProxyReplacementView,
  ProxyScope,
} from "../proxy-tools-types.ts";

class ProxyToolsError extends Error {}

const PAGE_SIZE = 50;
const CHECK_LABELS: Record<ProxyCheckView["status"], string> = {
  working: "可用", failed: "不可用", unstable: "不稳定", unavailable: "未知",
  missing: "未设置代理", invalid: "代理无效", unsupported: "不支持",
};
const REPLACEMENT_LABELS: Record<ProxyReplacementView["status"], string> = {
  ready: "待应用", updated: "已更新", unchanged: "未更改", missing: "未匹配", skipped: "已跳过", failed: "失败",
};
const REASONS: Record<string, string> = {
  authentication_failed: "身份验证失败", timeout: "检查超时", dns_failed: "DNS 查询失败",
  unreachable: "无法连接", connection_failed: "连接失败", intermittent: "连接时断时续",
  proxy_bypassed: "连接绕过了代理", check_unavailable: "检查服务不可用",
  profile_open: "请先关闭此资料再更换代理", version_conflict: "资料已更改，请重新预览",
  profile_trashed: "资料在回收站中", invalid_row: "输入行无效", invalid_proxy: "代理无效",
  duplicate_selector: "输入选择条件重复", duplicate_target: "分配冲突",
  no_editable_match: "未匹配到可编辑的资料", ambiguous_username: "匹配到了多个资料",
  expected_version_required: "请重新预览此资料", unsupported: "无法检查此代理类型",
  cancelled: "未完成", folder_access_denied: "无权访问此分组",
};

export function proxyScope(all: boolean, groups: string[], ids?: string[]): ProxyScope {
  return { ...(all ? { all: true } : { groups: [...new Set(groups)] }), ...(ids ? { ids: [...new Set(ids)] } : {}) };
}

export function proxyResultPage<T>(rows: T[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  return { items: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, pages, total: rows.length };
}

function checkNeedsRetry(row: ProxyCheckView): boolean {
  return row.status === "failed" || row.status === "unstable" || row.status === "unavailable";
}

export function failedProxyProfileIds(rows: ProxyCheckView[]): string[] {
  return [...new Set(rows.filter(checkNeedsRetry).flatMap((row) => row.profiles.map((profile) => profile.id)))];
}

export function mergeProxyCheckResult(rows: ProxyCheckView[], next: ProxyCheckView): ProxyCheckView[] {
  const updatedIds = new Set(next.profiles.map((profile) => profile.id));
  const remaining = rows.flatMap((row) => {
    const profiles = row.profiles.filter((profile) => !updatedIds.has(profile.id));
    return profiles.length ? [{ ...row, profiles }] : [];
  });
  return [...remaining, next];
}

export function retryProxyProfileIds(rows: ProxyReplacementView[]): string[] {
  return [...new Set(rows.filter((row) => row.status === "failed" || row.status === "skipped")
    .flatMap((row) => row.profileId ? [row.profileId] : []))];
}

function proxyRequest(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`/ui/api/proxies/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

async function previewResponse(response: Response): Promise<ProxyPreview> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ProxyToolsError("你无权执行此代理操作。");
    if (response.status === 404 || response.status === 501 || response.status === 503) throw new ProxyToolsError("此服务不支持批量代理工具。");
    throw new ProxyToolsError("无法预览代理更换，请检查输入格式和所选分组。");
  }
  let body: ProxyPreview;
  try { body = await response.json(); } catch { throw new ProxyToolsError("代理预览返回了无效数据。"); }
  if (body?.ok !== true || typeof body.previewId !== "string" || !Array.isArray(body.rows) || !Number.isInteger(body.unusedProxies)) {
    throw new ProxyToolsError("代理预览返回了无效数据。");
  }
  return body;
}

export async function requestProxyPreview(input: ProxyPreviewInput, signal?: AbortSignal): Promise<ProxyPreview> {
  return previewResponse(await proxyRequest("preview", input, signal));
}

export async function readProxyProgress(
  response: Response, onEvent: (event: ProxyProgressEvent) => void, signal?: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw new ProxyToolsError("无法启动代理操作，请检查网络连接和服务版本。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const accept = (line: string) => {
    if (!line.trim()) return;
    let event: ProxyProgressEvent;
    try { event = JSON.parse(line); } catch { throw new ProxyToolsError("代理操作返回的数据不完整。"); }
    if (!event || typeof event !== "object" || done) throw new ProxyToolsError("代理操作返回了无效数据。");
    switch (event.type) {
      case "progress":
        if (!["loading", "checking", "applying"].includes(event.phase) || !Number.isFinite(event.completed) || !Number.isFinite(event.total)) throw new ProxyToolsError("代理操作进度无效。");
        break;
      case "summary":
        if (![event.selectedProfiles, event.uniqueProxies, event.duplicatesSkipped].every(Number.isFinite)) throw new ProxyToolsError("代理操作摘要无效。");
        break;
      case "check":
        if (!event.row || !Object.hasOwn(CHECK_LABELS, event.row.status) || !Array.isArray(event.row.profiles)) throw new ProxyToolsError("代理检查结果无效。");
        break;
      case "replacement":
        if (!event.row || !Number.isInteger(event.row.index) || !["ready", "updated", "unchanged", "missing", "skipped", "failed"].includes(event.row.status)) throw new ProxyToolsError("代理更换结果无效。");
        break;
      case "done": done = true; break;
      case "error": throw new ProxyToolsError("代理操作失败，已完成的结果仍会保留。");
      default: throw new ProxyToolsError("代理操作返回了无效数据。");
    }
    onEvent(event);
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        accept(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) accept(pending);
    if (!done) throw new ProxyToolsError("代理操作已中断，部分项目尚未完成。");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  return <div className="proxy-pager">
    <span>共 {total.toLocaleString()} 项</span>
    <button type="button" className="btn" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
    <span>第 {page + 1} / {pages} 页</span>
    <button type="button" className="btn" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>下一页</button>
  </div>;
}

function AffectedProfiles({ profiles }: { profiles: ProxyCheckView["profiles"] }) {
  const [page, setPage] = useState(0);
  const result = proxyResultPage(profiles, page);
  const folders = [...new Set(profiles.map((profile) => profile.group || "未分组"))];
  return <details className="proxy-affected">
    <summary>{profiles.length.toLocaleString()} 个资料 · {folders.length} 个分组</summary>
    <div>{folders.join(", ")}</div>
    <ul>{result.items.map((profile) => <li key={profile.id}>{profile.name || profile.id} · {profile.group || "未分组"}</li>)}</ul>
    {result.pages > 1 && <Pager {...result} onPage={setPage} />}
  </details>;
}

export function ProxiesPage({ groups, onChanged, active }: {
  groups: string[];
  onChanged: () => Promise<void>;
  active: boolean;
}) {
  const [all, setAll] = useState(true);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [task, setTask] = useState<"check" | "replace">("check");
  const [mode, setMode] = useState<ProxyReplacementMode>("list");
  const [input, setInput] = useState("");
  const [perProxy, setPerProxy] = useState(1);
  const [preview, setPreview] = useState<ProxyPreview | null>(null);
  const [checks, setChecks] = useState<ProxyCheckView[]>([]);
  const [checkSummary, setCheckSummary] = useState<Extract<ProxyProgressEvent, { type: "summary" }> | null>(null);
  const [progress, setProgress] = useState<Extract<ProxyProgressEvent, { type: "progress" }> | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "check" | "file" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacementPage, setReplacementPage] = useState(0);
  const [checkPage, setCheckPage] = useState(0);
  const [replacementFailures, setReplacementFailures] = useState(false);
  const [checkFailures, setCheckFailures] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const scope = proxyScope(all, selectedGroups);
  const scopeReady = all || selectedGroups.length > 0;
  const folderNames = [...new Set(groups)];
  const retries = retryProxyProfileIds(preview?.rows ?? []);
  const failedChecks = failedProxyProfileIds(checks);
  const replacements = proxyResultPage((preview?.rows ?? []).filter((row) => !replacementFailures || ["failed", "skipped", "missing"].includes(row.status)), replacementPage);
  const checkResults = proxyResultPage(checks.filter((row) => !checkFailures || row.status !== "working"), checkPage);
  const ready = preview?.rows.filter((row) => row.status === "ready").length ?? 0;

  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const invalidatePreview = () => {
    setPreview(null); setReplacementPage(0); setError(null); setNotice(null);
  };
  const invalidateScope = () => {
    invalidatePreview(); setChecks([]); setCheckSummary(null); setCheckPage(0); setProgress(null);
  };
  const start = (operation: NonNullable<typeof busy>) => {
    if (controller.current) return null;
    const current = new AbortController();
    controller.current = current;
    setBusy(operation); setError(null); setNotice(null); setProgress(null);
    return current;
  };
  const finish = (current: AbortController) => {
    if (controller.current !== current) return;
    controller.current = null; setBusy(null);
  };
  const failed = (current: AbortController, operation: string, failure: unknown) => {
    if (controller.current !== current) return;
    // Raw fetch errors can include URLs. Only fixed client messages reach the page.
    if (current.signal.aborted) setNotice("操作已取消。已完成的结果仍会保存，部分项目可能尚未完成。");
    else if (failure instanceof ProxyToolsError) setError(failure.message);
    else setError(`${operation}失败，请检查输入、分组权限和网络连接后重试。`);
  };

  const makePreview = async (retry = false) => {
    const current = start("preview");
    if (!current) return;
    try {
      const next = retry && preview
        ? await previewResponse(await proxyRequest("retry-preview", { previewId: preview.previewId, ids: retries }, current.signal))
        : await requestProxyPreview({ scope, mode, input, ...(mode === "list" ? { profilesPerProxy: perProxy } : {}) }, current.signal);
      if (controller.current !== current || current.signal.aborted) return;
      setPreview(next); setReplacementPage(0); setReplacementFailures(false);
      setNotice("请先检查分配结果再应用，已打开的资料会被跳过。");
    } catch (failure) { failed(current, "预览", failure); }
    finally { finish(current); }
  };

  const apply = async () => {
    if (!preview || !ready) return;
    const current = start("apply");
    if (!current) return;
    setChecks([]); setCheckSummary(null); setCheckPage(0);
    try {
      await readProxyProgress(await proxyRequest("apply", { previewId: preview.previewId }, current.signal), (event) => {
        if (controller.current !== current) return;
        if (event.type === "progress") setProgress(event);
        if (event.type === "replacement") setPreview((previous) => previous && ({
          ...previous, rows: previous.rows.map((row) => row.index === event.row.index ? event.row : row),
        }));
      }, current.signal);
      if (controller.current === current) setNotice("代理更换已完成，请检查被跳过或失败的资料。");
    } catch (failure) { failed(current, "代理更换", failure); }
    finally {
      if (controller.current === current) {
        try { await onChanged(); } catch { setError("结果已保存，但无法刷新资料列表。"); }
      }
      finish(current);
    }
  };

  const runChecks = async (retry = false) => {
    const current = start("check");
    if (!current) return;
    if (!retry) setChecks([]);
    setCheckSummary(null); setCheckPage(0);
    try {
      await readProxyProgress(await proxyRequest("check", {
        scope: proxyScope(all, selectedGroups, retry ? failedChecks : undefined),
      }, current.signal), (event) => {
        if (controller.current !== current) return;
        if (event.type === "progress") setProgress(event);
        if (event.type === "summary") setCheckSummary(event);
        if (event.type === "check") setChecks((rows) => retry ? mergeProxyCheckResult(rows, event.row) : [...rows, event.row]);
      }, current.signal);
      if (controller.current === current) setNotice("代理检查已完成。“未知”表示无法确认检查结果。");
    } catch (failure) { failed(current, "代理检查", failure); }
    finally { finish(current); }
  };

  const loadFile = async (file: File) => {
    const current = start("file");
    if (!current) return;
    invalidatePreview();
    try {
      const text = await file.text();
      if (controller.current === current && !current.signal.aborted) setInput(text);
    } catch { if (controller.current === current) setError("无法读取所选文件。"); }
    finally { finish(current); }
  };

  return <div className="workspace proxy-page" hidden={!active}>
    <div className="tools-intro"><div><span className="tools-eyebrow">代理工具</span><h2>保持资料网络畅通</h2><p>检查已保存的连接，或批量更换整个分组的代理。</p></div></div>
    <div className="tools-tabs" aria-label="代理工具">
      <button className={task === "check" ? "selected" : ""} aria-pressed={task === "check"} onClick={() => setTask("check")}>检查代理 <small>查找连接问题</small></button>
      <button className={task === "replace" ? "selected" : ""} aria-pressed={task === "replace"} onClick={() => setTask("replace")}>更换代理 <small>分配新的连接</small></button>
    </div>
    <section className="tools-panel proxy-scope">
      <div className="tools-panel-head"><div><h3>{task === "replace" && <span className="tools-step">1</span>}选择分组</h3><p>包含这些分组中所有页面的全部资料。</p></div><span className="tools-folder-tag">{all ? "全部分组" : `已选择 ${selectedGroups.length} 个`}</span></div>
      <div className="proxy-folder-list">
        <label className={`folder-chip${all ? " selected" : ""}`}><input type="checkbox" checked={all} disabled={!!busy} onChange={(event) => { setAll(event.target.checked); setSelectedGroups([]); invalidateScope(); }} />全部分组</label>
        {folderNames.map((name) => <label className={`folder-chip${!all && selectedGroups.includes(name) ? " selected" : ""}`} key={name}>
          <input type="checkbox" checked={all || selectedGroups.includes(name)} disabled={!!busy} onChange={(event) => {
            setSelectedGroups(all ? folderNames.filter((group) => group !== name) : event.target.checked ? [...selectedGroups, name] : selectedGroups.filter((group) => group !== name));
            setAll(false); invalidateScope();
          }} />{name || "未分组"}
        </label>)}
      </div>
      {!scopeReady && <p className="tools-hint">请至少选择一个分组。</p>}
    </section>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    {busy && <div className="tools-progress" role="status">
      <div className="proxy-actions"><strong>{progress ? `${progress.phase === "loading" ? "正在加载资料" : progress.phase === "checking" ? "正在检查代理" : "正在应用更改"}：${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}` : "正在准备…"}</strong>
        <button type="button" className="btn" onClick={() => controller.current?.abort()}>取消</button></div>
      <progress aria-label="代理操作进度" {...(progress && progress.total > 0 ? { value: progress.completed, max: progress.total } : {})} />
    </div>}
    {task === "check" ? <>
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3>检查连接</h3><p>共用的代理只检查一次，不会打开浏览器或更改设置。</p></div>
          <button type="button" className="btn primary" disabled={!!busy || !scopeReady} onClick={() => void runChecks()}>{busy === "check" ? "正在检查…" : "检查代理"}</button></div>
        {checkSummary && <div className="tools-stats">
          <div><strong>{checkSummary.selectedProfiles.toLocaleString()}</strong><span>包含的资料</span></div>
          <div><strong>{checkSummary.uniqueProxies.toLocaleString()}</strong><span>不同的代理</span></div>
          <div><strong>{checkSummary.duplicatesSkipped.toLocaleString()}</strong><span>已避免重复检查</span></div>
          <div><strong>{checks.filter((row) => row.status === "working").length.toLocaleString()}</strong><span>可用</span></div>
        </div>}
        {checks.length > 0 ? <>
          <div className="tools-result-bar"><h3>检查结果</h3><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={checkFailures} onChange={(event) => { setCheckFailures(event.target.checked); setCheckPage(0); }} />只看问题</label>
            <button type="button" className="btn" disabled={!!busy || !failedChecks.length} onClick={() => void runChecks(true)}>重试失败项目</button>
          </div></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>代理地址</th><th>连接状态</th><th>出口 IP</th><th>使用资料</th><th>检查时间</th></tr></thead>
            <tbody>{checkResults.items.map((row) => <tr key={`${row.key}-${row.profiles[0]?.id}`}>
              <td className="tools-mono">{row.proxy || "未分配代理"}</td><td><span className={`tools-status ${row.status}`}>{CHECK_LABELS[row.status]}</span><small>{row.reason ? REASONS[row.reason] || "无法完成检查" : ""}</small></td>
              <td className="tools-mono">{row.ip || "—"}{row.country && <small>{row.country}</small>}</td><td><AffectedProfiles profiles={row.profiles} /></td>
              <td>{new Date(row.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
            </tr>)}</tbody></table></div>
          {!checkResults.total && <p className="tools-hint tools-result-empty">已完成的检查中没有发现问题。</p>}
          <Pager {...checkResults} onPage={setCheckPage} />
        </> : <div className="tools-empty"><span className="tools-empty-symbol" aria-hidden="true">↗</span><h3>{busy === "check" ? "正在检查所选分组…" : "随时可以开始"}</h3><p>请在上方选择分组，然后检查哪些代理可用、不可用或需要处理。</p></div>}
      </section>
      <p className="tools-footnote">支持 HTTP 和 SOCKS5，暂不支持检查 HTTPS 代理。“未知”表示无法确认结果。</p>
    </> : <>
      <section className="tools-panel proxy-input-panel">
        <div className="tools-panel-head"><div><h3><span className="tools-step">2</span>添加替换代理</h3><p>检查并应用分配结果前，不会更改任何内容。</p></div></div>
        <div className="tools-panel-body">
          <label className="fld"><span>分配方式</span><select value={mode} disabled={!!busy} onChange={(event) => { setMode(event.target.value as ProxyReplacementMode); invalidatePreview(); }}>
            <option value="list">粘贴代理列表</option><option value="profileId">按资料 ID 匹配（CSV）</option><option value="oldProxy">替换匹配的旧代理（CSV）</option>
          </select></label>
          <p className="tools-hint">{mode === "profileId" ? <>请包含表头：<code>profileId,type,host,port,user,pass</code>。</>
            : mode === "oldProxy" ? <>请包含表头：<code>oldProxy,newProxy</code>。所选分组中出现的每个旧代理都会被替换。</>
            : "每行粘贴一个代理。代理会按资料 ID 顺序匹配，并按下方设置的数量分配给资料。下一步会显示每项分配。"}</p>
          {mode === "list" && <label className="fld"><span>每个代理分配的资料数</span><input type="number" aria-label="每个代理分配的资料数" min={1} step={1} value={perProxy} disabled={!!busy} onChange={(event) => { setPerProxy(Math.max(1, Math.floor(Number(event.target.value)) || 1)); invalidatePreview(); }} /></label>}
          <label className="fld"><span>{mode === "list" ? "新代理列表" : "代理替换 CSV"}</span><textarea aria-label="代理替换输入" rows={5} value={input} disabled={!!busy} spellCheck={false} autoComplete="off" placeholder={mode === "list" ? "proxy.example.com:8080:username:password\nsocks5://username:password@proxy.example.com:1080" : mode === "profileId" ? "profileId,type,host,port,user,pass" : "oldProxy,newProxy"} onChange={(event) => { setInput(event.target.value); invalidatePreview(); }} /></label>
          <div className="tools-result-bar"><label className="proxy-upload">或上传文件<input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void loadFile(file); }} /></label>
            <button type="button" className="btn primary" disabled={!!busy || !scopeReady || !input.trim()} onClick={() => void makePreview()}>{busy === "preview" ? "正在生成预览…" : "预览更改"}</button></div>
        </div>
      </section>
      <section className="tools-panel">
        <div className="tools-panel-head"><div><h3><span className="tools-step">3</span>检查更改</h3><p>检查每个资料的新旧代理，已打开的资料会被跳过。</p></div>
          {preview && <button type="button" className="btn primary" disabled={!!busy || !ready} onClick={() => void apply()}>{busy === "apply" ? "正在应用…" : `应用 ${ready.toLocaleString()} 项更改`}</button>}</div>
        {preview ? <>
          <div className="tools-stats">
            <div><strong>{ready.toLocaleString()}</strong><span>待应用</span></div>
            <div><strong>{preview.rows.filter((row) => row.status === "updated").length.toLocaleString()}</strong><span>已更新</span></div>
            <div><strong>{preview.rows.filter((row) => ["skipped", "failed", "missing"].includes(row.status)).length.toLocaleString()}</strong><span>需要处理</span></div>
            <div><strong>{preview.rows.filter((row) => row.status === "unchanged").length.toLocaleString()}</strong><span>未更改</span></div>
          </div>
          <div className="tools-result-bar"><span className="tools-hint">{preview.rows.length.toLocaleString()} 项分配 · {preview.unusedProxies.toLocaleString()} 个代理未使用</span><div className="proxy-actions">
            <label className="proxy-choice"><input type="checkbox" checked={replacementFailures} onChange={(event) => { setReplacementFailures(event.target.checked); setReplacementPage(0); }} />只看问题</label>
            <button type="button" className="btn" disabled={!!busy || !retries.length} onClick={() => void makePreview(true)}>重新预览失败项目</button>
          </div></div>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table"><thead><tr><th>资料</th><th>分组</th><th>当前代理</th><th>新代理</th><th>状态</th></tr></thead>
            <tbody>{replacements.items.map((row) => <tr key={row.index}>
              <td><strong>{row.name || row.profileId || `输入第 ${row.index + 1} 行`}</strong><small className="tools-mono">{row.name ? row.profileId : ""}</small></td>
              <td>{row.group === undefined ? "—" : row.group || "未分组"}</td><td className="tools-mono">{row.previousProxy || "—"}</td><td className="tools-mono">{row.proxy || "—"}</td>
              <td><span className={`tools-status ${row.status}`}>{REPLACEMENT_LABELS[row.status]}</span><small>{row.code ? REASONS[row.code] || "无法应用此项目" : ""}</small></td>
            </tr>)}</tbody></table></div>
          <Pager {...replacements} onPage={setReplacementPage} />
        </> : <div className="tools-empty compact"><p>预览会显示在这里，已保存的会话和指纹不会改变。</p></div>}
      </section>
    </>}
  </div>;
}
