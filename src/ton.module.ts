import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { tonApiProvider } from "./providers/api.js";
import { TonService } from "./ton.service.js";
import { ConfigurableModuleClass } from "./ton.module-definition.js";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [tonApiProvider, Logger, TonService],
  exports: [TonService],
})
export class TonModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly tonService: TonService) {
    super();
  }

  public onModuleInit(): void {
    return this.tonService.init();
  }

  public onModuleDestroy(): void {
    return this.tonService.destroy();
  }
}
