# HMS — Requirements Analysis & Design

Source of truth: *Software Requirements Specification — Hospital Management System v1.0*
(Muhammad Habib 62669, Mamoon Ishaq Khan 62338, Daniyal Karim 63780, SE-4-1).

This document is the result of reading the entire SRS (all 77 pages, including every
diagram: architecture, DFD L0/L1, ER, the overall and per-module use-case diagrams, the 9
activity diagrams and all 50 use-case tables). Every row below is traceable to an SRS item.

---

## 1. Requirements summary

### 1.1 Functional requirements (SRS §3.1) and their governing use cases

| FR | Requirement (SRS wording, abridged) | Use cases | Key rules extracted |
|----|------|------|------|
| FR-01 | Staff log in with unique username + password | UC-01 | Session expires after **10 min inactivity**; login recorded in audit log |
| FR-02 | Verify credentials, grant access by role | UC-01, UC-03 | Compare against **hashed** password; **3 failed attempts → temporary lock**; redirect to role dashboard |
| FR-03 | Reset password via registered email | UC-04 | Reset link **expires within 24 h**; unregistered email → "email not found" message |
| FR-04 | Admin creates/edits/deletes users | UC-05/06/07 | Unique username; role mandatory; credentials sent to user; role change effective **next login**; deleted data **archived first**; admin **cannot delete self** |
| FR-05 | Admin assigns roles & permissions | UC-05/06 | Role-permission matrix editable |
| FR-06 | Admin manages doctor profiles (specialization, department) | UC-08 | Unique doctor ID; specialization required; missing fields highlighted |
| FR-07 | Admin manages departments | UC-09 | Unique department name |
| — | Staffing levels | UC-10 | Required count per department; **≤0 rejected**; review monthly |
| — | Staff list | UC-11 | Searchable & sortable by name, role, department; empty-state message |
| FR-08 | Receptionist registers patients (personal + medical) | UC-12 | Duplicate **name + DOB** → warn and ask for confirmation |
| FR-09 | Unique patient ID | UC-12, UC-14 | Patient-ID verification (< 2 s) before patient actions; invalid → re-entry |
| FR-10 | Receptionist updates patient info | UC-13 | Every change logged with date/time; not found → suggest registering |
| FR-11 | Receptionist **or patient** books, cancels, reschedules | UC-15/16 | Token number; confirmation sent; reason required; doctor notified; **cancellation < 1 h before → admin approval** |
| FR-12 | Conflict check before confirming | UC-15 | Conflict → message + **next available slot** |
| FR-13 | Waitlist when no slots | UC-17 | **FCFS**, timestamped; patient + receptionist notified when slot frees; decline → no action |
| FR-14 | Admit & assign ward/bed | UC-18/19, Fig 13 | Doctor recommends admission; no bed → suggest another ward; status → **In-Patient**; bed → Occupied; **real-time** across staff views; linked to medical record |
| FR-15 | Transfer between wards | UC-20 | Old bed freed, new bed assigned; logged with **date, time, reason** |
| FR-16 | Doctor or receptionist discharges **after bills cleared** | UC-21, Fig 13 | Doctor approves → bills checked → pending → **block + payment alert**; **discharge summary** generated; status → Discharged; bed freed |
| FR-17 | Doctor views complete history | UC-22/23/24 | Read-only; most recent first; print/download record; diagnosis logs **cannot be deleted** |
| FR-18 | Record diagnoses & observations | UC-25/26 | Diagnosis = condition, **severity**, notes; observations = vitals + symptoms with date/time/doctor; invalid vitals rejected per field |
| FR-19 | Digital prescriptions | UC-27, Fig 15 | Requires a diagnosis in the current visit; medicine, dosage, frequency, duration; sent to pharmacy; out-of-stock → alert + **suggest alternative** |
| FR-20 | Request lab tests + parameters | UC-28/29 | Test type, **urgency**, clinical notes; technician notified; unavailable test → suggest alternatives; parameters validated against test definition |
| FR-21 | Technician processes & uploads results | UC-30/31 | Pending → In Progress → Completed; **processing time recorded**; materials missing → **notify doctor of delay**; upload **PDF or image**, validated format & size |
| FR-22 | Notify doctor & patient on upload | UC-33 | Within **1 minute**; **retry up to 3 times** |
| FR-23 | Pharmacist verifies prescriptions | UC-34 | Verify within **15 min** of receipt; error → **flag + notify doctor** |
| FR-24 | Dispense & auto-update inventory | UC-35 | Stock checked per medicine; record quantity + date; out of stock → alert |
| FR-25 | Restock alerts | UC-37 | Pharmacist sets min level; alert when stock **≤ threshold**; invalid threshold rejected |
| FR-26 | Expiry tracking | UC-38 | Auto-flag **≤ 30 days (yellow)**, **expired (red)**; remove expired stock with log; "all within valid date" message |
| FR-27 | Itemized bills | UC-39 | **Consultation, lab, medicine, room** charges shown separately; unrecorded services → warning |
| FR-28 | Apply insurance | UC-40 | Verified before applying; invalid/expired → full amount remains payable |
| FR-29 | Payments & receipts | UC-41/42 | **Partial payments** tracked separately; amount > balance → error; receipt has date, amount, **remaining balance**; copy saved to patient record; no payment → Issue Receipt disabled |
| FR-30 | Financial reports (accountant & admin) | UC-43/44 | Daily / weekly / monthly; **PDF export**; summary = revenue, payments, outstanding (real time) |
| FR-31 | Backups manual/automatic | UC-45 | Automatic **daily at midnight**; compressed; timestamped confirmation; failure → alert admin + log |
| FR-32 | Monitor system health | UC-46 | Server, DB connectivity, performance; **runs hourly**; issue → alert admin; result logged |
| FR-33 | Automatic notifications | UC-47 | Appointments, lab results, low stock; logged with timestamp; within 1 min; 3 retries |
| FR-34 | Patient portal | UC-48/49/50 | View own profile, lab reports, bills; **read-only**; own data only |

