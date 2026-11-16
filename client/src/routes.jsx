// Routes for the ward, clinical, lab, pharmacy, billing, reporting, portal and system modules.
// Each route is guarded by the same permission the API enforces.
import { Route } from 'react-router-dom';
import { Guard } from './components/Guard.jsx';
import * as Wards from './pages/wards.jsx';
import * as Clinical from './pages/clinical.jsx';
import * as Lab from './pages/lab.jsx';
import * as Pharmacy from './pages/pharmacy.jsx';
import * as Billing from './pages/billing.jsx';
import * as Reports from './pages/reports.jsx';
import * as Portal from './pages/portal.jsx';
import * as System from './pages/system.jsx';

const r = (path, perm, el, role) => <Route key={path} path={path} element={<Guard perm={perm} role={role}>{el}</Guard>} />;

export const routes = [
  r('wards/board', ['wards.view', 'admissions.manage'], <Wards.BedBoardPage />),
  r('wards', 'wards.configure', <Wards.WardsConfigPage />),
  r('admissions', 'admissions.manage', <Wards.AdmissionsPage />),
  r('admissions/new', 'admissions.manage', <Wards.AdmitPage />),
  r('admissions/:id', ['admissions.manage', 'wards.view'], <Wards.AdmissionDetailPage />),

  r('doctor/schedule', 'clinical.record', <Clinical.DoctorSchedulePage />),
  r('doctor/patients', 'clinical.view', <Clinical.MyPatientsPage />),
  r('doctor/patients/:id', 'clinical.view', <Clinical.PatientChartPage />),
  r('doctor/visits/:id', 'clinical.view', <Clinical.VisitPage />),
  r('doctor/flagged', 'prescriptions.create', <Clinical.FlaggedPrescriptionsPage />),

  r('lab/requests', 'lab.process', <Lab.LabQueuePage />),
  r('lab/requests/:id', 'lab.process', <Lab.LabRequestPage />),
  r('lab/reports', 'lab.process', <Lab.LabReportsPage />),
  r('lab/tests', 'lab.catalog', <Lab.LabTestsPage />),

  r('pharmacy/prescriptions', ['pharmacy.verify', 'pharmacy.dispense'], <Pharmacy.RxQueuePage />),
  r('pharmacy/prescriptions/:id', ['pharmacy.verify', 'pharmacy.dispense'], <Pharmacy.RxDetailPage />),
  r('pharmacy/inventory', 'inventory.manage', <Pharmacy.InventoryPage />),
  r('pharmacy/medicines/:id', 'inventory.manage', <Pharmacy.MedicineDetailPage />),
  r('pharmacy/expiry', 'inventory.manage', <Pharmacy.ExpiryPage />),
  r('pharmacy/alerts', 'inventory.manage', <Pharmacy.AlertsPage />),

  r('billing', 'billing.manage', <Billing.BillingHomePage />),
  r('billing/patients/:id', 'billing.manage', <Billing.PatientBillingPage />),
  r('billing/bills', 'billing.view', <Billing.BillsListPage />),
  r('billing/bills/:id', 'billing.view', <Billing.BillDetailPage />),
  r('billing/insurance', 'insurance.manage', <Billing.InsuranceProvidersPage />),
  r('reports/financial', 'reports.financial', <Reports.FinancialReportsPage />),
  r('reports/operational', 'reports.operational', <Reports.OperationalReportsPage />),

  r('portal', 'portal.self', <Portal.PortalHomePage />),
  r('portal/appointments', 'portal.self', <Portal.PortalAppointmentsPage />),
  r('portal/lab-reports', 'portal.self', <Portal.PortalLabReportsPage />),
  r('portal/bills', 'portal.self', <Portal.PortalBillsPage />),
  r('portal/records', 'portal.self', <Portal.PortalRecordsPage />),

  r('system/health', 'system.health', <System.HealthPage />),
  r('system/backups', 'system.backup', <System.BackupsPage />),
  r('system/notifications', 'system.health', <System.NotificationLogPage />),
  r('system/audit', 'audit.view', <System.AuditLogPage />),
  <Route key="notifications" path="notifications" element={<System.NotificationsPage />} />,
];
