import { describe, it, expect } from 'vitest';
import { WorkAdmissionGate, WorkAdmissionGateClosedError } from '../src/gate.js';

describe('WorkAdmissionGate', () => {
  it('should start in closed state', () => {
    const gate = new WorkAdmissionGate('gen-123');
    expect(gate.isOpen()).toBe(false);
    expect(() => gate.assertOpen()).toThrow(WorkAdmissionGateClosedError);
  });

  it('should open when open() is called', () => {
    const gate = new WorkAdmissionGate('gen-123');
    gate.open();
    expect(gate.isOpen()).toBe(true);
    expect(() => gate.assertOpen()).not.toThrow();
  });

  it('should close when close() is called and remain closed', () => {
    const gate = new WorkAdmissionGate('gen-123');
    gate.open();
    expect(gate.isOpen()).toBe(true);

    gate.close();
    expect(gate.isOpen()).toBe(false);
    expect(() => gate.assertOpen()).toThrow(WorkAdmissionGateClosedError);
  });
});
