import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useState,
} from 'react';

const STORAGE_KEY = 'notificator_frontend_admin_shell';

function readStoredState() {
  if (typeof window === 'undefined') {
    return {
      baseUrl: '',
      email: '',
      token: '',
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        baseUrl: '',
        email: '',
        token: '',
      };
    }

    const parsed = JSON.parse(raw);
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
    };
  } catch {
    return {
      baseUrl: '',
      email: '',
      token: '',
    };
  }
}

function writeStoredState(nextState) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  return trimmed.replace(/\/+$/, '');
}

function buildUrl(baseUrl, path, params) {
  const finalBaseUrl = normalizeBaseUrl(baseUrl);
  const route = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${finalBaseUrl}${route}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

async function apiRequest({ baseUrl, path, method = 'GET', token, body, params }) {
  const headers = {};
  if (token) {
    headers.Token = token;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(buildUrl(baseUrl, path, params), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    const text = await response.text();
    throw new Error(text || 'The server returned an unreadable response.');
  }

  if (payload?.identifier === 'OK') {
    return payload.body;
  }

  throw new Error(
    payload?.user_message ||
      payload?.message ||
      `Request failed with status ${response.status}`,
  );
}

function sortAccounts(nextAccounts) {
  return [...nextAccounts].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  );
}

function prettyTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function emptyEditor() {
  return {
    id: null,
    name: '',
    nick: '',
    token: '',
  };
}

function generateSdkExampleCode({ account, baseUrl }) {
  const hostValue = normalizeBaseUrl(baseUrl) || 'http://127.0.0.1:8000';
  const accountName = JSON.stringify(account?.name || 'demo_account');
  const accountToken = JSON.stringify(account?.token || 'replace-with-token');
  const hostString = JSON.stringify(hostValue);

  return `pip install notificator

from notificator import Notificator

notificator = Notificator(
    name=${accountName},
    token=${accountToken},
    host=${hostString},
)

# Send one email notification
result = notificator.mail(
    mail="user@example.com",
    subject="Build finished",
    body="The nightly build is green.",
    recipient_name="Operator",
    action_url="https://example.com/jobs/42",
    action_text="Open job",
    footer_note="Triggered from Notificator Admin XP.",
)
print(result)

# Or fan out one message to multiple channels
multi_result = (
    notificator
    .clean()
    .prepare_sms(
        "+8613800000000",
        template_param={"scene": "incident"},
    )
    .prepare_mail(
        "user@example.com",
        recipient_name="Operator",
        action_url="https://example.com/incidents/7",
        action_text="View incident",
    )
    .prepare_webhook(
        "https://example.com/hooks/notificator",
        headers={"Authorization": "Bearer your-secret"},
        body={"source": "notificator-admin-xp"},
    )
    .send(
        format="verification",
        body={"code": "482901", "time": 10},
        title="Incident opened",
    )
)
print(multi_result)
`;
}

function XpButton({ children, kind = 'default', className = '', ...props }) {
  return (
    <button
      className={`xp-button xp-button--${kind} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export default function App() {
  const [storedState] = useState(() => readStoredState());
  const [booting, setBooting] = useState(true);
  const [clock, setClock] = useState(() => prettyTime(new Date()));
  const [baseUrl, setBaseUrl] = useState(
    storedState.baseUrl || import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000',
  );
  const [email, setEmail] = useState(storedState.email);
  const [password, setPassword] = useState('');
  const [adminToken, setAdminToken] = useState(storedState.token);
  const [accounts, setAccounts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editor, setEditor] = useState(emptyEditor);
  const [createForm, setCreateForm] = useState({ name: '', nick: '' });
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [busy, setBusy] = useState({
    login: false,
    refresh: false,
    create: false,
    save: false,
    renew: false,
    delete: false,
  });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deletePrimedId, setDeletePrimedId] = useState(null);
  const [exampleOpen, setExampleOpen] = useState(false);

  const visibleAccounts = accounts.filter((account) => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) {
      return true;
    }

    return (
      account.name.toLowerCase().includes(query) ||
      account.nick.toLowerCase().includes(query)
    );
  });

  const loadAccounts = useEffectEvent(async (quiet = false) => {
    if (!adminToken) {
      return;
    }

    setBusy((current) => ({ ...current, refresh: true }));
    setError('');

    try {
      const nextAccounts = await apiRequest({
        baseUrl,
        path: '/api/account/',
        method: 'GET',
        token: adminToken,
      });

      startTransition(() => {
        const normalized = Array.isArray(nextAccounts) ? sortAccounts(nextAccounts) : [];
        setAccounts(normalized);
        setSelectedId((current) => {
          if (normalized.some((item) => item.id === current)) {
            return current;
          }
          return normalized[0]?.id ?? null;
        });
      });

      if (!quiet) {
        setNotice('Directory refreshed from the service.');
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, refresh: false }));
    }
  });

  useEffect(() => {
    document.title = adminToken ? 'Notificator Admin XP' : 'Notificator Login XP';
  }, [adminToken]);

  useEffect(() => {
    const bootTimer = window.setTimeout(() => {
      setBooting(false);
    }, 1450);

    const clockTimer = window.setInterval(() => {
      setClock(prettyTime(new Date()));
    }, 15000);

    return () => {
      window.clearTimeout(bootTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  useEffect(() => {
    writeStoredState({
      baseUrl: normalizeBaseUrl(baseUrl),
      email,
      token: adminToken,
    });
  }, [adminToken, baseUrl, email]);

  useEffect(() => {
    const current = accounts.find((item) => item.id === selectedId);
    if (!current) {
      setEditor(emptyEditor());
      return;
    }

    setEditor({
      id: current.id,
      name: current.name,
      nick: current.nick,
      token: current.token,
    });
  }, [accounts, selectedId]);

  useEffect(() => {
    if (!adminToken) {
      return;
    }

    void loadAccounts(true);
  }, [adminToken, baseUrl]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setNotice('');
    }, 3200);

    return () => window.clearTimeout(timer);
  }, [notice]);

  async function handleLogin(event) {
    event.preventDefault();
    setBusy((current) => ({ ...current, login: true }));
    setError('');
    setNotice('');

    try {
      const data = await apiRequest({
        baseUrl,
        path: '/api/auth',
        method: 'POST',
        body: {
          email,
          password,
        },
      });

      setAdminToken(data?.token || '');
      setPassword('');
      setNotice('Administrator shell unlocked.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, login: false }));
    }
  }

  function handleLogout() {
    setAdminToken('');
    setPassword('');
    setAccounts([]);
    setSelectedId(null);
    setDeletePrimedId(null);
    setNotice('Session closed.');
  }

  async function handleCreate(event) {
    event.preventDefault();
    setBusy((current) => ({ ...current, create: true }));
    setError('');

    try {
      const created = await apiRequest({
        baseUrl,
        path: '/api/account/',
        method: 'POST',
        token: adminToken,
        body: {
          name: createForm.name,
          nick: createForm.nick,
        },
      });

      startTransition(() => {
        setAccounts((current) => sortAccounts([...current, created]));
        setSelectedId(created.id);
      });
      setCreateForm({ name: '', nick: '' });
      setNotice(`Account ${created.name} created.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, create: false }));
    }
  }

  async function handleSave() {
    if (!editor.id) {
      return;
    }

    setBusy((current) => ({ ...current, save: true }));
    setError('');

    try {
      const updated = await apiRequest({
        baseUrl,
        path: '/api/account/',
        method: 'PUT',
        token: adminToken,
        params: { id: editor.id },
        body: {
          name: editor.name,
          nick: editor.nick,
          renew: false,
        },
      });

      startTransition(() => {
        setAccounts((current) =>
          sortAccounts(current.map((item) => (item.id === updated.id ? updated : item))),
        );
      });
      setNotice(`Account ${updated.name} saved.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, save: false }));
    }
  }

  async function handleRenewToken() {
    if (!editor.id) {
      return;
    }

    setBusy((current) => ({ ...current, renew: true }));
    setError('');

    try {
      const updated = await apiRequest({
        baseUrl,
        path: '/api/account/',
        method: 'PUT',
        token: adminToken,
        params: { id: editor.id },
        body: {
          name: editor.name,
          nick: editor.nick,
          renew: true,
        },
      });

      startTransition(() => {
        setAccounts((current) =>
          sortAccounts(current.map((item) => (item.id === updated.id ? updated : item))),
        );
      });
      setNotice(`Token renewed for ${updated.name}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, renew: false }));
    }
  }

  async function handleDelete() {
    if (!editor.id) {
      return;
    }

    if (deletePrimedId !== editor.id) {
      setDeletePrimedId(editor.id);
      setNotice(`Delete ${editor.name}? Click Remove again to confirm.`);
      return;
    }

    setBusy((current) => ({ ...current, delete: true }));
    setError('');

    try {
      await apiRequest({
        baseUrl,
        path: '/api/account/',
        method: 'DELETE',
        token: adminToken,
        params: { id: editor.id },
      });

      startTransition(() => {
        setAccounts((current) => current.filter((item) => item.id !== editor.id));
      });
      setDeletePrimedId(null);
      setNotice(`Account ${editor.name} removed.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy((current) => ({ ...current, delete: false }));
    }
  }

  async function handleCopyToken() {
    if (!editor.token) {
      return;
    }

    try {
      await navigator.clipboard.writeText(editor.token);
      setNotice(`Token copied for ${editor.name}.`);
    } catch {
      setError('Clipboard access is unavailable in this browser.');
    }
  }

  async function handleCopyExample() {
    if (!selectedAccount) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        generateSdkExampleCode({
          account: selectedAccount,
          baseUrl,
        }),
      );
      setNotice(`SDK example copied for ${selectedAccount.name}.`);
    } catch {
      setError('Clipboard access is unavailable in this browser.');
    }
  }

  const sessionLabel = adminToken ? 'Administrator Session' : 'Welcome';
  const selectedAccount = accounts.find((item) => item.id === selectedId) || null;
  const sdkExampleCode = selectedAccount
    ? generateSdkExampleCode({
        account: selectedAccount,
        baseUrl,
      })
    : '';

  return (
    <div className="desktop">
      <div className="desktop__wallpaper" aria-hidden="true">
        <div className="desktop__sun" />
        <div className="desktop__cloud desktop__cloud--one" />
        <div className="desktop__cloud desktop__cloud--two" />
        <div className="desktop__hill desktop__hill--back" />
        <div className="desktop__hill desktop__hill--front" />
      </div>

      <aside className="desktop-icons" aria-label="Desktop shortcuts">
        <button className="desktop-icon" type="button">
          <span className="desktop-icon__badge desktop-icon__badge--computer" />
          <span className="desktop-icon__label">My Admin</span>
        </button>
        <button className="desktop-icon" type="button">
          <span className="desktop-icon__badge desktop-icon__badge--folder" />
          <span className="desktop-icon__label">Accounts</span>
        </button>
      </aside>

      <main className={`window-shell ${adminToken ? 'window-shell--wide' : ''}`}>
        <section className="xp-window" aria-label="Notificator administration shell">
          <header className="xp-titlebar">
            <div className="xp-titlebar__caption">
              <span className="xp-titlebar__dot" />
              <span>Notificator Administrator</span>
            </div>
            <div className="xp-titlebar__actions" aria-hidden="true">
              <span className="xp-titlebar__button">_</span>
              <span className="xp-titlebar__button">□</span>
              <span className="xp-titlebar__button xp-titlebar__button--danger">×</span>
            </div>
          </header>

          <div className="xp-menubar">
            <span>File</span>
            <span>Action</span>
            <span>View</span>
            <span>Help</span>
          </div>

          <div className="xp-toolbar">
            <XpButton
              kind="ghost"
              onClick={() => void loadAccounts(false)}
              disabled={!adminToken || busy.refresh}
            >
              Refresh
            </XpButton>
            <XpButton
              kind="ghost"
              onClick={() => {
                setCreateForm((current) => ({ ...current, name: current.name || 'ops_' }));
              }}
              disabled={!adminToken}
            >
              New
            </XpButton>
            <XpButton kind="ghost" onClick={handleLogout} disabled={!adminToken}>
              Sign Out
            </XpButton>
            <div className="xp-toolbar__status">{sessionLabel}</div>
          </div>

          {!adminToken ? (
            <div className="login-scene">
              <section className="welcome-pane">
                <div className="welcome-pane__orb" />
                <p className="welcome-pane__eyebrow">Classic control room</p>
                <h1>Operator Console</h1>
                <p>
                  This shell is for the Notificator administrator only. Sign in,
                  point the console at your backend, then manage account tokens
                  like it is 2002.
                </p>
                <ul className="welcome-pane__facts">
                  <li>Admin login via `/api/auth`</li>
                  <li>Accounts live under `/api/account/`</li>
                  <li>Every token becomes a sender identity</li>
                </ul>
              </section>

              <form className="auth-card" onSubmit={handleLogin}>
                <div className="auth-card__header">
                  <h2>Log On To Notificator</h2>
                  <p>Use the administrator credentials configured in the backend.</p>
                </div>

                <Field label="Server URL" hint="Example: http://127.0.0.1:8000">
                  <input
                    className="xp-input"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="http://127.0.0.1:8000"
                    required
                  />
                </Field>

                <Field label="Admin Email">
                  <input
                    className="xp-input"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="admin@example.com"
                    required
                    autoComplete="username"
                  />
                </Field>

                <Field label="Password">
                  <input
                    className="xp-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Your admin password"
                    type="password"
                    required
                    autoComplete="current-password"
                  />
                </Field>

                {error ? <p className="message-bar message-bar--error">{error}</p> : null}

                <div className="auth-card__footer">
                  <XpButton type="submit" kind="primary" disabled={busy.login}>
                    {busy.login ? 'Connecting...' : 'Log In'}
                  </XpButton>
                </div>
              </form>
            </div>
          ) : (
            <div className="workspace">
              <aside className="task-pane">
                <section className="task-group">
                  <div className="task-group__title">Connection</div>
                  <div className="task-group__body">
                    <Field label="Server URL">
                      <input
                        className="xp-input"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                      />
                    </Field>
                    <div className="inline-note">
                      Live endpoint for this session.
                    </div>
                  </div>
                </section>

                <section className="task-group">
                  <div className="task-group__title">Create Account</div>
                  <form className="task-group__body" onSubmit={handleCreate}>
                    <Field label="Account Name">
                      <input
                        className="xp-input"
                        value={createForm.name}
                        onChange={(event) =>
                          setCreateForm((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        placeholder="alert_ops"
                        required
                      />
                    </Field>

                    <Field label="Display Nick">
                      <input
                        className="xp-input"
                        value={createForm.nick}
                        onChange={(event) =>
                          setCreateForm((current) => ({
                            ...current,
                            nick: event.target.value,
                          }))
                        }
                        placeholder="Alert Ops"
                        required
                      />
                    </Field>

                    <XpButton type="submit" kind="primary" disabled={busy.create}>
                      {busy.create ? 'Creating...' : 'Add Account'}
                    </XpButton>
                  </form>
                </section>

                <section className="task-group">
                  <div className="task-group__title">Quick Notes</div>
                  <div className="task-group__body">
                    <p>Names are used in the `Auth` header for send requests.</p>
                    <p>Renewing a token immediately rotates the sender secret.</p>
                  </div>
                </section>
              </aside>

              <section className="directory-pane">
                <div className="directory-pane__header">
                  <div>
                    <p className="directory-pane__eyebrow">Account directory</p>
                    <h2>Manage sender identities</h2>
                  </div>
                  <label className="searchbox">
                    <span>Search</span>
                    <input
                      className="xp-input"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Filter by name or nick"
                    />
                  </label>
                </div>

                {error ? <p className="message-bar message-bar--error">{error}</p> : null}

                <div className="directory-grid">
                  <section className="account-list-panel">
                    <div className="list-head">
                      <span>Account</span>
                      <span>Nick</span>
                    </div>
                    <div className="account-list">
                      {visibleAccounts.length ? (
                        visibleAccounts.map((account) => (
                          <button
                            key={account.id}
                            type="button"
                            className={`account-row ${
                              selectedId === account.id ? 'account-row--selected' : ''
                            }`}
                            onClick={() => {
                              setSelectedId(account.id);
                              setDeletePrimedId(null);
                            }}
                          >
                            <span className="account-row__name">{account.name}</span>
                            <span className="account-row__nick">{account.nick}</span>
                          </button>
                        ))
                      ) : (
                        <div className="empty-panel">
                          <h3>No matching accounts</h3>
                          <p>
                            Create one from the task pane or widen the search.
                          </p>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="inspector-panel">
                    {selectedAccount ? (
                      <>
                        <div className="inspector-panel__header">
                          <div>
                            <p className="directory-pane__eyebrow">Selected identity</p>
                            <h3>{selectedAccount.name}</h3>
                          </div>
                          <div className="pill">
                            ID {selectedAccount.id}
                          </div>
                        </div>

                        <div className="inspector-form">
                          <Field label="Account Name">
                            <input
                              className="xp-input"
                              value={editor.name}
                              onChange={(event) =>
                                setEditor((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }))
                              }
                            />
                          </Field>

                          <Field label="Display Nick">
                            <input
                              className="xp-input"
                              value={editor.nick}
                              onChange={(event) =>
                                setEditor((current) => ({
                                  ...current,
                                  nick: event.target.value,
                                }))
                              }
                            />
                          </Field>

                          <Field
                            label="Current Token"
                            hint="Tokens are shown once here for operator convenience."
                          >
                            <textarea
                              className="xp-input xp-input--token"
                              readOnly
                              value={editor.token}
                            />
                          </Field>
                        </div>

                        <div className="action-row">
                          <XpButton kind="primary" onClick={handleSave} disabled={busy.save}>
                            {busy.save ? 'Saving...' : 'Save'}
                          </XpButton>
                          <XpButton kind="default" onClick={handleRenewToken} disabled={busy.renew}>
                            {busy.renew ? 'Renewing...' : 'Renew Token'}
                          </XpButton>
                          <XpButton kind="ghost" onClick={() => setExampleOpen(true)}>
                            Example
                          </XpButton>
                          <XpButton kind="ghost" onClick={handleCopyToken}>
                            Copy Token
                          </XpButton>
                          <XpButton kind="danger" onClick={handleDelete} disabled={busy.delete}>
                            {busy.delete
                              ? 'Removing...'
                              : deletePrimedId === editor.id
                                ? 'Confirm Remove'
                                : 'Remove'}
                          </XpButton>
                        </div>
                      </>
                    ) : (
                      <div className="empty-panel empty-panel--tall">
                        <h3>No account selected</h3>
                        <p>
                          Pick an entry from the directory to edit or rotate its token.
                        </p>
                      </div>
                    )}
                  </section>
                </div>
              </section>
            </div>
          )}

          <footer className="xp-statusbar">
            <span>{busy.refresh ? 'Synchronizing account list...' : `${accounts.length} account(s)`}</span>
            <span>{normalizeBaseUrl(baseUrl) || 'No server configured'}</span>
          </footer>
        </section>
      </main>

      <footer className="taskbar">
        <button className="start-button" type="button">
          <span className="start-button__orb" />
          <span>start</span>
        </button>
        <div className="taskbar__title">Notificator Administrator</div>
        <div className="taskbar__clock">{clock}</div>
      </footer>

      {notice ? <div className="toast">{notice}</div> : null}

      {exampleOpen && selectedAccount ? (
        <div
          className="xp-modal-backdrop"
          role="presentation"
          onClick={() => setExampleOpen(false)}
        >
          <section
            className="xp-modal-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sdk-example-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="xp-titlebar">
              <div className="xp-titlebar__caption">
                <span className="xp-titlebar__dot" />
                <span id="sdk-example-title">SDK Example for {selectedAccount.name}</span>
              </div>
              <div className="xp-titlebar__actions">
                <button
                  type="button"
                  className="xp-titlebar__button xp-titlebar__button--danger"
                  onClick={() => setExampleOpen(false)}
                  aria-label="Close example"
                >
                  ×
                </button>
              </div>
            </header>

            <div className="xp-modal-body">
              <div className="xp-modal-copybar">
                <p>
                  Use this account directly with `notificator-sdk`. The code below
                  already includes the selected name, token, and current backend URL.
                </p>
                <div className="action-row">
                  <XpButton kind="primary" onClick={handleCopyExample}>
                    Copy Code
                  </XpButton>
                  <XpButton kind="ghost" onClick={() => setExampleOpen(false)}>
                    Close
                  </XpButton>
                </div>
              </div>

              <pre className="code-viewer">
                <code>{sdkExampleCode}</code>
              </pre>
            </div>
          </section>
        </div>
      ) : null}

      {booting ? (
        <div className="boot-screen" role="status" aria-live="polite">
          <div className="boot-screen__frame">
            <div className="boot-screen__brand">Windows XP</div>
            <div className="boot-screen__sub">Notificator Administrator Edition</div>
            <div className="boot-screen__progress">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
