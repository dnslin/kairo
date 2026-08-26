import { describe, it, expect, vi } from 'vitest';
import { AcquisitionLedger, executeReverseShutdown } from '../src/ledger.js';
import { WorkAdmissionGate } from '../src/gate.js';

describe('AcquisitionLedger & Reverse Topological Shutdown', () => {
  it('should record resources and compute reverse topological shutdown order', () => {
    const ledger = new AcquisitionLedger('gen-test');

    const finalizerLock = vi.fn();
    const finalizerDb = vi.fn();
    const finalizerStorage = vi.fn();
    const finalizerMastra = vi.fn();

    // Acquire lock first
    ledger.record({
      id: 'InstanceLock',
      owner: 'CompositionRoot',
      dependencies: [],
      finalizer: finalizerLock,
    });

    // Acquire DB client (depends on Lock)
    ledger.record({
      id: 'KKBotClient',
      owner: 'CompositionRoot',
      dependencies: ['InstanceLock'],
      finalizer: finalizerDb,
    });

    // Acquire Storage (depends on Lock)
    ledger.record({
      id: 'LibSQLStore',
      owner: 'CompositionRoot',
      dependencies: ['InstanceLock'],
      finalizer: finalizerStorage,
    });

    // Acquire Mastra (depends on Storage and DB)
    ledger.record({
      id: 'Mastra',
      owner: 'CompositionRoot',
      dependencies: ['LibSQLStore', 'KKBotClient'],
      finalizer: finalizerMastra,
    });

    // Before transfer, reverse topological order should close Mastra first, then Storage/DB, then Lock
    const order = ledger.getReverseTopologicalOrder().map(e => e.id);
    expect(order[0]).toBe('Mastra');
    expect(order[order.length - 1]).toBe('InstanceLock');
  });

  it('should handle ownership transfer to Mastra cleanly', () => {
    const ledger = new AcquisitionLedger('gen-test');
    const storageFinalizer = vi.fn();

    ledger.record({
      id: 'LibSQLStore',
      owner: 'CompositionRoot',
      dependencies: [],
      finalizer: storageFinalizer,
    });

    expect(ledger.get('LibSQLStore')?.owner).toBe('CompositionRoot');
    expect(ledger.get('LibSQLStore')?.finalizer).toBe(storageFinalizer);

    // Transfer ownership to Mastra (Mastra shutdown will close Storage)
    ledger.transferOwnership('LibSQLStore', 'Mastra', null);

    const updated = ledger.get('LibSQLStore');
    expect(updated?.owner).toBe('Mastra');
    expect(updated?.transferredTo).toBe('Mastra');
    expect(updated?.finalizer).toBeNull();
  });

  it('should execute reverse topological shutdown and aggregate errors without skipping', async () => {
    const ledger = new AcquisitionLedger('gen-test');
    const gate = new WorkAdmissionGate('gen-test');
    gate.open();

    const trace: string[] = [];

    const finalizerLock = vi.fn().mockImplementation(() => {
      trace.push('lock_released');
    });

    const finalizerDb = vi.fn().mockImplementation(() => {
      trace.push('db_closed');
    });

    const finalizerMastra = vi.fn().mockImplementation(() => {
      trace.push('mastra_shutdown_failed');
      throw new Error('Mastra shutdown crashed');
    });

    ledger.record({
      id: 'InstanceLock',
      owner: 'CompositionRoot',
      dependencies: [],
      finalizer: finalizerLock,
    });

    ledger.record({
      id: 'KKBotClient',
      owner: 'CompositionRoot',
      dependencies: ['InstanceLock'],
      finalizer: finalizerDb,
    });

    ledger.record({
      id: 'Mastra',
      owner: 'CompositionRoot',
      dependencies: ['KKBotClient'],
      finalizer: finalizerMastra,
    });

    const result = await executeReverseShutdown({
      ledger,
      gate,
      triggerReason: 'test_shutdown',
    });

    // Step 1: Gate must be closed
    expect(gate.isOpen()).toBe(false);

    // Step 2: Mastra ran, DB ran, Lock ran last despite Mastra crashing
    expect(trace).toEqual(['mastra_shutdown_failed', 'db_closed', 'lock_released']);
    expect(finalizerDb).toHaveBeenCalledOnce();
    expect(finalizerLock).toHaveBeenCalledOnce();

    // Errors aggregated
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].resourceId).toBe('Mastra');
    expect(result.errors[0].error.message).toBe('Mastra shutdown crashed');
  });
  it('两个阻塞 Finalizer 共享同一 Shutdown deadline，不按资源倍增', async () => {
    const ledger = new AcquisitionLedger('gen-deadline');
    const gate = new WorkAdmissionGate('gen-deadline');
    const blockingFinalizer = () => new Promise<void>(() => {});
    ledger.record({ id: 'resource-a', owner: 'test', finalizer: blockingFinalizer });
    ledger.record({ id: 'resource-b', owner: 'test', finalizer: blockingFinalizer });

    const startedAt = Date.now();
    const result = await executeReverseShutdown({ ledger, gate, deadlineMs: 80 });

    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some(error => error.error.message.includes('deadline 已耗尽'))).toBe(true);
  });
});
