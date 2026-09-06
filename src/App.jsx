import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Clock3,
  Download,
  FileText,
  Gauge,
  Globe2,
  History,
  LockKeyhole,
  LogOut,
  Mail,
  Monitor,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import PptReport from "./PptReport.jsx";
import { orderWebsites } from "../website-order.mjs";

const metrics = [
  ["performance", "Performance", Gauge],
  ["accessibility", "Accessibility", ShieldCheck],
  ["bestPractices", "Best practices", Sparkles],
  ["seo", "SEO", Search],
];
const historyMetrics = [
  ["SEO", "seo"],
  ["Best Practices", "bestPractices"],
  ["Accessibility", "accessibility"],
  ["Performance", "performance"],
  ["Overall", "overall"],
];
const websiteLabels = {
  "stc.com.kw": "STC Kuwait",
  "kw.zain.com": "Zain Kuwait",
  "ooredoo.com.kw": "Ooredoo Kuwait",
  "stc.com.sa": "STC Saudi Arabia",
  "stc.com.bh": "STC Bahrain",
  "virgin.com": "Virgin",
};
const palette = [
  "#4f008c",
  "#ff375e",
  "#1d252d",
  "#8736c4",
  "#8e9aa0",
  "#c80025",
];

function loadSaved(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function colorForDomain(domain) {
  return palette[
    [...domain].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
      palette.length
  ];
}

function zeroSiteForUrl(standardUrl, index) {
  const domain = new URL(standardUrl).hostname.replace(/^www\./, "");
  const zeroDevice = () => ({
    performance: 0,
    accessibility: 0,
    bestPractices: 0,
    seo: 0,
  });
  return {
    id: `pending-${index}-${domain}`,
    domain,
    url: standardUrl,
    standardUrl,
    overall: 0,
    scores: {
      performance: 0,
      accessibility: 0,
      bestPractices: 0,
      seo: 0,
      mobile: 0,
      desktop: 0,
      coreWebVitals: 0,
    },
    deviceScores: { mobile: zeroDevice(), desktop: zeroDevice() },
    scannedAt: null,
    status: "Pending",
    coverage: { mobile: false, desktop: false },
    pending: true,
    color: colorForDomain(domain),
  };
}

function scoreTone(score) {
  if (score >= 90) return "great";
  if (score >= 75) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function relativeTime(date) {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(date)) / 60000),
  );
  if (minutes < 2) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function checkedTime(date) {
  if (!date) return "Not checked yet";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kuwait",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function historyCheckedTime(record) {
  if (!record) return "N/A";
  return record.dateOnly
    ? `${historyDateLabel(kuwaitDateKey(record.checkedAt))} (imported date only)`
    : checkedTime(record.checkedAt);
}

function kuwaitDateKey(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kuwait",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(date))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function historyDateLabel(dateKey) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function deviceScore(site, device, metric) {
  if (site.coverage?.[device] === false && !site.pending) return null;
  const exact = site.deviceScores?.[device]?.[metric];
  if (typeof exact === "number") return exact;
  if (metric === "performance")
    return device === "mobile" ? site.scores.mobile : site.scores.desktop;
  return null;
}

function parseWebsiteEntries(value) {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((entry) =>
          entry
            .trim()
            .replace(/^[\[<(]+/, "")
            .replace(/[\])>|]+$/, ""),
        )
        .filter(Boolean),
    ),
  ];
}

function loadEmailRecipients() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("benchmark-email-recipients") || "[]",
    );
    if (Array.isArray(saved))
      return saved.filter((value) => typeof value === "string");
  } catch {
    /* use legacy value below */
  }
  const legacy = localStorage.getItem("benchmark-email-recipient");
  return legacy ? [legacy] : [];
}

async function fetchWithStaticFallback(apiPath, staticPath) {
  const response = await fetch(apiPath, { cache: "no-store" });
  if (response.status === 401 || response.status === 403) return response;
  return response.ok ? response : fetch(staticPath, { cache: "no-store" });
}

function LoginScreen({ onAuthenticated }) {
  const setupToken =
    new URLSearchParams(window.location.search).get("setup") || "";
  const [mode, setMode] = useState(setupToken ? "setup" : "login");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [login, setLogin] = useState({ identifier: "", password: "" });
  const [request, setRequest] = useState({
    username: "",
    mobile: "",
    department: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");

  async function submit(path, body) {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Request failed");
      return result;
    } catch (error) {
      setMessage(error.message || "Request failed");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const result = await submit("/api/auth/login", login);
    if (result?.user) onAuthenticated(result);
  }

  async function requestAccess(event) {
    event.preventDefault();
    if (request.password !== request.confirmPassword)
      return setMessage("Password and Confirm Password must match.");
    const result = await submit("/api/auth/request-access", request);
    if (result?.submitted) {
      setMessage(
        "Access request submitted. An Admin will review it and you will receive an email after approval.",
      );
      setRequest({
        username: "",
        mobile: "",
        department: "",
        email: "",
        password: "",
        confirmPassword: "",
      });
    }
  }

  async function setupPassword(event) {
    event.preventDefault();
    if (password !== passwordConfirm)
      return setMessage("Password and Confirm Password must match.");
    const result = await submit("/api/auth/setup-password", {
      token: setupToken,
      password,
      confirmPassword: passwordConfirm,
    });
    if (result?.user) {
      window.history.replaceState({}, "", window.location.pathname);
      onAuthenticated(result);
    }
  }

  return (
    <div className="auth-shell">
      <section className="auth-brand-panel">
        <div className="auth-logo">stc</div>
        <span>Website Benchmark</span>
        <h1>Secure digital intelligence for STC teams.</h1>
        <p>
          Compare performance, review audit findings, manage score history, and
          distribute approved reports from one access-controlled workspace.
        </p>
        <div>
          <LockKeyhole size={18} />
          <strong>Role-based access</strong>
          <small>
            Every dashboard and action is protected by Admin-assigned
            permissions.
          </small>
        </div>
      </section>
      <section className="auth-card">
        <div className="auth-card-head">
          <span>
            {mode === "request"
              ? "Access request"
              : mode === "setup"
                ? "Account activation"
                : "Secure sign in"}
          </span>
          <h2>
            {mode === "request"
              ? "Request dashboard access"
              : mode === "setup"
                ? "Create your password"
                : "Welcome back"}
          </h2>
          <p>
            {mode === "request"
              ? "Choose a lowercase username using letters, dots, or commas, then submit your STC details for Admin review."
              : mode === "setup"
                ? "Use at least 10 characters. Your invitation can only be used once."
                : "Use your username or STC email and password."}
          </p>
        </div>
        {mode === "login" && (
          <form onSubmit={signIn}>
            <label>
              <span>Username or STC email</span>
              <input
                required
                autoComplete="username"
                value={login.identifier}
                onChange={(event) =>
                  setLogin({ ...login, identifier: event.target.value })
                }
              />
            </label>
            <label>
              <span>Password</span>
              <input
                required
                type="password"
                autoComplete="current-password"
                value={login.password}
                onChange={(event) =>
                  setLogin({ ...login, password: event.target.value })
                }
              />
            </label>
            <button disabled={loading}>
              <LockKeyhole size={16} />
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMode("request");
                setMessage("");
              }}
            >
              Request Access
            </button>
          </form>
        )}
        {mode === "request" && (
          <form onSubmit={requestAccess}>
            <label>
              <span>Username</span>
              <input
                required
                pattern="[a-z]+(?:[.,][a-z]+)*"
                title="Use lowercase letters, with dots or commas only between letter groups"
                autoCapitalize="none"
                autoComplete="username"
                value={request.username}
                onChange={(event) =>
                  setRequest({
                    ...request,
                    username: event.target.value
                      .toLowerCase()
                      .replace(/[^a-z.,]/g, ""),
                  })
                }
              />
              <small>Lowercase letters with dots or commas between letter groups</small>
            </label>
            <label>
              <span>Mobile number</span>
              <input
                required
                inputMode="tel"
                value={request.mobile}
                onChange={(event) =>
                  setRequest({ ...request, mobile: event.target.value })
                }
              />
            </label>
            <label>
              <span>Department</span>
              <input
                required
                value={request.department}
                onChange={(event) =>
                  setRequest({ ...request, department: event.target.value })
                }
              />
            </label>
            <label>
              <span>STC email ID</span>
              <input
                required
                type="email"
                placeholder="name@stc.com.kw"
                value={request.email}
                onChange={(event) =>
                  setRequest({ ...request, email: event.target.value })
                }
              />
            </label>
            <label>
              <span>Password</span>
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={request.password}
                onChange={(event) =>
                  setRequest({ ...request, password: event.target.value })
                }
              />
            </label>
            <label>
              <span>Confirm Password</span>
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={request.confirmPassword}
                onChange={(event) =>
                  setRequest({
                    ...request,
                    confirmPassword: event.target.value,
                  })
                }
              />
            </label>
            <button disabled={loading}>
              <Send size={16} />
              {loading ? "Submitting…" : "Submit request"}
            </button>
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMode("login");
                setMessage("");
              }}
            >
              Back to sign in
            </button>
          </form>
        )}
        {mode === "setup" && (
          <form onSubmit={setupPassword}>
            <label>
              <span>New password</span>
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              <span>Confirm Password</span>
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
              />
            </label>
            <button disabled={loading}>
              <UserCheck size={16} />
              {loading ? "Activating…" : "Activate account"}
            </button>
          </form>
        )}
        {message && (
          <div
            className={`auth-message ${/submitted/i.test(message) ? "success" : ""}`}
          >
            {message}
          </div>
        )}
      </section>
    </div>
  );
}

