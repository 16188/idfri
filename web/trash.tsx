import { useEffect, useRef, useState } from "react";
import type { TrashMutationResult, TrashProfileView } from "../proxy-tools-types.ts";
import { proxyResultPage } from "./proxies.tsx";

export function filterTrash(profiles: TrashProfileView[], groups: string[] | null, search: string): TrashProfileView[] {
  const query = search.trim().toLowerCase();
  return profiles.filter((profile) => (groups === null || groups.includes(profile.group)) &&
    (!query || [profile.id, profile.name, profile.group].some((value) => value.toLowerCase().includes(query))));
}

async function trashJson(response: Response): Promise<any> {
  if (!response.ok) throw new Error("无法加载或更新回收站，请刷新后重试。");
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error("回收站返回了不完整的数据。");
  return body;
}

export function TrashPage({ active, onChanged }: { active: boolean; onChanged: () => Promise<void> }) {
  const [profiles, setProfiles] = useState<TrashProfileView[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<"load" | "restore" | "purge" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const folderProfiles = filterTrash(profiles, folders, "");
  const filtered = filterTrash(profiles, folders.length ? folders : null, search);
  const paged = proxyResultPage(filtered, page);
  const chosen = profiles.filter((profile) => selected.has(profile.id));
  const groups = [...new Set(profiles.map((profile) => profile.group))].sort();
  const pageSelected = paged.items.filter((profile) => selected.has(profile.id)).length;
  const allResultsSelected = filtered.length > 0 && filtered.every((profile) => selected.has(profile.id));
  const restoreDenied = chosen.some((profile) => !profile.canRestore);
  const purgeDenied = chosen.some((profile) => !profile.canPurge);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);

  const load = async (signal: AbortSignal) => {
    const body = await trashJson(await fetch("/ui/api/trash", { signal, cache: "no-store" }));
    if (!Array.isArray(body.profiles)) throw new Error("回收站返回了不完整的数据。");
    if (!signal.aborted) {
      setProfiles(body.profiles);
      const ids = new Set(body.profiles.map((profile: TrashProfileView) => profile.id));
      const remainingFolders = new Set(body.profiles.map((profile: TrashProfileView) => profile.group));
      setFolders((previous) => previous.filter((name) => remainingFolders.has(name)));
      setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
    }
  };
  const refresh = async () => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy("load"); setError("");
    try { await load(current.signal); }
    catch { if (!current.signal.aborted) setError("无法加载回收站，请检查连接后重试。"); }
    finally { if (controller.current === current) { controller.current = null; setBusy(null); } }
  };
  useEffect(() => { if (active) void refresh(); }, [active]);

  const mutate = async (action: "restore" | "purge", targets = chosen) => {
    if (controller.current || !targets.length) return;
    if (action === "purge" && !confirm(`确定永久删除 ${targets.length} 个资料及其保存的数据吗？此操作无法撤销。`)) return;
    const current = new AbortController(); controller.current = current;
    setBusy(action); setError("");
    setNotice(`${action === "restore" ? "正在恢复" : "正在永久删除"} ${targets.length.toLocaleString()} 个资料…`);
    try {
      const result = await trashJson(await fetch(`/ui/api/trash/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ ids: targets.map((profile) => profile.id) }),
      })) as TrashMutationResult;
      if (current.signal.aborted) return;
      if (!Array.isArray(result.results) || result.results.length !== targets.length) throw new Error("操作结果不完整");
      const failed = result.results.filter((row) => row.status === "failed");
      setSelected(new Set(failed.map((row) => row.id)));
      if (failed.length) { setSearch(""); setPage(0); }
      setNotice(`已${action === "restore" ? "恢复" : "永久删除"} ${(targets.length - failed.length).toLocaleString()} 个资料。`);
      if (failed.length) setError(`${failed.length.toLocaleString()} 个资料无法${action === "restore" ? "恢复" : "删除"}，这些资料仍保持选中。请检查分组权限并关闭已打开的资料后重试。`);
      await load(current.signal);
      await onChanged();
    } catch {
      if (!current.signal.aborted) {
        setNotice("");
        setError("操作已停止，部分资料可能已更新。请刷新回收站后重试。");
        await load(current.signal).catch(() => {});
      }
    } finally { if (controller.current === current) { controller.current = null; setBusy(null); } }
  };

  const changeFolders = (next: string[]) => {
    setFolders(next); setSelected(new Set()); setPage(0); setNotice("");
  };

  return <div className="workspace proxy-page trash-page" hidden={!active}>
    <div className="tools-intro">
      <div><span className="tools-eyebrow">资料恢复</span><h2>恢复已删除的资料</h2>
        <p>将资料连同保存的身份和会话恢复到原分组。</p></div>
      <span className="tools-count">回收站中有 <strong>{profiles.length.toLocaleString()}</strong> 个资料</span>
    </div>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    <div className="trash-layout">
      <aside className="tools-panel trash-folders" aria-label="回收站分组">
        <div className="tools-panel-head"><h3>按分组恢复</h3><span>{groups.length}</span></div>
        <p className="tools-hint">选择分组可一次恢复其中的所有资料。</p>
        <button className={`folder-all${!folders.length ? " selected" : ""}`} disabled={!!busy} onClick={() => changeFolders([])}>
          全部已删除资料 <span>{profiles.length.toLocaleString()}</span>
        </button>
        <div className="trash-folder-list">
          {groups.map((name) => <label className={`folder-choice${folders.includes(name) ? " selected" : ""}`} key={name}>
            <input type="checkbox" aria-label={`分组 ${name || "未分组"}`} disabled={!!busy} checked={folders.includes(name)} onChange={(event) => changeFolders(event.target.checked ? [...folders, name] : folders.filter((group) => group !== name))} />
            <span>{name || "未分组"}</span><small>{profiles.filter((profile) => profile.group === name).length.toLocaleString()}</small>
          </label>)}
          {!groups.length && <p className="tools-hint">包含已删除资料的分组会显示在这里。</p>}
        </div>
        <div className="trash-folder-action">
          <button className="btn primary" disabled={!!busy || !folderProfiles.length || folderProfiles.some((profile) => !profile.canRestore)} onClick={() => void mutate("restore", folderProfiles)}>
            {folders.length ? `恢复全部 ${folderProfiles.length.toLocaleString()} 个资料` : "恢复所选分组"}
          </button>
          <p className="tools-hint">{folders.length ? `包含所选 ${folders.length} 个分组中的全部资料，包括搜索结果之外的资料。` : "请在上方选择一个或多个分组。"}</p>
          {folderProfiles.some((profile) => !profile.canRestore) && <p className="tools-hint">你需要拥有所有所选分组的编辑权限。</p>}
        </div>
      </aside>
      <section className="tools-panel trash-results" aria-label="已删除资料">
        <div className="tools-panel-head"><div><h3>{folders.length ? "所选分组" : "全部已删除资料"}</h3><p>{filtered.length.toLocaleString()} 个{search ? "匹配的" : ""}资料</p></div>
          <button className="btn ghost" disabled={!!busy} onClick={() => void refresh()}>{busy === "load" ? "加载中…" : "刷新"}</button></div>
        <div className="trash-search">
          <input className="input" aria-label="搜索回收站" type="search" placeholder="按名称、ID 或分组搜索…" value={search} disabled={!!busy} onChange={(event) => { setSearch(event.target.value); setPage(0); setSelected(new Set()); }} />
          <button className="btn" disabled={!!busy || !filtered.length || allResultsSelected} onClick={() => setSelected(new Set(filtered.map((profile) => profile.id)))}>
            {allResultsSelected ? `已选择全部 ${filtered.length.toLocaleString()} 项` : `选择全部 ${filtered.length.toLocaleString()} 项结果`}
          </button>
        </div>
        {!!chosen.length && <div className="trash-selection">
          <div className="proxy-actions"><strong>已选择 {chosen.length.toLocaleString()} 项</strong><button className="tlink" disabled={!!busy} onClick={() => setSelected(new Set())}>清除</button></div>
          <div className="proxy-actions">
            <button className="btn primary" disabled={!!busy || restoreDenied} onClick={() => void mutate("restore")}>{busy === "restore" ? "恢复中…" : `恢复 ${chosen.length.toLocaleString()} 个资料`}</button>
            <button className="btn ghost trash-purge" disabled={!!busy || purgeDenied} onClick={() => void mutate("purge")}>永久删除</button>
          </div>
          {(restoreDenied || purgeDenied) && <p className="tools-hint">{restoreDenied ? "恢复操作需要所有所选分组的编辑权限。" : ""}{purgeDenied ? "只有工作区所有者可以永久删除资料。" : ""}</p>}
        </div>}
        {filtered.length > 0 ? <>
          <div className="proxy-table-wrap"><table className="profile-table proxy-table trash-table"><thead><tr>
            <th className="tools-checkbox"><input type="checkbox" aria-label="选择本页" disabled={!!busy} checked={pageSelected === paged.items.length} ref={(input) => { if (input) input.indeterminate = pageSelected > 0 && pageSelected < paged.items.length; }} onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => { const next = new Set(previous); for (const profile of paged.items) checked ? next.add(profile.id) : next.delete(profile.id); return next; });
            }} /></th><th>资料</th><th>原分组</th><th>删除时间</th></tr></thead>
            <tbody>{paged.items.map((profile) => <tr key={profile.id} className={selected.has(profile.id) ? "is-selected" : ""}>
              <td className="tools-checkbox"><input type="checkbox" aria-label={`选择 ${profile.name || profile.id}`} disabled={!!busy} checked={selected.has(profile.id)} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); checked ? next.add(profile.id) : next.delete(profile.id); return next; }); }} /></td>
              <td><strong>{profile.name || profile.id}</strong><small className="tools-mono">{profile.id}</small></td>
              <td><span className="tools-folder-tag">{profile.group || "未分组"}</span></td>
              <td><time dateTime={new Date(profile.trashedAt).toISOString()} title={new Date(profile.trashedAt).toLocaleString()}>{new Date(profile.trashedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time><small>{new Date(profile.trashedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small></td>
            </tr>)}</tbody></table></div>
          <div className="proxy-pager"><span>{(paged.page * 50 + 1).toLocaleString()}–{Math.min((paged.page + 1) * 50, filtered.length).toLocaleString()}，共 {filtered.length.toLocaleString()} 项</span>
            <button className="btn" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>上一页</button>
            <span>{paged.page + 1} / {paged.pages}</span>
            <button className="btn" disabled={paged.page + 1 >= paged.pages} onClick={() => setPage(paged.page + 1)}>下一页</button>
          </div>
        </> : <div className="tools-empty"><span className="tools-empty-symbol" aria-hidden="true">↶</span><h3>{busy === "load" ? "正在加载回收站…" : profiles.length ? "没有匹配的资料" : "回收站为空"}</h3><p>{profiles.length ? "请尝试其他分组或搜索词。" : "移入回收站的资料会显示在这里，并可随时恢复。"}</p></div>}
      </section>
    </div>
    <p className="tools-footnote">恢复操作会保留已保存的资料数据；永久删除会移除数据且无法撤销。</p>
  </div>;
}
