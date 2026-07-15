// Backend API base URL — set via VITE_API_URL (e.g. in frontend/.env.local
// for dev, or as a Render Static Site env var in production). Falls back to
// the local dev backend so `npm run dev` keeps working with no setup.
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
