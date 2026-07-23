# Payroll Feature — Implementation Plan

## Goal
Add a dedicated **Payroll** section to the Back Office so owners and admins can view weekly staff hours and calculated pay, mark weeks as paid, and export the data.

## Placement & Access
- New item in the left sidebar: **Payroll**
- Position: **right before Devices**
- Visible only to **Owner** and **Admin** roles

## Page Layout (Mobile-first, consistent with existing Back Office)
- Full dedicated page (not a modal)
- Header with week navigation
- Clean table of staff for the selected week
- Export buttons
- Status controls

### Header
- Title: Payroll
- Week selector: ← Previous Week | Current Week
- Default view = Current pay period (Monday → Sunday of the current week)
- Show the date range clearly (e.g. “Jul 21 – Jul 27, 2026”)

### Main Table Columns
| Staff Name | Role | Hours Worked | Hourly Rate | Gross Pay | Status |
|------------|------|--------------|-------------|-----------|--------|

- Hours Worked = total worked time (clock-in to clock-out minus all breaks)
- Gross Pay = Hours Worked × Hourly Rate
- Status = Paid / Unpaid (default Unpaid)

### Status & Saving
- Each row has a checkbox or toggle for “Mark as Paid”
- A single **Save** button at the bottom of the table that persists the Paid/Unpaid status for the selected week
- Once saved, the status should remain when the page is revisited

### Export
- Two buttons: **Export CSV** and **Export PDF**
- Filename format: `payroll-YYYY-MM-DD-to-YYYY-MM-DD.csv` (and .pdf)
- Export includes the same columns + the week date range

### Edge Cases
- Open shifts that spill a few hours past Sunday → include those hours in the ending week
- No one should normally be clocked in at week end; handle gracefully
- Empty weeks show a clean “No shifts this week” message

## Technical Notes
- Reuse existing shifts + shift_breaks + staff.hourly_rate data
- New backend endpoints needed for:
  - Weekly payroll summary (hours + pay per staff)
  - Saving Paid/Unpaid status (new table or column recommended)
- Keep UI fully consistent with Staff Management, Devices, and Dashboard styling
- Excellent mobile experience (horizontal scroll or stacked cards on very small screens if needed)

## Acceptance Criteria
- [ ] Payroll appears in sidebar before Devices (owner/admin only)
- [ ] Default view is current Monday–Sunday week
- [ ] Previous Week / Current Week navigation works
- [ ] Hours correctly subtract breaks
- [ ] Gross Pay calculates correctly
- [ ] Mark as Paid + Save persists status
- [ ] CSV and PDF export work with correct filenames
- [ ] Fully responsive and matches existing Back Office design
