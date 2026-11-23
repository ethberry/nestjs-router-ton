import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoggerService } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { MessageHandler } from "@nestjs/microservices";
import { transformPatternToRoute } from "@nestjs/microservices/utils/index.js";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Address } from "@ton/core";
import { CronJob } from "cron";
import { EMPTY, from, Observable, Subject } from "rxjs";
import { finalize, mergeAll, mergeMap } from "rxjs/operators";

import type { TonApi } from "./providers/api.js";
import { parseMessage } from "./utils/parse-message.js";
import { BLOCK_EVENT, TON_API } from "./ton.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./ton.module-definition.js";
import type {
  IBlockEvent,
  IContractOptions,
  IDiscoveredHandler,
  ILogEvent,
  ITonModuleOptions,
} from "./interfaces/index.js";

const blockPattern = { eventName: BLOCK_EVENT };
// the masterchain has one shard: all bits
const MASTERCHAIN_SHARD = "-9223372036854775808";
// transactions per getBlockTransactionsExt page
const PAGE_SIZE = 256;

interface IBlockId {
  workchain: number;
  shard: string;
  seqno: number;
}

// A transaction of getBlockTransactionsExt: its account (user-friendly), id and BOC
export interface ITonTransaction {
  address: { account_address: string };
  transaction_id: { lt: string; hash: string };
  data: string;
}

// an event on its way to the handlers
interface IRoutedEvent {
  pattern: Record<string, string>;
  description: ILogEvent;
  context: unknown;
}

