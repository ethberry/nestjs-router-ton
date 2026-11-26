// The local TON network of the tests (docker-compose.yml: `nestjs-ton-node` = MyLocalTon, `nestjs-ton-api` = TON Center
// v2 on TON_API_URL, default http://localhost:8182) and the steps that send messages on it.
import { execFileSync } from "node:child_process";

import { Address, beginCell, external, internal, storeMessage, storeMessageRelaxed } from "@ton/core";
import type { Cell, MessageRelaxed } from "@ton/core";
import { getSecureRandomBytes, keyPairFromSeed, sign } from "@ton/crypto";

import { TonOpcode } from "./ton-router.constants.js";

export const API_URL = process.env.TON_API_URL ?? "http://localhost:8182";
// MyLocalTon writes the keys of its genesis wallets into its shared folder; the tests read them from the container
const CONTAINER = process.env.TON_CONTAINER ?? "nestjs-ton-node";
const readShared = (file: string) => execFileSync("docker", ["exec", CONTAINER, "cat", `/usr/share/data/${file}`]);
// MyLocalTon's main-wallet: wallet v3 with wallet id 42, in the masterchain
const WALLET_ID = 42;

const walletKey = keyPairFromSeed(readShared("main-wallet.pk"));
const walletAddress = readShared("main-wallet.addr");
export const wallet = new Address(walletAddress.readInt32BE(32), walletAddress.subarray(0, 32));

async function api<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `${API_URL}/${method}`,
    body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {},
  );
  const json = (await response.json()) as { ok: boolean; result: T };
  if (!json.ok) {
    throw new Error(`${method}: ${JSON.stringify(json)}`);
  }
  return json.result;
}

export async function masterchainSeqno(): Promise<number> {
  const { last } = await api<{ last: { seqno: number } }>("getMasterchainInfo");
  return last.seqno;
}

// an address nobody has used yet (uninitialized), in the basechain
export async function freshAddress(): Promise<Address> {
  return new Address(0, await getSecureRandomBytes(32));
}

async function walletSeqno(): Promise<number> {
  const { stack } = await api<{ stack: Array<[string, string]> }>("runGetMethod", {
    address: wallet.toString(),
    method: "seqno",
    stack: [],
  });
  return Number(stack[0][1]);
}

// Sends up to 4 messages in one external message of the main wallet (wallet v3 body, signed with its key), and waits
// until the wallet has accepted it (its seqno moved), so the next send gets the next seqno
export async function sendFromWallet(messages: MessageRelaxed[]): Promise<void> {
  const seqno = await walletSeqno();
  let body = beginCell()
    .storeUint(WALLET_ID, 32)
    .storeUint(Math.floor(Date.now() / 1000) + 60, 32)
    .storeUint(seqno, 32);
  for (const message of messages) {
    // mode 3: pay the fees separately, ignore errors
    body = body.storeUint(3, 8).storeRef(beginCell().store(storeMessageRelaxed(message)));
  }
  const unsigned = body.endCell();
  const signed = beginCell()
    .storeBuffer(sign(unsigned.hash(), walletKey.secretKey))
    .storeSlice(unsigned.beginParse())
    .endCell();
  const boc = beginCell()
    .store(storeMessage(external({ to: wallet, body: signed })))
    .endCell();
  await api("sendBoc", { boc: boc.toBoc().toString("base64") });
  while ((await walletSeqno()) === seqno) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// An internal message; with `init` it also deploys the contract at `to`
export function transfer(
  to: Address,
  value: bigint,
  bounce: boolean,
  body?: string | Cell,
  init?: { code: Cell; data: Cell },
): MessageRelaxed {
  return internal({ to, value, bounce, body, init });
}

// Waits until the contract at `address` is deployed
export async function waitForActive(address: Address): Promise<void> {
  while ((await api<string>(`getAddressState?address=${address.toString()}`)) !== "active") {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// transfer_notification as a jetton wallet sends it, with an inline text comment as the forward payload
export function transferNotification(jettonAmount: bigint, sender: Address, comment: string): Cell {
  return beginCell()
    .storeUint(TonOpcode.TRANSFER_NOTIFICATION, 32)
    .storeUint(0, 64)
    .storeCoins(jettonAmount)
    .storeAddress(sender)
    .storeBit(false)
    .storeUint(TonOpcode.COMMENT, 32)
    .storeStringTail(comment)
    .endCell();
}

// Waits until `done` holds, checking every 200 ms
export async function waitFor(done: () => boolean): Promise<void> {
  while (!done()) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
