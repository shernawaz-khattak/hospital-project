export function assertVisitMatchesPatientAndDoctor(visit, patientId, doctorId) {
  if (!visit || visit.patient_id !== patientId) {
    throw new Error('The visit belongs to another patient.');
  }
  if (doctorId && visit.doctor_id !== doctorId) {
    throw new Error('The visit belongs to another doctor.');
  }
}

export function validatePrescriptionItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Add at least one medicine.');
  }
  const ids = items.map((item) => item.medicineId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Each medicine can appear only once in a prescription.');
  }
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('Medicine quantity must be a positive whole number.');
    }
    if (!Number.isInteger(item.durationDays) || item.durationDays <= 0) {
      throw new Error('Prescription duration must be a positive whole number.');
    }
  }
}

export function validateDispensePlan(prescriptionItems, requestedItems) {
  const ids = requestedItems.map((item) => item.prescriptionItemId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Each medicine can appear only once.');
  }
  const selected = requestedItems.filter((item) => item.quantity > 0);
  if (!selected.length) {
    throw new Error('Enter a quantity to issue for at least one medicine.');
  }
  for (const item of selected) {
    const prescriptionItem = prescriptionItems.find((candidate) => candidate.id === item.prescriptionItemId);
    if (!prescriptionItem) {
      throw new Error('A dispensing item does not belong to this prescription.');
    }
    const dispensed = Number(prescriptionItem.dispensed ?? 0);
    if (item.quantity > prescriptionItem.quantity - dispensed) {
      throw new Error('Requested quantity exceeds the remaining prescribed quantity.');
    }
  }
  return selected;
}
