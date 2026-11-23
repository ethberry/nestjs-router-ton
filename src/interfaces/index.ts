import { CronExpression } from "@nestjs/schedule";

export interface ITonModuleOptions {
  // the first masterchain block to read; the app keeps the last processed one (the block event) and passes the next
  fromSeqno: number;
  // masterchain blocks per run
  chunkSize?: number;
  debug: boolean;
  cron: CronExpression;
}

// Watched accounts: a transaction of one of them goes to the handlers of its contractType.
// Addresses in any form (raw "0:…", user-friendly "EQ…" / "UQ…"); they are matched in raw form.
export interface IContractOptions {
  contractType: string;
  contractAddress: string[];
}

// `name` is a TonEventType, or "block" for the block event
export interface ILogEvent<T = any> {
  name: string;
  args: T;
}

// An incoming internal message of a watched account's transaction
export interface ITonMessage {
  // the transaction: its logical time and hash (hex) identify it on the account
  lt: bigint;
  hash: string;
  // raw addresses ("0:…"): the watched account, and the sender of the message
  to: string;
  from: string;
  // TON attached to the message, nanotons
  value: bigint;
  // the first 32 bits of the body; absent for an empty body
  op?: number;
  // a text comment: of a plain transfer, or the forward payload of a jetton notification
  comment?: string;
  // TransferNotification only: the jetton amount and its sender (the owner's wallet, not its jetton wallet).
  // `from` is the jetton wallet: check it is ours for a known jetton master, anyone can send this message.
  jettonAmount?: bigint;
  sender?: string;
}

export interface IBlockEvent {
  // the last masterchain block whose transactions have all been handled: resume from the next one
  seqno: number;
}

// A controller method found by its pattern metadata (@EventPattern / @MessagePattern)
export interface IDiscoveredHandler<T> {
  meta: T;
  methodName: string;
  handler: (...args: any[]) => unknown;
  instance: object;
}
