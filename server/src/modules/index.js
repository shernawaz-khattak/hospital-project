// Registry of feature modules mounted under /api/<prefix>. Each module is self-contained
// (routes + service), so it can be updated or replaced independently (NFR-11).
import appointmentRoutes, { waitlistRouter } from './appointments/routes.js';
import { wardRouter, admissionRouter } from './wards/routes.js';
import clinicalRoutes from './clinical/routes.js';
import labRoutes from './lab/routes.js';
import pharmacyRoutes from './pharmacy/routes.js';
import billingRoutes from './billing/routes.js';
import reportRoutes from './reports/routes.js';
import portalRoutes from './portal/routes.js';
import systemRoutes from './system/routes.js';

export const moduleRoutes = [
  ['appointments', appointmentRoutes],
  ['waitlist', waitlistRouter],
  ['wards', wardRouter],
  ['admissions', admissionRouter],
  ['clinical', clinicalRoutes],
  ['lab', labRoutes],
  ['pharmacy', pharmacyRoutes],
  ['billing', billingRoutes],
  ['reports', reportRoutes],
  ['portal', portalRoutes],
  ['system', systemRoutes],
];
