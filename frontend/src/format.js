// Formats a countdown duration (in whole seconds) for display — used for
// rate-limit lockout messages (PIN login, Back Office login). Compact for
// sub-minute durations, "Nm" / "Nm Ss" once a minute or more remains.
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}