### 1.2 Non-functional requirements (SRS §3.2)

| NFR | Target | How the design addresses it | How it can be verified |
|---|---|---|---|
| NFR-01 | 500 concurrent users | Stateless API, pooled DB connections, indexed queries, pagination | Load test script (autocannon) — results reported only if run |
| NFR-02 | RBAC | Permission middleware on every route + ownership checks + route guards in UI | Automated RBAC tests |
| NFR-03 | Encrypt passwords & sensitive patient data | bcrypt password hashes; AES-256-GCM field encryption for national ID, address, allergies, medical history, insurance policy no. | Tests read raw DB rows |
| NFR-04 | < 3 s common actions | Request timing middleware; p95 shown in System Health | Measured, not claimed |
| NFR-05 | Usable without training | Role-specific navigation, plain language, inline validation, empty states | Manual review |
| NFR-06 | 99% uptime | Health checks, process manager guidance, graceful shutdown | Deployment concern; not provable in dev |
| NFR-07 | Scalability over years | Normalized schema, indexes, pagination everywhere, partial unique indexes | Design review |
| NFR-08 | Daily automatic + manual backups | Scheduler at 00:00 + "Backup now"; `pg_dump` compressed with checksum | Backup tests |
| NFR-09 | Chrome, Firefox, Edge, Safari | Standard React build targeting evergreen browsers | Chromium automated; others manual |
| NFR-10 | 24/7 availability | Same as NFR-06 | Deployment concern |
| NFR-11 | Modular | One folder per module (routes / service / schema) on server; per-module pages on client | Code structure |
| NFR-12 | No duplicates, validated input | DB unique constraints + server-side schema validation on every write | Tests |

