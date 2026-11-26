import { Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DiscoveryModule } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";

import { tonApiProvider } from "./providers/api.js";
import { TonRouterService } from "./ton-router.service.js";
import { ConfigurableModuleClass } from "./ton-router.module-definition.js";

@Module({
  imports: [ConfigModule, DiscoveryModule, ScheduleModule.forRoot()],
  providers: [tonApiProvider, Logger, TonRouterService],
  exports: [TonRouterService],
})
export class TonRouterModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly tonRouterService: TonRouterService) {
    super();
  }

  public onModuleInit(): void {
    return this.tonRouterService.init();
  }

  public onModuleDestroy(): void {
    return this.tonRouterService.destroy();
  }
}
