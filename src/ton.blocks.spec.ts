// Which blocks and pages the reader asks TON Center for: cases the local one-shard network never makes (several shard
// blocks between two masterchain blocks, a block with more transactions than a page). The API is stubbed.
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { CronExpression } from "@nestjs/schedule";
import { Address } from "@ton/core";

import { TON_API } from "./ton.constants.js";
import { TonModule } from "./ton.module.js";
import { TonService } from "./ton.service.js";

const SHARD = "-9223372036854775808";
const ACCOUNT = new Address(0, Buffer.alloc(32, 7));
const WATCHED = new Address(0, Buffer.alloc(32, 9));
// the newest block of the basechain shard named by masterchain blocks 10 and 11
const SHARD_TOP: Record<number, number> = { 10: 20, 11: 23 };
const FIRST_PAGE_LT = "2100";

type Params = Record<string, string | number>;

describe("TonService block walk", function () {
  const calls: Params[] = [];

  // TON Center v2 with masterchain blocks 10 and 11; shard block 21 has two pages of transactions
  const api = (method: string, params: Params = {}) => {
    switch (method) {
      case "getMasterchainInfo":
        return Promise.resolve({ last: { workchain: -1, shard: SHARD, seqno: 11 } });
      case "shards":
        return Promise.resolve({ shards: [{ workchain: 0, shard: SHARD, seqno: SHARD_TOP[Number(params.seqno)] }] });
      case "getBlockTransactionsExt": {
        calls.push(params);
        const firstPage = params.workchain === 0 && params.seqno === 21 && !params.after_lt;
        const tx = {
          address: { account_address: ACCOUNT.toString() },
          transaction_id: { lt: FIRST_PAGE_LT, hash: "" },
          data: "",
        };
        return Promise.resolve({ incomplete: firstPage, transactions: firstPage ? [tx] : [] });
      }
      default:
        return Promise.reject(new Error(method));
    }
  };

  beforeEach(function () {
    calls.length = 0;
  });

  it("reads every shard block since the last one read, and every page of a block", async function () {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        TonModule.register({ fromSeqno: 10, debug: false, cron: CronExpression.EVERY_HOUR }),
      ],
    })
      .overrideProvider(TON_API)
      .useValue(api)
      .compile();
    const service = module.get(TonService);
    service.updateRegistry({ contractType: "WATCHED", contractAddress: [WATCHED.toString()] });

    await service.listen();

    const blocks = calls.map(c => [c.workchain, c.seqno, c.after_lt, c.after_hash]);
    expect(blocks).toEqual([
      [-1, 10, undefined, undefined],
      // a shard seen for the first time: only its newest block
      [0, 20, undefined, undefined],
      [-1, 11, undefined, undefined],
      // masterchain block 11 names shard block 23: 21 and 22 come in between
      [0, 21, undefined, undefined],
      // the second page continues after the last transaction of the first: its lt and account hash
      [0, 21, FIRST_PAGE_LT, ACCOUNT.hash.toString("hex")],
      [0, 22, undefined, undefined],
      [0, 23, undefined, undefined],
    ]);
    expect(service.getLastProcessedSeqno()).toEqual(11);
  });
});
