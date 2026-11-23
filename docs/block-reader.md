# Block reader

`TonService` reads the chain one masterchain block at a time and turns the incoming message of every transaction of a watched account into an event for Nest controllers.

## Cycle

- `init()` (from `TonModule.onModuleInit`) starts a cron job (`cron` option). A run is skipped while the previous one is still going; an error of a run is logged and the next run starts from the same cursor.
- `listen()` does nothing until the registry has an entry.
- It reads the last masterchain block (`getMasterchainInfo`) and the range `fromSeqno .. min(last, fromSeqno + chunkSize − 1)`.
- For each masterchain block: the block itself and the shard blocks it commits (`shards?seqno=`). A masterchain block names only the newest block of each shard; the earlier blocks of that shard since the last one read are taken by seqno. A shard seen for the first time (the first run after a start, a split or a merge) contributes only its newest block.
- Each block's transactions come from `getBlockTransactionsExt`, full (with the transaction BOC), in pages of 256; a page continues after the last transaction's logical time and account hash.
- A shard block committed to the masterchain is final, so no confirmation depth is needed.
- After the handlers of every event of the range have finished, the cursor moves: `fromSeqno` becomes `to + 1`, `getLastProcessedSeqno()` returns `to`, and the `block` event (`{ eventName: "block" }`, args `{ seqno: to }`) goes to its handlers. The app saves the cursor there and passes the saved seqno + 1 as `fromSeqno` on start. A crash re-reads the range in work.

## Events (`parseMessage`)

TON has no logs: an "event" is the incoming internal message of a transaction. Only transactions of watched accounts are parsed; the transaction BOC is decoded with `@ton/core` (`loadTransaction`).

- No event for an external incoming message (the account's own send) and for a message bounced back to its sender (bounce phase `ok`).
- `aborted` does not mean "nothing arrived": an uninitialized account has no code, its compute phase is skipped and the transaction is aborted, yet a non-bounceable message's coins stay there and are reported.
- The name comes from the message: a bounced message (`bounced` flag) → `Bounce`; an empty body → `Transfer`; op `0` → `Transfer` with `comment`; op `0x7362d09c` → `TransferNotification` with `jettonAmount`, `sender` and the comment of the forward payload; op `0xd53276db` → `Excesses`; any other op → `Message` with `op`.
- Args (`ITonMessage`): `lt`, `hash` (hex) of the transaction, `to` (the watched account) and `from` in raw form, `value` (nanotons), `op`.
- Anyone can send a `TransferNotification`: the handler checks that `from` is our jetton wallet of a known jetton master. A jetton transfer without `forward_ton_amount` sends no notification to the owner; it is seen only by watching the jetton wallet itself.

## Routing

- The registry (`updateRegistry({ contractType, contractAddress })`) maps watched addresses to a contract type; addresses may be raw or user-friendly and are stored raw, so all forms match.
- The event goes to the handlers of `{ contractType, eventName }` for every contract type that watches the account. The second handler argument is the transaction as `getBlockTransactionsExt` returned it.
- Handlers run one at a time, in chain order; a rejected handler is logged and does not stop the others.

## Account existence and bounce

- A never-used address is uninitialized. A non-bounceable transfer to it stays there (`Transfer` for that address).
- A bounceable transfer to it fails and comes back minus fees: no event for the address, `Bounce` for the sender.

## Tests

- `src/ton.service.spec.ts`, against the network of `docker-compose.yml` (MyLocalTon's main wallet sends):
  - one external message with a non-bounceable transfer with a comment, a hand-made `transfer_notification`, a message with an unknown opcode and a bounceable transfer to an uninitialized address: `Transfer`, `TransferNotification`, `Message` and `Bounce`, and no event for the address of the bounced transfer; the watched addresses are given in user-friendly and raw form;
  - a real jetton (the reference TEP-74 jetton in Tolk, code in `src/fixtures/jetton.ts`): deploy and mint, then a transfer with forward TON and a comment to a fresh address, which gets `TransferNotification` from its own jetton wallet;
  - a restart: a second reader started from the cursor of the first one's block event gets the transfer sent while it was down, and not the one already handled.
- `src/ton.blocks.spec.ts` (stubbed API): several shard blocks between two masterchain blocks are all read, a new shard only from its newest block, and a block's second page continues after the first page's last transaction.
