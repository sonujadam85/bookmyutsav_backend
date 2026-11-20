// Which company the current request belongs to. Every database call and file path uses this,
// so one company's request can never read or write another company's data.
import { AsyncLocalStorage } from 'node:async_hooks';

export const companyContext = new AsyncLocalStorage();

/** { company, db, uploadDir } of the running request. Throws if code runs without a company. */
export function current() {
  const store = companyContext.getStore();
  if (!store) throw new Error('No company selected for this operation');
  return store;
}
