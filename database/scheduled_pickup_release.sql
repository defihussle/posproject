-- Scheduled online pickup — kitchen "Fire now" release.
--
-- A scheduled online ticket (pickup_at later than now + 20 minutes) is held off
-- the live KDS board until 20 minutes before pickup_at
-- (backend/lib/scheduledRelease.js). "Fire now" on the KDS Scheduled dropdown
-- releases one early. That has to be recorded on the ORDER, not on a device,
-- so every KDS and Back Office Live Orders agree, and it must NOT move
-- pickup_at: that is the guest's slot and still prints on the ticket.
--
-- NULL = not released by hand (the time rule alone decides). Set = on the live
-- board from that moment, whatever pickup_at says.
--
-- Additive, nullable, re-runnable. Run against prod BEFORE deploying the
-- dependent code (Schema Change Checklist in CLAUDE.md).

ALTER TABLE orders ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.released_at IS
  'KDS Fire now: when a held scheduled pickup ticket was released to the live board early. NULL = time rule only.';
