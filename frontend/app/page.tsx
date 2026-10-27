"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const apiBaseUrl = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const tokenStorageKey = "crewlink.accessToken";

interface LocalAccess {
  local_id: string;
  local_name: string;
  role: "leader" | "member";
}

interface Classification {
  id: string;
  name: string;
}

interface Announcement {
  id: string;
  local_id: string;
  title: string;
  body: string;
  push_preview: string | null;
  needs_ack: boolean;
  status: "draft" | "approved" | "sending" | "sent" | "failed";
  approved_at: string | null;
  sent_at: string | null;
  created_at: string;
  recipient_count?: number;
  sent_count?: number;
  read_count?: number;
  acknowledged_count?: number;
}

interface DraftForm {
  title: string;
  body: string;
  pushPreview: string;
  needsAck: boolean;
}

interface ApiError extends Error {
  status: number;
}

const blankDraft: DraftForm = { title: "", body: "", pushPreview: "", needsAck: false };

async function apiRequest<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw Object.assign(new Error("Could not reach the CrewLink API. Check the API URL and try again."), { status: 0 });
  }

  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(payload.error ?? `Request failed (${response.status})`), {
      status: response.status,
    }) as ApiError;
  }
  return payload as T;
}

function draftFromAnnouncement(announcement: Announcement): DraftForm {
  return {
    title: announcement.title,
    body: announcement.body,
    pushPreview: announcement.push_preview ?? "",
    needsAck: announcement.needs_ack,
  };
}

function sameDraft(left: DraftForm, right: DraftForm): boolean {
  return left.title === right.title &&
    left.body === right.body &&
    left.pushPreview === right.pushPreview &&
    left.needsAck === right.needsAck;
}

function formatStatus(status: Announcement["status"]): string {
  return status === "sending" ? "Sending" : status.charAt(0).toUpperCase() + status.slice(1);
}

