// Against the local TON node (docker-compose.yml: `ton` and `ton-api`; TON_API_URL, default http://localhost:8082)
import { Controller, Injectable } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";
import { toNano } from "@ton/core";

import { TonEventType } from "./ton.constants.js";
import type { ILogEvent, ITonMessage } from "./interfaces/index.js";
import { TonModule } from "./ton.module.js";
import { TonService } from "./ton.service.js";
import {
  freshAddress,
  masterchainSeqno,
  sendFromWallet,
  transfer,
  transferNotification,
  waitFor,
  wallet,
} from "./test-utils.js";

enum ContractType {
  MERCHANT = "MERCHANT",
  JETTON_RECEIVER = "JETTON_RECEIVER",
  WALLET = "WALLET",
  NOBODY = "NOBODY",
}

@Injectable()
class Received {
  public events: Array<{ contractType: ContractType; event: ILogEvent<ITonMessage> }> = [];
}

@Controller()
class TestController {
  constructor(private readonly received: Received) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.MERCHANT, event });
  }

  // the uninitialized address that gets a bounceable message: any event of it is a mistake
  @EventPattern([
    { contractType: ContractType.NOBODY, eventName: TonEventType.TRANSFER },
    { contractType: ContractType.NOBODY, eventName: TonEventType.MESSAGE },
  ])
  public nobody(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.NOBODY, event });
  }

  @EventPattern({ contractType: ContractType.JETTON_RECEIVER, eventName: TonEventType.TRANSFER_NOTIFICATION })
  public notification(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.JETTON_RECEIVER, event });
  }

  @EventPattern({ contractType: ContractType.WALLET, eventName: TonEventType.BOUNCE })
  public bounce(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.WALLET, event });
  }
}

describe("TonService on the local node", function () {
  let module: TestingModule;
  let received: Received;
  let service: TonService;

  beforeEach(async function () {
    const fromSeqno = await masterchainSeqno();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        TonModule.register({ fromSeqno, debug: true, cron: CronExpression.EVERY_SECOND }),
      ],
      providers: [Received],
      controllers: [TestController],
    }).compile();
    received = module.get(Received);
    service = module.get(TonService);
    await module.init();
  });

  afterEach(async function () {
    await module.close();
  });

  it("routes the incoming messages of watched accounts by their opcode", async function () {
    const [merchant, jettonReceiver, nobody] = await Promise.all([freshAddress(), freshAddress(), freshAddress()]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [merchant.toString()] });
    service.updateRegistry({
      contractType: ContractType.JETTON_RECEIVER,
      contractAddress: [jettonReceiver.toRawString()],
    });
    service.updateRegistry({ contractType: ContractType.WALLET, contractAddress: [wallet.toString()] });
    service.updateRegistry({ contractType: ContractType.NOBODY, contractAddress: [nobody.toRawString()] });

    await sendFromWallet([
      // 1 TON with a comment, non-bounceable: stays on the uninitialized merchant address
      transfer(merchant, toNano("1"), false, "order:1"),
      // a transfer notification as a jetton wallet sends it (here from our wallet: anyone can send it)
      transfer(jettonReceiver, toNano("0.1"), false, transferNotification(5_000_000n, wallet, "order:2")),
      // 0.5 TON bounceable to an uninitialized address: its transaction fails, the coins come back as a bounce
      transfer(nobody, toNano("0.5"), true, "order:3"),
    ]);

    // the bounce is the last message of the three to arrive
    await waitFor(() => received.events.some(e => e.contractType === ContractType.WALLET));

    const byType = (contractType: ContractType) => received.events.filter(e => e.contractType === contractType);
    const [merchantEvent] = byType(ContractType.MERCHANT);
    const [jettonEvent] = byType(ContractType.JETTON_RECEIVER);
    const [bounceEvent] = byType(ContractType.WALLET);

    expect(byType(ContractType.MERCHANT)).toHaveLength(1);
    expect(merchantEvent.event.name).toEqual(TonEventType.TRANSFER);
    expect(merchantEvent.event.args.from).toEqual(wallet.toRawString());
    expect(merchantEvent.event.args.value).toEqual(toNano("1"));
    expect(merchantEvent.event.args.comment).toEqual("order:1");

    expect(byType(ContractType.JETTON_RECEIVER)).toHaveLength(1);
    expect(jettonEvent.event.name).toEqual(TonEventType.TRANSFER_NOTIFICATION);
    expect(jettonEvent.event.args.jettonAmount).toEqual(5_000_000n);
    expect(jettonEvent.event.args.sender).toEqual(wallet.toRawString());
    expect(jettonEvent.event.args.comment).toEqual("order:2");

    expect(byType(ContractType.WALLET)).toHaveLength(1);
    expect(bounceEvent.event.args.from).toEqual(nobody.toRawString());

    // the failed (aborted) transaction of the uninitialized address is not a transfer
    expect(byType(ContractType.NOBODY)).toEqual([]);
  });
});
