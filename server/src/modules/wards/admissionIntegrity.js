export function assertAdmissionEligible({ admissionStatuses = [], bed, patient }) {
  if (admissionStatuses.some((status) => status === 'active')) {
    throw new Error('This patient is already admitted.');
  }
  if (!bed || bed.status !== 'available') {
    throw new Error('The selected bed is not available.');
  }
  if (!patient) {
    throw new Error('Invalid patient.');
  }
}

export function assertDischargeAllowed({ isDoctor, admission, outstandingBalance, unbilledCount }) {
  if (!admission?.discharge_approved_at && !isDoctor) {
    throw new Error('A doctor must confirm the patient is ready for discharge first.');
  }
  if (Number(outstandingBalance) > 0 || Number(unbilledCount) > 0) {
    throw new Error('Discharge is blocked by pending bills.');
  }
}