### 1.3 Other requirements found outside the FR table
* §4.2.1 printer: bills, prescriptions, reports, receipts and discharge summaries have print layouts.
* §4.2.3 all traffic over **HTTPS** → secure cookies, HSTS, optional native TLS / reverse-proxy guide.
* §2.6 / §1.2 **out of scope**: mobile app, external insurance integration, lab equipment integration, hardware setup. None are built.
* Actor 9 "System" → automated actors are implemented as background jobs (scheduler) and services (credential verifier, notifier, patient-ID verifier).
* DFD L1 & architecture: Authentication Module, Patient Management, Billing Engine, Notification Service as backend services.
* ER diagram entities: Patient, Doctor, Staff, Appointment, Ward, Bed, Diagnosis, Prescription, Medicine, Lab Request, Lab Report, Bill, Payment — all present, with supporting tables added for normalization.

### 1.4 Interpretations where the SRS is silent (kept consistent with it)
| Topic | Decision |
|---|---|
| Lock duration (UC-01 says "temporarily") | 15 minutes; admin can unlock earlier |
| Patient portal accounts | Receptionist can enable portal access at/after registration; a temporary password is issued and must be changed on first login |
| "Delete user" vs. audit | Snapshot archived, account anonymised & disabled, sessions revoked; row kept so historical records (appointments, bills, audit) stay referentially intact |
| Doctor access to records | Doctors open full history for patients with a care relationship (appointment, visit, admission, lab request). Otherwise an audited **emergency access** with a reason grants 24 h access (SRS §2.3 names emergency access as a problem to solve) |
| Admin approval for <1 h cancellation | Creates a cancellation request; admin approves/rejects from a queue |
| Insurance "verification" | Local verification only (accepted provider, active, not expired, valid coverage %) — no external integration (out of scope) |
| Discharge with unbilled charges | Treated as "bills not cleared": discharge is blocked until a final bill is generated and paid |
| "Auto-save unsaved data before logout" (UC-02) | Long clinical/registration forms autosave drafts to the server (encrypted) and restore them after re-login |
| Email/SMS | Notification service with channels. In-app is always on. Email uses SMTP when configured; otherwise a **development outbox** stores the message, clearly labelled "captured — not delivered". SMS: no provider configured, so no SMS channel is claimed |

---

## 2. Module architecture

```
┌──────────────────────── Presentation (React SPA) ─────────────────────────┐
│ Staff dashboards (7 roles) · Patient portal · Forms & reports · Print views│
└─────────────── HTTPS / JSON + Server-Sent Events (real-time) ─────────────┘
┌──────────────────────── Application (Node.js / Express) ──────────────────┐
│ Middleware: helmet · rate limit · session auth (10-min idle) · RBAC ·      │
│             validation (zod) · audit · request metrics · error handler     │
│ Modules: auth · users/roles · departments · doctors · staff · staffing ·   │
│          patients · appointments · waitlist · wards/beds · admissions ·    │
│          clinical · lab · pharmacy · billing · reports · portal ·          │
│          notifications · audit · system (backup, health)                   │
│ Services: NotificationService (in-app, email; retry ×3) · RealtimeHub ·    │
│           Scheduler (midnight backup, hourly health, reminders, expiry,    │
│           retries) · FieldCrypto · PDF generator                           │
└───────────────────────────────────────────────────────────────────────────┘
┌──────────────────────── Data (PostgreSQL 16) ─────────────────────────────┐
│ Normalized schema · FK constraints · CHECK constraints · partial unique    │
│ indexes (no double booking / double bed) · append-only triggers on audit   │
│ logs and diagnoses · file store for lab reports · compressed backups       │
└───────────────────────────────────────────────────────────────────────────┘
```

Each server module has `routes.js` (HTTP + permission guards), `service.js` (business rules,
transactions) and `schemas.js` (validation). Modules talk to each other only through service
functions, so one can be replaced without touching the rest (NFR-11).

