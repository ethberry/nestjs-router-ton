// Which blocks and pages the reader asks TON Center for: cases the local one-shard network never makes (several shard
// blocks between two masterchain blocks after a restart, a shard split and merge, a block with more transactions than a
// page). The API is stubbed.
import { jest } from "@jest/globals";
import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { CronExpression } from "@nestjs/schedule";
import { Address } from "@ton/core";

import { TON_API } from "./ton.constants.js";
import { TonModule } from "./ton.module.js";
import { TonService } from "./ton.service.js";

const ALL = "-9223372036854775808"; // the whole basechain
const LEFT = "-4611686018427387904"; // its halves after a split
const RIGHT = "4611686018427387904";
const ACCOUNT = new Address(0, Buffer.alloc(32, 7));
const WATCHED = new Address(0, Buffer.alloc(32, 9));
const FIRST_PAGE_LT = "2100";

interface IBlockId {
  workchain: number;
  shard: string;
  seqno: number;
}
type Params = Record<string, string | number>;

const id = (shard: string, seqno: number): IBlockId => ({ workchain: 0, shard, seqno });
const key = (block: IBlockId) => `${block.shard}:${block.seqno}`;

// TON Center v2 of a chain whose last masterchain block is 11. `tops`: the shard blocks each masterchain block names;
// `prev`: the prev blocks of each shard block ("<shard>:<seqno>"); block 0:ALL:21 has two pages of transactions.
function fakeApi(tops: Record<number, IBlockId[]>, prev: Record<string, IBlockId[]>) {
  const read: Params[] = [];
  const api = (method: string, params: Params = {}) => {
    switch (method) {
      case "getMasterchainInfo":
        return Promise.resolve({ last: { workchain: -1, shard: ALL, seqno: 11 } });
      case "shards":
        return Promise.resolve({ shards: tops[Number(params.seqno)] });
      case "getBlockHeader":
        return Promise.resolve({ prev_blocks: prev[`${params.shard}:${params.seqno}`] });
      case "getBlockTransactionsExt": {
        read.push(params);
        const firstPage = params.workchain === 0 && params.shard === ALL && params.seqno === 21 && !params.after_lt;
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
  return { api, read };
}

async function readFrom11(chain: ReturnType<typeof fakeApi>): Promise<string[]> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      TonModule.register({ fromSeqno: 11, debug: false, cron: CronExpression.EVERY_HOUR }),
    ],
  })
    .overrideProvider(TON_API)
    .useValue(chain.api)
    .compile();
  jest.spyOn(module.get(Logger), "log").mockImplementation(() => undefined);
  const service = module.get(TonService);
  service.updateRegistry({ contractType: "WATCHED", contractAddress: [WATCHED.toString()] });

  await service.listen();

  return chain.read.map(p =>
    [p.workchain, p.shard === ALL ? "all" : p.shard === LEFT ? "left" : "right", p.seqno, p.after_lt ?? ""]
      .join(" ")
      .trim(),
  );
}

describe("TonService block walk", function () {
  it("after a restart reads every shard block since the previous masterchain block, and every page of a block", async function () {
    // masterchain block 10 named shard block 20, block 11 names 23: 21 and 22 are found through prev blocks
    const chain = fakeApi(
      { 10: [id(ALL, 20)], 11: [id(ALL, 23)] },
      { [key(id(ALL, 23))]: [id(ALL, 22)], [key(id(ALL, 22))]: [id(ALL, 21)], [key(id(ALL, 21))]: [id(ALL, 20)] },
    );

    const read = await readFrom11(chain);

    expect(read).toEqual([
      "-1 all 11",
      "0 all 21",
      // the second page continues after the first page's last transaction
      `0 all 21 ${FIRST_PAGE_LT}`,
      "0 all 22",
      "0 all 23",
    ]);
    expect(chain.read[2].after_hash).toEqual(ACCOUNT.hash.toString("hex"));
  });

  it("after a split reads the first blocks of both new shards", async function () {
    const chain = fakeApi(
      { 10: [id(ALL, 20)], 11: [id(LEFT, 21), id(RIGHT, 21)] },
      { [key(id(LEFT, 21))]: [id(ALL, 20)], [key(id(RIGHT, 21))]: [id(ALL, 20)] },
    );

    const read = await readFrom11(chain);

    expect(read).toEqual(["-1 all 11", "0 left 21", "0 right 21"]);
  });

  it("after a merge reads the merged block and the blocks of both halves before it", async function () {
    // block 10 named left 21 and right 21; the halves made one more block each before merging into all 23
    const chain = fakeApi(
      { 10: [id(LEFT, 21), id(RIGHT, 21)], 11: [id(ALL, 23)] },
      {
        [key(id(ALL, 23))]: [id(LEFT, 22), id(RIGHT, 22)],
        [key(id(LEFT, 22))]: [id(LEFT, 21)],
        [key(id(RIGHT, 22))]: [id(RIGHT, 21)],
      },
    );

    const read = await readFrom11(chain);

    expect(read.sort()).toEqual(["-1 all 11", "0 all 23", "0 left 22", "0 right 22"].sort());
  });
});
