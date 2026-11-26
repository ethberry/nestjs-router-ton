import { ConfigurableModuleBuilder } from "@nestjs/common";

import { ITonRouterModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ITonRouterModuleOptions>().build();
