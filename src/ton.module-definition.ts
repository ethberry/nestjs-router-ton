import { ConfigurableModuleBuilder } from "@nestjs/common";

import { ITonModuleOptions } from "./interfaces/index.js";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ITonModuleOptions>().build();
