# Block reader

`TonService` reads TON one masterchain block at a time, with every shard block it commits, and turns the incoming message of every transaction of a watched account into an event for Nest controllers (`@EventPattern({ contractType, eventName })`). It is the TON counterpart of `@ethberry/nestjs-viem`: the same module shape, registry and patterns.

## Configuration

- `TON_API_URL`, `TON_API_KEY` (env, through `ConfigService`): TON Center HTTP API v2 and its key. The `TON_API` provider (`TonApi`) sends GET requests with query params, and POST with a JSON body for `runGetMethod`; it returns `result` or throws the API's error.
- Module options (`ITonModuleOptions`, `TonModule.register` / `registerAsync`):
  - `fromSeqno`: the first masterchain block to read; the app passes its saved cursor + 1.
  - `chunkSize`: masterchain blocks per run, default 100.
  - `cron`: how often a run starts. `debug` is accepted for parity with nestjs-viem.

## Cycle (`listen`)

`init()` (from `TonModule.onModuleInit`) registers a cron job (`tonListener_<id>` in `SchedulerRegistry`). A tick starts `listen()` unless the previous run is still going; an error of a run is logged and nothing else happens: the cursor stays, the next tick tries the same range.

1. Nothing happens while the registry is empty.
2. The last masterchain block comes from `getMasterchainInfo`. Nothing happens while `fromSeqno` is above it. The range is `fromSeqno .. min(last, fromSeqno + chunkSize − 1)`.
3. Blocks of the range: each masterchain block, then the shard blocks it commits (`shards?seqno=`). A masterchain block names only the newest block of each shard; the blocks before it are found through `getBlockHeader`'s `prev_blocks`, back to the blocks the previous masterchain block named (`shards` of `fromSeqno − 1` for the first one). Nothing is kept in memory, so this holds after a restart, after a shard split (two new shards share a prev block) and after a merge (a block has two prev blocks).
4. Each block's transactions come from `getBlockTransactionsExt`, full (with the transaction BOC), in pages of 256; a page continues after the last transaction's logical time and account hash.
5. A shard block committed to the masterchain is final: no confirmation depth.
6. The **whole range is read before any handler runs**. An API error in the middle of a range (a 429, a timeout) therefore delivers nothing; the next run reads the range again.
7. The events go to the handlers **one at a time, in chain order**.
8. Passes: a handler may register a new address (`updateRegistry`) while the range is handled. After all events of a pass, the range's blocks are read again for the addresses that appeared during it, until none appears. The new address gets its messages of the whole range. A transaction has one account, so a later pass never delivers it again.
9. If any handler failed, the run throws (`A handler failed in blocks a..b: the range is read again on the next run`); the cursor stays.
10. Otherwise the `block` event (`{ eventName: "block" }`, args `{ seqno: to }`) goes to its handlers, if there are any. If it fails, the run throws and the cursor stays.
11. The cursor moves: `fromSeqno` becomes `to + 1`, `getLastProcessedSeqno()` returns `to` (−1 before the first range).

### Delivery guarantee

At least once. A range is delivered again after a failed handler, a failed block handler, or a restart before the app saved the cursor. **Handlers must be idempotent by `lt` and `hash`** of the transaction. Nothing is lost: the cursor never moves past a range whose handlers did not all succeed.

### Shutdown

`destroy()` (from `TonModule.onModuleDestroy`) stops and removes the cron job. A run in progress stops before its next handler and does not move the cursor.

## Events (`parseMessage`)

TON has no logs: the "event" of a transaction is its incoming internal message. Only transactions of watched accounts are parsed; the BOC is decoded with `@ton/core` (`loadTransaction`).