function AdminAccessScreen({ currentUser }) {
  const [data, setData] = useState({ requests: [], users: [], loading: true });
  const [notice, setNotice] = useState("");
  const [passwordReset, setPasswordReset] = useState(null);
  const [newUser, setNewUser] = useState(null);
  const [usernameEdit, setUsernameEdit] = useState(null);
  const sections = [
    ["overview", "Benchmark overview"],
    ["history", "Score history"],
    ["ppt", "PPT Report"],
    ["findings", "Audit findings"],
    ["emails", "Emails to send"],
  ];

  async function refresh() {
    const response = await fetch("/api/admin/access", { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    setData({
      requests: result.requests || [],
      users: result.users || [],
      loading: false,
    });
  }
  useEffect(() => {
    refresh().catch(() =>
      setData((current) => ({ ...current, loading: false })),
    );
  }, []);

  async function decide(request, decision) {
    const response = await fetch(
      `/api/admin/access-requests/${request.id}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          role: "user",
          sections: ["overview", "history", "ppt", "findings"],
          canSendEmail: false,
          canDownload: true,
        }),
      },
    );
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? decision === "approve"
          ? `Approved ${request.username}. ${result.activated ? "The account is active with the password selected in the request." : result.invitationSent ? "Invitation email sent." : "Invitation saved but email delivery failed."}`
          : `Rejected ${request.username}.`
        : result.error || "Unable to update request",
    );
    if (response.ok) await refresh();
  }

  async function updateUser(user, changes) {
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: user.role,
        status: user.status,
        sections: user.sections,
        canSendEmail: user.canSendEmail,
        canDownload: user.canDownload,
        ...changes,
      }),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `Permissions updated for ${user.username}.`
        : result.error || "Unable to update permissions",
    );
    if (response.ok) await refresh();
  }

  async function resendInvitation(user) {
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "POST",
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `A new invitation was sent to ${user.email}.`
        : result.error || "Unable to resend invitation",
    );
    if (response.ok) await refresh();
  }

  async function resetPasswords(event) {
    event.preventDefault();
    const response = await fetch("/api/admin/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: passwordReset.scope,
        userId: passwordReset.user?.id,
        password: passwordReset.password,
        confirmPassword: passwordReset.confirmPassword,
      }),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `Password reset completed for ${result.users} ${result.users === 1 ? "user" : "users"}.`
        : result.error || "Unable to reset password",
    );
    if (response.ok) {
      setPasswordReset(null);
      await refresh();
    }
  }

  async function createUser(event) {
    event.preventDefault();
    if (newUser.password !== newUser.confirmPassword) {
      return setNotice("Password and Confirm Password must match.");
    }
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `User ${result.user.username} was created and can sign in immediately.`
        : result.error || "Unable to create user",
    );
    if (response.ok) {
      setNewUser(null);
      await refresh();
    }
  }

  async function saveUsername(event) {
    event.preventDefault();
    const user = data.users.find((item) => item.id === usernameEdit.userId);
    if (!user) return;
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: user.role,
        status: user.status,
        sections: user.sections,
        canSendEmail: user.canSendEmail,
        canDownload: user.canDownload,
        username: usernameEdit.username,
      }),
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `Username updated to ${result.user.username}.`
        : result.error || "Unable to update username",
    );
    if (response.ok) {
      setUsernameEdit(null);
      await refresh();
    }
  }

  async function deleteUser(user) {
    if (
      !window.confirm(
        `Delete ${user.username}? This removes the account and signs the user out.`,
      )
    )
      return;
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "DELETE",
    });
    const result = await response.json().catch(() => ({}));
    setNotice(
      response.ok
        ? `${user.username} was deleted.`
        : result.error || "Unable to delete user",
    );
    if (response.ok) await refresh();
  }

  const pending = data.requests.filter(
    (request) => request.status === "pending",
  );
  return (
    <div className="admin-access">
      <section className="admin-hero">
        <div>
          <span>Administration</span>
          <h1>Access management</h1>
          <p>
            Approve requests, assign roles, reset passwords, remove users, and
            control dashboard, email, and download permissions.
          </p>
        </div>
        <div>
          <strong>{pending.length}</strong>
          <span>Pending requests</span>
        </div>
        <div>
          <strong>{data.users.length}</strong>
          <span>Managed users</span>
        </div>
      </section>
      {notice && <div className="admin-notice">{notice}</div>}
      <section className="admin-panel">
        <div className="admin-panel-head">
          <div>
            <span>Access requests</span>
            <h2>Pending Admin review</h2>
          </div>
          <button onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        {data.loading ? (
          <div className="admin-empty">Loading access requests…</div>
        ) : pending.length ? (
          <div className="request-table">
            <div className="request-row head">
              <span>User</span>
              <span>Department</span>
              <span>Contact</span>
              <span>Requested</span>
              <span>Decision</span>
            </div>
            {pending.map((request) => (
              <div className="request-row" key={request.id}>
                <span>
                  <strong>{request.username}</strong>
                  <small>{request.email}</small>
                </span>
                <span>{request.department}</span>
                <span>{request.mobile}</span>
                <span>{checkedTime(request.requestedAt)}</span>
                <span className="request-actions">
                  <button
                    className="approve"
                    onClick={() => decide(request, "approve")}
                  >
                    <UserCheck size={14} />
                    Approve
                  </button>
                  <button
                    className="reject"
                    onClick={() => decide(request, "reject")}
                  >
                    <XCircle size={14} />
                    Reject
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="admin-empty">
            <UserCheck size={24} />
            <strong>No pending requests</strong>
            <span>
              New requests will appear here and notify the Admin by email.
            </span>
          </div>
        )}
        {data.requests.some((request) => request.status !== "pending") && (
          <div className="request-history">
            <strong>Request history</strong>
            {data.requests
              .filter((request) => request.status !== "pending")
              .map((request) => (
                <div key={request.id}>
                  <span>
                    <b>{request.username}</b>
                    <small>{request.email}</small>
                  </span>
                  <em className={request.status}>{request.status}</em>
                  <time>{checkedTime(request.reviewedAt)}</time>
                </div>
              ))}
          </div>
        )}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-head">
          <div>
            <span>User permissions</span>
            <h2>Roles and feature access</h2>
          </div>
          <div className="admin-panel-buttons">
            <button
              className="create-user"
              onClick={() =>
                setNewUser({
                  username: "",
                  email: "",
                  mobile: "",
                  department: "",
                  password: "",
                  confirmPassword: "",
                  role: "user",
                  canSendEmail: false,
                  canDownload: true,
                })
              }
            >
              <UserPlus size={14} />
              Create user
            </button>
            <button
              className="reset-all"
              onClick={() =>
                setPasswordReset({
                  scope: "all",
                  user: null,
                  password: "",
                  confirmPassword: "",
                })
              }
            >
              <LockKeyhole size={14} />
              Reset all passwords
            </button>
          </div>
        </div>
        {newUser && (
          <form className="admin-create-panel" onSubmit={createUser}>
            <div className="admin-create-heading">
              <strong>Create a new user</strong>
              <small>The account becomes active immediately after creation.</small>
            </div>
            <label>
              Username
              <input
                required
                pattern="[a-z]+(?:[.,][a-z]+)*"
                title="Use lowercase letters, with dots or commas only between letter groups"
                value={newUser.username}
                onChange={(event) =>
                  setNewUser({
                    ...newUser,
                    username: event.target.value
                      .toLowerCase()
                      .replace(/[^a-z.,]/g, ""),
                  })
                }
              />
              <small>Example: mohammed.mohsin</small>
            </label>
            <label>
              STC email ID
              <input
                required
                type="email"
                placeholder="name@stc.com.kw"
                value={newUser.email}
                onChange={(event) =>
                  setNewUser({ ...newUser, email: event.target.value })
                }
              />
            </label>
            <label>
              Mobile number
              <input
                required
                inputMode="tel"
                value={newUser.mobile}
                onChange={(event) =>
                  setNewUser({ ...newUser, mobile: event.target.value })
                }
              />
            </label>
            <label>
              Department
              <input
                required
                value={newUser.department}
                onChange={(event) =>
                  setNewUser({ ...newUser, department: event.target.value })
                }
              />
            </label>
            <label>
              Password
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={newUser.password}
                onChange={(event) =>
                  setNewUser({ ...newUser, password: event.target.value })
                }
              />
            </label>
            <label>
              Confirm password
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={newUser.confirmPassword}
                onChange={(event) =>
                  setNewUser({
                    ...newUser,
                    confirmPassword: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Role
              <select
                value={newUser.role}
                onChange={(event) =>
                  setNewUser({ ...newUser, role: event.target.value })
                }
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <div className="admin-create-permissions">
              <label>
                <input
                  type="checkbox"
                  checked={newUser.role === "admin" || newUser.canSendEmail}
                  disabled={newUser.role === "admin"}
                  onChange={(event) =>
                    setNewUser({
                      ...newUser,
                      canSendEmail: event.target.checked,
                    })
                  }
                />
                Send email reports
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={newUser.role === "admin" || newUser.canDownload}
                  disabled={newUser.role === "admin"}
                  onChange={(event) =>
                    setNewUser({
                      ...newUser,
                      canDownload: event.target.checked,
                    })
                  }
                />
                Download reports
              </label>
            </div>
            <div className="admin-create-actions">
              <button type="button" onClick={() => setNewUser(null)}>
                Cancel
              </button>
              <button type="submit">
                <UserPlus size={13} />
                Create user
              </button>
            </div>
          </form>
        )}
        {passwordReset && (
          <form className="password-reset-panel" onSubmit={resetPasswords}>
            <div>
              <strong>
                {passwordReset.scope === "all"
                  ? "Reset passwords for all users"
                  : `Reset password for ${passwordReset.user.username}`}
              </strong>
              <small>
                {passwordReset.scope === "all"
                  ? `The same new password will be applied to all ${data.users.length} accounts.`
                  : "Only this selected account will be updated."}
              </small>
            </div>
            <label>
              New password
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={passwordReset.password}
                onChange={(event) =>
                  setPasswordReset({
                    ...passwordReset,
                    password: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Confirm password
              <input
                required
                minLength="10"
                type="password"
                autoComplete="new-password"
                value={passwordReset.confirmPassword}
                onChange={(event) =>
                  setPasswordReset({
                    ...passwordReset,
                    confirmPassword: event.target.value,
                  })
                }
              />
            </label>
            <div className="password-reset-actions">
              <button type="button" onClick={() => setPasswordReset(null)}>
                Cancel
              </button>
              <button type="submit">
                <LockKeyhole size={13} />
                Apply reset
              </button>
            </div>
          </form>
        )}
        <div className="user-permissions">
          {data.users.map((user) => (
            <article key={user.id}>
              <header>
                <div>
                  <span>{user.username.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{user.username}</strong>
                    <small>
                      {user.email} · {user.department || "Administration"}
                    </small>
                  </div>
                </div>
                <label>
                  Role
                  <select
                    value={user.role}
                    onChange={(event) =>
                      updateUser(user, { role: event.target.value })
                    }
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <label>
                  Status
                  <select
                    value={user.status}
                    onChange={(event) =>
                      updateUser(user, { status: event.target.value })
                    }
                  >
                    <option value="active">Active</option>
                    <option value="invited">Invited</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                {user.status === "invited" && (
                  <button
                    className="resend-invite"
                    onClick={() => resendInvitation(user)}
                  >
                    <Send size={13} />
                    Resend invite
                  </button>
                )}
              </header>
              {usernameEdit?.userId === user.id && (
                <form className="username-edit-row" onSubmit={saveUsername}>
                  <label>
                    Edit username
                    <input
                      required
                      autoFocus
                      pattern="[a-z]+(?:[.,][a-z]+)*"
                      title="Use lowercase letters, with dots or commas only between letter groups"
                      value={usernameEdit.username}
                      onChange={(event) =>
                        setUsernameEdit({
                          ...usernameEdit,
                          username: event.target.value
                            .toLowerCase()
                            .replace(/[^a-z.,]/g, ""),
                        })
                      }
                    />
                  </label>
                  <small>Lowercase letters with dots or commas between letter groups</small>
                  <div>
                    <button type="button" onClick={() => setUsernameEdit(null)}>
                      Cancel
                    </button>
                    <button type="submit">
                      <Check size={12} />
                      Save username
                    </button>
                  </div>
                </form>
              )}
              <div className="permission-grid">
                <div>
                  <span>Dashboard sections</span>
                  {sections.map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={
                          user.role === "admin" || user.sections?.includes(key)
                        }
                        disabled={user.role === "admin"}
                        onChange={(event) =>
                          updateUser(user, {
                            sections: event.target.checked
                              ? [...new Set([...(user.sections || []), key])]
                              : (user.sections || []).filter(
                                  (section) => section !== key,
                                ),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <div>
                  <span>Feature permissions</span>
                  <label>
                    <input
                      type="checkbox"
                      checked={user.role === "admin" || user.canSendEmail}
                      disabled={user.role === "admin"}
                      onChange={(event) =>
                        updateUser(user, { canSendEmail: event.target.checked })
                      }
                    />
                    Send email reports
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={user.role === "admin" || user.canDownload}
                      disabled={user.role === "admin"}
                      onChange={(event) =>
                        updateUser(user, { canDownload: event.target.checked })
                      }
                    />
                    Download Excel/PDF/PPT reports
                  </label>
                  <div className="admin-user-actions">
                    <button
                      onClick={() =>
                        setUsernameEdit({
                          userId: user.id,
                          username: user.username,
                        })
                      }
                    >
                      <UserCheck size={12} />
                      Edit username
                    </button>
                    <button
                      onClick={() =>
                        setPasswordReset({
                          scope: "user",
                          user,
                          password: "",
                          confirmPassword: "",
                        })
                      }
                    >
                      <LockKeyhole size={12} />
                      Reset password
                    </button>
                    <button
                      className="delete"
                      disabled={user.id === currentUser?.id}
                      title={
                        user.id === currentUser?.id
                          ? "You cannot delete your own account"
                          : `Delete ${user.username}`
                      }
                      onClick={() => deleteUser(user)}
                    >
                      <Trash2 size={12} />
                      Delete user
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardApp({ currentUser, permissions, onLogout }) {
  const allowedSections = permissions?.sections || [];
  const initialView =
    ["overview", "history", "ppt", "findings", "emails", "admin"].find(
      (section) => allowedSections.includes(section),
    ) || "overview";
  const [savedSites, setSites] = useState(() => loadSaved("webpulse-live-sites-v1"));
  const sites = useMemo(() => orderWebsites(savedSites), [savedSites]);
  const [issues, setIssues] = useState(() =>
    loadSaved("webpulse-live-issues-v1"),
  );
  const [url, setUrl] = useState("");
  const [view, setView] = useState(initialView);
  const [selectedSite, setSelectedSite] = useState("");
  const [severity, setSeverity] = useState("All");
  const [issueSite, setIssueSite] = useState("All");
  const [query, setQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [batchItems, setBatchItems] = useState([]);
  const [emailRecipient, setEmailRecipient] = useState("");
  const [emailRecipients, setEmailRecipients] = useState(loadEmailRecipients);
  const [manualRecipientMode, setManualRecipientMode] = useState("all");
  const [selectedEmailRecipients, setSelectedEmailRecipients] = useState([]);
  const manualRecipients = manualRecipientMode === "all"
    ? emailRecipients
    : emailRecipients.filter((recipient) => selectedEmailRecipients.includes(recipient));
  const [emailSchedule, setEmailSchedule] = useState(
    () =>
      localStorage.getItem("benchmark-email-schedule") ||
      "After every completed scan",
  );
  const [emailTime, setEmailTime] = useState(
    () => localStorage.getItem("benchmark-email-time") || "10:00",
  );
  const [emailDay, setEmailDay] = useState(
    () => localStorage.getItem("benchmark-email-day") || "Sunday",
  );
  const [emailReportType, setEmailReportType] = useState(
    () => localStorage.getItem("benchmark-email-report-type") || "benchmark",
  );
  const [historyEmailFrom, setHistoryEmailFrom] = useState(
    () => localStorage.getItem("benchmark-history-email-from") || "",
  );
  const [historyEmailTo, setHistoryEmailTo] = useState(
    () => localStorage.getItem("benchmark-history-email-to") || "",
  );
  const [emailEnabled, setEmailEnabled] = useState(
    () => localStorage.getItem("benchmark-email-enabled") !== "false",
  );
  const [autoSendAfterCheck, setAutoSendAfterCheck] = useState(
    () => localStorage.getItem("benchmark-auto-send-after-check") !== "false",
  );
  const [emailStatus, setEmailStatus] = useState({
    configured: false,
    sender: null,
    loading: true,
  });
  const [emailSending, setEmailSending] = useState(false);
  const [automation, setAutomation] = useState({
    status: "loading",
    standardUrls: [],
    progress: [],
    sites: [],
    nextRunAt: null,
  });
  const [history, setHistory] = useState([]);
  const [historyDevice, setHistoryDevice] = useState("All");
  const sitesRef = useRef(sites);
  const comparisonSitesRef = useRef([]);
  const issuesRef = useRef(issues);
  const appliedAutomationRef = useRef(null);
  const [toast, setToast] = useState("");
  const individualActiveUrl =
    automation.individualRun?.status === "running"
      ? automation.individualRun.url
      : null;
  const scoreCheckBusy =
    automation.status === "running" || Boolean(individualActiveUrl);

  const standardComparisonSites = automation.standardUrls?.length
    ? automation.standardUrls.map((standardUrl, index) => {
        const domain = new URL(standardUrl).hostname.replace(/^www\./, "");
        const progress = automation.progress?.find(
          (item) => item.url === standardUrl,
        );
        const savedSite = sites.find(
          (item) => item.standardUrl === standardUrl || item.domain === domain,
        );
        return (
          progress?.latestSite ||
          savedSite || {
            id: `standard-${index}`,
            domain,
            url: standardUrl,
            standardUrl,
            overall:
              typeof progress?.overall === "number" ? progress.overall : null,
            scores: {},
            deviceScores: { mobile: {}, desktop: {} },
            scannedAt: progress?.checkedAt || null,
          }
        );
      })
    : [];
  const standardDomains = new Set(
    (automation.standardUrls || []).map((standardUrl) =>
      new URL(standardUrl).hostname.replace(/^www\./, ""),
    ),
  );
  const extraSites = sites.filter((site) => !standardDomains.has(site.domain));
  const comparisonSites = automation.standardUrls?.length
    ? orderWebsites([...standardComparisonSites, ...extraSites])
    : sites;
  const comparisonGroups = Array.from(
    { length: Math.ceil(comparisonSites.length / 3) },
    (_, index) => comparisonSites.slice(index * 3, index * 3 + 3),
  );
  const average = sites.length
    ? Math.round(
        sites.reduce((sum, site) => sum + site.overall, 0) / sites.length,
      )
    : null;
  const filteredIssues = issues.filter(
    (issue) =>
      (severity === "All" || issue.severity === severity) &&
      (issueSite === "All" || issue.site === issueSite) &&
      `${issue.title} ${issue.site} ${issue.category} ${issue.device || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const severityCounts = useMemo(
    () =>
      ["Critical", "High", "Medium", "Low"].map((level) => ({
        level,
        count: issues.filter((issue) => issue.severity === level).length,
      })),
    [issues],
  );
  const historySites = [...new Set(history.map((record) => record.domain))];
  const standardHistoryDomains = (automation.standardUrls || []).map(
    (standardUrl) => new URL(standardUrl).hostname.replace(/^www\./, ""),
  );
  const historyDomains = orderWebsites(standardHistoryDomains.length
    ? standardHistoryDomains
    : historySites);
  const historyDevices =
    historyDevice === "All" ? ["Mobile", "Web"] : [historyDevice];
  const historyLookup = new Map();
  history.forEach((record) => {
    const key = `${kuwaitDateKey(record.checkedAt)}|${record.domain}|${record.device}`;
    const current = historyLookup.get(key);
    if (!current || new Date(record.checkedAt) > new Date(current.checkedAt))
      historyLookup.set(key, record);
  });
  const historyDates = [
    ...new Set(history.map((record) => kuwaitDateKey(record.checkedAt))),
  ].sort();
  const historyEmailRecords = history.filter((record) => {
    const date = kuwaitDateKey(record.checkedAt);
    return (
      (!historyEmailFrom || date >= historyEmailFrom) &&
      (!historyEmailTo || date <= historyEmailTo)
    );
  });
  const historyEmailDates = [
    ...new Set(
      historyEmailRecords.map((record) => kuwaitDateKey(record.checkedAt)),
    ),
  ].sort();
  const historyEmailSites = [
    ...new Set(historyEmailRecords.map((record) => record.domain)),
  ];
  const historyEmailLatest = [...historyEmailRecords].sort(
    (a, b) => new Date(b.checkedAt) - new Date(a.checkedAt),
  )[0];
  const historyEmailLookup = new Map();
  historyEmailRecords.forEach((record) => {
    const key = `${kuwaitDateKey(record.checkedAt)}|${record.domain}|${record.device}`;
    const current = historyEmailLookup.get(key);
    if (!current || new Date(record.checkedAt) > new Date(current.checkedAt))
      historyEmailLookup.set(key, record);
  });

  useEffect(
    () => localStorage.setItem("webpulse-live-sites-v1", JSON.stringify(sites)),
    [sites],
  );
  useEffect(
    () =>
      localStorage.setItem("webpulse-live-issues-v1", JSON.stringify(issues)),
    [issues],
  );
  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);
  useEffect(() => {
    comparisonSitesRef.current = comparisonSites;
  }, [comparisonSites]);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);
  useEffect(() => {
    fetch("/api/email-status")
      .then((response) => response.json())
      .then((status) => setEmailStatus({ ...status, loading: false }))
      .catch(() =>
        setEmailStatus({ configured: false, sender: null, loading: false }),
      );
  }, []);
  useEffect(() => {
    let active = true;
    const refreshHistory = async () => {
      try {
        const response = await fetchWithStaticFallback(
          "/api/history",
          "/benchmark-history.json",
        );
        if (!response.ok) return;
        const result = await response.json();
        if (active)
          setHistory(Array.isArray(result.history) ? result.history : []);
      } catch {
        /* history remains at its last loaded state */
      }
    };
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    fetch("/api/email-settings")
      .then((response) => response.json())
      .then((settings) => {
        if (Array.isArray(settings.recipients) && settings.recipients.length)
          setEmailRecipients(settings.recipients);
        else if (emailRecipients.length) persistEmailSettings(emailRecipients);
        if (settings.schedule) setEmailSchedule(settings.schedule);
        setEmailTime("10:00");
        localStorage.setItem("benchmark-email-time", "10:00");
        if (settings.day) setEmailDay(settings.day);
        if (
          settings.reportType === "benchmark" ||
          settings.reportType === "history"
        ) {
          setEmailReportType(settings.reportType);
          localStorage.setItem(
            "benchmark-email-report-type",
            settings.reportType,
          );
        }
        if (typeof settings.autoSendAfterCheck === "boolean") {
          setAutoSendAfterCheck(settings.autoSendAfterCheck);
          localStorage.setItem(
            "benchmark-auto-send-after-check",
            String(settings.autoSendAfterCheck),
          );
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetchWithStaticFallback(
          "/api/automation-state",
          "/benchmark-automation-state.json",
        );
        const next = await response.json();
        if (!active) return;
        setAutomation(next);
        const updateToken =
          next.individualRun?.updatedAt || next.lastCompletedAt;
        if (
          (next.status === "running" ||
            next.individualRun?.status === "running") &&
          Array.isArray(next.sites) &&
          next.sites.length
        ) {
          const progressiveSites = next.sites.map((site) => ({
            ...site,
            color: colorForDomain(site.domain),
            delta: 0,
          }));
          setSites(progressiveSites);
          setIssues(Array.isArray(next.issues) ? next.issues : []);
        } else if (
          updateToken &&
          updateToken !== appliedAutomationRef.current &&
          Array.isArray(next.sites) &&
          next.sites.length
        ) {
          appliedAutomationRef.current = updateToken;
          const liveSites = next.sites.map((site) => ({
            ...site,
            color: colorForDomain(site.domain),
            delta: 0,
          }));
          setSites(liveSites);
          setIssues(Array.isArray(next.issues) ? next.issues : []);
        }
      } catch {
        /* server status remains visible from the last successful poll */
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (sites.length && !sites.some((site) => site.domain === selectedSite))
      setSelectedSite(sites[0].domain);
  }, [sites, selectedSite]);

  function notify(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2800);
  }

  async function scanWebsite(targetUrl) {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        result.error || `Analysis failed with HTTP ${response.status}.`,
      );
    const previous = sites.find((site) => site.domain === result.site.domain);
    const site = {
      ...result.site,
      delta:
        previous?.overall == null ? 0 : result.site.overall - previous.overall,
      color: colorForDomain(result.site.domain),
    };
    setSites((current) =>
      current.some((item) => item.domain === site.domain)
        ? current.map((item) => (item.domain === site.domain ? site : item))
        : [...current, site],
    );
    setIssues((current) => [
      ...result.issues,
      ...current.filter((issue) => issue.site !== site.domain),
    ]);
    setSelectedSite(site.domain);
    return site;
  }

  async function scanBatch(targets) {
    const failures = [];
    let completed = 0;
    setBatchItems(
      targets.map((target) => ({
        url: target,
        domain: new URL(target).hostname.replace(/^www\./, ""),
        status: "queued",
      })),
    );
    setIsScanning(true);
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        setScanProgress({
          current: index + 1,
          total: targets.length,
          domain: new URL(target).hostname,
        });
        setBatchItems((items) =>
          items.map((item, itemIndex) =>
            itemIndex === index ? { ...item, status: "scanning" } : item,
          ),
        );
        try {
          const scannedSite = await scanWebsite(target);
          completed += 1;
          setBatchItems((items) =>
            items.map((item, itemIndex) =>
              itemIndex === index
                ? {
                    ...item,
                    status: scannedSite.scanWarning ? "partial" : "complete",
                    domain: scannedSite.domain,
                    overall: scannedSite.overall,
                    message: scannedSite.scanWarning,
                  }
                : item,
            ),
          );
        } catch (error) {
          failures.push({
            url: target,
            message: error.message || "Analysis failed",
          });
          setBatchItems((items) =>
            items.map((item, itemIndex) =>
              itemIndex === index
                ? {
                    ...item,
                    status: "failed",
                    message: error.message || "Analysis failed",
                  }
                : item,
            ),
          );
          continue;
        }
      }
      setUrl(targets.join("\n"));
      notify(
        failures.length
          ? `${completed} of ${targets.length} completed; ${failures.length} need retry`
          : `${completed} live ${completed === 1 ? "scan" : "scans"} completed`,
      );
      if (
        completed &&
        emailEnabled &&
        emailSchedule === "After every completed scan" &&
        emailRecipients.length
      ) {
        window.setTimeout(
          () => sendEmailReport(emailRecipients.join(","), true, "benchmark"),
          800,
        );
      }
    } finally {
      setIsScanning(false);
      setScanProgress(null);
    }
  }

  function analyze(event) {
    event?.preventDefault();
    const entries = parseWebsiteEntries(url);
    if (!entries.length) return notify("Enter at least one website URL");
    if (entries.length > 10) return notify("Add up to 10 websites per batch");
    const targets = [];
    for (const entry of entries) {
      try {
        const target = new URL(
          /^https?:\/\//i.test(entry) ? entry : `https://${entry}`,
        );
        if (!target.hostname.includes(".")) throw new Error();
        targets.push(target.href);
      } catch {
        return notify(`Invalid website URL: ${entry}`);
      }
    }
    scanBatch(targets);
  }

  function rescan(site) {
    if (site && !isScanning) scanBatch([site.url]);
  }

  function downloadCsv() {
    if (!permissions.canDownload)
      return notify("You do not have permission to download reports");
    if (!sites.length) return notify("No benchmark results to export");
    const deviceHeaders = metrics.flatMap(([, label]) => [
      `Mobile ${label}`,
      `Web ${label}`,
    ]);
    const head = [
      "Website",
      "Overall",
      ...deviceHeaders,
      "Issues",
      "Scan date",
    ];
    const rows = sites.map((site) => [
      site.domain,
      site.overall,
      ...metrics.flatMap(([key]) => [
        deviceScore(site, "mobile", key) ?? "",
        deviceScore(site, "desktop", key) ?? "",
      ]),
      issues.filter((issue) => issue.site === site.domain).length,
      new Date(site.scannedAt).toISOString(),
    ]);
    const csv = [head, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download = `stc-website-benchmark-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify("Excel-compatible report downloaded");
  }

  async function downloadHistoryExcel() {
    if (!permissions.canDownload)
      return notify("You do not have permission to download reports");
    try {
      let response = await fetch("/api/history.xlsx", { cache: "no-store" });
      let blob = response.ok ? await response.blob() : null;
      const signature = blob
        ? new Uint8Array(await blob.slice(0, 4).arrayBuffer())
        : [];
      if (!blob || signature[0] !== 0x50 || signature[1] !== 0x4b) {
        const encodedResponse = await fetch(
          "/benchmark-history-workbook.json",
          { cache: "no-store" },
        );
        if (!encodedResponse.ok) throw new Error("Excel history export failed");
        const encoded = await encodedResponse.json();
        const binary = atob(encoded.base64 || "");
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0),
        );
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
          throw new Error("Excel history export failed");
        blob = new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      }
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename =
        disposition.match(/filename="?([^";]+)"?/i)?.[1] ||
        `website-benchmark-history-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
      notify("Complete score history workbook downloaded");
    } catch (error) {
      notify(error.message || "Excel history export failed");
    }
  }

  async function sendEmailReport(
    recipient = emailRecipients.join(","),
    automatic = false,
    reportType = emailReportType,
  ) {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to send email reports");
    if (!emailStatus.configured)
      return notify("Gmail is not connected on the server");
    const recipients = String(recipient)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !recipients.length ||
      recipients.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    )
      return notify("Add at least one valid recipient email address");
    if (reportType === "history" && !history.length)
      return notify("No Score History Report is available yet");
    if (
      reportType === "history" &&
      historyEmailFrom &&
      historyEmailTo &&
      historyEmailFrom > historyEmailTo
    )
      return notify("The From date must be before the To date");
    if (reportType === "history" && !historyEmailRecords.length)
      return notify("No score history is available in the selected date range");
    if (reportType === "benchmark" && !comparisonSitesRef.current.length)
      return notify("Run at least one website scan first");
    setEmailSending(true);
    try {
      const response = await fetch(
        reportType === "history"
          ? "/api/history-email-report"
          : "/api/email-report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            reportType === "history"
              ? {
                  recipient,
                  dateFrom: historyEmailFrom,
                  dateTo: historyEmailTo,
                }
              : {
                  recipient,
                  sites: comparisonSitesRef.current.map((site) => ({
                    domain: site.domain,
                    overall: site.overall,
                    deviceScores: {
                      mobile: Object.fromEntries(
                        metrics.map(([key]) => [
                          key,
                          deviceScore(site, "mobile", key),
                        ]),
                      ),
                      desktop: Object.fromEntries(
                        metrics.map(([key]) => [
                          key,
                          deviceScore(site, "desktop", key),
                        ]),
                      ),
                    },
                  })),
                },
          ),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Email delivery failed");
      const label =
        reportType === "history" ? "Score History Report" : "Benchmark Report";
      notify(
        automatic
          ? `Automatic ${label} sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`
          : `${label} sent manually to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      notify(error.message || "Email delivery failed");
    } finally {
      setEmailSending(false);
    }
  }

  async function persistEmailSettings(
    recipients = emailRecipients,
    overrides = {},
  ) {
    try {
      await fetch("/api/email-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients,
          schedule: emailSchedule,
          time: emailTime,
          day: emailDay,
          enabled: true,
          autoSendAfterCheck,
          reportType: emailReportType,
          weeklyHistoryEnabled: true,
          ...overrides,
        }),
      });
    } catch {
      /* local settings remain available if the server is temporarily offline */
    }
  }

  async function runStandardCheck() {
    if (scoreCheckBusy) return;
    if (automation.hostingMode === "static-snapshot")
      return notify(
        "Live score checks require the Hostinger Node backend to be enabled",
      );
    try {
      const response = await fetch("/api/automation/run", { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Unable to start the score check");
      const resetSites = (automation.standardUrls || []).map(zeroSiteForUrl);
      setSites(resetSites);
      setIssues([]);
      setAutomation((current) => ({
        ...current,
        status: "running",
        trigger: "manual",
        sites: resetSites,
        issues: [],
        progress: resetSites.map((site) => ({
          url: site.standardUrl,
          domain: site.domain,
          status: "queued",
          attempt: 0,
          overall: 0,
          checkedAt: null,
          latestSite: site,
        })),
      }));
      notify("Score check started for all six standard URLs");
    } catch (error) {
      notify(error.message || "Unable to start the score check");
    }
  }

  async function runIndividualCheck(standardUrl) {
    if (scoreCheckBusy)
      return notify("Wait for the current score check to finish");
    if (automation.hostingMode === "static-snapshot")
      return notify(
        "Live score checks require the Hostinger Node backend to be enabled",
      );
    try {
      const response = await fetch("/api/automation/run-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: standardUrl }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          result.error || "Unable to start this website score check",
        );
      const index = (automation.standardUrls || []).indexOf(standardUrl);
      const zeroSite = zeroSiteForUrl(standardUrl, index);
      setSites((current) =>
        current.some(
          (site) =>
            site.standardUrl === standardUrl || site.domain === zeroSite.domain,
        )
          ? current.map((site) =>
              site.standardUrl === standardUrl ||
              site.domain === zeroSite.domain
                ? zeroSite
                : site,
            )
          : [...current, zeroSite],
      );
      setAutomation((current) => ({
        ...current,
        sites: (current.sites || []).map((site, siteIndex) =>
          siteIndex === index ? zeroSite : site,
        ),
        progress: (current.progress || []).map((item, itemIndex) =>
          itemIndex === index
            ? {
                ...item,
                status: "scanning",
                attempt: 1,
                overall: 0,
                checkedAt: null,
                latestSite: zeroSite,
              }
            : item,
        ),
        individualRun: {
          url: standardUrl,
          domain: zeroSite.domain,
          status: "running",
          startedAt: new Date().toISOString(),
        },
      }));
      notify(`Score check started for ${zeroSite.domain}`);
    } catch (error) {
      notify(error.message || "Unable to start this website score check");
    }
  }

  async function toggleAutoSendAfterCheck() {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to change email delivery");
    if (scoreCheckBusy) return;
    const next = !autoSendAfterCheck;
    setAutoSendAfterCheck(next);
    localStorage.setItem("benchmark-auto-send-after-check", String(next));
    try {
      const response = await fetch("/api/email-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: emailRecipients,
          schedule: emailSchedule,
          time: emailTime,
          day: emailDay,
          enabled: true,
          autoSendAfterCheck: next,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Unable to save Auto-Send Email");
      notify(
        next
          ? "Auto-Send Email enabled for completed score checks"
          : "Auto-Send Email disabled; reports can be reviewed and sent manually",
      );
    } catch (error) {
      setAutoSendAfterCheck(!next);
      localStorage.setItem("benchmark-auto-send-after-check", String(!next));
      notify(error.message || "Unable to save Auto-Send Email");
    }
  }

  function saveEmailDelivery() {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to change email delivery");
    const recipients = [...emailRecipients];
    if (emailRecipient.trim()) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRecipient.trim()))
        return notify("Enter a valid recipient email address");
      if (!recipients.includes(emailRecipient.trim().toLowerCase()))
        recipients.push(emailRecipient.trim().toLowerCase());
    }
    if (!recipients.length)
      return notify("Add at least one recipient email address");
    setEmailRecipients(recipients);
    setEmailRecipient("");
    localStorage.setItem(
      "benchmark-email-recipients",
      JSON.stringify(recipients),
    );
    localStorage.setItem("benchmark-email-schedule", emailSchedule);
    localStorage.setItem("benchmark-email-time", emailTime);
    localStorage.setItem("benchmark-email-day", emailDay);
    localStorage.setItem("benchmark-email-report-type", emailReportType);
    const canAutomate = emailStatus.verified;
    localStorage.setItem("benchmark-email-enabled", String(canAutomate));
    setEmailEnabled(canAutomate);
    persistEmailSettings(recipients, {
      schedule: emailSchedule,
      time: emailTime,
      day: emailDay,
      reportType: emailReportType,
      weeklyHistoryEnabled: true,
    });
    notify(
      canAutomate
        ? "Recipients and daily/Sunday report schedules saved"
        : "Recipients and report schedules saved",
    );
  }

  function selectEmailReportType(value) {
    const next = value === "history" ? "history" : "benchmark";
    setEmailReportType(next);
    localStorage.setItem("benchmark-email-report-type", next);
    persistEmailSettings(emailRecipients, {
      reportType: next,
      weeklyHistoryEnabled: true,
    });
  }

  function updateHistoryEmailRange(type, value) {
    if (type === "from") {
      setHistoryEmailFrom(value);
      localStorage.setItem("benchmark-history-email-from", value);
    } else {
      setHistoryEmailTo(value);
      localStorage.setItem("benchmark-history-email-to", value);
    }
  }

  function addEmailRecipient() {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to manage recipients");
    const value = emailRecipient.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return notify("Enter a valid recipient email address");
    if (emailRecipients.includes(value))
      return notify("This email address is already saved");
    const next = [...emailRecipients, value];
    setEmailRecipients(next);
    setEmailRecipient("");
    localStorage.setItem("benchmark-email-recipients", JSON.stringify(next));
    persistEmailSettings(next);
    notify("Recipient added");
  }

  function removeEmailRecipient(value) {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to manage recipients");
    const next = emailRecipients.filter((item) => item !== value);
    setEmailRecipients(next);
    localStorage.setItem("benchmark-email-recipients", JSON.stringify(next));
    persistEmailSettings(next);
    if (!next.length) {
      setEmailEnabled(false);
      localStorage.setItem("benchmark-email-enabled", "false");
    }
    notify("Recipient removed");
  }

  function openGmailDraft() {
    if (!permissions.canSendEmail)
      return notify("You do not have permission to send email reports");
    const recipients = [...manualRecipients];
    if (!recipients.length)
      return notify("Add at least one recipient email address");
    if (emailReportType === "history") {
      if (!history.length)
        return notify("No Score History Report is available yet");
      if (
        historyEmailFrom &&
        historyEmailTo &&
        historyEmailFrom > historyEmailTo
      )
        return notify("The From date must be before the To date");
      if (!historyEmailRecords.length)
        return notify(
          "No score history is available in the selected date range",
        );
      const summary = historyEmailDates
        .map(
          (dateKey) =>
            `${historyDateLabel(dateKey)}\n${historyDomains
              .map((domain) =>
                ["Mobile", "Web"]
                  .map((device) => {
                    const record = historyEmailLookup.get(
                      `${dateKey}|${domain}|${device}`,
                    );
                    return `${domain} ${device === "Web" ? "Desktop" : device}: ${historyMetrics.map(([label, key]) => `${label} ${record?.[key] ?? "N/A"}`).join(" | ")}`;
                  })
                  .join("\n"),
              )
              .join("\n")}`,
        )
        .join("\n\n");
      const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${encodeURIComponent([...new Set(recipients)].join(","))}&su=${encodeURIComponent("Website Score History Report")}&body=${encodeURIComponent(`Website Score History Report\n\n${summary}`)}`;
      window.open(composeUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (!comparisonSites.length)
      return notify("Run at least one website scan first");
    const reportLines = comparisonSites.map((site) => {
      const categoryLines = metrics.map(
        ([key, label]) =>
          `${label}: Mobile ${deviceScore(site, "mobile", key) ?? "—"} | Web ${deviceScore(site, "desktop", key) ?? "—"}`,
      );
      return `${site.domain}\nOverall score: ${site.overall}/100\n${categoryLines.join("\n")}`;
    });
    const body = [
      "Mobile and Web Benchmark Matrix",
      "",
      ...reportLines.flatMap((line) => [line, ""]),
    ].join("\n");
    const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${encodeURIComponent([...new Set(recipients)].join(","))}&su=${encodeURIComponent(`Mobile and Web benchmark matrix — ${comparisonSites.length} websites`)}&body=${encodeURIComponent(body)}`;
    window.open(composeUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="matrix-app">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">stc</span>
          <div>
            <strong>Website benchmark</strong>
            <span>Competitor intelligence</span>
          </div>
        </div>
        <div className="sidebar-label">Dashboard</div>
        <nav aria-label="Dashboard screens">
          {allowedSections.includes("overview") && (
            <button
              className={view === "overview" ? "active" : ""}
              onClick={() => setView("overview")}
            >
              <Gauge size={18} />
              <span>Benchmark overview</span>
            </button>
          )}
          {allowedSections.includes("history") && (
            <button
              className={view === "history" ? "active" : ""}
              onClick={() => setView("history")}
            >
              <History size={18} />
              <span>Score history</span>
              <b>{history.length}</b>
            </button>
          )}
          {allowedSections.includes("ppt") && (
            <button
              className={view === "ppt" ? "active" : ""}
              onClick={() => setView("ppt")}
            >
              <Presentation size={18} />
              <span>PPT Report</span>
            </button>
          )}
          {allowedSections.includes("findings") && (
            <button
              className={view === "findings" ? "active" : ""}
              onClick={() => setView("findings")}
            >
              <AlertTriangle size={18} />
              <span>Audit findings</span>
              <b>{issues.length}</b>
            </button>
          )}
          {allowedSections.includes("emails") && (
            <button
              className={view === "emails" ? "active" : ""}
              onClick={() => setView("emails")}
            >
              <Mail size={18} />
              <span>Emails to send</span>
            </button>
          )}
          {allowedSections.includes("admin") && (
            <button
              className={view === "admin" ? "active" : ""}
              onClick={() => setView("admin")}
            >
              <Users size={18} />
              <span>Access management</span>
            </button>
          )}
        </nav>
        <div className="sidebar-account">
          <i>{currentUser.username.slice(0, 1).toUpperCase()}</i>
          <span>
            <strong>{currentUser.username}</strong>
            <small>
              {currentUser.role === "admin"
                ? "Administrator"
                : "Dashboard user"}
            </small>
          </span>
          <button onClick={onLogout} title="Sign out">
            <LogOut size={15} />
          </button>
        </div>
        <div className="sidebar-source">
          <i></i>
          <span>
            <strong>Google PageSpeed</strong>
            <small>
              {automation.hostingMode === "static-snapshot"
                ? "Saved audit snapshot"
                : "Live audit source"}
            </small>
          </span>
        </div>
      </aside>

      <div className="dashboard-body">
        <header className="matrix-topbar">
          <div className="page-context">
            <span>STC Kuwait digital intelligence</span>
            <strong>
              {view === "overview"
                ? "Benchmark overview"
                : view === "history"
                  ? "Score history"
                  : view === "ppt"
                    ? "PPT Report"
                    : view === "findings"
                      ? "Audit findings"
                      : view === "admin"
                        ? "Access management"
                        : "Emails to send"}
            </strong>
          </div>
          <div className="top-status">
            <i></i>
            {automation.hostingMode === "static-snapshot"
              ? "Saved PageSpeed data"
              : "Google PageSpeed live"}
          </div>
          <div className="report-actions">
            {permissions.canDownload && (
              <button onClick={downloadHistoryExcel}>
                <Download size={16} />
                Excel history
              </button>
            )}
            {permissions.canDownload && (
              <button
                className="primary"
                onClick={() =>
                  sites.length
                    ? window.print()
                    : notify("No benchmark results to export")
                }
              >
                <FileText size={16} />
                PDF report
              </button>
            )}
            <button className="account-logout" onClick={onLogout}>
              <LogOut size={15} />
              Sign out
            </button>
          </div>
        </header>

        <main className="matrix-main">
          <div className={`view-screen ${view === "overview" ? "active" : ""}`}>
            <section className="standard-monitor">
              <div className="standard-monitor-head">
                <div>
                  <span>Automated standard monitoring</span>
                  <h1>Six websites. One complete score check.</h1>
                  <p>
                    PageSpeed checks run in bounded parallel batches. Every
                    failed website receives one Lighthouse fallback, while Zain
                    remains the final website tested.
                  </p>
                </div>
                <div className="automation-actions">
                  <span className="next-run">
                    Next automatic run
                    <strong>{checkedTime(automation.nextRunAt)}</strong>
                  </span>
                  {permissions.canSendEmail && (
                    <label
                      className={`auto-send-toggle ${autoSendAfterCheck ? "enabled" : ""}`}
                      title={
                        autoSendAfterCheck
                          ? "The completed report will be emailed to all saved recipients"
                          : "The completed report will wait for manual review"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={autoSendAfterCheck}
                        onChange={toggleAutoSendAfterCheck}
                        disabled={scoreCheckBusy}
                      />
                      <span aria-hidden="true">
                        <i></i>
                      </span>
                      <b>
                        Auto-Send Email
                        <small>
                          {autoSendAfterCheck ? "Enabled" : "Disabled"}
                        </small>
                      </b>
                    </label>
                  )}
                  <button onClick={runStandardCheck} disabled={scoreCheckBusy}>
                    {automation.status === "running" ? (
                      <RefreshCw className="spin" size={17} />
                    ) : (
                      <Gauge size={17} />
                    )}{" "}
                    {automation.status === "running"
                      ? `Checking ${automation.progress?.filter((item) => item.status === "complete").length || 0}/6`
                      : individualActiveUrl
                        ? "Website check running"
                        : "Check Score Now"}
                  </button>
                </div>
              </div>
              <div
                className={`automation-status ${individualActiveUrl ? "running" : automation.status || "idle"}`}
              >
                {individualActiveUrl || automation.status === "running" ? (
                  <RefreshCw className="spin" size={15} />
                ) : automation.status === "failed" ? (
                  <AlertTriangle size={15} />
                ) : (
                  <Check size={15} />
                )}
                <span>
                  {individualActiveUrl
                    ? `Rechecking ${new URL(individualActiveUrl).hostname.replace(/^www\./, "")}. Only this website is reset; the other scores remain available.`
                    : automation.status === "running"
                      ? automation.phase === "zain-lighthouse-retry"
                        ? "The first report was processed without Zain. Zain is receiving its single Lighthouse retry; an updated email will be sent only if it succeeds."
                        : automation.phase === "primary-lighthouse-fallback"
                          ? "PageSpeed checks are complete. Failed websites are receiving one bounded Lighthouse fallback before Zain runs last."
                          : automation.phase === "primary-pagespeed-recovery"
                            ? "Incomplete primary websites are receiving one final bounded PageSpeed recovery pass. Existing Mobile or Desktop results are preserved and merged."
                            : automation.phase === "primary-lighthouse-recovery"
                              ? "Only the remaining incomplete device columns are receiving a final Lighthouse recovery within the 18-minute limit."
                          : automation.phase === "zain-pagespeed"
                            ? "The five primary websites have finished their PageSpeed and Lighthouse checks. Zain is now running last through PageSpeed."
                        : automation.phase === "initial-report"
                          ? "Zain failed in PageSpeed and the first report is being sent without Zain data."
                          : `Scores started at zero and the primary websites are being checked two at a time with Zain last. ${autoSendAfterCheck ? "The daily report will be emailed to all saved recipients even when a website fails." : "The completed manual report will be held for review."}`
                      : automation.status === "failed"
                        ? `${automation.error || "The automated process failed unexpectedly."} Review the saved stage details and email status.`
                        : automation.lastCompletedAt
                          ? `${automation.warning ? `${automation.warning} ` : ""}Last completed run: ${checkedTime(automation.lastCompletedAt)} · Email ${automation.emailStatus?.status || "not sent"}${automation.emailStatus?.message ? ` — ${automation.emailStatus.message}` : ""}`
                          : "Ready for the first complete six-site score check."}
                </span>
              </div>
              <div className="standard-url-grid">
                {orderWebsites(automation.standardUrls || []).map((standardUrl, index) => {
                  const domain = new URL(standardUrl).hostname.replace(
                    /^www\./,
                    "",
                  );
                  const site = sites.find(
                    (item) =>
                      item.standardUrl === standardUrl ||
                      item.domain === domain,
                  );
                  const progress = automation.progress?.find(
                    (item) => item.url === standardUrl,
                  );
                  const displayOverall =
                    typeof progress?.overall === "number"
                      ? progress.overall
                      : site?.overall;
                  const displayCheckedAt =
                    progress?.checkedAt || site?.scannedAt;
                  return (
                    <article
                      key={standardUrl}
                      className={progress?.status || ""}
                    >
                      <i style={{ background: colorForDomain(domain) }}>
                        {index + 1}
                      </i>
                      <div>
                        <strong>{domain}</strong>
                        <small title={standardUrl}>{standardUrl}</small>
                        <em>
                          <Clock3 size={11} />
                          Last checked: {checkedTime(displayCheckedAt)}
                        </em>
                        <button
                          type="button"
                          className="card-scan-action"
                          onClick={() => runIndividualCheck(standardUrl)}
                          disabled={scoreCheckBusy}
                          aria-label={`Check score now for ${domain}`}
                        >
                          {individualActiveUrl === standardUrl ? (
                            <RefreshCw className="spin" size={11} />
                          ) : (
                            <Gauge size={11} />
                          )}{" "}
                          {individualActiveUrl === standardUrl
                            ? "Checking…"
                            : "Check Score Now"}
                        </button>
                      </div>
                      <b
                        className={
                          typeof displayOverall === "number"
                            ? scoreTone(displayOverall)
                            : ""
                        }
                      >
                        {displayOverall ?? "—"}
                      </b>
                      {progress?.status === "scanning" && (
                        <RefreshCw className="spin card-progress" size={14} />
                      )}
                      {progress?.status === "failed" && (
                        <AlertTriangle className="card-progress" size={14} />
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="workspace-stats" aria-label="Workspace summary">
              <div>
                <span>Workspace average</span>
                <strong>
                  {average ?? "—"}
                  <small>{average !== null && "/100"}</small>
                </strong>
              </div>
              <div>
                <span>Websites compared</span>
                <strong>{sites.length}</strong>
              </div>
              <div>
                <span>Total findings</span>
                <strong>{issues.length}</strong>
              </div>
              <div>
                <span>Critical + high</span>
                <strong className="danger-number">
                  {severityCounts[0].count + severityCounts[1].count}
                </strong>
              </div>
            </section>

            {sites.length > 0 && (
              <section className="site-ribbon">
                {sites.map((site) => {
                  const siteIssues = issues.filter(
                    (issue) => issue.site === site.domain,
                  );
                  return (
                    <button
                      key={site.id}
                      className={selectedSite === site.domain ? "selected" : ""}
                      onClick={() => {
                        setSelectedSite(site.domain);
                        setIssueSite(site.domain);
                      }}
                    >
                      <i style={{ background: colorForDomain(site.domain) }}>
                        {site.domain[0].toUpperCase()}
                      </i>
                      <span>
                        <strong>{site.domain}</strong>
                        <small>
                          <Clock3 size={11} />
                          {relativeTime(site.scannedAt)} · {siteIssues.length}{" "}
                          issues
                        </small>
                      </span>
                      <b className={scoreTone(site.overall)}>{site.overall}</b>
                    </button>
                  );
                })}
              </section>
            )}

            <section className="matrix-panel">
              <div className="section-head">
                <div>
                  <span>Score comparison</span>
                  <h2>Mobile and Web benchmark matrix</h2>
                </div>
                <p>
                  <Smartphone size={14} />
                  Mobile <Monitor size={14} />
                  Web <small>90+ strong · 50–89 improve · below 50 poor</small>
                </p>
              </div>
              {comparisonSites.length ? (
                <div className="matrix-scroll matrix-groups">
                  {comparisonGroups.map((group, groupIndex) => (
                    <div
                      className="matrix-group"
                      key={`matrix-group-${groupIndex}`}
                    >
                      <div className="matrix-group-label">
                        Websites {groupIndex * 3 + 1}–
                        {groupIndex * 3 + group.length}
                      </div>
                      <div
                        className="score-matrix"
                        style={{
                          gridTemplateColumns: `170px repeat(${group.length}, minmax(190px, 1fr))`,
                        }}
                      >
                        <div className="matrix-corner">Audit category</div>
                        {group.map((site, index) => (
                          <div className="matrix-site" key={site.id}>
                            <i
                              style={{
                                background: colorForDomain(site.domain),
                              }}
                            ></i>
                            <span>
                              {site.domain}
                              <small>
                                {groupIndex === 0 && index === 0
                                  ? "Primary website"
                                  : "Competitor"}
                              </small>
                            </span>
                            <b>
                              {typeof site.overall === "number"
                                ? site.overall
                                : "—"}
                            </b>
                          </div>
                        ))}
                        {metrics.map(([key, label, Icon]) => (
                          <div className="matrix-row" key={key}>
                            <div className="metric-label">
                              <Icon size={17} />
                              <span>
                                {label}
                                <small>0–100 score</small>
                              </span>
                            </div>
                            {group.map((site) => (
                              <div
                                className="dual-score"
                                key={`${site.id}-${key}`}
                              >
                                {[
                                  ["mobile", Smartphone, "Mobile"],
                                  ["desktop", Monitor, "Web"],
                                ].map(([device, DeviceIcon, deviceLabel]) => {
                                  const value = deviceScore(site, device, key);
                                  return (
                                    <div
                                      key={device}
                                      className={
                                        value == null
                                          ? "missing"
                                          : scoreTone(value)
                                      }
                                      title={
                                        value == null
                                          ? `Waiting for complete ${deviceLabel} ${label} score`
                                          : `${deviceLabel} ${label}: ${value}`
                                      }
                                    >
                                      <DeviceIcon size={14} />
                                      <span>{deviceLabel}</span>
                                      <strong>{value ?? "—"}</strong>
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-matrix">
                  <Gauge size={30} />
                  <strong>Your comparison matrix is ready</strong>
                  <span>
                    Add your website and competitors above to generate live
                    scores.
                  </span>
                </div>
              )}
            </section>
          </div>

          <div
            className={`view-screen history-screen ${view === "history" ? "active" : ""}`}
          >
            <section className="history-hero">
              <div>
                <span>Long-term score tracking</span>
                <h1>Website score history</h1>
                <p>
                  Review imported desktop history and every automatic Mobile and
                  Web snapshot, then download the complete Excel workbook
                  whenever required.
                </p>
              </div>
              {permissions.canDownload && (
                <button onClick={downloadHistoryExcel}>
                  <Download size={16} />
                  Download Excel history
                </button>
              )}
            </section>

            <section className="history-kpis">
              <div>
                <span>History records</span>
                <strong>{history.length}</strong>
                <small>Imported and automatic rows</small>
              </div>
              <div>
                <span>Websites tracked</span>
                <strong>{historySites.length}</strong>
                <small>Ordered competitor set</small>
              </div>
              <div>
                <span>Mobile records</span>
                <strong>
                  {
                    history.filter((record) => record.device === "Mobile")
                      .length
                  }
                </strong>
                <small>Automatic Mobile</small>
              </div>
              <div>
                <span>Web records</span>
                <strong>
                  {history.filter((record) => record.device === "Web").length}
                </strong>
                <small>Imported and automatic Desktop</small>
              </div>
              <div>
                <span>Latest history</span>
                <strong className="history-latest">
                  {checkedTime(history[0]?.checkedAt)}
                </strong>
                <small>Asia/Kuwait time</small>
              </div>
            </section>

            <section className="history-panel">
              <div className="history-toolbar">
                <div>
                  <span>Excel-style score archive</span>
                  <h2>Six-website history comparison</h2>
                  <p>
                    Each row is one Kuwait calendar date. Scroll horizontally to
                    compare every domain.
                  </p>
                </div>
                <div>
                  <label>
                    Device view
                    <select
                      value={historyDevice}
                      onChange={(event) => setHistoryDevice(event.target.value)}
                    >
                      <option value="All">Mobile + Desktop</option>
                      <option>Mobile</option>
                      <option value="Web">Desktop</option>
                    </select>
                  </label>
                </div>
              </div>
              {historyDates.length ? (
                <div className="history-matrix-scroll">
                  <table className="history-sheet">
                    <thead>
                      <tr className="history-domain-row">
                        <th className="history-date-head" rowSpan="3">
                          Date
                        </th>
                        {historyDomains.map((domain) => (
                          <th
                            colSpan={
                              historyDevices.length * historyMetrics.length + 2
                            }
                            style={{
                              "--history-domain-color": colorForDomain(domain),
                            }}
                            key={domain}
                          >
                            <strong>{domain}</strong>
                            <small>{websiteLabels[domain] || domain}</small>
                          </th>
                        ))}
                      </tr>
                      <tr className="history-device-row">
                        {historyDomains.map((domain) => (
                          <Fragment key={domain}>
                            {historyDevices.map((device) => (
                              <th
                                colSpan={historyMetrics.length}
                                style={{
                                  "--history-domain-color":
                                    colorForDomain(domain),
                                }}
                                key={`${domain}-${device}`}
                              >
                                {device === "Web" ? (
                                  <Monitor size={12} />
                                ) : (
                                  <Smartphone size={12} />
                                )}{" "}
                                {device === "Web" ? "Desktop" : "Mobile"}
                              </th>
                            ))}
                            <th
                              colSpan="2"
                              style={{
                                "--history-domain-color":
                                  colorForDomain(domain),
                              }}
                            >
                              Audit details
                            </th>
                          </Fragment>
                        ))}
                      </tr>
                      <tr className="history-metric-row">
                        {historyDomains.map((domain) => (
                          <Fragment key={domain}>
                            {historyDevices.flatMap((device) =>
                              historyMetrics.map(([label]) => (
                                <th
                                  style={{
                                    "--history-domain-color":
                                      colorForDomain(domain),
                                  }}
                                  key={`${domain}-${device}-${label}`}
                                >
                                  {label}
                                </th>
                              )),
                            )}
                            <th
                              style={{
                                "--history-domain-color":
                                  colorForDomain(domain),
                              }}
                            >
                              Checked date &amp; time
                            </th>
                            <th
                              style={{
                                "--history-domain-color":
                                  colorForDomain(domain),
                              }}
                            >
                              Source URL
                            </th>
                          </Fragment>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {historyDates.map((dateKey) => (
                        <tr key={dateKey}>
                          <th className="history-date-cell">
                            {historyDateLabel(dateKey)}
                          </th>
                          {historyDomains.map((domain) => {
                            const records = historyDevices
                              .map((device) =>
                                historyLookup.get(
                                  `${dateKey}|${domain}|${device}`,
                                ),
                              )
                              .filter(Boolean);
                            const auditRecord = [...records].sort(
                              (a, b) =>
                                new Date(b.checkedAt) - new Date(a.checkedAt),
                            )[0];
                            return (
                              <Fragment key={`${dateKey}-${domain}`}>
                                {historyDevices.flatMap((device) => {
                                  const record = historyLookup.get(
                                    `${dateKey}|${domain}|${device}`,
                                  );
                                  return historyMetrics.map(([label, key]) => {
                                    const value = record?.[key];
                                    return (
                                      <td
                                        className={
                                          typeof value === "number"
                                            ? `history-score ${scoreTone(value)}`
                                            : "history-score missing"
                                        }
                                        title={`${domain} · ${device === "Web" ? "Desktop" : device} · ${label}`}
                                        key={`${dateKey}-${domain}-${device}-${key}`}
                                      >
                                        {typeof value === "number"
                                          ? value
                                          : "N/A"}
                                      </td>
                                    );
                                  });
                                })}
                                <td className="history-audit-cell">
                                  {historyCheckedTime(auditRecord)}
                                </td>
                                <td className="history-source-cell">
                                  {auditRecord?.url ? (
                                    <a
                                      href={auditRecord.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={auditRecord.url}
                                    >
                                      {auditRecord.url}
                                    </a>
                                  ) : (
                                    "N/A"
                                  )}
                                </td>
                              </Fragment>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="history-empty">
                  <History size={28} />
                  <strong>No completed score history yet</strong>
                  <span>
                    Run Check Score Now. Every successfully completed Mobile and
                    Desktop result will be retained here.
                  </span>
                </div>
              )}
            </section>
          </div>

          <div
            className={`view-screen ppt-screen ${view === "ppt" ? "active" : ""}`}
          >
            {allowedSections.includes("ppt") && (
              <PptReport
                history={history}
                domains={historyDomains}
                labels={websiteLabels}
                canDownload={permissions.canDownload}
                notify={notify}
              />
            )}
          </div>

          <div
            className={`view-screen findings-screen ${view === "findings" ? "active" : ""}`}
          >
            <section className="findings-hero">
              <div>
                <span>Technical audit command center</span>
                <h1>Audit findings</h1>
                <p>
                  Prioritize every issue across your website and competitors,
                  then move from diagnosis to recommended action.
                </p>
              </div>
              <div className="findings-hero-actions">
                {allowedSections.includes("overview") && (
                  <button onClick={() => setView("overview")}>
                    <Gauge size={16} />
                    View scores
                  </button>
                )}
                {permissions.canDownload && (
                  <button className="primary" onClick={downloadCsv}>
                    <Download size={16} />
                    Export findings
                  </button>
                )}
              </div>
            </section>

            <section className="finding-kpis">
              <div>
                <span>All open issues</span>
                <strong>{issues.length}</strong>
                <small>
                  Across {sites.length}{" "}
                  {sites.length === 1 ? "website" : "websites"}
                </small>
              </div>
              <div className="critical">
                <span>Critical</span>
                <strong>{severityCounts[0].count}</strong>
                <small>Fix immediately</small>
              </div>
              <div className="high">
                <span>High priority</span>
                <strong>{severityCounts[1].count}</strong>
                <small>Plan next</small>
              </div>
              <div>
                <span>Mobile findings</span>
                <strong>
                  {issues.filter((issue) => issue.device !== "Web").length}
                </strong>
                <small>Mobile Lighthouse</small>
              </div>
              <div>
                <span>Web findings</span>
                <strong>
                  {issues.filter((issue) => issue.device === "Web").length}
                </strong>
                <small>Desktop Lighthouse</small>
              </div>
            </section>

            {sites.length > 0 && (
              <section className="issue-site-board">
                <div className="issue-site-intro">
                  <span>Website comparison</span>
                  <strong>Where should the team focus first?</strong>
                  <small>Select a website to filter the findings below.</small>
                </div>
                {sites.map((site) => {
                  const siteIssues = issues.filter(
                    (issue) => issue.site === site.domain,
                  );
                  const urgent = siteIssues.filter(
                    (issue) =>
                      issue.severity === "Critical" ||
                      issue.severity === "High",
                  ).length;
                  return (
                    <button
                      key={site.id}
                      className={issueSite === site.domain ? "selected" : ""}
                      onClick={() =>
                        setIssueSite(
                          issueSite === site.domain ? "All" : site.domain,
                        )
                      }
                    >
                      <span>
                        <i style={{ background: colorForDomain(site.domain) }}>
                          {site.domain[0].toUpperCase()}
                        </i>
                        <b>{site.domain}</b>
                      </span>
                      <strong>
                        {siteIssues.length}
                        <small>issues</small>
                      </strong>
                      <em>{urgent} urgent</em>
                      <div>
                        <i
                          style={{
                            width: `${siteIssues.length ? (urgent / siteIssues.length) * 100 : 0}%`,
                          }}
                        ></i>
                      </div>
                    </button>
                  );
                })}
              </section>
            )}

            <section className="findings-panel">
              <div className="section-head findings-title">
                <div>
                  <span>Audit findings</span>
                  <h2>Issues and recommended actions</h2>
                </div>
                <div className="findings-tools">
                  <label>
                    <Search size={14} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search issues"
                    />
                  </label>
                  <select
                    value={issueSite}
                    onChange={(event) => setIssueSite(event.target.value)}
                  >
                    <option value="All">All websites</option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.domain}>
                        {site.domain}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="priority-tabs">
                <button
                  className={severity === "All" ? "active" : ""}
                  onClick={() => setSeverity("All")}
                >
                  All <b>{issues.length}</b>
                </button>
                {severityCounts.map((item) => (
                  <button
                    key={item.level}
                    className={severity === item.level ? "active" : ""}
                    onClick={() => setSeverity(item.level)}
                  >
                    {item.level} <b>{item.count}</b>
                  </button>
                ))}
              </div>
              <div className="findings-table">
                <div className="finding-row table-head">
                  <span>Priority & issue</span>
                  <span>Website</span>
                  <span>Device</span>
                  <span>Category</span>
                  <span>Potential gain</span>
                </div>
                {filteredIssues.map((issue) => (
                  <div className="finding-row" key={issue.id}>
                    <div className="finding-name">
                      <i className={issue.severity.toLowerCase()}></i>
                      <span>
                        <strong>{issue.title}</strong>
                        <small>{issue.detail}</small>
                        <em>{issue.action}</em>
                      </span>
                    </div>
                    <span className="site-chip">{issue.site}</span>
                    <span className="device-chip">
                      {issue.device === "Web" ? (
                        <Monitor size={13} />
                      ) : (
                        <Smartphone size={13} />
                      )}{" "}
                      {issue.device || "Mobile"}
                    </span>
                    <span>{issue.category}</span>
                    <b className="gain">{issue.impact}</b>
                  </div>
                ))}
                {!filteredIssues.length && (
                  <div className="empty-findings">
                    <ShieldCheck size={27} />
                    <strong>No matching issues</strong>
                    <span>
                      {sites.length
                        ? "Change the filters or run a fresh scan."
                        : "Audit findings will appear after your first scan."}
                    </span>
                  </div>
                )}
              </div>
            </section>
          </div>

          <div
            className={`view-screen email-screen ${view === "emails" ? "active" : ""}`}
          >
            <section className="email-hero">
              <div className="email-hero-icon">
                <Mail size={24} />
              </div>
              <div>
                <span>Automated reporting</span>
                <h1>Emails to send</h1>
                <p>
                  Choose your report, select who receives it, and review before sending.
                </p>
              </div>
              <div
                className={`email-connection ${emailStatus.verified ? "connected" : emailStatus.errorType === "ESOCKET" ? "draft-ready" : ""}`}
              >
                <i></i>
                <span>
                  <strong>
                    {emailStatus.loading
                      ? "Checking Gmail connection"
                      : emailStatus.verified
                        ? "Gmail sender connected"
                        : emailStatus.errorType === "ESOCKET"
                          ? "Gmail draft mode available"
                          : "Email service not connected"}
                  </strong>
                  <small>
                    {emailStatus.verified
                      ? emailStatus.sender
                      : emailStatus.errorType === "ESOCKET"
                        ? "Automatic SMTP is blocked; open a prepared Gmail draft instead"
                        : emailStatus.configured
                          ? "Gmail could not verify the current credentials"
                          : "Gmail SMTP credentials required"}
                  </small>
                </span>
              </div>
            </section>

            <section className="email-delivery-overview" aria-label="Email delivery summary">
              <div><Users size={20} /><span>Saved recipients<strong>{emailRecipients.length}</strong></span></div>
              <div><Send size={20} /><span>Manual delivery<strong>{manualRecipients.length} selected</strong></span></div>
              <div><CalendarClock size={20} /><span>Automatic delivery<strong>All saved recipients · 10:00 AM Kuwait</strong></span></div>
            </section>
            <section className="email-layout">
              <article className="email-setup-card">
                <div className="email-card-head">
                  <span>Prepare your email</span>
                  <h2>Who should receive this report?</h2>
                  <p>
                    Send to one person, a selected group, or everyone. Your manual selection does not change automatic delivery.
                  </p>
                </div>
                {!permissions.canSendEmail && (
                  <div className="permission-notice">
                    <LockKeyhole size={15} />
                    <span>
                      <strong>View-only email access</strong>
                      <small>
                        An Admin must grant email permission before you can
                        manage recipients, schedules, or send reports.
                      </small>
                    </span>
                  </div>
                )}
                <div className="recipient-manager">
                  <div className="manual-recipient-modes" role="group" aria-label="Manual email recipients">
                    <button type="button" aria-pressed={manualRecipientMode === "all"} onClick={() => setManualRecipientMode("all")}>All recipients</button>
                    <button type="button" aria-pressed={manualRecipientMode === "selected"} onClick={() => setManualRecipientMode("selected")}>Choose recipients</button>
                  </div>
                  <span>Add to saved recipients</span>
                  <div className="recipient-entry">
                    <div>
                      <Mail size={16} />
                      <input
                        disabled={!permissions.canSendEmail}
                        type="email"
                        value={emailRecipient}
                        onChange={(event) =>
                          setEmailRecipient(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addEmailRecipient();
                          }
                        }}
                        placeholder="name@company.com"
                      />
                    </div>
                    <button
                      disabled={!permissions.canSendEmail}
                      onClick={addEmailRecipient}
                    >
                      <UserPlus size={15} />
                      Add
                    </button>
                  </div>
                  <div className="saved-recipients">
                    <div>
                      <strong>Saved email addresses</strong>
                      <small>
                        {emailRecipients.length} recipient
                        {emailRecipients.length === 1 ? "" : "s"}
                      </small>
                    </div>
                    {emailRecipients.length ? (
                      emailRecipients.map((recipient) => (
                        <div className="recipient-row" key={recipient}>
                          <label className="recipient-choice">
                            <input type="checkbox" aria-label={`Send to ${recipient}`}
                              disabled={!permissions.canSendEmail || manualRecipientMode === "all"}
                              checked={manualRecipients.includes(recipient)}
                              onChange={(event) => setSelectedEmailRecipients((current) => event.target.checked ? [...current, recipient] : current.filter((value) => value !== recipient))} />
                            <span>{recipient}</span>
                          </label>
                          <button
                            disabled={!permissions.canSendEmail}
                            onClick={() => removeEmailRecipient(recipient)}
                            title={`Remove ${recipient}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <p>No saved recipients yet.</p>
                    )}
                  </div>
                  <p className="recipient-help">{manualRecipientMode === "all" ? "Everyone on this list will receive your manual report." : `${manualRecipients.length} selected. Tick the people who should receive this report.`}</p>
                </div>
                <div className="schedule-settings">
                  <label className="report-type-setting">
                    <span>Select Report Type</span>
                    <div>
                      <FileText size={16} />
                      <select
                        aria-label="Select Report Type"
                        value={emailReportType}
                        onChange={(event) =>
                          selectEmailReportType(event.target.value)
                        }
                      >
                        <option value="benchmark">Benchmark Report</option>
                        <option value="history">Score History Report</option>
                      </select>
                    </div>
                  </label>
                  {emailReportType === "history" && (
                    <div className="history-date-range">
                      <span>History report date range</span>
                      <div>
                        <label>
                          <small>From</small>
                          <input
                            aria-label="History report from date"
                            type="date"
                            min={historyDates[0] || ""}
                            max={historyEmailTo || historyDates.at(-1) || ""}
                            value={historyEmailFrom}
                            onInput={(event) =>
                              updateHistoryEmailRange(
                                "from",
                                event.currentTarget.value,
                              )
                            }
                          />
                        </label>
                        <label>
                          <small>To</small>
                          <input
                            aria-label="History report to date"
                            type="date"
                            min={historyEmailFrom || historyDates[0] || ""}
                            max={historyDates.at(-1) || ""}
                            value={historyEmailTo}
                            onInput={(event) =>
                              updateHistoryEmailRange(
                                "to",
                                event.currentTarget.value,
                              )
                            }
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            updateHistoryEmailRange("from", "");
                            updateHistoryEmailRange("to", "");
                          }}
                        >
                          All dates
                        </button>
                      </div>
                      <small>
                        {historyEmailDates.length} scan date
                        {historyEmailDates.length === 1 ? "" : "s"} selected ·
                        This range applies to manual email and its Excel
                        attachment.
                      </small>
                    </div>
                  )}
                  <label>
                    <span>Benchmark schedule</span>
                    <div>
                      <CalendarClock size={16} />
                      <strong>Daily complete report</strong>
                    </div>
                  </label>
                  <label>
                    <span>History schedule</span>
                    <div>
                      <History size={16} />
                      <strong>Every Sunday · previous 15 calendar days</strong>
                    </div>
                  </label>
                  <label>
                    <span>Send time</span>
                    <div>
                      <Clock3 size={16} />
                      <strong>10:00 AM</strong>
                    </div>
                  </label>
                  <small className="timezone-note">
                    Daily at {emailTime || "10:00"} · Sunday–Thursday working week ·
                    Asia/Kuwait timezone. Next Sunday history report:{" "}
                    {checkedTime(automation.nextHistoryEmailAt)}. The server
                    must stay running.
                  </small>
                </div>
                <div className="email-includes">
                  <span>
                    {emailReportType === "history"
                      ? "Score History Report includes"
                      : "Benchmark Report includes"}
                  </span>
                  <div>
                    {emailReportType === "history" ? (
                      <>
                        <b>
                          <Check size={13} />
                          Selected historical date range
                        </b>
                        <b>
                          <Check size={13} />
                          Filtered Mobile + Desktop Excel attachment
                        </b>
                      </>
                    ) : (
                      <>
                        <b>
                          <Check size={13} />
                          Overall website scores
                        </b>
                        <b>
                          <Check size={13} />
                          Four Mobile + Web category scores
                        </b>
                      </>
                    )}
                  </div>
                </div>
                <div className="email-buttons">
                  <span className="manual-send-summary">Ready to send to <strong>{manualRecipients.length} recipient{manualRecipients.length === 1 ? "" : "s"}</strong></span>
                  {emailStatus.verified ? (
                    <button
                      className="connect-email secondary"
                      onClick={() => sendEmailReport(manualRecipients.join(","))}
                      disabled={emailSending || !permissions.canSendEmail || !manualRecipients.length}
                    >
                      <Send size={16} />
                      {emailSending ? "Sending…" : manualRecipientMode === "all" ? "Send to all" : "Send to selected"}
                    </button>
                  ) : (
                    <button
                      className="connect-email secondary"
                      disabled={!permissions.canSendEmail || !manualRecipients.length}
                      onClick={openGmailDraft}
                    >
                      <Mail size={16} />
                      Open manual Gmail draft
                    </button>
                  )}
                  <button
                    className="connect-email"
                    disabled={!permissions.canSendEmail}
                    onClick={saveEmailDelivery}
                  >
                    <Check size={16} />
                    {emailEnabled ? "Schedules saved" : "Save preferences"}
                  </button>
                </div>
              </article>

              <article className="email-preview-card">
                <div className="email-card-head">
                  <span>Email preview</span>
                  <h2>
                    {emailReportType === "history"
                      ? "Website Score History Report"
                      : "Mobile and Web benchmark matrix"}
                  </h2>
                  <p>
                    {emailReportType === "history"
                      ? "The email preview and Excel attachment include only the selected date range."
                      : "The email contains this score comparison only."}
                  </p>
                </div>
                {emailReportType === "history" ? (
                  historyEmailDates.length ? (
                    <div className="history-email-preview">
                      <section className="history-kpis email-history-kpis">
                        <div>
                          <span>History records</span>
                          <strong>{historyEmailRecords.length}</strong>
                          <small>Mobile and Web rows</small>
                        </div>
                        <div>
                          <span>Websites tracked</span>
                          <strong>{historyEmailSites.length}</strong>
                          <small>Selected period</small>
                        </div>
                        <div>
                          <span>Mobile records</span>
                          <strong>
                            {
                              historyEmailRecords.filter(
                                (record) => record.device === "Mobile",
                              ).length
                            }
                          </strong>
                          <small>Google PageSpeed Mobile</small>
                        </div>
                        <div>
                          <span>Web records</span>
                          <strong>
                            {
                              historyEmailRecords.filter(
                                (record) => record.device === "Web",
                              ).length
                            }
                          </strong>
                          <small>Google PageSpeed Web</small>
                        </div>
                        <div>
                          <span>Latest history</span>
                          <strong className="history-latest">
                            {historyCheckedTime(historyEmailLatest)}
                          </strong>
                          <small>Asia/Kuwait time</small>
                        </div>
                      </section>
                      <div className="history-preview-heading">
                        <span>Excel-style score archive</span>
                        <h3>Six-website history comparison</h3>
                        <p>
                          {historyEmailDates.length} selected scan date
                          {historyEmailDates.length === 1 ? "" : "s"} · Mobile
                          and Desktop scores, audit time, and source URL.
                        </p>
                      </div>
                      <div className="history-matrix-scroll">
                        <table className="history-sheet">
                          <thead>
                            <tr className="history-domain-row">
                              <th className="history-date-head" rowSpan="3">
                                Date
                              </th>
                              {historyDomains.map((domain) => (
                                <th
                                  colSpan={historyMetrics.length * 2 + 2}
                                  style={{
                                    "--history-domain-color":
                                      colorForDomain(domain),
                                  }}
                                  key={domain}
                                >
                                  <strong>{domain}</strong>
                                  <small>
                                    {websiteLabels[domain] || domain}
                                  </small>
                                </th>
                              ))}
                            </tr>
                            <tr className="history-device-row">
                              {historyDomains.map((domain) => (
                                <Fragment key={domain}>
                                  <th
                                    colSpan={historyMetrics.length}
                                    style={{
                                      "--history-domain-color":
                                        colorForDomain(domain),
                                    }}
                                  >
                                    <Smartphone size={12} /> Mobile
                                  </th>
                                  <th
                                    colSpan={historyMetrics.length}
                                    style={{
                                      "--history-domain-color":
                                        colorForDomain(domain),
                                    }}
                                  >
                                    <Monitor size={12} /> Desktop
                                  </th>
                                  <th
                                    colSpan="2"
                                    style={{
                                      "--history-domain-color":
                                        colorForDomain(domain),
                                    }}
                                  >
                                    Audit details
                                  </th>
                                </Fragment>
                              ))}
                            </tr>
                            <tr className="history-metric-row">
                              {historyDomains.map((domain) => (
                                <Fragment key={domain}>
                                  {["Mobile", "Web"].flatMap((device) =>
                                    historyMetrics.map(([label]) => (
                                      <th
                                        style={{
                                          "--history-domain-color":
                                            colorForDomain(domain),
                                        }}
                                        key={`${domain}-${device}-${label}`}
                                      >
                                        {label}
                                      </th>
                                    )),
                                  )}
                                  <th
                                    style={{
                                      "--history-domain-color":
                                        colorForDomain(domain),
                                    }}
                                  >
                                    Checked date &amp; time
                                  </th>
                                  <th
                                    style={{
                                      "--history-domain-color":
                                        colorForDomain(domain),
                                    }}
                                  >
                                    Source URL
                                  </th>
                                </Fragment>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {historyEmailDates.map((dateKey) => (
                              <tr key={dateKey}>
                                <th className="history-date-cell">
                                  {historyDateLabel(dateKey)}
                                </th>
                                {historyDomains.map((domain) => {
                                  const records = ["Mobile", "Web"]
                                    .map((device) =>
                                      historyEmailLookup.get(
                                        `${dateKey}|${domain}|${device}`,
                                      ),
                                    )
                                    .filter(Boolean);
                                  const auditRecord = [...records].sort(
                                    (a, b) =>
                                      new Date(b.checkedAt) -
                                      new Date(a.checkedAt),
                                  )[0];
                                  return (
                                    <Fragment key={`${dateKey}-${domain}`}>
                                      {["Mobile", "Web"].flatMap((device) => {
                                        const record = historyEmailLookup.get(
                                          `${dateKey}|${domain}|${device}`,
                                        );
                                        return historyMetrics.map(
                                          ([label, key]) => {
                                            const value = record?.[key];
                                            return (
                                              <td
                                                className={
                                                  typeof value === "number"
                                                    ? `history-score ${scoreTone(value)}`
                                                    : "history-score missing"
                                                }
                                                title={`${domain} · ${device === "Web" ? "Desktop" : device} · ${label}`}
                                                key={`${dateKey}-${domain}-${device}-${key}`}
                                              >
                                                {typeof value === "number"
                                                  ? value
                                                  : "N/A"}
                                              </td>
                                            );
                                          },
                                        );
                                      })}
                                      <td className="history-audit-cell">
                                        {historyCheckedTime(auditRecord)}
                                      </td>
                                      <td className="history-source-cell">
                                        {auditRecord?.url ? (
                                          <a
                                            href={auditRecord.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            title={auditRecord.url}
                                          >
                                            {auditRecord.url}
                                          </a>
                                        ) : (
                                          "N/A"
                                        )}
                                      </td>
                                    </Fragment>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    <div className="email-empty">
                      No score history is available in the selected date range.
                    </div>
                  )
                ) : comparisonSites.length ? (
                  <div className="email-preview-groups">
                    {comparisonGroups.map((group, groupIndex) => (
                      <div
                        className="email-matrix-scroll"
                        key={`email-group-${groupIndex}`}
                      >
                        <div className="email-preview-group-label">
                          Websites {groupIndex * 3 + 1}–
                          {groupIndex * 3 + group.length}
                        </div>
                        <div
                          className="email-preview-matrix"
                          style={{
                            gridTemplateColumns: `125px repeat(${group.length}, minmax(180px,1fr))`,
                          }}
                        >
                          <div className="email-matrix-corner">
                            Audit category
                          </div>
                          {group.map((site) => (
                            <div className="email-matrix-site" key={site.id}>
                              <span>
                                <i
                                  style={{
                                    background: colorForDomain(site.domain),
                                  }}
                                ></i>
                                <strong>{site.domain}</strong>
                              </span>
                              <b>
                                {typeof site.overall === "number"
                                  ? site.overall
                                  : "—"}
                              </b>
                            </div>
                          ))}
                          {metrics.map(([key, label]) => (
                            <div className="email-matrix-row" key={key}>
                              <div className="email-metric-name">
                                {label}
                                <small>0–100 score</small>
                              </div>
                              {group.map((site) => (
                                <div
                                  className="email-dual-score"
                                  key={`${site.id}-${key}`}
                                >
                                  <span
                                    className={
                                      deviceScore(site, "mobile", key) == null
                                        ? "missing"
                                        : scoreTone(
                                            deviceScore(site, "mobile", key),
                                          )
                                    }
                                  >
                                    Mobile{" "}
                                    <b>
                                      {deviceScore(site, "mobile", key) ?? "—"}
                                    </b>
                                  </span>
                                  <span
                                    className={
                                      deviceScore(site, "desktop", key) == null
                                        ? "missing"
                                        : scoreTone(
                                            deviceScore(site, "desktop", key),
                                          )
                                    }
                                  >
                                    Web{" "}
                                    <b>
                                      {deviceScore(site, "desktop", key) ?? "—"}
                                    </b>
                                  </span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="email-empty">
                    Run a website scan to build the report preview.
                  </div>
                )}
              </article>
            </section>
          </div>
          <div
            className={`view-screen admin-screen ${view === "admin" ? "active" : ""}`}
          >
        {allowedSections.includes("admin") && (
          <AdminAccessScreen currentUser={currentUser} />
        )}
          </div>
        </main>
      </div>
      {toast && (
        <div className="toast">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState({
    loading: true,
    user: null,
    permissions: null,
  });

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (active)
          setAuth({
            loading: false,
            user: result?.user || null,
            permissions: result?.permissions || null,
          });
      })
      .catch(() => {
        if (active) setAuth({ loading: false, user: null, permissions: null });
      });
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* local session is still cleared below */
    }
    setAuth({ loading: false, user: null, permissions: null });
  }

  if (auth.loading)
    return (
      <div className="auth-loading">
        <span className="auth-logo">stc</span>
        <RefreshCw className="spin" size={20} />
        <strong>Securing your workspace…</strong>
      </div>
    );
  if (!auth.user)
    return (
      <LoginScreen
        onAuthenticated={(result) =>
          setAuth({
            loading: false,
            user: result.user,
            permissions: result.permissions,
          })
        }
      />
    );
  return (
    <DashboardApp
      currentUser={auth.user}
      permissions={auth.permissions}
      onLogout={signOut}
    />
  );
}

export default App;
