import { describe, expect, it } from 'vitest';
import { assertVisitMatchesPatientAndDoctor, validatePrescriptionItems, validateDispensePlan } from '../src/modules/clinical/journeyIntegrity.js';

describe('clinical cross-module consistency', () => {
  it('accepts a visit for the selected patient and doctor', () => {
    expect(() => assertVisitMatchesPatientAndDoctor({ patient_id: 10, doctor_id: 4 }, 10, 4)).not.toThrow();
  });

  it('rejects a visit belonging to another patient', () => {
    expect(() => assertVisitMatchesPatientAndDoctor({ patient_id: 11, doctor_id: 4 }, 10, 4)).toThrow('another patient');
  });

  it('rejects a visit belonging to another doctor', () => {
    expect(() => assertVisitMatchesPatientAndDoctor({ patient_id: 10, doctor_id: 5 }, 10, 4)).toThrow('another doctor');
  });
});

describe('prescription integrity', () => {
  const item = (medicineId, quantity = 10, durationDays = 5) => ({ medicineId, quantity, durationDays });

  it('accepts valid unique prescription items', () => {
    expect(() => validatePrescriptionItems([item(1), item(2)])).not.toThrow();
  });
  it('rejects duplicate medicines', () => {
    expect(() => validatePrescriptionItems([item(1), item(1)])).toThrow('only once');
  });
  it('rejects zero quantity', () => {
    expect(() => validatePrescriptionItems([item(1, 0)])).toThrow('positive whole number');
  });
  it('rejects invalid duration', () => {
    expect(() => validatePrescriptionItems([item(1, 10, 0)])).toThrow('positive whole number');
  });
});

describe('pharmacy dispensing integrity', () => {
  const rxItems = [{ id: 101, quantity: 20, dispensed: 0 }, { id: 102, quantity: 10, dispensed: 5 }];

  it('accepts quantities remaining on the prescription', () => {
    expect(validateDispensePlan(rxItems, [{ prescriptionItemId: 101, quantity: 20 }])).toHaveLength(1);
  });
  it('rejects duplicate dispensing items', () => {
    expect(() => validateDispensePlan(rxItems, [{ prescriptionItemId: 101, quantity: 5 }, { prescriptionItemId: 101, quantity: 5 }])).toThrow('only once');
  });
  it('rejects an item outside the prescription', () => {
    expect(() => validateDispensePlan(rxItems, [{ prescriptionItemId: 999, quantity: 1 }])).toThrow('does not belong');
  });
  it('rejects quantity over remaining prescribed amount', () => {
    expect(() => validateDispensePlan(rxItems, [{ prescriptionItemId: 102, quantity: 6 }])).toThrow('exceeds');
  });
  it('rejects an empty dispensing request', () => {
    expect(() => validateDispensePlan(rxItems, [{ prescriptionItemId: 101, quantity: 0 }])).toThrow('at least one');
  });
});