- No event for an external incoming message (the account's own send), and none for a message bounced back to its sender (bounce phase `ok`): its coins did not stay.
- `aborted` does not mean "nothing arrived": an uninitialized account has no code, its compute phase is skipped and the transaction is aborted, yet a non-bounceable message's coins stay there and are reported. The same holds when the value was too small to bounce.
- The name comes from the message: the `bounced` flag → `Bounce`; an empty body → `Transfer`; op `0` → `Transfer` with `comment`; op `0x7362d09c` → `TransferNotification` with `jettonAmount`, `sender` and the comment of the forward payload (inline or in a reference); op `0xd53276db` → `Excesses`; any other op → `Message` with `op`.
- A body that does not parse as its opcode says (a cut comment, a notification without its fields) is a `Message` with that `op`. Anyone can send such a body for a small fee; it must never stop the reader.
- Args (`ITonMessage`): `lt`, `hash` (hex) of the transaction, `to` (the watched account) and `from` in raw form, `value` (nanotons), `op`, and per kind `comment`, `jettonAmount`, `sender`.

## Jettons

- Anyone can send a `TransferNotification`. It is real only when `from` is the receiver's jetton wallet of a jetton master the app trusts: `getJettonWalletAddress(master, owner)` asks the master's `get_wallet_address` and returns that address in raw form.
- A jetton transfer without `forward_ton_amount` sends no notification to the owner; it is seen only by watching the jetton wallet itself.

## Routing

- The registry (`updateRegistry({ contractType, contractAddress })`) maps watched accounts to a contract type; addresses may be raw or user-friendly (bounceable, non-bounceable, testnet) and are stored raw, so all forms match. A second call for the same type merges.
- The event goes to the handlers of `{ contractType, eventName }` for every contract type that watches the account. The second handler argument is the transaction as `getBlockTransactionsExt` returned it.
- A handler that throws (also synchronously) or rejects is logged; the other handlers still run; the range is then retried (above). A pattern without a handler is logged.

## Account existence and bounce

- A never-used address is uninitialized. A non-bounceable transfer to it stays there (`Transfer` for that address).
- A bounceable transfer to it fails and comes back minus fees: no event for the address, `Bounce` for the sender.

## Limits

- TON Center v2 reads one block per request (two with the header walk); a busy chain may need an own lite-server or a v3 indexer.
- The test network is created with TVM version 12 (`VERSION_CAPABILITIES`): Jetton 2.0 compiled by Tolk uses TVM 12 instructions and fails with exit code 6 on 11.

## Tests

- `src/ton.service.spec.ts`, against the network of `docker-compose.yml` (MyLocalTon's main wallet sends):
  - one external message with a non-bounceable transfer with a comment, a hand-made `transfer_notification`, a message with an unknown opcode and a bounceable transfer to an uninitialized address: `Transfer`, `TransferNotification`, `Message` and `Bounce`, and no event for the address of the bounced transfer; the watched addresses are given in user-friendly and raw form;
  - a real jetton (the reference TEP-74 jetton in Tolk, code in `src/fixtures/jetton.ts`): deploy and mint, then a transfer with forward TON and a comment; `getJettonWalletAddress` returns the `from` of the real notification and not of a spoofed one with the same fields;
  - a restart: a second reader started from the cursor of the first one's block event gets the transfer sent while it was down, and not the one already handled.
- `src/ton.blocks.spec.ts` (stubbed API): the shard blocks since the previous masterchain block after a restart, a split and a merge; a block's second page continues after the first page's last transaction.
- `src/ton.routing.spec.ts` (a fake chain: the API stubbed with transactions built by `src/fixtures/transactions.ts`): delivery, unwatched accounts, all address forms, several contract types, registry merge, an address registered by a handler mid-range, the block event and the cursor, an empty registry, a last block behind the cursor, `chunkSize`, a handler that rejects or throws (others run, cursor stays, the range comes again), a failing block handler, an API error mid-range (nothing delivered, the whole range next time), a failed run that reads the same shard blocks again, `destroy` during a run.
- `src/utils/parse-message.spec.ts`: each event kind from a built transaction, malformed bodies as `Message`, no event for an external or bounced-back message, a `Transfer` for coins that stayed on an uninitialized account.