export default function LeadershipPage() {
  const [token, setToken] = useState<string | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localAccess, setLocalAccess] = useState<LocalAccess[]>([]);
  const [selectedLocalId, setSelectedLocalId] = useState("");
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [classificationId, setClassificationId] = useState("");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState("");
  const [sendKey, setSendKey] = useState("");
  const [draft, setDraft] = useState<DraftForm>(blankDraft);
  const [savedDraft, setSavedDraft] = useState<DraftForm | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const leaderLocals = useMemo(
    () => localAccess.filter((access) => access.role === "leader"),
    [localAccess],
  );
  const selectedAnnouncement = announcements.find((announcement) => announcement.id === selectedAnnouncementId);
  const canEditSelected = !selectedAnnouncementId || selectedAnnouncement?.status === "draft";
  const dirty = savedDraft !== null && !sameDraft(draft, savedDraft);
  const formError = draft.title.trim().length === 0
    ? "Add a title before saving."
    : draft.title.trim().length > 200
      ? "The title must be 200 characters or fewer."
      : draft.body.trim().length === 0
        ? "Add announcement details before saving."
        : draft.body.trim().length > 20_000
          ? "The announcement body must be 20,000 characters or fewer."
          : draft.pushPreview.length > 120
            ? "The push preview must be 120 characters or fewer."
            : "";

  const clearSession = useCallback((message = "") => {
    localStorage.removeItem(tokenStorageKey);
    setToken(null);
    setLocalAccess([]);
    setSelectedLocalId("");
    setAnnouncements([]);
    setClassifications([]);
    setSelectedAnnouncementId("");
    setSavedDraft(null);
    setDraft(blankDraft);
    setError(message);
    setNotice("");
  }, []);

  useEffect(() => {
    const storedToken = localStorage.getItem(tokenStorageKey);
    if (storedToken) {
      setToken(storedToken);
    } else {
      setAuthLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    setAuthLoaded(false);
    apiRequest<{ localAccess: LocalAccess[] }>("/auth/me", token)
      .then(({ localAccess: access }) => {
        if (!active) return;
        const leaders = access.filter((item) => item.role === "leader");
        setLocalAccess(access);
        setSelectedLocalId((current) =>
          leaders.some((leader) => leader.local_id === current) ? current : leaders[0]?.local_id ?? "",
        );
        setError(leaders.length === 0 ? "This account does not have leadership access to a local." : "");
      })
      .catch((requestError: ApiError) => {
        if (!active) return;
        clearSession(requestError.status === 401 ? "Your session expired. Please sign in again." : requestError.message);
      })
      .finally(() => {
        if (active) setAuthLoaded(true);
      });
    return () => { active = false; };
  }, [token, clearSession]);

  const refreshWorkspace = useCallback(async (quiet = false) => {
    if (!token || !selectedLocalId) return;
    if (!quiet) setLoadingWorkspace(true);
    try {
      const [classificationResponse, announcementResponse] = await Promise.all([
        apiRequest<{ classifications: Classification[] }>(
          `/locals/${encodeURIComponent(selectedLocalId)}/announcements/classifications`,
          token,
        ),
        apiRequest<{ announcements: Announcement[] }>(
          `/locals/${encodeURIComponent(selectedLocalId)}/announcements`,
          token,
        ),
      ]);
      setClassifications(classificationResponse.classifications);
      setAnnouncements(announcementResponse.announcements);
      if (!quiet) setError("");
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) {
        clearSession("Your session expired. Please sign in again.");
      } else if (!quiet) {
        setError(apiError.message);
      }
    } finally {
      if (!quiet) setLoadingWorkspace(false);
    }
  }, [token, selectedLocalId, clearSession]);

  useEffect(() => {
    if (!token || !selectedLocalId) return;
    setSelectedAnnouncementId("");
    setSavedDraft(null);
    setDraft(blankDraft);
    setClassificationId("");
    setSendKey("");
    void refreshWorkspace();
    const intervalId = window.setInterval(() => void refreshWorkspace(true), 4_000);
    return () => window.clearInterval(intervalId);
  }, [token, selectedLocalId, refreshWorkspace]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ accessToken: string }>("/auth/login", null, {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      localStorage.setItem(tokenStorageKey, result.accessToken);
      setToken(result.accessToken);
      setPassword("");
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function selectAnnouncement(id: string) {
    setSelectedAnnouncementId(id);
    setNotice("");
    if (!id) {
      setDraft(blankDraft);
      setSavedDraft(null);
      setSendKey("");
      return;
    }
    setSendKey("");
    setBusy(true);
    try {
      const result = await apiRequest<{ announcement: Announcement }>(
        `/locals/${encodeURIComponent(selectedLocalId)}/announcements/${id}`,
        token,
      );
      const loaded = draftFromAnnouncement(result.announcement);
      setDraft(loaded);
      setSavedDraft(loaded);
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) clearSession("Your session expired. Please sign in again.");
      else setError(apiError.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (formError || !selectedLocalId) {
      setError(formError || "Select a local before saving.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      title: draft.title.trim(),
      body: draft.body.trim(),
      pushPreview: draft.pushPreview.trim() || null,
      needsAck: draft.needsAck,
    };
    try {
      const path = `/locals/${encodeURIComponent(selectedLocalId)}/announcements`;
      const result = savedDraft && selectedAnnouncementId
        ? await apiRequest<{ announcement: Announcement }>(`${path}/${selectedAnnouncementId}`, token, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
        : await apiRequest<{ announcement: Announcement }>(path, token, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      const saved = draftFromAnnouncement(result.announcement);
      setDraft(saved);
      setSavedDraft(saved);
      setSelectedAnnouncementId(result.announcement.id);
      setNotice("Draft saved. Review it, then use Send when you are ready.");
      setSendKey("");
      await refreshWorkspace(true);
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) clearSession("Your session expired. Please sign in again.");
      else setError(apiError.message);
    } finally {
      setBusy(false);
    }
  }

  async function generateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!notes.trim()) {
      setError("Enter leadership notes to generate a draft.");
      return;
    }
    if (notes.trim().length > 10_000) {
      setError("Notes must be 10,000 characters or fewer.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<{ announcement: Announcement }>(
        `/locals/${encodeURIComponent(selectedLocalId)}/announcements/ai-draft`,
        token,
        { method: "POST", body: JSON.stringify({ notes: notes.trim() }) },
      );
      const generated = draftFromAnnouncement(result.announcement);
      setSelectedAnnouncementId(result.announcement.id);
      setDraft(generated);
      setSavedDraft(generated);
      setNotice("AI suggestion saved as an unsent draft. Review and edit every field before sending.");
      await refreshWorkspace(true);
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) clearSession("Your session expired. Please sign in again.");
      else setError(apiError.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendAnnouncement() {
    if (!selectedAnnouncementId || !savedDraft || dirty || formError) {
      setError(dirty ? "Save your edits before sending." : "Save a valid draft before sending.");
      return;
    }
    if (!window.confirm("Send this announcement to the selected local audience? This action approves the draft.")) {
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const idempotencyKey = sendKey || crypto.randomUUID();
    setSendKey(idempotencyKey);
    try {
      await apiRequest(
        `/locals/${encodeURIComponent(selectedLocalId)}/announcements/${selectedAnnouncementId}/send`,
        token,
        {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body: JSON.stringify({ classificationId: classificationId || null }),
        },
      );
      setSendKey("");
      setNotice("Announcement approved and queued for delivery.");
      setSelectedAnnouncementId("");
      setSavedDraft(null);
      setDraft(blankDraft);
      await refreshWorkspace(true);
    } catch (requestError) {
      const apiError = requestError as ApiError;
      if (apiError.status === 401) clearSession("Your session expired. Please sign in again.");
      else setError(apiError.message);
    } finally {
      setBusy(false);
    }
  }

  if (!authLoaded) {
    return <main className="screen-center"><div className="loading-panel"><span className="spinner" />Checking your session…</div></main>;
  }

  if (!token) {
    return (
      <main className="login-page">
        <div className="brand brand-light"><span className="brand-mark">C</span><span>CrewLink</span></div>
        <section className="login-card">
          <div className="eyebrow">LEADERSHIP PORTAL</div>
          <h1>Sign in to your local</h1>
          <p className="muted">Create clear callouts and keep your members in the loop.</p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <form onSubmit={handleLogin} className="stack-form">
            <label>Email address<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button className="button button-primary button-wide" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="login-footnote">Leadership access is verified by CrewLink when you sign in.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">C</span><span>CrewLink</span><span className="brand-divider" />Leadership</div>
        <div className="topbar-right">
          <div className="local-picker">
            <span className="local-picker-label">WORKING LOCAL</span>
            <select
              aria-label="Select a local you lead"
              value={selectedLocalId}
              onChange={(event) => setSelectedLocalId(event.target.value)}
              disabled={leaderLocals.length === 0}
            >
              {leaderLocals.map((local) => <option value={local.local_id} key={local.local_id}>{local.local_name}</option>)}
              {leaderLocals.length === 0 && <option value="">No leadership locals</option>}
            </select>
          </div>
          <button className="button button-quiet" onClick={() => clearSession()} type="button">Sign out</button>
        </div>
      </header>

      <div className="page-wrap">
        <div className="page-heading">
          <div>
            <div className="eyebrow">MEMBER COMMUNICATIONS</div>
            <h1>Announcement studio</h1>
            <p className="muted">Write a callout, review it with your team, and send it when it’s ready.</p>
          </div>
          <div className="refresh-indicator"><span className="live-dot" /> Counts refresh every 4 seconds</div>
        </div>

        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {notice && <div className="alert alert-success" role="status">{notice}</div>}

        {leaderLocals.length === 0 ? (
          <section className="empty-panel">
            <div className="empty-icon">!</div><h2>No leadership access</h2>
            <p>Your account is signed in, but it does not have a leadership role in any local.</p>
          </section>
        ) : !selectedLocalId ? (
          <section className="empty-panel"><span className="spinner" /><p>Loading your local workspace…</p></section>
        ) : (
          <div className="studio-grid">
            <section className="editor-card">
              <div className="card-heading">
                <div><div className="eyebrow">COMPOSE</div><h2>{selectedAnnouncementId ? "Review announcement" : "New announcement"}</h2></div>
                {selectedAnnouncement && <span className={`status-pill status-${selectedAnnouncement.status}`}>{formatStatus(selectedAnnouncement.status)}</span>}
              </div>

              <div className="saved-draft-row">
                <label htmlFor="saved-announcements">Saved announcements</label>
                <select
                  id="saved-announcements"
                  value={selectedAnnouncementId}
                  onChange={(event) => void selectAnnouncement(event.target.value)}
                  disabled={loadingWorkspace}
                >
                  <option value="">Start a new announcement</option>
                  {announcements.map((announcement) => (
                    <option value={announcement.id} key={announcement.id}>
                      {announcement.title || "Untitled"} · {formatStatus(announcement.status)}
                    </option>
                  ))}
                </select>
              </div>

              <form className="ai-box" onSubmit={(event) => void generateDraft(event)}>
                <div className="ai-box-heading"><span className="sparkle">✦</span><div><strong>Draft from notes</strong><small>AI suggests copy only. You stay in control.</small></div></div>
                <textarea
                  aria-label="Messy leadership notes"
                  placeholder="Paste rough notes: topic, time, place, who needs to know…"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={10_000}
                  rows={3}
                />
                <div className="ai-box-footer"><span>{notes.length.toLocaleString()} / 10,000</span>
                  <button className="button button-ai" type="submit" disabled={busy || !notes.trim() || !selectedLocalId}>
                    {busy ? "Working…" : "✦ Generate draft"}
                  </button>
                </div>
              </form>

              <div className="separator"><span>OR WRITE IT YOURSELF</span></div>

              <form className="draft-form" onSubmit={(event) => void saveDraft(event)}>
                <label htmlFor="announcement-title">Title<span className="required">*</span></label>
                <input id="announcement-title" value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="A clear, specific headline" disabled={!canEditSelected} />
                <div className="field-meta"><span>Shown at the top of the callout</span><span>{draft.title.length}/200</span></div>

                <label htmlFor="announcement-body">Announcement body<span className="required">*</span></label>
                <textarea id="announcement-body" value={draft.body} maxLength={20_000} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder="Share the details members need to know…" rows={7} disabled={!canEditSelected} />
                <div className="field-meta"><span>Include key details and next steps</span><span>{draft.body.length.toLocaleString()}/20,000</span></div>

                <label htmlFor="push-preview">Push notification preview</label>
                <input id="push-preview" value={draft.pushPreview} maxLength={120} onChange={(event) => setDraft({ ...draft, pushPreview: event.target.value })} placeholder="Short notification shown on a device" disabled={!canEditSelected} />
                <div className={`field-meta ${draft.pushPreview.length > 120 ? "text-error" : ""}`}><span>Keep it short and useful</span><span>{draft.pushPreview.length}/120</span></div>

                <label className="check-row"><input type="checkbox" checked={draft.needsAck} onChange={(event) => setDraft({ ...draft, needsAck: event.target.checked })} disabled={!canEditSelected} /><span><strong>Request acknowledgement</strong><small>Members will be asked to confirm they’ve seen this.</small></span></label>

                <div className="audience-box">
                  <div className="audience-heading"><span className="audience-icon">◎</span><div><strong>Audience</strong><small>The recipient list is snapshotted when you send.</small></div></div>
                  <label htmlFor="classification">Work classification <span className="optional">OPTIONAL</span></label>
                  <select id="classification" value={classificationId} onChange={(event) => { setClassificationId(event.target.value); setSendKey(""); }} disabled={Boolean(selectedAnnouncementId && !["draft", "approved"].includes(selectedAnnouncement?.status ?? ""))}>
                    <option value="">All active members in this local</option>
                    {classifications.map((classification) => <option value={classification.id} key={classification.id}>{classification.name}</option>)}
                  </select>
                </div>

                {formError && <p className="inline-error" role="alert">{formError}</p>}
                <div className="form-actions">
                  <button className="button button-secondary" type="submit" disabled={busy || Boolean(formError) || !canEditSelected}>
                    {busy ? "Saving…" : !canEditSelected ? "Read-only" : savedDraft && selectedAnnouncementId ? "Save changes" : "Save as draft"}
                  </button>
                  <button className="button button-primary" type="button" onClick={() => void sendAnnouncement()} disabled={busy || !selectedAnnouncementId || !savedDraft || dirty || Boolean(formError) || !["draft", "approved"].includes(selectedAnnouncement?.status ?? "")}>
                    Send announcement <span aria-hidden="true">→</span>
                  </button>
                </div>
                {dirty && <p className="form-hint">Save your changes before sending. Sending explicitly approves this draft.</p>}
                {!selectedAnnouncementId && <p className="form-hint">Saving does not send. You can review or edit the draft before sending.</p>}
              </form>
            </section>

            <aside className="side-column">
              <section className="counts-card">
                <div className="card-heading"><div><div className="eyebrow">LIVE RESPONSE</div><h2>Member activity</h2></div><span className="live-dot" /></div>
                {!selectedAnnouncementId ? (
                  <div className="counts-empty"><div className="counts-empty-icon">↗</div><strong>Select an announcement</strong><p>Recipient and response counts appear here.</p></div>
                ) : (
                  <>
                    <p className="counts-subtitle">{selectedAnnouncement?.title || draft.title || "Selected announcement"}</p>
                    <div className="metric-list">
                      <div className="metric-row"><span><i className="metric-icon icon-send">↗</i> Sent to recipients</span><strong>{selectedAnnouncement?.recipient_count ?? 0}</strong></div>
                      <div className="metric-row"><span><i className="metric-icon icon-delivered">✓</i> Push delivered</span><strong>{selectedAnnouncement?.sent_count ?? 0}</strong></div>
                      <div className="metric-row"><span><i className="metric-icon icon-read">◉</i> Read</span><strong>{selectedAnnouncement?.read_count ?? 0}</strong></div>
                      <div className="metric-row"><span><i className="metric-icon icon-ack">✓</i> Acknowledged</span><strong>{selectedAnnouncement?.acknowledged_count ?? 0}</strong></div>
                    </div>
                    <p className="counts-footnote">Live counts refresh automatically. Push delivery and member actions are tracked separately.</p>
                  </>
                )}
              </section>
              <section className="guidance-card">
                <div className="guidance-icon">✦</div><h3>Human-reviewed, always</h3>
                <p>AI suggestions are starting points only. Review every detail, select the audience, and explicitly send to approve.</p>
              </section>
              <section className="recent-card">
                <div className="recent-heading"><h3>Recent announcements</h3><span>{announcements.length}</span></div>
                {loadingWorkspace ? <div className="recent-empty"><span className="spinner" />Loading…</div> :
                  announcements.length === 0 ? <p className="recent-empty">Nothing here yet. Your saved drafts will appear here.</p> :
                    announcements.slice(0, 5).map((announcement) => (
                      <button className={`recent-item ${selectedAnnouncementId === announcement.id ? "recent-item-active" : ""}`} key={announcement.id} onClick={() => void selectAnnouncement(announcement.id)} type="button">
                        <span className={`recent-status status-dot-${announcement.status}`} />
                        <span className="recent-copy"><strong>{announcement.title || "Untitled"}</strong><small>{new Date(announcement.created_at).toLocaleDateString()} · {formatStatus(announcement.status)}</small></span>
                        <span className="recent-arrow">›</span>
                      </button>
                    ))}
              </section>
            </aside>
          </div>
        )}
        <footer className="page-footer">CrewLink Leadership <span>•</span> Secure local communications</footer>
      </div>
    </main>
  );
}
