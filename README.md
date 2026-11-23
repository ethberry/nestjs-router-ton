# @ethberry/nestjs-ton

Reads TON block by block and hands the incoming messages of watched accounts to Nest controllers.

## Peers

`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/microservices`, `@nestjs/schedule`, `@ton/core`, `rxjs`.

## Configuration

- `TON_API_URL`: TON Center HTTP API v2 (default `http://localhost:8082`); `TON_API_KEY`: its key, if any.
- Module options (`ITonModuleOptions`): `fromSeqno` (the masterchain block to start from), `chunkSize` (masterchain blocks per run), `cron`, `debug`.

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

  // after every processed range: save the cursor
  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>) {
    return this.settings.update("TON_SEQNO", String(event.args.seqno));
  }
}
```

## Writing handlers

- One event per incoming internal message of a watched account: `Transfer` (coins, with `comment` for op 0), `TransferNotification` (jettons: `jettonAmount`, `sender`, `comment` of the forward payload), `Excesses`, `Bounce`, `Message` (any other `op`). Addresses in args are raw (`0:…`); register in any form.
- A payment counts when its coins stayed on the account:
  - a message bounced back to its sender gives no event to the receiver; the sender gets `Bounce`;
  - a transaction marked aborted but not bounced (a non-bounceable message, or a payment to an uninitialized wallet) kept the coins and gives `Transfer`;
  - an external message (the account's own send) gives nothing.
- `TransferNotification` can be sent by anyone: accept it only when `from` is the merchant's jetton wallet of a known jetton master (`get_wallet_address`). A jetton transfer without `forward_ton_amount` sends no notification; it is seen only by watching the jetton wallet itself.
- The second handler argument is the transaction as `getBlockTransactionsExt` returned it (`data` is its BOC). A transaction is identified by `lt` and `hash`.
- Save the cursor in the `block` handler: it runs after every handler of the range.

How it works: [docs/block-reader.md](docs/block-reader.md).
