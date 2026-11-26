export const TON_API = Symbol("TON_API");
export const BLOCK_EVENT = "block";

// What arrived at a watched account: one event per incoming internal message
export enum TonEventType {
  // coins, with or without a text comment
  TRANSFER = "Transfer",
  // a jetton wallet tells its owner about received jettons (TEP-74); only sent when forward_ton_amount > 0
  TRANSFER_NOTIFICATION = "TransferNotification",
  // the rest of the TON attached to a jetton transfer, returned to the sender (TEP-74)
  EXCESSES = "Excesses",
  // a message of this account came back: the receiver failed it, or did not exist and the message was bounceable
  BOUNCE = "Bounce",
  // any other opcode
  MESSAGE = "Message",
}

export enum TonOpcode {
  COMMENT = 0x00000000,
  TRANSFER_NOTIFICATION = 0x7362d09c,
  EXCESSES = 0xd53276db,
}
