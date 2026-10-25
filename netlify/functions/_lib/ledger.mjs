import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

const store = getStore("udhaaros-ledger");
const ledgerKey = "ledger.json";

const emptyLedger = () => ({ customers: [], transactions: [] });

export const readLedger = async () => {
  const result = await store.getWithMetadata(ledgerKey, { type: "json", consistency: "strong" });
  return {
    ledger: result?.data || emptyLedger(),
    etag: result?.etag || null
  };
};

export const updateLedger = async (change) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readLedger();
    const updated = change(current.ledger);
    const result = await store.setJSON(ledgerKey, updated.ledger, current.etag
      ? { onlyIfMatch: current.etag }
      : { onlyIfNew: true });

    if (result.modified) return { ...updated, ledger: updated.ledger };
  }

  const error = new Error("Ledger changed in another request. Please refresh and retry.");
  error.statusCode = 409;
  throw error;
};

export const createCustomer = ({ name, phone }) => updateLedger((ledger) => {
  const duplicate = ledger.customers.find((customer) => customer.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (duplicate) {
    const error = new Error("A customer with this name already exists.");
    error.statusCode = 409;
    throw error;
  }
  const customer = {
    id: randomUUID(),
    name,
    phone,
    createdAt: new Date().toISOString()
  };
  return {
    ledger: { ...ledger, customers: [...ledger.customers, customer] },
    customer
  };
});

export const createTransaction = ({ customerId, type, amountPaise, description, requestId }) => updateLedger((ledger) => {
  const existing = ledger.transactions.find((transaction) => transaction.id === requestId);
  if (existing) {
    if (existing.customerId !== customerId || existing.type !== type || existing.amountPaise !== amountPaise) {
      const error = new Error("This transaction request was already used. Refresh the ledger and try again.");
      error.statusCode = 409;
      throw error;
    }
    return {
      ledger,
      transaction: existing,
      balancePaise: ledger.transactions.reduce((balance, transaction) => {
        if (transaction.customerId !== existing.customerId) return balance;
        return balance + (transaction.type === "credit" ? transaction.amountPaise : -transaction.amountPaise);
      }, 0)
    };
  }

  const customer = ledger.customers.find((item) => item.id === customerId);
  if (!customer) {
    const error = new Error("Customer not found. Refresh the ledger and try again.");
    error.statusCode = 404;
    throw error;
  }

  const currentBalance = ledger.transactions.reduce((balance, transaction) => {
    if (transaction.customerId !== customerId) return balance;
    return balance + (transaction.type === "credit" ? transaction.amountPaise : -transaction.amountPaise);
  }, 0);
  if (type === "payment" && amountPaise > currentBalance) {
    const error = new Error(`${customer.name} ka balance ₹${(currentBalance / 100).toFixed(2)} hai. Payment record nahi hua.`);
    error.statusCode = 422;
    throw error;
  }

  const transaction = {
    id: requestId,
    customerId,
    type,
    amountPaise,
    description,
    createdAt: new Date().toISOString()
  };
  const transactions = [...ledger.transactions, transaction];
  const balancePaise = transactions.reduce((balance, item) => {
    if (item.customerId !== customerId) return balance;
    return balance + (item.type === "credit" ? item.amountPaise : -item.amountPaise);
  }, 0);

  return {
    ledger: { ...ledger, transactions },
    transaction,
    balancePaise
  };
});