---

## 3. Role / permission matrix

Legend: **F** full, **R** read, **O** own records only, **C** care-relationship only, — none.

| Capability | Patient | Receptionist | Doctor | Lab Tech | Pharmacist | Accountant | Admin | Sys Admin |
|---|---|---|---|---|---|---|---|---|
| Users, roles, permissions | — | — | — | — | — | — | F | — |
| Doctors, departments, staffing, staff list | — | — | — | — | — | — | F | — |
| Register / update patients | — | F | — | — | — | — | — | — |
| Patient demographics search | O | F | R | R (via request) | R (via Rx) | R | — | — |
| Appointments book/cancel/reschedule | O | F | R own schedule | — | — | — | approve <1h cancels | — |
| Waitlist | — | F | — | — | — | — | — | — |
| Wards & beds setup | — | F | R | — | — | — | F | — |
| Admit / assign bed / transfer | — | F | request | — | — | — | — | — |
| Discharge | — | F (after doctor approval) | F (approve + discharge) | — | — | — | — | — |
| Medical history, diagnoses, observations | O (read) | — | C (+ emergency access) | — | — | — | — | — |
| Prescriptions | O (read) | — | C create | — | verify/dispense | — | — | — |
| Lab requests | — | — | C create | process/upload | — | — | — | — |
| Lab reports | O | — | C | F | — | — | — | — |
| Lab test catalogue | — | — | R | F | — | — | F | — |
| Medicine inventory, alerts, expiry | — | — | R (stock) | — | F | — | — | — |
| Bills, insurance, payments, receipts | O (read) | R (balance for discharge) | — | — | — | F | R | — |
| Financial reports / summaries | — | — | — | — | — | F | F | — |
| Operational reports | — | partial (beds, appointments) | own workload | lab stats | inventory | — | F | — |
| Audit log | — | — | — | — | — | — | R | R |
| Backup, system health | — | — | — | — | — | — | — | F |
| Notifications | O | O | O | O | O | O | O | O |

Permissions are stored in the database (`permissions`, `role_permissions`) and loaded into the
session at login, so admin changes take effect on the user's next login (UC-06).

---

## 4. Database / ER design

ER entities from SRS Figure 4 are in **bold**; the rest are required to normalize or to satisfy
use-case rules.

