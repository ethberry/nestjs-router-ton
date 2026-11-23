import { Cell, loadTransaction } from "@ton/core";
import type { Slice } from "@ton/core";

import { TonEventType, TonOpcode } from "../ton.constants.js";
import type { ILogEvent, ITonMessage } from "../interfaces/index.js";

// A text comment: op 0, then UTF-8 text (snake cells)
function readComment(slice: Slice): string | undefined {
  if (slice.remainingBits < 32 || slice.preloadUint(32) !== Number(TonOpcode.COMMENT)) {
    return undefined;
  }
  slice.skip(32);
  return slice.loadStringTail();
}

// The event of one transaction of a watched account (its BOC, as TON Center returns it in `data`), or null when
// nothing stayed: an external message (the account's own send), or a message bounced back to its sender.
// `aborted` is not that test: an uninitialized account has no code, its compute phase is skipped and the transaction is
// marked aborted, yet a non-bounceable message's coins stay there. Only a bounce phase of type "ok" sends them back.
export function parseMessage(boc: string): ILogEvent<ITonMessage> | null {
  const tx = loadTransaction(Cell.fromBase64(boc).beginParse());
  const message = tx.inMessage;
  if (message?.info.type !== "internal") {
    return null;
  }
  if (tx.description.type === "generic" && tx.description.bouncePhase?.type === "ok") {
    return null;
  }

  const { info } = message;
  const args: ITonMessage = {
    lt: tx.lt,
    hash: tx.hash().toString("hex"),
    to: info.dest.toRawString(),
    from: info.src.toRawString(),
    value: info.value.coins,
  };

  const body = message.body.beginParse();
  if (body.remainingBits >= 32) {
    args.op = body.preloadUint(32);
  }

  if (info.bounced) {
    return { name: TonEventType.BOUNCE, args };
  }

  // anyone can send any body: one that does not parse as its opcode says (a cut comment, a notification without its
  // fields) is a Message with that opcode, never an error that would stop the reader
  try {
    return readBody(args, body);
  } catch {
    return { name: TonEventType.MESSAGE, args };
  }
}

function readBody(args: ITonMessage, body: Slice): ILogEvent<ITonMessage> {
  switch (args.op) {
    case undefined:
      return { name: TonEventType.TRANSFER, args };
    case TonOpcode.COMMENT:
      return { name: TonEventType.TRANSFER, args: { ...args, comment: readComment(body) } };
    case TonOpcode.TRANSFER_NOTIFICATION: {
      // transfer_notification#7362d09c query_id:uint64 amount:Coins sender:MsgAddress forward_payload:(Either Cell ^Cell)
      body.skip(32 + 64);
      const jettonAmount = body.loadCoins();
      const sender = body.loadAddress().toRawString();
      const payload = body.loadBit() ? body.loadRef().beginParse() : body;
      return {
        name: TonEventType.TRANSFER_NOTIFICATION,
        args: { ...args, jettonAmount, sender, comment: readComment(payload) },
      };
    }
    case TonOpcode.EXCESSES:
      return { name: TonEventType.EXCESSES, args };
    default:
      return { name: TonEventType.MESSAGE, args };
  }
}
