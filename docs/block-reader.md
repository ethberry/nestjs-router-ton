# Block reader

`TonService` reads TON one masterchain block at a time, with every shard block it commits, and turns the incoming message of every transaction of a watched account into an event for Nest controllers (`@EventPattern({ contractType, eventName })`). It is the TON counterpart of `@ethberry/nestjs-router-eth`: the same module shape, registry and patterns.

## Configuration

- `TON_API_URL`, `TON_API_KEY` (env, through `ConfigService`): TON Center HTTP API v2 and its key. The `TON_API` provider (`TonApi`) sends GET requests with query params, and POST with a JSON body for `runGetMethod`; it returns `result` or throws the API's error.
- Module options (`ITonModuleOptions`, `TonModule.register` / `registerAsync`):
  - `fromSeqno`: the first masterchain block to read; the app passes its saved cursor + 1.
  - `chunkSize`: masterchain blocks per run, default 20 (one to two minutes of chain). It is also the most a failed run reads again.
  - `cron`: how often a run starts. `debug` is accepted for parity with nestjs-router-eth.

## Cycle (`listen`)

`init()` (from `TonModule.onModuleInit`) registers a cron job (`tonListener_<id>` in `SchedulerRegistry`). A tick starts `listen()`.

- After a failed run (an API error) the next ticks are skipped, doubling: 1, 3, 7, up to 15 ticks, so after an API outage the reader tries again within 16 ticks. A tick that finds a run the app started itself still going does nothing and does not touch the count. A failing handler does not fail the run. Every failure is logged as an error with its count (`Run failed N time(s) in a row, next try in M tick(s): …`). A successful run resets the count.
- `listen()` runs one range at a time: a call while a run is going (a cron tick, or the app calling it) returns at once.

1. Nothing happens while the registry is empty.
2. The last masterchain block comes from `getMasterchainInfo`. Nothing happens while `fromSeqno` is above it. The range is `fromSeqno .. min(last, fromSeqno + chunkSize − 1)`.
3. Blocks of the range: each masterchain block, then the shard blocks it commits (`shards?seqno=`). A masterchain block names only the newest block of each shard; the blocks before it are found through `getBlockHeader`'s `prev_blocks`, back to the blocks the previous masterchain block named (`shards` of `fromSeqno − 1` for the first one). Nothing is kept in memory, so this holds after a restart, after a shard split (two new shards share a prev block) and after a merge (a block has two prev blocks). The walk of one masterchain block is one walk for all its shard tops, so a parent block both halves of a split lead back to is read once. It stops at a committed block, and below the lowest committed seqno of the workchain (seqnos only grow along a shard's chain). Block keys are normalised (workchain and seqno as numbers, shard as a 64-bit integer), so the same block from `shards` and from `getBlockHeader` matches whatever JSON types they use.
4. Each block's transactions come from `getBlockTransactionsExt`, full (with the transaction BOC), in pages of 256; a page continues after the last transaction's logical time and account hash. They are fetched once per run, also when a later pass reads the range again.
5. A shard block committed to the masterchain is final: no confirmation depth.
6. The **whole range is read before any handler runs**. An API error in the middle of a range (a 429, a timeout) therefore delivers nothing; the next run reads the range again.
7. The events go to the handlers **one at a time, in chain order**.
8. Passes: a handler may register a new address (`updateRegistry`) while the range is handled. After all events of a pass, the range's blocks are read again for the addresses that appeared during it, until none appears. The new address gets its messages of the whole range. A transaction has one account, so a later pass never delivers it again.
9. A handler that throws (also synchronously) or rejects is **logged and skipped**: the other handlers of that event and the later events still run, and the event is not delivered again.
10. Then the `block` event (`{ eventName: "block" }`, args `{ seqno: to }`) goes to its handlers, if there are any, after every message handler of the range has finished. A failing block handler is logged like any other.
11. The cursor moves: `fromSeqno` becomes `to + 1`, `getLastProcessedSeqno()` returns `to` (−1 before the first range).

### Delivery guarantee

Each event is delivered once. The reader never moves past a range it could not read (an API error ends the run before any handler; the next run reads the range again), but it does not hold the cursor for a handler: a handler that fails is logged and its event is not delivered again. What to do with an event it could not handle (retry inside, an outbox, a dead-letter record) is the handler's business; `lt` and `hash` identify the transaction.

An event can still come twice after a restart before the app saved the cursor (the range since the last save is read again), so a handler that records payments keeps them unique by `lt` and `hash`.

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

- Anyone can send a `TransferNotification`. It is real only when `from` is the receiver's jetton wallet of a jetton master the app trusts: `getJettonWalletAddress(master, owner)` asks the master's `get_wallet_address` and returns that address in raw form. The address never changes for a (master, owner) pair, so it is asked once and kept in memory (keyed in raw form).
- A jetton transfer without `forward_ton_amount` sends no notification to the owner; it is seen only by watching the jetton wallet itself.

## Routing

- The registry (`updateRegistry({ contractType, contractAddress })`) maps watched accounts to a contract type; addresses may be raw or user-friendly (bounceable, non-bounceable, testnet) and are stored raw, so all forms match. A second call for the same type merges.
- The event goes to the handlers of `{ contractType, eventName }` for every contract type that watches the account. The second handler argument is the transaction as `getBlockTransactionsExt` returned it.
- A handler that throws (also synchronously) or rejects is logged; the other handlers and the later events still run (above). A pattern without a handler is logged.

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
- `src/ton.blocks.spec.ts` (stubbed API): the shard blocks since the previous masterchain block after a restart, a split, a split of a parent that made another block first (that block read once), and a merge; a committed block given with a numeric shard still stops the walk; a block's second page continues after the first page's last transaction.
- `src/ton.routing.spec.ts` (a fake chain: the API stubbed with transactions built by `src/fixtures/transactions.ts`): delivery, unwatched accounts, all address forms, several contract types, registry merge, an address registered by a handler mid-range, the block event and the cursor, an empty registry, a last block behind the cursor, `chunkSize`, a handler that rejects or throws (logged; the event's other handlers run, the cursor moves, nothing comes again), a failing block handler (logged, the cursor moves), an API error mid-range (nothing delivered, the whole range next time), a failed run that reads the same shard blocks again, transactions fetched once across passes, a second `listen()` during a run, the growing pause after failed runs (an API that is down), the jetton wallet asked once, `destroy` during a run.
- `src/utils/parse-message.spec.ts`: each event kind from a built transaction, malformed bodies as `Message`, no event for an external or bounced-back message, a `Transfer` for coins that stayed on an uninitialized account.
