import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { sanitizeConnectorError } from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  executeLazyCatalogControl,
  lazyCatalogTools,
  resolveCatalogCall,
  searchCatalog,
} from "./lazy-tool-catalog.js";

const CATALOG_ID = "run-connections";
const catalogTools = lazyCatalogTools("connection", CATALOG_ID, "connection").map((tool) =>
  tool.name === "connection_load_tool" ? { ...tool, name: "connection_get_tool" } : tool,
);
const reservedNames = new Set(catalogTools.map((tool) => tool.name));

/** A stable catalog lets fixed-tool runtimes use connections discovered during a turn. */
export class RefreshableConnectors implements ConnectorProvider {
  constructor(
    private readonly provider: ConnectorProvider,
    private readonly builtinNames: ReadonlySet<string>,
  ) {}

  describe() {
    return this.provider.describe();
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    return (await this.provider.discoverTools(context)).filter(
      (tool) => !this.builtinNames.has(tool.name) && !reservedNames.has(tool.name),
    );
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    return [...(await this.authorizedTools(context)), ...catalogTools];
  }

  async refresh(context: AdapterContext) {
    return {
      ok: true,
      ...searchCatalog(catalogEntries(await this.authorizedTools(context)), {}),
    };
  }

  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    if (call.route?.connectorId !== CATALOG_ID) {
      return this.provider.resolveCall?.(call, context);
    }
    if (call.route.toolName !== CATALOG_EXECUTE) return undefined;
    const resolved = resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
    // A provider may itself expose a lazy catalog. Resolve through it before approval.
    return (await this.provider.resolveCall?.(resolved.call, context)) ?? resolved;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== CATALOG_ID) {
      yield* this.provider.execute(call, context);
      return;
    }
    if (call.route.toolName === CATALOG_EXECUTE) {
      throw new Error("Connection tool must be resolved before execution");
    }
    try {
      yield* executeLazyCatalogControl(
        call,
        catalogEntries(await this.authorizedTools(context)),
        () => {
          throw new Error("Connection tool must be resolved before execution");
        },
      );
    } catch (error) {
      yield { type: "error", message: sanitizeConnectorError(error) };
    }
  }
}
