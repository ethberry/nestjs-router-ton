import { ConfigService } from "@nestjs/config";

import { TON_API } from "../ton.constants.js";

// A GET request to TON Center HTTP API v2 (`/<method>?<params>`); returns its `result` or throws its error
export type TonApi = <T>(method: string, params?: Record<string, string | number>) => Promise<T>;

export const tonApiProvider = {
  provide: TON_API,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): TonApi => {
    const url = configService.get<string>("TON_API_URL", "http://localhost:8082");
    const apiKey = configService.get<string>("TON_API_KEY");
    return async <T>(method: string, params: Record<string, string | number> = {}): Promise<T> => {
      const query = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => query.append(key, String(value)));
      const response = await fetch(`${url}/${method}?${query.toString()}`, {
        headers: apiKey ? { "X-API-Key": apiKey } : {},
      });
      const body = (await response.json()) as { ok: boolean; result: T; error?: string };
      if (!body.ok) {
        throw new Error(`TON API ${method}: ${body.error ?? response.status}`);
      }
      return body.result;
    };
  },
};
