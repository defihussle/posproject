import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// The Back Office shortcut launches at /backoffice.html rather than
// /backoffice, deliberately: a real file resolves even on a host whose SPA
// rewrite hasn't been configured, so the icon can't be broken by a missing
// dashboard rule. The router only knows /backoffice, so normalise the path
// before it mounts — replaceState, so this never adds a history entry or
// reloads the standalone window.
if (window.location.pathname === "/backoffice.html") {
  window.history.replaceState(
    null,
    "",
    "/backoffice" + window.location.search + window.location.hash
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
