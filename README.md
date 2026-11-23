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

How it works: [docs/block-reader.md](docs/block-reader.md).
