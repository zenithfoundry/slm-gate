---
type: Decision
title: Architecture direction
verified_by: human:bz3b
verified_at: 2026-10-21
stale_after: 2027-04-01
---
API-first. The primary product boundary is the MCP protocol and the four wire formats the model gate speaks;
the dashboard is a reader of the ledger, not a boundary. Business logic lives behind those contracts.