| Table | Purpose / key constraints |
|---|---|
| roles, permissions, role_permissions | RBAC (FR-05) |
| users | unique username (case-insensitive, among non-deleted), email, bcrypt hash, failed_login_count, locked_until, must_change_password, status |
| archived_users | JSON snapshot before deletion (UC-07) |
| sessions | hashed opaque token, last_activity_at (10-min idle), role + permission snapshot, revoked_at |
| password_reset_tokens | hashed token, expires_at ≤ 24 h, used_at |
| departments | unique lower(name) |
| **staff** | 1:1 user, unique employee_code, department, designation |
| **doctors** | 1:1 staff, unique doctor_code, specialization, license no., consultation fee |
| doctor_schedules | weekly availability per doctor (weekday, start, end, slot length) |
| staffing_levels | (department, role) unique, required_count > 0, reviewed_at |
| **patients** | unique patient_code (P-YYYY-NNNNNN), encrypted national ID + blind-index hash (unique), encrypted address/allergies/history, status (out_patient / in_patient / discharged), optional portal user |
| insurance_providers, patient_insurance | accepted insurers, policy (encrypted no.), coverage %, cap, validity |
| **appointments** | token number unique per doctor/day; partial unique index on (doctor, date, start) and (patient, date, start) for active statuses → no double booking at DB level |
| appointment_cancellation_requests | <1 h cancellations awaiting admin approval |
| waitlist_entries | FCFS by created_at; status waiting/notified/booked/cancelled |
| **wards**, **beds** | unique (ward, bed_number); bed status available/occupied/maintenance |
| admission_requests | doctor-recommended admission/transfer (UC-18/20 triggers) |
| admissions | partial unique: one active admission per patient, **one active admission per bed** |
| bed_transfers | from/to ward+bed, reason, timestamp, user (UC-20) |
| discharge_summaries | 1:1 admission, generated text + snapshot (UC-21) |
| visits | medical record of one encounter (OPD/IPD), links appointment/admission |
| **diagnoses** | condition, severity, notes; **append-only trigger** (UC-24) |
| clinical_observations | vitals with CHECK ranges, symptoms, recorded_at, doctor (UC-26) |
| **prescriptions**, prescription_items | status pending/verified/flagged/dispensed/partially_dispensed/cancelled |
| **medicines**, medicine_batches | batch quantity ≥ 0 (CHECK), expiry per batch, reorder level |
| inventory_transactions | every stock movement (receive/dispense/adjust/expired removal) |
| dispensings, dispensing_items | what was issued, from which batch, at what price |
| stock_alerts | open low-stock / near-expiry / expired alerts (deduplicated) |
| lab_tests | catalogue with parameter definitions, price, availability |
| **lab_requests** | urgency, clinical notes, selected parameters, status, started/completed times, delay reason |
| **lab_reports** | 1:1 request, stored file (PDF/PNG/JPEG), result values |
| **bills**, bill_items | subtotal, insurance amount, payable, paid, generated balance; item category consultation/lab/medicine/room/other; unique source per billed service (no double billing) |
| **payments**, receipts | amount > 0, cannot exceed balance (CHECK paid ≤ payable); one receipt per payment with balance_after |
| notifications, notification_deliveries | per-user in-app notifications; per-channel delivery with attempts ≤ 3 |
| outbound_emails | development outbox (only when SMTP not configured) |
| audit_logs | user, action, entity, status, IP, details; **append-only trigger** |
| backups, health_checks | history of backups and health checks |
| drafts | encrypted autosaved form drafts (UC-02) |
| emergency_access_grants | audited break-glass access for doctors |

---

## 5. Frontend page structure

```
/login  /forgot-password  /reset-password/:token  /change-password
/dashboard                         role-specific dashboard
/notifications
Admin:        /admin/users  /admin/roles  /admin/doctors  /admin/departments
              /admin/staffing  /admin/staff  /admin/cancellation-requests
Reception:    /patients  /patients/new  /patients/:id  /patients/:id/edit
              /appointments  /appointments/book  /waitlist
              /wards  /wards/board  /admissions  /admissions/:id
Doctor:       /doctor/schedule  /doctor/patients  /doctor/patients/:id (history, diagnoses,
              observations, prescriptions, lab, admission)  /visits/:id
Lab:          /lab/requests  /lab/requests/:id  /lab/reports  /lab/tests
Pharmacy:     /pharmacy/prescriptions  /pharmacy/prescriptions/:id  /pharmacy/inventory
              /pharmacy/medicines/:id  /pharmacy/expiry  /pharmacy/alerts
Billing:      /billing  /billing/patients/:id  /billing/bills/:id  /billing/receipts/:id
              /billing/insurance-providers  /reports/financial
Reports:      /reports (operational, by permission)
System:       /system/health  /system/backups  /system/audit
Portal:       /portal  /portal/profile  /portal/appointments  /portal/lab-reports  /portal/bills
```

## 6. Backend API structure (all under `/api`)

