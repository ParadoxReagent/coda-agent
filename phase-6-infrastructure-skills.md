# Phase 6: Infrastructure Skills — NAS, Proxmox, Package Tracking

**Timeline:** Medium-term
**Depends on:** Phases 1-4 (stable core), Phase 5 (event bus patterns established)
**Goal:** Give coda visibility into your infrastructure stack and add quality-of-life package tracking.

---

## 6.1 Synology NAS Skill

### Integration Approach
- [ ] Use Synology DSM 7 REST API (LAN-only)
- [ ] Authenticate with dedicated `coda-readonly` DSM account
- [ ] Async HTTP client via native `fetch`

### Tools
- [ ] Tool: `nas_storage`
  - Output: volume health, capacity used/free per volume, RAID status
  - Flag warnings: volume > 80% full, degraded RAID, failed drive
- [ ] Tool: `nas_downloads`
  - Output: active Download Station tasks — filename, progress, speed, ETA
- [ ] Tool: `nas_services`
  - Output: status of key DSM services (Docker, Surveillance Station, Hyper Backup)
- [ ] Tool: `nas_surveillance`
  - Input: `camera` (string, optional — specific camera or "all")
  - Output: camera status, recent motion events, snapshot URL
  - Discord: embed camera snapshot

### Proactive Alerts
- [ ] `alert.nas.disk_warning` — disk health degraded, volume nearly full
- [ ] `alert.nas.raid_degraded` — RAID array degraded (always alert, ignore quiet hours)
- [ ] `alert.nas.backup_failed` — Hyper Backup task failed
- [ ] Poll interval: every 5 minutes for storage/health, every 60s for downloads

### Briefing Integration
- [ ] Include storage health summary if any warnings exist
- [ ] Include active download status if downloads are running

---

## 6.2 Proxmox Monitoring Skill

### Integration Approach
- [ ] Use Proxmox VE REST API (LAN-only)
- [ ] Authenticate with API token (least privilege — PVEAuditor role)
- [ ] Async HTTP client via native `fetch`

### Tools
- [ ] Tool: `proxmox_status`
  - Output: node health (CPU, RAM, storage), running VMs/LXCs count, cluster status
- [ ] Tool: `proxmox_vms`
  - Input: `filter` (optional: "running", "stopped", "all")
  - Output: VM/LXC list with status, resource usage (CPU%, RAM%), uptime
- [ ] Tool: `proxmox_vm_detail`
  - Input: `vmid` (number) or `name` (string)
  - Output: detailed VM info — config, resource usage, snapshots, network
- [ ] Tool: `proxmox_vm_action`
  - Input: `vmid` (number), `action` ("start", "stop", "restart", "shutdown")
  - **Destructive action — requires explicit confirmation for stop/restart**
  - Output: confirmation of action

### Proactive Alerts
- [ ] `alert.proxmox.node_high_cpu` — sustained CPU > 90% for 5+ minutes
- [ ] `alert.proxmox.node_high_ram` — RAM usage > 90%
- [ ] `alert.proxmox.node_storage_low` — storage < 10% free
- [ ] `alert.proxmox.vm_stopped` — unexpected VM/LXC shutdown (was running, now stopped)
- [ ] Poll interval: every 60 seconds

### Briefing Integration
- [ ] Include Proxmox summary in morning briefing if any warnings exist
- [ ] "Proxmox: all 12 VMs healthy, node at 34% CPU / 67% RAM"

---

## 6.3 Package Tracking Skill

### Integration Approach
- [ ] Primary: parse tracking emails from inbox (leverage Email skill)
  - Regex patterns for common carriers (USPS, UPS, FedEx, Amazon)
  - Extract tracking numbers from email subjects and bodies
- [ ] Secondary: 17track API or AfterShip API for status polling
- [ ] Store active shipments in Postgres

### Data Model
- [ ] Drizzle schema — `shipments` table:
  - `id` (UUID), `trackingNumber`, `carrier`, `description` (from email subject)
  - `status` (in_transit, out_for_delivery, delivered, exception)
  - `lastUpdate`, `estimatedDelivery`, `sourceEmailId`
  - `createdAt`, `deliveredAt`

### Tools
- [ ] Tool: `packages_status`
  - Output: all active (non-delivered) shipments with status and ETA
- [ ] Tool: `package_track`
  - Input: `trackingNumber` (string), `carrier` (string, optional — auto-detect)
  - Output: tracking history and current status
- [ ] Tool: `package_add`
  - Input: `trackingNumber`, `carrier` (optional), `description` (optional)
  - Output: confirmation, initial status fetch

### Auto-Detection
- [ ] Email skill integration: when email poller finds shipping confirmation emails, auto-extract tracking info and create shipment records
- [ ] Patterns for major carriers:
  - USPS: `9400...` (20-22 digits)
  - UPS: `1Z...` (18 chars)
  - FedEx: 12-15 digits
  - Amazon: detect from Amazon shipping confirmation emails

### Proactive Alerts
- [ ] `alert.package.out_for_delivery` — package is out for delivery today
- [ ] `alert.package.delivered` — package delivered
- [ ] `alert.package.exception` — delivery exception (failed attempt, returned)

### Briefing Integration
- [ ] Include package status in morning briefing if active shipments exist:
  ```
  2 packages in transit:
  - USB-C Hub (UPS) — out for delivery today
  - Filament order (USPS) — in transit, ETA Friday
  ```

---

## 6.4 Database Migrations

- [ ] Drizzle migration: create `shipments` table with indexes on `status` and `trackingNumber`

---

