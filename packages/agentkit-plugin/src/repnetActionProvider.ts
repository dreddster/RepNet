import { createRepNetActions, RepNetAction, RepNetJsonSchema } from "@repnet/sdk";
import { z } from "zod";

export interface Network {
  networkId?: string;
}

export interface EvmWalletProvider {
  getNetwork?: () => Promise<Network> | Network;
  getAddress?: () => Promise<string> | string;
}

export interface Action<TActionSchema extends z.ZodSchema = z.ZodSchema> {
  name: string;
  description: string;
  schema: TActionSchema;
  invoke: (args: z.infer<TActionSchema>) => Promise<string>;
}

type RepNetActionClient = Parameters<typeof createRepNetActions>[0];

export type RepNetAgentKitOptions = {
  /**
   * Prebuilt RepNet client. Useful for tests, scripts, or agents that own SDK setup outside AgentKit.
   */
  client?: RepNetActionClient;
  /**
   * Lazily creates a RepNet client for the invoking AgentKit wallet provider.
   * Use this when your app wants to bind actions to the active AgentKit wallet.
   */
  createClient?: (walletProvider: EvmWalletProvider) => RepNetActionClient;
  /**
   * Optional network allow-list. Defaults to all networks because RepNet SDK config owns chain/address selection.
   */
  supportedNetworkIds?: string[];
};

const jsonSchemaTypeToZod = (property: unknown): z.ZodTypeAny => {
  if (!property || typeof property !== "object") {
    return z.unknown();
  }

  const schema = property as { type?: string; description?: string; items?: unknown };
  let zodSchema: z.ZodTypeAny;

  switch (schema.type) {
    case "string":
      zodSchema = z.string();
      break;
    case "number":
    case "integer":
      zodSchema = z.number();
      break;
    case "boolean":
      zodSchema = z.boolean();
      break;
    case "array":
      zodSchema = z.array(jsonSchemaTypeToZod(schema.items));
      break;
    case "object":
      zodSchema = z.record(z.unknown());
      break;
    default:
      zodSchema = z.unknown();
      break;
  }

  return schema.description ? zodSchema.describe(schema.description) : zodSchema;
};

export const zodSchemaFromRepNetJsonSchema = (jsonSchema: RepNetJsonSchema): z.ZodObject<Record<string, z.ZodTypeAny>> => {
  const required = new Set(jsonSchema.required ?? []);
  const shape = Object.fromEntries(
    Object.entries(jsonSchema.properties).map(([name, property]) => {
      const zodSchema = jsonSchemaTypeToZod(property);
      return [name, required.has(name) ? zodSchema : zodSchema.optional()];
    }),
  );

  return z.object(shape);
};

export class RepNetActionProvider {
  readonly name = "repnet";
  readonly actionProviders: RepNetActionProvider[] = [];
  readonly #options: RepNetAgentKitOptions;
  readonly #schemas = new Map<string, z.ZodObject<Record<string, z.ZodTypeAny>>>();

  constructor(options: RepNetAgentKitOptions = {}) {
    this.#options = options;
  }

  supportsNetwork(network: Network): boolean {
    if (!this.#options.supportedNetworkIds?.length) {
      return true;
    }

    return network.networkId !== undefined && this.#options.supportedNetworkIds.includes(network.networkId);
  }

  getActions(walletProvider: EvmWalletProvider): Action[] {
    const actions = createRepNetActions(this.resolveClient(walletProvider));

    return Object.values(actions).map((action) => this.toAgentKitAction(action));
  }

  private resolveClient(walletProvider: EvmWalletProvider): RepNetActionClient {
    if (this.#options.client) {
      return this.#options.client;
    }

    if (!this.#options.createClient) {
      throw new Error(
        "RepNet AgentKit provider requires either `client` or `createClient`. "
        + "Build the RepNet SDK client in your app and pass it to repnetActionProvider({ client }) "
        + "or repnetActionProvider({ createClient }).",
      );
    }

    return this.#options.createClient(walletProvider);
  }

  private toAgentKitAction(action: RepNetAction): Action {
    const schema = this.schemaFor(action);

    return {
      name: action.name,
      description: action.description,
      schema,
      invoke: async (args: z.infer<typeof schema>) => action.execute(schema.parse(args)),
    };
  }

  private schemaFor(action: RepNetAction): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const existing = this.#schemas.get(action.name);
    if (existing) {
      return existing;
    }

    const schema = zodSchemaFromRepNetJsonSchema(action.inputSchema);
    this.#schemas.set(action.name, schema);
    return schema;
  }
}

export const repnetActionProvider = (options: RepNetAgentKitOptions = {}) => new RepNetActionProvider(options);
