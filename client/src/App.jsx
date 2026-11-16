import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider.jsx';
import AppShell from './components/AppShell.jsx';
import { Callout, Loading } from './components/ui.jsx';
import { ChangePasswordPage, DevOutboxPage, ForgotPasswordPage, LoginPage, ResetPasswordPage } from './pages/auth.jsx';
import Dashboard from './pages/Dashboard.jsx';
import * as Admin from './pages/admin.jsx';
import * as Nursing from './pages/nursing.jsx';
import * as Patients from './pages/patients.jsx';
import * as Appts from './pages/appointments.jsx';
import { routes as moduleRoutes } from './routes.jsx';
import { Guard } from './components/Guard.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading label="Starting…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return children;
}

function Home() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'patient' ? '/portal' : '/dashboard'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/dev/outbox" element={<DevOutboxPage />} />
      <Route path="/change-password" element={<ChangePasswordGate />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Guard role={['admin', 'receptionist', 'doctor', 'nurse', 'lab_technician', 'pharmacist', 'accountant', 'system_admin']}><Dashboard /></Guard>} />
        <Route path="account/password" element={<ChangePasswordPage />} />

        <Route path="admin/users" element={<Guard perm="users.manage"><Admin.UsersPage /></Guard>} />
        <Route path="admin/roles" element={<Guard perm="roles.manage"><Admin.RolesPage /></Guard>} />
        <Route path="admin/doctors" element={<Guard perm="doctors.manage"><Admin.DoctorsPage /></Guard>} />
        <Route path="admin/departments" element={<Guard perm="departments.manage"><Admin.DepartmentsPage /></Guard>} />
        <Route path="admin/staffing" element={<Guard perm="staffing.manage"><Admin.StaffingPage /></Guard>} />
        <Route path="admin/staff" element={<Guard perm="staff.view"><Admin.StaffListPage /></Guard>} />
        <Route path="admin/nurses" element={<Guard perm="staff.view"><Admin.StaffListPage fixedRole="nurse" /></Guard>} />
        <Route path="nursing/roster" element={<Guard perm={['nursing.roster.view', 'nursing.roster.manage']}><Nursing.NurseRosterPage /></Guard>} />
        <Route path="admin/cancellations" element={<Guard perm="appointments.approve_cancellation"><Admin.CancellationRequestsPage /></Guard>} />

        <Route path="patients" element={<Guard perm="patients.view"><Patients.PatientListPage /></Guard>} />
        <Route path="patients/new" element={<Guard perm="patients.create"><Patients.PatientRegisterPage /></Guard>} />
        <Route path="patients/:id" element={<Guard perm="patients.view"><Patients.PatientDetailPage /></Guard>} />

        <Route path="appointments" element={<Guard perm="appointments.manage"><Appts.AppointmentsPage /></Guard>} />
        <Route path="appointments/book" element={<Guard perm="appointments.manage"><Appts.BookAppointmentPage /></Guard>} />
        <Route path="waitlist" element={<Guard perm="waitlist.manage"><Appts.WaitlistPage /></Guard>} />

        {moduleRoutes}
        <Route path="*" element={<div className="max-w-xl"><Callout tone="caution" title="Page not found">Check the address or use the menu.</Callout></div>} />
      </Route>
    </Routes>
  );
}

function ChangePasswordGate() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <ChangePasswordPage />;
  return <Navigate to="/account/password" replace />;
}
