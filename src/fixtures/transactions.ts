// Transactions as TON Center returns them (`getBlockTransactionsExt`): the BOC of a transaction built here, with only
// the parts the reader looks at, so a test controls the incoming message and the outcome.
import { Address, beginCell, Cell, Dictionary, storeTransaction } from "@ton/core";
import type { Message, Transaction, TransactionDescriptionGeneric } from "@ton/core";

import type { ITonTransaction } from "../ton.service.js";

export interface IInternalMessage {
  from: Address;
  to: Address;
  value: bigint;
  body?: Cell;
  // the message came back to its sender
  bounced?: boolean;
}

export function internalMessage({ from, to, value, body, bounced = false }: IInternalMessage): Message {
  return {
    info: {
      type: "internal",
      ihrDisabled: true,
      bounce: false,
      bounced,
      src: from,
      dest: to,
      value: { coins: value },
      ihrFee: 0n,
      forwardFee: 0n,
      createdLt: 0n,
      createdAt: 0,
    },
    body: body ?? Cell.EMPTY,
  };
}

export function externalMessage(to: Address): Message {
  return { info: { type: "external-in", dest: to, importFee: 0n }, body: Cell.EMPTY };
}

export interface ITxOptions {
  account: Address;
  lt: bigint;
  message: Message;
  // the message was bounced back to its sender (bounce phase "ok")
  bouncedBack?: boolean;
  // the compute phase failed or was skipped (an uninitialized account)
  aborted?: boolean;
}

export function transactionBoc({
  account,
  lt,
  message,
  bouncedBack = false,
  aborted = bouncedBack,
}: ITxOptions): string {
  const description: TransactionDescriptionGeneric = {
    type: "generic",
    creditFirst: true,
    computePhase: { type: "skipped", reason: "no-state" },
    bouncePhase: bouncedBack
      ? { type: "ok", messageSize: { cells: 0n, bits: 0n }, messageFees: 0n, forwardFees: 0n }
      : undefined,
    aborted,
    destroyed: false,
  };
  const tx: Transaction = {
    address: BigInt(`0x${account.hash.toString("hex")}`),
    lt,
    prevTransactionHash: 0n,
    prevTransactionLt: 0n,
    now: 0,
    outMessagesCount: 0,
    oldStatus: "uninitialized",
    endStatus: "uninitialized",
    inMessage: message,
    outMessages: Dictionary.empty<number, Message>(),
    totalFees: { coins: 0n },
    stateUpdate: { oldHash: Buffer.alloc(32), newHash: Buffer.alloc(32) },
    description,
    raw: Cell.EMPTY,
    hash: () => Buffer.alloc(32),
  };
  return beginCell().store(storeTransaction(tx)).endCell().toBoc().toString("base64");
}

// A transaction of `account` as one entry of getBlockTransactionsExt
export function blockTransaction(options: ITxOptions): ITonTransaction {
  return {
    address: { account_address: options.account.toString() },
    transaction_id: { lt: String(options.lt), hash: "" },
    data: transactionBoc(options),
  };
}
