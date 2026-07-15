// Backend API base URL — set via VITE_API_URL (e.g. in frontend/.env.local
// for dev, or as a Render Static Site env var in production). Falls back to
// the local dev backend so `npm run dev` keeps working with no setup.
//
// Trailing slash stripped defensively: every call site builds URLs as
// `${API_URL}/api/...`, so a value like "https://host.com/" (trailing slash
// left in by mistake, e.g. typo'd into a Render env var) would produce a
// double slash that Express won't route, 404ing every single request. This
// happened in production once — stripping it here means a mistyped env var
// can't break the whole app again, regardless of what gets entered.
export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/+$/, "");