@Injectable()
export class TonService {
  private instanceId: string;
  private cronLock = false;
  private lastProcessedSeqno = -1;
  private registry: IContractOptions[] = [];
  // the last shard block read, per shard ("workchain:shard")
  private shardSeqno = new Map<string, number>();
  private subject = new Subject<IRoutedEvent>();
  // events emitted whose handlers have not finished, and who waits for that number to reach 0
  private pending = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(
    @Inject(Logger)
    protected readonly loggerService: LoggerService,
    @Inject(TON_API)
    protected readonly api: TonApi,
    protected readonly discoveryService: DiscoveryService,
    protected readonly metadataScanner: MetadataScanner,
    protected readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN)
    protected options: ITonModuleOptions,
    protected schedulerRegistry: SchedulerRegistry,
  ) {
    // handlers run one at a time, in the order of the chain
    this.subject
      .pipe(
        mergeMap(
          ({ pattern, description, context }) =>
            from(this.call(pattern, description, context)).pipe(
              mergeAll(),
              finalize(() => this.settle()),
            ),
          1,
        ),
      )
      .subscribe({
        next: v => {
          loggerService.log(v, `${TonService.name}-${this.instanceId}`);
        },
        error: e => {
          loggerService.error(e);
        },
      });
  }

  public init(): void {
    this.instanceId = (Math.random() + 1).toString(36).substring(7);
    const job = new CronJob(this.options.cron, async () => {
      // if the previous run is still going - skip
      if (this.cronLock) {
        return;
      }
      this.cronLock = true;
      await this.listen().catch(e => this.loggerService.error(e, `${TonService.name}-${this.instanceId}`));
      this.cronLock = false;
    });
    this.schedulerRegistry.addCronJob(`tonListener_${this.instanceId}`, job);
    job.start();
  }

  // Reads the next masterchain blocks up to the last one, with the shard blocks they commit, and hands the incoming
  // message of every transaction of a watched account to the handlers. A shard block committed to a masterchain block
  // is final. The cursor moves only after all handlers have finished; then the block event reports it.
  public async listen(): Promise<void> {
    if (!this.registry.length) {
      return;
    }

    const { last } = await this.api<{ last: IBlockId }>("getMasterchainInfo");
    const fromSeqno = this.options.fromSeqno;
    if (fromSeqno > last.seqno) {
      return;
    }
    const toSeqno = Math.min(last.seqno, fromSeqno + (this.options.chunkSize ?? 100) - 1);

    for (let seqno = fromSeqno; seqno <= toSeqno; seqno++) {
      for (const block of await this.blocksOf(seqno)) {
        for (const tx of await this.transactionsOf(block)) {
          this.route(tx);
        }
      }
    }

    await this.drained();
    this.lastProcessedSeqno = toSeqno;
    this.options.fromSeqno = toSeqno + 1;
    await this.emitBlock(toSeqno);
  }

  // Addresses are stored and matched in raw form ("0:…")
  public updateRegistry(contract: IContractOptions): void {
    const contractAddress = contract.contractAddress.map(address => Address.parse(address).toRawString());
    const entry = this.registry.find(e => e.contractType === contract.contractType);

    if (entry) {
      entry.contractAddress = [...new Set([...entry.contractAddress, ...contractAddress])];
    } else {
      this.registry.push({ ...contract, contractAddress });
    }

    this.loggerService.log(
      `TON listener updated: ${contractAddress.join(", ")}`,
      `${TonService.name}-${this.instanceId}`,
    );
  }

  public getRegistry(): IContractOptions[] {
    return this.registry;
  }

  // the last masterchain block whose transactions have all been handled, -1 before the first run
  public getLastProcessedSeqno(): number {
    return this.lastProcessedSeqno;
  }

  public destroy(): void {
    this.subject.complete();
  }

  protected getHandlerByPattern<T extends Array<Record<string, string>>>(route: string): Array<IDiscoveredHandler<T>> {
    const methods: Array<IDiscoveredHandler<T>> = [];
    for (const wrapper of this.discoveryService.getControllers()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== "function") {
          continue;
        }
        const meta = this.reflector.get<T | undefined>(PATTERN_METADATA, handler);
        if (meta) {
          methods.push({ meta, methodName, handler: handler as IDiscoveredHandler<T>["handler"], instance });
        }
      }
    }
    return methods.filter(method => method.meta.some(meta => transformPatternToRoute(meta) === route));
  }

  protected async call(
    pattern: Record<string, string>,
    description: ILogEvent,
    context: unknown,
  ): Promise<Observable<any>> {
    const route = transformPatternToRoute(pattern);
    const handlers = this.getHandlerByPattern(route);

    if (!handlers.length) {
      this.loggerService.log(`Handler not found for: ${route}`, `${TonService.name}-${this.instanceId}`);
      return EMPTY;
    }

    const results = await Promise.allSettled(
      handlers.map(({ handler, instance }) => (handler.bind(instance) as MessageHandler)(description, context)),
    );
    results.forEach(result => {
      if (result.status === "rejected") {
        this.loggerService.error(result.reason, `${TonService.name}-${this.instanceId}`);
      }
    });
    return from(["OK"]);
  }

  // The masterchain block and every shard block it commits that was not read yet. A masterchain block names only the
  // newest block of each shard; the shard's earlier blocks since the last read one are taken by seqno. A shard seen
  // for the first time (the first run, a split or a merge) contributes only its newest block.
  private async blocksOf(seqno: number): Promise<IBlockId[]> {
    const { shards } = await this.api<{ shards: IBlockId[] }>("shards", { seqno });
    const blocks: IBlockId[] = [{ workchain: -1, shard: MASTERCHAIN_SHARD, seqno }];
    for (const shard of shards) {
      const key = `${shard.workchain}:${shard.shard}`;
      const lastRead = this.shardSeqno.get(key);
      for (let n = lastRead === undefined ? shard.seqno : lastRead + 1; n <= shard.seqno; n++) {
        blocks.push({ ...shard, seqno: n });
      }
      this.shardSeqno.set(key, shard.seqno);
    }
    return blocks;
  }

  // All transactions of a block, page by page; a page continues after the (lt, account) of the previous page's last
  private async transactionsOf(block: IBlockId): Promise<ITonTransaction[]> {
    const transactions: ITonTransaction[] = [];
    let after: Record<string, string> = {};
    while (true) {
      const page = await this.api<{ incomplete: boolean; transactions: ITonTransaction[] }>("getBlockTransactionsExt", {
        ...block,
        count: PAGE_SIZE,
        ...after,
      });
      transactions.push(...page.transactions);
      if (!page.incomplete) {
        return transactions;
      }
      const lastTx = page.transactions[page.transactions.length - 1];
      after = {
        after_lt: lastTx.transaction_id.lt,
        after_hash: Address.parse(lastTx.address.account_address).hash.toString("hex"),
      };
    }
  }

  // A transaction of a watched account goes, as the event of its incoming message, to the handlers of the account's
  // contractType
  private route(tx: ITonTransaction): void {
    const account = Address.parse(tx.address.account_address).toRawString();
    const entries = this.registry.filter(entry => entry.contractAddress.includes(account));
    if (!entries.length) {
      return;
    }
    const event = parseMessage(tx.data);
    if (!event) {
      return;
    }
    for (const entry of entries) {
      this.emit({
        pattern: { contractType: entry.contractType, eventName: event.name },
        description: event,
        context: tx,
      });
    }
  }

  private async emitBlock(seqno: number): Promise<void> {
    if (!this.getHandlerByPattern(transformPatternToRoute(blockPattern)).length) {
      return;
    }
    const args: IBlockEvent = { seqno };
    this.emit({ pattern: blockPattern, description: { name: BLOCK_EVENT, args }, context: args });
    await this.drained();
  }

  private emit(event: IRoutedEvent): void {
    this.pending++;
    this.subject.next(event);
  }

  // an emitted event's handlers have finished
  private settle(): void {
    this.pending--;
    if (!this.pending) {
      this.drainWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  // resolves when the handlers of every emitted event have finished
  private drained(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.drainWaiters.push(resolve));
  }
}