## 6.5 Test Suite — Phase 6 Gate

All tests must pass before proceeding to Phase 7. Run with `npm run test:phase6`.

### Unit Tests

**NAS Skill (`tests/unit/skills/nas/skill.test.ts`)**
- [ ] `nas_storage` returns formatted volume health and capacity
- [ ] `nas_storage` flags warnings for volumes > 80% full
- [ ] `nas_storage` flags degraded RAID arrays
- [ ] `nas_downloads` returns active download tasks with progress
- [ ] `nas_downloads` returns empty message when no downloads active
- [ ] `nas_services` returns status of configured services
- [ ] `nas_surveillance` returns camera status and snapshot URL
- [ ] Handles NAS API unreachable gracefully

**Proxmox Skill (`tests/unit/skills/proxmox/skill.test.ts`)**
- [ ] `proxmox_status` returns formatted node health summary
- [ ] `proxmox_vms` returns VM list filtered by status
- [ ] `proxmox_vm_detail` returns detailed info for valid VMID
- [ ] `proxmox_vm_detail` returns error for invalid VMID
- [ ] `proxmox_vm_action` requires confirmation for stop/restart actions
- [ ] `proxmox_vm_action` executes start without confirmation
- [ ] Handles Proxmox API unreachable gracefully

**Proxmox Monitor (`tests/unit/skills/proxmox/monitor.test.ts`)**
- [ ] Detects sustained high CPU (>90% for 5+ minutes)
- [ ] Does not alert for brief CPU spikes (<5 minutes)
- [ ] Detects high RAM usage (>90%)
- [ ] Detects low storage (<10% free)
- [ ] Detects unexpected VM shutdown (was running, now stopped)
- [ ] Does not alert for VMs that were intentionally stopped

**Package Tracking Skill (`tests/unit/skills/packages/skill.test.ts`)**
- [ ] `packages_status` returns active shipments with status and ETA
- [ ] `packages_status` returns empty message when no active shipments
- [ ] `package_track` returns tracking history for valid tracking number
- [ ] `package_add` creates shipment record and fetches initial status
- [ ] Auto-detection extracts USPS tracking numbers from email body
- [ ] Auto-detection extracts UPS tracking numbers from email body
- [ ] Auto-detection extracts FedEx tracking numbers from email body
- [ ] Auto-detection extracts Amazon tracking from confirmation emails
- [ ] Carrier auto-detection correctly identifies carrier from tracking number format

**Tracking Number Parser (`tests/unit/skills/packages/parser.test.ts`)**
- [ ] Matches USPS format (9400... 20-22 digits)
- [ ] Matches UPS format (1Z... 18 chars)
- [ ] Matches FedEx format (12-15 digits)
- [ ] Returns null for strings that don't match any carrier pattern
- [ ] Extracts multiple tracking numbers from a single email body
- [ ] Handles tracking numbers with spaces/dashes (normalized)

### Integration Tests

**NAS Alert Pipeline (`tests/integration/nas-alerts.test.ts`)**
- [ ] RAID degradation publishes high-severity alert that bypasses quiet hours
- [ ] Volume >80% full publishes medium-severity alert
- [ ] Backup failure publishes alert with task details

**Proxmox Alert Pipeline (`tests/integration/proxmox-alerts.test.ts`)**
- [ ] Unexpected VM shutdown publishes alert with VM name and last known state
- [ ] Sustained high CPU publishes alert after 5-minute threshold
- [ ] Low storage publishes alert with volume details

**Package Auto-Detection (`tests/integration/package-detection.test.ts`)**
- [ ] Email poller finding shipping confirmation creates shipment record automatically
- [ ] Duplicate tracking numbers are not re-added
- [ ] Package delivery status update publishes alert

**Package Briefing (`tests/integration/package-briefing.test.ts`)**
- [ ] Morning briefing includes package section when shipments are active
- [ ] Morning briefing omits package section when no shipments are active

### Test Helpers (additions to previous phases)
- [ ] `createMockSynologyAPI()` — mock DSM API with configurable volumes, downloads, services
- [ ] `createMockProxmoxAPI()` — mock Proxmox API with configurable nodes and VMs
- [ ] `createTestShipments()` — fixture factory for shipment records
- [ ] `createTestTrackingEmails()` — fixture factory for carrier confirmation emails

---

## Acceptance Criteria

1. "How's the NAS?" returns storage health, volume status, and any warnings
2. "Any downloads running?" returns active Download Station tasks
3. "Proxmox status" returns node health and VM/LXC summary
4. "Restart the pihole VM" requires confirmation, then executes the action
5. VM unexpected shutdown triggers a Discord alert
6. "Any packages coming?" returns active shipment statuses
7. Shipping confirmation emails are auto-detected and tracked
8. Package out-for-delivery triggers a morning notification
9. NAS RAID degradation triggers an immediate alert (bypasses quiet hours)
10. **`npm run test:phase6` passes with 0 failures**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Synology API | DSM 7 REST API | Native, documented, no third-party SDK needed |
| Proxmox API | REST API with token auth | Standard, role-based access control built in |
| Package tracking | Email parsing + optional 17track API | Email-first avoids another API dependency |
| Carrier detection | Regex pattern matching on tracking numbers | Simple, reliable for major carriers |
| HTTP client | Native `fetch` | No additional dependencies, built into Node 22 |

---

## Key Dependencies (additions to previous phases)

No new runtime dependencies. NAS, Proxmox, and package tracking APIs are all consumed via native `fetch`. Tracking number parsing uses regex patterns — no external library needed.
