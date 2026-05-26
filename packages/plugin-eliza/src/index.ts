export interface ActionResult {
  success?: boolean;
  text?: string;
  values?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: string;
}

export type HandlerCallback = (content: { text?: string; [key: string]: unknown }) => Promise<void> | void;

export interface IAgentRuntime {
  [key: string]: unknown;
}

export interface Memory {
  content?: unknown;
  [key: string]: unknown;
}

export interface State {
  [key: string]: unknown;
}

export interface Action {
  name: string;
  description: string;
  similes?: string[];
  validate?: (...args: unknown[]) => Promise<boolean> | boolean;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => Promise<ActionResult>;
}

export interface Plugin {
  name: string;
  description?: string;
  actions?: Action[];
  providers?: unknown[];
  services?: unknown[];
}

import { createRepNetActions } from "@repnet/sdk";

type RepNetActionClient = Parameters<typeof createRepNetActions>[0];
type RepNetAction = ReturnType<typeof createRepNetActions>[string];

type InputResolver = (
  actionName: string,
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type RepNetElizaOptions = {
  /** Prebuilt RepNet SDK client. Useful for tests and agents that own wallet setup externally. */
  client?: RepNetActionClient;
  /** Lazily creates the RepNet SDK client for the Eliza runtime. */
  createClient?: (runtime: IAgentRuntime) => RepNetActionClient;
  /** Optional structured input resolver for mapping Eliza messages to canonical action inputs. */
  getInput?: InputResolver;
};

const getMessageContent = (message: Memory): Record<string, unknown> => {
  const content = message.content;
  return content && typeof content === "object" ? content as Record<string, unknown> : {};
};

const defaultInputResolver: InputResolver = (_actionName, _runtime, message, _state, options) => {
  const content = getMessageContent(message);
  const fromOptions = options?.input;
  if (fromOptions && typeof fromOptions === "object") {
    return fromOptions as Record<string, unknown>;
  }

  const fromContent = content.input;
  if (fromContent && typeof fromContent === "object") {
    return fromContent as Record<string, unknown>;
  }

  return content;
};

const resolveClient = (options: RepNetElizaOptions, runtime: IAgentRuntime): RepNetActionClient => {
  if (options.client) return options.client;
  if (options.createClient) return options.createClient(runtime);

  throw new Error(
    "RepNet Eliza plugin requires either `client` or `createClient`. "
    + "Create the RepNet SDK client in your agent runtime and pass it to createRepNetPlugin({ client }) "
    + "or createRepNetPlugin({ createClient }).",
  );
};

const toActionResult = (text: string): ActionResult => ({
  success: true,
  text,
  values: { text },
  data: { text },
});

const toErrorResult = (error: unknown): ActionResult => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    text: `RepNet action failed: ${message}`,
    error: message,
  };
};

const toElizaAction = (canonicalAction: RepNetAction, options: RepNetElizaOptions): Action => ({
  name: canonicalAction.name,
  description: canonicalAction.description,
  similes: [canonicalAction.name.replace(/^repnet_/, "REPNET_").toUpperCase()],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    handlerOptions?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const input = await (options.getInput ?? defaultInputResolver)(
        canonicalAction.name,
        runtime,
        message,
        state,
        handlerOptions,
      );
      const text = await canonicalAction.execute(input);
      if (callback) {
        await callback({ text });
      }
      return toActionResult(text);
    } catch (error) {
      const result = toErrorResult(error);
      if (callback) {
        await callback({ text: result.text ?? "RepNet action failed" });
      }
      return result;
    }
  },
});

export function createRepNetElizaActions(options: RepNetElizaOptions): Action[] {
  const actions = createRepNetActions({} as RepNetActionClient);

  return Object.values(actions).map((canonicalAction) => ({
    ...toElizaAction(canonicalAction, options),
    handler: async (...args) => {
      const runtime = args[0];
      const client = resolveClient(options, runtime);
      const boundAction = createRepNetActions(client)[canonicalAction.name];
      return toElizaAction(boundAction, options).handler(...args);
    },
  }));
}

export function createRepNetPlugin(options: RepNetElizaOptions): Plugin {
  return {
    name: "@repnet/plugin-eliza",
    description: "RepNet canonical action adapter for ElizaOS agents",
    actions: createRepNetElizaActions(options),
    providers: [],
    services: [],
  };
}

export const repnetPlugin: Plugin = createRepNetPlugin({
  createClient: () => {
    throw new Error(
      "Default repnetPlugin has no RepNet SDK client configured. "
      + "Use createRepNetPlugin({ client }) or createRepNetPlugin({ createClient }).",
    );
  },
});

export default repnetPlugin;