```
auth          POST login, logout, forgot-password, reset-password, change-password; GET me; POST heartbeat
users         CRUD, /:id/unlock, /:id/reset-password ; roles & permissions matrix
departments   CRUD ; doctors CRUD + schedules ; staff list ; staffing-levels
patients      CRUD, /search, /verify/:code, /check-duplicate, /:id/history, /:id/portal-access
appointments  GET list, /slots, POST book, /:id/cancel, /:id/reschedule, /:id/complete,
              cancellation-requests (+ approve/reject)
waitlist      list, add, /:id/book, /:id/cancel
wards         wards & beds CRUD, /board ; admissions (admit, transfer, approve-discharge,
              discharge, discharge-summary) ; admission-requests
clinical      visits, diagnoses, observations, history, emergency-access
prescriptions create, list, revise ; pharmacy: verify, flag, dispense
pharmacy      medicines, batches, adjustments, alerts, expiry, removal
lab           tests catalogue, requests, start, delay, complete, report upload/download
billing       unbilled services, bills, insurance apply, payments, receipts, insurance providers
reports       dashboard stats per role, operational, financial (JSON + PDF)
portal        me, appointments, lab-reports, bills
notifications list, read, read-all ; events (SSE stream)
system        health (run, history), backups (run, list, download), audit logs
drafts        get / put / delete per form key
```

## 7. Main workflows (from the activity diagrams)

1. **Login** (Fig 7): credentials → verify (hash) → fail ⇒ error & retry, 3rd fail ⇒ lock → role dashboard → audit → idle 10 min ⇒ session ends.
2. **Admin action** (Fig 9): select action → form → validate → invalid ⇒ highlight fields → save → confirm → audit.
3. **Patient access** (Fig 11): new patient? → register (duplicate check) → ID assigned → book appointment → availability check → unavailable ⇒ next slot or waitlist → confirm + notification.
4. **Ward** (Fig 13): doctor recommends admission → receptionist selects ward → bed available? (else suggest another ward) → assign bed → Occupied → treatment → doctor approves discharge → bills cleared? (else block + alert) → discharge summary → bed freed, status Discharged.
5. **Clinical** (Fig 15): open profile → history → observations & diagnosis → lab test needed? → request → prescription → pharmacy.
6. **Laboratory** (Fig 17): pending requests → select → materials available? (else delay + notify doctor) → process → upload → link to record → notify doctor & patient.
7. **Pharmacy** (Fig 19): pending prescriptions → verify → valid? (else flag + notify doctor) → in stock? (else alert + notify) → issue → update inventory → record dispensing.
8. **Financial** (Fig 21): billing section → review services → insurance? → itemized bill → payment → receipt → balance updated.
9. **System** (Fig 23): health check → issues? alert admin : log → backup → confirm.
10. **Portal** (Fig 25): login → dashboard → choose section → view → logout.

## 8. Development phases
1. Setup, DB, auth, RBAC, admin, patients
2. Appointments, waitlist, wards, admission/transfer/discharge
3. Clinical care & prescriptions
4. Laboratory
5. Pharmacy
6. Billing, payments, financial reports
7. Patient portal, notifications, audit, backup, health
8. Tests, security review, UI refinement, docs, requirement checklist

## 9. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18 + Vite, React Router, TanStack Query, Tailwind CSS, lucide icons, Recharts | Fast SPA, caching + invalidation for "real-time" views, consistent design system |
| Backend | Node.js 22 + Express 5 (ES modules) | Simple, widely taught, one language across tiers |
| Validation | zod | Field-level error messages returned to forms |
| Database | PostgreSQL 16 via Knex (migrations + query builder) | Relational, real constraints, partial unique indexes, row locks, `pg_dump` backups |
| Auth | Server-side sessions (httpOnly, SameSite=Strict cookie) + bcrypt | Real logout/revocation, exact 10-minute idle expiry |
| Encryption | AES-256-GCM field encryption + HMAC blind index | NFR-03 without losing duplicate detection |
| Real-time | Server-Sent Events | Bed board / notifications update live (UC-19) |
| Jobs | node-cron | Midnight backup, hourly health, reminders, expiry scan, retries |
| PDF | pdfkit | Financial reports (UC-43) |
| Tests | Vitest + Supertest (API, real Postgres), Playwright (browser smoke) | Workflows tested end-to-end |
