# @ethberry/nestjs-router-ton

Reads TON one masterchain block at a time, with its shard blocks, and hands the incoming messages of watched accounts to Nest controllers, the way `@ethberry/nestjs-router-eth` hands EVM logs.

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/schedule`, `cron`, `@ton/core`, `rxjs`.

## Exports

- `TonModule` (`register` / `registerAsync` with `ITonModuleOptions`), `TonService`.
- `TonService`: `updateRegistry({ contractType, contractAddress })`, `getRegistry()`, `getLastProcessedSeqno()`, `getJettonWalletAddress(master, owner)`, `listen()` (one run; the cron calls it).
- `TonEventType` (`Transfer`, `TransferNotification`, `Excesses`, `Bounce`, `Message`), `TonOpcode`, `BLOCK_EVENT`, `TON_API` (the API provider token), `parseMessage(boc)`.
- Types: `ITonMessage`, `IBlockEvent`, `ILogEvent`, `IContractOptions`, `ITonTransaction`, `ITonModuleOptions`, `TonApi`.

## Configuration

- `TON_API_URL`: TON Center HTTP API v2; `TON_API_KEY`: its key, if any.
- Module options (`ITonModuleOptions`): `fromSeqno` (the masterchain block to start from), `chunkSize` (masterchain blocks per run, default 20; also the most a failed run reads again), `cron`, `debug`. After a failed run the next cron ticks are skipped, doubling up to 15.

## Example

```ts
@Module({
  imports: [
    TonModule.registerAsync({
      imports: [ConfigModule, SettingsModule],
      inject: [SettingsService],
      useFactory: async (settings: SettingsService) => ({
        fromSeqno: Number(await settings.retrieveByKey("TON_SEQNO")) + 1,
        cron: CronExpression.EVERY_10_SECONDS,
        debug: false,
      }),
    }),
  ],
  controllers: [PaymentController],
})
export class PaymentModule {}

@Controller()
export class PaymentController {
  constructor(private readonly tonService: TonService, private readonly settings: SettingsService) {}

  public onModuleInit() {
    this.tonService.updateRegistry({ contractType: "MERCHANT", contractAddress: [merchantAddress] });
  }

  @EventPattern({ contractType: "MERCHANT", eventName: TonEventType.TRANSFER })
  public transfer(@Payload() event: ILogEvent<ITonMessage>) {
    // event.args: { lt, hash, from, to, value, op, comment }
  }

  @EventPattern({ contractType: "MERCHANT", eventName: TonEventType.TRANSFER_NOTIFICATION })
  public async jetton(@Payload() event: ILogEvent<ITonMessage>) {
    // a real notification comes from the merchant's jetton wallet of a trusted master
    const expected = await this.tonService.getJettonWalletAddress(usdtMaster, merchantAddress);
    if (event.args.from !== expected) {
      return; // spoofed
    }
    // event.args: { jettonAmount, sender, comment, ... }
  }

  // after every handler of the range has finished: save the cursor
  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>) {
    return this.settings.update("TON_SEQNO", String(event.args.seqno));
  }
}
```

## Writing handlers

- **Each event once.** A handler that throws or rejects is logged and skipped; its event is not delivered again. Handle your own failures (retry inside the handler, an outbox). After a restart before the cursor was saved, the range since the last save comes again: record a payment once per `lt` and `hash`.
- One event per incoming internal message of a watched account: `Transfer` (coins, with `comment` for op 0), `TransferNotification` (jettons: `jettonAmount`, `sender`, `comment` of the forward payload), `Excesses`, `Bounce`, `Message` (any other `op`, and any body that does not parse as its opcode says). Addresses in args are raw (`0:…`); register in any form.
- A payment counts when its coins stayed on the account:
  - a message bounced back to its sender gives no event to the receiver; the sender gets `Bounce`;
  - a transaction marked aborted but not bounced (a non-bounceable message, or a payment to an uninitialized wallet) kept the coins and gives `Transfer`;
  - an external message (the account's own send) gives nothing.
- `TransferNotification` can be sent by anyone: accept it only when `from` equals `getJettonWalletAddress(master, merchant)` for a master you trust (the reader asks the master once per owner and keeps the answer). A jetton transfer without `forward_ton_amount` sends no notification; it is seen only by watching the jetton wallet itself.
- The second handler argument is the transaction as `getBlockTransactionsExt` returned it (`data` is its BOC).
- Save the cursor in the `block` handler: it runs after every handler of the range has finished.

How it works, in full: [docs/block-reader.md](docs/block-reader.md).
