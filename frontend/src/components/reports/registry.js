import SalesSummaryReport from "./SalesSummaryReport";
import TransactionLogReport from "./TransactionLogReport";
import DiscountReport from "./DiscountReport";
import LaborReport from "./LaborReport";

// ============================================================
// Reports registry — the SINGLE source of truth for the Reports section.
// Drives BOTH the sidebar dropdown items (BackOffice.jsx) AND the nested routes
// under /backoffice/reports/* (each report is its own URL). Add a report here
// — e.g. the Refunds Report — and it gets a dropdown entry and a route with no
// other file changes. Role-aware from day one (each carries the roles allowed
// to run it); today every report is owner/admin, matching Back Office access.
// ============================================================
export const REPORTS = [
  { key: "sales-summary", path: "sales-summary", label: "Sales Summary", roles: ["owner", "admin"], Component: SalesSummaryReport },
  { key: "transactions", path: "transactions", label: "Transaction Log", roles: ["owner", "admin"], Component: TransactionLogReport },
  { key: "discounts", path: "discounts", label: "Discount Report", roles: ["owner", "admin"], Component: DiscountReport },
  { key: "labor", path: "labor", label: "Labor Report", roles: ["owner", "admin"], Component: LaborReport },
];

// Reports the given role may run, in registry order.
export const visibleReports = (role) => REPORTS.filter((r) => r.roles.includes(role));
