/**
 * Initial HMS schema.
 *
 * Mirrors the SRS ER diagram (Figure 4): Patient, Doctor, Staff, Appointment, Ward, Bed,
 * Diagnosis, Prescription, Medicine, Lab Request, Lab Report, Bill, Payment — plus the
 * supporting tables needed to enforce the use-case rules at database level.
 *
 * Integrity rules enforced by the database itself (not only by application code):
 *  - no double booking of a doctor slot or a patient slot  (partial unique indexes)
 *  - one active admission per patient and per bed          (partial unique indexes)
 *  - stock can never go negative                            (CHECK)
 *  - a bill can never be over-paid                          (CHECK)
 *  - a service can be billed only once                      (unique index)
 *  - diagnoses and audit logs are append-only               (triggers)
 */

export async function up(knex) {
  await knex.raw(`
  CREATE EXTENSION IF NOT EXISTS citext;

  -- ===================================================================== RBAC
  CREATE TABLE roles (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    is_staff      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE permissions (
    id            SERIAL PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    module        TEXT NOT NULL,
    description   TEXT NOT NULL
  );

  CREATE TABLE role_permissions (
    role_id       INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  );

  -- ===================================================================== Users
  CREATE TABLE users (
    id                    SERIAL PRIMARY KEY,
    username              CITEXT NOT NULL,
    email                 CITEXT,
    password_hash         TEXT,
    full_name             TEXT NOT NULL,
    phone                 TEXT,
    role_id               INT NOT NULL REFERENCES roles(id),
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','deleted')),
    failed_login_count    INT NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
    locked_until          TIMESTAMPTZ,
    must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at         TIMESTAMPTZ,
    password_changed_at   TIMESTAMPTZ,
    deleted_at            TIMESTAMPTZ,
    created_by            INT REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT username_format CHECK (username ~ '^[A-Za-z0-9._-]{3,40}$' OR status = 'deleted')
  );
  CREATE UNIQUE INDEX users_username_active_uq ON users (username) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX users_email_active_uq ON users (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
  CREATE INDEX users_role_idx ON users(role_id);

  CREATE TABLE archived_users (
    id               SERIAL PRIMARY KEY,
    original_user_id INT NOT NULL REFERENCES users(id),
    snapshot         JSONB NOT NULL,
    reason           TEXT,
    archived_by      INT REFERENCES users(id),
    archived_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE sessions (
    id                SERIAL PRIMARY KEY,
    token_hash        TEXT NOT NULL UNIQUE,
    user_id           INT NOT NULL REFERENCES users(id),
    role_code         TEXT NOT NULL,
    permissions       TEXT[] NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL,
    revoked_at        TIMESTAMPTZ,
    revoke_reason     TEXT,
    ip                TEXT,
    user_agent        TEXT
  );
  CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

  CREATE TABLE password_reset_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ===================================================================== Organisation
  CREATE TABLE departments (
    id           SERIAL PRIMARY KEY,
    name         CITEXT NOT NULL UNIQUE,
    code         CITEXT NOT NULL UNIQUE,
    description  TEXT,
    location     TEXT,
    phone        TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (length(trim(name)) >= 2)
  );

  CREATE TABLE staff (
    id             SERIAL PRIMARY KEY,
    user_id        INT NOT NULL UNIQUE REFERENCES users(id),
    employee_code  CITEXT NOT NULL UNIQUE,
    department_id  INT REFERENCES departments(id),
    designation    TEXT,
    date_joined    DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX staff_department_idx ON staff(department_id);

  CREATE TABLE doctors (
    id                 SERIAL PRIMARY KEY,
    staff_id           INT NOT NULL UNIQUE REFERENCES staff(id),
    doctor_code        CITEXT NOT NULL UNIQUE,
    specialization     TEXT NOT NULL CHECK (length(trim(specialization)) > 0),
    qualification      TEXT,
    license_number     CITEXT NOT NULL UNIQUE,
    department_id      INT NOT NULL REFERENCES departments(id),
    consultation_fee   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
    slot_minutes       INT NOT NULL DEFAULT 15 CHECK (slot_minutes BETWEEN 5 AND 120),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX doctors_department_idx ON doctors(department_id);

  CREATE TABLE doctor_schedules (
    id          SERIAL PRIMARY KEY,
    doctor_id   INT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    CHECK (end_time > start_time),
    UNIQUE (doctor_id, weekday, start_time)
  );

  CREATE TABLE staffing_levels (
    id              SERIAL PRIMARY KEY,
    department_id   INT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    role_id         INT NOT NULL REFERENCES roles(id),
    required_count  INT NOT NULL CHECK (required_count > 0),
    notes           TEXT,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      INT REFERENCES users(id),
    UNIQUE (department_id, role_id)
  );

  -- ===================================================================== Patients
  CREATE SEQUENCE patient_code_seq START 1;

  CREATE TABLE insurance_providers (
    id                        SERIAL PRIMARY KEY,
    name                      CITEXT NOT NULL UNIQUE,
    default_coverage_percent  NUMERIC(5,2) NOT NULL CHECK (default_coverage_percent > 0 AND default_coverage_percent <= 100),
    max_coverage_amount       NUMERIC(12,2) CHECK (max_coverage_amount IS NULL OR max_coverage_amount > 0),
    policy_number_pattern     TEXT,
    contact_phone             TEXT,
    is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE patients (
    id                       SERIAL PRIMARY KEY,
    patient_code             TEXT NOT NULL UNIQUE,
    user_id                  INT UNIQUE REFERENCES users(id),
    first_name               TEXT NOT NULL CHECK (length(trim(first_name)) > 0),
    last_name                TEXT NOT NULL CHECK (length(trim(last_name)) > 0),
    date_of_birth            DATE NOT NULL CHECK (date_of_birth > '1900-01-01'),
    gender                   TEXT NOT NULL CHECK (gender IN ('male','female','other')),
    blood_group              TEXT CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    marital_status           TEXT,
    phone                    TEXT NOT NULL,
    email                    CITEXT,
    -- Sensitive fields are stored encrypted (AES-256-GCM); *_hash is an HMAC blind index
    national_id_enc          TEXT,
    national_id_hash         TEXT UNIQUE,
    address_enc              TEXT,
    city                     TEXT,
    emergency_contact_name   TEXT,
    emergency_contact_phone  TEXT,
    emergency_contact_relation TEXT,
    allergies_enc            TEXT,
    medical_history_enc      TEXT,
    current_medications_enc  TEXT,
    status                   TEXT NOT NULL DEFAULT 'out_patient' CHECK (status IN ('out_patient','in_patient','discharged','inactive')),
    duplicate_override_reason TEXT,
    created_by               INT REFERENCES users(id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX patients_name_dob_idx ON patients (lower(first_name), lower(last_name), date_of_birth);
  CREATE INDEX patients_phone_idx ON patients (phone);
  CREATE INDEX patients_name_trgm_idx ON patients (lower(first_name || ' ' || last_name));

  CREATE TABLE patient_insurance (
    id                 SERIAL PRIMARY KEY,
    patient_id         INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    provider_id        INT NOT NULL REFERENCES insurance_providers(id),
    policy_number_enc  TEXT NOT NULL,
    policy_number_last4 TEXT,
    coverage_percent   NUMERIC(5,2) NOT NULL CHECK (coverage_percent > 0 AND coverage_percent <= 100),
    valid_from         DATE NOT NULL,
    valid_until        DATE NOT NULL,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_until >= valid_from)
  );
  CREATE INDEX patient_insurance_patient_idx ON patient_insurance(patient_id);

  -- ===================================================================== Appointments
  CREATE SEQUENCE appointment_code_seq START 1;
  CREATE TABLE appointments (
    id                    SERIAL PRIMARY KEY,
    appointment_code      TEXT NOT NULL UNIQUE,
    patient_id            INT NOT NULL REFERENCES patients(id),
    doctor_id             INT NOT NULL REFERENCES doctors(id),
    appointment_date      DATE NOT NULL,
    start_time            TIME NOT NULL,
    end_time              TIME NOT NULL,
    token_number          INT NOT NULL CHECK (token_number > 0),
    status                TEXT NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','cancellation_requested','completed','cancelled','no_show','rescheduled')),
    reason                TEXT,
    booking_channel       TEXT NOT NULL DEFAULT 'reception' CHECK (booking_channel IN ('reception','portal','waitlist')),
    booked_by             INT REFERENCES users(id),
    cancellation_reason   TEXT,
    cancelled_at          TIMESTAMPTZ,
    cancelled_by          INT REFERENCES users(id),
    rescheduled_from_id   INT REFERENCES appointments(id),
    reminder_sent_at      TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_time > start_time)
  );
  -- No double booking (FR-12): a slot can hold only one live appointment
  CREATE UNIQUE INDEX appt_doctor_slot_uq ON appointments (doctor_id, appointment_date, start_time)
    WHERE status IN ('scheduled','cancellation_requested');
  CREATE UNIQUE INDEX appt_patient_slot_uq ON appointments (patient_id, appointment_date, start_time)
    WHERE status IN ('scheduled','cancellation_requested');
  CREATE UNIQUE INDEX appt_token_uq ON appointments (doctor_id, appointment_date, token_number);
  CREATE INDEX appt_date_idx ON appointments (appointment_date);
  CREATE INDEX appt_patient_idx ON appointments (patient_id);

  CREATE TABLE appointment_cancellation_requests (
    id              SERIAL PRIMARY KEY,
    appointment_id  INT NOT NULL REFERENCES appointments(id),
    requested_by    INT NOT NULL REFERENCES users(id),
    reason          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    decided_by      INT REFERENCES users(id),
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX cancel_req_pending_uq ON appointment_cancellation_requests (appointment_id) WHERE status = 'pending';

  CREATE TABLE waitlist_entries (
    id               SERIAL PRIMARY KEY,
    patient_id       INT NOT NULL REFERENCES patients(id),
    doctor_id        INT NOT NULL REFERENCES doctors(id),
    preferred_date   DATE NOT NULL,
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','booked','cancelled')),
    created_by       INT REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at      TIMESTAMPTZ,
    appointment_id   INT REFERENCES appointments(id),
    closed_at        TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX waitlist_open_uq ON waitlist_entries (patient_id, doctor_id, preferred_date) WHERE status IN ('waiting','notified');
  CREATE INDEX waitlist_fcfs_idx ON waitlist_entries (doctor_id, preferred_date, created_at) WHERE status IN ('waiting','notified');

  -- ===================================================================== Wards & admissions
  CREATE TABLE wards (
    id             SERIAL PRIMARY KEY,
    name           CITEXT NOT NULL UNIQUE,
    ward_type      TEXT NOT NULL CHECK (ward_type IN ('general','private','semi_private','icu','maternity','pediatric','surgical','emergency')),
    department_id  INT REFERENCES departments(id),
    floor          TEXT,
    gender_policy  TEXT NOT NULL DEFAULT 'any' CHECK (gender_policy IN ('any','male','female')),
    daily_rate     NUMERIC(12,2) NOT NULL CHECK (daily_rate >= 0),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE beds (
    id          SERIAL PRIMARY KEY,
    ward_id     INT NOT NULL REFERENCES wards(id),
    bed_number  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','maintenance')),
    notes       TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ward_id, bed_number)
  );

  CREATE SEQUENCE admission_code_seq START 1;
  CREATE TABLE admission_requests (
    id                 SERIAL PRIMARY KEY,
    request_type       TEXT NOT NULL CHECK (request_type IN ('admission','transfer')),
    patient_id         INT NOT NULL REFERENCES patients(id),
    doctor_id          INT NOT NULL REFERENCES doctors(id),
    preferred_ward_id  INT REFERENCES wards(id),
    reason             TEXT NOT NULL,
    priority           TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','cancelled')),
    admission_id       INT,
    fulfilled_by       INT REFERENCES users(id),
    fulfilled_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE admissions (
    id                         SERIAL PRIMARY KEY,
    admission_code             TEXT NOT NULL UNIQUE,
    patient_id                 INT NOT NULL REFERENCES patients(id),
    attending_doctor_id        INT NOT NULL REFERENCES doctors(id),
    ward_id                    INT NOT NULL REFERENCES wards(id),
    bed_id                     INT NOT NULL REFERENCES beds(id),
    admission_request_id       INT REFERENCES admission_requests(id),
    reason                     TEXT NOT NULL,
    status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discharged')),
    admitted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    admitted_by                INT NOT NULL REFERENCES users(id),
    discharge_approved_by      INT REFERENCES doctors(id),
    discharge_approved_at      TIMESTAMPTZ,
    discharge_notes            TEXT,
    discharged_at              TIMESTAMPTZ,
    discharged_by              INT REFERENCES users(id),
    room_billed_until          DATE,
    CHECK (status = 'active' OR discharged_at IS NOT NULL)
  );
  -- One active admission per patient and per bed (no double-assigned beds)
  CREATE UNIQUE INDEX admissions_patient_active_uq ON admissions (patient_id) WHERE status = 'active';
  CREATE UNIQUE INDEX admissions_bed_active_uq ON admissions (bed_id) WHERE status = 'active';
  ALTER TABLE admission_requests ADD CONSTRAINT admission_requests_admission_fk FOREIGN KEY (admission_id) REFERENCES admissions(id);

  CREATE TABLE bed_transfers (
    id             SERIAL PRIMARY KEY,
    admission_id   INT NOT NULL REFERENCES admissions(id),
    from_ward_id   INT NOT NULL REFERENCES wards(id),
    from_bed_id    INT NOT NULL REFERENCES beds(id),
    to_ward_id     INT NOT NULL REFERENCES wards(id),
    to_bed_id      INT NOT NULL REFERENCES beds(id),
    reason         TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    transferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    transferred_by INT NOT NULL REFERENCES users(id),
    CHECK (from_bed_id <> to_bed_id)
  );

  CREATE TABLE discharge_summaries (
    id                       SERIAL PRIMARY KEY,
    admission_id             INT NOT NULL UNIQUE REFERENCES admissions(id),
    patient_id               INT NOT NULL REFERENCES patients(id),
    final_diagnosis          TEXT,
    condition_at_discharge   TEXT,
    treatment_summary        TEXT,
    follow_up_instructions   TEXT,
    content                  JSONB NOT NULL,
    generated_by             INT NOT NULL REFERENCES users(id),
    generated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ===================================================================== Clinical
  CREATE SEQUENCE visit_code_seq START 1;
  CREATE TABLE visits (
    id               SERIAL PRIMARY KEY,
    visit_code       TEXT NOT NULL UNIQUE,
    patient_id       INT NOT NULL REFERENCES patients(id),
    doctor_id        INT NOT NULL REFERENCES doctors(id),
    appointment_id   INT UNIQUE REFERENCES appointments(id),
    admission_id     INT REFERENCES admissions(id),
    visit_type       TEXT NOT NULL CHECK (visit_type IN ('opd','ipd','emergency')),
    chief_complaint  TEXT,
    notes_enc        TEXT,
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at        TIMESTAMPTZ
  );
  CREATE INDEX visits_patient_idx ON visits (patient_id, started_at DESC);

  CREATE TABLE diagnoses (
    id              SERIAL PRIMARY KEY,
    visit_id        INT NOT NULL REFERENCES visits(id),
    patient_id      INT NOT NULL REFERENCES patients(id),
    doctor_id       INT NOT NULL REFERENCES doctors(id),
    condition_name  TEXT NOT NULL CHECK (length(trim(condition_name)) > 0),
    icd_code        TEXT,
    severity        TEXT NOT NULL CHECK (severity IN ('mild','moderate','severe','critical')),
    notes           TEXT NOT NULL CHECK (length(trim(notes)) > 0),
    diagnosed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX diagnoses_patient_idx ON diagnoses (patient_id, diagnosed_at DESC);

  CREATE TABLE clinical_observations (
    id                 SERIAL PRIMARY KEY,
    visit_id           INT NOT NULL REFERENCES visits(id),
    patient_id         INT NOT NULL REFERENCES patients(id),
    doctor_id          INT NOT NULL REFERENCES doctors(id),
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    temperature_c      NUMERIC(4,1) CHECK (temperature_c BETWEEN 30 AND 45),
    pulse_bpm          INT CHECK (pulse_bpm BETWEEN 20 AND 250),
    systolic_bp        INT CHECK (systolic_bp BETWEEN 50 AND 260),
    diastolic_bp       INT CHECK (diastolic_bp BETWEEN 30 AND 160),
    respiratory_rate   INT CHECK (respiratory_rate BETWEEN 4 AND 60),
    spo2               INT CHECK (spo2 BETWEEN 50 AND 100),
    weight_kg          NUMERIC(5,1) CHECK (weight_kg BETWEEN 0.3 AND 400),
    height_cm          NUMERIC(5,1) CHECK (height_cm BETWEEN 20 AND 260),
    blood_glucose      NUMERIC(5,1) CHECK (blood_glucose BETWEEN 10 AND 900),
    symptoms           TEXT,
    notes              TEXT,
    CHECK (systolic_bp IS NULL OR diastolic_bp IS NULL OR systolic_bp > diastolic_bp)
  );
  CREATE INDEX observations_patient_idx ON clinical_observations (patient_id, recorded_at DESC);

  CREATE TABLE emergency_access_grants (
    id          SERIAL PRIMARY KEY,
    doctor_id   INT NOT NULL REFERENCES doctors(id),
    patient_id  INT NOT NULL REFERENCES patients(id),
    reason      TEXT NOT NULL CHECK (length(trim(reason)) >= 10),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX emergency_access_idx ON emergency_access_grants (doctor_id, patient_id, expires_at);

  -- ===================================================================== Pharmacy
  CREATE TABLE medicines (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    generic_name   TEXT NOT NULL,
    form           TEXT NOT NULL CHECK (form IN ('tablet','capsule','syrup','injection','cream','drops','inhaler','other')),
    strength       TEXT NOT NULL,
    category       TEXT NOT NULL,
    unit_price     NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    reorder_level  INT NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX medicines_identity_uq ON medicines (lower(name), lower(strength), form);

  CREATE TABLE medicine_batches (
    id            SERIAL PRIMARY KEY,
    medicine_id   INT NOT NULL REFERENCES medicines(id),
    batch_number  TEXT NOT NULL,
    quantity      INT NOT NULL CHECK (quantity >= 0),
    expiry_date   DATE NOT NULL,
    supplier      TEXT,
    cost_price    NUMERIC(12,2) CHECK (cost_price IS NULL OR cost_price >= 0),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by   INT REFERENCES users(id),
    removed_at    TIMESTAMPTZ,
    UNIQUE (medicine_id, batch_number)
  );
  CREATE INDEX batches_fefo_idx ON medicine_batches (medicine_id, expiry_date) WHERE status = 'active';

  CREATE TABLE inventory_transactions (
    id               SERIAL PRIMARY KEY,
    medicine_id      INT NOT NULL REFERENCES medicines(id),
    batch_id         INT REFERENCES medicine_batches(id),
    txn_type         TEXT NOT NULL CHECK (txn_type IN ('receive','dispense','adjust','expired_removal')),
    quantity_change  INT NOT NULL CHECK (quantity_change <> 0),
    stock_after      INT NOT NULL CHECK (stock_after >= 0),
    reference_type   TEXT,
    reference_id     INT,
    reason           TEXT,
    performed_by     INT REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX inv_txn_medicine_idx ON inventory_transactions (medicine_id, created_at DESC);

  CREATE TABLE stock_alerts (
    id           SERIAL PRIMARY KEY,
    medicine_id  INT NOT NULL REFERENCES medicines(id),
    batch_id     INT REFERENCES medicine_batches(id),
    alert_type   TEXT NOT NULL CHECK (alert_type IN ('low_stock','near_expiry','expired','out_of_stock_request')),
    message      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX stock_alerts_open_uq ON stock_alerts (medicine_id, alert_type, COALESCE(batch_id, 0)) WHERE status = 'open';

  CREATE SEQUENCE prescription_code_seq START 1;
  CREATE TABLE prescriptions (
    id                 SERIAL PRIMARY KEY,
    prescription_code  TEXT NOT NULL UNIQUE,
    visit_id           INT NOT NULL REFERENCES visits(id),
    patient_id         INT NOT NULL REFERENCES patients(id),
    doctor_id          INT NOT NULL REFERENCES doctors(id),
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','verified','flagged','dispensed','partially_dispensed','cancelled')),
    notes              TEXT,
    stock_warning_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    sent_to_pharmacy_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_by        INT REFERENCES users(id),
    verified_at        TIMESTAMPTZ,
    flag_reason        TEXT,
    flagged_by         INT REFERENCES users(id),
    flagged_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX prescriptions_status_idx ON prescriptions (status, sent_to_pharmacy_at);
  CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);

  CREATE TABLE prescription_items (
    id               SERIAL PRIMARY KEY,
    prescription_id  INT NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    medicine_id      INT NOT NULL REFERENCES medicines(id),
    dosage           TEXT NOT NULL CHECK (length(trim(dosage)) > 0),
    frequency        TEXT NOT NULL CHECK (length(trim(frequency)) > 0),
    duration_days    INT NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
    quantity         INT NOT NULL CHECK (quantity > 0),
    instructions     TEXT
  );

  CREATE TABLE dispensings (
    id               SERIAL PRIMARY KEY,
    prescription_id  INT NOT NULL REFERENCES prescriptions(id),
    dispensed_by     INT NOT NULL REFERENCES users(id),
    dispensed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes            TEXT
  );

  CREATE TABLE dispensing_items (
    id                    SERIAL PRIMARY KEY,
    dispensing_id         INT NOT NULL REFERENCES dispensings(id),
    prescription_item_id  INT NOT NULL REFERENCES prescription_items(id),
    medicine_id           INT NOT NULL REFERENCES medicines(id),
    batch_id              INT NOT NULL REFERENCES medicine_batches(id),
    quantity              INT NOT NULL CHECK (quantity > 0),
    unit_price            NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0)
  );

  -- ===================================================================== Laboratory
  CREATE TABLE lab_tests (
    id                SERIAL PRIMARY KEY,
    code              CITEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    category          TEXT NOT NULL,
    sample_type       TEXT NOT NULL,
    price             NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    turnaround_hours  INT NOT NULL DEFAULT 24 CHECK (turnaround_hours > 0),
    parameters        JSONB NOT NULL DEFAULT '[]',
    is_available      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE SEQUENCE lab_request_code_seq START 1;
  CREATE TABLE lab_requests (
    id                      SERIAL PRIMARY KEY,
    request_code            TEXT NOT NULL UNIQUE,
    patient_id              INT NOT NULL REFERENCES patients(id),
    doctor_id               INT NOT NULL REFERENCES doctors(id),
    visit_id                INT REFERENCES visits(id),
    lab_test_id             INT NOT NULL REFERENCES lab_tests(id),
    urgency                 TEXT NOT NULL CHECK (urgency IN ('routine','urgent','stat')),
    clinical_notes          TEXT NOT NULL CHECK (length(trim(clinical_notes)) > 0),
    parameters              JSONB NOT NULL DEFAULT '[]',
    special_instructions    TEXT,
    status                  TEXT NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested','in_progress','delayed','completed','reported','cancelled')),
    technician_id           INT REFERENCES users(id),
    started_at              TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    processing_minutes      INT CHECK (processing_minutes IS NULL OR processing_minutes >= 0),
    delay_reason            TEXT,
    delayed_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX lab_requests_status_idx ON lab_requests (status, urgency, created_at);
  CREATE INDEX lab_requests_patient_idx ON lab_requests (patient_id, created_at DESC);

  CREATE TABLE lab_reports (
    id               SERIAL PRIMARY KEY,
    lab_request_id   INT NOT NULL UNIQUE REFERENCES lab_requests(id),
    patient_id       INT NOT NULL REFERENCES patients(id),
    file_path        TEXT NOT NULL,
    original_name    TEXT NOT NULL,
    mime_type        TEXT NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg')),
    file_size        INT NOT NULL CHECK (file_size > 0),
    sha256           TEXT NOT NULL,
    result_values    JSONB NOT NULL DEFAULT '[]',
    remarks          TEXT,
    uploaded_by      INT NOT NULL REFERENCES users(id),
    uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ===================================================================== Billing
  CREATE SEQUENCE bill_number_seq START 1;
  CREATE SEQUENCE payment_number_seq START 1;
  CREATE SEQUENCE receipt_number_seq START 1;

  CREATE TABLE bills (
    id                    SERIAL PRIMARY KEY,
    bill_number           TEXT NOT NULL UNIQUE,
    patient_id            INT NOT NULL REFERENCES patients(id),
    admission_id          INT REFERENCES admissions(id),
    subtotal              NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    insurance_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (insurance_amount >= 0),
    total_payable         NUMERIC(12,2) NOT NULL CHECK (total_payable >= 0),
    amount_paid           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    balance               NUMERIC(12,2) GENERATED ALWAYS AS (total_payable - amount_paid) STORED,
    status                TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partially_paid','paid')),
    patient_insurance_id  INT REFERENCES patient_insurance(id),
    insurance_applied_at  TIMESTAMPTZ,
    insurance_applied_by  INT REFERENCES users(id),
    notes                 TEXT,
    generated_by          INT NOT NULL REFERENCES users(id),
    generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bills_insurance_le_subtotal CHECK (insurance_amount <= subtotal),
    CONSTRAINT bills_payable_consistent CHECK (total_payable = subtotal - insurance_amount),
    CONSTRAINT bills_not_overpaid CHECK (amount_paid <= total_payable)
  );
  CREATE INDEX bills_patient_idx ON bills (patient_id, generated_at DESC);
  CREATE INDEX bills_status_idx ON bills (status);

  CREATE TABLE bill_items (
    id            SERIAL PRIMARY KEY,
    bill_id       INT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    category      TEXT NOT NULL CHECK (category IN ('consultation','lab','medicine','room','other')),
    description   TEXT NOT NULL,
    quantity      NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
    unit_price    NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    source_type   TEXT CHECK (source_type IN ('appointment','visit','lab_request','dispensing_item','admission','manual')),
    source_id     INT,
    period_start  DATE,
    period_end    DATE,
    service_date  DATE
  );
  -- A billable service can only appear on one bill (no double billing)
  CREATE UNIQUE INDEX bill_items_source_uq ON bill_items (source_type, source_id)
    WHERE source_type IN ('appointment','visit','lab_request','dispensing_item');
  CREATE INDEX bill_items_bill_idx ON bill_items (bill_id);

  CREATE TABLE payments (
    id              SERIAL PRIMARY KEY,
    payment_number  TEXT NOT NULL UNIQUE,
    bill_id         INT NOT NULL REFERENCES bills(id),
    amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method          TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','cheque','mobile_wallet')),
    reference_no    TEXT,
    notes           TEXT,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by     INT NOT NULL REFERENCES users(id)
  );
  CREATE INDEX payments_bill_idx ON payments (bill_id);
  CREATE INDEX payments_received_idx ON payments (received_at);

  CREATE TABLE receipts (
    id              SERIAL PRIMARY KEY,
    receipt_number  TEXT NOT NULL UNIQUE,
    payment_id      INT NOT NULL UNIQUE REFERENCES payments(id),
    patient_id      INT NOT NULL REFERENCES patients(id),
    amount_paid     NUMERIC(12,2) NOT NULL,
    balance_after   NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
    snapshot        JSONB NOT NULL,
    issued_by       INT NOT NULL REFERENCES users(id),
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ===================================================================== Notifications
  CREATE TABLE notifications (
    id           SERIAL PRIMARY KEY,
    -- user_id: in-app recipient. patient_id: set for patient-facing messages; a patient
    -- without a portal account is reached by email only.
    user_id      INT REFERENCES users(id),
    patient_id   INT REFERENCES patients(id),
    event_type   TEXT NOT NULL,
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    link         TEXT,
    priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    entity_type  TEXT,
    entity_id    INT,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    read_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (user_id IS NOT NULL OR patient_id IS NOT NULL)
  );
  CREATE INDEX notifications_user_idx ON notifications (user_id, is_read, created_at DESC);

  CREATE TABLE notification_deliveries (
    id               SERIAL PRIMARY KEY,
    notification_id  INT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel          TEXT NOT NULL CHECK (channel IN ('in_app','email')),
    recipient        TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','delivered','captured','failed','skipped')),
    attempts         INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    last_error       TEXT,
    next_attempt_at  TIMESTAMPTZ,
    delivered_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX deliveries_retry_idx ON notification_deliveries (status, next_attempt_at) WHERE status = 'pending';

  -- Development outbox: emails captured locally when SMTP is not configured.
  -- Rows here were NOT delivered to any mailbox.
  CREATE TABLE outbound_emails (
    id          SERIAL PRIMARY KEY,
    to_address  TEXT NOT NULL,
    subject     TEXT NOT NULL,
    body_text   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ===================================================================== Audit & system
  CREATE TABLE audit_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INT REFERENCES users(id),
    username     TEXT,
    role_code    TEXT,
    action       TEXT NOT NULL,
    entity_type  TEXT,
    entity_id    TEXT,
    status       TEXT NOT NULL CHECK (status IN ('success','failure','denied')),
    ip           TEXT,
    user_agent   TEXT,
    details      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);
  CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id);
  CREATE INDEX audit_user_idx ON audit_logs (user_id, created_at DESC);
  CREATE INDEX audit_action_idx ON audit_logs (action);

  CREATE TABLE backups (
    id            SERIAL PRIMARY KEY,
    file_name     TEXT,
    size_bytes    BIGINT,
    sha256        TEXT,
    backup_type   TEXT NOT NULL CHECK (backup_type IN ('manual','automatic')),
    status        TEXT NOT NULL CHECK (status IN ('running','success','failed')),
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    triggered_by  INT REFERENCES users(id)
  );

  CREATE TABLE health_checks (
    id              SERIAL PRIMARY KEY,
    overall_status  TEXT NOT NULL CHECK (overall_status IN ('healthy','degraded','down')),
    components      JSONB NOT NULL,
    check_type      TEXT NOT NULL CHECK (check_type IN ('manual','automatic')),
    duration_ms     INT NOT NULL,
    triggered_by    INT REFERENCES users(id),
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE drafts (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    form_key    TEXT NOT NULL CHECK (form_key ~ '^[a-z0-9:_-]{1,80}$'),
    data_enc    TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, form_key)
  );

  -- ===================================================================== Append-only guards
  CREATE OR REPLACE FUNCTION hms_forbid_modification() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION '% records are read-only and cannot be %', TG_TABLE_NAME, lower(TG_OP)
      USING ERRCODE = 'P0001';
  END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION hms_forbid_modification();
  CREATE TRIGGER diagnoses_append_only BEFORE UPDATE OR DELETE ON diagnoses
    FOR EACH ROW EXECUTE FUNCTION hms_forbid_modification();
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS drafts, health_checks, backups, audit_logs, outbound_emails,
      notification_deliveries, notifications, receipts, payments, bill_items, bills,
      lab_reports, lab_requests, lab_tests, dispensing_items, dispensings, prescription_items,
      prescriptions, stock_alerts, inventory_transactions, medicine_batches, medicines,
      emergency_access_grants, clinical_observations, diagnoses, visits, discharge_summaries,
      bed_transfers, admission_requests, admissions, beds, wards, waitlist_entries,
      appointment_cancellation_requests, appointments, patient_insurance, patients,
      insurance_providers, staffing_levels, doctor_schedules, doctors, staff, departments,
      password_reset_tokens, sessions, archived_users, users, role_permissions, permissions, roles CASCADE;
    DROP SEQUENCE IF EXISTS patient_code_seq, appointment_code_seq, admission_code_seq, visit_code_seq,
      prescription_code_seq, lab_request_code_seq, bill_number_seq, payment_number_seq, receipt_number_seq;
    DROP FUNCTION IF EXISTS hms_forbid_modification();
  `);
}
