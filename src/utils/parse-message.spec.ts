import { Address, beginCell, Cell, toNano } from "@ton/core";

import { TonEventType, TonOpcode } from "../ton.constants.js";
import { externalMessage, internalMessage, transactionBoc } from "../fixtures/transactions.js";
import { parseMessage } from "./parse-message.js";

const ACCOUNT = new Address(0, Buffer.alloc(32, 1));
const SENDER = new Address(0, Buffer.alloc(32, 2));
const JETTON_SENDER = new Address(0, Buffer.alloc(32, 3));
const LT = 1000n;
const VALUE = toNano("1");
const OTHER_OP = 0x12345678;

const comment = (text: string) => beginCell().storeUint(TonOpcode.COMMENT, 32).storeStringTail(text).endCell();

// transfer_notification query_id:uint64 amount:Coins sender:MsgAddress forward_payload:(Either Cell ^Cell)
function notification(jettonAmount: bigint, payload: Cell | null, inRef: boolean): Cell {
  const body = beginCell()
    .storeUint(TonOpcode.TRANSFER_NOTIFICATION, 32)
    .storeUint(0, 64)
    .storeCoins(jettonAmount)
    .storeAddress(JETTON_SENDER);
  if (payload && inRef) {
    return body.storeBit(true).storeRef(payload).endCell();
  }
  body.storeBit(false);
  return (payload ? body.storeSlice(payload.beginParse()) : body).endCell();
}

const incoming = (body?: Cell, bounced = false) =>
  transactionBoc({
    account: ACCOUNT,
    lt: LT,
    message: internalMessage({ from: SENDER, to: ACCOUNT, value: VALUE, body, bounced }),
  });

describe("parseMessage", function () {
  it("reads coins without a body as a Transfer, with the transaction and the raw addresses", function () {
    const boc = incoming();

    const event = parseMessage(boc);

    expect(event).toEqual({
      name: TonEventType.TRANSFER,
      args: {
        lt: LT,
        // the transaction's hash is the hash of its cell
        hash: Cell.fromBase64(boc).hash().toString("hex"),
        to: ACCOUNT.toRawString(),
        from: SENDER.toRawString(),
        value: VALUE,
      },
    });
  });

  it("reads a text comment (op 0) as a Transfer with the comment", function () {
    const event = parseMessage(incoming(comment("order:1")));

    expect(event?.name).toEqual(TonEventType.TRANSFER);
    expect(event?.args.op).toEqual(TonOpcode.COMMENT);
    expect(event?.args.comment).toEqual("order:1");
  });

  it.each([
    ["inline", false],
    ["in a reference", true],
  ])("reads a transfer notification with the comment of its forward payload %s", function (_where, inRef) {
    const event = parseMessage(incoming(notification(5_000_000n, comment("order:2"), inRef)));

    expect(event?.name).toEqual(TonEventType.TRANSFER_NOTIFICATION);
    expect(event?.args.jettonAmount).toEqual(5_000_000n);
    expect(event?.args.sender).toEqual(JETTON_SENDER.toRawString());
    expect(event?.args.from).toEqual(SENDER.toRawString());
    expect(event?.args.comment).toEqual("order:2");
  });

  it("reads a transfer notification without a text payload with no comment", function () {
    const binary = beginCell().storeUint(OTHER_OP, 32).storeUint(42, 64).endCell();

    const event = parseMessage(incoming(notification(5_000_000n, binary, true)));

    expect(event?.name).toEqual(TonEventType.TRANSFER_NOTIFICATION);
    expect(event?.args.jettonAmount).toEqual(5_000_000n);
    expect(event?.args.comment).toBeUndefined();
  });

  it("reads excesses as Excesses", function () {
    const event = parseMessage(incoming(beginCell().storeUint(TonOpcode.EXCESSES, 32).storeUint(0, 64).endCell()));

    expect(event?.name).toEqual(TonEventType.EXCESSES);
  });

  it("reads any other opcode as Message with the opcode", function () {
    const event = parseMessage(incoming(beginCell().storeUint(OTHER_OP, 32).endCell()));

    expect(event?.name).toEqual(TonEventType.MESSAGE);
    expect(event?.args.op).toEqual(OTHER_OP);
  });

  it("reads a message that came back to its sender as Bounce", function () {
    const event = parseMessage(incoming(beginCell().storeUint(0xffffffff, 32).endCell(), true));

    expect(event?.name).toEqual(TonEventType.BOUNCE);
    expect(event?.args.value).toEqual(VALUE);
  });

  it("reads nothing for an external message: the account's own send", function () {
    const event = parseMessage(transactionBoc({ account: ACCOUNT, lt: LT, message: externalMessage(ACCOUNT) }));

    expect(event).toBeNull();
  });

  it("reads nothing for a message bounced back to its sender: the coins did not stay", function () {
    const boc = transactionBoc({
      account: ACCOUNT,
      lt: LT,
      message: internalMessage({ from: SENDER, to: ACCOUNT, value: VALUE, body: comment("order:3") }),
      bouncedBack: true,
    });

    const event = parseMessage(boc);

    expect(event).toBeNull();
  });

  it("reads coins that stayed on an uninitialized account (aborted, not bounced) as a Transfer", function () {
    const boc = transactionBoc({
      account: ACCOUNT,
      lt: LT,
      message: internalMessage({ from: SENDER, to: ACCOUNT, value: VALUE }),
      aborted: true,
    });

    const event = parseMessage(boc);

    expect(event?.name).toEqual(TonEventType.TRANSFER);
    expect(event?.args.value).toEqual(VALUE);
  });
});
